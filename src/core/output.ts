// Post-processing of model output: strip markdown fences, cut at the stop point.
import type { StopRule } from "./stops";

const LEADING_FENCE = /^\s*```[^\n]*\n/;
/** A closing fence ends the reply, whatever comes after it. */
const FENCE = "```";

/**
 * Removes a leading fence line. Returns undefined while the text could still
 * turn out to be the start of a fence line, so streaming can wait for more.
 */
function stripLeadingFence(raw: string): string | undefined {
  const fence = LEADING_FENCE.exec(raw);
  if (fence) return raw.slice(fence[0].length);
  const trimmed = raw.trimStart();
  if (trimmed.length > 0 && FENCE.startsWith(trimmed.slice(0, 3)) && !trimmed.includes("\n")) {
    return undefined;
  }
  return raw;
}

export interface Cutter {
  /** The suggestion once its stop point has streamed in, else undefined. */
  cut(raw: string): string | undefined;
  /** The suggestion once the stream has ended without reaching a stop point. */
  end(raw: string): string;
}

export function createCutter(stop: StopRule): Cutter {
  return {
    cut(raw) {
      const body = stripLeadingFence(raw);
      if (body === undefined) return undefined;
      const fence = body.indexOf(FENCE);
      return fence < 0 ? stop(body, false) : stop(body.slice(0, fence), true);
    },
    end(raw) {
      const body = stripLeadingFence(raw) ?? "";
      const fence = body.indexOf(FENCE);
      return stop(fence < 0 ? body : body.slice(0, fence), true) ?? "";
    },
  };
}
