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
    if (!res.ok || !res.body) throw errorFromResponse(res.status, await res.text());

    try {
      yield* parseSse(res.body);
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ModelError) throw err;
      throw new ModelError("network", String(err));
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
      if (chunk.error) throw errorFromResponse(Number(chunk.error.code) || 500, JSON.stringify(chunk));
      yield { provider: chunk.provider, text: chunk.choices?.[0]?.delta?.content ?? undefined };
    }
  }
}

function errorFromResponse(status: number, body: string): ModelError {
  let message = body;
  try {
    message = JSON.parse(body).error?.message ?? body;
  } catch {
    // Not JSON; keep the raw body.
  }
  if (status === 401 || status === 403) return new ModelError("bad_key", message, status);
  if (status === 429) return new ModelError("rate_limit", message, status);
  if (status === 400) return new ModelError("bad_request", message, status);
  return new ModelError("http", message, status);
}
