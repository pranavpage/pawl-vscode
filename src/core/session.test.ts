import { describe, expect, it, vi } from "vitest";
import { createSession, type Session, type SessionConfig } from "./session";
import { doc, FakeClock, FakeModelClient } from "./testing/fakes";
import { ModelError, type DocumentSnapshot, type Effect, type Level, type Position, type WorkspaceFiles } from "./types";

function setup({
  hasKey = true,
  level,
  config: overrides = {},
}: { hasKey?: boolean; level?: Level; config?: Partial<SessionConfig> } = {}) {
  const clock = new FakeClock();
  const model = new FakeModelClient(clock);
  const effects: Effect[] = [];
  const config: SessionConfig = {
    timeoutMs: 8000,
    log: { enabled: true, prompts: false },
    keepTodoOnAccept: false,
    ...overrides,
  };
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

  const badRequest = () => ({ error: new ModelError("bad_request", "Provider returned error", 400) });

  it("falls back to minimal reasoning when the model rejects effort none", async () => {
    const { session, model, of } = setup();
    model.reply(badRequest()).reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "none" }, { effort: "minimal" }]);
    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });

  it("falls back to low reasoning when the model rejects none and minimal", async () => {
    const { session, model, of } = setup();
    model.reply(badRequest()).reply(badRequest()).reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests.map((r) => r.body.reasoning)).toEqual([
      { effort: "none" },
      { effort: "minimal" },
      { effort: "low" },
    ]);
    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
  });

  it("starts the next press with the same model from the setting that worked", async () => {
    const { session, model } = setup();
    model.reply(badRequest()).reply(badRequest()).reply({ text: "x)\n" }).reply({ text: "y)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "rejected" });
    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests.map((r) => r.body.reasoning)).toEqual([
      { effort: "none" },
      { effort: "minimal" },
      { effort: "low" },
      { effort: "low" },
    ]);
  });

  it("fails the press as a bad request when every setting is rejected", async () => {
    const { session, model, of } = setup();
    model.reply(badRequest()).reply(badRequest()).reply(badRequest());

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests).toHaveLength(3);
    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "! bad request" }));
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "error", reason: "bad_request" }),
    ]);
  });

  it("never sends exclude", async () => {
    const { session, model } = setup();
    model.reply(badRequest()).reply(badRequest()).reply(badRequest());

    await session.dispatch({ type: "go", doc: doc("print(|") });

    for (const r of model.requests) expect(r.body.reasoning).not.toHaveProperty("exclude");
  });

  it.each([
    ["rate limit", new ModelError("rate_limit", "Too many requests", 429)],
    ["auth", new ModelError("bad_key", "Unauthorized", 401)],
  ])("does not fall back on a %s error", async (_, error) => {
    const { session, model } = setup();
    model.reply({ error }).reply({ text: "x)\n" });

    await session.dispatch({ type: "go", doc: doc("print(|") });

    expect(model.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "none" }]);
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

  it("is one deadline per go-press, covering the reasoning fallback", async () => {
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

/** The `edit` effects so far. */
const editsOf = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: "edit" }> => e.type === "edit");

/**
 * The file after Tab: the suggestion at the cursor, then the edits the accept brought. The
 * cursor ends where the edits leave it, else after the suggestion.
 */
function afterAccept(document: DocumentSnapshot, suggestion: string, edit?: Extract<Effect, { type: "edit" }>): DocumentSnapshot {
  const lines = document.text.split("\n");
  const at = lines.slice(0, document.cursor.line).reduce((n, l) => n + l.length + 1, 0) + document.cursor.character;
  let text = document.text.slice(0, at) + suggestion + document.text.slice(at);
  const inserted = suggestion.split("\n");
  let cursor: Position = {
    line: document.cursor.line + inserted.length - 1,
    character: (inserted.length === 1 ? document.cursor.character : 0) + inserted.at(-1)!.length,
  };
  if (edit) {
    const offset = (p: Position) => text.split("\n").slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    const ranges = edit.edits.map((e) => ({ ...e, from: offset(e.start), to: offset(e.end) }));
    for (const e of ranges.sort((a, b) => b.from - a.from)) {
      expect(text.slice(e.from, e.to)).toBe(e.replaces);
      text = text.slice(0, e.from) + e.text + text.slice(e.to);
    }
    cursor = edit.cursor;
  }
  return { ...document, text, cursor };
}

