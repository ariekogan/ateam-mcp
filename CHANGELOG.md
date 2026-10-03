# Changelog

## 0.4.114 — 2026-10-03

### Tools that reach the connector upload say how long they take (#59)

- `ateam_create_plugin`, `ateam_create_connector`, `ateam_upload_connector`
  and `ateam_build_and_run` declare `monitoring.latency_ms_p95` (75 s). Core
  sizes an in-app call's timeout from it (×4, up to 300 s), so creating a
  plugin or a connector through the in-app builder is no longer cut off at
  30 s.

## 0.4.113 — 2026-10-02

### Tool texts say what really happens (#55)

- `ateam_test_abort`: drops the description of an `actor_id` that the abort
  never used.
- `ateam_conversation`: says what `actor_id` does and does not do, what
  continues a conversation, and how long a pending question waits for its
  answer.
- `ateam_verify_surface`, `ateam_get_spec`: point at the one served rule for
  data fidelity and for finishing a test with the solution's own delete. They
  name the `search` form, which returns that section whole even when a page
  is over the response cap.
- `ateam_get_spec` (triggers): points at the rule for a recurring check that
  has no cadence from the user (ask; add no trigger until they answer).

### Served examples fit any solution (#56)

- The examples in `ateam_verify_surface`, `ateam_connector_logs`, the
  attachment helper and the scaffolded connector's comments are now varied
  and domain-neutral.
- A test fails if a served string or key, or a string literal in `src/`,
  names the scenario a release was tested with.

## 0.4.112 — 2026-10-02

### The browser sign-in belongs to the host the request addressed

- The OAuth issuer, the `401` challenge's `resource_metadata`, the
  protected-resource and authorization-server metadata, and the authorize and
  token endpoints are now those of the MCP host the request addressed
  (`X-Forwarded-Host`, else `Host`), for each environment the key table names.
  They came from one process-wide `ATEAM_BASE_URL`, which the Dockerfile set to
  production, so a browser sign-in started on a non-production MCP was sent to
  production and bound a production workspace. `ATEAM_BASE_URL` is deleted
  from the code and the Dockerfile; nothing reads it.
- A self-hosted box signs in on its own MCP host: when `DOMAIN` (the variable
  its setup page writes) is set, `mcp.<DOMAIN>` gets its own issuer and
  endpoints, derived from `api.<DOMAIN>` the way every other environment's are,
  and its sign-in page links its own key page, `app.<DOMAIN>/connect`. `DOMAIN`
  must be a bare hostname; any other value is refused at startup with a log
  line and is never used.
- A host the server cannot name (a forged header, `localhost`, a self-hosted
  domain `DOMAIN` does not name) gets no browser sign-in: the sign-in paths
  answer `421` with no URL, and the `401` challenge names no metadata. The host
  is never echoed, and it is not given production's URLs. A client there sends
  the key as `Authorization: Bearer <key>`.
- The sign-in page links the production key page only on production (and a
  self-hosted box's own on that box); on any other environment it says the key
  is on that environment's own A-Team app.
- `/get-api-key` and `/connect-github` answer by the host too: production's key
  page and app on production, a self-hosted box's own on that box, and on any
  other host the same words with no link. They sent every host to production's.
  `ATEAM_APP_URL` is deleted; nothing reads it.
- A sign-in's code is redeemed only on the host that issued it.

### Signing in, which workspace a session is on, and how to switch

- Every tool needs a sign-in unless `src/publicTools.js` lists it (the docs,
  validation, `ateam_bootstrap`, `ateam_auth`). The gate allowed only a
  hand-kept list of tenant tools, and fifteen later tools (promote, rollback,
  repo writes among them) ran on an `ADAS_API_KEY` environment fallback that
  is not a sign-in.
- `ateam_bootstrap` opens with `session`, and the MCP server instructions open
  with the same text: the workspace and environment the session is signed in
  to and how to switch, or, signed out, how to sign in. The steps differ for
  the hosted connector, a local (stdio) process, and the A-Team app's own
  builder, and each gets its own; no person is named.
- The steps live in `src/signInSteps.js` and are rendered in the sign-in
  refusal, the 401/403 hints, every refusal for a solution or skill this
  workspace does not have (which now says it may be in another workspace),
  and the sign-in page. They link `https://mcp.ateam-ai.com`,
  `https://claude.ai/customize/connectors` and the key page
  `https://app.ateam-ai.com/connect`. Switching is signing in again on the
  A-Team page with the other workspace's key.
- `ateam_auth` keeps a key for a bearer's later sessions only when the API
  accepted it, and a new sign-in on the A-Team page drops it.
- An agent never asks for a key in the chat and never uses one pasted there.
- `ateam_auth`'s `environment` and the opening give one answer (`unstated` for
  a key that names none, the url itself for a self-hosted API). `/get-api-key`
  redirects to the key page.
- An `ADAS_API_KEY` in the environment is never sent: a signed-out session's
  public tools (validation) went out with it, and the Builder read and billed
  that key's tenant. A refused `ateam_auth` leaves the session exactly as it was.
- A session on a non-production A-Team API is shown it by name ("the dev API"),
  never by host, in `base_url`, `_where` and error messages.

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

### What the tools tell an outside agent (MGAP, 2026-09-27)

- `ateam_spec_search` works without signing in. It posted to a key-gated
  connector route and answered 401 "Missing API key" to any session that had
  not signed in; it now calls the Builder's keyless `POST /spec/search`.
- `ateam_get_spec`, `ateam_get_examples`, `ateam_get_workflows`,
  `ateam_spec_search` and `ateam_bootstrap` return `served_by`: `prod` or
  `dev`, the environment whose API answered (the base URL itself for any
  other host). It is derived from the base the call went to, never configured.
- `ateam_create_plugin` no longer says to declare the plugin in
  `solution.ui_plugins[]`: the deploy merges what it discovers. Bootstrap says
  `platform_connectors` can carry the solution's own connectors
  (`source: 'solution'`), and that a skill reaches a connector's tools through
  its own `connectors[]`.

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
