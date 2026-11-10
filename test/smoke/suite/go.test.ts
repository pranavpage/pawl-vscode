import * as assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { connectDevTools, type DevTools } from "./devtools";

/** A stand-in for OpenRouter that streams the next scripted reply per request and records what was sent. */
function fakeOpenRouter() {
  const replies: string[][] = [];
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": OPENROUTER PROCESSING\n\n");
      for (const content of replies.shift() ?? []) {
        res.write(`data: ${JSON.stringify({ provider: "FakeProvider", choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, requests, replies };
}

async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every session log line written so far. */
function logLines(): string[] {
  const dir = join(process.env.PAWL_HOME!, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((log) => readFileSync(join(dir, log), "utf8").trim().split("\n"));
}

describe("Pawl smoke", () => {
  const openRouter = fakeOpenRouter();
  let devtools: DevTools;
  let editor: vscode.TextEditor;
  let original: string;
  /** Log lines written before the current test. */
  let logged: number;

  /** Waits for the current test's single log line and returns it. */
  async function logEntry() {
    const lines = await waitFor(() => logLines().length > logged && logLines(), "the session log line");
    assert.equal(lines.length, logged + 1, "one log line per go-press");
    return JSON.parse(lines[logged]);
  }

  before(async () => {
    await new Promise<void>((r) => openRouter.server.listen(0, "127.0.0.1", r));
    const { port } = openRouter.server.address() as AddressInfo;
    process.env.PAWL_OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
    await vscode.extensions.getExtension("pranavpage.pawl")!.activate();
    devtools = await connectDevTools();
    await vscode.commands.executeCommand("pawl.setOpenRouterKey", "sk-or-smoke-test");
    const [file] = await vscode.workspace.findFiles("main.py");
    editor = await vscode.window.showTextDocument(file);
    original = editor.document.getText();
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    const cursor = new vscode.Position(1, 10);
    editor.selection = new vscode.Selection(cursor, cursor);
    logged = logLines().length;
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(editor.document.getText(), original);
  });

  after(() => {
    devtools?.close();
    openRouter.server.close();
  });

  it("go arms a suggestion that Tab inserts, and logs the accept", async () => {
    openRouter.replies.push(["```python\n", "name)\n", "    return name\n"]);

    // Typing and pausing never sends a request.
    await vscode.commands.executeCommand("type", { text: "x" });
    await vscode.commands.executeCommand("deleteLeft");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(openRouter.requests.length, 0);

    await vscode.commands.executeCommand("pawl.go");
    assert.equal(openRouter.requests.length, 1);
    const [request] = openRouter.requests;
    assert.equal(request.headers.authorization, "Bearer sk-or-smoke-test");
    assert.deepEqual(request.body.reasoning, { effort: "none" });
    assert.deepEqual(request.body.provider, { sort: "latency" });
    assert.equal(request.body.stream, true);

    assert.equal(await waitFor(() => devtools.ghostText(), "ghost text"), "name)");
    await devtools.pressKey("Tab");
    await waitFor(() => editor.document.lineAt(1).text !== "    print(", "Tab to insert the suggestion");
    assert.equal(editor.document.lineAt(1).text, "    print(name)");
    assert.equal(editor.document.lineAt(2).text, "", "only the current line is completed");

    const entry = await logEntry();
    assert.equal(entry.outcome, "accepted");
    assert.equal(entry.suggestion, "name)");
    assert.equal(entry.provider, "FakeProvider");
    assert.ok(!logLines().some((l) => l.includes("sk-or-smoke-test")), "the key never appears in the log");
    const settings = join(process.env.PAWL_USER_DATA_DIR!, "User", "settings.json");
    assert.ok(
      !existsSync(settings) || !readFileSync(settings, "utf8").includes("sk-or-smoke-test"),
      "the key never appears in settings.json",
    );
  });

  it("Esc hides the suggestion and logs it as rejected", async () => {
    openRouter.replies.push(["name)\n"]);

    await vscode.commands.executeCommand("pawl.go");
    await waitFor(() => devtools.ghostText(), "ghost text");
    await devtools.pressKey("Escape");
    await waitFor(async () => !(await devtools.ghostText()), "the ghost text to go");

    assert.equal(editor.document.lineAt(1).text, "    print(");
    assert.equal((await logEntry()).outcome, "rejected");
  });

  it("the suggestion stays while typed through, and Tab then accepts the rest", async () => {
    openRouter.replies.push(["name)\n"]);

    await vscode.commands.executeCommand("pawl.go");
    await waitFor(() => devtools.ghostText(), "ghost text");
    await vscode.commands.executeCommand("type", { text: "n" });
    await vscode.commands.executeCommand("type", { text: "a" });
    await waitFor(async () => (await devtools.ghostText()) === "me)", "the rest to stay as ghost text");
    await devtools.pressKey("Tab");
    await waitFor(() => editor.document.lineAt(1).text === "    print(name)", "Tab to insert the rest");

    assert.equal((await logEntry()).outcome, "accepted");
  });

  it("level 3 writes only the block, cut by the bundled Python grammar", async () => {
    // Indentation alone would end the block at the column-0 comment; the parser keeps it in.
    openRouter.replies.push(["name)\n# note\n", "    return name\n", "\n\ngreet('x')\n"]);
    await vscode.commands.executeCommand("pawl.pickLevel", 3);
    try {
      await vscode.commands.executeCommand("pawl.go");
      assert.equal(await waitFor(() => devtools.ghostText(), "ghost text"), "name)");
      await devtools.pressKey("Escape");

      const entry = await logEntry();
      assert.equal(entry.level, 3);
      assert.equal(entry.outcome, "rejected");
      assert.equal(entry.suggestion, "name)\n# note\n    return name");
    } finally {
      await vscode.commands.executeCommand("pawl.pickLevel", 1);
    }
  });

  it("accept-next-word takes one word and logs partial once the rest is rejected", async () => {
    openRouter.replies.push(["name, end='')\n"]);

    await vscode.commands.executeCommand("pawl.go");
    await waitFor(() => devtools.ghostText(), "ghost text");
    await devtools.pressKey("ArrowRight", { mod: true });
    const line = await waitFor(() => {
      const text = editor.document.lineAt(1).text;
      return text !== "    print(" && text;
    }, "the next word to be inserted");
    assert.ok("    print(name, end='')".startsWith(line) && line.length < "    print(name, end='')".length);
    await devtools.pressKey("Escape");

    const entry = await logEntry();
    assert.equal(entry.outcome, "partial");
    assert.equal(entry.accepted_chars, line.length - "    print(".length);
  });
});
