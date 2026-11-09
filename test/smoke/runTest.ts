import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

// Lets the suite drive the window over the Chrome DevTools Protocol (focus emulation, real key presses).
const DEVTOOLS_PORT = 9333;

async function main(): Promise<void> {
  const root = resolve(__dirname, "../../..");
  const scratch = mkdtempSync(join(tmpdir(), "pawl-smoke-"));
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(__dirname, "suite/index"),
    launchArgs: [
      resolve(root, "test/smoke/workspace"),
      "--disable-extensions",
      `--user-data-dir=${join(scratch, "user-data")}`,
      `--remote-debugging-port=${DEVTOOLS_PORT}`,
    ],
    extensionTestsEnv: {
      PAWL_HOME: join(scratch, "pawl"),
      PAWL_DEVTOOLS_PORT: String(DEVTOOLS_PORT),
      PAWL_USER_DATA_DIR: join(scratch, "user-data"),
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
