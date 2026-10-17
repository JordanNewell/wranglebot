import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, Guardrail, Verdict } from "../../src/types.js";
import { createPipeline } from "../../src/daemon/pipeline.js";
import { SupervisorSession } from "../../src/daemon/session.js";

function makeEvent(tool = "Bash"): AgentEvent {
  return { ts: 1, source: "claude-code", sessionId: "s1", tool, input: { command: "ls" } };
}

function guardrail(name: string, verdict: Verdict | null = null) {
  return {
    name,
    inspect: vi.fn(() => verdict),
    observe: vi.fn(),
  } satisfies Guardrail;
}

describe("SupervisorSession", () => {
  it("allows when no guardrail objects", () => {
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [] });
    expect(s.handle(makeEvent())).toEqual({ action: "allow" });
  });

  it("allows when all guardrails return null", () => {
    const g = guardrail("passive");
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [g] });
    expect(s.handle(makeEvent()).action).toBe("allow");
    expect(g.inspect).toHaveBeenCalledOnce();
  });

  it("first deny wins and short-circuits later guardrails", () => {
    const a = guardrail("a", { action: "deny", reason: "no" });
    const b = guardrail("b", { action: "deny", reason: "also no" });
    const c = guardrail("c");
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [a, b, c] });
    expect(s.handle(makeEvent())).toEqual({ action: "deny", reason: "no" });
    expect(c.inspect).not.toHaveBeenCalled();
  });

  it("first rewrite wins and carries updatedInput", () => {
    const a = guardrail("a", { action: "rewrite", updatedInput: { command: "echo hi" } });
    const b = guardrail("b", { action: "deny" });
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [a, b] });
    expect(s.handle(makeEvent())).toEqual({
      action: "rewrite",
      updatedInput: { command: "echo hi" },
    });
  });

  it("warn does not win — falls through to allow", () => {
    const a = guardrail("a", { action: "warn", reason: "meh" });
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [a] });
    expect(s.handle(makeEvent()).action).toBe("allow");
  });

  it("runs observe() on every guardrail even after a deny", () => {
    const a = guardrail("a", { action: "deny" });
    const b = guardrail("b");
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [a, b] });
    s.handle(makeEvent());
    expect(a.observe).toHaveBeenCalledOnce();
    expect(b.observe).toHaveBeenCalledOnce();
  });

  it("appends every handled event to the log", () => {
    const s = new SupervisorSession({ sessionId: "s1", guardrails: [] });
    s.handle(makeEvent("Edit"));
    s.handle(makeEvent("Bash"));
    expect(s.events).toHaveLength(2);
    expect(s.events[1]?.tool).toBe("Bash");
  });
});

describe("createPipeline", () => {
  it("creates a session with a generated sessionId and wired guardrails", () => {
    const g = guardrail("p1");
    const s = createPipeline({ sources: ["claude-code"], guardrails: [g] });
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.sources).toEqual(["claude-code"]);
    expect(s.handle(makeEvent())).toEqual({ action: "allow" });
    expect(g.observe).toHaveBeenCalledOnce();
  });

  it("rejects non-array config", () => {
    expect(() =>
      createPipeline({ sources: "claude-code" as unknown as [], guardrails: [] }),
    ).toThrow(TypeError);
  });
});
