import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  fingerprint,
  LoopBreaker,
} from "../../src/loopbreak/loop-breaker.js";
import type { AgentEvent } from "../../src/types.js";

function ev(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ts: 1760000000000,
    source: "codex",
    sessionId: "s1",
    tool: "shell",
    input: { command: "npm test" },
    ...overrides,
  };
}

/** Run one scripted event through the full inspect-then-observe cycle. */
function cycle(breaker: LoopBreaker, event: AgentEvent) {
  const verdict = breaker.inspect(event);
  breaker.observe(event);
  return verdict;
}

describe("identical (tool, input) fingerprint loop", () => {
  it("warns on the 3rd identical call and denies on the 5th", () => {
    const breaker = new LoopBreaker();
    const verdicts = [];
    for (let i = 1; i <= 5; i++) {
      // Vary output so the no-progress detector stays out of the way.
      verdicts.push(cycle(breaker, ev({ output: `attempt ${i} output` })));
    }
    expect(verdicts[0]).toBeNull();
    expect(verdicts[1]).toBeNull();
    expect(verdicts[2]).toMatchObject({ action: "warn" });
    expect(verdicts[3]).toMatchObject({ action: "warn" });
    expect(verdicts[4]).toMatchObject({ action: "deny" });
    expect(verdicts[4]?.reason).toContain("kill");
  });

  it("does not count different inputs as the same loop", () => {
    const breaker = new LoopBreaker();
    for (let i = 1; i <= 4; i++) {
      cycle(
        breaker,
        ev({ input: { command: `echo variant ${i}` }, output: `out ${i}` }),
      );
    }
    expect(breaker.inspect(ev({ input: { command: "echo variant 5" } })))
      .toBeNull();
  });

  it("tracks sessions independently and reset() clears a single session", () => {
    const breaker = new LoopBreaker();
    for (let i = 1; i <= 3; i++) {
      cycle(breaker, ev({ sessionId: "s1", output: `out ${i}` }));
    }
    // s2 is untouched by s1's loop.
    expect(cycle(breaker, ev({ sessionId: "s2", output: "s2 out" }))).toBeNull();

    breaker.reset("s1");
    expect(cycle(breaker, ev({ sessionId: "s1", output: "fresh" }))).toBeNull();

    // After reset("s1") the counter restarts at 1 — two more attempts stay silent.
    expect(cycle(breaker, ev({ sessionId: "s1", output: "again 2" }))).toBeNull();
  });

  it("reset() with no argument clears all sessions", () => {
    const breaker = new LoopBreaker();
    for (let i = 1; i <= 4; i++) {
      cycle(breaker, ev({ sessionId: "s1", output: `out ${i}` }));
      cycle(breaker, ev({ sessionId: "s2", output: `out ${i}` }));
    }
    breaker.reset();
    expect(cycle(breaker, ev({ sessionId: "s1", output: "x1" }))).toBeNull();
    expect(cycle(breaker, ev({ sessionId: "s2", output: "x1" }))).toBeNull();
  });
});

describe("no-progress detection", () => {
  const frozen = "Error: cannot find module 'left-pad'\n    at require.js:1:1";

  it("warns after 3 consecutive identical shell outputs", () => {
    const breaker = new LoopBreaker();
    // Turn structure: each turn re-runs a (different) command but the output
    // is byte-identical — the classic stuck loop.
    const verdicts = [
      cycle(breaker, ev({ input: { command: "run 1" }, output: frozen })),
      cycle(breaker, ev({ input: { command: "run 2" }, output: frozen })),
      cycle(breaker, ev({ input: { command: "run 3" }, output: frozen })),
    ];
    expect(verdicts[0]).toBeNull();
    expect(verdicts[1]).toBeNull();
    expect(verdicts[2]).toBeNull(); // streak hits 3 during observe of turn 3
    // The next gate sees the no-progress state and warns.
    const next = breaker.inspect(
      ev({ input: { command: "run 4" }, output: "different output" }),
    );
    expect(next).toMatchObject({ action: "warn" });
    expect(next?.reason).toContain("no progress");
  });

  it("breaks the streak when output changes", () => {
    const breaker = new LoopBreaker();
    cycle(breaker, ev({ input: { command: "a" }, output: frozen }));
    cycle(breaker, ev({ input: { command: "b" }, output: frozen }));
    cycle(breaker, ev({ input: { command: "c" }, output: "all good\n" }));
    const verdict = breaker.inspect(
      ev({ input: { command: "d" }, output: "still good\n" }),
    );
    expect(verdict).toBeNull();
  });

  it("warn threshold is configurable", () => {
    const breaker = new LoopBreaker({ noProgressWarnThreshold: 2 });
    cycle(breaker, ev({ output: "same" }));
    cycle(breaker, ev({ output: "same" })); // streak hits 2 during observe
    const verdict = breaker.inspect(ev({ output: "same" }));
    expect(verdict).toMatchObject({ action: "warn" });
  });
});

describe("identical test-failure hashing", () => {
  const failure =
    "FAIL src/app.test.ts\n" +
    "  × handles empty input\n" +
    "    AssertionError: expected [] to have length 1\n" +
    "\n" +
    "Tests  1 failed | 12 passed\n";

  it("denies after the 4th identical failure, even across different commands", () => {
    const breaker = new LoopBreaker();
    const verdicts = [];
    for (let i = 1; i <= 4; i++) {
      verdicts.push(
        cycle(
          breaker,
          ev({ input: { command: `npm test -- filter${i}` }, output: failure }),
        ),
      );
    }
    expect(verdicts[0]).toBeNull();
    expect(verdicts[1]).toBeNull();
    expect(verdicts[2]).toBeNull();
    expect(verdicts[3]).toMatchObject({ action: "deny" });
  });

  it("does not group distinct failures or successful output", () => {
    const breaker = new LoopBreaker();
    for (let i = 1; i <= 4; i++) {
      cycle(
        breaker,
        ev({
          input: { command: `cmd ${i}` },
          output: `FAIL case ${i}\n  × different error each time ${i}\n`,
        }),
      );
    }
    // Distinct failure signatures each time, inputs differ — nothing trips.
    expect(
      breaker.inspect(ev({ input: { command: "cmd 5" }, output: "ok\n" })),
    ).toBeNull();
  });

  it("never fires on healthy output", () => {
    const breaker = new LoopBreaker();
    for (let i = 1; i <= 4; i++) {
      cycle(
        breaker,
        ev({ input: { command: `build ${i}` }, output: `built in ${i}s\n` }),
      );
    }
    expect(
      breaker.inspect(ev({ input: { command: "build 5" }, output: "built\n" })),
    ).toBeNull();
  });
});

describe("fingerprint helpers", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ a: 1, b: [2, { c: 3 }] })).toBe(
      canonicalJson({ b: [2, { c: 3 }], a: 1 }),
    );
    expect(fingerprint("shell", { a: 1, b: 2 })).toBe(
      fingerprint("shell", { b: 2, a: 1 }),
    );
  });

  it("distinguishes tool and input differences", () => {
    expect(fingerprint("shell", { a: 1 })).not.toBe(
      fingerprint("edit", { a: 1 }),
    );
    expect(fingerprint("shell", { a: 1 })).not.toBe(
      fingerprint("shell", { a: 2 }),
    );
  });
});
