// What the model sees at each level: the text before and after the cursor.
import type { DocumentSnapshot, Level, Position } from "./types";

export interface Context {
  before: string;
  after: string;
  /** False when only part of the file is sent. */
  wholeFile: boolean;
  /** True when the cap left out lines the level would send. */
  truncated: boolean;
}

/** How many lines above the cursor level 1 sees. */
const LINES_ABOVE_AT_LEVEL_1 = 20;
/** About 12k tokens, at about 4 characters a token. */
export const CONTEXT_CAP_CHARS = 48_000;
/** Shown where lines are left out of the middle of the context. */
const gap = (lines: number) => `[… ${lines} lines left out …]`;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";
/** A line that only closes what the lines above it opened, like `}` or `})`. */
const CLOSING_LINE = /^\s*[)\]}]/;
const FUNCTION_HEADER =
  /^\s*(?:(?:export|default|async|pub(?:\([\w ]+\))?|public|private|protected|internal|static|override|final|abstract|inline|unsafe|suspend)\s+)*(?:def|func|function|fn|fun|sub)\b|=>\s*\{?\s*$/;
const IMPORT: Record<string, RegExp> = {
  python: /^(?:import|from)\s/,
  go: /^import\b/,
};
const DEFAULT_IMPORT = /^(?:import|#include|#import|using|use|require)\b/;

export function offsetAt(text: string, pos: Position): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) offset = text.indexOf("\n", offset) + 1;
  return offset + pos.character;
}

/**
 * The indent of the block at the cursor: lines indented less end it. After a header such
 * as `def f():` or `if (x) {`, that is the header's body.
 */
function blockIndentAt(lines: string[], cursor: Position): number {
  const before = lines[cursor.line].slice(0, cursor.character);
  if (isBlank(before)) return before.length;
  return indentOf(before) + (/[:{]\s*$/.test(before) ? 1 : 0);
}

/** The last line of the block at the cursor, from the line below the cursor down. */
function endOfBlockBelow(lines: string[], cursor: Position): number {
  const indent = blockIndentAt(lines, cursor);
  let end = cursor.line;
  for (let j = cursor.line + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) {
      // At the top level, the block is the paragraph the cursor is in.
      if (indent === 0) break;
      continue;
    }
    if (indentOf(lines[j]) < indent) {
      if (CLOSING_LINE.test(lines[j])) end = j;
      break;
    }
    end = j;
  }
  return end;
}

/** The last line of the block a header line starts, its closing line included. */
function endOfBlockFrom(lines: string[], header: number): number {
  const indent = indentOf(lines[header]);
  let end = header;
  for (let j = header + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) <= indent) {
      if (indentOf(lines[j]) === indent && CLOSING_LINE.test(lines[j])) end = j;
      break;
    }
    end = j;
  }
  return end;
}

/**
 * The first line of the function the cursor is in or, outside any function, of the outermost
 * block. Includes decorators and comments right above it. Undefined at the top level.
 */
