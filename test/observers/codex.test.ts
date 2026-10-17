import { describe, expect, it } from "vitest";
import {
  codexSessionId,
  parseCodexEvent,
} from "../../src/observers/codex.js";

// Fixtures mirror the documented `codex exec --json` JSONL streams.
// Modern: codex-rs/exec/src/exec_events.rs (ThreadEvent, tag "type";
// ThreadItemDetails tag "type" + snake_case, flattened into item).
// Legacy: codex-rs/protocol EventMsg wrapped as {"id":..., "msg":{...}}.

const THREAD_STARTED = `{"type":"thread.started","thread_id":"7f9a2b3c-1d4e-4f5a-9b6c-2e8d0a1f3c4b"}`;
const TURN_STARTED = `{"type":"turn.started"}`;
const TURN_COMPLETED = `{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":300,"reasoning_output_tokens":100}}`;

const ITEM_EXEC_STARTED = `{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"git status","aggregated_output":"","exit_code":null,"status":"in_progress"}}`;
const ITEM_EXEC_COMPLETED = `{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"git status","aggregated_output":"On branch main\\nnothing to commit, working tree clean\\n","exit_code":0,"status":"completed"}}`;

const ITEM_PATCH_STARTED = `{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"src/index.ts","kind":"update"}],"status":"in_progress"}}`;
const ITEM_PATCH_COMPLETED = `{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"src/index.ts","kind":"update"}],"status":"completed"}}`;

const ITEM_MCP = `{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"github","tool":"search_issues","arguments":{"q":"loop"},"status":"completed","result":{"content":[],"structured_content":null},"error":null}}`;

const LEGACY_CONV = "a1b2c3d4-0000-4000-8000-000000000000";
const LEGACY_SESSION_CONFIGURED = `{"id":"${LEGACY_CONV}","msg":{"type":"session_configured","session_id":"${LEGACY_CONV}","model":"gpt-5-codex","approval_policy":"on-request","sandbox_policy":{"mode":"workspace-write"},"cwd":"/repo","turn_context":null}}`;
const LEGACY_EXEC_BEGIN = `{"id":"${LEGACY_CONV}","msg":{"type":"exec_command_begin","call_id":"call_1","turn_id":"t1","started_at_ms":1760000000000,"command":["bash","-lc","cargo test"],"cwd":"/repo","parsed_cmd":["cargo","test"],"source":"agent"}}`;
const LEGACY_EXEC_END = `{"id":"${LEGACY_CONV}","msg":{"type":"exec_command_end","call_id":"call_1","turn_id":"t1","completed_at_ms":1760000002500,"command":["bash","-lc","cargo test"],"cwd":"/repo","aggregated_output":"test result: FAILED. 3 passed; 2 failed\\n","exit_code":101,"duration":2.5,"status":"failed"}}`;
const LEGACY_PATCH_BEGIN = `{"id":"${LEGACY_CONV}","msg":{"type":"patch_apply_begin","call_id":"call_2","turn_id":"t1","auto_approved":false,"changes":{"src/main.rs":{"kind":"update"}}}}`;
const LEGACY_PATCH_END = `{"id":"${LEGACY_CONV}","msg":{"type":"patch_apply_end","call_id":"call_2","turn_id":"t1","stdout":"","stderr":"","success":true,"changes":{"src/main.rs":{"kind":"update"}},"status":"completed"}}`;

const GARBAGE_LINES = [
  "",
  "not json at all",
  "{broken",
  "[]",
  "null",
  `{"type":"item.started"}`,
  `{"type":"item.completed","item":{"id":"item_9","type":"command_execution"}}`,
  `{"type":"totally_unknown_event","data":1}`,
  `{"id":"${LEGACY_CONV}","msg":{"type":"token_count","info":{}}}`,
  `{"id":"${LEGACY_CONV}","msg":{"type":"agent_message","message":"all done"}}`,
];

function sidOf(event: { sessionId: string } | null): string | null {
  return event ? event.sessionId : null;
}

