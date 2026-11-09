import { findPin, type Pin } from "./markers";
import { cutAtStopPoint, cutAtStreamEnd } from "./output";
import { assembleContext, buildMessages } from "./prompt";
import { isoWithOffset } from "./time";
import { ModelError, type ChatRequest, type Clock, type DocumentSnapshot, type Effect, type Level, type LogEntry, type ModelClient, type Position, type SessionEvent } from "./types";

export interface SessionConfig {
  /** The deadline for each go-press, covering every attempt. */
  timeoutMs: number;
  log: { enabled: boolean; prompts: boolean };
}

export interface SessionDeps {
  model: ModelClient;
  clock: Clock;
  modelForLevel(level: Level): string;
  /** The saved global level; 1 on first run. */
  level?: Level;
  /** Read on each go-press, so setting changes apply to the next one. */
  config(): SessionConfig;
  emit(effect: Effect): void;
}

export interface Session {
  /** Handles one event. Resolves once any work it started has finished. */
  dispatch(event: SessionEvent): Promise<void>;
}

/** How long an error or `nothing to add` stays at the cursor, and an error in the status bar. */
const NOTICE_TTL_MS = 3000;

interface Reply {
  suggestion: string;
  provider?: string;
}

/** A log line still waiting for its outcome. */
type Draft = Omit<LogEntry, "outcome">;

/** The suggestion on screen. Its log line is written once its outcome is known. */
interface Shown {
  docId: string;
  at: Position;
  text: string;
  /** The start of `text` now in the file, typed or accepted. */
  typed: string;
  /** True once a word was accepted, which makes any non-accept a `partial`. */
  wordAccepted: boolean;
  draft: Draft;
}

const samePosition = (a: Position, b: Position) => a.line === b.line && a.character === b.character;

/** Offset of `pos` within `text` written from `origin`, or undefined if it is outside it. */
function offsetIn(text: string, origin: Position, pos: Position): number | undefined {
  const lines = text.split("\n");
  const row = pos.line - origin.line;
  if (row < 0 || row >= lines.length) return undefined;
  const column = row === 0 ? pos.character - origin.character : pos.character;
  if (column < 0 || column > lines[row].length) return undefined;
  return lines.slice(0, row).reduce((n, line) => n + line.length + 1, 0) + column;
}

/** A go-press waiting on the model. */
interface InFlight {
  docId: string;
  at: Position;
  draft: Draft;
  abort: AbortController;
  timedOut: boolean;
  stopTimer(): void;
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
  let inFlight: InFlight | undefined;
  let shown: Shown | undefined;

  /** The level a valid pin holds the file at; none while the dial is at 0, which overrides every pin. */
  function pinnedLevel(pin: Pin): Level | undefined {
    return level !== 0 && typeof pin === "object" ? pin.level : undefined;
  }

  /** The level a press in a file with this pin runs at. */
  function effectiveLevel(pin: Pin): Level {
    return pinnedLevel(pin) ?? level;
  }

  /** Moves the dial, unless a pin in the active file holds it. Only the off key overrides a pin. */
  function turnDial(next: Level): void {
    if (pinnedLevel(activePin) !== undefined) {
      emit({ type: "notice", text: "pinned by @pawl, remove it to use the dial", ttlMs: NOTICE_TTL_MS });
      return;
    }
    setGlobalLevel(next);
  }

  function setGlobalLevel(next: Level): void {
    if (next !== level) {
      level = next;
      emit({ type: "saveLevel", level });
    }
    showStatus();
  }

  function statusText(): string {
    const pinned = pinnedLevel(activePin) !== undefined;
    const shown = effectiveLevel(activePin);
    if (shown === 0) return pinned ? "Pawl off · pinned" : "Pawl off";
    if (!hasKey) return "Pawl ! no key";
    if (activePin === "bad") return "Pawl ! bad @pawl";
    const parts = [`Pawl ${shown}`];
    if (pinned) parts.push("pinned");
    if (lastLatency !== undefined) parts.push(`${lastLatency} ms`);
    return parts.join(" · ");
  }

