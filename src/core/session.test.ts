import { describe, expect, it } from "vitest";
import { createSession } from "./session";
import { doc, FakeClock, FakeModelClient } from "./testing/fakes";
import { ModelError, type Effect } from "./types";

function setup({ hasKey = true } = {}) {
  const clock = new FakeClock();
  const model = new FakeModelClient(clock);
  const effects: Effect[] = [];
  const session = createSession({
    model,
    clock,
    modelForLevel: () => "deepseek/deepseek-v4.1-flash",
    emit: (e) => effects.push(e),
  });
  void session.dispatch({ type: "keyChanged", hasKey });
  const of = <T extends Effect["type"]>(type: T) =>
    effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
  return { clock, model, effects, session, of };
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
        context_chars: 21,
        suggestion: "x)",
        latency_ms: 610,
        attempts: 1,
        outcome: "accepted",
      },
    ]);
    expect(of("clearGhost")).toHaveLength(1);
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
