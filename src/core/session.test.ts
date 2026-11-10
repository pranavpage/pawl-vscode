import { describe, expect, it, vi } from "vitest";
import { createSession, type Session, type SessionConfig } from "./session";
import { doc, FakeClock, FakeModelClient } from "./testing/fakes";
import { ModelError, type DocumentSnapshot, type Effect, type Level, type Position } from "./types";

function setup({
  hasKey = true,
  level,
  config: overrides = {},
}: { hasKey?: boolean; level?: Level; config?: Partial<SessionConfig> } = {}) {
  const clock = new FakeClock();
  const model = new FakeModelClient(clock);
  const effects: Effect[] = [];
  const config: SessionConfig = { timeoutMs: 8000, log: { enabled: true, prompts: false }, ...overrides };
  const session = createSession({
    model,
    clock,
    modelForLevel: (level) => (level <= 2 ? "deepseek/deepseek-v4.1-flash" : `model-for-level-${level}`),
    level,
    config: () => config,
    emit: (e) => effects.push(e),
  });
  void session.dispatch({ type: "keyChanged", hasKey });
  const of = <T extends Effect["type"]>(type: T) =>
    effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
  return { clock, model, effects, session, of, config };
}

/** Types `text` one character at a time from `at`, the way the editor reports it. */
async function type(session: Session, text: string, at: Position) {
  const docId = "file:///work/main.py";
  for (const [i, ch] of [...text].entries()) {
    const character = at.character + i;
    await session.dispatch({ type: "edited", docId, at: { line: at.line, character }, removed: 0, text: ch });
    await session.dispatch({ type: "cursorMoved", docId, at: { line: at.line, character: character + 1 } });
  }
}

describe("go at level 1", () => {
  it("shows … while in flight, then ghost text that completes only the current line", async () => {
    const { session, model, effects, of } = setup();
    model.reply({ text: "print(" }, { text: "x)\nreturn x\n" });

    const pressed = session.dispatch({ type: "go", doc: doc("def f(x):\n    |") });
    expect(effects).toContainEqual(
      expect.objectContaining({ type: "marker", text: "…", at: { line: 1, character: 4 } }),
    );
    await pressed;

    expect(of("ghost")).toEqual([
      { type: "ghost", docId: "file:///work/main.py", at: { line: 1, character: 4 }, text: "print(x)" },
    ]);
    expect(of("clearMarker").length).toBeGreaterThan(0);
  });
});

describe("the request", () => {
  it("turns reasoning off and asks OpenRouter for the lowest-latency provider", async () => {
    const { session, model } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].body).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      reasoning: { effort: "none" },
      provider: { sort: "latency" },
    });
  });

  it("is aborted as soon as the end of the line streams in", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\nprint(" }, { text: "y)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests[0].aborted).toBe(true);
    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });

  it("falls back to excluding reasoning when the model rejects the request", async () => {
    const { session, model, of } = setup();
    model
      .reply({ error: new ModelError("bad_request", "Provider returned error", 400) })
      .reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "none" }, { exclude: true }]);
    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });
});

describe("model output", () => {
  it.each([
    ["a fenced reply", ["```python\n", "x)\n", "```"]],
    ["a fence split across chunks", ["``", "`py\nx)", "\n```\n"]],
    ["a trailing fence on the same line", ["x)```"]],
    ["a trailing fence before the newline", ["x)```\n"]],
  ])("strips markdown fences from %s", async (_, chunks) => {
    const { session, model, of } = setup();
    model.reply(...chunks.map((text) => ({ text })));

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });
});

describe("the status bar", () => {
  it("shows the level and the latency from go-press to ghost text", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x", afterMs: 400 }, { text: ")\n", afterMs: 240 });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 1 · 640 ms" });
  });
});

describe("without an OpenRouter key", () => {
  it("shows Pawl ! no key in the status bar", () => {
    const { of } = setup({ hasKey: false });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl ! no key" });
  });

  it("shows the error at the cursor on go and sends no request", async () => {
    const { session, model, of } = setup({ hasKey: false });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests).toHaveLength(0);
    expect(of("marker")).toEqual([
      expect.objectContaining({ text: "! no key", at: { line: 0, character: 6 }, ttlMs: 3000 }),
    ]);
    expect(of("ghost")).toEqual([]);
  });

  it("shows the level once a key is set", async () => {
    const { session, of } = setup({ hasKey: false });

    await session.dispatch({ type: "keyChanged", hasKey: true });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 1" });
  });
});