  function showStatus(): void {
    emit({ type: "status", text: statusText() });
  }

  /** Writes a log line, as the log settings allow. Drafts always carry the prompt. */
  function log(entry: LogEntry): void {
    const settings = deps.config().log;
    if (!settings.enabled) return;
    const { prompt, ...rest } = entry;
    emit({ type: "log", entry: settings.prompts ? entry : rest });
  }

  let stopStatusTimer = () => {};
  /** Shows `text` in the status bar for a while, then the usual status. */
  function flashStatus(text: string): void {
    stopStatusTimer();
    emit({ type: "status", text });
    stopStatusTimer = deps.clock.after(NOTICE_TTL_MS, showStatus);
  }

  /** Models known to reject `effort: "none"`; they get `exclude` straight away. */
  const excludeReasoning = new Set<string>();

  async function streamReply(request: ChatRequest, signal: AbortSignal): Promise<Reply> {
    const abort = new AbortController();
    let raw = "";
    let provider: string | undefined;
    for await (const chunk of deps.model.stream(request, AbortSignal.any([signal, abort.signal]))) {
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

  async function requestReply(
    model: string,
    base: Omit<ChatRequest, "model" | "reasoning">,
    signal: AbortSignal,
  ): Promise<Reply> {
    if (!excludeReasoning.has(model)) {
      try {
        return await streamReply({ ...base, model, reasoning: { effort: "none" } }, signal);
      } catch (err) {
        // OpenRouter's wording for an unsupported effort varies, so any 400 gets one try with `exclude`.
        if (!(err instanceof ModelError && err.kind === "bad_request")) throw err;
      }
    }
    const reply = await streamReply({ ...base, model, reasoning: { exclude: true } }, signal);
    excludeReasoning.add(model);
    return reply;
  }

  function cancelInFlight(): void {
    const press = inFlight;
    if (!press) return;
    inFlight = undefined;
    press.stopTimer();
    press.abort.abort();
    emit({ type: "clearMarker" });
    log({ ...press.draft, outcome: "cancelled" });
  }

  /**
   * Ends the suggestion on screen and logs how. A non-accept after accepting a word is `partial`.
   * Returns the part not yet in the file, for the next press to call "not this".
   */
  function endShown(outcome: "accepted" | "rejected" | "dismissed"): string | undefined {
    const ended = shown;
    if (!ended) return undefined;
    shown = undefined;
    emit({ type: "clearGhost" });
    const entry: LogEntry =
      outcome !== "accepted" && ended.wordAccepted
        ? { ...ended.draft, outcome: "partial", accepted_chars: ended.typed.length }
        : { ...ended.draft, outcome };
    log(entry);
    return ended.text.slice(ended.typed.length);
  }

  async function go(doc: DocumentSnapshot): Promise<void> {
    const pressedAt = deps.clock.now();
    cancelInFlight();
    const notThis = endShown("rejected");
    const mark = (text: string, ttlMs?: number) =>
      emit({ type: "marker", docId: doc.docId, at: doc.cursor, text, ttlMs });
    const level = effectiveLevel(findPin(doc));
    const pressed = { ts: isoWithOffset(pressedAt), file: doc.path, lang: doc.languageId, level };

    if (level === 0) {
      mark("Pawl off", NOTICE_TTL_MS);
      log({ ...pressed, context_chars: 0, attempts: 0, outcome: "off" });
      return;
    }

    if (doc.cursorCount > 1 || doc.hasSelection) {
      emit({ type: "collapseSelection", docId: doc.docId, at: doc.cursor });
    }
    const model = deps.modelForLevel(level);
    const draft: Draft = { ...pressed, model, context_chars: 0, attempts: 0 };
    const fail = (reason: string, entry: Draft) => {
      const shownReason = `! ${reason.replaceAll("_", " ")}`;
      mark(shownReason, NOTICE_TTL_MS);
      flashStatus(`Pawl ${shownReason}`);
      log({ ...entry, outcome: "error", reason });
    };

    if (!hasKey) return fail("no_key", draft);

    mark(doc.cursorCount > 1 ? "… · primary cursor only" : "…");
    const context = assembleContext(doc);
    const messages = buildMessages(doc, context, notThis);
    draft.context_chars = context.before.length + context.after.length;
    draft.prompt = messages;
    draft.attempts = 1;
    const press: InFlight = {
      docId: doc.docId,
      at: doc.cursor,
      draft,
      abort: new AbortController(),
      timedOut: false,
      stopTimer: deps.clock.after(deps.config().timeoutMs, () => {
        press.timedOut = true;
        press.abort.abort();
      }),
    };
    inFlight = press;
    let reply: Reply | undefined;
    let error: unknown;
    try {
      reply = await requestReply(
        model,
        { messages, provider: { sort: "latency" }, max_tokens: 128 },
        press.abort.signal,
      );
    } catch (err) {
      error = err;
    }
    // Replaced or cancelled while waiting; its log line is already written.
    if (inFlight !== press) return;
    inFlight = undefined;
    press.stopTimer();
    draft.latency_ms = deps.clock.now() - pressedAt;
    if (press.timedOut) return fail("timeout", draft);
    if (!reply) return fail(errorReason(error), draft);

    lastLatency = draft.latency_ms;
    draft.provider = reply.provider;
    draft.suggestion = reply.suggestion;
    showStatus();
    if (reply.suggestion.trim() === "") {
      mark("· nothing to add", NOTICE_TTL_MS);
      log({ ...draft, outcome: "empty" });
      return;
    }
    emit({ type: "clearMarker" });
    emit({ type: "ghost", docId: doc.docId, at: doc.cursor, text: reply.suggestion });
    shown = { docId: doc.docId, at: doc.cursor, text: reply.suggestion, typed: "", wordAccepted: false, draft };
  }

  /** Type-through: the suggestion stays while the file matches it, and is accepted once typed out. */
  function edited(docId: string, at: Position, removed: number, text: string): void {
    if (inFlight?.docId === docId) cancelInFlight();
    if (shown?.docId !== docId) return;
    const { typed } = shown;
    // The edit may retype or replace text already typed, as the editor does on Tab.
    const start = offsetIn(typed, shown.at, at);
    const next =
      start === undefined || start + removed > typed.length
        ? undefined
        : typed.slice(0, start) + text + typed.slice(start + removed);
    if (next === undefined || !shown.text.startsWith(next)) return void endShown("dismissed");
    shown.typed = next;
    if (next === shown.text) endShown("accepted");
  }

  /** A suggestion belongs to the spot it was asked for, so leaving that spot ends it. */
  function cursorMoved(docId: string, at: Position): void {
    if (inFlight && (inFlight.docId !== docId || !samePosition(inFlight.at, at))) cancelInFlight();
    if (shown && (shown.docId !== docId || offsetIn(shown.typed, shown.at, at) !== shown.typed.length)) {
      endShown("dismissed");
    }
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
          endShown("accepted");
          return;
        case "acceptedWord":
          if (shown) shown.wordAccepted = true;
          return;
        case "rejected":
          endShown("rejected");
          return;
        case "edited":
          return edited(event.docId, event.at, event.removed, event.text);
        case "cursorMoved":
          return cursorMoved(event.docId, event.at);
        case "editorChanged":
          cancelInFlight();
          endShown("dismissed");
          return;
        case "levelUp":
          return turnDial(Math.min(5, level + 1) as Level);
        case "levelDown":
          return turnDial(Math.max(0, level - 1) as Level);
        case "setLevel":
          return event.level === 0 ? setGlobalLevel(0) : turnDial(event.level);
      }
    },
  };
}