/** A workspace folder holding `files`, by path. */
function workspace(files: Record<string, string>): WorkspaceFiles {
  return {
    read: async (path) => files[path],
    list: async (dir) =>
      Object.keys(files)
        .filter((path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) === dir)
        .map((path) => path.slice(path.lastIndexOf("/") + 1)),
  };
}

/** Presses go at `level`, waits for the suggestion and presses Tab. */
async function acceptAt(level: Level, document: DocumentSnapshot, reply: string, config: Partial<SessionConfig> = {}) {
  const t = setup({ level, config });
  t.model.reply({ text: reply });
  await t.session.dispatch({ type: "go", doc: document });
  const ghost = t.of("ghost").at(-1)!.text;
  await t.session.dispatch({ type: "accepted" });
  return { ...t, ghost, after: afterAccept(document, ghost, editsOf(t.effects).at(-1)) };
}

describe("level 4", () => {
  it("fills the TODO the cursor is under, names it in the in-flight marker, and removes it on accept", async () => {
    const document = doc("def total(xs):\n    t = 0\n    # TODO: add up xs\n    |\n    return t\n");
    const { model, of, after } = await acceptAt(4, document, "for x in xs:\n        t += x\n");

    expect(of("marker")[0]).toEqual(expect.objectContaining({ text: "… TODO:3" }));
    expect(model.requests[0].body.model).toBe("model-for-level-4");
    expect(sentSystem(model)).toContain('TODO comment on line 3 asks for: "add up xs"');
    expect(after.text).toBe("def total(xs):\n    t = 0\n    for x in xs:\n        t += x\n    return t\n");
    expect(after.cursor).toEqual({ line: 3, character: 14 });
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ level: 4, outcome: "accepted" })]);
  });

  it("fills a TODO the cursor is at the end of, and leaves no blank line where it was", async () => {
    const { after } = await acceptAt(4, doc("def f(xs):\n    # TODO: sort xs|\n    return xs\n"), "\n    xs = sorted(xs)\n");

    expect(after.text).toBe("def f(xs):\n    xs = sorted(xs)\n    return xs\n");
  });

  it("carries a TODO on to the comment lines right under it, and removes them all", async () => {
    const document = goDoc("package main\n\nfunc f(xs []int) int {\n\t// TODO: return the largest,\n\t// or 0 when xs is empty\n\t|\n}\n");
    const { model, after } = await acceptAt(4, document, "return max(xs)\n");

    expect(sentSystem(model)).toContain('"return the largest, or 0 when xs is empty"');
    expect(after.text).toBe("package main\n\nfunc f(xs []int) int {\n\treturn max(xs)\n}\n");
  });

  it("removes only the comment of a TODO after code", async () => {
    const { after } = await acceptAt(4, doc("def f(x):\n    y = g(x)  # TODO: check y\n    |\n"), "assert y\n");

    expect(after.text).toBe("def f(x):\n    y = g(x)\n    assert y\n");
  });

  it("keeps the TODO with pawl.keepTodoOnAccept on", async () => {
    const document = doc("def f(xs):\n    # TODO: sort xs\n    |\n");
    const { after, effects } = await acceptAt(4, document, "return sorted(xs)\n", { keepTodoOnAccept: true });

    expect(editsOf(effects)).toEqual([]);
    expect(after.text).toBe("def f(xs):\n    # TODO: sort xs\n    return sorted(xs)\n");
  });

  it.each([
    [
      "Python, pass after a docstring and a comment, which stay",
      doc('def area(r):\n    """Area of a circle."""\n    # r in metres\n    pass|\n'),
      "\n    return 3.14 * r * r\n",
      'def area(r):\n    """Area of a circle."""\n    # r in metres\n    return 3.14 * r * r\n',
    ],
    ["Python, ...", doc("def f(x):\n    |\n    ...\n\n\nf(1)\n"), "return x\n", "def f(x):\n    return x\n\n\nf(1)\n"],
    [
      "Python, raise NotImplementedError",
      doc('class Shape:\n    def area(self):\n        |\n        raise NotImplementedError("later")\n'),
      "return 0\n",
      "class Shape:\n    def area(self):\n        return 0\n",
    ],
    [
      "Go, panic(...)",
      goDoc('package main\n\nfunc add(a, b int) int {\n\t|\n\tpanic("todo")\n}\n'),
      "return a + b\n",
      "package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n",
    ],
    ["Go, no placeholder", goDoc("package main\n\nfunc add(a, b int) int {\n\t|\n}\n"), "return a + b\n", "package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n"],
  ])("fills the empty body the cursor is in and removes a lone placeholder: %s", async (_, document, reply, expected) => {
    const { after, of, model } = await acceptAt(4, document, reply);

    expect(of("marker")[0].text).toMatch(/^… body:\d+$/);
    expect(sentSystem(model)).toContain("Fill the empty body of the function");
    expect(after.text).toBe(expected);
  });

  it("fills an empty body from the blank line right under its header", async () => {
    const { of } = await suggest(4, doc("def f(x):\n|\n\ndef g():\n    return 1\n"), "    return x\n");

    expect(of("marker")[0].text).toBe("… body:1");
  });

  it.each([
    ["a function that has code", doc("def f(x):\n    y = x\n    |\n")],
    ["a TODO in lower case", doc("def f(x):\n    y = x\n    # todo: double it\n    |\n")],
    ["a TODO two lines up", doc("def f(x):\n    # TODO: double it\n    y = x\n    |\n")],
    ["the top level", doc("import os\n\n|\n")],
  ])("falls back to level 3 and says so, without a TODO or empty body at the cursor: %s", async (_, document) => {
    const { session, model, of } = await suggest(4, document, "x = 1\n");
    await session.dispatch({ type: "accepted" });

    expect(of("marker")[0].text).toBe("… · no TODO here, using level 3");
    expect(model.requests[0].body.model).toBe("model-for-level-3");
    expect(sentSystem(model)).not.toContain("TODO comment");
    expect(of("log").map((l) => l.entry.level)).toEqual([3]);
    expect(editsOf(of("edit"))).toEqual([]);
  });

  it("retries an empty reply once", async () => {
    const { session, model, of } = setup({ level: 4 });
    model.reply({ text: "" }).reply({ text: "return x\n" });

    await session.dispatch({ type: "go", doc: doc("def f(x):\n    |\n") });
    await session.dispatch({ type: "accepted" });

    expect(model.requests).toHaveLength(2);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ level: 4, attempts: 2, outcome: "accepted" })]);
  });
});

