import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doc, FakeClock, FakeModelClient } from "../src/core/testing/fakes";
import type { Level } from "../src/core/types";
import { loadFixtures, overruns, runEval, summarize, type Fixture, type PressResult } from "./harness";

function setup() {
  const clock = new FakeClock();
  const model = new FakeModelClient(clock);
  const run = (fixtures: Fixture[], presses: number) =>
    runEval({ model, clock, modelForLevel: (level: Level) => `model-${level}`, fixtures, presses, timeoutMs: 8000 });
  return { model, run };
}

const py = (level: Level, source: string): Fixture => ({ name: `l${level}.py`, level, doc: doc(source) });

describe("runEval", () => {
  it("presses a level-1 fixture through the core and records what the model's reply became", async () => {
    const { model, run } = setup();
    model.reply({ provider: "DeepInfra" }, { text: "x)\nreturn x\n", afterMs: 640 });

    const [press] = await run([py(1, "def f(x):\n    print(|")], 1);

    expect(press).toEqual(
      expect.objectContaining({
        fixture: "l1.py",
        level: 1,
        model: "model-1",
        provider: "DeepInfra",
        latencyMs: 640,
        outcome: "shown",
        suggestion: "x)",
        reply: "x)\nreturn x\n",
        overran: false,
        cut: true,
      }),
    );
  });
});

describe("runEval outcomes", () => {
  const go = (level: Level, source: string): Fixture => ({
    name: `l${level}.go`,
    level,
    doc: doc(source, { languageId: "go", path: "main.go", docId: "file:///work/main.go" }),
  });

  it("shares each level's presses between its Python and Go fixtures, levels in order", async () => {
    const { model, run } = setup();
    for (let i = 0; i < 4; i++) model.reply({ text: "x)" });

    const presses = await run([go(2, "package main\n\nfunc f() {\n\tprintln(|\n}\n"), py(1, "print(|"), py(2, "f(|")], 2);

    expect(presses.map((p) => `${p.level} ${p.fixture}`)).toEqual(["1 l1.py", "1 l1.py", "2 l2.go", "2 l2.py"]);
  });

  it("records a Q: reply as a question", async () => {
    const { model, run } = setup();
    model.reply({ text: "Q: sorted by what?\n" });

    const [press] = await run([py(3, "def f(xs):\n    |\n")], 1);

    expect(press).toEqual(expect.objectContaining({ outcome: "question", suggestion: "Q: sorted by what?", overran: false }));
  });

  it("records nothing to add once the retry is empty too", async () => {
    const { model, run } = setup();
    model.reply({ text: "" }).reply({ text: "\n" });

    const [press] = await run([py(3, "def f(xs):\n    |\n")], 1);

    expect(press).toEqual(expect.objectContaining({ outcome: "empty", attempts: 2 }));
  });

  it("records a level-5 step past the line cap as step_too_big", async () => {
    const { model, run } = setup();
    model.reply({ text: Array.from({ length: 45 }, (_, i) => `print(${i})`).join("\n") });

    const [press] = await run([py(5, "# PLAN\n# [ ] print a lot\n# END PLAN\n\n|\n")], 1);

    expect(press).toEqual(expect.objectContaining({ outcome: "step_too_big", ranAt: 5 }));
  });

  it("records a level-5 step that doesn't parse as an error with its own reason", async () => {
    const { model, run } = setup();
    model.reply({ text: "print(sum(nums)\nprint(1)\n" });

    const [press] = await run([py(5, "# PLAN\n# [ ] print the sum\n# END PLAN\n\n|\n")], 1);

    expect(press).toEqual(expect.objectContaining({ outcome: "error", reason: "step_does_not_parse", ranAt: 5 }));
  });

  it("records the level a press fell back to", async () => {
    const { model, run } = setup();
    model.reply({ text: "return 1" });

    const [press] = await run([py(5, "def f():\n    |\n")], 1);

    expect(press).toEqual(expect.objectContaining({ level: 5, ranAt: 4, model: "model-4", outcome: "shown" }));
  });
});

