# ateam-mcp Cardinal Invariants (BLOCKING)

> Applies ONLY to `ateam-mcp` — the PUBLIC MCP server external AI agents
> (Claude.ai, ChatGPT, Cursor…) connect to; it forwards to the ADAS External
> Agent API → Core. `src/` IS the published artifact (`files: ["src/"]`, no
> build). These are in addition to the generic ADAS rules. Each is a hard blocker.

## 1. Two kinds of OAuth token, told apart by prefix (BLOCKING)

- **Personal sign-in (`atg_` access, `atr_` refresh, `atc_` code)** — `src/grantAuth.js`. The person
  approves the client in the A-Team app as themself; Core issues the tokens and is the ONLY one that
  knows them (sha256 hashes in Core's `agent_grants`). `verifyAccessToken` asks Core (`resolve`, cached
  60 s by the token's hash). `atg_` lives 15 minutes, `atr_` rotates on every refresh. The workspace key
  Core hands over (`workspaceKey`) stays in this server's memory per grant (`grantWorkspaces`) and in the
  session record; it NEVER goes into a tool result, a token, a log line or the chat.
  - A failed call to Core is a 5xx (`CoreUnavailable` → `ServerError`), NEVER a 401: a 401 makes the
    client refresh, and a refresh that also fails makes the person approve again.
  - Core's door is ateam-mcp's OWN value, `HMAC-SHA256(CORE_MCP_SECRET, "ateam-mcp/agent-auth/v1")`
    (`deriveServiceSecret`, the same construction as Core's `utils/serviceDoors.js`; both sides pin the
    vector in a test). Sending the raw `CORE_MCP_SECRET` to `cp.agent_auth_api` ⇒ BLOCKING.
  - PKCE: the SDK's local check is off (`skipLocalPkceValidation`) because Core checks an `atc_` code;
    a key page code is checked here (`verifyPkce`). Removing either check ⇒ BLOCKING.
  - The grant path is used only on the MCP host whose environment is Core's own (`open` returns `env`).
  - **One connector for prod and dev** (`src/envLink.js`, slice 8). A PRODUCTION grant may reach the
    person's DEV workspaces when production Core offers it (`resolve` → `link`, a SysAdmin switch). This
    server then is a client of A-Team's DEV connector: it gets a DEV grant by the device code there (the
    person approves on DEV) and passes the person's calls on with it. Rules:
    - The DEV address is this server's own (`mcpUrlForEnv("dev", KEY_ENVIRONMENTS)`), never a setting or
      anything a caller or Core says; only a grant whose `env` is `prod` gets a link ⇒ else BLOCKING.
    - No `device_code`, DEV `atg_`/`atr_` or key ever goes into a tool result, a log line or the chat
      (the user code and approval link are for the person and may). DEV refresh tokens are saved on the
      prod grant via Core `linkSet` (sealed there), over the token they replaced (`previous_refresh_token`).
    - NEVER SILENTLY INTO PROD. While the grant's active workspace is a DEV one (`remote`), every call is
      passed on or refused with the reason; none runs here. `remote` is saved on the grant BEFORE DEV is
      asked to switch. Only the person's own switch sends `leave_remote` to `workspaceKey`; an automatic
      start never does (Core refuses it while remote). Any path that runs a call in a PROD workspace while
      `remote` is set, or that clears `remote` without the person's confirmed switch ⇒ BLOCKING.
    - DEV must be approved by the same person (email on both sides) or the link is dropped.
    - Linking starts only when the agent asks for DEV (`environment: "dev"`).
