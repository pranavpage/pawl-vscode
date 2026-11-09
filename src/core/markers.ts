// Comment markers the user writes in the file to talk to Pawl. Markers only count inside comments.
import type { DocumentSnapshot, Level } from "./types";

/** A pin only counts in the first lines of the file. */
const PIN_LINES = 5;

interface CommentSyntax {
  line: string[];
  block?: [start: string, end: string];
}

const HASH: CommentSyntax = { line: ["#"] };
const C_LIKE: CommentSyntax = { line: ["//"], block: ["/*", "*/"] };
const DASHES: CommentSyntax = { line: ["--"], block: ["/*", "*/"] };
const MARKUP: CommentSyntax = { line: [], block: ["<!--", "-->"] };
/** For untuned languages: the common comment styles. */
const FALLBACK: CommentSyntax = { line: ["//", "#"], block: ["/*", "*/"] };

const COMMENT_SYNTAX: Record<string, CommentSyntax> = {
  python: HASH,
  shellscript: HASH,
  ruby: HASH,
  perl: HASH,
  r: HASH,
  yaml: HASH,
  toml: HASH,
  dockerfile: HASH,
  makefile: HASH,
  powershell: HASH,
  elixir: HASH,
  julia: HASH,
  go: C_LIKE,
  javascript: C_LIKE,
  javascriptreact: C_LIKE,
  typescript: C_LIKE,
  typescriptreact: C_LIKE,
  java: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  rust: C_LIKE,
  swift: C_LIKE,
  kotlin: C_LIKE,
  scala: C_LIKE,
  dart: C_LIKE,
  jsonc: C_LIKE,
  php: { line: ["//", "#"], block: ["/*", "*/"] },
  sql: DASHES,
  lua: { line: ["--"], block: ["--[[", "]]"] },
  haskell: { line: ["--"], block: ["{-", "-}"] },
  html: MARKUP,
  xml: MARKUP,
  markdown: MARKUP,
};

const QUOTES = ["\"", "'", "`"];

/**
 * The comment text on each line, with code and string contents left out. Strings are
 * tracked within a line only, which is enough for the head of a file.
 */
function commentsIn(lines: string[], syntax: CommentSyntax): string[] {
  let blockEnd: string | undefined;
  return lines.map((line) => {
    let comment = "";
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
      if (blockEnd) {
        const end = line.indexOf(blockEnd, i);
        if (end < 0) {
          comment += line.slice(i);
          break;
        }
        comment += line.slice(i, end) + " ";
        i = end + blockEnd.length - 1;
        blockEnd = undefined;
        continue;
      }
      const c = line[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = undefined;
        continue;
      }
      if (QUOTES.includes(c)) {
        quote = c;
        continue;
      }
      if (syntax.block && line.startsWith(syntax.block[0], i)) {
        blockEnd = syntax.block[1];
        i += syntax.block[0].length - 1;
        continue;
      }
      const token = syntax.line.find((t) => line.startsWith(t, i));
      if (token) {
        comment += line.slice(i + token.length);
        break;
      }
    }
    return comment;
  });
}

/** The file's `@pawl level=N` pin: absent, a valid level, or a typo. */
export type Pin = { level: Level } | "bad" | undefined;

export function findPin(doc: Pick<DocumentSnapshot, "languageId" | "text">): Pin {
  const head = doc.text.split("\n", PIN_LINES);
  for (const comment of commentsIn(head, COMMENT_SYNTAX[doc.languageId] ?? FALLBACK)) {
    const at = /@pawl(?![\w-])/.exec(comment);
    if (!at) continue;
    const pin = /^\s+level=([0-5])(?!\S)/.exec(comment.slice(at.index + at[0].length));
    return pin ? { level: Number(pin[1]) as Level } : "bad";
  }
  return undefined;
}
