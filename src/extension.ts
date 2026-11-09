// Thin VS Code adapter: turns editor actions into session events and applies the session's effects.
import * as vscode from "vscode";
import { createSession } from "./core/session";
import { LEVELS, type DocumentSnapshot, type Effect, type Level, type Position } from "./core/types";
import { OpenRouterClient } from "./openrouter";
import { appendLogEntry } from "./sessionLog";

const KEY_SECRET = "pawl.openrouterKey";
const LEVEL_STATE = "pawl.level";

interface Ghost {
  docId: string;
  at: Position;
  text: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const { secrets, globalState } = context;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "pawl.pickLevel";
  status.tooltip = "Pawl: choose a level";
  status.show();
  const marker = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorGhostText.foreground"),
      fontStyle: "italic",
      margin: "0 0 0 0.25em",
    },
  });
  let markerTimer: ReturnType<typeof setTimeout> | undefined;
  /** The suggestion armed by the last go-press; the only thing the provider ever returns. */
  let ghost: Ghost | undefined;

  const editorFor = (docId: string) =>
    vscode.window.visibleTextEditors.find((e) => docIdOf(e.document) === docId);
  const toVs = (p: Position) => new vscode.Position(p.line, p.character);

  function clearMarker(): void {
    clearTimeout(markerTimer);
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(marker, []);
  }

  function apply(effect: Effect): void {
    switch (effect.type) {
      case "status":
        status.text = effect.text;
        return;
      case "marker": {
        clearMarker();
        const at = toVs(effect.at);
        editorFor(effect.docId)?.setDecorations(marker, [
          { range: new vscode.Range(at, at), renderOptions: { after: { contentText: effect.text } } },
        ]);
        if (effect.ttlMs) markerTimer = setTimeout(clearMarker, effect.ttlMs);
        return;
      }
      case "clearMarker":
        return clearMarker();
      case "notice":
        vscode.window.setStatusBarMessage(effect.text, effect.ttlMs);
        return;
      case "ghost":
        ghost = { docId: effect.docId, at: effect.at, text: effect.text };
        void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        return;
      case "clearGhost":
        ghost = undefined;
        return;
      case "saveLevel":
        void globalState.update(LEVEL_STATE, effect.level);
        return;
      case "log":
        appendLogEntry(effect.entry).catch((err) => console.error("Pawl: could not write session log", err));
        return;
    }
  }

  // Smoke tests point the client at a local fake; nothing else may redirect the key.
  const baseUrl = () =>
    context.extensionMode === vscode.ExtensionMode.Test ? process.env.PAWL_OPENROUTER_BASE_URL : undefined;
  const session = createSession({
    model: new OpenRouterClient(() => Promise.resolve(secrets.get(KEY_SECRET)), baseUrl),
    clock: Date,
    modelForLevel: (level) => vscode.workspace.getConfiguration("pawl").get<string>(`models.level${level}`) ?? "",
    level: LEVELS.find((l) => l.level === globalState.get(LEVEL_STATE))?.level,
    emit: apply,
  });
  const refreshKey = async () =>
    session.dispatch({ type: "keyChanged", hasKey: Boolean(await secrets.get(KEY_SECRET)) });
  // The active file's `@pawl` pin sets the status bar, so the session sees every change to it.
  const refreshActiveDoc = () => {
    const document = vscode.window.activeTextEditor?.document;
    return session.dispatch({
      type: "activeDocChanged",
      doc: document && !isNotebookCell(document) ? { languageId: document.languageId, text: document.getText() } : undefined,
    });
  };

  context.subscriptions.push(
    status,
    marker,
    { dispose: () => clearTimeout(markerTimer) },
    secrets.onDidChange((e) => {
      if (e.key === KEY_SECRET) void refreshKey();
    }),
    // A suggestion belongs to the spot it was asked for; it never comes back once the cursor leaves.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (ghost && (docIdOf(e.textEditor.document) !== ghost.docId || !e.selections[0].active.isEqual(toVs(ghost.at)))) {
        ghost = undefined;
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      ghost = undefined;
      void refreshActiveDoc();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) void refreshActiveDoc();
    }),

    vscode.commands.registerCommand("pawl.go", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || isNotebookCell(editor.document)) return;
      return session.dispatch({ type: "go", doc: snapshot(editor) });
    }),

    vscode.commands.registerCommand("pawl.levelUp", () => session.dispatch({ type: "levelUp" })),
    vscode.commands.registerCommand("pawl.levelDown", () => session.dispatch({ type: "levelDown" })),
    vscode.commands.registerCommand("pawl.off", () => session.dispatch({ type: "setLevel", level: 0 })),
    // Takes the level as an argument for tests; otherwise asks for it.
    vscode.commands.registerCommand("pawl.pickLevel", async (level?: Level) => {
      level ??= (
        await vscode.window.showQuickPick(
          LEVELS.map(({ level, name, writes }) => ({ label: `${level} · ${name}`, description: writes, level })),
          { title: "Pawl: Choose level" },
        )
      )?.level;
      if (level !== undefined) return session.dispatch({ type: "setLevel", level });
    }),

    // Takes the key as an argument for tests; otherwise asks for it.
    vscode.commands.registerCommand("pawl.setOpenRouterKey", async (key?: string) => {
      key ??= await vscode.window.showInputBox({
        title: "Pawl: Set OpenRouter key",
        prompt: "Stored in VS Code SecretStorage only. Leave empty to remove it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key.trim()) await secrets.store(KEY_SECRET, key.trim());
      else await secrets.delete(KEY_SECRET);
      await refreshKey();
    }),

    // Runs after VS Code inserts an item (Tab).
    vscode.commands.registerCommand("pawl._accepted", () => session.dispatch({ type: "accepted" })),

    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      {
        provideInlineCompletionItems(document, position) {
          if (!ghost || docIdOf(document) !== ghost.docId || !position.isEqual(toVs(ghost.at))) {
            return undefined;
          }
          return [
            new vscode.InlineCompletionItem(ghost.text, new vscode.Range(position, position), {
              title: "Accept Pawl suggestion",
              command: "pawl._accepted",
            }),
          ];
        },
      },
    ),
  );

  await refreshKey();
  await refreshActiveDoc();
  void checkCopilot();
}

