// Imports a level-5 step brings: the model writes them first, and accepting the step moves
// them to the file's imports.

const PYTHON_IMPORT = /^(?:import\s+\S|from\s+\S+\s+import\s+\S)/;
const GO_IMPORT = /^import\s+(?:[\w.]+\s+)?"[^"]+"$/;
const OTHER_IMPORT = /^(?:import|#include|#import|using|use|require)\b/;

function findLast(lines: string[], test: (line: string) => boolean): number {
  for (let j = lines.length - 1; j >= 0; j--) if (test(lines[j])) return j;
  return -1;
}

const importPattern = (languageId: string) =>
  languageId === "python" ? PYTHON_IMPORT : languageId === "go" ? GO_IMPORT : OTHER_IMPORT;

/**
 * Splits the import lines a reply starts with from the code after them. While streaming, only
 * whole lines count. Go's `import ( … )` group comes out as one `import` line per path.
 */
export function splitImports(reply: string, languageId: string, done = true): { imports: string[]; code: string } {
  const lines = reply.split("\n");
  if (!done) lines.pop();
  const imports: string[] = [];
  let k = 0;
  for (; k < lines.length; k++) {
    const line = lines[k].trim();
    if (!line) continue;
    if (languageId === "go" && /^import\s*\($/.test(line)) {
      const close = lines.findIndex((l, j) => j > k && l.trim() === ")");
      if (close < 0) break;
      for (const spec of lines.slice(k + 1, close).map((l) => l.trim()).filter(Boolean)) imports.push(`import ${spec}`);
      k = close;
      continue;
    }
    if (!importPattern(languageId).test(line)) break;
    imports.push(line);
  }
  if (k >= lines.length && !done) return { imports, code: "" };
  return { imports, code: reply.split("\n").slice(k).join("\n") };
}

/** The imports the file doesn't have yet. */
export function newImports(imports: string[], text: string, languageId: string): string[] {
  const have = new Set(text.split("\n").map((line) => line.trim()));
  return [...new Set(imports)].filter((line) => {
    if (languageId !== "go") return !have.has(line);
    const path = /"[^"]+"/.exec(line)![0];
    return !text.split("\n").some((l) => l.includes(path) && /^\s*(?:import\s+)?(?:[\w.]+\s+)?"/.test(l));
  });
}

/** Where the imports go in the file, and the text that adds them there. */
export function importInsertion(text: string, languageId: string, imports: string[]): { offset: number; text: string } {
  const lines = text.split("\n");
  const offsetOfLine = (line: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  /** Inserts before `line`; at the end of the file, on a line of its own. */
  const before = (line: number, added: string) =>
    line < lines.length ? { offset: offsetOfLine(line), text: added } : { offset: text.length, text: `\n${added.replace(/\n$/, "")}` };

  if (languageId === "go") {
    const specs = imports.map((line) => line.replace(/^import\s+/, ""));
    const group = lines.findIndex((l) => /^import\s*\($/.test(l.trim()));
    const close = group < 0 ? -1 : lines.findIndex((l, j) => j > group && l.trim() === ")");
    if (close >= 0) return before(close, specs.map((spec) => `\t${spec}\n`).join(""));
    const single = findLast(lines, (l) => /^import\s/.test(l));
    if (single >= 0) return before(single + 1, imports.map((line) => `${line}\n`).join(""));
    const pkg = lines.findIndex((l) => /^package\s/.test(l));
    return before(pkg + 1, `\n${imports.join("\n")}\n`);
  }

  const pattern = importPattern(languageId);
  let last = findLast(lines, (l) => pattern.test(l));
  if (last >= 0) {
    // A parenthesised import runs to its `)`.
    if (lines[last].includes("(") && !lines[last].includes(")")) {
      while (last + 1 < lines.length && !lines[last].includes(")")) last++;
    }
    return before(last + 1, imports.map((line) => `${line}\n`).join(""));
  }
  // No imports yet: after the comments and the docstring the file starts with.
  let first = 0;
  while (first < lines.length && (!lines[first].trim() || /^\s*(?:#|\/\/)/.test(lines[first]))) first++;
  if (languageId === "python" && /^\s*(?:"""|''')/.test(lines[first] ?? "")) {
    const quote = lines[first].trim().slice(0, 3);
    const opened = lines[first].trim().slice(3);
    if (!opened.includes(quote)) while (first + 1 < lines.length && !lines[++first].includes(quote));
    first++;
  } else {
    while (first > 0 && !lines[first - 1].trim()) first--;
  }
  const blankAfter = lines[first] !== undefined && lines[first].trim() !== "";
  return before(first, `${imports.join("\n")}\n${blankAfter ? "\n" : ""}`);
}
