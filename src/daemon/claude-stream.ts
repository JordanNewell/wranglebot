import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentKind } from "../types.js";

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

const SOURCE: AgentKind = "claude-code";

/** @internal — stream-json in print mode requires --verbose. */
export function claudeArgs(prompt: string): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose"];
}

interface StreamLine {
  type?: string;
  message?: { content?: unknown };
}

/** Pure NDJSON line -> AgentEvents. tool_use blocks only; anything else is ignored. */
export function parseStreamLine(raw: string, sessionId: string, ts: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  let line: StreamLine;
  try {
    line = JSON.parse(raw) as StreamLine;
  } catch {
    return events;
  }
  const content = line?.message?.content;
  if (!Array.isArray(content)) return events;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type === "tool_use" && typeof b.name === "string" && b.input !== undefined) {
      events.push({ ts, source: SOURCE, sessionId, tool: b.name, input: b.input });
    }
  }
  return events;
}

export interface ClaudeStreamOptions {
  sessionId: string;
  prompt: string;
  workdir?: string;
  spawnFn?: SpawnFn;
  onEvent: (event: AgentEvent) => void;
}

/** Spawns `claude -p --output-format stream-json` and emits AgentEvents for tool_use blocks. */
export function runClaudeStream(opts: ClaudeStreamOptions): ChildProcess {
  const doSpawn = opts.spawnFn ?? spawn;
  const child = doSpawn("claude", claudeArgs(opts.prompt), {
    cwd: opts.workdir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.on("error", (err) => {
    process.stderr.write(`wranglebot: claude spawn failed: ${err.message}\n`);
  });
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (raw) => {
      for (const event of parseStreamLine(raw, opts.sessionId, Date.now())) {
        opts.onEvent(event);
      }
    });
  }
  return child;
}
