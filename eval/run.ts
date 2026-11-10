// Real-model eval, outside CI: presses each level's fixtures through the session core against
// OpenRouter and reports overruns, latency, providers and outcomes. See the README.
//
//   OPENROUTER_API_KEY=... npm run eval -- [--presses 20] [--levels 1,2,3,4,5]
//                                          [--model 5=z-ai/glm-5.3] [--timeout 4s|8s] [--out results.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { systemClock } from "../src/core/time";
import type { Level } from "../src/core/types";
import { OpenRouterClient } from "../src/openrouter";
import { loadFixtures, runEval, summarize, type LevelSummary, type PressResult } from "./harness";

const ROOT = join(__dirname, "..", "..");

const USAGE = `Usage: OPENROUTER_API_KEY=... npm run eval -- [options]

  --presses N         presses per level, shared between its Python and Go fixtures (default 20)
  --levels 1,2,...    levels to run (default 1,2,3,4,5)
  --model L=ID        OpenRouter model for level L instead of Pawl's default; repeatable
  --timeout 4s|8s     the deadline for each press, as the pawl.timeout setting (default 8s)
  --out FILE          also write every press, suggestions included, as JSON`;

/** Pawl's default model for each level, from the extension's settings. */
function defaultModels(): Record<number, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const settings = pkg.contributes.configuration.properties;
  return Object.fromEntries([1, 2, 3, 4, 5].map((level) => [level, settings[`pawl.models.level${level}`].default]));
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parse() {
  const { values } = parseArgs({
    options: {
      presses: { type: "string", default: "20" },
      levels: { type: "string", default: "1,2,3,4,5" },
      model: { type: "string", multiple: true, default: [] },
      timeout: { type: "string", default: "8s" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const presses = Number(values.presses);
  if (!Number.isInteger(presses) || presses < 1) fail(`--presses must be a whole number above 0, not ${values.presses}`);
  const levels = values.levels.split(",").map(Number);
  if (levels.some((l) => !Number.isInteger(l) || l < 1 || l > 5)) fail(`--levels takes levels 1–5, not ${values.levels}`);
  if (values.timeout !== "4s" && values.timeout !== "8s") fail(`--timeout is 4s or 8s, not ${values.timeout}`);
  const models = defaultModels();
  for (const pair of values.model) {
    const match = /^([1-5])=(.+)$/.exec(pair);
    if (!match) fail(`--model takes LEVEL=MODEL_ID, e.g. 5=z-ai/glm-5.3, not ${pair}`);
    models[Number(match[1])] = match[2];
  }
  return { presses, levels: levels as Level[], models, timeoutMs: values.timeout === "4s" ? 4000 : 8000, out: values.out };
}

const ms = (n?: number) => (n === undefined ? "-" : `${n} ms`);
const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ") || "none";

function pressLine(p: PressResult): string {
  const what = p.outcome === "error" ? `error ${p.reason}` : p.outcome;
  const flags = [p.overran && "OVERRUN", p.cut && "cut", p.ranAt !== p.level && `ran at level ${p.ranAt}`].filter(Boolean);
  return `  L${p.level} ${p.fixture.padEnd(6)} ${what.padEnd(20)} ${ms(p.latencyMs).padStart(8)}  ${p.provider ?? "-"}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

function summaryLines(s: LevelSummary): string[] {
  const { shown, empty, question, step_too_big, errors } = s.outcomes;
  return [
    `Level ${s.level} · ${s.models.join(", ")} · ${s.presses} presses`,
    `  overruns past the stop point: ${s.overruns}`,
    `  latency: p50 ${ms(s.p50)} · p90 ${ms(s.p90)}`,
    `  providers: ${counts(s.providers)}`,
    `  outcomes: shown ${shown} · empty ${empty} · question ${question} · step_too_big ${step_too_big} · errors: ${counts(errors)}`,
    `  cut by Pawl at the stop point: ${s.cut} · fell back to a lower level: ${s.fellBack}`,
  ];
}

async function main(): Promise<void> {
  const options = parse();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) fail("Set OPENROUTER_API_KEY in the environment.");
  /** Everything printed or written goes through here, so the key can't leak even if a reply echoes it. */
  const redact = (text: string) => text.split(key).join("[OPENROUTER_API_KEY]");
  const print = (text: string) => console.log(redact(text));

  const fixtures = (await loadFixtures(join(ROOT, "eval", "fixtures"))).filter((f) => options.levels.includes(f.level));
  print(`Pressing levels ${options.levels.join(", ")}, ${options.presses} times each, deadline ${ms(options.timeoutMs)}.`);
  for (const level of options.levels) print(`  level ${level}: ${options.models[level]}`);
  print("");

  const results = await runEval({
    model: new OpenRouterClient(() => Promise.resolve(key)),
    clock: systemClock,
    modelForLevel: (level) => options.models[level],
    fixtures,
    presses: options.presses,
    timeoutMs: options.timeoutMs,
    onPress: (p) => print(pressLine(p)),
  });
  const summaries = summarize(results);
  print("");
  for (const s of summaries) print(summaryLines(s).join("\n") + "\n");

  if (options.out) {
    writeFileSync(options.out, redact(JSON.stringify({ models: options.models, summaries, presses: results }, null, 2)) + "\n");
    print(`Wrote every press to ${options.out}.`);
  }
  const overruns = summaries.reduce((n, s) => n + s.overruns, 0);
  if (overruns > 0) {
    print(`${overruns} suggestion(s) went past the stop point.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const key = process.env.OPENROUTER_API_KEY;
  const message = String(err?.stack ?? err);
  console.error(key ? message.split(key).join("[OPENROUTER_API_KEY]") : message);
  process.exit(1);
});
