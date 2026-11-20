<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/leverframe/wranglebot/main/site/brand/wranglebot-lockup-on-dark.svg">
    <img src="https://raw.githubusercontent.com/leverframe/wranglebot/main/site/brand/wranglebot-lockup-on-light.svg" alt="WrangleBot" width="520">
  </picture>
</p>

<p align="center">
  <strong>Deterministic guardrails, loop-breaking, and <a href="https://curtisai.tech/curt">.curt</a> emission for coding agents.</strong><br>
  Claude Code · Codex
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@wranglebot/cli"><img src="https://img.shields.io/npm/v/@wranglebot/cli?style=flat-square&labelColor=0E1116&color=FFB224" alt="npm version"></a>
  <a href="https://github.com/leverframe/wranglebot/actions/workflows/ci.yml"><img src="https://github.com/leverframe/wranglebot/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/leverframe/wranglebot/actions/workflows/codeql.yml"><img src="https://github.com/leverframe/wranglebot/actions/workflows/codeql.yml/badge.svg?branch=main" alt="CodeQL"></a>
  <a href="https://github.com/leverframe/wranglebot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1%20%E2%86%92%20MIT%202030-0E1116?style=flat-square&labelColor=0E1116&color=FFB224" alt="BUSL-1.1"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-0E1116?style=flat-square&labelColor=0E1116&color=FFB224" alt="node >= 20">
</p>

---

Supervisors supervise. WrangleBot sits between your coding agent and its
tools and makes thrashing expensive: dangerous constructs get gated before
they execute, runaway loops get killed by deterministic signals, and every
decision lands in a `.curt` record.

No model calls. No heuristics trained on vibes. Three deterministic
guardrails, every turn:

| Guardrail | What it does |
| --------- | ------------ |
| `ast-gate` | Tree-sitter parse of Edit/Write content (TS + Python). Denies `child_process`/`subprocess`; warns on destructive deletes outside the workdir, Python `eval`/`exec`, network egress. Parse errors fail open. |
| `scope-guard` | Real path containment (resolve + relative, Windows-safe). Denies writes outside the workdir/scope and to CI/config surfaces; warns on package-manifest writes. |
| `loop-breaker` | Deterministic kill signals: identical (tool, input) fingerprint ≥3 warn / ≥5 deny; byte-identical shell output ≥3 turns; same test-failure hash ≥4 deny. All thresholds configurable. |

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

## .curt sessions

Every supervised event is recorded and flushed to `<workdir>/.wranglebot/*.curt`
on exit — WrangleBot is the first consumer of the `.curt` format, so sessions
replay anywhere the format goes.

## Documentation

Full docs at **[wranglebot.com/docs](https://wranglebot.com/docs)** · changelog at [wranglebot.com/changelog](https://wranglebot.com/changelog).

## Development

```bash
npm install --legacy-peer-deps
npm test        # vitest
npm run lint    # tsc --noEmit
```

## Security

Security policy and reporting: [SECURITY.md](./SECURITY.md) — email
security@jordannewell.com, never open a public issue. Only the latest
minor release receives security updates.

## License

[BUSL-1.1](./LICENSE) — free for personal and noncommercial use; converts
to MIT on 2030-10-16. Commercial use requires a written license from the
Licensor.
