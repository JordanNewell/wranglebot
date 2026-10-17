import type { AgentEvent, AgentKind, Guardrail, Verdict } from "../types.js";

export interface SessionOptions {
  sessionId: string;
  guardrails: Guardrail[];
  /** Agent kinds this session supervises. */
  sources?: AgentKind[];
}

const ALLOW: Verdict = { action: "allow" };

export class SupervisorSession {
  readonly sessionId: string;
  readonly sources: AgentKind[];
  readonly events: AgentEvent[] = [];
  private readonly guardrails: Guardrail[];

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.sources = opts.sources ?? [];
    this.guardrails = opts.guardrails;
  }

  get guardrailNames(): string[] {
    return this.guardrails.map((g) => g.name);
  }

  /**
   * Runs inspect() in registration order; first deny/rewrite wins, else allow.
   * observe() runs on every guardrail regardless of outcome.
   */
  handle(event: AgentEvent): Verdict {
    this.events.push(event);
    let verdict = ALLOW;
    for (const g of this.guardrails) {
      const v = g.inspect(event);
      if (v && (v.action === "deny" || v.action === "rewrite")) {
        verdict = v;
        break;
      }
    }
    for (const g of this.guardrails) g.observe(event);
    return verdict;
  }
}
