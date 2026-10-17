// cc-hook — standalone Claude Code PreToolUse hook entry.
//
// Claude Code contract (verified 2026-10-16 against
// https://code.claude.com/docs/en/hooks):
//   stdin  : full hook input JSON, incl. session_id, cwd, hook_event_name,
//            tool_name, tool_input, tool_use_id.
//   stdout : JSON decision object, schema:
//     { "hookSpecificOutput": {
//         "hookEventName": "PreToolUse",
//         "permissionDecision": "allow" | "deny" | "ask" | "defer",
//         "permissionDecisionReason": "...",
//         "updatedInput": { ... }   // optional; replaces the tool's arguments
//     } }
//   exit 0 = success (fields apply); exit 2 = blocking error (tool blocked,
//   stderr is the reason); any other code = non-blocking error.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import type { AgentEvent, Verdict } from "../types.js";
import { AstGate } from "./ast-gate.js";

const GATED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Pure handler: hook input JSON (already parsed) -> hook output JSON string.
 * Exported so tests can round-trip without spawning a subprocess.
 */
export function handleHookInput(json: unknown): string {
  const gate = new AstGate({
    workdir: typeof (json as HookInput | null)?.cwd === "string" ? (json as HookInput).cwd : undefined,
  });

  const input = (typeof json === "object" && json !== null ? json : {}) as HookInput;
  if (input.hook_event_name !== "PreToolUse" || typeof input.tool_name !== "string") {
    return allowJson("ast-gate: not a PreToolUse event, allowing");
  }
  if (!GATED_TOOLS.has(input.tool_name)) {
    return allowJson(`ast-gate: tool ${input.tool_name} not gated`);
  }

  const event: AgentEvent = {
    ts: Date.now(),
    source: "claude-code",
    sessionId: typeof input.session_id === "string" ? input.session_id : "unknown",
    tool: input.tool_name,
    input: input.tool_input,
  };

  let verdict: Verdict | null;
  try {
    verdict = gate.inspect(event);
  } catch (err) {
    // Never let a gate bug hard-block an edit: fail open.
    return allowJson(`ast-gate: internal error (${String(err)}), allowing`);
  }

  if (verdict === null) {
    return allowJson("ast-gate: no dangerous constructs found");
  }

  const reason = verdict.reason ?? "ast-gate verdict";
  switch (verdict.action) {
    case "deny":
      return decisionJson("deny", reason);
    case "warn":
      // CC permissionDecision: surface to the user as an approval prompt.
      return decisionJson("ask", reason);
    case "rewrite":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
          updatedInput: verdict.updatedInput ?? input.tool_input,
        },
      });
    case "allow":
    default:
      return decisionJson("allow", reason);
  }
}

function decisionJson(
  permissionDecision: "allow" | "deny" | "ask",
  permissionDecisionReason: string,
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  });
}

function allowJson(reason: string): string {
  return decisionJson("allow", reason);
}

/** CLI entry: read stdin, print the decision JSON. Returns the exit code. */
export async function main(): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch (err) {
    process.stderr.write(`ast-gate hook: cannot read stdin: ${String(err)}\n`);
    return 2; // blocking error per the CC hook contract
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`ast-gate hook: invalid hook JSON on stdin: ${String(err)}\n`);
    return 2;
  }

  process.stdout.write(handleHookInput(json) + "\n");
  return 0;
}

// Run only when invoked directly (node/tsx src/hooks/cc-hook.ts), not on import.
const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) {
  void main().then((code) => process.exit(code));
}
