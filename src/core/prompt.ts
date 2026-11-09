import type { ChatMessage, DocumentSnapshot } from "./types";

const CURSOR = "<CURSOR>";

export interface Context {
  before: string;
  after: string;
}

/** Level 1 sees the file around the cursor; no symbol lookup. */
export function assembleContext(doc: DocumentSnapshot): Context {
  const lines = doc.text.split("\n");
  const { line, character } = doc.cursor;
  const before = [...lines.slice(0, line), lines[line].slice(0, character)].join("\n");
  const after = [lines[line].slice(character), ...lines.slice(line + 1)].join("\n");
  return { before, after };
}

/** `notThis` is a suggestion the user just rejected at this spot. */
export function buildMessages(doc: DocumentSnapshot, context: Context, notThis?: string): ChatMessage[] {
  let file = `File: ${doc.path} (${doc.languageId})\n\n${context.before}${CURSOR}${context.after}`;
  if (notThis) file += `\n\nThe user rejected this completion; reply with a different one:\n${notThis}`;
  return [
    {
      role: "system",
      content: [
        "You are a code completion engine inside an editor.",
        `The user's file is given with the cursor marked ${CURSOR}.`,
        `Reply with only the text to insert at ${CURSOR}: no explanation, no markdown fences,`,
        "and never repeat text that is already before or after the cursor.",
        "Complete only the rest of the current line, then stop.",
      ].join(" "),
    },
    {
      role: "user",
      content: file,
    },
  ];
}
