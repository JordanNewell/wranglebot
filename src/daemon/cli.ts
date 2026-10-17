import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentKind, CurtRecord, Verdict } from "../types.js";
import { CodexObserver } from "../observers/codex.js";
import { runClaudeStream } from "./claude-stream.js";
import { createPipeline } from "./pipeline.js";
import { loadGuardrails } from "./registry.js";

export class CliError extends Error {}

const USAGE = "usage: wranglebot run <claude-code|codex> [PROMPT...] [--workdir DIR] [--scope PATH]...";

export interface RunOptions {
  agent: AgentKind;
  workdir?: string;
  scope: string[];
  prompt: string;
}

export interface ParsedCommand {
  command: "run";
  options: RunOptions;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const [command, agent, ...rest] = argv;
  if (command !== "run") throw new CliError(`unknown command: ${command ?? "(none)"}\n${USAGE}`);
  if (agent !== "claude-code" && agent !== "codex") {
    throw new CliError(`unknown agent: ${agent ?? "(missing)"}\n${USAGE}`);
  }
  const options: RunOptions = { agent, scope: [], prompt: "" };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--workdir" || arg === "--scope") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`flag ${arg} requires a value\n${USAGE}`);
      }
      if (arg === "--workdir") options.workdir = value;
      else options.scope.push(value);
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown flag: ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  options.prompt = positional.join(" ");
  return { command: "run", options };
}

function notify(msg: string): void {
  process.stderr.write(`wranglebot: ${msg}\n`);
}

interface CurtEmitterLike {
  add(record: CurtRecord): void;
  readonly size: number;
  flush(writePath: string): string;
}

/** Optional .curt emission; skipped with a warning if the curt module is missing. */
async function loadCurtEmitter(sessionId: string): Promise<CurtEmitterLike | null> {
  const spec = new URL("../curt/curt-emitter.js", import.meta.url).href;
  try {
    const mod = (await import(spec)) as { CurtEmitter?: new (o: object) => CurtEmitterLike };
    if (typeof mod.CurtEmitter !== "function") throw new Error("CurtEmitter export missing");
    return new mod.CurtEmitter({ sessionId });
  } catch (err) {
    notify(`curt emission disabled: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    notify((err as Error).message);
    return 1;
  }
  const { options } = parsed;
  if (!options.prompt) {
    notify("no prompt given\n" + USAGE);
    return 1;
  }

  const workdir = options.workdir ?? process.cwd();
  const guardrails = await loadGuardrails({ workdir, scope: options.scope });
  const sessionId = randomUUID();
  process.stderr.write(
    `wranglebot session ${sessionId} agent=${options.agent} guardrails=[${guardrails.map((g) => g.name).join(", ")}]\n`,
  );
  const curt = await loadCurtEmitter(sessionId);

  const session = createPipeline({ sources: [options.agent], guardrails });
  const record = (tool: string, ts: number, verdict: Verdict): void => {
    curt?.add({ sessionId, ts, tool, verdict, reason: verdict.reason });
  };
  let denied = false;
  let killAgent: () => void = () => {};
  const onEvent = (event: Parameters<typeof session.handle>[0]): void => {
    const verdict = session.handle(event);
    const suffix = verdict.reason ? ` (${verdict.reason})` : "";
    notify(`${event.tool} -> ${verdict.action}${suffix}`);
    record(event.tool, event.ts, verdict);
    if (verdict.action === "deny") {
      denied = true;
      killAgent();
    }
  };

  let code: number | null = 0;
  if (options.agent === "codex") {
    const observer = new CodexObserver();
    killAgent = () => observer.stop();
    try {
      await observer.run(options.prompt, { onEvent });
    } catch (err) {
      notify((err as Error).message);
      code = 1;
    }
  } else {
    const child = runClaudeStream({
      sessionId,
      prompt: options.prompt,
      workdir,
      onEvent,
    });
    killAgent = () => child.kill();
    code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
    });
  }

  if (curt && curt.size > 0) {
    try {
      const file = curt.flush(path.join(workdir, ".wranglebot"));
      notify(`curt written: ${file}`);
    } catch (err) {
      notify(`curt flush failed: ${(err as Error).message}`);
    }
  }
  return denied ? 2 : (code ?? 1);
}