describe("the context at levels 4–5", () => {
  const python = workspace({
    "app/main.py": "",
    "app/utils.py": "def helper():\n    return 1\n",
    "app/unused.py": "UNUSED = 1\n",
    "pkg/__init__.py": "",
    "pkg/models.py": "class Model:\n    pass\n",
  });
  const pythonDoc = (level: Level) =>
    suggest(
      level,
      doc("from .utils import helper\nimport pkg.models\nimport os\n\ndef f():\n    |\n", { path: "app/main.py", files: python }),
      "return helper()\n",
    );

  it("adds the files a Python file imports from the workspace, whole and nearest first", async () => {
    const { model } = await pythonDoc(4);

    const sent = sentFile(model);
    expect(sent).toContain("app/utils.py\n\ndef helper():\n    return 1\n");
    expect(sent).toContain("pkg/models.py\n\nclass Model:\n    pass\n");
    expect(sent.indexOf("app/utils.py")).toBeLessThan(sent.indexOf("pkg/models.py"));
    expect(sent).not.toContain("UNUSED");
  });

  it("adds a Go file's package siblings, then the packages it imports from its module", async () => {
    const files = workspace({
      "go.mod": "module example.com/shop\n\ngo 1.24\n",
      "cmd/shop/main.go": "",
      "cmd/shop/flags.go": "package main\n\nvar verbose bool\n",
      "cmd/shop/main_test.go": "package main\n\nfunc TestX() {}\n",
      "internal/store/store.go": "package store\n\ntype Store struct{}\n",
      "internal/other/other.go": "package other\n",
    });
    const document = goDoc('package main\n\nimport (\n\t"fmt"\n\t"example.com/shop/internal/store"\n)\n\nfunc run(s store.Store) {\n\t|\n}\n');
    const { model } = await suggest(4, { ...document, path: "cmd/shop/main.go", files }, "fmt.Println(s)\n");

    const sent = sentFile(model);
    expect(sent).toContain("var verbose bool");
    expect(sent).toContain("type Store struct{}");
    expect(sent.indexOf("var verbose bool")).toBeLessThan(sent.indexOf("type Store struct{}"));
    expect(sent).not.toContain("TestX");
    expect(sent).not.toContain("package other");
  });

  it("leaves out files past the cap and logs context_truncated", async () => {
    const files = workspace({ "big.py": `X = "${"x".repeat(60_000)}"\n`, "small.py": "Y = 1\n" });
    const { model, session, of } = await suggest(
      4,
      doc("import big\nimport small\n\ndef f():\n    |\n", { files }),
      "return small.Y\n",
    );
    await session.dispatch({ type: "accepted" });

    expect(sentFile(model)).not.toContain("xxxx");
    expect(sentFile(model)).toContain("Y = 1");
    expect(of("log")[0].entry).toEqual(expect.objectContaining({ context_truncated: true }));
  });

  it("is not added at level 3", async () => {
    const { model } = await pythonDoc(3);

    expect(sentFile(model)).not.toContain("def helper");
  });
});

