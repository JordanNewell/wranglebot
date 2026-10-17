// Shared contract — all modules import from here. Do not rename fields;
// add new optional fields only (coordination file owned by main session).

export type AgentKind = "claude-code" | "codex";

/** Normalized observation of one agent action, from any supported agent. */
export interface AgentEvent {
  ts: number;
  source: AgentKind;
  sessionId: string;
  /** Tool the agent invoked, e.g. "Edit", "Bash", "shell". */
  tool: string;
  /** Tool input as provided by the agent (JSON-serializable). */
  input: unknown;
  /** Output/result summary when available (stream-json tail, exec result). */
  output?: unknown;
}

/** A supervisor decision about an event. */
export interface Verdict {
  action: "allow" | "warn" | "deny" | "rewrite";
  reason?: string;
  /** Only for action="rewrite" (hookSpecificOutput.updatedInput contract). */
  updatedInput?: unknown;
}

/** Interface implemented by each guardrail (AST gate, scope guard, loop-breaker). */
export interface Guardrail {
  name: string;
  /** Inspect an event before it executes; may deny/rewrite. */
  inspect(event: AgentEvent): Verdict | null;
  /** Feed post-execution output into state (loop-breaker bookkeeping). */
  observe(event: AgentEvent): void;
}

/** One .curt record emitted for the supervised session. */
export interface CurtRecord {
  sessionId: string;
  ts: number;
  tool: string;
  verdict: Verdict;
  reason?: string;
}
