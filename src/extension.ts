// Thin VS Code adapter: turns editor actions into session events and applies the session's effects.
import * as vscode from "vscode";
import { createSession, type SessionConfig } from "./core/session";
import { LEVELS, type Clock, type DocumentSnapshot, type Effect, type Level, type Position } from "./core/types";
import { OpenRouterClient } from "./openrouter";
import { appendLogEntry } from "./sessionLog";

const KEY_SECRET = "pawl.openrouterKey";
const LEVEL_STATE = "pawl.level";
/** Context key the Esc and accept-next-word keybindings check, so they only wrap Pawl's suggestions. */
const VISIBLE_KEY = "pawl.suggestionVisible";

const clock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function readConfig(): SessionConfig {
  const config = vscode.workspace.getConfiguration("pawl");
  return {
    timeoutMs: config.get("timeout") === "4s" ? 4000 : 8000,
    log: { enabled: config.get("log.enabled", true), prompts: config.get("log.prompts", false) },
  };
}

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

  const setVisible = (visible: boolean) => vscode.commands.executeCommand("setContext", VISIBLE_KEY, visible);

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
        void setVisible(true);
        void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        return;
      case "clearGhost":
        ghost = undefined;
        void setVisible(false);
        void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
        return;
      case "collapseSelection": {
        const editor = editorFor(effect.docId);
        if (editor) editor.selections = [new vscode.Selection(toVs(effect.at), toVs(effect.at))];
        return;
      }
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
    clock,
    modelForLevel: (level) => vscode.workspace.getConfiguration("pawl").get<string>(`models.level${level}`) ?? "",
    config: readConfig,
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
    // The core decides what typing, moving and switching editors do to a request or suggestion.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const docId = docIdOf(e.document);
      for (const change of e.contentChanges) {
        const { start } = change.range;
        void session.dispatch({
          type: "edited",
          docId,
          at: { line: start.line, character: start.character },
          removed: change.rangeLength,
          text: change.text,
        });
      }
      if (e.document === vscode.window.activeTextEditor?.document) void refreshActiveDoc();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const { active } = e.selections[0];
      void session.dispatch({
        type: "cursorMoved",
        docId: docIdOf(e.textEditor.document),
        at: { line: active.line, character: active.character },
      });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void session.dispatch({ type: "editorChanged" });
      void refreshActiveDoc();
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

    // Esc and accept-next-word wrap VS Code's own commands so the core can log them.
    vscode.commands.registerCommand("pawl.reject", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
      await session.dispatch({ type: "rejected" });
    }),
    vscode.commands.registerCommand("pawl.acceptNextWord", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextWord");
      await session.dispatch({ type: "acceptedWord" });
    }),

    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      {
        provideInlineCompletionItems(document, position) {
          if (!ghost || docIdOf(document) !== ghost.docId) return undefined;
          // While the user types through it, the same item stays, spanning what they've typed.
          const start = toVs(ghost.at);
          if (position.isBefore(start)) return undefined;
          const typed = new vscode.Range(start, position);
          if (!ghost.text.startsWith(document.getText(typed))) return undefined;
          return [
            new vscode.InlineCompletionItem(ghost.text, typed, {
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
  const { document, selection, selections } = editor;
  return {
    docId: docIdOf(document),
    path: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    text: document.getText(),
    cursor: { line: selection.active.line, character: selection.active.character },
    cursorCount: selections.length,
    hasSelection: !selection.isEmpty,
  };
}

export function deactivate(): void {}
