// ast-gate — tree-sitter guardrail over file-edit tool inputs.
//
// Parses the NEW content of Edit/Write/MultiEdit calls and flags dangerous
// constructs per the rule table below. Design constraints:
//   - Fail open on anything we cannot evaluate (syntax errors, unknown
//     languages, grammar load failure): never a false-positive deny.
//   - Grammar loading is lazy + memoized (native module load is expensive).
//   - The rule table is data; extend it, not the matching engine.

import { createRequire } from "node:module";
import * as path from "node:path";
import type { AgentEvent, Guardrail, Verdict } from "../types.js";

const requireCjs = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Minimal structural types for tree-sitter (kept local so we don't depend on
// the ambient "tree-sitter" module typing from a CJS `export =` declaration).
// ---------------------------------------------------------------------------

interface TsPosition {
  row: number;
  column: number;
}

interface TsNode {
  type: string;
  text: string;
  hasError: boolean;
  startPosition: TsPosition;
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(lang: unknown): void;
  parse(input: string): TsTree;
}

type LanguageKey = "ts" | "tsx" | "py";

interface Grammars {
  ts: unknown;
  tsx: unknown;
  py: unknown;
  parser: TsParser;
}

// ---------------------------------------------------------------------------
// Rule table — data only. action "deny" hard-blocks; "warn" surfaces a prompt.
// ---------------------------------------------------------------------------

interface AstRule {
  id: string;
  action: "deny" | "warn";
  langs: LanguageKey[];
  /** Module specifiers matched against import/require/import() sources. */
  modules?: string[];
  /** Dotted callee text matched exactly, e.g. "subprocess.run", "fs.rmSync". */
  callees?: string[];
  /** Callee object (first dotted segment), e.g. "axios", "requests". */
  calleeObjects?: string[];
  /** Plain identifier callees, e.g. "eval", "fetch". */
  bareCallees?: string[];
  /**
   * Destructive-deletion semantics: if the first call argument is a string
   * literal that resolves inside the session workdir, no verdict is emitted.
   */
  deletionPathCheck?: boolean;
  message: string;
}

export const AST_RULES: readonly AstRule[] = [
  {
    id: "node-child-process",
    action: "deny",
    langs: ["ts", "tsx"],
    modules: ["child_process", "node:child_process"],
    message: "child_process import/require in written code",
  },
  {
    id: "python-subprocess",
    action: "deny",
    langs: ["py"],
    modules: ["subprocess"],
    callees: [
      "subprocess.run",
      "subprocess.call",
      "subprocess.check_call",
      "subprocess.check_output",
      "subprocess.Popen",
      "subprocess.getoutput",
      "subprocess.getstatusoutput",
    ],
    message: "subprocess import/call in written code",
  },
  {
    id: "destructive-delete",
    action: "warn",
    langs: ["ts", "tsx", "py"],
    callees: [
      "fs.rmSync",
      "fs.rm",
      "fsPromises.rm",
      "rimraf",
      "shutil.rmtree",
      "os.remove",
      "os.removedirs",
      "os.unlink",
    ],
    bareCallees: ["rmSync", "rimraf", "rmtree"],
    deletionPathCheck: true,
    message: "destructive filesystem deletion",
  },
  {
    id: "python-eval-exec",
    action: "warn",
    langs: ["py"],
    bareCallees: ["eval", "exec"],
    message: "dynamic eval/exec in Python code",
  },
  {
    id: "network-egress",
    action: "warn",
    langs: ["ts", "tsx", "py"],
    bareCallees: ["fetch"],
    calleeObjects: [
      "axios",
      "requests",
      "httpx",
      "urllib",
      "http",
      "https",
      "got",
      "superagent",
      "node-fetch",
    ],
    message: "network egress call",
  },
];

// ---------------------------------------------------------------------------
// Language detection + content extraction
// ---------------------------------------------------------------------------

const GATED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const EXT_TO_LANG: Record<string, LanguageKey> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "ts",
  ".jsx": "tsx",
  ".py": "py",
};

interface GateTarget {
  lang: LanguageKey;
  content: string;
}

