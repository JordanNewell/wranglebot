# Security Policy

## Supported versions

Only the latest minor release receives security updates.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Email **security@jordannewell.com** with:

- A description of the issue and its impact
- Reproduction steps (a minimal example is ideal)
- Affected version — run `wranglebot --version`

**Do not open a public GitHub issue** for security reports.

## Response timeline

- **Acknowledgment:** within 72 hours
- **Assessment:** within 7 days
- **Fix or mitigation:** within 30 days for high-severity issues

## Scope

**In scope:**

- The `wranglebot` CLI and supervisor daemon
- The guardrail pipeline (AST gate, scope guard, loop-breaker)
- Hook adapters (Claude Code PreToolUse, Codex observer)
- .curt emission

**Out of scope:**

- Findings in dependencies — report upstream
- Bypass of guardrails by a fully deterministic adversary who controls the
  supervised agent's model weights — WrangleBot raises the cost of thrashing,
  it does not sandbox a hostile model
- Denial of Service

## Design note

WrangleBot fails open on its own internal errors (a broken guardrail warns on
stderr and the agent proceeds). A fail-closed supervisor that bricks your
coding agent is worse than a gap; treat any fail-open path you disagree with
as a bug, not a feature.
