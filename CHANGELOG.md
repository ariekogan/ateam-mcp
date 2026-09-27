# Changelog

## Unreleased

### Security

- `ateam_delete_solution` no longer lets `solution_id` carry `?force=true`.
  The id was pasted into the URL raw, so `solution_id:"walkmate?force=true"`
  in PREVIEW mode sent a forced delete that no `confirm` had approved, and
  `"../x"` left the route. The id is now checked against the Builder's own rule
  (`/^[a-z0-9][a-z0-9_-]{0,127}$/i`) and refused with no request sent, and
  both the preview and the forced call encode it.
- A forced `ateam_delete_solution` is sent once, with a 95s timeout (under
  Cloudflare's ~100s). A verdict (a JSON body with a `code`), or any JSON
  4xx, comes back whole, with `http_status` and a `_next` chosen from its
  `code`. Anything else returns `NO_ANSWER` and says to call the preview
  before re-issuing. That covers a timeout, a 5xx without a `code` (a gateway
  page, a Cloudflare 520, or the skill-validator's own `{ok:false,error}`),
  and a socket reset after the request was sent.

- No tool puts a caller's id into a URL path raw. Over a hundred API paths in
  `tools.js` pasted ids in as they came. Because fetch normalizes `..`,
  `ateam_test_abort(skill_id:"..", job_id:"..?force=true")` sent
  `DELETE /deploy/solutions/<id>?force=true`, a forced tenant wipe with no
  confirm. `ateam_delete_skill` and `ateam_delete_connector` did the same with
  `"..?force=true"`, `"%2e%2e?force=true"` or `"walkmate?force=true#"`.
  Every API path is now built by one tag, `apiPath` in `src/pathParam.js`. It
  refuses a value that cannot be an id (`.`, `..`, `/`, `?`, `#`, `%`, `\`,
  whitespace, or empty) before any request, and percent-encodes every other
  value. A test fails on any API path built another way, including one
  built on a variable base.
- A job id the tag refuses fails at once, instead of being polled for the
  whole budget and reported as "polling timed out".
- `ateam_build_and_run` and `ateam_deploy_solution` refuse a `solution.id`
  that no path could carry, before deploying a solution that no later call
  could address.

### Retries

- A response whose body carries a verdict (a JSON object with a `code`) is
  never re-sent, whatever its status: the server answered.
- A request whose connection was refused is re-sent, whatever its method,
  because nothing was sent.
- After the request was sent, only a read is re-sent on a transport failure:
  a timeout, a gateway's 502/504 page, or a hop's bare `{ok:false,error}`.
  A read is a GET, or a POST declared `idempotent`: the validators,
  `ateam_design_advisor`, `ateam_spec_search`, the delete preview,
  `build_and_run`'s validate phase and its Phase 0 pull-bundle, and
  sync-from-main with `dry_run:true`. Reconcile is not a read even as a dry
  run: the Builder merges before it checks `dryRun`. A write is not re-sent,
  and its 5xx hint no longer says "Try again in a minute". `api.js`
  `mayAutoRetry` decides this for every request.
- `ateam_redeploy`, `ateam_github_pull`, `ateam_upload_connector` and
  `ateam_create_plugin` fall back from their async kick to the sync call only
  when the kick never reached the server or got a 404/405. Before this, any
  failure re-sent the write, including a JSON 502 verdict or a kick slower
  than 30s. `ateam_build_and_run` no longer re-POSTs its deploy in async mode
  after a 502 that carries a verdict.

### Tools

- `ateam_delete_solution` says that it wipes conversations and history,
  memory facts and stored actor data, clears voice config, and keeps the tenant
  account, members and settings. Recovery: code and config can be recovered
  from git history, and rolling main back to a prod tag restores the files.
  Conversations, memory and stored data cannot be recovered. It no longer
  names `ateam_github_pull` as the recovery.
- `ateam_delete_skill` and `ateam_delete_connector` no longer say the GitHub
  source is preserved. Both delete it from the repo on dev and main.

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
