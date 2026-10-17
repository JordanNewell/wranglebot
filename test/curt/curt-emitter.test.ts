import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCurtConversation, parseCurt } from "curt-format";
import { CurtEmitter } from "../../src/curt/curt-emitter.js";
import type { CurtRecord } from "../../src/types.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wranglebot-curt-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function record(sessionId: string, ts: number, tool: string, action: "allow" | "deny"): CurtRecord {
  return {
    sessionId,
    ts,
    tool,
    verdict: action === "deny" ? { action: "deny", reason: "outside workdir" } : { action },
  };
}

describe("CurtEmitter", () => {
  it("round-trips N records through a .curt file with tool fields intact", () => {
    const dir = tmpDir();
    const emitter = new CurtEmitter({ sessionId: "sess_abc12345" });
    for (let i = 0; i < 5; i++) {
      emitter.add(record("sess_abc12345", 1700000000000 + i * 1000, i % 2 ? "Bash" : "Edit", i === 1 ? "deny" : "allow"));
    }
    expect(emitter.size).toBe(5);

    const file = emitter.flush(dir);
    expect(path.dirname(file)).toBe(dir);
    expect(file.endsWith(".curt")).toBe(true);

    const parsed = parseCurt(fs.readFileSync(file, "utf8"));
    expect(parsed).not.toBeNull();
    expect(isCurtConversation(parsed)).toBe(true);
    expect(parsed!.messages).toHaveLength(5);
    expect(parsed!.id).toBe("sess_abc12345");
    expect(parsed!.createdAt).toBe(1700000000000);
    expect(parsed!.updatedAt).toBe(1700000004000);

    const tools = parsed!.messages.map((m) => m.tool);
    expect(tools).toEqual(["Edit", "Bash", "Edit", "Bash", "Edit"]);
    const denied = JSON.parse(parsed!.messages[1]!.content) as { verdict: { action: string } };
    expect(denied.verdict.action).toBe("deny");
    // Underscored id gives curtFilename a stable suffix from the session id.
    expect(file).toContain("sess_abc12345".split("_").pop()!);
  });

  it("writes to an explicit file path verbatim", () => {
    const dir = tmpDir();
    const emitter = new CurtEmitter({ sessionId: "s2" });
    emitter.add(record("s2", 1, "Write", "allow"));
    const file = emitter.flush(path.join(dir, "out.curt"));
    expect(fs.existsSync(file)).toBe(true);
    expect(parseCurt(fs.readFileSync(file, "utf8"))!.messages).toHaveLength(1);
  });

  it("emits a generator string and optional provider/model", () => {
    const dir = tmpDir();
    const emitter = new CurtEmitter({
      sessionId: "s3",
      provider: "claude-code",
      model: "claude-sonnet-4-5",
    });
    emitter.add(record("s3", 5, "Edit", "allow"));
    const file = emitter.flush(dir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { generator?: string };
    const parsed = parseCurt(fs.readFileSync(file, "utf8"))!;
    expect(parsed.provider).toBe("claude-code");
    expect(parsed.model).toBe("claude-sonnet-4-5");
    expect(raw.generator).toContain("wranglebot");
  });

  it("rejects records from a foreign session", () => {
    const emitter = new CurtEmitter({ sessionId: "s1" });
    expect(() => emitter.add(record("other", 1, "Edit", "allow"))).toThrow(/sessionId/);
  });

  it("flushes an empty buffer to a spec-valid conversation", () => {
    const dir = tmpDir();
    const emitter = new CurtEmitter({ sessionId: "s4" });
    const file = emitter.flush(dir);
    const parsed = parseCurt(fs.readFileSync(file, "utf8"));
    expect(parsed).not.toBeNull();
    expect(parsed!.messages).toHaveLength(0);
  });
});