/** Extract the NEW content an edit tool would write. Null = nothing to gate. */
export function extractEditTarget(input: unknown): GateTarget | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  const filePath = typeof rec.file_path === "string" ? rec.file_path : null;
  if (!filePath) return null;
  const lang = EXT_TO_LANG[path.extname(filePath).toLowerCase()];
  if (!lang) return null;

  let content: string | null = null;
  if (typeof rec.content === "string") {
    content = rec.content; // Write
  } else if (typeof rec.new_string === "string") {
    content = rec.new_string; // Edit
  } else if (Array.isArray(rec.edits)) {
    // MultiEdit: concatenate the new_string of every hunk.
    const parts = rec.edits
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).new_string : undefined))
      .filter((s): s is string => typeof s === "string");
    if (parts.length > 0) content = parts.join("\n");
  }
  if (content === null) return null;
  return { lang, content };
}

// ---------------------------------------------------------------------------
// Lazy, memoized grammar loading
// ---------------------------------------------------------------------------

let grammarsCache: Grammars | null | undefined;

function loadGrammars(): Grammars | null {
  if (grammarsCache !== undefined) return grammarsCache;
  try {
    // Synchronous CJS load: inspect() must stay sync per the Guardrail
    // contract, and dynamic import() cannot be awaited there.
    const ParserCtor = requireCjs("tree-sitter") as unknown as { new (): TsParser };
    const tsGrammars = requireCjs("tree-sitter-typescript") as Record<string, unknown>;
    const pyGrammar = requireCjs("tree-sitter-python") as unknown;
    grammarsCache = {
      ts: tsGrammars.typescript,
      tsx: tsGrammars.tsx,
      py: pyGrammar,
      parser: new ParserCtor(),
    };
  } catch {
    grammarsCache = null; // memoize the failure; gate fails open
  }
  return grammarsCache;
}

// ---------------------------------------------------------------------------
// AST matching engine
// ---------------------------------------------------------------------------

interface Finding {
  rule: AstRule;
  line: number;
  detail: string;
}

function walk(root: TsNode, visit: (n: TsNode) => void): void {
  const stack: TsNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as TsNode;
    visit(n);
    for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i] as TsNode);
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
}

/** Normalize a dotted callee/source text: drop whitespace and optional-chain punctuation. */
function normalizeDotted(s: string): string {
  return s.replace(/\s+/g, "").replace(/[?!]/g, "");
}

function normalizeModuleRef(s: string): string {
  return stripQuotes(s.trim()).replace(/^node:/, "");
}

function moduleMatches(ref: string, modules: string[]): boolean {
  const n = normalizeModuleRef(ref);
  return modules.some((m) => m.replace(/^node:/, "") === n);
}

/** Collect module specifier strings from import/require/import()/export-from. */
function collectModuleRefs(root: TsNode, lang: LanguageKey): string[] {
  const refs: string[] = [];
  walk(root, (n) => {
    if (lang === "py") {
      if (n.type === "import_statement" || n.type === "import_from_statement") {
        const mn = n.childForFieldName("module_name");
        if (mn) {
          refs.push(mn.text);
          return;
        }
        for (const c of n.namedChildren) {
          if (c.type === "dotted_name") refs.push(c.text);
          else if (c.type === "aliased_import") {
            const name = c.childForFieldName("name");
            if (name) refs.push(name.text);
          }
        }
      }
      return;
    }
    // TypeScript / JavaScript
    if (n.type === "import_statement" || n.type === "export_statement") {
      const src = n.childForFieldName("source");
      if (src) refs.push(src.text);
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && (fn.text === "require" || fn.text === "import")) {
        const args = n.childForFieldName("arguments");
        const first = args?.namedChildren[0];
        if (first && first.type === "string") refs.push(first.text);
      }
    }
  });
  return refs;
}

/** Extract the callee text of a call node, or null. */
function calleeText(n: TsNode, lang: LanguageKey): string | null {
  const callType = lang === "py" ? "call" : "call_expression";
  if (n.type !== callType) return null;
  const fn = n.childForFieldName("function");
  return fn ? normalizeDotted(fn.text) : null;
}

