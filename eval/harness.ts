// Model-quality eval: real go-presses through the session core, one result per press.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { offsetAt } from "../src/core/context";
import { replyBody } from "../src/core/output";
import { createSession } from "../src/core/session";
import { MAX_STEP_LINES, parsesWith, type Insertion } from "../src/core/stops";
import { loadGrammar, type Node } from "../src/core/syntax";
import type { ChatRequest, Clock, DocumentSnapshot, Level, LogEntry, ModelClient, StreamChunk } from "../src/core/types";

/** A file with a cursor, pressed at one level. */
export interface Fixture {
  name: string;
  level: Level;
  doc: DocumentSnapshot;
}

/** How a press ended: a suggestion on screen, `nothing to add`, a `Q:`, a level-5 step too big, or another error. */
export type PressOutcome = "shown" | "empty" | "question" | "step_too_big" | "error";

export interface PressResult {
  fixture: string;
  /** The level the fixture is pressed at. */
  level: Level;
  /** The level the press ran at, after any fallback. */
  ranAt: Level;
  model?: string;
  provider?: string;
  latencyMs?: number;
  attempts: number;
  outcome: PressOutcome;
  /** For errors, e.g. `timeout` or `rate_limit`. */
  reason?: string;
  suggestion?: string;
  /** The last reply as the model sent it, up to where Pawl stopped reading. */
  reply: string;
  /** True if the suggestion shown goes past the level's stop point. Expected never. */
  overran: boolean;
  /** Levels 1–4: true if the model wrote past the stop point and Pawl cut it there. */
  cut: boolean;
}

export interface EvalOptions {
  model: ModelClient;
  clock: Clock;
  modelForLevel(level: Level): string;
  fixtures: Fixture[];
  /** Presses per level, shared in turn between that level's fixtures. */
  presses: number;
  timeoutMs: number;
  /** Called after each press, for progress. */
  onPress?(result: PressResult): void;
}

/** Where the cursor goes in a fixture file. */
export const CURSOR = "<|>";

const LANGUAGES: Record<string, string> = { ".py": "python", ".go": "go" };

/**
 * Fixture files in `dir`, named `l<level>.<ext>` (or `l<level>-<anything>.<ext>`), each with
 * one `<|>` where the cursor goes.
 */
export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const match = /^l([1-5])\b.*(\.\w+)$/.exec(name);
    const languageId = match && LANGUAGES[match[2]];
    if (!languageId) continue;
    const source = await readFile(join(dir, name), "utf8");
    const at = source.indexOf(CURSOR);
    if (at < 0 || source.indexOf(CURSOR, at + 1) >= 0) throw new Error(`${name} needs exactly one ${CURSOR}`);
    const before = source.slice(0, at).split("\n");
    fixtures.push({
      name,
      level: Number(match[1]) as Level,
      doc: {
        docId: `file:///eval/${name}`,
        path: name,
        languageId,
        text: source.slice(0, at) + source.slice(at + CURSOR.length),
        cursor: { line: before.length - 1, character: before[before.length - 1].length },
        cursorCount: 1,
        hasSelection: false,
      },
    });
  }
  return fixtures;
}

/** Passes requests through, keeping the text of the last reply as the model sent it. */
class Recorder implements ModelClient {
  raw = "";
  constructor(private inner: ModelClient) {}
  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.raw = "";
    for await (const chunk of this.inner.stream(request, signal)) {
      this.raw += chunk.text ?? "";
      yield chunk;
    }
  }
}

/** Presses each level's fixtures `presses` times in all, one press at a time, levels in order. */
export async function runEval(options: EvalOptions): Promise<PressResult[]> {
  const recorder = new Recorder(options.model);
  let entry: LogEntry | undefined;
  let shown = false;
  const session = createSession({
    model: recorder,
    clock: options.clock,
    modelForLevel: options.modelForLevel,
    config: () => ({ timeoutMs: options.timeoutMs, log: { enabled: true, prompts: false }, keepTodoOnAccept: false }),
    emit(effect) {
      if (effect.type === "log") entry = effect.entry;
      if (effect.type === "ghost") shown = true;
    },
  });
  await session.dispatch({ type: "keyChanged", hasKey: true });

  const results: PressResult[] = [];
  const levels = [...new Set(options.fixtures.map((f) => f.level))].sort();
  for (const level of levels) {
    const fixtures = options.fixtures.filter((f) => f.level === level);
    for (let i = 0; i < options.presses; i++) {
      const fixture = fixtures[i % fixtures.length];
      await session.dispatch({ type: "setLevel", level });
      entry = undefined;
      shown = false;
      recorder.raw = "";
      await session.dispatch({ type: "go", doc: fixture.doc });
      // A suggestion's log line is written once it ends; Esc ends it.
      if (shown) await session.dispatch({ type: "rejected" });
      if (!entry) throw new Error(`No log line for a press on ${fixture.name}`);
      const result = await resultOf(fixture, entry, recorder.raw);
      results.push(result);
      options.onPress?.(result);
    }
  }
  return results;
}

