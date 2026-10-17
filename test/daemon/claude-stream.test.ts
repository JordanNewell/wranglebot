import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { claudeArgs, parseStreamLine, runClaudeStream } from "../../src/daemon/claude-stream.js";

function toolUseLine(name: string, input: unknown) {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name, input }] },
  });
}

function fakeChild() {
  const child = new PassThrough() as unknown as ChildProcess & { stdout: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("parseStreamLine", () => {
  it("maps tool_use blocks to AgentEvents", () => {
    const events = parseStreamLine(toolUseLine("Edit", { file: "a.ts" }), "s1", 42);
    expect(events).toEqual([
      { ts: 42, source: "claude-code", sessionId: "s1", tool: "Edit", input: { file: "a.ts" } },
    ]);
  });

  it("maps multiple tool_use blocks in one line", () => {
    const raw = JSON.stringify({
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: {} },
          { type: "tool_use", name: "Read", input: { path: "x" } },
        ],
      },
    });
    expect(parseStreamLine(raw, "s1", 1)).toHaveLength(2);
  });

  it("ignores non-tool events", () => {
    expect(parseStreamLine(JSON.stringify({ type: "system" }), "s1", 1)).toEqual([]);
    expect(
      parseStreamLine(JSON.stringify({ message: { content: [{ type: "text", text: "x" }] } }), "s1", 1),
    ).toEqual([]);
    expect(
      parseStreamLine(
        JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash" }] } }),
        "s1",
        1,
      ),
    ).toEqual([]); // no input
  });

  it("ignores malformed JSON", () => {
    expect(parseStreamLine("{not json", "s1", 1)).toEqual([]);
  });
});

describe("runClaudeStream", () => {
  it("spawns claude with stream-json args and emits mapped events", () => {
    const spawnFn = vi.fn(() => fakeChild());
    const onEvent = vi.fn();
    runClaudeStream({ sessionId: "s1", prompt: "do it", workdir: "/tmp", spawnFn, onEvent });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnFn.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(cmd).toBe("claude");
    expect(args).toEqual(claudeArgs("do it"));
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(opts.cwd).toBe("/tmp");

    const child = spawnFn.mock.results[0]!.value as ReturnType<typeof fakeChild>;
    child.stdout.write(toolUseLine("Bash", { command: "ls" }) + "\n");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "Bash", source: "claude-code", sessionId: "s1" }),
    );
  });

  it("survives garbage lines without emitting", () => {
    const spawnFn = vi.fn(() => fakeChild());
    const onEvent = vi.fn();
    runClaudeStream({ sessionId: "s1", prompt: "p", spawnFn, onEvent });
    const child = spawnFn.mock.results[0]!.value as ReturnType<typeof fakeChild>;
    child.stdout.write("garbage\n");
    child.stdout.write("\n");
    expect(onEvent).not.toHaveBeenCalled();
  });
});