function resolveInsideWorkdir(target: string, workdir: string): boolean | null {
  const t = target.trim();
  if (t.length === 0 || t.startsWith("~")) return null; // undeterminable
  let abs: string;
  try {
    abs = path.isAbsolute(t) ? path.normalize(t) : path.resolve(workdir, t);
  } catch {
    return null;
  }
  const rel = path.relative(workdir, abs);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** First argument of a call node if it is a plain string literal. */
function firstStringArg(n: TsNode): string | null {
  const args = n.childForFieldName("arguments");
  const first = args?.namedChildren.find((c) => c.type === "string");
  return first ? stripQuotes(first.text) : null;
}

export interface AstGateOptions {
  /** Session workdir used for deletion-path containment checks. */
  workdir?: string;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export class AstGate implements Guardrail {
  readonly name = "ast-gate";
  private readonly workdir: string;

  constructor(options: AstGateOptions = {}) {
    this.workdir = options.workdir ?? process.cwd();
  }

  /** Pure evaluation of one edit target; exported for tests and reuse. */
  evaluate(target: GateTarget): Verdict | null {
    const grammars = loadGrammars();
    if (!grammars) {
      return { action: "allow", reason: "ast-gate: grammars unavailable, not gating" };
    }
    let tree: TsTree;
    try {
      grammars.parser.setLanguage(grammars[target.lang]);
      tree = grammars.parser.parse(target.content);
    } catch {
      return { action: "allow", reason: "ast-gate: parse failed, not gating" };
    }
    if (tree.rootNode.hasError) {
      return { action: "allow", reason: "unparseable, not gated" };
    }

    const findings: Finding[] = [];
    const moduleRefs = new Set<string>();
    for (const rule of AST_RULES) {
      if (!rule.langs.includes(target.lang)) continue;

      if (rule.modules) {
        if (moduleRefs.size === 0) {
          for (const r of collectModuleRefs(tree.rootNode, target.lang)) moduleRefs.add(r);
        }
        for (const ref of moduleRefs) {
          if (moduleMatches(ref, rule.modules)) {
            findings.push({ rule, line: 1, detail: `module "${normalizeModuleRef(ref)}"` });
            break;
          }
        }
      }

      walk(tree.rootNode, (n) => {
        const callee = calleeText(n, target.lang);
        if (!callee) return;
        const line = n.startPosition.row + 1;

        if (rule.callees?.includes(callee)) {
          if (rule.deletionPathCheck) {
            const arg = firstStringArg(n);
            if (arg !== null) {
              const inside = resolveInsideWorkdir(arg, this.workdir);
              if (inside === true) return; // deleting inside the workdir: fine
            }
          }
          findings.push({ rule, line, detail: callee });
          return;
        }

        if (rule.calleeObjects) {
          const parts = callee.split(".");
          if (parts.length >= 2 && rule.calleeObjects.includes(parts[0] as string)) {
            findings.push({ rule, line, detail: callee });
            return;
          }
        }

        if (rule.bareCallees?.includes(callee)) {
          if (rule.deletionPathCheck) {
            const arg = firstStringArg(n);
            if (arg !== null && resolveInsideWorkdir(arg, this.workdir) === true) return;
          }
          findings.push({ rule, line, detail: callee });
        }
      });
    }

    if (findings.length === 0) return { action: "allow" };

    const denied = findings.filter((f) => f.rule.action === "deny");
    const chosen = denied.length > 0 ? denied : findings;
    const reasons = chosen.map(
      (f) => `${f.rule.id}: ${f.rule.message} (${f.detail}${f.line > 1 ? `, line ${f.line}` : ""})`,
    );
    return {
      action: denied.length > 0 ? "deny" : "warn",
      reason: `ast-gate: ${reasons.join("; ")}`,
    };
  }

  inspect(event: AgentEvent): Verdict | null {
    if (!GATED_TOOLS.has(event.tool)) return null;
    const target = extractEditTarget(event.input);
    if (!target) return null; // unknown language / no content: not gated
    return this.evaluate(target);
  }

  /** ast-gate is pre-execution only; nothing to record. */
  observe(_event: AgentEvent): void {
    /* no-op */
  }
}
