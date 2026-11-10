import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelError, type ChatRequest } from "./core/types";
import { OpenRouterClient } from "./openrouter";

const KEY = "sk-or-v1-secret";
const request: ChatRequest = {
  model: "deepseek/deepseek-v4.1-flash",
  messages: [{ role: "user", content: "print(" }],
  reasoning: { effort: "none" },
  provider: { sort: "latency" },
  max_tokens: 128,
};

function respond(body: string, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

/** Reads the whole stream and returns the error it throws. */
async function errorOf(): Promise<ModelError> {
  const client = new OpenRouterClient(async () => KEY);
  try {
    for await (const _ of client.stream(request, new AbortController().signal)) {
      // Read on to the error.
    }
  } catch (err) {
    if (err instanceof ModelError) return err;
    throw err;
  }
  throw new Error("no error thrown");
}

afterEach(() => vi.unstubAllGlobals());

describe("an OpenRouter error", () => {
  it("over HTTP keeps the status, error.message and the provider", async () => {
    respond(
      JSON.stringify({
        error: { code: 429, message: "Provider returned error", metadata: { provider_name: "DeepInfra", raw: "{}" } },
      }),
      429,
    );

    const err = await errorOf();

    expect(err).toMatchObject({ kind: "rate_limit", status: 429, message: "Provider returned error", provider: "DeepInfra" });
  });

  it("with a body that isn't JSON keeps the raw body as its message", async () => {
    respond("<html>Bad gateway</html>", 502);

    const err = await errorOf();

    expect(err).toMatchObject({ kind: "http", status: 502, message: "<html>Bad gateway</html>", provider: undefined });
  });

  it("inside the stream takes its status from error.code", async () => {
    respond(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`,
        `data: ${JSON.stringify({
          error: { code: 429, message: "Rate limit exceeded upstream", metadata: { provider_name: "Chutes" } },
          choices: [{ delta: { content: "" }, finish_reason: "error" }],
        })}`,
        "",
      ].join("\n"),
    );

    const err = await errorOf();

    expect(err).toMatchObject({ kind: "rate_limit", status: 429, message: "Rate limit exceeded upstream", provider: "Chutes" });
  });

  it("inside the stream without a numeric code has no status", async () => {
    respond(`data: ${JSON.stringify({ error: { code: "server_error", message: "Internal error" } })}\n`);

    const err = await errorOf();

    expect(err).toMatchObject({ kind: "http", status: undefined, message: "Internal error" });
  });

  it("never carries the key in its message", async () => {
    respond(JSON.stringify({ error: { message: `Invalid key ${KEY}` } }), 401);

    const err = await errorOf();

    expect(err).toMatchObject({ kind: "bad_key", status: 401, message: "Invalid key <key>" });
  });
});
