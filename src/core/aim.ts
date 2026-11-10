// What a go-press at levels 4–5 fills, and the level it falls back to when there is nothing.
import type { OnAccept } from "./accept";
import type { Markers, PlanStep } from "./markers";
import type { Task } from "./prompt";
import { emptyBodyAt, todoAt, type Span } from "./targets";
import type { DocumentSnapshot, Level } from "./types";

export interface Aim {
  /** The level the press runs at, after any fallback. */
  level: Level;
  task?: Task;
  /** What the in-flight marker names, e.g. `TODO:12` or `plan step 3`. */
  source?: string;
  /** Why the press runs at a lower level than the dial's, e.g. `no TODO here, using level 3`. */
  fallback?: string;
  step?: PlanStep;
  onAccept?: OnAccept;
}

/** Level 5 writes at the cursor, which must be on an empty line. */
export interface NotOnEmptyLine {
  step: PlanStep;
}

/**
 * Level 5 writes the plan's first unchecked step; without one it falls back to level 4. Level 4
 * fills the `TODO:` or empty body at the cursor; without one it falls back to level 3.
 */
export function aimAt(
  doc: DocumentSnapshot,
  level: Level,
  markers: Markers,
  { keepTodo }: { keepTodo: boolean },
): Aim | NotOnEmptyLine {
  const missing: string[] = [];
  const fallback = (to: Level) => (missing.length > 0 ? `${missing.join(", ")}, using level ${to}` : undefined);
  if (level === 5) {
    const step = markers.plan?.find((s) => !s.done);
    if (step) {
      if (doc.text.split("\n")[doc.cursor.line].trim() !== "") return { step };
      return {
        level,
        step,
        task: { kind: "step", number: step.number, text: step.text },
        source: `plan step ${step.number}`,
        onAccept: { remove: [], tick: step.box, newLine: true },
      };
    }
    missing.push(markers.plan ? "plan done" : "no plan");
    level = 4;
  }
  if (level === 4) {
    const todo = todoAt(markers.todos, doc);
    const body = emptyBodyAt(doc);
    const remove: Span[] = [];
    if (todo?.span && !keepTodo) remove.push(todo.span);
    if (body?.placeholder) remove.push(body.placeholder);
    if (todo) {
      return {
        level,
        task: { kind: "todo", line: todo.line, text: todo.text },
        source: `TODO:${todo.line + 1}`,
        fallback: fallback(4),
        onAccept: { remove },
      };
    }
    if (body) {
      return {
        level,
        task: { kind: "body", line: body.line },
        source: `body:${body.line + 1}`,
        fallback: fallback(4),
        onAccept: { remove },
      };
    }
    missing.push("no TODO here");
    level = 3;
  }
  return { level, fallback: fallback(level) };
}