describe("the session log", () => {
  it("writes one line when the suggestion is accepted", async () => {
    const { session, model, of } = setup();
    model.reply({ provider: "DeepInfra" }, { text: "x)\n", afterMs: 610 });

    await session.dispatch({
      type: "go",
      doc: doc("def f(x):\n    print(|\n", { path: "src/main.py" }),
    });
    expect(of("log")).toEqual([]);
    await session.dispatch({ type: "accepted" });

    expect(of("log").map((l) => l.entry)).toEqual([
      {
        ts: "2026-11-09T10:00:00.000+05:30",
        file: "src/main.py",
        lang: "python",
        level: 1,
        model: "deepseek/deepseek-v4.1-flash",
        provider: "DeepInfra",
        context_chars: 20,
        suggestion: "x)",
        latency_ms: 610,
        attempts: 1,
        outcome: "accepted",
      },
    ]);
    expect(of("clearGhost")).toHaveLength(1);
  });

  it("writes nothing when turned off", async () => {
    const { session, model, of } = setup({ config: { log: { enabled: false, prompts: false } } });
    model.reply({ text: "x)\n" }).reply({ error: new ModelError("network", "fetch failed") }).reply({ text: "y)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "accepted" });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "rejected" });

    expect(of("log")).toEqual([]);
  });

  it("leaves the prompt out by default", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "accepted" });

    expect(of("log")[0].entry).not.toHaveProperty("prompt");
  });

  it("adds the full prompt to each line when asked to", async () => {
    const { session, model, of } = setup({ config: { log: { enabled: true, prompts: true } } });
    model.reply({ text: "x)\n" }).reply({ stall: true }).reply({ text: "y)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "accepted" });
    const cancelled = session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await cancelled;
    await session.dispatch({ type: "rejected" });

    const entries = of("log").map((l) => l.entry);
    expect(entries.map((e) => e.outcome)).toEqual(["accepted", "cancelled", "rejected"]);
    entries.forEach((entry, i) => expect(entry.prompt).toEqual(model.requests[i].body.messages));
  });

  it("writes nothing for an accept with no suggestion on screen", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "accepted" });

    expect(of("log")).toEqual([]);
  });
});

describe("errors", () => {
  it("logs a go-press without a key as an error with reason no_key", async () => {
    const { session, of } = setup({ hasKey: false });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("log").map((l) => l.entry)).toEqual([
      {
        ts: "2026-11-09T10:00:00.000+05:30",
        file: "main.py",
        lang: "python",
        level: 1,
        model: "deepseek/deepseek-v4.1-flash",
        context_chars: 0,
        attempts: 0,
        outcome: "error",
        reason: "no_key",
      },
    ]);
  });

  it.each([
    ["network", new ModelError("network", "fetch failed"), "network"],
    ["rate limit", new ModelError("rate_limit", "Too many requests", 429), "rate_limit"],
    ["bad key", new ModelError("bad_key", "No auth credentials found", 401), "bad_key"],
  ])("shows a %s error at the cursor and in the status bar for 3 s", async (label, error, reason) => {
    const { session, model, clock, of } = setup();
    model.reply({ error });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: `! ${label}`, ttlMs: 3000 }));
    expect(of("status").at(-1)).toEqual({ type: "status", text: `Pawl ! ${label}` });
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "error", reason })]);
    clock.advance(2999);
    expect(of("status").at(-1)?.text).toBe(`Pawl ! ${label}`);
    clock.advance(1);
    expect(of("status").at(-1)?.text).toBe("Pawl 1");
  });

  it("shows a model error at the cursor and logs it", async () => {
    const { session, model, of } = setup();
    model.reply({ error: new ModelError("rate_limit", "Too many requests", 429) });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("marker").at(-1)).toEqual(
      expect.objectContaining({ text: "! rate limit", at: { line: 0, character: 6 }, ttlMs: 3000 }),
    );
    expect(of("ghost")).toEqual([]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "error", reason: "rate_limit", attempts: 1, context_chars: 6 }),
    ]);
  });
});

describe("an empty reply", () => {
  it("shows · nothing to add instead of ghost text and logs outcome empty", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "```\n```" });

    await session.dispatch({ type: "go", doc: doc("print(x)|") });

    expect(of("ghost")).toEqual([]);
    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "· nothing to add", ttlMs: 3000 }));
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "empty", suggestion: "" })]);
  });
});

describe("go while a request is in flight", () => {
  it("cancels it, logs it as cancelled and sends a new one", async () => {
    const { session, model, of } = setup();
    model.reply({ stall: true }).reply({ text: "y)\n" });

    const first = session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await first;

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].aborted).toBe(true);
    expect(of("ghost").map((g) => g.text)).toEqual(["y)"]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "cancelled", attempts: 1, context_chars: 6 }),
    ]);
  });
});

