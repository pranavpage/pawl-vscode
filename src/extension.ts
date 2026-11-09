// Thin VS Code adapter: turns editor actions into session events and applies the session's effects.
import * as vscode from "vscode";
import { createSession } from "./core/session";
import type { DocumentSnapshot, Effect, Level, Position } from "./core/types";
import { OpenRouterClient } from "./openrouter";
import { appendLogEntry } from "./sessionLog";

const KEY_SECRET = "pawl.openrouterKey";
const DEFAULT_MODELS: Record<Level, string> = {
  0: "",
  1: "deepseek/deepseek-v4.1-flash",
  2: "deepseek/deepseek-v4.1-flash",
  3: "z-ai/glm-5.3",
  4: "z-ai/glm-5.3",
  5: "moonshotai/kimi-k3.1-pro",
};

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
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === docId);
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
      case "ghost":
        ghost = { docId: effect.docId, at: effect.at, text: effect.text };
        void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        return;
      case "clearGhost":
        ghost = undefined;
        return;
      case "log":
        appendLogEntry(effect.entry).catch((err) => console.error("Pawl: could not write session log", err));
        return;
    }
  }

  const session = createSession({
    model: new OpenRouterClient(() => Promise.resolve(secrets.get(KEY_SECRET))),
    clock: Date,
    modelForLevel: (level) =>
      vscode.workspace.getConfiguration("pawl").get<string>(`models.level${level}`) || DEFAULT_MODELS[level],
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

    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      {
        provideInlineCompletionItems(document, position) {
          if (!ghost || document.uri.toString() !== ghost.docId || !position.isEqual(toVs(ghost.at))) {
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
}

function snapshot(editor: vscode.TextEditor): DocumentSnapshot {
  const { document, selection } = editor;
  return {
    docId: document.uri.toString(),
    path: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    text: document.getText(),
    cursor: { line: selection.active.line, character: selection.active.character },
  };
}

export function deactivate(): void {}
