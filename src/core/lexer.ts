// A small lexer that tells code from strings and comments, and tracks open brackets.
// It knows only each language's comment and string delimiters, which is enough for
// markers and for the stop-point heuristics.

export interface LanguageSyntax {
  lineComments: string[];
  blockComment?: [start: string, end: string];
  /** String delimiters that may span lines. Other strings end at the end of the line. */
  multilineStrings: string[];
}

const HASH: LanguageSyntax = { lineComments: ["#"], multilineStrings: [] };
const PYTHON: LanguageSyntax = { lineComments: ["#"], multilineStrings: ['"""', "'''"] };
const C_LIKE: LanguageSyntax = { lineComments: ["//"], blockComment: ["/*", "*/"], multilineStrings: [] };
const BACKTICK: LanguageSyntax = { ...C_LIKE, multilineStrings: ["`"] };
const DASHES: LanguageSyntax = { lineComments: ["--"], blockComment: ["/*", "*/"], multilineStrings: [] };
const MARKUP: LanguageSyntax = { lineComments: [], blockComment: ["<!--", "-->"], multilineStrings: [] };
/** For untuned languages: the common comment styles. */
const FALLBACK: LanguageSyntax = { lineComments: ["//", "#"], blockComment: ["/*", "*/"], multilineStrings: [] };

const SYNTAX: Record<string, LanguageSyntax> = {
  python: PYTHON,
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
  go: BACKTICK,
  javascript: BACKTICK,
  javascriptreact: BACKTICK,
  typescript: BACKTICK,
  typescriptreact: BACKTICK,
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
  php: { ...C_LIKE, lineComments: ["//", "#"] },
  sql: DASHES,
  lua: { lineComments: ["--"], blockComment: ["--[[", "]]"], multilineStrings: [] },
  haskell: { lineComments: ["--"], blockComment: ["{-", "-}"], multilineStrings: [] },
  html: MARKUP,
  xml: MARKUP,
  markdown: MARKUP,
};

export const syntaxFor = (languageId: string): LanguageSyntax => SYNTAX[languageId] ?? FALLBACK;

const QUOTES = ['"', "'", "`"];
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** Characters after which a `{` opens a value, not a block. */
const VALUE_BEFORE = new Set(["=", "(", ",", ":", "[", "?"]);

/**
 * What a run of characters is: code, the inside of a comment or string, or a
 * delimiter that opens or closes one.
 */
export type Kind = "code" | "comment" | "string" | "delimiter";

/** An open bracket: `{` for a block, `{=` for a value such as an object literal. */
export type Bracket = "(" | "[" | "{" | "{=";

export class Lexer {
  /** Brackets open at the current position, outermost first. */
  stack: Bracket[] = [];
  /** The last two code characters on the current line, ignoring whitespace. */
  lineEnd = "";
  private quote?: string;
  private blockEnd?: string;
  private lineComment = false;
  private lastCode = "";

  constructor(private syntax: LanguageSyntax) {}

  clone(): Lexer {
    return Object.assign(new Lexer(this.syntax), this, { stack: [...this.stack] });
  }

  /** True inside a comment or a string. */
  get inText(): boolean {
    return this.inComment || this.quote !== undefined;
  }

  get inComment(): boolean {
    return this.lineComment || this.blockEnd !== undefined;
  }

  /** Reads `text` to its end. */
  read(text: string): this {
    for (let i = 0; i < text.length; ) i += this.step(text, i).width;
    return this;
  }

  /** Reads the token at `text[i]`: one character, or a whole delimiter. */
  step(text: string, i: number): { width: number; kind: Kind } {
    const c = text[i];
    if (c === "\n") {
      this.lineComment = false;
      if (this.quote && !this.syntax.multilineStrings.includes(this.quote)) this.quote = undefined;
      this.lineEnd = "";
      return { width: 1, kind: this.inText ? (this.blockEnd ? "comment" : "string") : "code" };
    }
    if (this.lineComment) return { width: 1, kind: "comment" };
    if (this.blockEnd) {
      if (!text.startsWith(this.blockEnd, i)) return { width: 1, kind: "comment" };
      const width = this.blockEnd.length;
      this.blockEnd = undefined;
      return { width, kind: "delimiter" };
    }
    if (this.quote) {
      if (c === "\\" && text[i + 1] !== "\n") return { width: 2, kind: "string" };
      if (!text.startsWith(this.quote, i)) return { width: 1, kind: "string" };
      const width = this.quote.length;
      this.quote = undefined;
      return { width, kind: "delimiter" };
    }
    const block = this.syntax.blockComment;
    if (block && text.startsWith(block[0], i)) {
      this.blockEnd = block[1];
      return { width: block[0].length, kind: "delimiter" };
    }
    const lineToken = this.syntax.lineComments.find((t) => text.startsWith(t, i));
    if (lineToken) {
      this.lineComment = true;
      return { width: lineToken.length, kind: "delimiter" };
    }
    const quote =
      this.syntax.multilineStrings.find((q) => text.startsWith(q, i)) ?? QUOTES.find((q) => q === c);
    if (quote) {
      this.quote = quote;
      return { width: quote.length, kind: "delimiter" };
    }
    this.code(c);
    return { width: 1, kind: "code" };
  }

  private code(c: string): void {
    if (c === " " || c === "\t" || c === "\r") return;
    if (c === "(" || c === "[") this.stack.push(c);
    else if (c === "{") this.stack.push(VALUE_BEFORE.has(this.lastCode) ? "{=" : "{");
    else if (c in CLOSERS) {
      const top = this.stack.at(-1);
      if (top && top[0] === CLOSERS[c]) this.stack.pop();
    }
    this.lastCode = c;
    this.lineEnd = (this.lineEnd + c).slice(-2);
  }
}

/** One line of source, split by what the lexer saw on it. */
export interface ScannedLine {
  /** The comment text, delimiters left out. */
  comment: string;
  /** Columns of the line's comments, delimiters included: from the first one's start to the last one's end. */
  commentStart?: number;
  commentEnd?: number;
  /** The line with comments left out. */
  code: string;
  /** The line with comments and strings left out, delimiters too. */
  bare: string;
  /** True if the line starts inside a block comment or a multi-line string. */
  startsInText: boolean;
  /** True if it ends inside one. */
  endsInText: boolean;
}

export function scanLines(text: string, syntax: LanguageSyntax): ScannedLine[] {
  const lexer = new Lexer(syntax);
  const lines: ScannedLine[] = [];
  const blank = (startsInText: boolean): ScannedLine => ({ comment: "", code: "", bare: "", startsInText, endsInText: false });
  let line = blank(false);
  let column = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\n") {
      lexer.step(text, i);
      line.endsInText = lexer.inText;
      lines.push(line);
      line = blank(lexer.inText);
      column = 0;
      i++;
      continue;
    }
    const wasComment = lexer.inComment;
    const { width, kind } = lexer.step(text, i);
    const piece = text.slice(i, i + width);
    if (kind === "comment" || (kind === "delimiter" && (wasComment || lexer.inComment))) {
      if (kind === "comment") line.comment += piece;
      line.commentStart ??= column;
      line.commentEnd = column + width;
    } else {
      line.code += piece;
      if (kind === "code") line.bare += piece;
    }
    i += width;
    column += width;
  }
  line.endsInText = lexer.inText;
  lines.push(line);
  return lines;
}

/** The comment text on each line of `text`, with code, strings and delimiters left out. */
export function commentsIn(text: string, syntax: LanguageSyntax): string[] {
  return scanLines(text, syntax).map((line) => line.comment);
}
