import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogEntry } from "./core/types";

/** `~/.pawl/sessions`, or `$PAWL_HOME/sessions` when set. */
function sessionsDir(): string {
  return join(process.env.PAWL_HOME ?? join(homedir(), ".pawl"), "sessions");
}

/** Appends one JSONL line to the file for the entry's local date (`YYYY-MM-DD.jsonl`). */
export async function appendLogEntry(entry: LogEntry): Promise<void> {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n");
}
