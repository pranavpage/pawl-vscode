// Public vocabulary of the session core. Nothing here depends on VS Code.

export type Level = 0 | 1 | 2 | 3 | 4 | 5;

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
  cursor: Position;
}

export type SessionEvent =
  | { type: "keyChanged"; hasKey: boolean }
  | { type: "go"; doc: DocumentSnapshot }
  | { type: "accepted" };

export type Outcome = "accepted" | "empty" | "error";

export interface LogEntry {
  ts: string;
  file: string;
  lang: string;
  level: Level;
  model?: string;
  provider?: string;
  context_chars: number;
  suggestion?: string;
  latency_ms?: number;
  attempts: number;
  outcome: Outcome;
  reason?: string;
}

export type Effect =
  | { type: "status"; text: string }
  /** A faint marker at the cursor; cleared after `ttlMs` if given. */
  | { type: "marker"; docId: string; at: Position; text: string; ttlMs?: number }
  | { type: "clearMarker" }
  | { type: "ghost"; docId: string; at: Position; text: string }
  | { type: "clearGhost" }
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
}
