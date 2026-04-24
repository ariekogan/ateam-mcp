# Security

## Reporting a vulnerability

Please report security issues privately to **ariekogan33@gmail.com**.
Do not open a public GitHub issue for security vulnerabilities.

When possible, include: reproduction steps, affected version, potential
impact, and any suggested mitigation.

## Known fixed issues — upgrade guidance

Upgrade to the latest version to receive all security fixes. For details see
[CHANGELOG.md](CHANGELOG.md).

### 0.3.31 (2026-04-24)
- **CRITICAL** (HTTP mode only): Cross-user OAuth bearer cache could auth
  User B as User A when User B sent an unauth'd MCP request while User A's
  token was cached. Stdio mode was unaffected. Users running
  `mcp.ateam-ai.com` or any self-hosted multi-user deployment must upgrade.
- **High**: Silent tenant fallback to `"main"` on malformed API keys.
- **Medium**: Bearer tokens logged as `substring(0, 25-30)` prefixes.

## Supported versions

| Version | Supported |
|---|---|
| 0.3.31 and later | ✅ |
| 0.3.30 and earlier | ❌ — contains CRITICAL HTTP-mode auth bug. Upgrade immediately if running in HTTP mode. |

## Cross-repo context

This package is part of the ADAS platform. The master security audit log —
covering all repos (ADAS Core, Skill Builder, PB, ateam-mobile, this one) —
is at:

→ https://github.com/ariekogan/ai-dev-assistant/blob/main/Docs/security/SESSION_2026_04_24_SUMMARY.md

Relevant findings for this package: **#28, #29, #30** (round 009).

## Safe checkpoints

This repo has `safe-2026-04-24-001` through `safe-2026-04-24-007` and
`safe-2026-04-24-009` tags. Rounds 008 and 010–012 did not touch this
package.
