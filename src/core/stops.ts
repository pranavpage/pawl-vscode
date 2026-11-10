// Stop points: where a suggestion must end at each level. Python and Go are parsed with
// tree-sitter, with the suggestion inserted at the cursor. Other languages, and replies
// the parser can't make sense of, use indentation and brackets.
import { splitImports } from "./imports";
import { Lexer, syntaxFor } from "./lexer";
import { hasErrorIn, type Grammar, type Node } from "./syntax";
import type { Level } from "./types";

/** The document split at the cursor, where the suggestion goes. */
export interface Insertion {
  head: string;
  tail: string;
  languageId: string;
}

/**
 * Cuts a reply at the level's stop point: returns the cut once the stop point has streamed
 * in, else undefined. Once `done`, it always returns the suggestion. Between calls, `text`
 * may only grow.
 */
export type StopRule = (text: string, done: boolean) => string | undefined;

/** Level 2 finishes a statement; levels 3 and up write a block. */
type Unit = "statement" | "block";

export function stopRule(level: Level, at: Insertion, grammar?: Grammar): StopRule {
  if (level <= 1) {
    return (text, done) => {
      const eol = text.indexOf("\n");
      return eol >= 0 ? text.slice(0, eol) : done ? text : undefined;
    };
  }
  const unit: Unit = level === 2 ? "statement" : "block";
  const lexer = new Lexer(syntaxFor(at.languageId)).read(at.head);
  const heuristic = (text: string) => heuristicEnd(unit, at, lexer.clone(), text);

  if (!grammar) {
    return (text, done) => {
      const end = heuristic(text) ?? (done ? text.length : undefined);
      return end === undefined ? undefined : text.slice(0, end).trimEnd();
    };
  }

  const tree = new TreeStops(unit, at, grammar);
  /** Lines before this offset have been checked. */
  let checked = 0;
  return (text, done) => {
    // A stop point can only be known at the end of a line, or of the reply.
    for (let eol = text.indexOf("\n", checked); eol >= 0; eol = text.indexOf("\n", eol + 1)) {
      checked = eol + 1;
      const end = tree.end(text.slice(0, eol), false);
      if (end !== undefined) return text.slice(0, end).trimEnd();
    }
    if (!done) return undefined;
    const end = tree.end(text, true) ?? heuristic(text) ?? text.length;
    return text.slice(0, end).trimEnd();
  };
}

/** Where the unit is looked up: the last code before the cursor on its line, else the first code written. */
function anchorFor(head: string, written: string): number | undefined {
  const lineStart = head.lastIndexOf("\n") + 1;
  const before = head.slice(lineStart).trimEnd();
  if (before.trim()) return lineStart + before.length - 1;
  const first = written.search(/\S/);
  return first < 0 ? undefined : head.length + first;
}

/** True if the cursor's line is blank and the first code written is on a later line, left of the cursor. */
function startsLeftOfCursor(head: string, written: string): boolean {
  const cursorLine = head.slice(head.lastIndexOf("\n") + 1);
  const first = written.search(/\S/);
  if (cursorLine.trim() || first < 0) return false;
  const lineStart = written.lastIndexOf("\n", first) + 1;
  return lineStart > 0 && first - lineStart < cursorLine.length;
}

/** Stop points from the syntax tree of the document with the suggestion inserted. */
class TreeStops {
  private file?: { errors: number; closedByTail: boolean };

  constructor(
    private unit: Unit,
    private at: Insertion,
    private grammar: Grammar,
  ) {}

  /**
   * Where the unit ends within `written`, as an offset into it. Undefined while the unit may
   * still go on or the parse has errors. Once `done`, everything written is in the unit
   * unless it ended earlier.
   */
  end(written: string, done: boolean): number | undefined {
    const { head, tail } = this.at;
    let anchor = anchorFor(head, written);
    if (anchor === undefined) return done ? written.length : undefined;
    // In Python, a first line left of a blank cursor's column is already outside its block.
    if (!this.grammar.braces && startsLeftOfCursor(head, written)) return 0;
    const text = head + written + tail;
    const tree = this.grammar.parser.parse(text);
    if (!tree) return undefined;
    try {
      const from = head.length;
      const to = from + written.length;
      const root = tree.rootNode;
      let node = root.descendantForIndex(anchor);
      // Comments the suggestion starts with belong to the code after them.
      while (node?.type === "comment" && anchor >= from) {
        const next = text.slice(node.endIndex, to).search(/\S/);
        if (next < 0) return done ? written.length : undefined;
        anchor = node.endIndex + next;
        node = root.descendantForIndex(anchor);
      }
      if (!node) return undefined;
      const end = this.unit === "statement" ? this.statementEnd(node, anchor, to, done) : this.blockEnd(node, anchor, to, done);
      if (end === undefined) return undefined;
      // An end followed by an error on its line is no end: Go's `func f()` is complete without its ` {`.
      const eol = text.indexOf("\n", end);
      if (end < to && hasErrorIn(root, end, eol < 0 ? text.length : eol)) return undefined;
      // Keeping the whole reply must not make the file worse, as repeating a `}` it already has would.
      if (end >= to && countErrors(root) > this.original().errors) return undefined;
      return Math.min(Math.max(end - from, 0), written.length);
    } finally {
      tree.delete();
    }
  }