const docIdOf = (document: vscode.TextDocument) => document.uri.toString();
const isNotebookCell = (document: vscode.TextDocument) => document.uri.scheme === "vscode-notebook-cell";

/** True when a `github.copilot.enable` value turns completions on: a boolean, or a per-language map. */
const copilotEnableIsOn = (value: unknown) =>
  value === true || (typeof value === "object" && value !== null && Object.values(value).includes(true));

/**
 * Warns when Copilot's ghost text would compete with Pawl's. Settings change only on the
 * button click, and only in this workspace.
 */
async function checkCopilot(): Promise<void> {
  const copilot = vscode.workspace.getConfiguration("github.copilot");
  const completions = copilot.get<unknown>("enable");
  const completionsOn = copilotEnableIsOn(completions);
  const nextEditsOn = copilot.get<unknown>("nextEditSuggestions.enabled") === true;
  if (!completionsOn && !nextEditsOn) return;

  const disable = "Disable for this workspace";
  const choice = await vscode.window.showWarningMessage(
    "Copilot inline suggestions are on. Their ghost text will compete with Pawl's.",
    disable,
  );
  if (choice !== disable) return;
  const workspace = vscode.ConfigurationTarget.Workspace;
  try {
    if (completionsOn) {
      const off =
        typeof completions === "object" && completions !== null
          ? { ...Object.fromEntries(Object.keys(completions).map((language) => [language, false])), "*": false }
          : false;
      await copilot.update("enable", off, workspace);
    }
    if (nextEditsOn) await copilot.update("nextEditSuggestions.enabled", false, workspace);
  } catch (err) {
    void vscode.window.showErrorMessage(`Pawl could not change the Copilot settings: ${err}`);
  }
}

function snapshot(editor: vscode.TextEditor): DocumentSnapshot {
  const { document, selection } = editor;
  return {
    docId: docIdOf(document),
    path: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    text: document.getText(),
    cursor: { line: selection.active.line, character: selection.active.character },
  };
}

export function deactivate(): void {}
