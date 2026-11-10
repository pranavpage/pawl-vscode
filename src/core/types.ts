// Public vocabulary of the session core. Nothing here depends on VS Code.

export type Level = 0 | 1 | 2 | 3 | 4 | 5;

/** The dial, as shown in the level list. */
export const LEVELS: readonly { level: Level; name: string; writes: string }[] = [
  { level: 0, name: "Off", writes: "Nothing" },
  { level: 1, name: "Syntax", writes: "Finishes the line" },
  { level: 2, name: "Sentence", writes: "Finishes the statement" },
  { level: 3, name: "Block", writes: "Writes the block you're in" },
  { level: 4, name: "Skeleton", writes: "Fills the empty function or TODO: you're in" },
  { level: 5, name: "Plan step", writes: "Writes the next unchecked step of a plan comment" },
];

export interface Position {
  line: number;
  character: number;
}

/** What the editor looks like at the moment of a go-press. */
export interface DocumentSnapshot {
  /** Opaque id the adapter uses to find the document again (a URI string). */
  docId: string;
  /** Workspace-relative path, as logged. */
  path: string;
  /** VS Code language ID. */
  languageId: string;
  text: string;
  /** The main cursor: suggestions only ever go here. */
  cursor: Position;
  /** How many cursors the editor has, the main one included. */
  cursorCount: number;
  /** True when the main selection isn't empty. */
  hasSelection: boolean;
  /** The files around this one, for the imported and sibling files levels 4–5 send. */
  files?: WorkspaceFiles;
}

/**
 * Read access to the workspace folder a document is in. Paths are relative to that
 * folder, as in `DocumentSnapshot.path`, with `/` between parts.
 */
export interface WorkspaceFiles {
  /** The file's text, or undefined if there is no such file. */
  read(path: string): Promise<string | undefined>;
  /** The names of the files in a folder, folders left out; empty if there is no such folder. */
  list(dir: string): Promise<string[]>;
}

export type SessionEvent =
  | { type: "keyChanged"; hasKey: boolean }
  | { type: "go"; doc: DocumentSnapshot }
  | { type: "accepted" }
  /** Pawl's accept-next-word command ran; the word itself arrives as an edit. */
  | { type: "acceptedWord" }
  /** Esc on a suggestion. */
  | { type: "rejected" }
  /** Text changed: `removed` characters at `at` were replaced by `text`. */
  | { type: "edited"; docId: string; at: Position; removed: number; text: string }
  /** The main cursor moved, by typing or otherwise. */
  | { type: "cursorMoved"; docId: string; at: Position }
  | { type: "editorChanged" }
  /** The active editor changed, or its text did. Undefined when no text editor is active. */
  | { type: "activeDocChanged"; doc?: Pick<DocumentSnapshot, "languageId" | "text"> }
  | { type: "levelUp" }
  | { type: "levelDown" }
  /** The off key (level 0) or a pick from the level list. */
  | { type: "setLevel"; level: Level };

export type Outcome =
  | "accepted"
  | "partial"
  | "rejected"
  | "dismissed"
  | "empty"
  | "error"
  | "cancelled"
  | "question"
  | "off";

export interface LogEntry {
  ts: string;
  file: string;
  lang: string;
  level: Level;
  model?: string;
  provider?: string;
  context_chars: number;
  /** Only when the context cap left part of the file out. */
  context_truncated?: boolean;
  /** Only when `pawl.log.prompts` is on. */
  prompt?: ChatMessage[];
  suggestion?: string;
  latency_ms?: number;
  attempts: number;
  outcome: Outcome;
  reason?: string;
  /** For `partial`: how much of the suggestion ended up in the file. */
  accepted_chars?: number;
  /** Level 5 only: the number of the plan step the press wrote. */
  plan_step?: number;
}

/** Replaces the text from `start` to `end`. */
export interface TextEdit {
  start: Position;
  end: Position;
  text: string;
  /** The text the range holds now; if it holds anything else, the edit is stale. */
  replaces: string;
}

export type Effect =
  | { type: "status"; text: string }
  /** A faint marker at the cursor; cleared after `ttlMs` if given. */
  | { type: "marker"; docId: string; at: Position; text: string; ttlMs?: number }
  | { type: "clearMarker" }
  /** A short message not tied to the cursor, e.g. for a level key. */
  | { type: "notice"; text: string; ttlMs: number }
  | { type: "ghost"; docId: string; at: Position; text: string }
  | { type: "clearGhost" }
  /**
   * The edits an accepted suggestion brings with it, such as ticking its plan step. Positions are
   * in the document with the suggestion in it. Apply all or none, then put the cursor at `cursor`.
   */
  | { type: "edit"; docId: string; edits: TextEdit[]; cursor: Position }
  /** Leaves only the main cursor, with nothing selected. */
  | { type: "collapseSelection"; docId: string; at: Position }
  /** The global level changed; persist it so it survives a restart. */
  | { type: "saveLevel"; level: Level }
  | { type: "log"; entry: LogEntry };

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Request body sent to OpenRouter, minus transport details like `stream`. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  reasoning: { effort: "none" } | { exclude: true };
  provider: { sort: "latency" };
  max_tokens: number;
}

export interface StreamChunk {
  text?: string;
  /** Serving provider, as reported by OpenRouter. */
  provider?: string;
}

export type ModelErrorKind = "bad_key" | "rate_limit" | "bad_request" | "network" | "http";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelClient {
  /** Streams a chat completion. Throws `ModelError` on failure. */
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Calls `fn` once, `ms` from now. Returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}
