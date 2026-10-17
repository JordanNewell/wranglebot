import { describe, expect, it } from "vitest";
import { handleHookInput } from "../../src/hooks/cc-hook.js";

function hookInput(toolInput: unknown, toolName = "Write") {
  return {
    session_id: "sess-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_01",
  };
}

describe("cc-hook handleHookInput", () => {
  it("emits the CC deny schema for child_process writes", () => {
    const out = JSON.parse(
      handleHookInput(
        hookInput({
          file_path: "src/run.ts",
          content: 'import { spawn } from "child_process";\n',
        }),
      ),
    ) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };

    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("child_process");
  });

  it("maps warn verdicts to 'ask'", () => {
    const out = JSON.parse(
      handleHookInput(
        hookInput({
          file_path: "scripts/fetch.py",
          content: 'import requests\nrequests.get("https://example.com")\n',
        }),
      ),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("allows plain code with the allow schema", () => {
    const out = JSON.parse(
      handleHookInput(
        hookInput({
          file_path: "src/util.ts",
          content: "export const one = 1;\n",
        }),
      ),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("allows syntax-error content with an explanatory reason", () => {
    const out = JSON.parse(
      handleHookInput(
        hookInput({ file_path: "broken.py", content: "def f(:\n" }),
      ),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("unparseable");
  });

  it("allows unknown extensions without evaluation", () => {
    const out = JSON.parse(
      handleHookInput(
        hookInput({
          file_path: "README.md",
          content: 'require("child_process")',
        }),
      ),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("allows non-gated tools immediately", () => {
    const out = JSON.parse(
      handleHookInput(hookInput({ command: "ls" }, "Bash")),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("tolerates malformed hook payloads (fails open, never throws)", () => {
    expect(() => handleHookInput(null)).not.toThrow();
    expect(() => handleHookInput({ tool_name: "Write" })).not.toThrow();
    const out = JSON.parse(handleHookInput(null));
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
