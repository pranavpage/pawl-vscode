import type { Context } from "./context";
import { MAX_STEP_LINES } from "./stops";
import type { ChatMessage, DocumentSnapshot, Level } from "./types";

const CURSOR = "<CURSOR>";

/** What each level may write. */
function stopInstruction(level: Level): string {
  if (level <= 1) return "Complete only the rest of the current line, then stop.";
  if (level === 2) {
    return (
      "Complete only the current statement, then stop. " +
      "If the cursor is in the header of a compound statement (if, for, def, func, …), complete only the header."
    );
  }
  if (level === 5) return `Write only the code for the plan step given below, then stop. Write at most ${MAX_STEP_LINES} lines.`;
  return "Write the rest of the block or function the cursor is in, then stop. Write nothing after its end.";
}

/** Levels 3–5 may ask instead of guessing. */
const QUESTION_INSTRUCTION =
  "If the request is too ambiguous to write good code, reply instead with a single line that starts with " +
  '"Q: " and asks the user one short question. Never mix a question with code.';

/** What a level 4–5 press asks for, beyond the level's stop rule. */
export type Task =
  | { kind: "todo"; line: number; text: string }
  | { kind: "body"; line: number }
  | { kind: "step"; number: number; text: string };

function taskInstruction(task: Task): string {
  switch (task.kind) {
    case "todo":
      return (
        `Write the code that the TODO comment on line ${task.line + 1} asks for: "${task.text}". ` +
        "Write only that code, starting at the cursor. Don't repeat the TODO comment; it is removed once the code is in."
      );
    case "body":
      return (
        `Fill the empty body of the function on line ${task.line + 1}, starting at the cursor. ` +
        "Its docstring and comments stay; don't repeat them. A placeholder such as pass, ..., " +
        "raise NotImplementedError or panic(...) is removed once the code is in, so don't keep it."
      );
    case "step":
      return (
        `The file has a plan. Write the code for step ${task.number} only: "${task.text}". ` +
        "The cursor is on an empty line where the step's code goes. " +
        "If the step needs a new import, write each import statement on its own line at the very start of your reply; " +
        "Pawl moves them to the file's imports. Don't edit the plan."
      );
  }
}

/** What a level 3–5 retry adds after an empty reply. */
export const CONTINUE_NUDGE: ChatMessage = {
  role: "user",
  content: `Your reply was empty. Continue the implementation at ${CURSOR}.`,
};

/**
 * `rules` are the file's `RULE:` texts. `task` is what levels 4–5 fill. `notThis` is a
 * suggestion the user just rejected at this spot.
 */
export function buildMessages(
  doc: DocumentSnapshot,
  level: Level,
  context: Context,
  rules: string[],
  { task, notThis }: { task?: Task; notThis?: string } = {},
): ChatMessage[] {
  const system = [
    "You are a code completion engine inside an editor.",
    `The user's file is given with the cursor marked ${CURSOR}.`,
    `Reply with only the text to insert at ${CURSOR}: no explanation, no markdown fences,`,
    "and never repeat text that is already before or after the cursor.",
    stopInstruction(level),
  ];
  if (task) system.push(taskInstruction(task));
  if (level >= 3) system.push(QUESTION_INSTRUCTION);
  if (context.related.length > 0) system.push("Other files from the workspace come first, for reference only.");
  if (context.truncated) system.push("Lines marked [… N lines left out …] are in the file but not shown.");
  if (rules.length > 0) {
    system.push(`\nThe user's rules for this file. Never break them:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }
  const shown = context.wholeFile ? "" : ", part of it";
  const related = context.related.map((f) => `Reference file: ${f.path}\n\n${f.text}\n\n`).join("");
  let file = `${related}File: ${doc.path} (${doc.languageId})${shown}\n\n${context.before}${CURSOR}${context.after}`;
  if (notThis) file += `\n\nThe user rejected this completion; reply with a different one:\n${notThis}`;
  return [
    { role: "system", content: system.join(" ") },
    { role: "user", content: file },
  ];
}