describe("typing while a request is in flight", () => {
  it("cancels it, so a suggestion never lands on top of typed text", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x" }, { text: ")\n" });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "edited", docId: "file:///work/main.py", at: { line: 0, character: 6 }, removed: 0, text: "n" });
    await pressed;

    expect(model.requests[0].aborted).toBe(true);
    expect(of("ghost")).toEqual([]);
    expect(of("marker").at(-1)?.text).toBe("…");
    expect(of("clearMarker").length).toBeGreaterThan(0);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });

  it("ignores edits to other files", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x" }, { text: ")\n" });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "edited", docId: "file:///work/other.py", at: { line: 0, character: 0 }, removed: 0, text: "n" });
    await pressed;

    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });
});

describe("go while a suggestion is visible", () => {
  it("logs it as rejected and asks for an alternative that is not it", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "rejected_name)\n" }).reply({ text: "other)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "rejected", suggestion: "rejected_name)" }),
    ]);
    expect(JSON.stringify(model.requests[0].body.messages)).not.toContain("rejected_name)");
    expect(JSON.stringify(model.requests[1].body.messages)).toContain("rejected_name)");
    expect(of("ghost").map((g) => g.text)).toEqual(["rejected_name)", "other)"]);
  });

  it("calls only the part not yet typed \"not this\"", async () => {
    const { session, model } = setup();
    model.reply({ text: "rejected_name)\n" }).reply({ text: "other)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await type(session, "rej", { line: 0, character: 6 });
    await session.dispatch({ type: "go", doc: doc("print(rej|") });

    const prompt = JSON.stringify(model.requests[1].body.messages);
    expect(prompt).toContain("ected_name)");
    expect(prompt).not.toContain("rejected_name)");
  });
});

describe("Esc", () => {
  it("hides the suggestion and logs it as rejected", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "rejected" });

    expect(of("clearGhost")).toHaveLength(1);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "rejected", suggestion: "x)" })]);
  });

  it("does nothing with no suggestion on screen", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "rejected" });

    expect(of("log")).toEqual([]);
  });
});

describe("typing while a suggestion is visible", () => {
  it("keeps it visible while the characters match", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await type(session, "nam", { line: 0, character: 6 });

    expect(of("clearGhost")).toEqual([]);
    expect(of("log")).toEqual([]);
  });

  it("logs accepted once the whole suggestion is typed out", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await type(session, "name)", { line: 0, character: 6 });

    expect(of("clearGhost")).toHaveLength(1);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "accepted", suggestion: "name)" })]);
  });

  it("dismisses it on the first character that doesn't match", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await type(session, "nb", { line: 0, character: 6 });

    expect(of("clearGhost")).toHaveLength(1);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "dismissed" })]);
  });

  it("counts Tab after typing part of it as accepted, however the editor replaces the typed part", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await type(session, "na", { line: 0, character: 6 });
    await session.dispatch({ type: "edited", docId: "file:///work/main.py", at: { line: 0, character: 6 }, removed: 2, text: "name)" });
    await session.dispatch({ type: "accepted" });

    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "accepted" })]);
  });
});

describe("moving away from a suggestion", () => {
  it.each([
    ["moving the cursor", { type: "cursorMoved", docId: "file:///work/main.py", at: { line: 0, character: 2 } }],
    ["clicking into another file", { type: "cursorMoved", docId: "file:///work/other.py", at: { line: 0, character: 6 } }],
    ["switching editors", { type: "editorChanged" }],
  ] as const)("dismisses it on %s", async (_, event) => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch(event);

    expect(of("clearGhost")).toHaveLength(1);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "dismissed" })]);
  });

  it("keeps it when the cursor stays where the suggestion is", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "cursorMoved", docId: "file:///work/main.py", at: { line: 0, character: 6 } });

    expect(of("clearGhost")).toEqual([]);
  });

  it("cancels a request in flight, since its suggestion could no longer show", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x" }, { text: ")\n" });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "cursorMoved", docId: "file:///work/main.py", at: { line: 0, character: 6 } });
    await session.dispatch({ type: "editorChanged" });
    await pressed;

    expect(of("ghost")).toEqual([]);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  });
});

describe("accepting the next word", () => {
  /** What the editor reports when it accepts the next word: the word is inserted, then Pawl's command finishes. */
  async function acceptWord(session: Session, word: string, at: Position) {
    await session.dispatch({ type: "edited", docId: "file:///work/main.py", at, removed: 0, text: word });
    await session.dispatch({ type: "cursorMoved", docId: "file:///work/main.py", at: { ...at, character: at.character + word.length } });
    await session.dispatch({ type: "acceptedWord" });
  }

  it("logs partial with the accepted characters once the rest is rejected", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name, sep=sep)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await acceptWord(session, "name", { line: 0, character: 6 });
    expect(of("log")).toEqual([]);
    await session.dispatch({ type: "rejected" });

    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "partial", accepted_chars: 4, suggestion: "name, sep=sep)" }),
    ]);
  });

  it("logs partial when typing after it doesn't match", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name, sep=sep)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await acceptWord(session, "name", { line: 0, character: 6 });
    await type(session, ")", { line: 0, character: 10 });

    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "partial", accepted_chars: 4 })]);
  });

  it("logs accepted once every word is accepted", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "name)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await acceptWord(session, "name", { line: 0, character: 6 });
    await acceptWord(session, ")", { line: 0, character: 10 });

    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "accepted" })]);
  });
});

