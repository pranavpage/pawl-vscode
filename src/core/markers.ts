// Comment markers the user writes in the file to talk to Pawl. Markers only count inside
// comments, and only with their exact prefix at the start of the comment.
import { commentsIn, syntaxFor } from "./lexer";
import type { DocumentSnapshot, Level } from "./types";

/** A pin only counts in the first lines of the file. */
const PIN_LINES = 5;

type Doc = Pick<DocumentSnapshot, "languageId" | "text">;

/** A marker at the start of a comment, allowing the `*` that starts lines inside block comments. */
const marker = (prefix: string) => new RegExp(`^\\s*(?:\\*\\s*)?${prefix}`);
const PIN = /@pawl(?![\w-])/;
const RULE = marker("RULE:\\s*(\\S.*?)\\s*$");
const PLAN = marker("PLAN\\b");
const END_PLAN = marker("END PLAN\\b");

/** The file's `@pawl level=N` pin: absent, a valid level, or a typo. */
export type Pin = { level: Level } | "bad" | undefined;

export function findPin(doc: Doc): Pin {
  const head = doc.text.split("\n", PIN_LINES).join("\n");
  for (const comment of commentsIn(head, syntaxFor(doc.languageId))) {
    const at = PIN.exec(comment);
    if (!at) continue;
    const pin = /^\s+level=([0-5])(?!\S)/.exec(comment.slice(at.index + at[0].length));
    return pin ? { level: Number(pin[1]) as Level } : "bad";
  }
  return undefined;
}

export interface Markers {
  /** The text of each `RULE:`, in file order. */
  rules: string[];
  /** Lines the context always keeps: `RULE:`, `@pawl` and the `PLAN … END PLAN` block. */
  lines: number[];
}

export function findMarkers(doc: Doc): Markers {
  const rules: string[] = [];
  const lines: number[] = [];
  let inPlan = false;
  commentsIn(doc.text, syntaxFor(doc.languageId)).forEach((comment, line) => {
    const rule = RULE.exec(comment);
    if (rule) rules.push(rule[1]);
    if (PLAN.test(comment)) inPlan = true;
    if (rule || inPlan || PIN.test(comment)) lines.push(line);
    if (END_PLAN.test(comment)) inPlan = false;
  });
  return { rules, lines };
}
