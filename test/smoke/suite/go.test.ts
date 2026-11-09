import * as assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { connectDevTools, type DevTools } from "./devtools";

/** A stand-in for OpenRouter that streams one scripted reply per request and records what was sent. */
function fakeOpenRouter(reply: string[]) {
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": OPENROUTER PROCESSING\n\n");
      for (const content of reply) {
        res.write(`data: ${JSON.stringify({ provider: "FakeProvider", choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
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

describe("Pawl smoke", () => {
  const openRouter = fakeOpenRouter(["```python\n", "name)\n", "    return name\n"]);
  let devtools: DevTools;

  before(async () => {
    await new Promise<void>((r) => openRouter.server.listen(0, "127.0.0.1", r));
    const { port } = openRouter.server.address() as AddressInfo;
    process.env.PAWL_OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
    await vscode.extensions.getExtension("pranavpage.pawl")!.activate();
    devtools = await connectDevTools();
  });

  after(() => {
    devtools?.close();
    openRouter.server.close();
  });

  it("go arms a suggestion that Tab inserts, and logs the accept", async () => {
    await vscode.commands.executeCommand("pawl.setOpenRouterKey", "sk-or-smoke-test");
    const [file] = await vscode.workspace.findFiles("main.py");
    const editor = await vscode.window.showTextDocument(file);
    const original = editor.document.getText();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    const cursor = new vscode.Position(1, 10);
    editor.selection = new vscode.Selection(cursor, cursor);

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

    const logDir = join(process.env.PAWL_HOME!, "sessions");
    const lines = await waitFor(() => {
      try {
        const [log] = readdirSync(logDir);
        return log && readFileSync(join(logDir, log), "utf8").trim().split("\n");
      } catch {
        return undefined;
      }
    }, "the session log line");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.outcome, "accepted");
    assert.equal(entry.suggestion, "name)");
    assert.equal(entry.provider, "FakeProvider");
    assert.ok(!lines[0].includes("sk-or-smoke-test"), "the key never appears in the log");

    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(editor.document.getText(), original);
  });
});