describe("a Q: reply", () => {
  it.each([3, 4, 5] as const)("at level %i shows at the cursor as a marker, not ghost text, and is logged as question", async (level) => {
    const document = doc("# PLAN\n# [ ] total the prices\n# END PLAN\n\ndef total(prices):\n    |\n");
    const { session, of, model } = await suggest(level, document, "Q: Should prices in cents", " be rounded?\nreturn 0\n");
    await session.dispatch({ type: "accepted" });

    expect(of("ghost")).toEqual([]);
    expect(of("marker").at(-1)).toEqual(
      expect.objectContaining({ text: "Q: Should prices in cents be rounded?", at: { line: 5, character: 4 } }),
    );
    expect(of("marker").at(-1)?.ttlMs).toBeUndefined();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].aborted).toBe(true);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "question", suggestion: "Q: Should prices in cents be rounded?" }),
    ]);
  });

  it("stays until the cursor moves", async () => {
    const { session, of } = await suggest(4, doc("def f(x):\n    |\n"), "Q: Which x?\n");
    const cleared = of("clearMarker").length;

    await session.dispatch({ type: "cursorMoved", docId: "file:///work/main.py", at: { line: 1, character: 4 } });
    expect(of("clearMarker")).toHaveLength(cleared);
    await session.dispatch({ type: "cursorMoved", docId: "file:///work/main.py", at: { line: 0, character: 0 } });
    expect(of("clearMarker")).toHaveLength(cleared + 1);
  });

  it.each([1, 2] as const)("at level %i counts as empty", async (level) => {
    const { session, of } = await suggest(level, doc("def f(x):\n    |\n"), "Q: Which x?\n");
    await session.dispatch({ type: "accepted" });

    expect(of("ghost")).toEqual([]);
    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "· nothing to add" }));
    expect(of("log").map((l) => l.entry.outcome)).toEqual(["empty"]);
  });

  it("is never part of a suggestion: a Q: line after code ends it", async () => {
    const { ghost } = await suggest(3, doc("def f(x):\n    |\n"), "y = x * 2\n    Q: return y too?\n    return y\n");

    expect(ghost).toEqual(["y = x * 2"]);
  });
});

