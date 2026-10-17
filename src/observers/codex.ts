// Codex observer: parses `codex exec --json` JSONL output into AgentEvents and
// provides a thin spawn wrapper around the codex CLI.
//
// Supported wire formats (parser is graceful — unrecognized lines yield null):
//
// 1. Modern ThreadEvent stream (codex exec --json / --experimental-json,
//    codex-rs/exec/src/exec_events.rs, `#[serde(tag = "type")]`):
//      {"type":"thread.started","thread_id":"<uuid>"}
//      {"type":"turn.started"}
//      {"type":"item.started","item":{"id":"item_0","type":"command_execution",
//        "command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
//      {"type":"item.completed","item":{...same item at terminal state...}}
//      {"type":"turn.completed","usage":{...}}
//    ThreadItemDetails is `#[serde(tag = "type", rename_all = "snake_case")]` and
//    flattens into the item object (command_execution, file_change, mcp_tool_call,
//    web_search, agent_message, reasoning, todo_list, error, collab_tool_call).
//
// 2. Legacy EventMsg stream (older codex --json, codex-rs/protocol protocol.rs
//    EventMsg, snake_case variants wrapped as {"id":"<conversation id>","msg":{...}}):
//      {"id":"<conv>","msg":{"type":"session_configured","session_id":"<uuid>",...}}
//      {"id":"<conv>","msg":{"type":"exec_command_begin","call_id":"...","command":["bash","-lc","ls"],"cwd":"..."}}
//      {"id":"<conv>","msg":{"type":"exec_command_end","call_id":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//      {"id":"<conv>","msg":{"type":"patch_apply_begin","call_id":"...","changes":{...}}}
//      {"id":"<conv>","msg":{"type":"patch_apply_end","call_id":"...","success":true,...}}
//
// Tool mapping:
//   command_execution / exec_command_*  -> tool "shell"  (output on completed/end)
//   file_change / patch_apply_*         -> tool "edit"
//   mcp_tool_call                       -> tool "mcp:<server>.<tool>"
//   web_search                          -> tool "web_search"
//   agent_message / reasoning / turn.* / thread.started / errors -> null (no action)

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent } from "../types.js";

type JsonObj = Record<string, unknown>;

function asObj(value: unknown): JsonObj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObj)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function makeEvent(
  sessionId: string,
  tool: string,
  input: unknown,
  output?: unknown,
): AgentEvent {
  return {
    ts: Date.now(),
    source: "codex",
    sessionId,
    tool,
    input,
    ...(output !== undefined ? { output } : {}),
  };
}

/** Parse one JSONL line from `codex exec --json` into an AgentEvent, or null. */
export function parseCodexEvent(
  line: string,
  opts: { sessionId?: string } = {},
): AgentEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const obj = asObj(raw);
  if (!obj) return null;
  return parseModernThreadEvent(obj, opts) ?? parseLegacyEventMsg(obj, opts);
}

/**
 * Extract the session/thread id from a JSONL line, if the line carries one
 * (`thread.started` in the modern stream, `session_configured` in the legacy
 * stream). Callers track this and pass it back via `parseCodexEvent` opts so
 * subsequent session-less lines can be attributed.
 */
export function codexSessionId(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const obj = asObj(raw);
  if (!obj) return null;
  if (asString(obj["type"]) === "thread.started") {
    return asString(obj["thread_id"]);
  }
  const msg = asObj(obj["msg"]);
  if (msg && asString(msg["type"]) === "session_configured") {
    return asString(msg["session_id"]) ?? asString(obj["id"]);
  }
  return null;
}

function parseModernThreadEvent(
  obj: JsonObj,
  opts: { sessionId?: string },
): AgentEvent | null {
  const type = asString(obj["type"]);
  if (type !== "item.started" && type !== "item.completed") return null;
  const completed = type === "item.completed";
  const item = asObj(obj["item"]);
  if (!item) return null;
  const itemType = asString(item["type"]);
  const itemId = asString(item["id"]) ?? "";
  const sessionId = opts.sessionId ?? "";

  switch (itemType) {
    case "command_execution": {
      const rawCommand = item["command"];
      const command =
        typeof rawCommand === "string"
          ? rawCommand
          : Array.isArray(rawCommand)
            ? rawCommand.map(String).join(" ")
            : null;
      if (command === null) return null;
      const output = completed
        ? {
            exit_code: item["exit_code"],
            output: asString(item["aggregated_output"]) ?? "",
            status: asString(item["status"]) ?? undefined,
          }
        : undefined;
      return makeEvent(sessionId, "shell", { command, itemId }, output);
    }
    case "file_change": {
      if (!Array.isArray(item["changes"])) return null;
      const output = completed
        ? { status: asString(item["status"]) ?? undefined }
        : undefined;
      return makeEvent(
        sessionId,
        "edit",
        { changes: item["changes"], itemId },
        output,
      );
    }
    case "mcp_tool_call": {
      const server = asString(item["server"]);
      const tool = asString(item["tool"]);
      if (!server || !tool) return null;
      const output = completed
        ? {
            status: asString(item["status"]) ?? undefined,
            result: item["result"],
            error: item["error"],
          }
        : undefined;
      return makeEvent(
        sessionId,
        `mcp:${server}.${tool}`,
        { arguments: item["arguments"], itemId },
        output,
      );
    }
    case "web_search": {
      const query = asString(item["query"]);
      if (query === null) return null;
      return makeEvent(
        sessionId,
        "web_search",
        { query, action: item["action"], itemId },
        undefined,
      );
    }
    default:
      return null;
  }
}

