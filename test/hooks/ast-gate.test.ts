import { describe, expect, it } from "vitest";
import { AstGate } from "../../src/hooks/ast-gate.js";
import type { AgentEvent } from "../../src/types.js";

const gate = new AstGate({ workdir: process.cwd() });

function editEvent(input: unknown, tool = "Write"): AgentEvent {
  return {
    ts: Date.now(),
    source: "claude-code",
    sessionId: "test-session",
    tool,
    input,
  };
}

function writeInput(filePath: string, content: string) {
  return { file_path: filePath, content };
}

describe("AstGate", () => {
  it("denies child_process import in TypeScript", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "src/run.ts",
          'import { spawn } from "child_process";\nspawn("ls", ["-la"]);\n',
        ),
      ),
    );
    expect(v).not.toBeNull();
    expect(v?.action).toBe("deny");
    expect(v?.reason).toContain("child_process");
  });

  it("denies require('child_process') and dynamic import in JS", () => {
    for (const code of [
      'const cp = require("child_process");\ncp.execSync("ls");\n',
      'const cp = await import("node:child_process");\n',
    ]) {
      const v = gate.inspect(editEvent(writeInput("tool.js", code)));
      expect(v?.action).toBe("deny");
    }
  });

  it("denies subprocess import and calls in Python", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "scripts/run.py",
          'import subprocess\nsubprocess.run(["ls"])\n',
        ),
      ),
    );
    expect(v?.action).toBe("deny");
    expect(v?.reason).toContain("subprocess");
  });

  it("warns on requests.get in Python", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "scripts/fetch.py",
          'import requests\nr = requests.get("https://example.com")\nprint(r.status_code)\n',
        ),
      ),
    );
    expect(v?.action).toBe("warn");
    expect(v?.reason).toContain("requests.get");
  });

  it("warns on fetch call in TypeScript", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "src/api.ts",
          'export async function ping(): Promise<number> {\n  const res = await fetch("https://example.com");\n  return res.status;\n}\n',
        ),
      ),
    );
    expect(v?.action).toBe("warn");
    expect(v?.reason).toContain("fetch");
  });

  it("warns on eval/exec in Python", () => {
    const v = gate.inspect(
      editEvent(
        writeInput("scripts/dyn.py", 'value = eval("1 + 1")\n'),
      ),
    );
    expect(v?.action).toBe("warn");
    expect(v?.reason).toContain("eval");
  });

  it("warns on deletion outside the workdir", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "src/clean.ts",
          'import fs from "fs";\nfs.rmSync("C:/Windows/Temp", { recursive: true, force: true });\n',
        ),
      ),
    );
    expect(v?.action).toBe("warn");
    expect(v?.reason).toContain("fs.rmSync");
  });

  it("allows deletion of paths inside the workdir", () => {
    const v = gate.inspect(
      editEvent(
        writeInput(
          "src/clean.ts",
          'import fs from "fs";\nfs.rmSync("./dist", { recursive: true, force: true });\n',
        ),
      ),
    );
    expect(v?.action).toBe("allow");
  });

  it("allows plain code", () => {
    const ts = gate.inspect(
      editEvent(
        writeInput(
          "src/util.ts",
          'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
        ),
      ),
    );
    expect(ts?.action).toBe("allow");

    const py = gate.inspect(
      editEvent(
        writeInput("util.py", "def add(a, b):\n    return a + b\n"),
      ),
    );
    expect(py?.action).toBe("allow");
  });

  it("allows with reason on syntax errors (never false-positive deny)", () => {
    const v = gate.inspect(
      editEvent(writeInput("broken.py", "def f(:\n  pass\n")),
    );
    expect(v?.action).toBe("allow");
    expect(v?.reason).toContain("unparseable");
  });

  it("returns null (not gated) for unknown file extensions", () => {
    const v = gate.inspect(
      editEvent(
        writeInput("notes.md", 'import { spawn } from "child_process";\n'),
      ),
    );
    expect(v).toBeNull();
  });

  it("returns null for non-edit tools", () => {
    const v = gate.inspect(
      editEvent({ command: 'import "child_process"' }, "Bash"),
    );
    expect(v).toBeNull();
  });

  it("handles MultiEdit and Edit input shapes", () => {
    const multi = gate.inspect(
      editEvent({
        file_path: "a.ts",
        edits: [{ old_string: "a", new_string: 'require("child_process")' }],
      }, "MultiEdit"),
    );
    expect(multi?.action).toBe("deny");

    const edit = gate.inspect(
      editEvent({
        file_path: "b.py",
        old_string: "x = 1",
        new_string: 'value = eval(input())',
      }, "Edit"),
    );
    expect(edit?.action).toBe("warn");
  });

  it("exposes name and no-op observe per the Guardrail contract", () => {
    expect(gate.name).toBe("ast-gate");
    expect(() => gate.observe(editEvent({}))).not.toThrow();
  });
});
