import { findPin, type Pin } from "./markers";
import { cutAtStopPoint, cutAtStreamEnd } from "./output";
import { assembleContext, buildMessages } from "./prompt";
import { isoWithOffset } from "./time";
import { ModelError, type ChatRequest, type Clock, type DocumentSnapshot, type Effect, type Level, type LogEntry, type ModelClient, type SessionEvent } from "./types";

export interface SessionDeps {
  model: ModelClient;
  clock: Clock;
  modelForLevel(level: Level): string;
  /** The saved global level; 1 on first run. */
  level?: Level;
  emit(effect: Effect): void;
}

export interface Session {
  /** Handles one event. Resolves once any work it started has finished. */
  dispatch(event: SessionEvent): Promise<void>;
}

/** How long an error or `nothing to add` stays at the cursor. */
const MARKER_TTL_MS = 3000;

interface Reply {
  suggestion: string;
  provider?: string;
}

/** The `reason` logged and shown for a failed request. */
function errorReason(err: unknown): string {
  if (!(err instanceof ModelError)) return "internal";
  return err.kind === "http" ? `http_${err.status}` : err.kind;
}

export function createSession(deps: SessionDeps): Session {
  const { emit } = deps;
  /** The dial; 0 also overrides every pin. */
  let level: Level = deps.level ?? 1;
  /** The pin in the active file, which sets the status bar. */
  let activePin: Pin;
  let hasKey = false;
  let lastLatency: number | undefined;
  /** The log line for the suggestion on screen, written once its outcome is known. */
  let armed: Omit<LogEntry, "outcome"> | undefined;

  /** The level a press in a file with this pin runs at. */
  function effectiveLevel(pin: Pin): Level {
    if (level === 0 || pin === undefined || pin === "bad") return level;
    return pin.level;
  }

  /** Moves the dial, unless a pin in the active file holds it. Only the off key overrides a pin. */
  function turnDial(next: Level): void {
    if (level !== 0 && typeof activePin === "object") {
      emit({ type: "notice", text: "pinned by @pawl, remove it to use the dial", ttlMs: MARKER_TTL_MS });
      return;
    }
    setLevel(next);
  }

  function setLevel(next: Level): void {
    if (next !== level) {
      level = next;
      emit({ type: "saveLevel", level });
    }
    showStatus();
  }

  function statusText(): string {
    const shown = effectiveLevel(activePin);
    if (shown === 0) return "Pawl off";
    if (!hasKey) return "Pawl ! no key";
    if (activePin === "bad") return "Pawl ! bad @pawl";
    const parts = [`Pawl ${shown}`];
    if (activePin) parts.push("pinned");
    if (lastLatency !== undefined) parts.push(`${lastLatency} ms`);
    return parts.join(" · ");
  }

  function showStatus(): void {
    emit({ type: "status", text: statusText() });
  }
  /** Models known to reject `effort: "none"`; they get `exclude` straight away. */
  const excludeReasoning = new Set<string>();

  async function streamReply(request: ChatRequest): Promise<Reply> {
    const abort = new AbortController();
    let raw = "";
    let provider: string | undefined;
    for await (const chunk of deps.model.stream(request, abort.signal)) {
      provider ??= chunk.provider;
      raw += chunk.text ?? "";
      const suggestion = cutAtStopPoint(raw);
      if (suggestion !== undefined) {
        abort.abort();
        return { suggestion, provider };
      }
    }
    return { suggestion: cutAtStreamEnd(raw), provider };
  }

  async function requestReply(model: string, base: Omit<ChatRequest, "model" | "reasoning">): Promise<Reply> {
    if (!excludeReasoning.has(model)) {
      try {
        return await streamReply({ ...base, model, reasoning: { effort: "none" } });
      } catch (err) {
        // OpenRouter's wording for an unsupported effort varies, so any 400 gets one try with `exclude`.
        if (!(err instanceof ModelError && err.kind === "bad_request")) throw err;
      }
    }
    const reply = await streamReply({ ...base, model, reasoning: { exclude: true } });
    excludeReasoning.add(model);
    return reply;
  }

  async function go(doc: DocumentSnapshot): Promise<void> {
    const pressedAt = deps.clock.now();
    const mark = (text: string, ttlMs?: number) =>
      emit({ type: "marker", docId: doc.docId, at: doc.cursor, text, ttlMs });
    const level = effectiveLevel(findPin(doc));
    const pressed = { ts: isoWithOffset(pressedAt), file: doc.path, lang: doc.languageId, level };

    if (level === 0) {
      mark("Pawl off", MARKER_TTL_MS);
      emit({ type: "log", entry: { ...pressed, context_chars: 0, attempts: 0, outcome: "off" } });
      return;
    }

    const model = deps.modelForLevel(level);
    const press = { ...pressed, model };
    const fail = (reason: string, logged: Partial<LogEntry>) => {
      mark(`! ${reason.replaceAll("_", " ")}`, MARKER_TTL_MS);
      emit({ type: "log", entry: { ...press, context_chars: 0, attempts: 0, ...logged, outcome: "error", reason } });
    };

    if (!hasKey) return fail("no_key", {});

    mark("…");
    const context = assembleContext(doc);
    const context_chars = context.before.length + context.after.length;
    let reply: Reply;
    try {
      reply = await requestReply(model, {
        messages: buildMessages(doc, context),
        provider: { sort: "latency" },
        max_tokens: 128,
      });
    } catch (err) {
      return fail(errorReason(err), { context_chars, attempts: 1, latency_ms: deps.clock.now() - pressedAt });
    }

    lastLatency = deps.clock.now() - pressedAt;
    const shown = {
      ...press,
      provider: reply.provider,
      context_chars,
      suggestion: reply.suggestion,
      latency_ms: lastLatency,
      attempts: 1,
    };
    showStatus();
    if (reply.suggestion.trim() === "") {
      mark("· nothing to add", MARKER_TTL_MS);
      emit({ type: "log", entry: { ...shown, outcome: "empty" } });
      return;
    }
    emit({ type: "clearMarker" });
    emit({ type: "ghost", docId: doc.docId, at: doc.cursor, text: reply.suggestion });
    armed = shown;
  }

  function accepted(): void {
    if (!armed) return;
    emit({ type: "log", entry: { ...armed, outcome: "accepted" } });
    emit({ type: "clearGhost" });
    armed = undefined;
  }

  return {
    async dispatch(event) {
      switch (event.type) {
        case "keyChanged":
          hasKey = event.hasKey;
          return showStatus();
        case "activeDocChanged":
          activePin = event.doc && findPin(event.doc);
          return showStatus();
        case "go":
          return go(event.doc);
        case "accepted":
          return accepted();
        case "levelUp":
          return turnDial(Math.min(5, level + 1) as Level);
        case "levelDown":
          return turnDial(Math.max(0, level - 1) as Level);
        case "setLevel":
          return event.level === 0 ? setLevel(0) : turnDial(event.level);
      }
    },
  };
}
