// Comment markers the user writes in the file to talk to Pawl. Markers only count inside
// comments, and only with their exact prefix at the start of the comment.
import { commentsIn, scanLines, syntaxFor, type ScannedLine } from "./lexer";
import type { DocumentSnapshot, Level, Position } from "./types";

/** A pin only counts in the first lines of the file. */
const PIN_LINES = 5;

type Doc = Pick<DocumentSnapshot, "languageId" | "text">;

/** A marker at the start of a comment, allowing the `*` that starts lines inside block comments. */
const marker = (prefix: string) => new RegExp(`^\\s*(?:\\*\\s*)?${prefix}`);
const PIN = /@pawl(?![\w-])/;
const RULE = marker("RULE:\\s*(\\S.*?)\\s*$");
const PLAN = marker("PLAN\\b");
const END_PLAN = marker("END PLAN\\b");
const TODO = marker("TODO:\\s*(.*?)\\s*$");
/** A plan step: `[ ]` or `[x]`, after an optional bullet or number. */
const STEP = /^\s*(?:\*\s*)?(?:[-*+]\s+|\d+[.)]\s+)?\[([ xX])\]\s*(.*?)\s*$/;
const ANY_MARKER = [PIN, RULE, PLAN, END_PLAN, TODO, STEP];

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

/** A `TODO:` comment, with the comment lines right under it that carry on its text. */
export interface Todo {
  line: number;
  endLine: number;
  text: string;
  /**
   * The whole comment, delimiters included, when it can be removed on its own: it starts on
   * `line` and ends on `endLine`, and holds nothing but the TODO.
   */
  span?: { start: Position; end: Position };
}

export interface PlanStep {
  /** 1 for the plan's first step. */
  number: number;
  line: number;
  text: string;
  done: boolean;
  /** The space in its `[ ]`, which ticking turns into `x`. */
  box: Position;
}

export interface Markers {
  /** The text of each `RULE:`, in file order. */
  rules: string[];
  /** Lines the context always keeps: `RULE:`, `@pawl` and the `PLAN … END PLAN` block. */
  lines: number[];
  todos: Todo[];
  /** The steps of the first `PLAN … END PLAN` block that has any; undefined without one. */
  plan?: PlanStep[];
}

const isCommentOnly = (line: ScannedLine) => line.code.trim() === "" && line.comment.trim() !== "";

export function findMarkers(doc: Doc): Markers {
  const scanned = scanLines(doc.text, syntaxFor(doc.languageId));
  const source = doc.text.split("\n");
  const rules: string[] = [];
  const lines: number[] = [];
  const todos: Todo[] = [];
  const plans: PlanStep[][] = [];
  /** The plan being read, until its `END PLAN` or the first line of code. */
  let reading: PlanStep[] | undefined;
  scanned.forEach(({ comment, code }, line) => {
    if (reading && code.trim() !== "") reading = undefined;
    const rule = RULE.exec(comment);
    if (rule) rules.push(rule[1]);
    if (PLAN.test(comment)) plans.push((reading = []));
    if (rule || reading || PIN.test(comment)) lines.push(line);
    if (END_PLAN.test(comment)) reading = undefined;
    else if (reading && !PLAN.test(comment)) readStep(reading, scanned[line], source[line], line);
    const todo = TODO.exec(comment);
    if (todo) todos.push(todoAt(scanned, line, todo[1]));
  });
  return { rules, lines, todos, plan: plans.find((steps) => steps.length > 0) };
}

function readStep(steps: PlanStep[], { comment, commentStart }: ScannedLine, source: string, line: number): void {
  const step = STEP.exec(comment);
  if (step) {
    steps.push({
      number: steps.length + 1,
      line,
      text: step[2],
      done: step[1] !== " ",
      // Only the comment delimiter and a bullet come before the box.
      box: { line, character: source.indexOf("[", commentStart) + 1 },
    });
  } else if (comment.trim() && steps.length > 0) {
    // A line under a step carries on its text.
    steps[steps.length - 1].text += ` ${comment.trim().replace(/^\*\s*/, "")}`;
  }
}

function todoAt(scanned: ScannedLine[], line: number, text: string): Todo {
  const first = scanned[line];
  let endLine = line;
  // Comment lines right under it carry on its text, unless they are markers of their own.
  for (let j = line + 1; j < scanned.length; j++) {
    const next = scanned[j];
    const continues = next.startsInText || next.commentStart === first.commentStart;
    if (!isCommentOnly(next) || !continues || ANY_MARKER.some((m) => m.test(next.comment))) break;
    text += ` ${next.comment.trim().replace(/^\*\s*/, "")}`;
    endLine = j;
  }
  const last = scanned[endLine];
  const removable = !first.startsInText && !last.endsInText && first.commentStart !== undefined;
  return {
    line,
    endLine,
    text,
    span: removable
      ? { start: { line, character: first.commentStart! }, end: { line: endLine, character: last.commentEnd! } }
      : undefined,
  };
}
