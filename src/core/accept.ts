// The edits that come with an accepted suggestion, outside the text it inserted.
import { offsetAt } from "./context";
import { positionAt, type Span } from "./targets";
import type { Position, TextEdit } from "./types";

/** What accepting a suggestion does besides inserting it. Positions are in the file before it went in. */
export interface OnAccept {
  /** Removed, along with their line if nothing else is left on it: a filled `TODO:`, a placeholder. */
  remove: Span[];
  /** The space in a plan step's `[ ]`, ticked to `[x]`. */
  tick?: Position;
  /** New imports, at an offset in the file. */
  imports?: { offset: number; text: string };
  /** Starts a new line after the suggestion, indented like the cursor's, and leaves the cursor there. */
  newLine?: boolean;
}

/** A change to the file with the suggestion in it, as offsets into it. */
interface Change {
  from: number;
  to: number;
  text: string;
}

/**
 * The edits for accepting `suggestion` at `cursor` in `text`, and where the cursor ends up.
 * Undefined when there is nothing to do.
 */
export function acceptEdits(
  text: string,
  cursor: Position,
  suggestion: string,
  onAccept: OnAccept,
): { edits: TextEdit[]; cursor: Position } | undefined {
  const at = offsetAt(text, cursor);
  const end = at + suggestion.length;
  const file = text.slice(0, at) + suggestion + text.slice(at);
  /** Where a span of the old file is in the new one; undefined if the suggestion went in inside it. */
  const moved = (from: number, to: number) =>
    to <= at ? [from, to] : from >= at ? [from + suggestion.length, to + suggestion.length] : undefined;

  const changes: Change[] = [];
  for (const span of onAccept.remove) {
    const range = moved(offsetAt(text, span.start), offsetAt(text, span.end));
    if (range) changes.push(removal(file, range[0], range[1]));
  }
  if (onAccept.tick) {
    const box = offsetAt(text, onAccept.tick);
    const range = moved(box, box + 1);
    if (range && file[range[0]] === " ") changes.push({ from: range[0], to: range[1], text: "x" });
  }
  if (onAccept.imports) {
    const { offset, text: added } = onAccept.imports;
    const to = offset <= at ? offset : offset + suggestion.length;
    changes.push({ from: to, to, text: added });
  }
  let newLine: Change | undefined;
  if (onAccept.newLine) {
    const indent = /[ \t]*$/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1, at))![0];
    newLine = { from: end, to: end, text: `\n${indent}` };
    changes.push(newLine);
  }
  if (changes.length === 0) return undefined;

  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  const kept = changes.filter((change, k) => k === 0 || change.from >= changes[k - 1].to);
  let after = file;
  let caret = end;
  for (const change of [...kept].reverse()) {
    after = after.slice(0, change.from) + change.text + after.slice(change.to);
    if (change === newLine || change.to <= end) caret += change.text.length - (change.to - change.from);
  }
  return {
    edits: kept.map((change) => ({
      start: positionAt(file, change.from),
      end: positionAt(file, change.to),
      text: change.text,
      replaces: file.slice(change.from, change.to),
    })),
    cursor: positionAt(after, caret),
  };
}

/** Removes [from, to), and the whole line if that leaves it blank; else the spaces before it at a line end. */
function removal(file: string, from: number, to: number): Change {
  const lineStart = file.lastIndexOf("\n", from - 1) + 1;
  const eol = file.indexOf("\n", to);
  const lineEnd = eol < 0 ? file.length : eol;
  const rest = file.slice(to, lineEnd);
  if ((file.slice(lineStart, from) + rest).trim() === "") {
    return eol < 0 ? { from: Math.max(0, lineStart - 1), to: lineEnd, text: "" } : { from: lineStart, to: eol + 1, text: "" };
  }
  if (rest.trim() === "") while (from > lineStart && /[ \t]/.test(file[from - 1])) from--;
  return { from, to, text: "" };
}
