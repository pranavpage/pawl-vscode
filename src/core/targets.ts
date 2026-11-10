// What level 4 fills: the empty function body, or the `TODO:`, at the cursor.
import { FUNCTION_HEADER, offsetAt } from "./context";
import { Lexer, scanLines, syntaxFor, type ScannedLine } from "./lexer";
import type { Todo } from "./markers";
import type { DocumentSnapshot, Position } from "./types";

export interface Span {
  start: Position;
  end: Position;
}

/** A function whose body holds nothing but a docstring, comments and at most one placeholder. */
export interface EmptyBody {
  /** The line its header starts on. */
  line: number;
  /** The lone placeholder, which filling the body removes. */
  placeholder?: Span;
}

/** What a stub body holds in place of code: `pass`, `...`, `raise NotImplementedError` or `panic(...)`. */
const PLACEHOLDER = /^(?:pass|\.\.\.|raise\s+NotImplementedError(?:\s*\(.*\))?|panic\s*\(.*\))\s*;?$/s;
/** How many lines a function header may span. */
const MAX_HEADER_LINES = 30;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

/** The `TODO:` the cursor is at the end of or on the line right under. */
export function todoAt(todos: Todo[], doc: DocumentSnapshot): Todo | undefined {
  const { line, character } = doc.cursor;
  const restOfLine = doc.text.split("\n")[line].slice(character);
  return todos.find((todo) => todo.endLine === line - 1 || (todo.endLine === line && isBlank(restOfLine)));
}

/** A function body: where it starts, after the `:` or `{`, and where it ends. */
interface Body {
  header: number;
  /** The line the header ends on. */
  headerEnd: number;
  /** Offset just past the `:` or `{`. */
  from: number;
  /** Offset of the closing `}`, or the end of the body's last line. */
  to: number;
  /** The first line that is no longer in the body, as far as a blank cursor line is concerned. */
  stopLine: number;
}

/** The innermost function the cursor is in, if its body is empty. */
export function emptyBodyAt(doc: DocumentSnapshot): EmptyBody | undefined {
  const lines = doc.text.split("\n");
  const scanned = scanLines(doc.text, syntaxFor(doc.languageId));
  const cursor = offsetAt(doc.text, doc.cursor);
  for (let header = doc.cursor.line; header >= 0; header--) {
    if (scanned[header].startsInText || !FUNCTION_HEADER.test(scanned[header].bare)) continue;
    const body = bodyOf(doc, lines, scanned, header);
    if (!body || !contains(body, doc, lines, cursor)) continue;
    return emptiness(doc, body);
  }
  return undefined;
}

function bodyOf(doc: DocumentSnapshot, lines: string[], scanned: ScannedLine[], header: number): Body | undefined {
  const indented = doc.languageId === "python";
  const start = offsetAt(doc.text, { line: header, character: 0 });
  const lexer = new Lexer(syntaxFor(doc.languageId));
  let line = header;
  // The header ends at its `:` or `{`, outside any brackets.
  let open: number | undefined;
  for (let i = start; i < doc.text.length && line - header < MAX_HEADER_LINES; ) {
    const c = doc.text[i];
    const depth = lexer.stack.length;
    const { width, kind } = lexer.step(doc.text, i);
    if (c === "\n") line++;
    if (kind === "code" && depth === 0) {
      if (c === (indented ? ":" : "{")) {
        open = i;
        break;
      }
      if (c === ";") return undefined;
      // Only a brace on the next line may still open the body.
      if (c === "\n" && (indented || !lines[line]?.trimStart().startsWith("{"))) return undefined;
    }
    i += width;
  }
  if (open === undefined) return undefined;
  const from = open + 1;
  const headerIndent = indentOf(lines[header]);

  if (!indented) {
    for (let i = from; i < doc.text.length; ) {
      const c = doc.text[i];
      const { width, kind } = lexer.step(doc.text, i);
      if (kind === "code" && c === "}" && lexer.stack.length === 0) {
        return { header, headerEnd: line, from, to: i, stopLine: lineOf(doc.text, i) };
      }
      i += width;
    }
    // Not closed yet: the body runs to the first line of code that is not indented under the header.
  }
  const colonLine = line;
  if (!indented || isBlank(scanned[colonLine].code.slice(open - offsetAt(doc.text, { line: colonLine, character: 0 }) + 1))) {
    let last = colonLine;
    let stopLine = lines.length;
    for (let j = colonLine + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= headerIndent) {
        if (!isBlank(scanned[j].code)) {
          stopLine = j;
          break;
        }
        continue;
      }
      last = j;
    }
    const to = offsetAt(doc.text, { line: last, character: lines[last].length });
    return { header, headerEnd: line, from, to, stopLine };
  }
  // A body on the header's own line, as in `def f(): ...`.
  const to = offsetAt(doc.text, { line: colonLine, character: lines[colonLine].length });
  return { header, headerEnd: line, from, to, stopLine: colonLine + 1 };
}

/** True if the cursor is in the body, or on a blank line in or right under it. */
function contains(body: Body, doc: DocumentSnapshot, lines: string[], cursor: number): boolean {
  if (cursor < body.from) return false;
  if (cursor <= body.to) return true;
  const { line, character } = doc.cursor;
  if (line >= body.stopLine || !isBlank(lines[line])) return false;
  return line === body.headerEnd + 1 || character > indentOf(lines[body.header]);
}

function emptiness(doc: DocumentSnapshot, body: Body): EmptyBody | undefined {
  const text = doc.text.slice(body.from, body.to);
  const scanned = scanLines(text, syntaxFor(doc.languageId));
  // Docstrings and comments leave nothing in `bare`.
  const code = scanned.map((line, k) => ({ line, k })).filter(({ line }) => !isBlank(line.bare));
  if (code.length === 0) return { line: body.header };
  if (!PLACEHOLDER.test(code.map(({ line }) => line.code.trim()).join(" "))) return undefined;
  const lineStart = (k: number) => {
    let offset = 0;
    for (let j = 0; j < k; j++) offset = text.indexOf("\n", offset) + 1;
    return offset;
  };
  const first = code[0];
  const last = code[code.length - 1];
  const start = body.from + lineStart(first.k) + indentOf(first.line.code);
  const end = body.from + lineStart(last.k) + last.line.code.trimEnd().length;
  return { line: body.header, placeholder: { start: positionAt(doc.text, start), end: positionAt(doc.text, end) } };
}

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

export function positionAt(text: string, offset: number): Position {
  const line = lineOf(text, offset);
  return { line, character: offset - (text.lastIndexOf("\n", offset - 1) + 1) };
}
