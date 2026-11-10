import { acceptEdits, type OnAccept } from "./accept";
import { aimAt } from "./aim";
import { assembleContext, contextChars, offsetAt, withRelated } from "./context";
import { importInsertion, newImports, splitImports } from "./imports";
import { findMarkers, findPin, type Pin } from "./markers";
import { createCutter, replyBody, type Cut, type Cutter } from "./output";
import { buildMessages, CONTINUE_NUDGE } from "./prompt";
import { relatedFiles } from "./related";
import { MAX_STEP_LINES, parsesWith, planStepRule, stopRule, type Insertion, type StopRule } from "./stops";
import { loadGrammar } from "./syntax";
import { isoWithOffset } from "./time";
import { ModelError, type ChatMessage, type ChatRequest, type Clock, type DocumentSnapshot, type Effect, type Level, type LogEntry, type ModelClient, type Position, type SessionEvent } from "./types";

export interface SessionConfig {
  /** The deadline for each go-press, covering every attempt. */
  timeoutMs: number;
  log: { enabled: boolean; prompts: boolean };
  /** Keeps a filled `TODO:` comment on accept. */
  keepTodoOnAccept: boolean;
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

/** Room for what each level writes: a line, a statement, a block, a plan step. */
const maxTokens = (level: Level) => [0, 128, 256, 1024, 1024, 2048][level];

type Reply = Cut & { provider?: string };

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
  /** The file as it was at the go-press, which the edits on accept start from. */
  before: string;
  onAccept?: OnAccept;
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
  /** A `Q:` at the cursor; it stays until the user types or moves. */
  let asked: { docId: string; at: Position } | undefined;

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

  /** Streams a reply and aborts it as soon as the stop point arrives. `onText` sees the reply so far. */
  async function streamReply(
    request: ChatRequest,
    cutter: Cutter,
    signal: AbortSignal,
    onText?: (raw: string) => void,
  ): Promise<Reply> {
    const abort = new AbortController();
    let raw = "";
    let provider: string | undefined;
    for await (const chunk of deps.model.stream(request, AbortSignal.any([signal, abort.signal]))) {
      provider ??= chunk.provider;
      raw += chunk.text ?? "";
      onText?.(raw);
      const cut = cutter.cut(raw);
      if (cut !== undefined) {
        abort.abort();
        return { ...cut, provider };
      }
    }
    return { ...cutter.end(raw), provider };
  }

  /** `newCutter` gives each stream its own, since a cutter remembers what it has read. */
  async function requestReply(
    model: string,
    base: Omit<ChatRequest, "model" | "reasoning">,
    newCutter: () => Cutter,
    signal: AbortSignal,
    onText?: (raw: string) => void,
  ): Promise<Reply> {
    if (!excludeReasoning.has(model)) {
      try {
        return await streamReply({ ...base, model, reasoning: { effort: "none" } }, newCutter(), signal, onText);
      } catch (err) {
        // OpenRouter's wording for an unsupported effort varies, so any 400 gets one try with `exclude`.
        if (!(err instanceof ModelError && err.kind === "bad_request")) throw err;
      }
    }
    const reply = await streamReply({ ...base, model, reasoning: { exclude: true } }, newCutter(), signal, onText);
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
    if (outcome === "accepted" && ended.onAccept) {
      const accepted = acceptEdits(ended.before, ended.at, ended.text, ended.onAccept);
      if (accepted) emit({ type: "edit", docId: ended.docId, ...accepted });
    }
    const entry: LogEntry =
      outcome !== "accepted" && ended.wordAccepted
        ? { ...ended.draft, outcome: "partial", accepted_chars: ended.typed.length }
        : { ...ended.draft, outcome };
    log(entry);
    return ended.text.slice(ended.typed.length);
  }

  /** Takes the `Q:` away from the cursor. */
  function clearQuestion(): void {
    if (!asked) return;
    asked = undefined;
    emit({ type: "clearMarker" });
  }

