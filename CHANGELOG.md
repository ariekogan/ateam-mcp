# Changelog

## 0.3.31 — 2026-04-24

### Security

**Users running ateam-mcp in HTTP mode (e.g. `mcp.ateam-ai.com` or any
self-hosted multi-user deployment) must upgrade.** Stdio users (Claude
Desktop, Claude Code local, ChatGPT desktop) are unaffected by the CRITICAL
fix but should still upgrade for the silent-fallback and log hygiene
improvements.

- **CRITICAL (HTTP mode):** Cross-user OAuth bearer cache. Previous versions
  kept a process-global `recentTokens` Map and injected the newest cached
  token into any request arriving without an `Authorization` header
  (`autoInjectToken` middleware). With multiple simultaneous users, this let
  User B's unauth'd MCP request auto-inject User A's token — effectively
  authenticating User B as User A. Cache is now keyed by client IP, and the
  TTL is shortened from 60 min to 5 min (intended as an OAuth → first-MCP
  handshake window, not a session).
- **High:** Removed silent fallback to tenant `"main"` in
  `setSessionCredentials`, `getCredentials`, and master-mode `headers`.
  Malformed API keys or missing tenant args now throw instead of silently
  targeting a default tenant (matching the pattern fixed in the broader
  ADAS audit at memory-mcp, docs-index-mcp, nutrition-mcp).
- **Medium:** Redacted bearer tokens and API keys across 7 log sites
  (`src/http.js:53`, `src/api.js:189`, `src/stub.js` — 6 sites). Previously
  logged as `substring(0, 25-30)` prefixes, which is enough entropy for
  narrowing attacks if logs are indexed or shipped externally.

Full audit context:
https://github.com/ariekogan/ai-dev-assistant/blob/main/Docs/security/SESSION_2026_04_24_SUMMARY.md
(findings #28–30, round 009).

### Non-security

No functional changes in this release.

## 0.3.30 and earlier

See commit history (`git log`). Prior releases were not tracked in this
CHANGELOG; it was introduced with 0.3.31 as part of the security audit.
