// Post-processing of model output: strip markdown fences, cut at the stop point.

const LEADING_FENCE = /^\s*```[^\n]*\n/;
const TRAILING_FENCE = /\n?```\s*$/;

/**
 * Removes a leading fence line. Returns undefined while the text could still
 * turn out to be the start of a fence line, so streaming can wait for more.
 */
function stripLeadingFence(raw: string): string | undefined {
  const fence = LEADING_FENCE.exec(raw);
  if (fence) return raw.slice(fence[0].length);
  const trimmed = raw.trimStart();
  if (trimmed.length > 0 && "```".startsWith(trimmed.slice(0, 3)) && !trimmed.includes("\n")) {
    return undefined;
  }
  return raw;
}

/**
 * Level 1 stop rule: the suggestion ends at the end of the current line.
 * Returns the cut suggestion once the stop point has streamed in, else undefined.
 */
export function cutAtStopPoint(raw: string): string | undefined {
  const body = stripLeadingFence(raw);
  if (body === undefined) return undefined;
  const eol = body.indexOf("\n");
  return eol < 0 ? undefined : body.slice(0, eol);
}

/** Final cut once the stream has ended without reaching a stop point. */
export function finish(raw: string): string {
  return cutAtStopPoint(raw) ?? (stripLeadingFence(raw) ?? "").replace(TRAILING_FENCE, "");
}