  /** Level 2: the end of the statement, or of the header if the anchor is in one. */
  private statementEnd(node: Node, anchor: number, to: number, done: boolean): number | undefined {
    const statement = this.statementAt(node);
    if (!statement) return undefined;
    const header = this.headerAt(node, anchor, statement);
    const end = header ? this.headerEnd(header) : statement.endIndex;
    if (hasErrorIn(statement, statement.startIndex, end)) return undefined;
    // It must end on the line the suggestion ends on, the rest of the cursor's line included.
    const lineEnd = to + restOfLine(this.at.tail).length;
    if (end <= lineEnd) return end;
    return done ? to : undefined;
  }

  /**
   * Levels 3 and up: the end of the innermost block, or of a statement whose header the user
   * has started. Outside any block, the end of the top-level statement.
   */
  private blockEnd(node: Node, anchor: number, to: number, done: boolean): number | undefined {
    const from = this.at.head.length;
    const statement = this.statementAt(node);
    let unit: Node | undefined;
    for (let n: Node | null = node; n && !unit; n = n.parent) {
      if (n.type === "block") unit = n;
      else if (n.startIndex < from && inHeader(n, anchor)) unit = n;
    }
    unit ??= statement;
    if (!unit) return undefined;
    const isBlock = unit.type === "block";
    // Go blocks end at their closing brace; a Python block only once something follows it.
    const ended = this.grammar.braces ? unit.endIndex <= to : contentBetween(node.tree.rootNode, unit.endIndex, to);
    if (!ended && !done) return undefined;
    const end = ended ? unit.endIndex : to;
    if (hasErrorIn(unit, from, end)) return undefined;
    if (ended && this.grammar.braces && isBlock && this.original().closedByTail) {
      // The file already closes this block, so the suggestion's own `}` is left out.
      return unit.lastChild?.startIndex;
    }
    return end;
  }

  /** The statement around `node`. */
  private statementAt(node: Node): Node | undefined {
    for (let n: Node | null = node; n?.parent; n = n.parent) {
      if (this.grammar.containers.has(n.parent.type)) return n;
    }
    return undefined;
  }

  /** The innermost node from `node` up to `top` whose header holds the anchor. */
  private headerAt(node: Node, anchor: number, top: Node): Node | undefined {
    for (let n: Node | null = node; n; n = n.parent) {
      if (inHeader(n, anchor)) return n;
      if (n.id === top.id) return undefined;
    }
    return undefined;
  }

  /** The end of a header: Python's `:`, Go's `{`. */
  private headerEnd(node: Node): number {
    const body = bodyOf(node)!;
    if (body.type === "{" || this.grammar.braces) return body.startIndex + 1;
    return body.previousSibling?.endIndex ?? body.startIndex;
  }

  /**
   * The file without the suggestion: how many parse errors it has, and whether it has a `}`
   * for the block at the cursor.
   */
  private original(): { errors: number; closedByTail: boolean } {
    if (this.file) return this.file;
    const { head, tail } = this.at;
    const at = head.length;
    const tree = this.grammar.parser.parse(head + tail);
    if (!tree) return (this.file = { errors: Infinity, closedByTail: false });
    let block: Node | undefined;
    for (let n: Node | undefined = tree.rootNode; n; n = n.children.find((c) => c.startIndex < at && at < c.endIndex)) {
      if (n.type === "block") block = n;
    }
    const brace = block?.lastChild;
    const closedByTail = brace?.type === "}" && !brace.isMissing && brace.startIndex >= at;
    this.file = { errors: countErrors(tree.rootNode), closedByTail };
    tree.delete();
    return this.file;
  }
}

/** How many error and missing nodes the tree has. */
function countErrors(node: Node): number {
  if (node.isError || node.isMissing) return 1;
  return node.hasError ? node.children.reduce((n, child) => n + countErrors(child), 0) : 0;
}

/** A node's body: a block, or for Go's `switch` and `select` the opening brace. */
function bodyOf(node: Node): Node | undefined {
  const body = node.children.find((child) => child.type === "block" || child.type === "{");
  if (body) return body;
  // Python's decorated function or class.
  const definition = node.childForFieldName("definition");
  return definition ? bodyOf(definition) : undefined;
}

/** True if `node` has a body and the anchor comes before it. */
function inHeader(node: Node, anchor: number): boolean {
  const body = bodyOf(node);
  return body !== undefined && anchor < body.startIndex;
}

