// The files levels 4–5 send along with the open one: what it imports from the workspace,
// and for Go its package's other files.
import { scanLines, syntaxFor } from "./lexer";
import type { DocumentSnapshot, WorkspaceFiles } from "./types";

export interface RelatedFile {
  path: string;
  text: string;
}

const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Joins path parts, resolving `.` and `..`. Undefined if the result would leave the workspace folder. */
function join(...parts: string[]): string | undefined {
  const out: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.pop() === undefined) return undefined;
  }
  return out.join("/");
}

/** Folder steps from one folder to another. */
function distance(from: string, to: string): number {
  const a = from ? from.split("/") : [];
  const b = to ? to.split("/") : [];
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length - common + (b.length - common);
}

/** Folder listings, read once per go-press. */
class Folders {
  private listed = new Map<string, Promise<Set<string>>>();

  constructor(readonly files: WorkspaceFiles) {}

  private names(dir: string): Promise<Set<string>> {
    let names = this.listed.get(dir);
    if (!names) {
      names = this.files.list(dir).then(
        (list) => new Set(list),
        () => new Set<string>(),
      );
      this.listed.set(dir, names);
    }
    return names;
  }

  async has(path: string): Promise<boolean> {
    return (await this.names(dirname(path))).has(basename(path));
  }

  async list(dir: string): Promise<string[]> {
    return [...(await this.names(dir))].map((name) => (dir ? `${dir}/${name}` : name));
  }

  /** The first of `paths` that exists. */
  async first(paths: (string | undefined)[]): Promise<string | undefined> {
    for (const path of paths) if (path !== undefined && (await this.has(path))) return path;
    return undefined;
  }
}

/** The workspace files the document imports, and for Go its package's other files, nearest first. */
export async function relatedFiles(doc: DocumentSnapshot, files: WorkspaceFiles): Promise<RelatedFile[]> {
  const folders = new Folders(files);
  const find = FINDERS[doc.languageId];
  if (!find) return [];
  const paths = [...new Set(await find(doc, folders))].filter((path) => path !== doc.path);
  const here = dirname(doc.path);
  // A stable sort keeps the import order among files at the same distance.
  paths.sort((a, b) => distance(here, dirname(a)) - distance(here, dirname(b)));
  const read = await Promise.all(
    paths.map(async (path) => ({ path, text: await files.read(path).catch(() => undefined) })),
  );
  return read.filter((file): file is RelatedFile => file.text !== undefined);
}

type Finder = (doc: DocumentSnapshot, folders: Folders) => Promise<string[]>;

const FINDERS: Record<string, Finder> = { python: pythonImports, go: goImports };

/** Each line with its comments left out. */
const codeLines = (doc: DocumentSnapshot) => scanLines(doc.text, syntaxFor(doc.languageId)).map((line) => line.code);

/** Relative imports, and imports that resolve from the file's folder or any folder above it. */
async function pythonImports(doc: DocumentSnapshot, folders: Folders): Promise<string[]> {
  const here = dirname(doc.path);
  const roots: string[] = [];
  for (let dir = here; ; dir = dirname(dir)) {
    roots.push(dir);
    if (!dir) break;
  }
  /** The module file for a dotted name under `root`, and the submodules `names` may be. */
  const candidates = (root: string, module: string, names: string[]) => {
    const base = join(root, module.replaceAll(".", "/"));
    if (base === undefined) return [];
    const own = module ? [`${base}.py`, join(base, "__init__.py")] : [];
    return [own, ...names.map((name) => [join(base, `${name}.py`), join(base, name, "__init__.py")])];
  };
  const found: string[] = [];
  const add = async (groups: (string | undefined)[][]) => {
    for (const group of groups) {
      const path = await folders.first(group);
      if (path) found.push(path);
    }
  };
  for (const line of codeLines(doc)) {
    const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+\(?([^)]*)/.exec(line);
    if (from) {
      const [, dots, module, list] = from;
      const names = list.split(",").map((n) => n.trim().split(/\s+/)[0]).filter((n) => /^\w+$/.test(n));
      if (dots) {
        const root = join(here, ...Array(dots.length - 1).fill(".."));
        if (root !== undefined) await add(candidates(root, module, names));
        continue;
      }
      for (const root of roots) {
        const groups = candidates(root, module, names);
        if (await folders.first(groups[0])) {
          await add(groups);
          break;
        }
      }
      continue;
    }
    const imported = /^\s*import\s+(.+)$/.exec(line);
    if (!imported) continue;
    for (const module of imported[1].split(",").map((m) => m.trim().split(/\s+/)[0])) {
      for (const root of roots) {
        const path = await folders.first(candidates(root, module, [])[0]);
        if (path) {
          found.push(path);
          break;
        }
      }
    }
  }
  return found;
}

/** The package's other files, then the packages it imports from its own module. */
async function goImports(doc: DocumentSnapshot, folders: Folders): Promise<string[]> {
  const here = dirname(doc.path);
  const isTest = doc.path.endsWith("_test.go");
  const goFiles = async (dir: string) =>
    (await folders.list(dir)).filter((path) => path.endsWith(".go") && (isTest || !path.endsWith("_test.go")));
  const found = await goFiles(here);

  let root: string | undefined;
  for (let dir = here; root === undefined; dir = dirname(dir)) {
    if (await folders.has(join(dir, "go.mod")!)) root = dir;
    else if (!dir) break;
  }
  if (root === undefined) return found;
  const goMod = await folders.files.read(join(root, "go.mod")!).catch(() => undefined);
  const module = goMod && /^module\s+(\S+)/m.exec(goMod)?.[1];
  if (!module) return found;

  let inGroup = false;
  for (const line of doc.text.split("\n")) {
    const single = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
    if (/^import\s*\(/.test(line)) inGroup = true;
    else if (inGroup && /^\s*\)/.test(line)) inGroup = false;
    const path = single?.[1] ?? (inGroup ? /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(line)?.[1] : undefined);
    if (path?.startsWith(`${module}/`)) {
      const dir = join(root, path.slice(module.length + 1));
      if (dir !== undefined) found.push(...(await goFiles(dir)));
    }
  }
  return found;
}