  async function go(doc: DocumentSnapshot): Promise<void> {
    const pressedAt = deps.clock.now();
    cancelInFlight();
    asked = undefined;
    const notThis = endShown("rejected");
    const mark = (text: string, ttlMs?: number) =>
      emit({ type: "marker", docId: doc.docId, at: doc.cursor, text, ttlMs });
    const dial = effectiveLevel(findPin(doc));
    const pressed = { ts: isoWithOffset(pressedAt), file: doc.path, lang: doc.languageId, level: dial };

    if (dial === 0) {
      mark("Pawl off", NOTICE_TTL_MS);
      log({ ...pressed, context_chars: 0, attempts: 0, outcome: "off" });
      return;
    }

    if (doc.cursorCount > 1 || doc.hasSelection) {
      emit({ type: "collapseSelection", docId: doc.docId, at: doc.cursor });
    }
    const fail = (reason: string, entry: Draft, shownReason = `! ${reason.replaceAll("_", " ")}`) => {
      mark(shownReason, NOTICE_TTL_MS);
      flashStatus(`Pawl ${shownReason}`);
      log({ ...entry, outcome: "error", reason });
    };

    if (!hasKey) return fail("no_key", { ...pressed, model: deps.modelForLevel(dial), context_chars: 0, attempts: 0 });

    const config = deps.config();
    const markers = findMarkers(doc);
    const aim = aimAt(doc, dial, markers, { keepTodo: config.keepTodoOnAccept });
    if (!("level" in aim)) {
      mark("· move to an empty line", NOTICE_TTL_MS);
      const model = deps.modelForLevel(dial);
      log({ ...pressed, model, context_chars: 0, attempts: 0, plan_step: aim.step.number, outcome: "error", reason: "not_empty_line" });
      return;
    }
    const { level } = aim;
    const model = deps.modelForLevel(level);
    const draft: Draft = { ...pressed, level, model, context_chars: 0, attempts: 1 };
    if (aim.step) draft.plan_step = aim.step.number;
    /** The in-flight marker: what the press fills, and anything the user should know about it. */
    const inFlightMarker = (more = "") =>
      [
        aim.source ? `… ${aim.source}${more}` : "…",
        aim.fallback,
        doc.cursorCount > 1 ? "primary cursor only" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
    mark(inFlightMarker());

    let context = assembleContext(doc, level, markers.lines);
    draft.context_chars = contextChars(context);
    const press: InFlight = {
      docId: doc.docId,
      at: doc.cursor,
      draft,
      abort: new AbortController(),
      timedOut: false,
      stopTimer: deps.clock.after(config.timeoutMs, () => {
        press.timedOut = true;
        press.abort.abort();
      }),
    };
    inFlight = press;
    const at = offsetAt(doc.text, doc.cursor);
    const insertion: Insertion = { head: doc.text.slice(0, at), tail: doc.text.slice(at), languageId: doc.languageId };
    let grammar: Awaited<ReturnType<typeof loadGrammar>>;
    let reply: Reply | undefined;
    let error: unknown;
    try {
      // Levels 4–5 also see the files this one imports.
      if (level >= 4 && doc.files) {
        context = withRelated(context, await relatedFiles(doc, doc.files));
        if (inFlight !== press) return;
        draft.context_chars = contextChars(context);
      }
      if (context.truncated) draft.context_truncated = true;
      const messages = buildMessages(doc, level, context, markers.rules, { task: aim.task, notThis });
      draft.prompt = messages;
      grammar = level >= 2 ? await loadGrammar(doc.languageId) : undefined;
      const rule = level === 5 ? planStepRule(doc.languageId) : stopRule(level, insertion, grammar);
      const newCutter = () => createCutter(dropFirstLineIndent(rule, insertion.head), { questions: level >= 3 });
      // At level 5, the marker says so as soon as the step brings new imports.
      let importsShown = 0;
      const onText =
        level === 5
          ? (raw: string) => {
              const body = replyBody(raw)?.body;
              if (body === undefined) return;
              const { imports } = splitImports(body, doc.languageId, false);
              const count = newImports(imports, doc.text, doc.languageId).length;
              if (count === importsShown || inFlight !== press) return;
              importsShown = count;
              mark(inFlightMarker(count > 0 ? ` +${count} import${count > 1 ? "s" : ""}` : ""));
            }
          : undefined;
      const ask = (messages: ChatMessage[]) =>
        requestReply(
          model,
          { messages, provider: { sort: "latency" }, max_tokens: maxTokens(level) },
          newCutter,
          press.abort.signal,
          onText,
        );
      reply = await ask(messages);
      // Levels 3–5 get one more try at an empty reply, within the same deadline.
      if (level >= 3 && reply.question === undefined && reply.suggestion.trim() === "" && inFlight === press) {
        draft.attempts = 2;
        reply = await ask([...messages, CONTINUE_NUDGE]);
      }
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
    showStatus();
    if (reply.question !== undefined) {
      // A question shows at the cursor as a marker, which Tab can't insert.
      draft.suggestion = `Q: ${reply.question.replace(/^Q:\s*/, "")}`;
      mark(draft.suggestion);
      asked = { docId: doc.docId, at: doc.cursor };
      log({ ...draft, outcome: "question" });
      return;
    }
    let suggestion = reply.suggestion;
    let onAccept = aim.onAccept;
    if (level === 5 && suggestion.trim() !== "") {
      const { imports, code } = splitImports(suggestion, doc.languageId);
      suggestion = tidyStep(code, insertion.head);
      if (suggestion.split("\n").length > MAX_STEP_LINES) {
        draft.suggestion = suggestion;
        return fail("step_too_big", draft, "! step too big, split it in the plan");
      }
      if (!parsesWith(insertion, suggestion, grammar)) {
        draft.suggestion = suggestion;
        return fail("step_does_not_parse", draft, "! step doesn't parse, press go again");
      }
      const added = newImports(imports, doc.text, doc.languageId);
      if (added.length > 0) onAccept = { ...onAccept!, imports: importInsertion(doc.text, doc.languageId, added) };
    }
    draft.suggestion = suggestion;
    if (suggestion.trim() === "") {
      mark("· nothing to add", NOTICE_TTL_MS);
      log({ ...draft, outcome: "empty" });
      return;
    }
    emit({ type: "clearMarker" });
    emit({ type: "ghost", docId: doc.docId, at: doc.cursor, text: suggestion });
    shown = {
      docId: doc.docId,
      at: doc.cursor,
      text: suggestion,
      typed: "",
      wordAccepted: false,
      draft,
      before: doc.text,
      onAccept,
    };
  }

  /** Type-through: the suggestion stays while the file matches it, and is accepted once typed out. */
  function edited(docId: string, at: Position, removed: number, text: string): void {
    if (inFlight?.docId === docId) cancelInFlight();
    if (asked?.docId === docId) clearQuestion();
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
    if (asked && (asked.docId !== docId || !samePosition(asked.at, at))) clearQuestion();
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
          // Loads the file's grammar ahead of the first go-press that needs it.
          if (event.doc) void loadGrammar(event.doc.languageId);
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
          clearQuestion();
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

/**
 * The editor has already indented a whitespace-only cursor line, and the suggestion goes in at the
 * cursor, so the reply's first line must not add more indent: any it starts with goes before the
 * stop rule reads it, else a dedent from it looks like the end of the block. At column 0, or after
 * code, the reply is left as it is.
 */
export function dropFirstLineIndent(rule: StopRule, head: string): StopRule {
  const before = head.slice(head.lastIndexOf("\n") + 1);
  if (!/^[ \t]+$/.test(before)) return rule;
  return (text, done) => rule(text.replace(/^[ \t]+/, ""), done);
}

/**
 * A step goes in at the cursor, on its empty line: leading blank lines go, and so does an indent
 * on its first line that repeats the one already before the cursor.
 */
function tidyStep(code: string, head: string): string {
  const indent = head.slice(head.lastIndexOf("\n") + 1);
  const step = code.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return indent && step.startsWith(indent) ? step.slice(indent.length) : step;
}
