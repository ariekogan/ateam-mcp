# ateam-mcp Cardinal Invariants (BLOCKING)

> Applies ONLY to `ateam-mcp` — the PUBLIC MCP server external AI agents
> (Claude.ai, ChatGPT, Cursor…) connect to; it forwards to the ADAS External
> Agent API → Core. `src/` IS the published artifact (`files: ["src/"]`, no
> build). These are in addition to the generic ADAS rules. Each is a hard blocker.

## 1. OAuth access-token IS the raw `adas_<tenant>_<32hex>` API key (BLOCKING)

- The OAuth `access_token` must stay the literal `adas_` key (never opaque);
  `refresh_token` = `rt_<apiKey>`; `scope: "claudeai"`; `expires_in: 3600`.
- `parseApiKey()` (`src/api.js`) is the **single** structural definition of a
  valid key/token; `verifyAccessToken` must stay structural-only (no server-side
  token store — real authZ is delegated to Core via the forwarded key).
- Making the token opaque, changing the key format/regex, or adding non-structural
  validation without updating **every** call site (`src/oauth.js` ×3, `src/api.js`
  ×3, `src/tools.js`) + the `/authorize` hint text ⇒ BLOCKING (breaks every OAuth'd
  Claude.ai session + refresh).

## 2. Session reuse = bearer-ownership; token injection = IP-scoped short-TTL (BLOCKING)

- `mcp-session-id` is client-supplied and non-secret (logged/echoed). A bearer-bound
  session may be reused (POST/GET/DELETE) ONLY by the same validated bearer:
  `denySessionReuse`/`bearerOwnershipOk` MUST run on **every** MCP verb. Any new
  route/method under `MCP_PATHS` must call it.
- The OAuth→MCP token auto-injection cache must stay **IP-scoped with a short TTL**
  (`recentTokensByIp`, `TOKEN_TTL`) — NEVER a process-global "newest token"
  (`getNewestToken()` was the CRITICAL cross-user auth bypass, finding #28).
- This is layer 2, and it is not redundant with the bearer gate (§3):
  `verifyAccessToken` is structural-only (§1), so ANY well-formed key passes the
  gate, and only the ownership check stops it from using another client's session.
- Extend `test/session-isolation.test.mjs` when touching this path. It tests each
  layer on its own, on every verb. Regressing either ⇒ BLOCKING (cross-tenant auth
  bypass on the public surface).

## 3. Dual mount contract: BOTH `/` and `/mcp` strict (BLOCKING)

- MCP is served at BOTH `/` and `/mcp`, behind ONE auth rule (`mcpAuth`, 39ff024):
  a request with no valid Bearer gets 401 + `WWW-Authenticate` naming
  `resource_metadata` (RFC 9728). That challenge is how an OAuth client (Claude.ai,
  ChatGPT) learns to send its token. `/mcp` was optional-auth until 39ff024
  (704206e); an anonymous 200 told clients the endpoint was public, and an
  anonymous session has no bound bearer, so anyone with its id could reuse it.
- Reopening either mount to anonymous requests ⇒ BLOCKING, even "for a legacy
  client". A client that sends no `Authorization` (e.g. ai-dev-assistant's
  ateam-proxy-mcp) is fixed by sending its key as a Bearer, not by relaxing the
  gate. `ATEAM_OAUTH_DISABLED=1` removes the gate entirely and must stay unset on a
  shared server. `test/session-isolation.test.mjs` covers both mounts.
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

- Every tool touching tenant data MUST be in `TENANT_TOOLS` and requires EXPLICIT
  `ateam_auth`/bearer — ambient env (`ADAS_API_KEY`/`ADAS_TENANT`) is deliberately
  NOT sufficient (`isExplicitlyAuthenticated`). A new tenant-touching tool omitted
  from `TENANT_TOOLS` bypasses the gate ⇒ BLOCKING.
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