describe("level 5", () => {
  const plan = (cursorLine = "|") =>
    doc(
      [
        "# PLAN",
        "# [x] read the numbers",
        "# [ ] print their sum",
        "# [ ] print their mean",
        "# END PLAN",
        "import sys",
        "",
        "nums = [int(a) for a in sys.argv[1:]]",
        cursorLine,
        "",
      ].join("\n"),
    );

  it("writes code for the first unchecked step only, at the cursor", async () => {
    const { session, model, of, ghost } = await suggest(5, plan(), "print(sum(nums))\n");
    await session.dispatch({ type: "rejected" });

    expect(of("marker")[0].text).toBe("… plan step 2");
    expect(model.requests[0].body.model).toBe("model-for-level-5");
    expect(sentSystem(model)).toContain('step 2 only: "print their sum"');
    expect(ghost).toEqual(["print(sum(nums))"]);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ level: 5, plan_step: 2, outcome: "rejected" })]);
  });

  it("ticks the step on accept and leaves the cursor on a new line just after the code", async () => {
    const { after } = await acceptAt(5, plan("    |"), "print(sum(nums))\n");

    expect(after.text).toContain("# [x] print their sum\n# [ ] print their mean");
    expect(after.text).toContain("nums = [int(a) for a in sys.argv[1:]]\n    print(sum(nums))\n    \n");
    expect(after.cursor).toEqual({ line: 9, character: 4 });
  });

  it.each(["x = 1|", "  x|  ", "|x"])("needs the cursor on an empty line, not %j", async (line) => {
    const { session, model, of } = setup({ level: 5 });

    await session.dispatch({ type: "go", doc: plan(line) });

    expect(model.requests).toHaveLength(0);
    expect(of("marker")).toEqual([expect.objectContaining({ text: "· move to an empty line", ttlMs: 3000 })]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ level: 5, plan_step: 2, outcome: "error", reason: "not_empty_line", attempts: 0 }),
    ]);
  });

  it("moves an import the step needs to the file's imports, and says +1 import while in flight", async () => {
    const { of, ghost, after } = await acceptAt(5, plan(), "import statistics\nprint(statistics.mean(nums))\n");

    expect(of("marker").map((m) => m.text)).toEqual(["… plan step 2", "… plan step 2 +1 import"]);
    expect(ghost).toBe("print(statistics.mean(nums))");
    expect(after.text).toContain("# END PLAN\nimport sys\nimport statistics\n\nnums");
    expect(after.text).toContain("nums = [int(a) for a in sys.argv[1:]]\nprint(statistics.mean(nums))\n\n");
    expect(after.cursor).toEqual({ line: 10, character: 0 });
  });

  it("does not add an import the file already has", async () => {
    const { of, after } = await acceptAt(5, plan(), "import sys\nprint(len(sys.argv))\n");

    expect(of("marker").map((m) => m.text)).toEqual(["… plan step 2"]);
    expect(after.text.match(/import sys/g)).toHaveLength(1);
  });

  it("adds a Go import to the file's import group", async () => {
    const document = goDoc(
      'package main\n\n// PLAN\n// [ ] shout the name\n// END PLAN\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tname := "x"\n\t|\n}\n',
    );
    const { after } = await acceptAt(5, document, 'import "strings"\nfmt.Println(strings.ToUpper(name))\n');

    expect(after.text).toContain('import (\n\t"fmt"\n\t"strings"\n)');
    expect(after.text).toContain('// [x] shout the name');
    expect(after.text).toContain('\tname := "x"\n\tfmt.Println(strings.ToUpper(name))\n\t\n}');
  });

  it("leaves a rejected step unchecked, so the next press retries it", async () => {
    const { session, model, of } = setup({ level: 5 });
    model.reply({ text: "print(sum(nums))\n" }).reply({ text: "print(sum(nums, 0))\n" });

    await session.dispatch({ type: "go", doc: plan() });
    await session.dispatch({ type: "rejected" });
    await session.dispatch({ type: "go", doc: plan() });

    expect(model.requests.map((r) => r.body.messages[0].content)).toEqual([
      expect.stringContaining('step 2 only: "print their sum"'),
      expect.stringContaining('step 2 only: "print their sum"'),
    ]);
    expect(editsOf(of("edit"))).toEqual([]);
  });

  it("picks up edits to the plan on the next press", async () => {
    const { session, model } = setup({ level: 5 });
    model.reply({ text: "x\n" }).reply({ text: "y\n" });
    const edited = (d: DocumentSnapshot) => ({ ...d, text: d.text.replace("# [ ] print their sum", "# [ ] print their sum, labelled") });

    await session.dispatch({ type: "go", doc: plan() });
    await session.dispatch({ type: "rejected" });
    await session.dispatch({ type: "go", doc: edited(plan()) });

    expect(sentSystem(model)).toContain('"print their sum, labelled"');
  });

  it.each([
    ["longer than 40 lines", Array.from({ length: 41 }, (_, k) => `print(${k})\n`).join("")],
    ["code that doesn't parse", "print(sum(nums)\nprint(1)\n"],
  ])("shows ! step too big for %s, and logs it as an error", async (_, reply) => {
    const { session, of } = await suggest(5, plan(), reply);
    await session.dispatch({ type: "accepted" });

    expect(of("ghost")).toEqual([]);
    expect(of("marker").at(-1)).toEqual(expect.objectContaining({ text: "! step too big, split it in the plan", ttlMs: 3000 }));
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ outcome: "error", reason: "step_too_big", plan_step: 2 }),
    ]);
  });

  it("stops the stream once a step is past 40 lines", async () => {
    const { model } = await suggest(5, plan(), ...Array.from({ length: 60 }, (_, k) => `print(${k})\n`));

    expect(model.requests[0].aborted).toBe(true);
  });

  it.each([
    ["no plan", doc("def f(x):\n    |\n"), "… body:1 · no plan, using level 4", 4],
    ["no plan and no TODO", doc("x = 1\n|\n"), "… · no plan, no TODO here, using level 3", 3],
    ["every step done", doc("# PLAN\n# [x] a\n# END PLAN\ndef f():\n    |\n"), "… body:4 · plan done, using level 4", 4],
    ["a PLAN comment without steps", doc("# PLAN: tidy up later\ndef f():\n    |\n"), "… body:2 · no plan, using level 4", 4],
  ] as const)("falls back with %s, and says so", async (_, document, marker, level) => {
    const { session, model, of } = await suggest(5, document, "return 1\n");
    await session.dispatch({ type: "rejected" });

    expect(of("marker")[0].text).toBe(marker);
    expect(model.requests[0].body.model).toBe(`model-for-level-${level}`);
    expect(of("log").map((l) => l.entry)).toEqual([expect.objectContaining({ level })]);
    expect(of("log")[0].entry).not.toHaveProperty("plan_step");
  });

  it("finishes a 4-step plan in 4 presses and 4 Tabs, with every step marked [x]", async () => {
    const { session, model, effects, of } = setup({ level: 5 });
    const steps = ["import sys\nnums = [int(a) for a in sys.argv[1:]]\n", "total = sum(nums)\n", "mean = total / len(nums)\n", "print(total, mean)\n"];
    for (const text of steps) model.reply({ text });
    let file = doc("# PLAN\n# [ ] read the numbers\n# [ ] sum them\n# [ ] average them\n# [ ] print both\n# END PLAN\n\n|\n");

    for (let press = 0; press < 4; press++) {
      await session.dispatch({ type: "go", doc: file });
      await session.dispatch({ type: "accepted" });
      file = afterAccept(file, of("ghost").at(-1)!.text, editsOf(effects).at(-1));
    }

    expect(model.requests.map((r) => r.body.messages[0].content.match(/step (\d) only/)?.[1])).toEqual(["1", "2", "3", "4"]);
    expect(file.text).toBe(
      [
        "# PLAN",
        "# [x] read the numbers",
        "# [x] sum them",
        "# [x] average them",
        "# [x] print both",
        "# END PLAN",
        "import sys",
        "",
        "nums = [int(a) for a in sys.argv[1:]]",
        "total = sum(nums)",
        "mean = total / len(nums)",
        "print(total, mean)",
        "",
        "",
      ].join("\n"),
    );
    expect(of("log").map((l) => [l.entry.plan_step, l.entry.outcome])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
    ]);
  });
});