/** True if [from, to) has anything but whitespace and comments. */
function contentBetween(root: Node, from: number, to: number): boolean {
  const text = root.text;
  for (let i = from; i < to; i++) {
    if (/\s/.test(text[i])) continue;
    const node = root.descendantForIndex(i);
    if (node?.type !== "comment") return true;
    i = node.endIndex - 1;
  }
  return false;
}

const restOfLine = (tail: string) => {
  const eol = tail.indexOf("\n");
  return eol < 0 ? tail : tail.slice(0, eol);
};

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Characters that leave a statement unfinished at the end of a line. */
const CONTINUES = new Set(["\\", ",", "+", "-", "*", "/", "%", "=", "&", "|", "^", "."]);

function continuesOnNextLine(lineEnd: string): boolean {
  if (lineEnd === "++" || lineEnd === "--") return false;
  return lineEnd === "=>" || lineEnd === "->" || CONTINUES.has(lineEnd.at(-1) ?? "");
}

/**
 * Stop points from indentation and brackets, as an offset into `written`. `lexer` has read
 * the text before the cursor.
 */
function heuristicEnd(unit: Unit, at: Insertion, lexer: Lexer, written: string): number | undefined {
  const outer = lexer.stack.length;
  /** Brackets above the innermost block belong to the current statement. */
  const statementBase = lexer.stack.lastIndexOf("{") + 1;
  const cursorLine = at.head.slice(at.head.lastIndexOf("\n") + 1);
  // A line indented less than this ends the block. At the top level, any line at column 0
  // starts a new statement, once the suggestion has written one.
  const blockIndent = cursorLine.trim()
    ? indentOf(cursorLine) + (/[:{]\s*$/.test(cursorLine) ? 1 : 0)
    : cursorLine.length;
  const topLevel = blockIndent === 0;

  let lineHasCode = cursorLine.trim() !== "";
  /** True once the current line has anything but whitespace. */
  let lineStarted = lineHasCode;
  /** The newline before the current line, or -1 on the cursor's line. */
  let lineStart = -1;
  let wroteCode = false;
  for (let i = 0; i < written.length; ) {
    const c = written[i];
    const code = !lexer.inText;
    const firstOnLine = code && !lineStarted && !/\s/.test(c);
    // A closing bracket for a block opened before the cursor ends the statement and the block.
    if (code && ")]}".includes(c) && lexer.stack.length <= statementBase) {
      return firstOnLine && lineStart >= 0 ? lineStart : i;
    }
    if (unit === "block" && firstOnLine && lineStart >= 0 && lexer.stack.length <= outer) {
      const indent = i - lineStart - 1;
      if (topLevel ? indent === 0 && wroteCode : indent < blockIndent) return lineStart;
    }
    const lineEnd = lexer.lineEnd;
    const { width, kind } = lexer.step(written, i);
    if (kind === "code" && c === "\n") {
      if (unit === "statement" && lineHasCode) {
        const depth = lexer.stack.length;
        if (depth === statementBase && !continuesOnNextLine(lineEnd)) return i;
        // A header that opens a block, like `if (x) {`.
        if (depth === statementBase + 1 && lexer.stack.at(-1) === "{") return i;
      }
      lineStart = i;
      lineHasCode = lineStarted = false;
    } else if (!/\s/.test(c)) {
      lineStarted = true;
      if (kind === "code") {
        lineHasCode = wroteCode = true;
        if (unit === "statement" && c === ";" && lexer.stack.length === statementBase) return i + 1;
      }
    }
    i += width;
  }
  return undefined;
}

/** The most lines a level-5 step may write. */
export const MAX_STEP_LINES = 40;

/**
 * Level 5: a step runs to the end of the reply. It is cut early only once it is past the line
 * cap, which makes it too big anyway. Import lines at its start don't count.
 */
export function planStepRule(languageId: string): StopRule {
  return (text, done) => {
    if (done) return text.trimEnd();
    const { code } = splitImports(text, languageId, false);
    return code.split("\n").length > MAX_STEP_LINES + 1 ? text : undefined;
  };
}

/** True if inserting `written` at the cursor leaves the file parsing no worse than before. */
export function parsesWith(at: Insertion, written: string, grammar?: Grammar): boolean {
  if (!grammar) {
    // Without a parser: the step must close every bracket, string and comment it opens.
    const before = new Lexer(syntaxFor(at.languageId)).read(at.head);
    const after = before.clone().read(written);
    return !after.inText && after.stack.join() === before.stack.join();
  }
  const errors = (text: string) => {
    const tree = grammar.parser.parse(text);
    if (!tree) return Infinity;
    try {
      return countErrors(tree.rootNode);
    } finally {
      tree.delete();
    }
  };
  return errors(at.head + written + at.tail) <= errors(at.head + at.tail);
}