function startOfEnclosing(lines: string[], cursor: Position): number | undefined {
  const headers: number[] = [];
  const cursorLine = lines[cursor.line];
  let limit = blockIndentAt(lines, cursor);
  if (!isBlank(cursorLine.slice(0, cursor.character))) {
    headers.push(cursor.line);
    limit = indentOf(cursorLine);
  }
  for (let j = cursor.line - 1; j >= 0 && limit > 0; j--) {
    if (isBlank(lines[j]) || CLOSING_LINE.test(lines[j]) || indentOf(lines[j]) >= limit) continue;
    headers.push(j);
    limit = indentOf(lines[j]);
  }
  let start = headers.find((j) => FUNCTION_HEADER.test(lines[j])) ?? (limit === 0 ? headers.at(-1) : undefined);
  if (start === undefined || (start === cursor.line && !FUNCTION_HEADER.test(lines[start]))) return undefined;
  const indent = indentOf(lines[start]);
  while (start > 0 && indentOf(lines[start - 1]) === indent && /^\s*(?:@|#|\/\/)/.test(lines[start - 1])) start--;
  return start;
}

function importLines(lines: string[], languageId: string): number[] {
  const pattern = IMPORT[languageId] ?? DEFAULT_IMPORT;
  const found: number[] = [];
  let inGroup = false;
  lines.forEach((line, j) => {
    if (inGroup || pattern.test(line)) found.push(j);
    // Go's `import (` … `)` group.
    if (/^import\s*\($/.test(line.trimEnd())) inGroup = true;
    else if (inGroup && /^\)/.test(line)) inGroup = false;
  });
  return found;
}

/**
 * The context for a go-press at `level`. `keep` lists lines that stay in the context
 * when the cap cuts it: markers such as `RULE:`. Levels 3 and up also keep imports.
 */
export function assembleContext(doc: DocumentSnapshot, level: Level, keep: number[]): Context {
  const lines = doc.text.split("\n");
  const { cursor } = doc;
  // Every level sees the rest of the cursor's block below it.
  let first = Math.max(0, cursor.line - LINES_ABOVE_AT_LEVEL_1);
  let last = endOfBlockBelow(lines, cursor);
  if (level === 2) {
    const start = startOfEnclosing(lines, cursor);
    if (start !== undefined) {
      first = start;
      last = Math.max(last, endOfBlockFrom(lines, start));
    }
  } else if (level >= 3) {
    first = 0;
    last = lines.length - 1;
    keep = [...keep, ...importLines(lines, doc.languageId)];
  }
  const included = fit(lines, cursor.line, first, last, keep);
  return {
    ...render(lines, cursor, [first - 1, ...included, last + 1]),
    wholeFile: first === 0 && last === lines.length - 1 && included.length === lines.length,
    truncated: included.length < last - first + 1,
  };
}

/**
 * The lines from `first` to `last` if they fit the cap. Otherwise the `keep` lines among
 * them, plus as many lines as fit in a window centred on the cursor.
 */
function fit(lines: string[], cursorLine: number, first: number, last: number, keep: number[]): number[] {
  const size = (j: number) => lines[j].length + 1;
  const all = Array.from({ length: last - first + 1 }, (_, k) => first + k);
  let budget = CONTEXT_CAP_CHARS - all.reduce((n, j) => n + size(j), 0);
  if (budget >= 0) return all;

  const included = new Set([cursorLine, ...keep.filter((j) => j >= first && j <= last)]);
  budget = CONTEXT_CAP_CHARS - [...included].reduce((n, j) => n + size(j), 0);
  let above = cursorLine - 1;
  let below = cursorLine + 1;
  for (let grew = true; grew; ) {
    grew = false;
    for (const side of ["below", "above"] as const) {
      const j = side === "below" ? below : above;
      if (j < first || j > last) continue;
      if (!included.has(j)) {
        if (size(j) > budget) continue;
        budget -= size(j);
        included.add(j);
      }
      if (side === "below") below++;
      else above--;
      grew = true;
    }
  }
  return [...included].sort((a, b) => a - b);
}

/**
 * Joins the included lines around the cursor, marking each run of left-out lines.
 * `included` starts and ends with the lines just outside the range sent.
 */
function render(lines: string[], cursor: Position, included: number[]): Pick<Context, "before" | "after"> {
  const before: string[] = [];
  const after: string[] = [];
  for (let k = 1; k < included.length; k++) {
    const j = included[k];
    const left = j - included[k - 1] - 1;
    if (left > 0) (j <= cursor.line ? before : after).push(gap(left));
    if (k === included.length - 1) break;
    const line = lines[j];
    if (j < cursor.line) before.push(line);
    else if (j > cursor.line) after.push(line);
    else {
      before.push(line.slice(0, cursor.character));
      after.push(line.slice(cursor.character));
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}
