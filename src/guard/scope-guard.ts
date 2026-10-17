import path from "node:path";
import type { AgentEvent, Guardrail, Verdict } from "../types.js";

/** Tools whose input targets a file on disk. */
const FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "write_file",
  "file-create",
  "create_file",
]);

/** Input field names commonly carrying the target path, in priority order. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

/** v1 blanket-denied dot-config / CI locations (normalized, forward-slash). */
const DEFAULT_DENIED_PATTERNS = [".git/", ".github/workflows/", ".claude/settings.json"];

const MANIFEST_FILES = new Set(["package.json", "package-lock.json", "requirements.txt"]);

export interface ScopeGuardOptions {
  /** Additional directory roots the agent may write to, outside workdir. */
  allowedPaths: string[];
  /** Project root the agent is confined to by default. */
  workdir: string;
  /** Extra blanket-denied locations appended to the v1 defaults. */
  deniedPatterns?: string[];
}

/**
 * Worktree-diff scope guard: confines file writes to the workdir (plus
 * explicitly allowed roots), blanket-denies dot-config/CI files, and
 * warns on package-manifest writes. inspect() only; observe() is a no-op.
 */
export class ScopeGuard implements Guardrail {
  readonly name = "scope-guard";

  private readonly workdir: string;
  private readonly allowedPaths: string[];
  private readonly deniedPatterns: string[];

  constructor(options: ScopeGuardOptions) {
    this.workdir = path.resolve(options.workdir);
    this.allowedPaths = options.allowedPaths.map((p) => path.resolve(p));
    this.deniedPatterns = [...DEFAULT_DENIED_PATTERNS, ...(options.deniedPatterns ?? [])];
  }

  inspect(event: AgentEvent): Verdict | null {
    if (!FILE_TOOLS.has(event.tool)) return null;

    const target = extractTargetPath(event.input);
    if (target === null) return null;

    const resolved = path.resolve(target);

    const inWorkdir = isWithin(this.workdir, resolved);
    const allowedRoot = this.allowedPaths.find((root) => isWithin(root, resolved));

    if (!inWorkdir && allowedRoot === undefined) {
      const boundary = this.allowedPaths.length
        ? "outside workdir and not covered by any allowedPaths entry"
        : "outside workdir (no allowedPaths configured)";
      return {
        action: "deny",
        reason: `scope-guard: ${resolved} is ${boundary}`,
      };
    }

    if (matchesDeniedPattern(resolved, this.deniedPatterns)) {
      // An exact allowedPaths entry is the explicit-allow override.
      const explicitlyAllowed = this.allowedPaths.some(
        (p) => samePath(p, resolved) || isWithin(p, resolved),
      );
      if (!explicitlyAllowed) {
        const matched = this.deniedPatterns.find((p) =>
          matchesDeniedPattern(resolved, [p]),
        );
        return {
          action: "deny",
          reason: `scope-guard: ${resolved} matches denied pattern "${matched}"`,
        };
      }
    }

    const base = path.basename(resolved).toLowerCase();
    if (MANIFEST_FILES.has(base)) {
      return {
        action: "warn",
        reason: `scope-guard: ${base} is a package manifest — dependency changes need review`,
      };
    }

    return { action: "allow" };
  }

  observe(_event: AgentEvent): void {
    // Stateless pre-execution guard; nothing to record post-execution.
  }
}

/** Pull the target path out of a tool input across common field names. */
export function extractTargetPath(input: unknown): string | null {
  if (typeof input === "string" && input.trim() !== "") return input;
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Real containment: resolve, relative, then check for leading ".." or an
 * absolute remainder. Case-insensitive on Windows.
 */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(normalizeCase(root), normalizeCase(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function samePath(a: string, b: string): boolean {
  return normalizeCase(path.resolve(a)) === normalizeCase(path.resolve(b));
}

function normalizeCase(p: string): string {
  const resolved = path.resolve(p);
  return path.sep === "\\" ? resolved.toLowerCase() : resolved;
}

/** Substring match on the forward-slash, case-folded absolute path. */
function matchesDeniedPattern(resolved: string, patterns: string[]): boolean {
  const flat = resolved.replaceAll("\\", "/").toLowerCase();
  return patterns.some((pattern) => flat.includes(pattern.replaceAll("\\", "/").toLowerCase()));
}
