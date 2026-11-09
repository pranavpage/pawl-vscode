// PROTOTYPE — throwaway. Real-load probe against OpenRouter, same request shape as src/core/session.ts.
// Usage: node --env-file=.env prototypes/rate-limits/probe.mjs
import { readFileSync } from "node:fs";

const KEY = process.env.OPENROUTER_API_KEY;
const URL = "https://openrouter.ai/api/v1/chat/completions";
const L1 = "deepseek/deepseek-v4.1-flash", L3 = "z-ai/glm-5.3", L5 = "moonshotai/kimi-k3.1-pro";

function file(paths) {
  const text = paths.map((p) => readFileSync(p, "utf8")).join("\n");
  const cut = text.indexOf("const model = deps.modelForLevel");
  const at = cut > 0 ? cut + "const model = ".length : Math.floor(text.length / 2);
  return { chars: text.length, body: `File: src/core/session.ts (typescript)\n\n${text.slice(0, at)}<CURSOR>${text.slice(at)}` };
}
const SYSTEM = "You are a code completion engine inside an editor. The user's file is given with the cursor marked <CURSOR>. Reply with only the text to insert at <CURSOR>: no explanation, no markdown fences, and never repeat text that is already before or after the cursor. Complete only the rest of the current line, then stop.";
const SMALL = file(["src/core/session.ts"]);
const BIG = file(["src/core/session.ts", "src/core/session.test.ts", "src/extension.ts", "src/core/types.ts", "src/core/markers.ts", "src/openrouter.ts", "package-lock.json"].slice(0, 7));

async function press(model, ctx, { signal } = {}) {
  const t0 = performance.now();
  const r = { model, ctxChars: ctx.chars };
  try {
    const res = await fetch(URL, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "Pawl probe" },
      body: JSON.stringify({ model, stream: true, max_tokens: 128, provider: { sort: "latency" }, reasoning: { effort: "none" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: ctx.body }] }),
    });
    r.status = res.status;
    r.headers = Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry/i.test(k)));
    if (!res.ok) { r.err = (await res.text()).slice(0, 160); r.ms = Math.round(performance.now() - t0); return r; }
    const dec = new TextDecoder(); let buf = "", out = "";
    for await (const b of res.body) {
      buf += dec.decode(b, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim(); if (d === "[DONE]") break;
        const c = JSON.parse(d);
        if (c.error) { r.err = JSON.stringify(c.error).slice(0, 160); r.status = c.error.code; }
        r.provider ??= c.provider;
        const t = c.choices?.[0]?.delta?.content;
        if (t) { r.ttft ??= Math.round(performance.now() - t0); out += t; }
        if (out.includes("\n")) { r.ms = Math.round(performance.now() - t0); r.out = out.split("\n")[0]; res.body.cancel?.().catch(() => {}); return r; }
      }
    }
    r.ms = Math.round(performance.now() - t0); r.out = out;
  } catch (e) { r.status = signal?.aborted ? "aborted" : "neterr"; r.ms = Math.round(performance.now() - t0); }
  return r;
}

