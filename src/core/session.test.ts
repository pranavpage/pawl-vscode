import { describe, expect, it } from "vitest";
import { createSession } from "./session";
import { doc, FakeClock, FakeModelClient } from "./testing/fakes";
import { ModelError, type Effect, type Level } from "./types";

function setup({ hasKey = true, level }: { hasKey?: boolean; level?: Level } = {}) {
  const clock = new FakeClock();
  const model = new FakeModelClient(clock);
  const effects: Effect[] = [];
  const session = createSession({
    model,
    clock,
    modelForLevel: (level) => (level <= 2 ? "deepseek/deepseek-v4.1-flash" : `model-for-level-${level}`),
    level,
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

describe("levels 2–5", () => {
  it("send each press to the level's model and, until their own stop rules land, finish only the line", async () => {
    const { session, model, of } = setup();
    model.reply({ text: "x)\nreturn x\n" });
    await session.dispatch({ type: "setLevel", level: 4 });

    await session.dispatch({ type: "go", doc: doc("print(|") });
    await session.dispatch({ type: "accepted" });

    expect(model.requests[0].body.model).toBe("model-for-level-4");
    expect(of("ghost").map((g) => g.text)).toEqual(["x)"]);
    expect(of("log").map((l) => l.entry)).toEqual([
      expect.objectContaining({ level: 4, model: "model-for-level-4", outcome: "accepted" }),
    ]);
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
