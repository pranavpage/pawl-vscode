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

/** A cut reply: code to suggest, or at levels 3–5 a one-line question for the user. */
export type Cut = { suggestion: string; question?: undefined } | { question: string };

export interface Cutter {
  /** The cut reply once its stop point has streamed in, else undefined. */
  cut(raw: string): Cut | undefined;
  /** The cut reply once the stream has ended without reaching a stop point. */
  end(raw: string): Cut;
}

/** A line that asks the user a question instead of writing code. */
const QUESTION = /^[ \t]*Q:/m;

/**
 * The reply without its fences, up to a closing fence or a `Q:` line, which ends it.
 * `ended` says whether one did. Undefined while it may still turn out to start with a fence.
 */
export function replyBody(raw: string): { body: string; ended: boolean } | undefined {
  const body = stripLeadingFence(raw);
  if (body === undefined) return undefined;
  const fence = body.indexOf(FENCE);
  const question = body.search(QUESTION);
  const ends = [fence, question].filter((i) => i >= 0);
  if (ends.length === 0) return { body, ended: false };
  // A question anywhere but at the start is cut off, newline and all, so Tab never inserts it.
  return { body: body.slice(0, Math.min(...ends)).replace(/\n[ \t]*$/, ""), ended: true };
}

/**
 * `questions` allows a `Q:` reply, at levels 3–5. Elsewhere a reply that is only a question
 * counts as empty.
 */
export function createCutter(stop: StopRule, { questions }: { questions: boolean }): Cutter {
  /** A reply that starts with `Q:` is a question; undefined while that is still unknown. */
  const asks = (raw: string, done: boolean): Cut | undefined | false => {
    const start = (stripLeadingFence(raw) ?? "").trimStart();
    if (!start.startsWith("Q:")) return !done && start.length < 2 && "Q:".startsWith(start) && start !== "" ? undefined : false;
    const eol = start.indexOf("\n");
    if (eol < 0 && !done) return undefined;
    const question = (eol < 0 ? start : start.slice(0, eol)).replace(/\s*`{3}.*$/, "").trim();
    return questions ? { question } : { suggestion: "" };
  };
  return {
    cut(raw) {
      const asked = asks(raw, false);
      if (asked !== false) return asked;
      const reply = replyBody(raw);
      if (reply === undefined) return undefined;
      const suggestion = stop(reply.body, reply.ended);
      return suggestion === undefined ? undefined : { suggestion };
    },
    end(raw) {
      const asked = asks(raw, true);
      if (asked) return asked;
      return { suggestion: stop(replyBody(raw)?.body ?? "", true) ?? "" };
    },
  };
}