describe("the timeout", () => {
  it("ends a press that takes longer than 8 s with ! timeout at the cursor and in the status bar", async () => {
    const { session, model, clock, of } = setup();
    model.reply({ stall: true });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    clock.advance(7999);
    expect(model.requests[0].aborted).toBe(false);
    clock.advance(1);
    await pressed;

    expect(model.requests[0].aborted).toBe(true);
    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "! timeout", ttlMs: 3000 }));
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl ! timeout" });
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "error", reason: "timeout", latency_ms: 8000 }),
    ]);
  });

  it("can be set to 4 s", async () => {
    const { session, model, clock, of } = setup({ config: { timeoutMs: 4000 } });
    model.reply({ stall: true });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    clock.advance(4000);
    await pressed;

    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ reason: "timeout", latency_ms: 4000 })]);
  });

  it("is one deadline per go-press, covering the retry without reasoning", async () => {
    const { session, model, clock, of } = setup();
    model
      .reply({ text: "", afterMs: 5000 }, { error: new ModelError("bad_request", "Provider returned error", 400) })
      .reply({ stall: true });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|") });
    await new Promise((r) => setTimeout(r));
    expect(model.requests).toHaveLength(2);
    clock.advance(3000);
    await pressed;

    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ reason: "timeout", latency_ms: 8000 })]);
  });

  it("does not fire once the press has ended", async () => {
    const { session, model, clock, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    clock.advance(10_000);

    expect(of("marker").map((m) => m.text)).not.toContain("! timeout");
  });
});

describe("cursors and selections", () => {
  it("uses the main cursor only, collapses the others and says so", async () => {
    const { session, model, effects, of } = setup();
    model.reply({ text: "x)\n" });

    const pressed = session.dispatch({ type: "go", doc: doc("print(|", { cursorCount: 3 }) });
    expect(of("marker").at(-1)?.text).toBe("… · primary cursor only");
    await pressed;

    expect(effects).toContainEqual({ type: "collapseSelection", docId: "file:///work/main.py", at: { line: 0, character: 6 } });
    expect(of("ghost")).toEqual([expect.objectContaining({ at: { line: 0, character: 6 }, text: "x)" })]);
  });

  it("collapses a selection to the cursor", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|", { hasSelection: true }) });

    expect(of("collapseSelection")).toEqual([{ type: "collapseSelection", docId: "file:///work/main.py", at: { line: 0, character: 6 } }]);
    expect(of("marker")[0].text).toBe("…");
  });

  it("leaves a single empty cursor alone", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(of("collapseSelection")).toEqual([]);
  });
});

describe("the dial", () => {
  it("steps the level up and down with the level keys and shows it in the status bar at once", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "levelUp" });
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 2" });
    await session.dispatch({ type: "levelUp" });
    await session.dispatch({ type: "levelDown" });
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 2" });
  });

  it("jumps to level 0 with the off key and shows Pawl off", async () => {
    const { session, of } = setup();
    await session.dispatch({ type: "levelUp" });

    await session.dispatch({ type: "setLevel", level: 0 });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl off" });
  });
});

describe("a level change", () => {
  it("leaves the suggestion on screen alone and applies to the next go-press", async () => {
    const { session, model, effects, of } = setup();
    model.reply({ text: "x)\n" }).reply({ text: "y)\n" });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    const shown = effects.length;

    await session.dispatch({ type: "levelUp" });
    expect(effects.slice(shown).filter((e) => e.type === "ghost" || e.type === "clearGhost")).toEqual([]);
    await session.dispatch({ type: "accepted" });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "accepted" });

    expect(model.requests).toHaveLength(2);
    expect(of("log").map((l) => [l.entry.level, l.entry.suggestion])).toEqual([
      [1, "x)"],
      [2, "y)"],
    ]);
  });
});

const goDoc = (source: string) =>
  doc(source, { languageId: "go", path: "main.go", docId: "file:///work/main.go" });
const jsDoc = (source: string) =>
  doc(source, { languageId: "javascript", path: "main.js", docId: "file:///work/main.js" });

/** Presses go at `level` while the model streams `chunks`. */
async function suggest(level: Level, document: DocumentSnapshot, ...chunks: string[]) {
  const t = setup({ level });
  t.model.reply(...chunks.map((text) => ({ text })));
  await t.session.dispatch({ type: "go", doc: document });
  return { ...t, ghost: t.of("ghost").map((g) => g.text) };
}

