// Thin VS Code adapter: turns editor actions into session events and applies the session's effects.
import * as vscode from "vscode";
import { createSession, type SessionConfig } from "./core/session";
import type { Clock, DocumentSnapshot, Effect, Position } from "./core/types";
import { OpenRouterClient } from "./openrouter";
import { appendLogEntry } from "./sessionLog";

const KEY_SECRET = "pawl.openrouterKey";
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
  const { secrets } = context;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
    emit: apply,
  });
  const refreshKey = async () =>
    session.dispatch({ type: "keyChanged", hasKey: Boolean(await secrets.get(KEY_SECRET)) });

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
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const { active } = e.selections[0];
      void session.dispatch({
        type: "cursorMoved",
        docId: docIdOf(e.textEditor.document),
        at: { line: active.line, character: active.character },
      });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => session.dispatch({ type: "editorChanged" })),

    vscode.commands.registerCommand("pawl.go", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      return session.dispatch({ type: "go", doc: snapshot(editor) });
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
}

const docIdOf = (document: vscode.TextDocument) => document.uri.toString();

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