describe("overruns", () => {
  it("flags a suggestion that goes past the level's stop point, and passes one that stops there", async () => {
    const at = doc("def f(x):\n    y = |\n    return y\n");

    expect(await overruns(at, 1, "x + 1\n    z = 2")).toBe(true);
    expect(await overruns(at, 2, "x + 1\n    z = 2")).toBe(true);
    expect(await overruns(at, 2, "x + 1")).toBe(false);
    expect(await overruns(at, 3, "x + 1\n    z = 2")).toBe(false);
    expect(await overruns(at, 3, "x + 1\n\ndef g():\n    pass")).toBe(true);
 
  });

  it("checks the stop point on its own terms, not with Pawl's cutter", async () => {
    const inIf = doc("def f(x):\n    if x:\n        |\n    return y\n");
    const goBody = doc("package main\n\nfunc f() int {\n\t|\n}\n", { languageId: "go" });

    expect(await overruns(inIf, 3, "y = 1")).toBe(false);
    expect(await overruns(inIf, 3, "y = 1\n    z = 2")).toBe(true);
    expect(await overruns(goBody, 4, "x := 1\n\treturn x")).toBe(false);
    expect(await overruns(goBody, 4, "return 1\n}\n\nfunc g() {")).toBe(true);
    expect(await overruns(goBody, 2, "x := 1")).toBe(false);
    expect(await overruns(goBody, 2, "x := 1; y := 2")).toBe(true);
  });
});

describe("summarize", () => {
  const press = (over: Partial<PressResult>): PressResult => ({
    fixture: "l3.py",
    level: 3,
    ranAt: 3,
    model: "z-ai/glm-5.3",
    provider: "Z.AI",
    latencyMs: 1000,
    attempts: 1,
    outcome: "shown",
    reply: "",
    overran: false,
    cut: false,
    ...over,
  });

  it("gives each level its overruns, latency percentiles, providers and outcome counts", () => {
    const [summary] = summarize([
      press({ latencyMs: 400, cut: true }),
      press({ latencyMs: 100, provider: "Baseten" }),
      press({ latencyMs: 300, outcome: "empty", attempts: 2 }),
      press({ latencyMs: 200, outcome: "question" }),
      press({ latencyMs: 8000, outcome: "error", reason: "timeout", provider: undefined }),
      press({ latencyMs: 500, outcome: "shown", overran: true }),
    ]);

    expect(summary).toEqual({
      level: 3,
      models: ["z-ai/glm-5.3"],
      presses: 6,
      overruns: 1,
      cut: 1,
      fellBack: 0,
      p50: 300,
      p90: 500,
      providers: { "Z.AI": 4, Baseten: 1 },
      outcomes: { shown: 3, empty: 1, question: 1, step_too_big: 0, errors: { timeout: 1 } },
    });
  });

  it("counts step_too_big apart from other errors, with its latency, and counts fallbacks", () => {
    const [summary] = summarize([
      press({ level: 5, ranAt: 5, latencyMs: 2000, outcome: "step_too_big", model: "moonshotai/kimi-k3.1-pro" }),
      press({ level: 5, ranAt: 4, latencyMs: 1000, model: "z-ai/glm-5.3" }),
    ]);

    expect(summary).toEqual(
      expect.objectContaining({
        models: ["moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3"],
        fellBack: 1,
        p50: 1000,
        p90: 2000,
        outcomes: { shown: 1, empty: 0, question: 0, step_too_big: 1, errors: {} },
      }),
    );
  });
});

describe("the eval fixtures", () => {
  it("have a Python and a Go file for each level, each pressed at its own level without a fallback", async () => {
    const fixtures = await loadFixtures(join(__dirname, "fixtures"));
    const { model, run } = setup();
    for (const _ of fixtures) model.reply({ text: "x" });

    const presses = await run(fixtures, 2);

    expect(fixtures.map((f) => `${f.level} ${f.doc.languageId}`).sort()).toEqual(
      ["1 go", "1 python", "2 go", "2 python", "3 go", "3 python", "4 go", "4 python", "5 go", "5 python"],
    );
    expect(presses.filter((p) => p.ranAt !== p.level)).toEqual([]);
  });
});
