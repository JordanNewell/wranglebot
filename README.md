# WrangleBot

Deterministic guardrails, loop-breaking, and [.curt](https://curtisai.tech/curt) emission for coding agents (Claude Code, Codex).

Supervisors supervise. WrangleBot sits between your coding agent and its
tools and makes thrashing expensive: dangerous constructs get gated before
they execute, runaway loops get killed by deterministic signals, and every
decision lands in a `.curt` record.

## Install

```bash
npm install -g @wranglebot/cli
```

## Usage

```bash
# supervise a Claude Code run
wranglebot run claude-code "fix the failing tests" --workdir /path/to/repo --scope src --scope tests

# supervise a Codex run
wranglebot run codex "refactor the parser" --workdir /path/to/repo
```

Exit codes: `0` agent finished clean · `1` setup/supervision error · `2` agent denied (loop-breaker kill or guardrail deny).

## Guardrails

| Guardrail | What it does |
| --------- | ------------ |
| `ast-gate` | Tree-sitter parse of Edit/Write content (TS + Python). Denies `child_process`/`subprocess`; warns on destructive deletes outside the workdir, Python `eval`/`exec`, network egress. Parse errors fail open. |
| `scope-guard` | Real path containment (resolve + relative, Windows-safe). Denies writes outside the workdir/scope and to CI/config surfaces; warns on package-manifest writes. |
| `loop-breaker` | Deterministic kill signals: identical (tool, input) fingerprint ≥3 warn / ≥5 deny; byte-identical shell output ≥3 turns; same test-failure hash ≥4 deny. All thresholds configurable. |

Every supervised event is recorded and flushed to `<workdir>/.wranglebot/*.curt`
on exit — WrangleBot is the first consumer of the `.curt` format.

## Claude Code hook mode

Run WrangleBot as a native PreToolUse hook instead of a wrapper process:

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "wranglebot-hook" }] }]
  }
}
```

Deny/rewrite decisions ride `hookSpecificOutput.permissionDecision` and
`updatedInput`. Warn surfaces as an approval prompt (`ask`).

## Development

```bash
npm install --legacy-peer-deps
npm test        # vitest
npm run lint    # tsc --noEmit
```

## License

[BUSL-1.1](./LICENSE) — free for personal and noncommercial use; converts to MIT on 2030-10-16. Commercial use requires a written license from the Licensor.
