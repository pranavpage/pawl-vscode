import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { connectDevTools, type DevTools } from "./devtools";

describe("Pawl dial smoke", () => {
  let devtools: DevTools;

  before(async () => {
    await vscode.extensions.getExtension("pranavpage.pawl")!.activate();
    devtools = await connectDevTools();
  });

  after(() => devtools?.close());

  /** Waits for the status bar to settle on `expected`, and fails with what it showed instead. */
  async function statusBecomes(expected: string): Promise<void> {
    const deadline = Date.now() + 5000;
    let text: string | undefined;
    while ((text = await devtools.statusText()) !== expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(text, expected);
  }

  it("the level keys move the dial, the off key overrides a pin, and a pin holds the dial", async () => {
    await vscode.commands.executeCommand("pawl.setOpenRouterKey", "sk-or-smoke-test");
    const [file] = await vscode.workspace.findFiles("main.py");
    const editor = await vscode.window.showTextDocument(file);
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await statusBecomes("Pawl 1");

    await devtools.pressKey("=", { alt: true });
    await statusBecomes("Pawl 2");
    await devtools.pressKey("-", { alt: true });
    await statusBecomes("Pawl 1");
    await devtools.pressKey("0", { alt: true });
    await statusBecomes("Pawl off");
    await devtools.pressKey("=", { alt: true });
    await statusBecomes("Pawl 1");

    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "# @pawl level=3\n"));
    await statusBecomes("Pawl 3 · pinned");
    await devtools.pressKey("=", { alt: true });
    await new Promise((r) => setTimeout(r, 300));
    await statusBecomes("Pawl 3 · pinned");
    await devtools.pressKey("0", { alt: true });
    await statusBecomes("Pawl off");
    await devtools.pressKey("=", { alt: true });
    await statusBecomes("Pawl 3 · pinned");

    await vscode.commands.executeCommand("pawl.pickLevel", 1);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await statusBecomes("Pawl 1");
  });
});