- **Key page sign-in (legacy, kept)** — the access token is the literal `adas_` key; `refresh_token` =
  `rt_<apiKey>`. `parseApiKey()` (`src/api.js`) is the **single** structural definition of a valid key,
  and `verifyAccessToken` stays structural-only for it (real authZ is Core's, via the forwarded key).
  Changing the key format/regex without updating **every** call site ⇒ BLOCKING.
- Because the code is exchanged for that raw key, `redirect_uri` decides who gets
  it. A redirect is accepted only if `redirectRequester` (`src/oauth.js`) allows
  it, at `/register` AND at `/authorize`: the exact Claude / ChatGPT / Cursor /
  VS Code https callbacks, ChatGPT's per-connection
  `https://chatgpt.com/connector/oauth/<one segment>`, loopback http
  (`localhost`, `127.0.0.1`, any port), Cursor's app scheme on Cursor's hosts. The consent page names the requester from that
  table by the redirect's host, NEVER by `client_name`. Accepting or merging a
  caller's redirect, or showing `client_name` ⇒ BLOCKING
  (`test/oauth-redirect-allowlist.test.mjs`).

## 2. Session reuse = owner-ownership; NO token injection (BLOCKING)

- `mcp-session-id` is client-supplied and non-secret (logged/echoed). A bound
  session may be reused (POST/GET/DELETE) ONLY by the same owner — the same
  validated bearer, the same GRANT for a personal sign-in (`grant:<gid>`, `grantOwner`:
  its token rotates every 15 minutes, the grant does not), or the platform principal
  for a platform session (§3):
  `denySessionReuse`/`sessionOwnershipOk` MUST run on **every** MCP verb. Any new
  route/method under `MCP_PATHS` must call it.
- The server NEVER supplies a token to a request: no cache of `/token` responses,
  no injection into a request that arrived without `Authorization`, keyed by
  anything. A process-global "newest token" (`getNewestToken()`) was the CRITICAL
  cross-user bypass of finding #28; its IP-scoped successor (`recentTokensByIp` +
  `autoInjectToken`) was the same bypass behind a shared egress IP (Claude.ai and
  ChatGPT share them), and ran before the strict gate. Both were deleted
  (BUILDER-SEC-SIGNIN-P0). The injection was a workaround for Claude.ai dropping
  its token (anthropics/claude-ai-mcp#35); prod logs now show Claude.ai sending
  its own bearer, which is why removing it is safe. Bringing any injection
  back ⇒ BLOCKING.
- This is layer 2, and it is not redundant with the bearer gate (§3):
  `verifyAccessToken` is structural-only (§1), so ANY well-formed key passes the
  gate, including a made-up key naming the victim's own tenant. Only the ownership
  check stops it from using another client's session, so it must compare the WHOLE
  key, never the tenant or a prefix.
- The binding (`sessionOwners`) lives as long as the session's transport and is
  removed only with it (`clearSession`). The idle sweep (`sweepStaleSessions`)
  drops credentials, NEVER the binding. It used to drop it (8fc71af, before
  c294d0f made the map the owner), and an idle live session then went to the next
  bearer that asked.
- `PLATFORM_PRINCIPAL` is a Symbol so no bearer can equal it, and it is NEVER an
  `authOverrides` key: an override is re-applied to every session of its key, so
  one shared platform credential holding one would carry a tenant into every proxy
  session. Every override lookup goes through `bearerOf`, which answers null for it,
  and null for a grant owner too: a personal sign-in session takes no key (`ateam_auth`
  refuses there) and its workspace comes only from Core (`ateam_switch_workspace`).
  No override is ever keyed by an opaque `atg_` token or a grant. `test/personal-signin.test.mjs`.
- Extend `test/session-isolation.test.mjs` when touching this path. It tests each
  layer on its own, on every verb, plus the idle sweep, and that a `/token`
  exchange does not authenticate a bearer-less request from the same IP. Regressing any of them ⇒ BLOCKING (cross-tenant auth bypass on the
  public surface).

## 3. Dual mount contract: BOTH `/` and `/mcp` strict (BLOCKING)

- MCP is served at BOTH `/` and `/mcp`, behind ONE auth rule (`mcpAuth`, 39ff024):
  a request with no valid Bearer gets 401 + `WWW-Authenticate` naming
  `resource_metadata` (RFC 9728). That challenge is how an OAuth client (Claude.ai,
  ChatGPT) learns to send its token. `/mcp` was optional-auth until 39ff024
  (704206e); an anonymous 200 told clients the endpoint was public, and an
  anonymous session has no bound bearer, so anyone with its id could reuse it.
- Reopening either mount to anonymous requests ⇒ BLOCKING, even "for a legacy
  client". `ATEAM_OAUTH_DISABLED=1` removes the gate entirely and must stay unset on a
  shared server. `test/session-isolation.test.mjs` covers both mounts.
- The ONE other way in is platform sign-in (`platformGate`, for ai-dev-assistant's
  ateam-proxy-mcp, which has no bearer for its tenant-less handshake). It runs
  BEFORE the bearer gate, and must stay:
  - constant-time against `CORE_MCP_SECRET`, byte lengths compared first
    (`presentsPlatformSecret`), and FAIL CLOSED when that is unset or empty;
  - decided alone: a presented `x-adas-token` that fails is a 401, never a fall-through
    to the bearer gate, and a passing one ignores any `Authorization` sent with it;
  - tenant-less: it binds the session to `PLATFORM_PRINCIPAL` and seeds no key, no
    tenant and no override. A tenant tool on a platform session is refused until
    `ateam_auth` puts that tenant's own key in. Widening it into a master key
    (a tenant, a key, or access to another owner's session) ⇒ BLOCKING.
  - replaced, never merged: the proxy runs EVERY tenant on ONE platform session,
    so `ateam_auth` there starts from an empty record (`resetPlatformSession`,
    before anything reads it). Merging keeps the last tenant's url, master key,
    actor and context for the next ⇒ BLOCKING.
- `stage: "auth_gate"` on the dispatcher's auth-gate refusal is a contract with
  ateam-proxy-mcp: it signs in again and REPLAYS a call on that mark alone, because
  only the gate knows the tool did not run (`deriveErrorCode` also says
  UNAUTHENTICATED for a tool that ran and failed with "401" in its text). Setting
  it anywhere else, or dropping it from the gate ⇒ BLOCKING.
- Every POST must be Accept-normalized to include `application/json` +
  `text/event-stream` (on parsed headers AND `rawHeaders`) or the SDK rejects requests.
- OAuth `resourceServerUrl` / PRM `resource` MUST equal the connector ROOT URL (not
  `/mcp`), and `server.json`/README URLs must stay consistent with the mounts.

## 4. Public tool contract: names, two-tier visibility, response envelope (BLOCKING)

- External agents call tools by exact string (`ateam_bootstrap`, `ateam_auth`, …)
  and parse the JSON text body. Renaming/removing/repurposing an `ateam_*` tool or
  narrowing its `inputSchema` without a back-compat/version story ⇒ BLOCKING.
- `tools/list` advertises only `coreTools` (`core !== false`) but `handleToolCall`
  dispatches ALL tools by name — advanced (unlisted) tools MUST stay callable. Set
  `core` correctly on new tools.
- Preserve the output envelope: `{ content: [{ type:"text", text: JSON.stringify(result) }] }`,
  `isError: true` on failure, `MAX_RESPONSE_CHARS` truncation. A mutating tool must
  be in `STAMP_WHERE_TOOLS` and return an object (for the `_where` stamp).

## 5. Tenant-scoped tools: explicit-auth gated, never default the tenant (BLOCKING)

- ONE CHECK RUNS BEFORE THE GATE: a personal sign-in whose active workspace is a DEV one (`remoteOf`) has
  every call but `ateam_switch_workspace` / `ateam_auth` passed on to the DEV connector
  (`forwardToolCall`), where the DEV connector's own gate applies. It never falls through to this gate
  with a PROD workspace (§1, "One connector for prod and dev").

- The auth gate DENIES BY DEFAULT: every tool requires an EXPLICIT sign-in
  (`ateam_auth` or a bearer — `isExplicitlyAuthenticated`) unless it is in
  `PUBLIC_TOOLS` (`src/publicTools.js`), the one list, each entry with its reason.
  Adding a tool to `PUBLIC_TOOLS` that reads or writes a workspace, or a second
  hand-kept list of public/tenant tools, ⇒ BLOCKING. (`TENANT_TOOLS`, the old
  opt-in list, missed fifteen tools and was deleted in #38.)
- Ambient env (`ADAS_API_KEY`/`ADAS_TENANT`) is NOT a sign-in and is never SENT:
  `getCredentials` reads only the session's record. Re-introducing an env-key
  fallback for requests ⇒ BLOCKING (`envApiKeyPresent()` exists only for the
  refusal text).
- Sign-in and switch steps live in `src/signInSteps.js` and are rendered from
  it; restating them elsewhere ⇒ BLOCKING (test/sign-in-and-switch.test.mjs).
- Credential resolution + `headers()` (`src/api.js`) must **throw** when the tenant
  can't be resolved — NEVER re-introduce a `|| "main"`/`|| "default"` fallback
  (High-sev bug). Keep the exact forward-header names (`X-ADAS-TENANT` + `X-API-KEY`,
  or `x-adas-token` + `X-ADAS-TENANT` in master mode). New Core call sites must go
  through `get/post/patch/del` (so these gates apply), not a bespoke `fetch`.

## Publish/version lockstep (non-blocking unless a release PR)

`publish.yml` publishes on any `src/**`/`package.json` change to `main`. For registry
+ npm validity, `package.json.mcpName` must equal `server.json.name`, and the npm id
must equal `package.json.name`. A release PR that leaves `package.json` /`server.json`
/`src/server.js` hardcoded version / `CHANGELOG` out of lockstep should be flagged.

## A red main does not publish (BLOCKING)

`publish.yml` runs `npm test` between `npm ci` and `npm publish` in the publishing job,
and `ci.yml` runs `npm ci` + `npm test` on every pull request and every push to main.
Flag any change that removes, reorders, conditions (`if:`), softens (`continue-on-error`,
`|| true`) or path-filters either; `test/release-metadata.test.mjs` pins both.