describe("level 2", () => {
  it.each([
    [
      "Python, a call spanning lines",
      doc("def f(a, b):\n    result = compute(|\n"),
      ["a,\n", "                     b)\n", "    return result\n"],
      "a,\n                     b)",
    ],
    [
      "Python, a statement on a new line",
      doc("def f(xs):\n    |\n"),
      ["total = sum(xs)\n    return total\n"],
      "total = sum(xs)",
    ],
    ["Python, the header of an if", doc("def f(x):\n    if x > 0|\n"), [":\n        return x\n"], ":"],
    ["Python, the rest of the line in the file", doc("print(|)\n"), ["x\n", "print(y)\n"], "x"],
    [
      "Go, a call spanning lines",
      goDoc("package main\n\nfunc f() {\n\tx := compute(|\n}\n"),
      ["a,\n\t\tb)\n", "\treturn x\n"],
      "a,\n\t\tb)",
    ],
    [
      "Go, the header of an if",
      goDoc("package main\n\nfunc f(err error) error {\n\tif err != nil|\n}\n"),
      [" {\n\t\treturn err\n\t}\n"],
      " {",
    ],
    [
      "an untuned language, by brackets",
      jsDoc("function f() {\n  const x = compute(|\n}\n"),
      ["a,\n    b);\n  return x;\n"],
      "a,\n    b);",
    ],
    [
      "Go, after a comment",
      goDoc("package main\n\nfunc f() {\n\t|\n}\n"),
      ["// note\n\tx := 1\n", "\ty := 2\n"],
      "// note\n\tx := 1",
    ],
    ["an untuned language, at a semicolon", jsDoc("function f() {\n  |\n}\n"), ["let a = 1; let b = 2;\n"], "let a = 1;"],
  ])("finishes only the current statement: %s", async (_, document, chunks, expected) => {
    const { ghost, model } = await suggest(2, document, ...chunks);

    expect(ghost).toEqual([expected]);
    expect(model.requests[0].aborted).toBe(true);
  });
});

describe("level 3", () => {
  it.each([
    [
      "Python, the function body",
      doc("def total(xs):\n    |\n"),
      ["t = 0\n    for x in xs:\n", "        t += x\n    return t\n", "\n\nprint(total([1]))\n"],
      "t = 0\n    for x in xs:\n        t += x\n    return t",
    ],
    [
      "Python, the if body the cursor is in",
      doc("def f(x):\n    if x:\n        |\n    return x\n"),
      ["x += 1\n        print(x)\n", "    else:\n        pass\n"],
      "x += 1\n        print(x)",
    ],
    [
      "Python, a function whose header the user has started",
      doc("def add(a, b|\n"),
      ["):\n    return a + b\n", "\n\ndef sub(a, b):\n    return a - b\n"],
      "):\n    return a + b",
    ],
    [
      "Go, a function whose header the user has started",
      goDoc("package main\n\nfunc add(a, b int|\n"),
      [") int {\n\treturn a + b\n}\n", "\nfunc sub() {}\n"],
      ") int {\n\treturn a + b\n}",
    ],
    [
      "Go, a block the file already closes",
      goDoc("package main\n\nfunc sum(xs []int) int {\n\t|\n}\n"),
      ["t := 0\n\tfor _, x := range xs {\n\t\tt += x\n\t}\n", "\treturn t\n}\n", "\nfunc other() {}\n"],
      "t := 0\n\tfor _, x := range xs {\n\t\tt += x\n\t}\n\treturn t",
    ],
    [
      "Go, a block the file does not close yet",
      goDoc("package main\n\nfunc sum(xs []int) int {\n\t|"),
      ["t := 0\n\treturn t\n}\n", "\nfunc other() {}\n"],
      "t := 0\n\treturn t\n}",
    ],
    [
      "Go, the if body the cursor is in",
      goDoc("package main\n\nfunc f(err error) error {\n\tif err != nil {\n\t\t|\n\t}\n\treturn nil\n}\n"),
      ["log(err)\n\t\treturn err\n\t}\n", "\treturn nil\n}\n"],
      "log(err)\n\t\treturn err",
    ],
    [
      "an untuned language, by braces",
      jsDoc("function f(xs) {\n  |\n}\n"),
      ["let t = 0;\n  for (const x of xs) {\n    t += x;\n  }\n", "  return t;\n}\n", "\nfunction g() {}\n"],
      "let t = 0;\n  for (const x of xs) {\n    t += x;\n  }\n  return t;",
    ],
  ])("writes only the block the cursor is in: %s", async (_, document, chunks, expected) => {
    const { ghost, model } = await suggest(3, document, ...chunks);

    expect(ghost).toEqual([expected]);
    expect(model.requests[0].aborted).toBe(true);
  });

  it("falls back to brackets when the reply would break the file, as by repeating its `}`", async () => {
    const { ghost } = await suggest(3, goDoc("package main\n\nfunc f() {\n\tx := []int{\n\t\t|\n\t}\n}\n"), "1, 2,\n\t}\n\treturn\n");

    expect(ghost).toEqual(["1, 2,"]);
  });

  it("keeps the whole reply when it stays inside the block", async () => {
    const { ghost, model } = await suggest(3, doc("def f(x):\n    |\n"), "y = x * 2\n", "    return y\n");

    expect(ghost).toEqual(["y = x * 2\n    return y"]);
    expect(model.requests[0].aborted).toBe(false);
  });

  it("sends more room for a block than for a line", async () => {
    const { model } = await suggest(3, doc("def f(x):\n    |\n"), "return x\n");

    expect(model.requests[0].body.max_tokens).toBeGreaterThan(128);
  });
});

