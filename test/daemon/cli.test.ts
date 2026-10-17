import { describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../../src/daemon/cli.js";

describe("parseArgs", () => {
  it("parses a valid claude-code run", () => {
    const parsed = parseArgs([
      "run",
      "claude-code",
      "fix",
      "the",
      "bug",
      "--workdir",
      "/tmp/proj",
      "--scope",
      "src",
      "--scope",
      "tests",
    ]);
    expect(parsed.command).toBe("run");
    expect(parsed.options.agent).toBe("claude-code");
    expect(parsed.options.prompt).toBe("fix the bug");
    expect(parsed.options.workdir).toBe("/tmp/proj");
    expect(parsed.options.scope).toEqual(["src", "tests"]);
  });

  it("parses codex with defaults", () => {
    const parsed = parseArgs(["run", "codex", "hello"]);
    expect(parsed.options.agent).toBe("codex");
    expect(parsed.options.workdir).toBeUndefined();
    expect(parsed.options.scope).toEqual([]);
  });

  it("rejects unknown agents", () => {
    expect(() => parseArgs(["run", "gpt", "hi"])).toThrow(/unknown agent/);
    expect(() => parseArgs(["run"])).toThrow(/unknown agent/);
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseArgs(["watch", "claude-code"])).toThrow(/unknown command/);
    expect(() => parseArgs(["run", "claude-code", "--wat"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["run", "claude-code", "--scope"])).toThrow(/requires a value/);
  });
});

describe("main", () => {
  it("exits non-zero for an unknown agent", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["run", "gpt"])).toBe(1);
    err.mockRestore();
  });

  it("exits non-zero when the codex agent cannot run", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const prev = process.env["CODEX_PATH"];
    process.env["CODEX_PATH"] = "Z:\\definitely-not-real\\wranglebot-fake-codex";
    try {
      expect(await main(["run", "codex", "hi"])).toBe(1);
    } finally {
      if (prev === undefined) delete process.env["CODEX_PATH"];
      else process.env["CODEX_PATH"] = prev;
      err.mockRestore();
    }
  });
});
