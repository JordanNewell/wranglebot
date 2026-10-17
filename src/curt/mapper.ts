import type { CurtMessage } from "curt-format";
import type { CurtRecord } from "../types.js";

/**
 * Map one supervised tool call to a .curt message. role="tool" per the spec;
 * the CurtRecord payload travels in `content` (string) and is duplicated as
 * extension fields (`tool`, `verdict`, `sessionId`) which .curt readers
 * ignore on unknown fields but round-trip verbatim.
 */
export function recordToMessage(record: CurtRecord, index: number): CurtMessage {
  return {
    id: `${record.sessionId}_${record.ts}_${index}`,
    role: "tool",
    content: JSON.stringify({
      tool: record.tool,
      verdict: record.verdict,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    }),
    timestamp: record.ts,
    tool: record.tool,
    verdict: record.verdict,
    sessionId: record.sessionId,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
}