describe("an empty reply at level 3", () => {
  it("is retried once with a nudge to continue, and logged with attempts: 2", async () => {
    const { session, model, of } = setup({ level: 3 });
    model.reply({ text: "\n\nprint(1)\n" }).reply({ text: "return x\n" });

    await session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });
    await session.dispatch({ type: "accepted" });

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].body.messages.slice(0, -1)).toEqual(model.requests[0].body.messages);
    expect(model.requests[1].body.messages.at(-1)?.content).toContain("Continue the implementation");
    expect(of("ghost").map((g) => g.text)).toEqual(["return x"]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "accepted", attempts: 2, suggestion: "return x" }),
    ]);
  });

  it("shows · nothing to add when the retry is empty too", async () => {
    const { session, model, of } = setup({ level: 3 });
    model.reply({ text: "" }).reply({ text: "" });

    await session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });

    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "· nothing to add" }));
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "empty", attempts: 2 })]);
  });

  it("is retried within the same deadline", async () => {
    const { session, model, clock, of } = setup({ level: 3 });
    model.reply({ text: "", afterMs: 5000 }).reply({ stall: true });

    const pressed = session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });
    await vi.waitFor(() => expect(model.requests).toHaveLength(2));
    clock.advance(3000);
    await pressed;

    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "error", reason: "timeout", latency_ms: 8000, attempts: 2 }),
    ]);
  });

  it("is not retried at level 2", async () => {
    const { session, model, of } = setup({ level: 2 });
    model.reply({ text: "" });

    await session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });

    expect(model.requests).toHaveLength(1);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ outcome: "empty", attempts: 1 })]);
  });
});

describe("levels 4 and 5", () => {
  it("send each press to the level's model and, until their own rules land, write a block like level 3", async () => {
    const { session, model, of } = setup({ level: 4 });
    model.reply({ text: "return x\n\nprint(1)\n" });

    await session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });
    await session.dispatch({ type: "accepted" });

    expect(model.requests[0].body.model).toBe("model-for-level-4");
    expect(of("ghost").map((g) => g.text)).toEqual(["return x"]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ level: 4, model: "model-for-level-4", outcome: "accepted" }),
    ]);
  });
});

/** The file as the model saw it in the last request. */
const sentFile = (model: FakeModelClient) => model.requests.at(-1)!.body.messages.at(-1)!.content;
const sentSystem = (model: FakeModelClient) => model.requests.at(-1)!.body.messages[0].content;
const numbered = (from: number, to: number, indent = "") =>
  Array.from({ length: to - from + 1 }, (_, k) => `${indent}x${from + k} = ${from + k}`).join("\n");

