// Tree-sitter (WASM) parsing for the tuned languages, Python and Go.
import { Language, Parser, type Node } from "web-tree-sitter";

export type { Node } from "web-tree-sitter";

/** What the stop rules need to know about one language's syntax tree. */
export interface Grammar {
  parser: Parser;
  /** Node types whose named children are statements. */
  containers: ReadonlySet<string>;
  /** True for Go, where a block includes its braces; Python blocks are bare statements. */
  braces: boolean;
}

const GRAMMARS: Record<string, { wasm: string; containers: string[]; braces: boolean }> = {
  python: {
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    containers: ["module", "block"],
    braces: false,
  },
  go: {
    wasm: "tree-sitter-go/tree-sitter-go.wasm",
    containers: ["source_file", "statement_list"],
    braces: true,
  },
};

let initialized: Promise<void> | undefined;
const loading = new Map<string, Promise<Grammar | undefined>>();

/**
 * The grammar for a language, loaded once. Undefined for languages without one, or if
 * it fails to load; the stop rules then fall back to indentation and brackets.
 */
export function loadGrammar(languageId: string): Promise<Grammar | undefined> {
  const spec = GRAMMARS[languageId];
  if (!spec) return Promise.resolve(undefined);
  let grammar = loading.get(languageId);
  if (!grammar) {
    initialized ??= Parser.init();
    grammar = initialized
      .then(() => Language.load(require.resolve(spec.wasm)))
      .then((language) => ({
        parser: new Parser().setLanguage(language),
        containers: new Set(spec.containers),
        braces: spec.braces,
      }))
      .catch((err) => {
        console.error(`Pawl: could not load the ${languageId} grammar`, err);
        return undefined;
      });
    loading.set(languageId, grammar);
  }
  return grammar;
}

/** True if an error or missing node inside `node` touches [from, to]. */
export function hasErrorIn(node: Node, from: number, to: number): boolean {
  if (node.isError || node.isMissing) return node.startIndex <= to && node.endIndex >= from;
  if (!node.hasError) return false;
  return node.children.some(
    (child) => child !== null && child.startIndex <= to && child.endIndex >= from && hasErrorIn(child, from, to),
  );
}
