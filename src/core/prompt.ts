import type { Context } from "./context";
import type { ChatMessage, DocumentSnapshot, Level } from "./types";

const CURSOR = "<CURSOR>";

/** What each level may write. Levels 4 and 5 write a block until their own rules land. */
function stopInstruction(level: Level): string {
  if (level <= 1) return "Complete only the rest of the current line, then stop.";
  if (level === 2) {
    return (
      "Complete only the current statement, then stop. " +
      "If the cursor is in the header of a compound statement (if, for, def, func, …), complete only the header."
    );
  }
  return "Write the rest of the block or function the cursor is in, then stop. Write nothing after its end.";
}

/** What a level 3–5 retry adds after an empty reply. */
export const CONTINUE_NUDGE: ChatMessage = {
  role: "user",
  content: `Your reply was empty. Continue the implementation at ${CURSOR}.`,
};

/** `rules` are the file's `RULE:` texts. `notThis` is a suggestion the user just rejected at this spot. */
export function buildMessages(
  doc: DocumentSnapshot,
  level: Level,
  context: Context,
  rules: string[],
  notThis?: string,
): ChatMessage[] {
  const system = [
    "You are a code completion engine inside an editor.",
    `The user's file is given with the cursor marked ${CURSOR}.`,
    `Reply with only the text to insert at ${CURSOR}: no explanation, no markdown fences,`,
    "and never repeat text that is already before or after the cursor.",
    stopInstruction(level),
  ];
  if (context.truncated) system.push("Lines marked [… N lines left out …] are in the file but not shown.");
  if (rules.length > 0) {
    system.push(`\nThe user's rules for this file. Never break them:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }
  const shown = context.wholeFile ? "" : ", part of it";
  let file = `File: ${doc.path} (${doc.languageId})${shown}\n\n${context.before}${CURSOR}${context.after}`;
  if (notThis) file += `\n\nThe user rejected this completion; reply with a different one:\n${notThis}`;
  return [
    { role: "system", content: system.join(" ") },
    { role: "user", content: file },
  ];
}