describe("the context", () => {
  const file = [
    "import os",
    "",
    "def first():",
    numbered(1, 30, "    "),
    "",
    "def second():",
    numbered(31, 60, "    "),
    "    |",
    numbered(61, 65, "    "),
    "",
    "def third():",
    "    pass",
    "",
  ].join("\n");

  it("at level 1 is the current line, the 20 lines above it and the rest of its block", async () => {
    const { model } = await suggest(1, doc(file), "x\n");

    const sent = sentFile(model);
    expect(sent).toContain("    x41 = 41\n");
    expect(sent).not.toContain("x40 = 40");
    expect(sent).toContain("x65 = 65");
    expect(sent).not.toContain("def third");
  });

  it("at level 2 is the function the cursor is in", async () => {
    const { model } = await suggest(2, doc(file), "x\n");

    const sent = sentFile(model);
    expect(sent).toContain("def second():\n    x31 = 31");
    expect(sent).toContain("x65 = 65");
    expect(sent).not.toContain("def first");
    expect(sent).not.toContain("def third");
  });

  it("at level 3 is the whole file", async () => {
    const { model, of, session } = await suggest(3, doc(file), "x\n");
    await session.dispatch({ type: "accepted" });

    const sent = sentFile(model);
    expect(sent).toContain("import os\n\ndef first():");
    expect(sent).toContain("def third():\n    pass");
    expect(of("log")[0].entry).not.toHaveProperty("context_truncated");
  });

  describe("past the cap at levels 3–5", () => {
    const big = (cursorAt: number) =>
      [
        "# @pawl level=3",
        "import os",
        "# RULE: no external deps",
        "# PLAN",
        "# [ ] read the file",
        "# END PLAN",
        "",
        "def big():",
        numbered(1, cursorAt - 1, "    "),
        "    |",
        numbered(cursorAt, 6000, "    "),
        "",
      ].join("\n");

    it("keeps a window centred on the cursor, with the marker and import lines, and logs context_truncated", async () => {
      const { model, session, of } = await suggest(3, doc(big(3000)), "x\n");
      await session.dispatch({ type: "accepted" });

      const sent = sentFile(model);
      expect(sent.length).toBeLessThan(50_000);
      expect(sent).toContain("x2999 = 2999\n    <CURSOR>\n    x3000 = 3000");
      expect(sent).not.toContain("x1000 = 1000\n");
      expect(sent).not.toContain("x5000 = 5000\n");
      for (const line of ["# @pawl level=3", "import os", "# RULE: no external deps", "# PLAN", "# [ ] read the file", "# END PLAN"]) {
        expect(sent).toContain(line);
      }
      const above = sent.slice(0, sent.indexOf("<CURSOR>")).split("\n").length;
      const below = sent.slice(sent.indexOf("<CURSOR>")).split("\n").length;
      expect(Math.abs(above - below)).toBeLessThan(20);
      expect(of("log")[0].entry).toEqual(expect.objectContaining({ context_truncated: true }));
    });

    it("applies at levels 4 and 5 too", async () => {
      for (const level of [4, 5] as const) {
        const { model } = await suggest(level, doc(big(3000)), "x\n");
        expect(sentFile(model).length).toBeLessThan(50_000);
      }
    });
  });
});

describe("RULE:", () => {
  it("is sent with every request, wherever it is in the file", async () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      const lines = ["# RULE: no external deps", numbered(1, 100), "def f():", "    |", ""].join("\n");
      const { model } = await suggest(level, doc(lines), "x\n");

      if (level === 1) expect(sentFile(model)).not.toContain("RULE");
      expect(sentSystem(model)).toContain("no external deps");
    }
  });

  it("works in Go comments", async () => {
    const { model } = await suggest(1, goDoc("package main\n\n// RULE: wrap errors with %w\nfunc f() {\n\t|\n}\n"), "x\n");

    expect(sentSystem(model)).toContain("wrap errors with %w");
  });

  it.each([
    ["in a string", 'x = "RULE: not a rule"'],
    ["in a docstring", '"""\n# RULE: not a rule\n"""'],
    ["in lower case", "# rule: not a rule"],
    ["after other text", "# see RULE: not a rule"],
    ["as part of a word", "# XRULE: not a rule"],
  ])("counts only in a comment with the exact prefix, so not %s", async (_, line) => {
    const { model } = await suggest(1, doc(`${line}\nprint(|`), "x)\n");

    expect(sentSystem(model)).not.toContain("not a rule");
  });
});

describe("the global level", () => {
  it("is saved on every change so it survives a restart", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "levelUp" });
    await session.dispatch({ type: "setLevel", level: 0 });

    expect(of("saveLevel")).toEqual([
      { type: "saveLevel", level: 2 },
      { type: "saveLevel", level: 0 },
    ]);
  });

  it("starts from the saved level", () => {
    const { of } = setup({ level: 3 });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 3" });
  });
});

describe("at level 0", () => {
  it("go shows Pawl off at the cursor, logs outcome off and calls no model", async () => {
    const { session, model, of } = setup();
    await session.dispatch({ type: "setLevel", level: 0 });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests).toHaveLength(0);
    expect(of("marker")).toEqual([
      expect.objectContaining({ text: "Pawl off", at: { line: 0, character: 6 }, ttlMs: 3000 }),
    ]);
    expect(of("log").map((l) => l.entry)).toEqual([
      {
        ts: "2026-11-09T10:00:00.000+05:30",
        file: "main.py",
        lang: "python",
        level: 0,
        context_chars: 0,
        attempts: 0,
        outcome: "off",
      },
    ]);
  });

  it("go still ends the suggestion on screen, so only Pawl off shows", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });
    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "setLevel", level: 0 });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests).toHaveLength(1);
    expect(of("clearGhost")).toHaveLength(1);
    expect(of("log").map((l) => l.entry.outcome)).toEqual(["rejected", "off"]);
  });

  it("shows Pawl off rather than a missing key", async () => {
    const { session, of } = setup({ hasKey: false });

    await session.dispatch({ type: "setLevel", level: 0 });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl off" });
  });
});

