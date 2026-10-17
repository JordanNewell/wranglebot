import type { Guardrail } from "../types.js";

/**
 * Well-known guardrail module locations, relative to this file. Specified as
 * string variables so tsc never tries to statically resolve modules that
 * teammates may not have landed yet.
 */
const MODULE_PATHS = [
  "../hooks/ast-gate.js",
  "../loopbreak/loop-breaker.js",
  "../guard/scope-guard.js",
  "../curt/curt-emitter.js",
];

export interface GuardrailLoadOptions {
  /** Project root handed to workdir-aware guardrails (scope-guard, ast-gate). */
  workdir?: string;
  /** Extra allowed roots handed to scope-guard (--scope flags). */
  scope?: string[];
}

type GuardrailCtor = new (options: Record<string, unknown>) => Guardrail;

function isGuardrailInstance(x: unknown): x is Guardrail {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as Guardrail).name === "string" &&
    typeof (x as Guardrail).inspect === "function" &&
    typeof (x as Guardrail).observe === "function"
  );
}

function isGuardrailClass(x: unknown): x is GuardrailCtor {
  const proto = (x as { prototype?: Record<string, unknown> } | null)?.prototype;
  return typeof x === "function" && !!proto && typeof proto.inspect === "function" && typeof proto.observe === "function";
}

function warn(msg: string): void {
  process.stderr.write(`wranglebot: ${msg}\n`);
}

/**
 * Loads guardrails from known teammate modules. Accepts default/named exports
 * that satisfy Guardrail (instances), Guardrail classes (instantiated with
 * workdir/scope options), or arrays of instances. Missing or broken modules
 * are skipped with a stderr warning — never fatal.
 */
export async function loadGuardrails(opts: GuardrailLoadOptions = {}): Promise<Guardrail[]> {
  const constructorOptions: Record<string, unknown> = {
    workdir: opts.workdir ?? process.cwd(),
    allowedPaths: opts.scope ?? [],
  };
  const loaded: Guardrail[] = [];
  for (const rel of MODULE_PATHS) {
    // Keep specifiers as file:// URLs — bare Windows drive-letter paths
    // ("e:/...") are rejected by the ESM loader ("protocol 'e:'").
    const spec = new URL(rel, import.meta.url).href;
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const found: Guardrail[] = [];
      for (const value of Object.values(mod)) {
        if (isGuardrailInstance(value)) {
          found.push(value);
        } else if (isGuardrailClass(value)) {
          found.push(new value(constructorOptions));
        } else if (Array.isArray(value)) {
          for (const g of value) if (isGuardrailInstance(g)) found.push(g);
        }
      }
      if (found.length === 0) {
        warn(`skipped ${rel}: no Guardrail export found`);
      } else {
        loaded.push(...found);
      }
    } catch (err) {
      warn(`skipped ${rel}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return loaded;
}
