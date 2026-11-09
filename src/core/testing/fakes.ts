import type { ChatRequest, Clock, DocumentSnapshot, ModelClient, StreamChunk } from "../types";
import { ModelError } from "../types";

/** A clock that only moves when told to, firing due timers as it goes. */
export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void }[] = [];

  constructor(private t = Date.parse("2026-11-09T10:00:00+05:30")) {}
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => (this.timers = this.timers.filter((t) => t !== timer));
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

/** One scripted step of a fake model reply. */
export type Step =
  | { text: string; afterMs?: number }
  | { provider: string }
  | { error: ModelError }
  /** Sends nothing more until the request is aborted. */
  | { stall: true };

export interface RecordedRequest {
  body: ChatRequest;
  /** True once the caller aborted the request. */
  aborted: boolean;
}

/**
 * A model client that replays scripted replies, one per request, and records
 * what was sent. Advances the fake clock by each step's `afterMs`.
 */
export class FakeModelClient implements ModelClient {
  readonly requests: RecordedRequest[] = [];
  private replies: Step[][] = [];

  constructor(private clock: FakeClock) {}

  reply(...steps: Step[]): this {
    this.replies.push(steps);
    return this;
  }

  async *stream(body: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const record: RecordedRequest = { body, aborted: false };
    this.requests.push(record);
    signal.addEventListener("abort", () => (record.aborted = true));
    const steps = this.replies.shift() ?? [];
    for (const step of steps) {
      await Promise.resolve();
      if (signal.aborted) return;
      if ("error" in step) throw step.error;
      if ("stall" in step) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        return;
      }
      if ("provider" in step) {
        yield { provider: step.provider };
        continue;
      }
      if (step.afterMs) this.clock.advance(step.afterMs);
      yield { text: step.text };
    }
  }
}

/** A document whose cursor sits where `|` is in `source`. */
export function doc(source: string, overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  const at = source.indexOf("|");
  if (at < 0) throw new Error("doc() needs a | cursor");
  const before = source.slice(0, at).split("\n");
  return {
    docId: "file:///work/main.py",
    path: "main.py",
    languageId: "python",
    text: source.slice(0, at) + source.slice(at + 1),
    cursor: { line: before.length - 1, character: before[before.length - 1].length },
    cursorCount: 1,
    hasSelection: false,
    ...overrides,
  };
}