describe("a pinned file", () => {
  const pinned = "#!/usr/bin/env python3\n# practice file  @pawl level=3\nprint(|";

  it("shows the pinned level in the status bar when it becomes the active file", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "activeDocChanged", doc: doc(pinned) });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 3 · pinned" });
  });

  it("uses the pinned level and its model for a go-press", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc(pinned) });
    await session.dispatch({ type: "accepted" });

    expect(model.requests[0].body.model).toBe("model-for-level-3");
    expect(of("log").map((l) => l.entry.level)).toEqual([3]);
  });

  it.each([
    ["level up", { type: "levelUp" }],
    ["level down", { type: "levelDown" }],
    ["a level pick", { type: "setLevel", level: 5 }],
  ] as const)("ignores %s and says why", async (_, event) => {
    const { session, of } = setup();
    await session.dispatch({ type: "activeDocChanged", doc: doc(pinned) });

    await session.dispatch(event);

    expect(of("notice")).toEqual([
      { type: "notice", text: "pinned by @pawl, remove it to use the dial", ttlMs: 3000 },
    ]);
    expect(of("saveLevel")).toEqual([]);
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 3 · pinned" });
  });

  it("is overridden by the off key, and returns to its pinned level when the dial goes up again", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\n" });
    await session.dispatch({ type: "activeDocChanged", doc: doc(pinned) });

    await session.dispatch({ type: "setLevel", level: 0 });
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl off" });
    await session.dispatch({ type: "go", doc: doc(pinned) });
    expect(model.requests).toHaveLength(0);

    await session.dispatch({ type: "levelUp" });
    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl 3 · pinned" });
    await session.dispatch({ type: "go", doc: doc(pinned) });
    await session.dispatch({ type: "accepted" });

    expect(of("saveLevel").map((e) => e.level)).toEqual([0, 1]);
    expect(of("log").map((l) => [l.entry.level, l.entry.outcome])).toEqual([
      [0, "off"],
      [3, "accepted"],
    ]);
  });
});

describe("a file pinned to level 0", () => {
  it("says it is pinned off, so the dial not moving makes sense", async () => {
    const { session, of } = setup();

    await session.dispatch({ type: "activeDocChanged", doc: doc("# @pawl level=0\nprint(|") });

    expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl off · pinned" });
  });
});

describe("an invalid pin", () => {
  it.each(["@pawl level=7", "@pawl level=x", "@pawl level=", "@pawl level=12", "@pawl"])(
    "(%s) shows Pawl ! bad @pawl and the global level applies",
    async (pin) => {
      const { session, model, of } = setup();
      model.reply({ text: "x)\n" });
      const file = `# ${pin}\nprint(|`;

      await session.dispatch({ type: "activeDocChanged", doc: doc(file) });
      expect(of("status").at(-1)).toEqual({ type: "status", text: "Pawl ! bad @pawl" });
      await session.dispatch({ type: "levelUp" });
      await session.dispatch({ type: "go", doc: doc(file) });
      await session.dispatch({ type: "accepted" });

      expect(of("notice")).toEqual([]);
      expect(of("log").map((l) => l.entry.level)).toEqual([2]);
    },
  );
});

describe("the @pawl pin", () => {
  it.each([
    ["a Python # comment", "python", "import os  # @pawl level=2\n|", "Pawl 2 · pinned"],
    ["a Go // comment", "go", "// @pawl level=2\npackage main\n|", "Pawl 2 · pinned"],
    ["a Go /* */ comment", "go", "/*\n  Practice.\n  @pawl level=2\n*/\npackage main\n|", "Pawl 2 · pinned"],
    ["line 6", "python", "\n\n\n\n\n# @pawl level=2\n|", "Pawl 1"],
    ["a string", "python", 'tag = "@pawl level=2"\n|', "Pawl 1"],
    ["a string before a # comment", "python", 's = "#"  # @pawl level=2\n|', "Pawl 2 · pinned"],
    ["a # in a string", "python", 's = "# @pawl level=2"\n|', "Pawl 1"],
    ["Python's // operator", "python", "x = 7 // 2  @pawl level=2\n|", "Pawl 1"],
    ["Go's # character", "go", "# @pawl level=2\n|", "Pawl 1"],
  ])("counts in %s only when it is a comment in that language", async (_, languageId, source, status) => {
    const { session, of } = setup();

    await session.dispatch({ type: "activeDocChanged", doc: doc(source, { languageId }) });

    expect(of("status").at(-1)).toEqual({ type: "status", text: status });
  });
});