const show = (label, rs) => {
  const ok = rs.filter((r) => r.status === 200), lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const codes = {}; rs.forEach((r) => (codes[r.status] = (codes[r.status] ?? 0) + 1));
  const prov = {}; ok.forEach((r) => (prov[r.provider] = (prov[r.provider] ?? 0) + 1));
  console.log(`\n## ${label}\n  status: ${JSON.stringify(codes)}  providers: ${JSON.stringify(prov)}`);
  if (lat.length) console.log(`  latency to line end ms: p50 ${q(0.5)}  p90 ${q(0.9)}  max ${lat.at(-1)}`);
  const errs = rs.filter((r) => r.err).slice(0, 3); errs.forEach((r) => console.log(`  err ${r.status}: ${r.err}`));
  const hdr = rs.find((r) => r.headers && Object.keys(r.headers).length); if (hdr) console.log(`  rate headers: ${JSON.stringify(hdr.headers)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = process.argv[2] ?? "all";
console.log(`context: small ${SMALL.chars} chars (~${Math.round(SMALL.chars / 3.5)} tok), big ${BIG.chars} chars (~${Math.round(BIG.chars / 3.5)} tok)`);

if (step === "all" || step === "seq") {
  const rs = []; for (let i = 0; i < 8; i++) { rs.push(await press(L1, SMALL)); await sleep(1500); }
  show("A. human pace, level 1, 8 presses 1.5 s apart", rs);
  console.log(`  sample: ${JSON.stringify(rs.find((r) => r.out)?.out)}`);
}
if (step === "all" || step === "burst") {
  show("B. burst: 25 concurrent level-1 presses", await Promise.all(Array.from({ length: 25 }, () => press(L1, SMALL))));
}
if (step === "all" || step === "repeat") {
  // Held go key: OS key repeat ~30 Hz for 2 s. The real design aborts the previous press each time.
  let prev; const rs = [];
  for (let i = 0; i < 60; i++) {
    prev?.abort(); const ac = new AbortController(); prev = ac;
    rs.push(press(L1, SMALL, { signal: ac.signal })); await sleep(33);
  }
  show("C. held go key, 60 presses at 30 Hz, each aborts the previous", await Promise.all(rs));
}
if (step === "all" || step === "big") {
  const rs = []; for (let i = 0; i < 3; i++) rs.push(await press(L1, BIG));
  show(`D. big file at level 1 (~${Math.round(BIG.chars / 3.5)} tok, whole file sent)`, rs);
}
if (step === "all" || step === "levels") {
  const g = [], k = []; for (let i = 0; i < 3; i++) { g.push(await press(L3, SMALL)); k.push(await press(L5, SMALL)); }
  show("E. level 3 model (GLM 5.3), 3 presses", g); show("F. level 5 model (Kimi K3.1 Pro), 3 presses", k);
}

async function pressWith(extra, model, ctx) {
  const t0 = performance.now();
  const res = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, max_tokens: 128, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: ctx.body }], ...extra }) });
  const hdr = Math.round(performance.now() - t0);
  let out = "", provider, ttft, finish, usage; const dec = new TextDecoder(); let buf = "";
  for await (const b of res.body) { buf += dec.decode(b, { stream: true }); let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l.startsWith("data:") || l.includes("[DONE]")) continue; const c = JSON.parse(l.slice(5));
      provider ??= c.provider; const t = c.choices?.[0]?.delta?.content; if (t) { ttft ??= Math.round(performance.now() - t0); out += t; }
      finish = c.choices?.[0]?.finish_reason ?? finish; usage = c.usage ?? usage; } }
  return { status: res.status, hdr, ttft, ms: Math.round(performance.now() - t0), provider, out: out.split("\n")[0].slice(0, 60), finish, ctok: usage?.completion_tokens, rtok: usage?.completion_tokens_details?.reasoning_tokens };
}
if (step === "knee") {
  for (const n of [1, 3, 6, 12]) {
    const rs = await Promise.all(Array.from({ length: n }, () => press(L1, SMALL)));
    show(`knee: ${n} concurrent, sort latency`, rs); await sleep(2000);
  }
  const rs = await Promise.all(Array.from({ length: 12 }, () => press(L1, SMALL).then(r=>r)));
  const alt = await Promise.all(Array.from({ length: 12 }, () => pressWith({ provider: { sort: "throughput" }, reasoning: { effort: "none" } }, L1, SMALL)));
  console.log("\n## 12 concurrent, sort throughput:", JSON.stringify(alt.map((r) => [r.status, r.ms, r.provider])));
}
if (step === "glm") {
  for (let i = 0; i < 3; i++) console.log("GLM exclude:", JSON.stringify(await pressWith({ provider: { sort: "latency" }, reasoning: { exclude: true } }, L3, SMALL)));
  for (let i = 0; i < 2; i++) console.log("GLM effort low:", JSON.stringify(await pressWith({ provider: { sort: "latency" }, reasoning: { effort: "low", exclude: true } }, L3, SMALL)));
  console.log("GLM exclude max_tokens 1024:", JSON.stringify(await pressWith({ provider: { sort: "latency" }, reasoning: { exclude: true }, max_tokens: 1024 }, L3, SMALL)));
}
