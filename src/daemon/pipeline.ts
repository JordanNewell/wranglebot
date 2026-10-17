import { randomUUID } from "node:crypto";
import type { AgentKind, Guardrail } from "../types.js";
import { SupervisorSession } from "./session.js";

export interface PipelineConfig {
  sources: AgentKind[];
  guardrails: Guardrail[];
}

export function createPipeline(cfg: PipelineConfig): SupervisorSession {
  if (!Array.isArray(cfg.sources)) throw new TypeError("sources must be an array of AgentKind");
  if (!Array.isArray(cfg.guardrails)) throw new TypeError("guardrails must be an array of Guardrail");
  return new SupervisorSession({
    sessionId: randomUUID(),
    sources: cfg.sources,
    guardrails: cfg.guardrails,
  });
}