async function resultOf(fixture: Fixture, entry: LogEntry, raw: string): Promise<PressResult> {
  const outcome: PressOutcome =
    entry.outcome === "rejected"
      ? "shown"
      : entry.outcome === "empty" || entry.outcome === "question"
        ? entry.outcome
        : entry.reason === "step_too_big"
          ? "step_too_big"
          : "error";
  const suggestion = entry.suggestion;
  const shown = outcome === "shown" && suggestion !== undefined;
  return {
    fixture: fixture.name,
    level: fixture.level,
    ranAt: entry.level,
    model: entry.model,
    provider: entry.provider,
    latencyMs: entry.latency_ms,
    attempts: entry.attempts,
    outcome,
    reason: outcome === "error" ? (entry.reason ?? entry.outcome) : undefined,
    suggestion,
    reply: raw,
    overran: shown ? await overruns(fixture.doc, entry.level, suggestion) : false,
    cut: shown && entry.level <= 4 && (replyBody(raw)?.body.trimEnd() ?? "").length > suggestion.length,
  };
}

/**
 * True if `suggestion`, inserted at the cursor, goes past the level's stop point. This checks the
 * stop points as the spec states them, apart from Pawl's own cutter, so it can catch the cutter's
 * mistakes. Level 1: a second line. Level 2: a second statement. Levels 3–4: a new top-level
 * declaration, or in Python a line left of the cursor's block. Level 5: more than the line cap,
 * or a file that parses worse. Languages without a grammar are checked at levels 1 and 5 only.
 */
export async function overruns(doc: DocumentSnapshot, level: Level, suggestion: string): Promise<boolean> {
  const lines = suggestion.split("\n");
  if (level === 1) return lines.length > 1;
  const at = offsetAt(doc.text, doc.cursor);
  const insertion: Insertion = { head: doc.text.slice(0, at), tail: doc.text.slice(at), languageId: doc.languageId };
  const grammar = await loadGrammar(doc.languageId);
  if (level === 5) return lines.length > MAX_STEP_LINES || !parsesWith(insertion, suggestion, grammar);
  const firstCode = suggestion.search(/\S/);
  if (!grammar || firstCode < 0) return false;

  if (level >= 3 && !grammar.braces) {
    const cursorLine = insertion.head.slice(insertion.head.lastIndexOf("\n") + 1);
    const blockIndent = cursorLine.trim() ? indentOf(cursorLine) : cursorLine.length;
    if (lines.slice(1).some((line) => line.trim() !== "" && indentOf(line) < blockIndent)) return true;
  }
  const tree = grammar.parser.parse(insertion.head + suggestion + insertion.tail);
  if (!tree) return false;
  try {
    // A statement (level 2) or top-level declaration (levels 3–4) that starts after the
    // suggestion's first code is one too many.
    const containers = level === 2 ? grammar.containers : new Set([tree.rootNode.type]);
    const from = at + firstCode;
    return startsIn(tree.rootNode, containers, from, at + suggestion.length);
  } finally {
    tree.delete();
  }
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** True if a non-comment child of a `containers` node starts in (from, to). */
function startsIn(node: Node, containers: ReadonlySet<string>, from: number, to: number): boolean {
  return node.children.some((child) => {
    if (child.endIndex <= from || child.startIndex >= to) return false;
    if (containers.has(node.type) && child.type !== "comment" && child.startIndex > from) return true;
    return startsIn(child, containers, from, to);
  });
}

export interface LevelSummary {
  level: Level;
  /** Every model the level's presses ran on; more than one after a fallback. */
  models: string[];
  presses: number;
  overruns: number;
  cut: number;
  /** Presses that ran at a lower level than the fixture's. */
  fellBack: number;
  /** Go-press to suggestion, `Q:` or `nothing to add`, in ms; failed requests left out. */
  p50?: number;
  p90?: number;
  /** Presses per serving provider. */
  providers: Record<string, number>;
  outcomes: { shown: number; empty: number; question: number; step_too_big: number; errors: Record<string, number> };
}

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

const increment = (counts: Record<string, number>, key: string) => (counts[key] = (counts[key] ?? 0) + 1);

/** One summary per level, levels in order. */
export function summarize(results: PressResult[]): LevelSummary[] {
  const levels = [...new Set(results.map((r) => r.level))].sort();
  return levels.map((level) => {
    const presses = results.filter((r) => r.level === level);
    const outcomes: LevelSummary["outcomes"] = { shown: 0, empty: 0, question: 0, step_too_big: 0, errors: {} };
    const providers: Record<string, number> = {};
    for (const press of presses) {
      if (press.provider) increment(providers, press.provider);
      if (press.outcome === "error") increment(outcomes.errors, press.reason ?? "unknown");
      else outcomes[press.outcome]++;
    }
    // A step too big is still a reply, so it counts toward latency.
    const latencies = presses
      .filter((p) => p.outcome !== "error" && p.latencyMs !== undefined)
      .map((p) => p.latencyMs!)
      .sort((a, b) => a - b);
    return {
      level,
      models: [...new Set(presses.flatMap((p) => (p.model ? [p.model] : [])))],
      presses: presses.length,
      overruns: presses.filter((p) => p.overran).length,
      cut: presses.filter((p) => p.cut).length,
      fellBack: presses.filter((p) => p.ranAt !== p.level).length,
      p50: latencies.length ? percentile(latencies, 0.5) : undefined,
      p90: latencies.length ? percentile(latencies, 0.9) : undefined,
      providers,
      outcomes,
    };
  });
}
