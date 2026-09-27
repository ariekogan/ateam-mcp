# Changelog

## Unreleased

## 0.4.106 — 2026-09-27

### HTTP mode

- The 401 on `/mcp` now names `/.well-known/oauth-protected-resource/mcp`,
  the metadata whose `resource` is `/mcp`. It named the root document on both
  mounts, so a client checking `resource` against the URL it called (RFC 9728
  §3.3) was sent to metadata for a different resource. `/` is unchanged.
- `WWW-Authenticate` is now in `Access-Control-Expose-Headers`, so a
  browser-hosted client can read the challenge it is sent.
- A legacy bearer (`adas_<32 hex>`) no longer answers every request with a
  500. Its tenant is asked of `/auth/whoami` on the server's API; if that
  cannot place it, the session is left signed out and tenant tools say so.

### Tools

- Every tool declares MCP safety hints (`readOnlyHint`, `destructiveHint`).
  A tool that runs code this server cannot see is `destructiveHint: true`:
  `ateam_test_connector`, `ateam_verify` (its connector smoke call),
  `ateam_test_skill`, `ateam_conversation`, `ateam_test_voice`,
  `ateam_solution_chat` and `ateam_verify_surface` (the plugin's own JS makes
  live tool calls). A client may therefore ask before running them.
- `ateam_patch`'s validation verdict reaches the caller. It had been read from
  a route the API has never served, so it was always silently absent. The
  verdict is advisory, and it no longer says `build_and_run` refuses an invalid
  skill: `build_and_run`'s gate is the solution validator, which does not run
  this per-skill check.

## 0.4.93 — 2026-09-11

### Breaking (HTTP mode)

**An HTTP request must carry a credential. Anonymous requests to `/mcp` are
refused.** Until 0.4.93, `/mcp` let a request with no `Authorization` through,
so a client could initialize anonymously and then call `ateam_auth(api_key)`.
Both mounts (`/` and `/mcp`) now answer such a request with `401` and a
`WWW-Authenticate` challenge (RFC 9728) pointing at OAuth discovery.

Why: an OAuth client learns it must send its token only by being refused
without one. `/mcp` answered anonymous requests with 200, so ChatGPT — which
had completed OAuth and held a valid token — never sent it, every tenant tool
refused, and the connector was disabled. An anonymous session also had no
owner, so anyone holding its id could use the key `ateam_auth` had put into it.

What an HTTP client does now:
- **OAuth** (Claude.ai, ChatGPT): connect to `https://mcp.ateam-ai.com` or
  `https://mcp.ateam-ai.com/mcp`; the client follows the challenge.
- **An API key as a bearer**: send `Authorization: Bearer <your A-Team API key>`.
  `ateam_auth` still works inside such a session (switching tenants or
  environments).
- **Platform sign-in** (0.4.104, A-Team's own in-product Builder only):
  `x-adas-token`.
- **Self-hosted, single-user only**: `ATEAM_OAUTH_DISABLED=1` removes the gate
  for the whole process. Do not set it on a shared server: sessions then have
  no owner to check.

Stdio (`npx @ateam-ai/mcp`) is unaffected.

## 0.3.32 – 0.4.92, and 0.4.94 onward

Not tracked here. See the commit history (`git log`).

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
