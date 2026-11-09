import { readdirSync } from "node:fs";
import { join } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 20_000, color: true });
  for (const file of readdirSync(__dirname)) {
    if (file.endsWith(".test.js")) mocha.addFile(join(__dirname, file));
  }
  return new Promise((resolve, reject) =>
    mocha.run((failures) => (failures ? reject(new Error(`${failures} smoke tests failed`)) : resolve())),
  );
}
