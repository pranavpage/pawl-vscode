import { ModelError, type ChatRequest, type ModelClient, type StreamChunk } from "./core/types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Streams chat completions straight from OpenRouter. The key is read per request and never stored here. */
export class OpenRouterClient implements ModelClient {
  constructor(
    private getKey: () => Promise<string | undefined>,
    private getBaseUrl: () => string | undefined = () => undefined,
  ) {}

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const key = await this.getKey();
    if (!key) throw new ModelError("bad_key", "No OpenRouter key set");

    try {
      let res: Response;
      try {
        res = await fetch(`${this.getBaseUrl() ?? DEFAULT_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/pranavpage/pawl-vscode",
            "X-Title": "Pawl",
          },
          body: JSON.stringify({ ...request, stream: true }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        throw new ModelError("network", String(err));
      }
      if (!res.ok || !res.body) throw errorFromBody(res.status, await res.text());

      try {
        yield* parseSse(res.body);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ModelError) throw err;
        throw new ModelError("network", String(err));
      }
    } catch (err) {
      // The error's message goes to the log, so it must never carry the key.
      if (err instanceof ModelError && err.message.includes(key)) {
        throw new ModelError(err.kind, err.message.replaceAll(key, "<key>"), err.status, err.provider);
      }
      throw err;
    }
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let eol: number;
    while ((eol = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, eol).trim();
      buffer = buffer.slice(eol + 1);
      // Lines starting with ":" are keep-alive comments.
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const chunk = JSON.parse(data);
      // An error after the stream started comes as a chunk, with its status in `error.code`.
      if (chunk.error) throw errorFrom(Number(chunk.error.code) || undefined, chunk.error, data);
      yield { provider: chunk.provider, text: chunk.choices?.[0]?.delta?.content ?? undefined };
    }
  }
}

/** OpenRouter's `{ error: { message, metadata } }` body, or the raw body if it isn't JSON. */
function errorFromBody(status: number, body: string): ModelError {
  let error: unknown;
  try {
    error = JSON.parse(body).error;
  } catch {
    // Not JSON; the raw body is the message.
  }
  return errorFrom(status, error, body);
}

function errorFrom(status: number | undefined, error: unknown, raw: string): ModelError {
  const { message, metadata } = (error ?? {}) as { message?: unknown; metadata?: { provider_name?: unknown } };
  const text = typeof message === "string" ? message : raw;
  const provider = typeof metadata?.provider_name === "string" ? metadata.provider_name : undefined;
  const kind =
    status === 401 || status === 403
      ? "bad_key"
      : status === 429
        ? "rate_limit"
        : status === 400
          ? "bad_request"
          : "http";
  return new ModelError(kind, text, status, provider);
}