function parseLegacyEventMsg(
  obj: JsonObj,
  opts: { sessionId?: string },
): AgentEvent | null {
  const msg = asObj(obj["msg"]);
  if (!msg) return null;
  const type = asString(msg["type"]);
  if (!type) return null;
  const sessionId = opts.sessionId ?? asString(obj["id"]) ?? "";
  const callId = asString(msg["call_id"]) ?? "";

  switch (type) {
    case "exec_command_begin":
    case "exec_command_end": {
      const isEnd = type === "exec_command_end";
      const output = isEnd
        ? {
            exit_code: msg["exit_code"],
            output: asString(msg["aggregated_output"]) ?? "",
            status: asString(msg["status"]) ?? undefined,
            duration: msg["duration"],
          }
        : undefined;
      return makeEvent(
        sessionId,
        "shell",
        { command: msg["command"], cwd: asString(msg["cwd"]) ?? undefined, callId },
        output,
      );
    }
    case "patch_apply_begin":
    case "patch_apply_end": {
      const isEnd = type === "patch_apply_end";
      const output = isEnd
        ? {
            success: msg["success"] === true,
            stdout: asString(msg["stdout"]) ?? "",
            stderr: asString(msg["stderr"]) ?? "",
            status: asString(msg["status"]) ?? undefined,
          }
        : undefined;
      return makeEvent(
        sessionId,
        "edit",
        { changes: msg["changes"], callId },
        output,
      );
    }
    default:
      // session_configured, agent_message, token_count, turn diffs, etc.
      return null;
  }
}

export interface CodexObserverOptions {
  /** Path to the codex binary (default: "codex", or $CODEX_PATH). */
  codexPath?: string;
  /** Called for every parsed AgentEvent. */
  onEvent?: (event: AgentEvent) => void;
  /** Called with raw stderr chunks from the codex process. */
  onStderr?: (chunk: string) => void;
}

/** Spawn wrapper around `codex exec --json <prompt>`. */
export class CodexObserver {
  private sessionId: string | null = null;
  private child: ChildProcess | null = null;

  /** Run codex on a prompt, streaming parsed events to opts.onEvent. Resolves on process exit. */
  run(prompt: string, opts: CodexObserverOptions = {}): Promise<void> {
    const codexPath = opts.codexPath ?? process.env["CODEX_PATH"] ?? "codex";
    this.sessionId = null;
    return new Promise<void>((resolve, reject) => {
      // shell:true on Windows so the .cmd shim installed by npm resolves.
      const child = spawn(codexPath, ["exec", "--json", prompt], {
        shell: process.platform === "win32",
      });
      this.child = child;

      child.on("error", (err) => {
        this.child = null;
        reject(new Error(`failed to spawn codex ("${codexPath}"): ${err.message}`));
      });
      child.on("close", (exitCode) => {
        this.child = null;
        // Non-zero codex exit (or the Windows shell's 9009 for a missing
        // binary) means the agent never ran the turn — surface it.
        if (exitCode !== 0) {
          reject(new Error(`codex ("${codexPath}") exited with code ${exitCode}`));
        } else {
          resolve();
        }
      });

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          opts.onStderr?.(chunk.toString("utf8"));
        });
      }
      if (!child.stdout) {
        reject(new Error(`codex ("${codexPath}") produced no stdout stream`));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => this.handleLine(line, opts));
    });
  }

  /** Terminate the running codex process, if any. */
  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  private handleLine(line: string, opts: CodexObserverOptions): void {
    const sid = codexSessionId(line);
    if (sid !== null) this.sessionId = sid;
    const event = parseCodexEvent(line, { sessionId: this.sessionId ?? undefined });
    if (event) opts.onEvent?.(event);
  }
}