describe("parseCodexEvent — modern thread events", () => {
  it("returns null for thread/turn lifecycle events", () => {
    expect(parseCodexEvent(THREAD_STARTED)).toBeNull();
    expect(parseCodexEvent(TURN_STARTED)).toBeNull();
    expect(parseCodexEvent(TURN_COMPLETED)).toBeNull();
  });

  it("maps item.started command_execution to a pre-execution shell event", () => {
    const event = parseCodexEvent(ITEM_EXEC_STARTED, {
      sessionId: "7f9a2b3c",
    });
    expect(event).toMatchObject({
      source: "codex",
      sessionId: "7f9a2b3c",
      tool: "shell",
      input: { command: "git status", itemId: "item_0" },
    });
    expect(event?.output).toBeUndefined();
  });

  it("maps item.completed command_execution with output attached", () => {
    const event = parseCodexEvent(ITEM_EXEC_COMPLETED);
    expect(event).toMatchObject({
      tool: "shell",
      input: { command: "git status", itemId: "item_0" },
    });
    expect(event?.output).toMatchObject({
      exit_code: 0,
      status: "completed",
    });
    expect(event?.output).toHaveProperty(
      "output",
      "On branch main\nnothing to commit, working tree clean\n",
    );
  });

  it("maps file_change items to edit events", () => {
    const started = parseCodexEvent(ITEM_PATCH_STARTED);
    const completed = parseCodexEvent(ITEM_PATCH_COMPLETED);
    expect(started?.tool).toBe("edit");
    expect(started?.input).toMatchObject({
      changes: [{ path: "src/index.ts", kind: "update" }],
    });
    expect(started?.output).toBeUndefined();
    expect(completed?.tool).toBe("edit");
    expect(completed?.output).toMatchObject({ status: "completed" });
  });

  it("maps mcp_tool_call items to namespaced mcp tools", () => {
    const event = parseCodexEvent(ITEM_MCP);
    expect(event?.tool).toBe("mcp:github.search_issues");
    expect(event?.output).toMatchObject({ status: "completed" });
  });
});

describe("parseCodexEvent — legacy EventMsg stream", () => {
  it("returns null for session_configured but extracts its session id", () => {
    expect(parseCodexEvent(LEGACY_SESSION_CONFIGURED)).toBeNull();
    expect(codexSessionId(LEGACY_SESSION_CONFIGURED)).toBe(LEGACY_CONV);
  });

  it("attributes legacy events to the wrapper conversation id", () => {
    const event = parseCodexEvent(LEGACY_EXEC_BEGIN);
    expect(sidOf(event)).toBe(LEGACY_CONV);
    expect(event?.tool).toBe("shell");
    expect(event?.input).toMatchObject({
      command: ["bash", "-lc", "cargo test"],
      cwd: "/repo",
    });
    expect(event?.output).toBeUndefined();
  });

  it("maps exec_command_end with output and exit code", () => {
    const event = parseCodexEvent(LEGACY_EXEC_END);
    expect(event?.tool).toBe("shell");
    expect(event?.output).toMatchObject({
      exit_code: 101,
      status: "failed",
    });
    expect(event?.output).toHaveProperty(
      "output",
      "test result: FAILED. 3 passed; 2 failed\n",
    );
  });

  it("maps patch_apply_begin/end to edit events", () => {
    const begin = parseCodexEvent(LEGACY_PATCH_BEGIN);
    const end = parseCodexEvent(LEGACY_PATCH_END);
    expect(begin?.tool).toBe("edit");
    expect(begin?.output).toBeUndefined();
    expect(end?.tool).toBe("edit");
    expect(end?.output).toMatchObject({ success: true, status: "completed" });
  });
});

describe("parseCodexEvent — session id extraction", () => {
  it("extracts thread_id from thread.started", () => {
    expect(codexSessionId(THREAD_STARTED)).toBe(
      "7f9a2b3c-1d4e-4f5a-9b6c-2e8d0a1f3c4b",
    );
  });

  it("returns null for lines without a session id", () => {
    expect(codexSessionId(TURN_STARTED)).toBeNull();
    expect(codexSessionId(ITEM_EXEC_STARTED)).toBeNull();
    expect(codexSessionId("garbage")).toBeNull();
  });
});

describe("parseCodexEvent — graceful on garbage", () => {
  it("returns null for every unparseable or unrecognized line", () => {
    for (const line of GARBAGE_LINES) {
      expect(parseCodexEvent(line)).toBeNull();
    }
  });
});
