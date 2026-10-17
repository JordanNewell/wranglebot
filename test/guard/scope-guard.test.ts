import { describe, expect, it } from "vitest";
import path from "node:path";
import { ScopeGuard } from "../../src/guard/scope-guard.js";
import type { AgentEvent } from "../../src/types.js";

function editEvent(input: unknown, tool = "Edit"): AgentEvent {
  return { ts: Date.now(), source: "claude-code", sessionId: "s1", tool, input };
}

// Synthetic root derived from cwd so the suite runs identically on AEON
// (E:\dev\...) and CI checkouts (D:\a\..., /home/...). Pure path math — no
// filesystem access — so the directories need not exist.
const ROOT = path.resolve(process.cwd(), "..", "sg-fixture-root");
const WORKDIR = path.join(ROOT, "wranglebot");
const SIBLING = path.join(ROOT, "wranglebot-evil");
const ELSEWHERE = path.join(ROOT, "other");
const SHARED = path.join(ROOT, "shared", "docs");

describe("ScopeGuard", () => {
  it("allows writes inside the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(WORKDIR, "src", "x.ts") }));
    expect(v?.action).toBe("allow");
  });

  it("allows relative paths that resolve inside the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const rel = path.relative(process.cwd(), path.join(WORKDIR, "src", "x.ts"));
    const v = guard.inspect(editEvent({ file_path: rel }));
    expect(v?.action).toBe("allow");
  });

  it("denies sibling-directory writes and names the violated boundary", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(ELSEWHERE, "x.ts") }));
    expect(v?.action).toBe("deny");
    expect(v?.reason).toContain("outside workdir");
  });

  it("denies sibling directories that merely share a string prefix", () => {
    // "wranglebot-evil" shares the "wranglebot" prefix but is not inside it.
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(SIBLING, "x.ts") }));
    expect(v?.action).toBe("deny");
  });

  it("allows writes under an allowedPath outside the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [SHARED], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(SHARED, "notes.md") }));
    expect(v?.action).toBe("allow");
  });

  it("allows path traversal that escapes then re-enters the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(
      editEvent({ file_path: path.join(WORKDIR, "src", "..", "..", "wranglebot", "ok.ts") }),
    );
    expect(v?.action).toBe("allow");
  });

  it("denies path traversal that escapes the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join("..", "..", "etc", "passwd") }));
    expect(v?.action).toBe("deny");
  });

  it("denies .git writes inside the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(WORKDIR, ".git", "config") }));
    expect(v?.action).toBe("deny");
    expect(v?.reason).toContain("denied pattern");
  });

  it("denies .github/workflows writes inside the workdir", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(
      editEvent({ file_path: path.join(WORKDIR, ".github", "workflows", "ci.yml") }),
    );
    expect(v?.action).toBe("deny");
  });

  it("honors constructor-extensible deniedPatterns", () => {
    const guard = new ScopeGuard({
      allowedPaths: [],
      workdir: WORKDIR,
      deniedPatterns: ["secrets/"],
    });
    const v = guard.inspect(editEvent({ file_path: path.join(WORKDIR, "secrets", "k.md") }));
    expect(v?.action).toBe("deny");
  });

  it("warns on package.json writes", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    const v = guard.inspect(editEvent({ file_path: path.join(WORKDIR, "package.json") }));
    expect(v?.action).toBe("warn");
    expect(v?.reason).toContain("manifest");
  });

  it("warns on requirements.txt and package-lock.json writes", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    expect(guard.inspect(editEvent({ file_path: path.join(WORKDIR, "requirements.txt") }))?.action).toBe("warn");
    expect(
      guard.inspect(editEvent({ file_path: path.join(WORKDIR, "package-lock.json") }))
        ?.action,
    ).toBe("warn");
  });

  it.skipIf(path.sep !== "\\")("is case-insensitive on Windows paths", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: "e:\\dev\\PROJECTS\\WRANGLEBOT" });
    const allow = guard.inspect(editEvent({ file_path: "E:\\DEV\\projects\\WrangleBot\\src\\a.ts" }));
    expect(allow?.action).toBe("allow");
    const deny = guard.inspect(editEvent({ file_path: "E:\\dev\\projects\\WRANGLEBOT\\.GIT\\config" }));
    expect(deny?.action).toBe("deny");
  });

  it("reads notebook_path and plain path fields", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    expect(guard.inspect(editEvent({ notebook_path: path.join(WORKDIR, "n.ipynb") }))?.action).toBe("allow");
    expect(guard.inspect(editEvent({ path: path.join(ELSEWHERE, "x.ts") }))?.action).toBe("deny");
  });

  it("returns null for non-file tools and observes nothing", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    expect(guard.inspect(editEvent({ command: "ls" }, "Bash"))).toBeNull();
    expect(guard.observe(editEvent({}))).toBeUndefined();
  });

  it("keeps the guardrail name from the contract", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: WORKDIR });
    expect(guard.name).toBe("scope-guard");
  });

  it("resolves workdir relative to cwd", () => {
    const guard = new ScopeGuard({ allowedPaths: [], workdir: path.resolve(WORKDIR) });
    expect(guard.inspect(editEvent({ file_path: path.join(WORKDIR, "src", "b.ts") }))?.action).toBe("allow");
  });
});
