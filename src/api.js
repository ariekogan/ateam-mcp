/**
 * A-Team API client — thin HTTP wrapper for the External Agent API.
 *
 * Credentials resolve in this order:
 *   1. Per-session record (set via ateam_auth, or seeded from the bearer), as
 *      the CURRENT TOOL CALL sees it — see runToolCall
 *   2. Nothing: no key and no tenant. There is no default tenant, and no
 *      environment key: ADAS_API_KEY / ADAS_TENANT do not sign a session in
 *      and are never sent (see getCredentials).
 *
 * Sessions also track activity timestamps and optional context (active solution,
 * last skill) to support TTL-based cleanup and smarter UX.
 */

import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
// Signing in and switching workspace: ONE statement of the steps (formatError renders them).
import { connectSteps, switchSteps, notInThisWorkspace } from "./signInSteps.js";

const BASE_URL = process.env.ADAS_API_URL || "https://api.ateam-ai.com";
// CORE_URL removed — all requests now route through BASE_URL (skill-validator)

// Request timeout (120 seconds — deploys can take 60-90s)
const REQUEST_TIMEOUT_MS = 120_000;

// Session TTL — sessions idle longer than this are swept
const SESSION_TTL = 60 * 60 * 1000; // 60 minutes

// Sweep interval — how often we check for stale sessions
const SWEEP_INTERVAL = 5 * 60 * 1000; // every 5 minutes

// Per-session store (sessionId → { tenant, apiKey, lastActivity, context })
// context: { activeSolutionId, lastSkillId, lastToolName }
// A record is REPLACED, never edited, when a session signs in again
// (setSessionCredentials) or a master-key session switches tenant
// (switchTenant): each builds a new object, which is what lets a tool call
// already in flight keep the one it started with. See runToolCall.
const sessions = new Map();

/**
 * A TOOL CALL RUNS AS THE SESSION WAS WHEN IT STARTED.
 *
 * Every request used to read the session's credentials from `sessions` at the
 * moment it went out (headers, getBaseUrl — 3d8ec1c, v0.1.4). One session was
 * one caller then, so "the session's key now" and "the key this call started
 * with" were the same key. The platform session made them different (f05c750):
 * ateam-proxy-mcp keeps ONE session for every tenant and signs each one in with
 * ateam_auth before its calls. A call that makes several requests (a deploy
 * that then polls, a test that then reads the chain, a 15-minute chain wait)
 * read the record again for each of them, so once another tenant signed in
 * during the call, the rest of it went out with THAT tenant's key and tenant
 * header, its actor landed in that tenant's record, and its `_where` named that
 * tenant. The proxy serializes sign-in and call under a per-session lock, but
 * the lock ends when the proxy stops waiting (its forward timeout, 330s), not
 * when the tool here finishes, and nothing here may depend on a caller's lock
 * for tenant isolation.
 *
 * So each tools/call (src/server.js) runs inside runToolCall, which holds the
 * session's record as it was when the call arrived, and sessionRecord answers
 * from it for the whole call, across every await. A sign-in or a master-mode
 * tenant switch by ANOTHER call replaces the session's record and leaves this
 * one alone. The same by THIS call (ateam_auth, a `tenant` arg in master mode)
 * is the one change it adopts: setSessionCredentials, resetPlatformSession and
 * switchTenant update the call's record as well as the session's. A sweep over
 * tenants (runAsTenant) changes only its own call's record, never the session's.
 *
 * Outside a tool call (seedCredentials on an incoming request, the sweep, a test
 * calling a handler directly) sessionRecord reads the session store, as before.
 *
 * The call also carries the TRANSPORT it arrived on, as stated by whoever built
 * its server (src/index.js: "stdio", src/http.js: "http"). The session id cannot
 * say it: "stdio" is only createServer's default id, and an HTTP client picks its
 * own id (http.js reuses a stale mcp-session-id as given), so it can send
 * "stdio". See callTransport.
 */
const toolCall = new AsyncLocalStorage(); // { sessionId, record, transport }

/** Run one tool call as `sessionId` was when it arrived, on the transport its server was built for. */
export function runToolCall(sessionId, fn, { transport = null } = {}) {
  return toolCall.run({ sessionId, record: sessions.get(sessionId) || null, transport }, fn);
}

/**
 * The transport the current tool call arrived on: "stdio" (a local process the
 * caller started) or "http" (the hosted server). null outside a tool call, or
 * when the server was built without saying, and a caller must treat null as
 * NOT local: only a stated "stdio" may do what the hosted server must not.
 */
export function callTransport() {
  return toolCall.getStore()?.transport ?? null;
}

/**
 * The session record this code acts as: the current tool call's, when it runs
 * inside one for this session; otherwise the session store's. The ONE read of a
 * session's credentials and context — every reader below goes through it.
 */
function sessionRecord(sessionId) {
  if (!sessionId) return null;
  const call = toolCall.getStore();
  if (call && call.sessionId === sessionId) return call.record;
  return sessions.get(sessionId) || null;
}

/** This call changed its own session's record (ateam_auth): it acts as the new one. */
function adoptRecord(sessionId, record) {
  const call = toolCall.getStore();
  if (call && call.sessionId === sessionId) call.record = record;
}

// ── Bearer-based auth (persistent across sessions) ──────────────
// The OAuth bearer token IS the user's API key (oauth.js exchangeAuthorizationCode).
// Each user has a unique bearer. MCP clients create new sessions per tool call,
// so we use the bearer as the persistent actor identity.
//
// When ateam_auth signs a bearer's session in to another key, and that key is
// ACCEPTED, the override is stored per bearer and applied to all future
// sessions of it, until it expires or a new sign-in on the A-Team page
// (/authorize) for that bearer drops it (clearAuthOverride).
const authOverrides = new Map();  // bearerToken → { tenant, apiKey, updatedAt }
// sessionId → the session's OWNER: its bearer string, or PLATFORM_PRINCIPAL.
// denySessionReuse (src/http.js) compares every request against it.
const sessionOwners = new Map();

/**
 * THE PLATFORM PRINCIPAL — the owner of a session opened with `x-adas-token`.
 *
 * ai-dev-assistant's ateam-proxy-mcp is the in-product Solution Builder's way
 * in. It opens ONE tenant-less session (initialize, tools/list — the catalog is
 * the same for every tenant), then signs each tenant in with an in-band
 * ateam_auth before that tenant's calls. It has no bearer to send: the catalog
 * handshake belongs to no tenant. 39ff024 made every request without a bearer
 * a 401, so from 2026-09-11 that handshake failed on every host.
 *
 * It now signs in with the platform secret instead (Core's ADAS_MCP_TOKEN; this
 * container's CORE_MCP_SECRET, the same value). What that buys is EXACTLY what
 * an anonymous session had before 39ff024, plus an owner:
 *   - the global tools (bootstrap, spec, examples, validate);
 *   - ateam_auth, which is how each tenant's own key gets into the session.
 * It carries NO tenant and NO key. It is not a master key: a tenant tool on a
 * platform session is refused until ateam_auth puts that tenant's credential
 * in, exactly as for any other session. And since many tenants take turns on
 * one platform session, each ateam_auth there replaces the last tenant's record
 * instead of merging into it (resetPlatformSession), and a call already in
 * flight keeps the record it started with (runToolCall).
 *
 * A Symbol, never a string, so it cannot equal any bearer a client presents.
 * It is never a key in authOverrides (see bearerOf): overrides are per bearer
 * and re-applied to every session of that bearer, so one shared platform
 * credential holding an override would put one tenant into every proxy session.
 */
export const PLATFORM_PRINCIPAL = Symbol("ateam-mcp:platform-principal");

/**
 * Did the caller present the platform secret (`x-adas-token`)?
 *
 * Read per call from CORE_MCP_SECRET, the name this container already holds
 * (ai-dev-assistant's docker-compose fills it from the same value Core reads as
 * ADAS_MCP_TOKEN). No new variable.
 *
 * Returns false, never throws, when:
 *   - CORE_MCP_SECRET is unset or empty. FAIL CLOSED: laptops, npx and the
 *     launchd agent set none, and there the platform path does not exist. An
 *     empty secret must never match an empty token.
 *   - `presented` is not a non-empty string (a repeated header, an array).
 *   - the BYTE lengths differ. Comparing string lengths and then calling
 *     timingSafeEqual on the UTF-8 buffers throws a RangeError when a character
 *     outside ASCII makes the buffers differ, which one unauthenticated request
 *     could use to crash a server. Same rule as the Builder's
 *     presentsServiceSecret (packages/skill-validator/src/services/serviceSecret.js).
 */
export function presentsPlatformSecret(presented) {
  const secret = process.env.CORE_MCP_SECRET || "";
  if (!secret || typeof presented !== "string" || presented === "") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The session's owner IF it is a bearer, else null. The one way to ask "which
 * bearer's override applies here", so the platform principal can never become
 * an override key, whoever adds the next caller.
 */
function bearerOf(sessionId) {
  const owner = sessionOwners.get(sessionId);
  return typeof owner === "string" && owner ? owner : null;
}

/**
 * THE ENVIRONMENTS A KEY MAY NAME. A CLOSED SET, deliberately.
 *
 * If this were an open pattern like [a-z]+, a typo — `adas_prd_…` — would
 * become a NEW VALID ENVIRONMENT rather than an error, and the caller would be
 * routed somewhere that does not exist instead of being told they mistyped.
 * That is the same silent-wrong class as an environment fallback. Add an
 * environment HERE, in one place, or it does not exist.
 */
export const KEY_ENVIRONMENTS = Object.freeze({
  prod: "https://api.ateam-ai.com",
  dev: "https://dev-api.ateam-ai.com",
});

const TENANT_RE = "[a-z0-9][a-z0-9-]{0,28}[a-z0-9]";
const ENV_KEY_RE = new RegExp(`^adas_(${Object.keys(KEY_ENVIRONMENTS).join("|")})_(${TENANT_RE})_([0-9a-f]{32})$`);
const PLAIN_KEY_RE = new RegExp(`^adas_(${TENANT_RE})_([0-9a-f]{32})$`);

/**
 * THE SEALED FORM — `adas_<env>_<blob>`, where the tenant is INSIDE the blob.
 *
 * base64url of [version:1][nonce:8][AES-256-GCM(tenant)][tag:8][secret:16].
 * The trailing 16 bytes — the actual secret — are in the clear; the sealing key
 * protects ROUTING ONLY. So the blob is not "the encrypted key", and losing the
 * sealing secret is an availability problem, not a credential breach.
 *
 * THIS FILE MUST NEVER DECODE IT, and the reason is specific to this package:
 * `@ateam-ai/mcp` installs from npm onto developer laptops. Any decoder here
 * would mean the sealing secret shipping with it. We learn the tenant by asking
 * — GET /auth/whoami — never by parsing.
 *
 * Length bounds come from that byte layout: 1-char tenant = 34 bytes = 46
 * base64url chars; 30-char tenant = 63 bytes = 84.
 */
const SEALED_KEY_RE = new RegExp(`^adas_(${Object.keys(KEY_ENVIRONMENTS).join("|")})_([A-Za-z0-9_-]{46,88})$`);

/**
 * Parse an API key.
 * Sealed: adas_<env>_<blob>            (tenant NOT in the string — ask whoami)
 * Format: adas_<env>_<tenant>_<32hex>  env ∈ prod|dev
 * Older:  adas_<tenant>_<32hex>        (no environment named)
 * Legacy: adas_<32hex>                 (no tenant either)
 *
 * ORDER IS LOAD-BEARING, and it is the order Core resolves in. base64url
 * includes `-` and `_`, so a long-tenant key with a malformed secret has the
 * SHAPE of a sealed blob. Trying the strict forms first means every well-formed
 * key is claimed by the form it belongs to, and only genuine leftovers reach the
 * blob pattern — where they parse as "sealed", fail to decrypt at Core, and
 * authenticate as NOBODY. That residue is acceptable only because nothing here
 * makes an authorisation decision. Reverse the order and a typo masquerades as
 * a sealed key.
 *
 * `tenant: null` with `sealed: true` is the CORRECT answer, not a failure.
 *
 * `env: null` means the key does not SAY which environment it belongs to — not
 * that it is production. Nothing here defaults it; a caller that needs to know
 * must treat null as unknown.
 *
 * @returns {{ env: string|null, tenant: string|null, sealed: boolean, isValid: boolean }}
 */
export function parseApiKey(key) {
  const no = { env: null, tenant: null, sealed: false, isValid: false };
  if (!key || typeof key !== 'string') return no;
  const withEnv = key.match(ENV_KEY_RE);
  if (withEnv) return { env: withEnv[1], tenant: withEnv[2], sealed: false, isValid: true };
  const match = key.match(PLAIN_KEY_RE);
  if (match) return { env: null, tenant: match[1], sealed: false, isValid: true };
  const legacy = key.match(/^adas_([0-9a-f]{32})$/);
  if (legacy) return { env: null, tenant: null, sealed: false, isValid: true };
  const sealed = key.match(SEALED_KEY_RE);
  if (sealed) return { env: sealed[1], tenant: null, sealed: true, isValid: true };
  return no;
}

/**
 * ASK WHO THIS KEY IS. The replacement for splitting the string.
 *
 * Deliberately a bare fetch rather than request(): it runs BEFORE the session
 * has credentials, which is the whole point — request() builds its headers from
 * the session we are trying to populate.
 *
 * Returns { tenant, env } or throws. It does NOT fall back to anything. A key
 * whose tenant cannot be established is a key we refuse to act for: guessing
 * here would put a caller on someone else's data, which is the single failure
 * this system must never have.
 *
 * `/auth/whoami` is served by the skill-validator (api.ateam-ai.com and
 * dev-api.ateam-ai.com are BOTH the validator, not Core), which relays the
 * tenant Core gave it when it verified the key. Same answer, one hop.
 */
export async function whoami(apiKey, baseUrl, { timeoutMs = 10_000 } = {}) {
  if (!apiKey) throw new Error("whoami: no api key");
  if (!baseUrl) throw new Error("whoami: no base url");
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/auth/whoami`, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const e = new Error(`whoami failed at ${shownBase(baseUrl)} (HTTP ${res.status}): ${text.slice(0, 300)}`);
    // The status and the WHOLE body ride on the error, as request()'s do: a
    // refusal by name (personRefused: the key's person is gone) is an answer
    // about the key, and its own hint lies past the 300 characters above.
    e.status = res.status;
    e.body = text;
    throw e;
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`whoami returned non-JSON from ${shownBase(baseUrl)}: ${text.slice(0, 200)}`); }
  if (!json?.ok || !json?.tenant) {
    throw new Error(`whoami did not name a tenant at ${shownBase(baseUrl)}: ${text.slice(0, 300)}`);
  }
  return { tenant: json.tenant, env: json.env ?? null };
}

/** The API base a key's environment names, or null when it names none. */
export function baseUrlForKeyEnv(key) {
  const { env } = parseApiKey(key);
  return env ? KEY_ENVIRONMENTS[env] : null;
}

/**
 * Which known environment does this URL belong to? null = not a known host.
 *
 * Used to REFUSE a `url` that contradicts the key. Deliberately only recognises
 * the known hosts: an unrecognised url (localhost, a staging box) is still
 * allowed through, because the override exists for those — it just must not be
 * a way to cross prod/dev by accident.
 */
export function envForBaseUrl(url) {
  if (!url) return null;
  const norm = String(url).replace(/\/+$/, "");
  for (const [env, base] of Object.entries(KEY_ENVIRONMENTS)) {
    if (norm === base) return env;
  }
  return null;
}

/**
 * EACH ENVIRONMENT'S HOSTED MCP, AND WHICH ONE A REQUEST ADDRESSED.
 *
 * An environment's MCP host is its API host with the "api" label swapped for
 * "mcp" (api.<domain> ↔ mcp.<domain>, and the same for every prefixed entry).
 * So the closed set of environments stays in KEY_ENVIRONMENTS alone, and the
 * classifier stays envForBaseUrl: an addressed MCP host is mapped to its API
 * base and classified there, as a url given to ateam_auth is.
 *
 * The HTTP transport's sign-in (oauth.js mountOAuth) publishes mcpUrlForEnv(env)
 * for the environment envForMcpHost(req.hostname) names, never the request's
 * own host. null means a host this server cannot name.
 */
const API_LABEL = /^((?:[a-z0-9]+-)?)api\./;
const MCP_HOST = /^((?:[a-z0-9]+-)?)mcp\.([a-z0-9.-]+)$/;

/** The origin of `env`'s hosted MCP, or null for an environment that has none. */
export function mcpUrlForEnv(env) {
  if (!Object.hasOwn(KEY_ENVIRONMENTS, env)) return null;
  const url = new URL(KEY_ENVIRONMENTS[env]);
  const mcpHost = url.hostname.replace(API_LABEL, "$1mcp.");
  if (mcpHost === url.hostname) return null;
  url.hostname = mcpHost;
  return url.origin;
}

/** The environment whose hosted MCP is `hostname`, or null. */
export function envForMcpHost(hostname) {
  const m = MCP_HOST.exec(String(hostname ?? "").toLowerCase());
  return m ? envForBaseUrl(`https://${m[1]}api.${m[2]}`) : null;
}

/**
 * A BASE AS A SERVED TEXT OR FIELD MAY SHOW IT. Production's host and a
 * self-hosted base as themselves; any other A-Team environment by its name only
 * ("the dev API"). Public text names no non-production host (Arie, 2026-10-01),
 * and that covers what a session on one is served: base_url, error targets,
 * _where. Routing still uses the real base (getBaseUrl); this is display only.
 */
export function shownBase(base) {
  const env = envForBaseUrl(base);
  return env && env !== "prod" ? `the ${env} API` : base;
}

/**
 * WHICH ENVIRONMENT ANSWERS THIS SESSION — the `served_by` on every docs result
 * (ateam_get_spec, ateam_get_examples, ateam_get_workflows, ateam_spec_search)
 * and on ateam_bootstrap.
 *
 * MGAP-A15: an agent that never signed in read the PROD docs, compared them
 * with DEV's, and reported the difference as a contradiction in the docs. No
 * result said which environment had answered.
 *
 * Derived, never configured: the base this session's requests go to
 * (getBaseUrl, the resolution request() makes), named by the one map of
 * environments (envForBaseUrl). A base that is neither environment (localhost,
 * a self-hosted deployment) is named by itself: calling it "prod" would be the
 * guess this file refuses everywhere else.
 * @returns {string} "prod" | "dev" | the base URL itself
 */
export function servedBy(sessionId) {
  const base = getBaseUrl(sessionId);
  return envForBaseUrl(base) || base;
}

/**
 * Set credentials for a session.
 * If tenant is not provided, it's auto-extracted from the key.
 * Set explicit=true when called from ateam_auth (not from seedCredentials).
 * Set masterKey for cross-tenant master mode (uses shared secret auth).
 */
export function setSessionCredentials(sessionId, { tenant, apiKey, apiUrl, explicit = false, masterKey = null }) {
  let resolvedTenant = tenant;
  if (!resolvedTenant && apiKey) {
    const parsed = parseApiKey(apiKey);
    if (parsed.tenant) resolvedTenant = parsed.tenant;
  }
  // A SEALED key legitimately carries no tenant, so "unresolved" here means two
  // very different things and they must not share an outcome:
  //
  //   sealed  → the tenant is not IN the string and never will be. Null is the
  //             honest answer until whoami is asked. Requests still work: Core
  //             resolves the tenant from the key itself, and headers() simply
  //             omits X-ADAS-TENANT rather than sending a guess.
  //   not sealed → the key is malformed. Still a hard failure.
  //
  // The distinction is the whole discipline: we never INVENT a tenant, but
  // "not stated yet" is not the same as "wrong", and conflating them would
  // refuse every sealed key at the door.
  const sealedKey = apiKey ? parseApiKey(apiKey).sealed : false;
  // Fail loudly — silent fallback to "main" previously let malformed API keys
  // or missing tenant args silently pivot all operations onto the wrong tenant.
  // Matches the pattern we killed in ADAS connectors (memory-mcp, docs-index-mcp,
  // nutrition-mcp) — `|| "default"` was the #1 source of cross-tenant leaks.
  if (!resolvedTenant && !sealedKey) {
    throw new Error(
      `setSessionCredentials: tenant could not be resolved for session ${sessionId} ` +
      `(tenant arg ${tenant ? "present" : "missing"}, apiKey ${apiKey ? "present but malformed (expected adas_<env>_<key>)" : "absent"}). ` +
      `Refusing to fall back to a default tenant.`
    );
  }
  if (!resolvedTenant) {
    console.warn(
      `[Auth] Session ${sessionId} holds a sealed key whose tenant is not resolved yet. ` +
      `Calls will still authenticate (the tenant is inside the key and Core resolves it); ` +
      `anything that needs the tenant BY NAME must call whoami rather than assume one.`
    );
  }
  const existing = sessionRecord(sessionId);
  const sameTenant = !!existing && existing.tenant === (resolvedTenant || null);
  // A NEW object, never an edit of the old one: a call still in flight holds
  // the old one and must keep it (runToolCall).
  const record = {
    // Never `undefined` — a missing tenant is an explicit null, so every reader
    // sees "not resolved" rather than an absent property it might paper over.
    tenant: resolvedTenant || null,
    apiKey,
    apiUrl: apiUrl || existing?.apiUrl || null,
    authExplicit: explicit || existing?.authExplicit || false,
    masterKey: masterKey || existing?.masterKey || null,
    lastActivity: Date.now(),
    // The context (active solution, last skill, bound actor) carries over: on a
    // bearer's session this is one user signing in again (4dc8f17). It stays
    // the SAME object while the tenant is the same, because seedCredentials
    // builds a new record on every HTTP request and an actor a running call
    // learns (touchSession, which edits the context in place) must still reach
    // the session. For ANOTHER tenant it is a copy: a shared one let the new
    // tenant's actor reach the old tenant's call still in flight, and that
    // call's minted actor reach the new tenant.
    context: sameTenant ? existing.context : { ...(existing?.context || {}) },
  };
  sessions.set(sessionId, record);
  adoptRecord(sessionId, record);
  const urlNote = apiUrl ? `, url: ${apiUrl}` : "";
  const masterNote = masterKey ? ", MASTER MODE" : "";
  console.log(`[Auth] Credentials set for session ${sessionId} (tenant: ${resolvedTenant || "unresolved — sealed key"}${explicit ? ", explicit" : ""}${urlNote}${masterNote})`);
}

/**
 * A MASTER-KEY RECORD ACTING ON `tenant` — the one builder of it, for
 * switchTenant and runAsTenant.
 *
 * A NEW object: the same master key, url and explicit sign-in, the new tenant,
 * and a context of its own. Two things went wrong while a switch edited the
 * record instead (`session.tenant = newTenant`, 94b9bc0):
 *   - every call in flight on the session holds that same object (runToolCall),
 *     so one call's switch moved the rest of the others' requests — a deploy's
 *     polls, a GitHub write — onto its tenant;
 *   - the context came along, and master-mode headers send its actor as
 *     X-ADAS-ACTOR-ID (852b373), so tenant A's actor went out on tenant B's
 *     requests. The context belongs to the tenant, as on a platform session
 *     (resetPlatformSession).
 * The same tenant is no switch: the record itself comes back.
 */
function masterRecordFor(record, tenant) {
  if (record.tenant === tenant) return record;
  return { ...record, tenant, lastActivity: Date.now(), context: {} };
}

/**
 * Switch the active tenant of a master-key session (no re-auth needed): the
 * dispatcher's per-call `tenant` override. Returns true if switched, false if
 * not in master mode.
 *
 * Like a sign-in (setSessionCredentials) it REPLACES the session's record and
 * this call adopts the new one; a call already in flight keeps the record it
 * started with. The switch stays for the session's later calls, as it always
 * has. A sweep over tenants uses runAsTenant instead, which moves nothing but
 * its own call.
 */
export function switchTenant(sessionId, newTenant) {
  const current = sessionRecord(sessionId);
  if (!current?.masterKey) return false;
  const record = masterRecordFor(current, newTenant);
  if (record !== current) {
    sessions.set(sessionId, record);
    adoptRecord(sessionId, record);
  }
  console.log(`[Auth] Master mode tenant switch: ${newTenant} (session ${sessionId})`);
  return true;
}

/**
 * Run `fn` as the master-key session acting on `tenant`, for THIS CALL ALONE.
 *
 * ateam_status_all and ateam_sync_all visit every tenant in turn. They used to
 * switchTenant through all of them, which moved the SESSION: a parallel call
 * with no `tenant` arg (a GitHub write meant for the session's own tenant) went
 * out as whichever tenant the sweep had reached, and the sweep left the session
 * on the last tenant it visited. Here only `fn` sees the other tenant; the
 * session and every other call keep theirs.
 *
 * Throws when the session is not in master mode. Running `fn` as the session's
 * own tenant instead would label that tenant's data with another tenant's name.
 */
export function runAsTenant(sessionId, tenant, fn) {
  const current = sessionRecord(sessionId);
  if (!current?.masterKey) {
    throw new Error(`runAsTenant: session ${sessionId} is not in master mode; refusing to act as tenant "${tenant}".`);
  }
  return toolCall.run({ sessionId, record: masterRecordFor(current, tenant) }, fn);
}

/**
 * Check if a session is in master key mode.
 */
export function isMasterMode(sessionId) {
  const session = sessionRecord(sessionId);
  return !!(session?.masterKey);
}

/**
 * THE CREDENTIALS A REQUEST CARRIES: the session's own record (ateam_auth, or
 * the bearer seeded by http.js), and nothing else.
 *
 * It fell back to ADAS_API_KEY / ADAS_TENANT for a session with no record
 * (3d8ec1c, 4fbe006). The auth gate never counted that as a sign-in, so the
 * fallback served only the tools the gate let through — and a signed-out
 * session's ateam_validate_solution went out with the environment's key: the
 * Builder verified it, read that tenant's state and billed an LLM call to it.
 * A key in the environment is no longer sent anywhere; envApiKeyPresent()
 * only lets the refusal say it was found and why it does not count.
 */
export function getCredentials(sessionId) {
  const session = sessionRecord(sessionId);
  if (session) {
    return { tenant: session.tenant, apiKey: session.apiKey };
  }
  // No record: not signed in. No key, no tenant (callers check apiKey.length).
  return { tenant: null, apiKey: "" };
}

/** Is there an ADAS_API_KEY in this process's environment? For the refusal text only — it signs nothing in. */
export function envApiKeyPresent() {
  return Boolean(process.env.ADAS_API_KEY);
}

/**
 * Check if a session has been explicitly authenticated via ateam_auth.
 * Checks per-session credentials AND bearer auth overrides.
 * Used to gate tenant-aware operations — env vars alone are not sufficient
 * to deploy, update, or read solutions.
 */
export function isExplicitlyAuthenticated(sessionId) {
  if (!sessionId) return false;
  // Session has credentials AND they came from ateam_auth (not just seedCredentials)
  const session = sessionRecord(sessionId);
  if (session?.authExplicit) return true;
  // Bearer has an active auth override from a previous session's ateam_auth
  return hasBearerAuth(sessionId);
}

/**
 * WHICH ENVIRONMENT THIS SESSION'S SIGN-IN IS ON — one answer, read by
 * ateam_auth's `environment` and by the `session` opening of ateam_bootstrap
 * and the server instructions. They disagreed for a key that names no
 * environment: ateam_auth said "unstated" while the opening said "prod",
 * because the opening read served_by.
 *
 * The environment the key names; else the one the session's url names (a url
 * given to ateam_auth, or kept from an earlier sign-in — the base its calls go
 * to), or that url itself for a host that is neither; else "unstated". A key
 * that names none lands on this server's default API, and calling that "prod"
 * would turn a default into a claim.
 *
 * served_by answers a different question — which API answered a call — and
 * stays separate (servedBy).
 * @returns {string} "prod" | "dev" | a self-hosted base | "unstated"
 */
export function sessionEnvironment(sessionId) {
  const record = sessionRecord(sessionId);
  const keyEnv = parseApiKey(record?.apiKey).env;
  if (keyEnv) return keyEnv;
  // A url that is neither A-Team environment (localhost, a self-hosted
  // deployment) is named by itself, as served_by names it: "unstated" would
  // hide where the calls go.
  return envForBaseUrl(record?.apiUrl) || record?.apiUrl || "unstated";
}

/**
 * HOW THIS SESSION SIGNS IN AND MOVES — the facts signInSteps.js renders its
 * steps from, read in one place:
 *   - audience: "platform" for a session owned by PLATFORM_PRINCIPAL (the A-Team
 *     app's builder, via ateam-proxy-mcp); else "stdio" when the call (or the
 *     server being built) is on stdio — callTransport, the transport's own
 *     owner; else "hosted". A null transport is NOT local (callTransport).
 *   - signedIn: the gate's own test (isExplicitlyAuthenticated);
 *   - tenant, environment (sessionEnvironment), masterMode.
 * @param {string} sessionId
 * @param {{ transport?: string|null }} [opts] — for a caller outside a tool call (createServer).
 */
export function signInContext(sessionId, { transport = callTransport() } = {}) {
  const audience = sessionOwners.get(sessionId) === PLATFORM_PRINCIPAL ? "platform"
    : transport === "stdio" ? "stdio"
    : "hosted";
  const signedIn = isExplicitlyAuthenticated(sessionId);
  const record = signedIn ? sessionRecord(sessionId) : null;
  return {
    audience,
    signedIn,
    tenant: record?.tenant || null,
    environment: signedIn ? sessionEnvironment(sessionId) : null,
    masterMode: !!record?.masterKey,
  };
}

/**
 * Record activity on a session — called on every tool call.
 * Keeps the session alive and updates context for smarter UX.
 */
/**
 * Forget the session's bound actor.
 *
 * A session binds an actor from args or from a run-starting tool's result, and
 * NOTHING ever unbound it — so a session that bound a bad value ("dev", a
 * branch name a caller mistook for an actor) sent it on every later request
 * forever, each one 401-ing with `Actor "dev" not found`. Restricting where a
 * bind may come from narrows the entrance; it does not open an exit.
 *
 * Called when Core tells us the actor does not exist. Self-healing beats a
 * hint telling a human to re-authenticate a key that was never the problem.
 */
export function clearSessionActor(sessionId, reason = "") {
  const session = sessionRecord(sessionId);
  if (!session?.context?.actorId) return false;
  const had = session.context.actorId;
  delete session.context.actorId;
  console.warn(`[Auth] Unbound session actor "${had}"${reason ? ` — ${reason}` : ""}. Later calls act as the tenant until an actor is passed again.`);
  return true;
}

export function touchSession(sessionId, { toolName, solutionId, skillId, actorId } = {}) {
  const session = sessionRecord(sessionId);
  if (!session) return;

  session.lastActivity = Date.now();

  // Update context — track what the user is working on
  if (toolName) session.context.lastToolName = toolName;
  if (solutionId) session.context.activeSolutionId = solutionId;
  if (skillId) session.context.lastSkillId = skillId;
  // THE ACTOR IS SESSION STATE, NOT A PER-CALL ARGUMENT.
  //
  // A job belongs to an ACTOR, and Core enforces that on every per-job read.
  // The tenant API key is roleless — it identifies a tenant, i.e. NOBODY — so
  // without an actor a caller is refused reads of jobs it kicked off itself and
  // just listed. Threading actor_id through each tool made five of six job-facing
  // tools forget it (get_chain, chain_status, test_status, test_abort,
  // get_metrics) — and get_chain's own description PROMISED actor scoping its
  // schema could not express. Remembering it here means no tool can forget.
  //
  // Learned from whatever the caller last supplied, and from ateam_conversation's
  // reply, which is where an actor id comes from in the first place. Safe to keep:
  // the Builder applies realActorId() before forwarding, so a generated
  // test_<ts>_<rand> thread key is dropped rather than sent to Core (which 401s on
  // an actor it cannot find). An explicit actor_id on a call still wins. (2026-08-22.)
  // ONLY A REAL ACTOR. ateam_conversation mints a throwaway THREAD key
  // (test_<ts>_<rand>) for anonymous use and returns it as actor_id — the docs
  // tell callers to pass it back for multi-turn. It is not an actor Core can
  // resolve, and Core 401s the WHOLE REQUEST on an actor it cannot find.
  //
  // I shipped this without the filter and broke ateam_chain_status — the tool
  // every agent polls in a loop — for a chain the same session had just
  // started: 403 "Access denied" became 401 "Authentication required". The
  // commit claimed it was safe because "the Builder applies realActorId()
  // first", which is true only of the two routes I had touched, not of the
  // status/chain pipes. Asserting a safety property that holds locally and
  // assuming it holds everywhere is how the header reached Core unfiltered.
  //
  // So the rule lives at the SOURCE too, matching the Builder's
  // GENERATED_THREAD_ACTOR_RE exactly. (2026-08-22.)
  if (actorId && !/^test_\d+_[a-z0-9]+$/i.test(String(actorId))) {
    session.context.actorId = String(actorId);
  }
}

/**
 * Get session context — what the user has been working on.
 * Returns {} if no session or no context.
 */
export function getSessionContext(sessionId) {
  const session = sessionRecord(sessionId);
  if (!session) return {};
  return { ...session.context };
}

/**
 * Remove session credentials (on disconnect).
 */
export function clearSession(sessionId) {
  sessionOwners.delete(sessionId);
  sessions.delete(sessionId);
}

// ── Session ownership ──────────────────────────────────────────────

/** Bind a session to its OAuth bearer token. Called from seedCredentials. */
export function bindSessionBearer(sessionId, bearerToken) {
  sessionOwners.set(sessionId, bearerToken);
  console.log(`[Auth] Bearer bound for session ${sessionId}`);
}

/**
 * Bind a session to the platform principal (a request that presented the
 * platform secret — see PLATFORM_PRINCIPAL). Called from seedCredentials.
 * Seeds NO credentials: the tenant arrives later, in-band, through ateam_auth.
 */
export function bindSessionPlatform(sessionId) {
  sessionOwners.set(sessionId, PLATFORM_PRINCIPAL);
  console.log(`[Auth] Platform principal bound for session ${sessionId}`);
}

/**
 * ON A PLATFORM SESSION, EVERY ateam_auth STARTS FROM NOTHING. Called first
 * thing in ateam_auth; a no-op on any other session.
 *
 * setSessionCredentials MERGES into the record it finds: it keeps the previous
 * apiUrl (57007d3), masterKey (94b9bc0) and context (4dc8f17), which holds the
 * active solution, the last skill and the bound actor (touchSession). On a
 * bearer's session that is ONE user signing in again, and keeping them is the
 * point. A platform session is the opposite. ateam-proxy-mcp keeps ONE session
 * for EVERY tenant (Core holds one MCP session per connector) and signs each
 * tenant in before its calls, so the merge handed the next tenant what the last
 * one left:
 *   - its url: a key that names no environment went to a host the previous
 *     tenant's agent had chosen, and every call after it too;
 *   - its master key: the next tenant's calls went out as x-adas-token = that
 *     value, and without the next tenant's own key;
 *   - its actor: the next tenant's calls carried X-ADAS-ACTOR-ID of the
 *     previous tenant's user;
 *   - its context: the next tenant's ateam_bootstrap showed the previous
 *     tenant's active solution.
 * So the record is dropped BEFORE ateam_auth reads anything (its whoami base is
 * getBaseUrl, which reads the record), and it stays dropped if the sign-in then
 * fails: a failed sign-in leaves nobody signed in, never the tenant before.
 * The owner binding stays; only the credentials and the context go.
 *
 * Dropped for the ateam_auth call itself too (it started holding the previous
 * tenant's record — runToolCall), and ONLY for it: another tenant's call still
 * in flight on this session keeps its own record to the end.
 */
export function resetPlatformSession(sessionId) {
  if (!sessionId || sessionOwners.get(sessionId) !== PLATFORM_PRINCIPAL) return false;
  if (sessions.delete(sessionId)) {
    console.log(`[Auth] Platform session ${sessionId}: previous sign-in dropped before ateam_auth`);
  }
  adoptRecord(sessionId, null);
  return true;
}

/**
 * A REFUSED SIGN-IN CHANGES NOTHING. ateam_auth writes the new key into the
 * session so its check request carries it; call this first, and call what it
 * returns if the API refuses the key: the session — and this call — are back on
 * exactly the record they had. It left a stdio session on the refused key, and
 * the session's opening then said it was signed in.
 *
 * Only what THIS sign-in wrote is taken back: if another call signed the
 * session in meanwhile (the store no longer holds this call's record), that
 * sign-in stays. A platform session was reset before this (resetPlatformSession),
 * so for it "as it was" is signed out, as that function documents.
 */
export function beginSignIn(sessionId) {
  const call = toolCall.getStore();
  const inCall = !!call && call.sessionId === sessionId;
  const before = sessions.get(sessionId) || null;
  const callBefore = inCall ? call.record : null;
  return function refused() {
    if (!inCall || (sessions.get(sessionId) || null) === call.record) {
      if (before) sessions.set(sessionId, before);
      else sessions.delete(sessionId);
    }
    if (inCall) call.record = callBefore;
  };
}

/**
 * The owner a session is bound to — a bearer string or PLATFORM_PRINCIPAL — or
 * null if there is none. Used by the HTTP transport to enforce that a bound
 * session can only be reused by a request presenting the SAME owner: a
 * client-supplied session-id alone must never grant access to another client's
 * credentials.
 *
 * With OAuth on, every LIVE session has a binding: seedCredentials binds on
 * every POST, and the binding is removed only together with the transport
 * (clearSession, on close). The idle sweep keeps it — see sweepStaleSessions.
 * So null means either an id with no live session behind it (never existed,
 * closed, or lost in a restart: stale-recovery then opens a fresh session under
 * it with the caller's OWN credentials), or ATEAM_OAUTH_DISABLED=1.
 */
export function getSessionOwner(sessionId) {
  return sessionOwners.get(sessionId) || null;
}

/**
 * May a request presenting `presented` reuse a session whose bound owner is
 * `boundOwner`? `presented` is the request's validated bearer, PLATFORM_PRINCIPAL
 * if it presented the platform secret, or null/undefined if neither.
 *
 * - No bound owner → nothing to match against, allow. With OAuth on, a live
 *   session is never unbound (see getSessionOwner), so this is an id with no
 *   live session behind it, or ATEAM_OAUTH_DISABLED=1.
 * - Bound owner → the request MUST present the exact same owner. A missing or
 *   different bearer is denied — so a client that knows another client's
 *   (non-secret, logged/echoed) session-id cannot be served that client's
 *   credentials by sending the id with no/other Authorization. The platform
 *   principal is a Symbol, so it matches only itself: a bearer cannot reuse a
 *   platform session, and the platform secret cannot reuse a bearer's.
 *
 * Pure + exported for unit testing.
 */
export function sessionOwnershipOk(boundOwner, presented) {
  if (!boundOwner) return true;
  return !!presented && presented === boundOwner;
}

/**
 * Store ateam_auth override for this user (by bearer). Called from tools.js.
 *
 * A platform session gets NO override. ateam_auth still sets that session's own
 * credentials (setSessionCredentials), which is all the proxy needs: it signs
 * each tenant in on the session it is about to use.
 */
export function setAuthOverride(sessionId, { tenant, apiKey, apiUrl }) {
  const bearer = bearerOf(sessionId);
  if (!bearer) {
    const why = sessionOwners.get(sessionId) === PLATFORM_PRINCIPAL
      ? "it is a platform session, and an override is per bearer"
      : "no bearer is bound to it";
    console.log(`[Auth] Override NOT stored for session ${sessionId}: ${why}. The session's own credentials are set.`);
    return;
  }
  authOverrides.set(bearer, { tenant, apiKey, apiUrl: apiUrl || null, updatedAt: Date.now() });
  console.log(`[Auth] Override stored for bearer (tenant: ${tenant}${apiUrl ? ", url: " + apiUrl : ""})`);
}

/** Get ateam_auth override for a bearer token. Returns null if none/expired. */
export function getAuthOverride(bearerToken) {
  const entry = authOverrides.get(bearerToken);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL) {
    authOverrides.delete(bearerToken);
    return null;
  }
  return { tenant: entry.tenant, apiKey: entry.apiKey, apiUrl: entry.apiUrl || null };
}

/**
 * A NEW SIGN-IN ON THE A-TEAM PAGE DROPS THE OVERRIDE KEPT FOR THAT KEY.
 * Called when /authorize issues a token (oauth.js exchangeAuthorizationCode).
 * An override is per bearer and re-applied to every new session of it
 * (http.js seedCredentials) for SESSION_TTL, so without this a user who signed
 * in again with their key — to get back to its workspace — stayed on the
 * workspace an earlier ateam_auth had moved that bearer to.
 */
export function clearAuthOverride(bearerToken) {
  if (bearerToken && authOverrides.delete(bearerToken)) {
    console.log("[Auth] Override dropped for bearer: a new sign-in on the A-Team page");
  }
}

/**
 * Get the base URL for a session. Resolution order:
 *   1. Per-session apiUrl (set via ateam_auth url parameter)
 *   2. Bearer auth override apiUrl
 *   3. Environment variable ADAS_API_URL
 *   4. Default: https://api.ateam-ai.com
 */
export function getBaseUrl(sessionId) {
  // 1. Per-session
  const session = sessionRecord(sessionId);
  if (session?.apiUrl) return session.apiUrl;
  // 2. Bearer override
  if (sessionId) {
    const bearer = bearerOf(sessionId);
    if (bearer) {
      const override = getAuthOverride(bearer);
      if (override?.apiUrl) return override.apiUrl;
    }
  }
  // 3/4. Env or default
  return BASE_URL;
}

/**
 * Map an API base URL → the user-facing app URL where a deployed change is
 * visible. ateam-mcp is a PUBLIC MCP: a given user talks to exactly ONE
 * platform (their tenant is on one live deployment), so the useful thing to
 * surface is NOT an internal "env" but WHERE to go look at the result.
 *   api.ateam-ai.com          → app.ateam-ai.com          (prod)
 *   dev-api.ateam-ai.com      → dev-app.ateam-ai.com      (our internal dev)
 *   anything else (self-host) → best-effort api→app swap, or the base itself
 */
export function apiToAppUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    // host swaps: <x>api.<domain> → <x>app.<domain>; "api." prefix → "app."
    let host = u.hostname;
    if (host.startsWith("api.")) host = "app." + host.slice(4);
    else if (host.startsWith("dev-api.")) host = "dev-app." + host.slice(8);
    else if (host.includes("-api.")) host = host.replace("-api.", "-app.");
    else if (host.includes("api")) host = host.replace(/api/, "app");
    return `${u.protocol}//${host}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Location stamp for a tool result: which tenant + which app URL a change
 * landed on. Returned as `_where` so any consumer (desktop, mobile, cloud
 * agent) can tell the user where to see it — no reliance on a plugin SKILL.md.
 */
export function getWhere(sessionId) {
  let tenant = null;
  try { tenant = getCredentials(sessionId)?.tenant || null; } catch { /* unauthed */ }
  // PLATFORM INTERNALS NEVER REACH THE AGENT. This used to return
  // `app_url` plus a `_note` telling the agent to "view it at
  // http://skill-builder-backend" — an internal compose service name. The
  // agent cannot reach it, cannot act on it, and cannot show it to a user;
  // it resolves nowhere outside Docker. Worse than useless: an
  // actionable-looking instruction that leads nowhere.
  //
  // Only a PUBLIC url is worth returning, so we return one only when the
  // resolved host actually looks public. Otherwise `_where` is just the
  // tenant, which is the part that is solution-scoped and that the agent
  // genuinely needs. (Arie, 2026-08-21, reading a raw error panel.)
  // A non-production A-Team environment's app is not named (shownBase).
  const base = getBaseUrl(sessionId);
  if (shownBase(base) !== base) return tenant ? { tenant } : {};
  const appUrl = apiToAppUrl(base);
  const isPublic = /^https?:\/\/[^/]*\./.test(appUrl || "") && !/^https?:\/\/(localhost|127\.|\[?::1)/i.test(appUrl || "");
  if (!isPublic) return tenant ? { tenant } : {};
  return {
    tenant,
    app_url: appUrl,
    _note: tenant
      ? `This change is on tenant "${tenant}". View it at ${appUrl}.`
      : `View at ${appUrl}.`,
  };
}

/** Check if a bearer has an active auth override. */
export function hasBearerAuth(sessionId) {
  const bearer = bearerOf(sessionId);
  return bearer ? authOverrides.has(bearer) : false;
}

/**
 * Sweep expired sessions — drops the CREDENTIALS of sessions idle longer than
 * SESSION_TTL. Returns the number of sessions swept.
 *
 * It does NOT drop the session's owner binding, and must not. sessionOwners
 * is the session's OWNER: denySessionReuse (src/http.js) compares every request
 * against it. This sweep never closes the transport, so the session is still
 * live after it. 8fc71af deleted the binding here too, back when the map was
 * only ateam_auth's actor lookup. c294d0f then made it the owner and left this
 * line alone, so an idle session became an unowned one: the next well-formed
 * bearer took over the live transport, and the real owner was refused as "a
 * different credential". The owner's next request re-seeds the credentials
 * from its bearer. The binding goes when the transport does (clearSession).
 *
 * A PLATFORM session is not re-seeded: it has no bearer and no override, by
 * design. After an idle hour its tenant tools are refused at the dispatcher's
 * auth gate (isError, structuredContent { code: "UNAUTHENTICATED", stage:
 * "auth_gate" }), and ateam-proxy-mcp re-runs ateam_auth and replays on exactly
 * that signal: the stage says the tool did not run. test/session-isolation.test.mjs
 * pins that contract.
 */
export function sweepStaleSessions() {
  const now = Date.now();
  let swept = 0;
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL) {
      sessions.delete(sid);
      swept++;
    }
  }
  // Also sweep expired auth overrides
  let overridesSwept = 0;
  for (const [bearer, entry] of authOverrides) {
    if (now - entry.updatedAt > SESSION_TTL) {
      authOverrides.delete(bearer);
      overridesSwept++;
    }
  }
  if (swept > 0 || overridesSwept > 0) {
    console.log(`[Session] Swept ${swept} session(s), ${overridesSwept} override(s). ${sessions.size} active, ${authOverrides.size} overrides.`);
  }
  return swept;
}

/**
 * Start the periodic session sweep timer.
 * Called once from HTTP transport on startup.
 */
export function startSessionSweeper() {
  const timer = setInterval(sweepStaleSessions, SWEEP_INTERVAL);
  timer.unref(); // don't prevent process exit
  console.log(`[Session] Sweep timer started (interval: ${SWEEP_INTERVAL / 1000}s, TTL: ${SESSION_TTL / 1000}s)`);
  return timer;
}

/**
 * Get session stats — for health checks and debugging.
 */
export function getSessionStats() {
  const now = Date.now();
  let oldest = Infinity;
  let newest = 0;
  for (const [, session] of sessions) {
    if (session.lastActivity < oldest) oldest = session.lastActivity;
    if (session.lastActivity > newest) newest = session.lastActivity;
  }
  return {
    active: sessions.size,
    oldestAge: sessions.size > 0 ? Math.round((now - oldest) / 1000) : 0,
    newestAge: sessions.size > 0 ? Math.round((now - newest) / 1000) : 0,
  };
}

function headers(sessionId) {
  const session = sessionRecord(sessionId);

  // Master mode: use shared secret auth (x-adas-token) instead of API key.
  // A master-mode session MUST have an active tenant (set via ateam_auth or
  // switchTenant). Silent fallback to "main" previously masked configuration
  // bugs and could pivot a master-key caller onto the wrong tenant.
  if (session?.masterKey) {
    if (!session.tenant) {
      throw new Error(
        `headers: master-mode session ${sessionId} has no active tenant — ` +
        `caller must select a tenant via ateam_auth or switchTenant before making requests.`
      );
    }
    const h = { "Content-Type": "application/json" };
    h["x-adas-token"] = session.masterKey;
    h["X-ADAS-TENANT"] = session.tenant;
    if (session.context?.actorId) h["X-ADAS-ACTOR-ID"] = session.context.actorId;
    return h;
  }

  // Normal mode: API key auth
  const { tenant, apiKey } = getCredentials(sessionId);
  const h = { "Content-Type": "application/json" };
  if (tenant) h["X-ADAS-TENANT"] = tenant;
  if (apiKey) h["X-API-KEY"] = apiKey;
  // The acting actor rides with the tenant on EVERY call — see touchSession.
  // The tenant says WHICH account; the actor says WHO, and per-job reads need
  // both. Adds no authority: Core resolves the actor INSIDE the authenticated
  // tenant and 401s if it is not there.
  if (session?.context?.actorId) h["X-ADAS-ACTOR-ID"] = session.context.actorId;
  return h;
}

// Core's own wording, and the only free-text form trusted: the actor's name in
// real quotes (a nested hop may escape them). `unknown actor` is NOT here —
// nothing emits it, and the bare phrase matched Core's own
// "unknown actor_skills plugin: <id>" (actorWidgetNamespace.js).
const ACTOR_NOT_FOUND_TEXT_RX = /\bActor\s+\\?"([^"\\]+)\\?"\s+not found/i;

/**
 * ONE answer to "is this error body an actor-not-found?". formatError's hint
 * and request()'s self-heal both ask it; they used to carry two regexes that
 * had already drifted (the self-heal made the quotes optional and matched
 * ACTOR_NOT_FOUND as a bare substring anywhere in the body), so any 400 that
 * merely ECHOED that token unbound a valid session actor.
 *
 * Only two shapes count, and only at the TOP LEVEL of the body:
 *   - the Builder's structured `code: "ACTOR_NOT_FOUND"`
 *   - Core's `error: 'Actor "X" not found'` (the error/message string, or a
 *     non-JSON body that is exactly that sentence)
 * A token inside a nested or echoed field is data, not a verdict.
 *
 * @param {number} status
 * @param {string|object} body
 * @returns {{ actor: string|null } | null}  null when the body is not an actor-not-found
 */
export function actorNotFound(status, body) {
  if (status !== 401 && status !== 400) return null;
  let obj = body && typeof body === "object" ? body : null;
  if (!obj && typeof body === "string") {
    try { obj = JSON.parse(body); } catch { /* not JSON — judged as text below */ }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const said = [obj.error, obj.message].find((v) => typeof v === "string") || "";
    const named = ACTOR_NOT_FOUND_TEXT_RX.exec(said);
    if (obj.code === "ACTOR_NOT_FOUND" || named) return { actor: named ? named[1].trim() : null };
    return null;
  }
  const named = typeof body === "string" ? ACTOR_NOT_FOUND_TEXT_RX.exec(body) : null;
  return named ? { actor: named[1].trim() } : null;
}

/**
 * A PERSON THE PLATFORM WILL NOT ACT AS — Core's named refusals (ai-dev-assistant
 * 9f32bac37), which the Builder answers in its own words with the same code
 * (Builder #117). Each is a 401 whose top-level `code` says which:
 *   KEY_OWNER_DELETED   the person this API key belongs to (who minted it) was
 *                       deleted: the key runs nothing, as anyone;
 *   KEY_OWNER_INACTIVE  that person is no longer active in the workspace;
 *   ACTOR_INACTIVE      Core will not act as the person a call named.
 * Not an actor this session sent by mistake (actorNotFound), and not a key
 * that was rotated (the table's 401): each has its own way out, and saying
 * "your key is fine" or "sign in again" about it sends the reader the wrong way.
 * Read like actorNotFound: the code at the TOP LEVEL of the body, never a token
 * anywhere. `actor` is the person, from Core's actorId or the Builder's actor_id.
 *
 * @param {number} status
 * @param {string|object} body
 * @returns {{ code: string, actor: string|null } | null}
 */
const PERSON_REFUSAL_CODES = new Set(["KEY_OWNER_DELETED", "KEY_OWNER_INACTIVE", "ACTOR_INACTIVE"]);
export function personRefused(status, body) {
  if (status !== 401) return null;
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : jsonBodyOf(body);
  if (!obj || !PERSON_REFUSAL_CODES.has(obj.code)) return null;
  const actor = [obj.actorId, obj.actor_id].find((v) => typeof v === "string" && v.trim());
  return { code: obj.code, actor: actor ? actor.trim() : null };
}

/** The way out of a personRefused 401, for this session as it stands (ctx). */
function personRefusalHint({ code, actor }, ctx) {
  const who = actor ? ` (actor ${actor})` : "";
  const signInWithIt = ctx.signedIn ? switchSteps(ctx) : connectSteps(ctx);
  if (code === "KEY_OWNER_DELETED") {
    return `This API key belongs to a person who has been deleted${who}. A key acts as the person who minted it, so ` +
      "this one runs nothing now, and it is never run as anyone else. Signing in again with the same key will not help: " +
      "a workspace owner or admin rotates the key (Tenant Admin → Tokens & Keys, in the A-Team app), the new key " +
      `belongs to whoever rotates it, and this session signs in with the new key.\n${signInWithIt}`;
  }
  if (code === "KEY_OWNER_INACTIVE") {
    return `This API key belongs to a person who is no longer active in this workspace${who}. A key acts as the person ` +
      "who minted it, so this one runs nothing until that changes, and it is never run as anyone else. Signing in again " +
      "with the same key will not help. Either a workspace owner or admin reactivates or approves that person (Tenant " +
      "Admin → Users, in the A-Team app), and the same key works again; or they rotate the key (Tenant Admin → Tokens & " +
      `Keys), the new key belongs to whoever rotates it, and this session signs in with the new key.\n${signInWithIt}`;
  }
  return `The platform will not act as the person${who}: they are no longer active in this workspace, so the call did ` +
    "not run. Retrying as the same person will not help. Act as a person who is active here, or have a workspace owner " +
    "or admin reactivate or approve that person (Tenant Admin → Users, in the A-Team app). If that person is the one " +
    "this session's key belongs to, the key acts as nobody else: reactivate them, or rotate the key (Tenant Admin → " +
    "Tokens & Keys) and sign this session in with the new one.";
}

/**
 * Does this 404 body say that a SOLUTION or SKILL is missing (as opposed to a
 * file, job or connector inside one)? Read like actorNotFound: the structured
 * code, or the top-level error/message sentence, never a token anywhere.
 */
const SOLUTION_OR_SKILL_MISSING_RX = /\b(?:solution|skill)\b[^.]{0,80}?\bnot found\b|^no (?:solution|skill)\b/i;
function solutionOrSkillMissing(body) {
  let obj = body && typeof body === "object" ? body : null;
  if (!obj && typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return SOLUTION_OR_SKILL_MISSING_RX.test(body.trim()); }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.code === "SOLUTION_NOT_FOUND" || obj.code === "SKILL_NOT_FOUND") return true;
  if (obj.code) return false;
  const said = [obj.error, obj.message].find((v) => typeof v === "string") || "";
  return SOLUTION_OR_SKILL_MISSING_RX.test(said);
}

/**
 * Format an API error into a user-friendly message with actionable hints.
 *
 * Exported so the hints can be TESTED as behaviour rather than as source text.
 * A test that greps for the right-looking code passes on code that never runs.
 */
export function formatError(method, path, status, body, baseUrl, { read = method === "GET", signIn = null, refusedSignIn = false } = {}) {
  // How this session signs in or moves (signInContext): request() passes it.
  // A direct caller that passes none is told the hosted steps, with the
  // environment of the base it called.
  const ctx = signIn || { audience: "hosted", signedIn: true, environment: envForBaseUrl(baseUrl) || baseUrl || null };
  // The base as a served text may show it (shownBase): no non-production host.
  const shown = baseUrl ? shownBase(baseUrl) : baseUrl;
  // A key given to ateam_auth that the API refused: ctx is the session AFTER
  // beginSignIn put it back, so it says where the session still stands. The
  // 401 text below is for a key the session signed in with, which this is not.
  const signInRefused = () => {
    const stands = ctx.signedIn
      ? `still signed in to ${ctx.tenant ? `workspace "${ctx.tenant}"` : "the workspace it was on"}`
      : "still not signed in";
    return `The API refused the key given to ateam_auth (rotated, revoked, or not a key for this API). Nothing changed: this session is ${stands}.\n` +
      (ctx.signedIn ? switchSteps(ctx) : connectSteps(ctx));
  };
  // A WRITE IS NOT "TRY AGAIN IN A MINUTE". request() does not re-send one
  // that may have reached the server, and a hint telling the caller to re-send
  // it would undo that: it may already have run.
  const again = read
    ? "Try again in a minute."
    : "The call was not re-sent: check whether it took effect before issuing it again.";
  const hints = {
    400: "Bad request — see the error details above for what to fix.",
    // 401/403 sent the user to …/get-api-key to bring the agent a key for
    // ateam_auth (c6e7275): the agent asking for a key. The steps are
    // signInSteps.js's, word for word, for how THIS session is connected.
    401: refusedSignIn ? signInRefused()
      : ctx.signedIn
      ? `The API refused the key this session signed in with: it may have been rotated.\n${switchSteps(ctx)}`
      : `The API refused this call: this session is not signed in to a workspace.\n${connectSteps(ctx)}`,
    403: refusedSignIn ? signInRefused()
      : `This key is not allowed to do this here. A key acts only in its own workspace; if the user meant another one:\n${switchSteps(ctx)}`,
    404: "Resource not found. Check the solution_id or skill_id you're using. Use ateam_list_solutions to see available solutions.",
    409: "Conflict — the resource may already exist or is in a conflicting state.",
    422: "Validation failed. Check the request payload against the spec (use ateam_get_spec).",
    429: "Rate limited. Wait a moment and try again.",
    500: `A-Team server error. The platform may be temporarily unavailable. ${again}`,
    502: `A-Team API is unreachable. The service may be restarting. ${again}`,
    503: `A-Team API is temporarily unavailable. ${again}`,
  };

  // A 401 IS NOT ALWAYS AN AUTH PROBLEM, AND SAYING SO COSTS A RUN.
  //
  // The table above answers EVERY 401 with a sign-in hint, by status code,
  // never by cause (from c6e7275 to #38 that hint read "your API key may be
  // invalid or expired — get a new key and call ateam_auth").
  // Core also returns 401 for `Actor "X" not found`, where the key is perfectly
  // valid and the actor is the problem. A PROD agent believed that hint this
  // morning, stopped, and asked the admin to paste an API key — for an error
  // that had nothing to do with keys. An error naming the wrong remedy does not
  // just fail; it sends someone competent in the wrong direction.
  // 400 is here too. The same cause reaches us with two different codes
  // depending on which hop classified it: Core answers 401 directly, while the
  // Builder's test route hands back a 400 ACTOR_NOT_FOUND. Keying this on 401
  // alone meant the correctly-classified one missed the hint entirely — the
  // guard did not follow the fix.
  const notFound = actorNotFound(status, body);
  if (notFound) {
    // The structured code carries no name — say "the actor you sent" rather
    // than printing empty quotes.
    const who = notFound.actor || "you sent";
    // Every sentence here must be something the code does. This used to end
    // "call ateam_auth again to reset the session binding" — ateam_auth does
    // not: setSessionCredentials carries the session's context, actor
    // included, across a sign-in. What does drop it is request(): on this same
    // response, with this same classifier, it unbinds the session's actor
    // before this message is built (clearSessionActor). So the true remedy is
    // the cheaper one: retry.
    hints[status] =
      `NOT an auth problem — your key is fine. Core does not recognise the ACTOR "${who}" in this tenant. ` +
      `Re-authenticating will not help. Either pass a real actor id (the one ateam_conversation returned for the thread), ` +
      `or omit the actor entirely to act as the tenant. If you never sent an actor, this session was carrying a stale one: ` +
      `it has been dropped with this error, so retrying the same call now acts as the tenant.`;
  }

  // A 404 ON /spec IS NOT A MISSING SOLUTION.
  //
  // The table answers every 404 with "check the solution_id or skill_id".
  // /spec/* takes neither. Asking for a topic this deployment does not serve —
  // which happens the moment the tool ships ahead of the backend, as
  // device-capabilities did on 2026-09-04 — sent the reader looking for a
  // solution that was never involved. The environment is the whole answer, so
  // name it: the same call against a newer deployment succeeds.
  if (status === 404 && /^\/spec(\/|$)/.test(String(path || ""))) {
    const topic = String(path).replace(/^\/spec\/?/, "") || "(index)";
    hints[404] =
      `Nothing to do with solutions — /spec takes no solution_id or skill_id. The A-Team API at ` +
      `${shown || "this URL"} does not serve the topic "${topic}". Either the topic name is wrong (ateam_get_spec ` +
      `with topic:"overview" lists what this deployment has), or this backend is OLDER than the tool you are ` +
      `calling from and the topic has not been deployed here yet. Retrying will not change either.`;
  }

  // A 404 FROM A DEPLOYMENT WITHOUT THE TRIGGER PROBE IS NOT A WRONG ID.
  //
  // ateam_get_solution(view:"triggers") reads GET /deploy/solutions/:id/skills/
  // :sk/triggers, which the Builder serves from BUILDER-10 on. A backend older
  // than the tool answers Express's own HTML "Cannot GET …" page; the route's
  // genuine not-found is JSON ({"error":"Skill not found"}). The table gave both
  // "check the solution_id or skill_id", so "this deployment cannot check a
  // schedule" read exactly like a typo — and a builder could go on to report
  // the schedule as set up. Same trap as /spec above; same answer: name the
  // environment.
  if (status === 404 && /^\/deploy\/solutions\/[^/]+\/skills\/[^/]+\/triggers$/.test(String(path || "")) && jsonBodyOf(body) === null) {
    hints[404] =
      `Not a solution_id or skill_id problem — the A-Team API at ${shown || "this URL"} does not serve the trigger ` +
      `probe yet (the Builder route behind view:"triggers" is not deployed there). Nothing was checked: do NOT report ` +
      `the schedule as registered or as running. Retrying will not change it.`;
  }

  // The body as TEXT — ONE normalization for every check below. request()
  // passes the text it read; anything else (a direct caller) is serialized.
  // This function had grown three copies of this line (the 5xx check, the
  // github_not_connected + specific-hint checks, and `detail`), each spelled a
  // little differently.
  const bodyStr = typeof body === "string" ? body
    : body == null ? ""
    : (() => { try { return JSON.stringify(body); } catch { return ""; } })();

  // A 500 THAT NAMES A MISSING CONFIGURATION IS NOT "TRY AGAIN IN A MINUTE".
  //
  // /chat answered 500 {"message":"OPENAI_API_KEY is not set"} and this table
  // labelled it "the platform may be temporarily unavailable — try again in a
  // minute". Every part is wrong: nothing is unavailable, a minute changes
  // nothing, and the fix is to set a key. An agent obeying that hint burns its
  // retries on a condition that cannot clear on its own. The body already said
  // so; only the hint disagreed. (2026-08-22, found by sweeping every tool.)
  if (status >= 500) {
    const m = /\b([A-Z][A-Z0-9_]{3,})\s+is not set\b|\bmissing (?:env|environment) (?:var|variable)\s+([A-Z0-9_]+)/i.exec(bodyStr);
    if (m) {
      const name = m[1] || m[2];
      hints[status] =
        `CONFIGURATION, not an outage: the server reports ${name} is not set. Retrying will not help and nothing is down — ` +
        `this needs ${name} configured on the A-Team backend serving ${shown || "this API"}. Other tools are unaffected.`;
    }
  }

  // Special-case: GitHub App not connected for this tenant. This is the wall a
  // user hits the first time they iterate on CONNECTOR CODE (github_patch /
  // github_write / github_push / build_and_run auto-pull). The raw
  // "github_not_connected" code + a generic 409 hint tells them nothing — so
  // guide them explicitly to the one-time connect step and note the repo-less
  // escape hatch for definition edits.
  if (/github_not_connected/i.test(bodyStr)) {
    return [
      `A-Team API error: ${method} ${path} — GitHub isn't connected for this tenant.`,
      "",
      "Versioned connector-code changes (edit, push, promote, deploy-from-repo) need a",
      "GitHub repo, and this tenant hasn't connected one yet.",
      "",
      "→ Open this guide and follow the 3 steps: https://mcp.ateam-ai.com/connect-github",
      "",
      "In short: Tenant Admin → GitHub → \"Connect GitHub\", approve the App, then retry.",
      "The repo is auto-created on the next deploy.",
      "",
      "No GitHub yet? Skill/solution DEFINITION edits still work without a repo via",
      "ateam_patch(..., source:\"local\"). Only connector CODE iteration needs GitHub.",
    ].join("\n");
  }

  // A GENERIC HINT MUST NOT CONTRADICT A SPECIFIC ONE. When the body already
  // carries its own `code` + `hint`, the endpoint has diagnosed the failure
  // precisely — appending the status-level guess produces two hints pointing
  // opposite ways, and the reader follows the wrong one. Observed 2026-08-21
  // (job_aehopl8z): a patch whose search string did not match came back with
  // the endpoint's correct "re-read the file and copy the exact bytes"
  // followed by "Check the solution_id … use ateam_list_solutions", and the
  // agent went hunting for a missing solution three times.
  const hasSpecificHint = /"code"\s*:/.test(bodyStr) && /"hint"\s*:/.test(bodyStr);
  // A person the platform will not act as has ONE way out, whichever hop said
  // so: Core's bare { code, actorId, error } carries no hint, so the table would
  // have answered "the key may have been rotated — sign in again"; the
  // Builder's carries one, and this adds only how THIS session signs in with a
  // new key, which no endpoint can know. It contradicts neither.
  const person = personRefused(status, body);
  const hint = person ? personRefusalHint(person, ctx)
    : hasSpecificHint ? "" : (hints[status] || "");
  // A SOLUTION THIS WORKSPACE DOES NOT HAVE MAY BE IN ANOTHER ONE. Both 404
  // hints — the table's "check the solution_id" and the Builder's own
  // SOLUTION_NOT_FOUND hint ("this tenant has: …, use one of those ids") — read
  // as "pick from what is here", so a user signed in to the wrong workspace was
  // steered to a look-alike. This adds the cause neither can see; it
  // contradicts neither, so it follows a specific hint too.
  //
  // Only where the BODY says a solution or skill is missing: the not-found
  // codes, or a top-level error/message such as Core's "Skill 'x' not found" or
  // the Builder's "Solution not found in Builder". Not on any 404 under a
  // solution's path: a missing file, job or connector inside a solution that
  // exists is not in another workspace, and a patch's NO_MATCH names its own
  // cause.
  const solutionMissing = status === 404 && solutionOrSkillMissing(body);
  // Truncated, never dropped. Before 4b36c4d a body of 2000+ chars was dropped
  // ENTIRELY, so the richer the error the less the caller was told — a 422
  // carrying the full diagnosis (ui.surfaceProbe's failures) arrived as a bare
  // status code.
  const detail = bodyStr.length < 2000 ? bodyStr : bodyStr.slice(0, 2000) + "… (truncated)";

  // Always show the FULL URL actually hit — ateam-mcp is a PUBLIC MCP with a
  // configurable base (prod default, dev/self-host overrides), so a bare
  // "POST /deploy/..." 404 is ambiguous: is the route missing, or did the
  // request go to the wrong base? The full URL disambiguates instantly.
  const target = baseUrl ? (shown === baseUrl ? `${baseUrl}${path}` : `${path} on ${shown}`) : path;
  let msg = `A-Team API error: ${method} ${target} returned ${status}`;
  if (detail) msg += ` — ${detail}`;
  if (hint) msg += `\nHint: ${hint}`;
  if (solutionMissing) msg += `\n${notInThisWorkspace(ctx)}`;

  return msg;
}

/**
 * ONE answer to "did this request fail by TIMING OUT — at a gateway, or here?"
 * (the failure an async retry can outrun, or a longer wait explain).
 *
 * Read from what request() attached to the error — the HTTP status, its own
 * timeout mark, the socket's errno — never from the message. The message
 * carries up to 2000 chars of the response body (formatError), so the regex
 * both callers used, /524|502|503|timeout|ETIMEDOUT/ over err.message, read a
 * deterministic 400 whose body merely said "timeout" as a timeout:
 * ateam_build_and_run then re-POSTed the whole deploy in async mode instead of
 * returning the real error. And it could never see ETIMEDOUT, which lives in
 * err.cause.code, not in "fetch failed".
 * @param {any} err  an error thrown by get/post/patch/del
 * @returns {boolean}
 */
export function isTimeoutError(err) {
  return err?.timedOut === true
    || [502, 503, 504, 524].includes(err?.status)
    || err?.cause?.code === "ETIMEDOUT";
}

/**
 * The JSON object a response body carries, or null when it carries none (an
 * HTML gateway page, an empty body, a bare string, an array).
 * @param {unknown} body  the raw response text (err.body)
 * @returns {object|null}
 */
export function jsonBodyOf(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  try {
    const v = JSON.parse(body);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The VERDICT a response body carries: a JSON object with a `code`. Null
 * otherwise, and that includes a bare {ok:false, error}.
 *
 * ONE answer to "did the server that owns this call answer it?". request()'s
 * retry gate asks it before re-sending a read, and ateam_delete_solution asks
 * it before calling a failure "no answer". A JSON body alone is not enough:
 * the skill-validator reports its OWN transport failures ("fetch failed", its
 * 15s proxy abort) as 502 {ok:false, error} at some 40 sites. That is a hop
 * saying it lost the answer, not the answer.
 * @param {unknown} body  the raw response text (err.body)
 * @returns {object|null}
 */
export function jsonVerdictOf(body) {
  const o = jsonBodyOf(body);
  return o && typeof o.code === "string" && o.code ? o : null;
}

/** A read: a GET, or a call its site declared `idempotent`. */
const isRead = (method, idempotent) => idempotent ?? method === "GET";

/**
 * ONE answer to "may request() send this again by itself?" (CORE ruling 11,
 * 2026-09-27). Every retry request() makes goes through here.
 *
 * NEVER A RESPONSE THAT CARRIES A VERDICT (jsonVerdictOf), whatever its
 * status. The server answered. A Builder 502 whose body names the step that
 * failed is the result, and sending the call again swaps it for the answer to
 * a different question. B7: a forced ateam_delete_solution got the Builder's
 * JSON 502 ("a Core cleanup step failed"), and request() re-sent the DELETE
 * twice without reading the body. The caller saw the last pass, which found
 * Core already empty and reported `core_skills: []`.
 *
 * ANY METHOD, WHEN THE REQUEST PROVABLY NEVER REACHED THE SERVER: the
 * connection was refused, so not one byte of it was sent. Re-sending that is
 * not a second write. This is the case c99acb7 (bug #6) was for.
 *
 * OTHERWISE ONLY A READ. After the request was sent, a write that got no
 * answer (this request's own timeout, a gateway's 502/504 page, a hop's bare
 * {ok:false,error}) may still have run. Sending it again is a second write the
 * caller never asked for, and it hides what the first one did. A read is
 * re-sent on those. `idempotent` defaults from the method: GET is a read, and
 * every other method is a write. A POST that only reads (a validator, a
 * search, a dry run) passes `{ idempotent: true }` at its call site.
 * @param {{ method: string, idempotent?: boolean, status?: number, body?: string, noAnswer?: boolean, neverSent?: boolean }} f
 *   neverSent: the connection was refused (ECONNREFUSED); nothing was sent
 *   noAnswer: the request was sent and no response arrived (own timeout)
 * @returns {boolean}
 */
export function mayAutoRetry({ method, idempotent, status, body, noAnswer = false, neverSent = false }) {
  if (neverSent) return true;
  if (!isRead(method, idempotent)) return false;
  if (noAnswer) return true;
  if (status !== 502 && status !== 504) return false;
  return jsonVerdictOf(body) === null;
}

/**
 * Core fetch wrapper with timeout and error formatting.
 * @param {string} method
 * @param {string} path
 * @param {*} body
 * @param {string} sessionId
 * @param {{ timeoutMs?: number, retries?: number, idempotent?: boolean }} [opts]
 *   retries: how many times an IDEMPOTENT READ may be re-sent after a transport
 *   failure (default 2). It never re-sends a write: mayAutoRetry decides.
 *   idempotent: declare a non-GET call a read (see mayAutoRetry).
 */
async function request(method, path, body, sessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  // 2 since c99acb7 (bug #6: a redeploy hit a 502 while the skill-builder was
  // restarting). That default re-sent EVERY method, writes included, on any
  // 502/504 and on this request's own timeout. mayAutoRetry now decides which
  // failures may be re-sent at all; this is only how many times.
  const maxRetries = opts.retries ?? 2;
  const mayRetry = (attempt, failure) =>
    attempt < maxRetries && mayAutoRetry({ method, idempotent: opts.idempotent, ...failure });
  const backoff = async (attempt, what) => {
    const wait = Math.min(5000 * (attempt + 1), 15000);
    console.error(`[MCP] ${method} ${path} ${what}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
    await new Promise(r => setTimeout(r, wait));
  };
  const baseUrl = getBaseUrl(sessionId);
  // What the messages below may show of it (shownBase): no non-production host.
  const shown = shownBase(baseUrl);
  const health = shown === baseUrl ? `${baseUrl}/health` : `/health on ${shown}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOpts = {
        method,
        headers: headers(sessionId),
        signal: controller.signal,
      };
      if (body !== undefined) {
        fetchOpts.body = JSON.stringify(body);
      }

      const res = await fetch(`${baseUrl}${path}`, fetchOpts);

      if (!res.ok) {
        // The body is read BEFORE deciding to re-send: a JSON verdict is an
        // answer, and only the body can say whether there is one.
        const text = await res.text().catch(() => "");
        if (mayRetry(attempt, { status: res.status, body: text })) {
          await backoff(attempt, `returned ${res.status} with no verdict`);
          continue;
        }
        // SELF-HEAL A BAD ACTOR BINDING. Core saying `Actor "X" not found` is
        // proof the session is carrying an actor that does not exist, and every
        // subsequent request would send it again. Restricting where a bind may
        // come from narrows the entrance; this is the exit. Unbinding costs
        // nothing when the actor was genuinely wrong, and the next call simply
        // acts as the tenant until a real actor is passed.
        // 400 as well as 401 — see the hint block above. The Builder's test
        // route classifies this correctly as 400 ACTOR_NOT_FOUND, and keying
        // the self-heal on 401 alone meant the BETTER-classified error was the
        // one that failed to clear the poisoned binding. Every subsequent call
        // in the session then re-sent the actor Core had just rejected, which
        // is precisely the latch the external build hit: a refused actor_id
        // survived into ateam_upload_connector, a call that takes no actor.
        // The SAME classifier as the hint above — see actorNotFound for why a
        // second, looser copy here unbound valid actors on echoed 400s.
        if (actorNotFound(res.status, text)) {
          clearSessionActor(sessionId, `Core rejected it on ${method} ${path}`);
        }
        // Attach the HTTP status so callers can distinguish a genuine 404
        // (resource absent) from a transient/5xx failure. ateam_patch relies
        // on this to NOT scaffold-clobber an existing skill on a read error.
        const e = new Error(formatError(method, path, res.status, text, baseUrl, { read: isRead(method, opts.idempotent), signIn: signInContext(sessionId) }));
        e.status = res.status;
        // Keep the RAW body on the error. formatError truncates for humans, and
        // an endpoint that answers 4xx WITH the diagnosis (ui.surfaceProbe's 422
        // carries the failures explaining why a surface is broken) is exactly the
        // case where the body matters more than the status. A caller that knows
        // how to read its own error shape should not have to scrape a message.
        e.body = text;
        throw e;
      }

      // THE ONE PARSE OF A SUCCESS BODY. It was `res.json()` from the first
      // commit on, and an empty body made that "Unexpected end of JSON input":
      // a bare SyntaxError naming no call, no status and no server (MGAP-A19,
      // the Builder's /spec/skill?search answering 200 with nothing). An empty
      // or blank 2xx body is now EMPTY_RESPONSE, naming the call; it is never
      // read as {}. A 204 too: no route this client calls answers one, and
      // every caller reads fields off the result, so a null would only fail
      // later, unnamed.
      // Not awaited, as res.json() was not: this attempt's timer is cleared
      // once the status is in, so a call that answered is never re-sent or
      // reported as "did not respond" because its body was slow.
      return res.text().then((text) => {
        if (text.trim()) return JSON.parse(text);
        throw Object.assign(new Error(
          `A-Team API ${method} ${path} answered ${res.status} with an empty body: there is no result to read (server: ${shown}).\n` +
          `Hint: the server answered success with no body.` +
          (isRead(method, opts.idempotent) ? "" : " This write was not re-sent, and it may have taken effect: check before issuing it again.")
        ), { code: "EMPTY_RESPONSE", status: res.status, method, path, body: text });
      });
    } catch (err) {
      if (err.name === "AbortError") {
        if (mayRetry(attempt, { noAnswer: true })) {
          await backoff(attempt, "timed out");
          continue;
        }
        const t = new Error(
          `A-Team API timeout: ${method} ${path} did not respond within ${timeoutMs / 1000}s.\n` +
          (isRead(method, opts.idempotent) ? "" : "It was NOT re-sent: a write that got no answer may still have run. Check its effect before issuing it again.\n") +
          `Hint: The A-Team API at ${shown} may be down. Check ${health}`
        );
        t.timedOut = true; // read by isTimeoutError — never the message
        throw t;
      }
      // NOTHING WAS SENT. `neverSent` on the error lets a caller that falls
      // back to another door (an async kick's sync fallback) know that the
      // first one never reached the server.
      if (err.cause?.code === "ECONNREFUSED") {
        if (mayRetry(attempt, { neverSent: true })) {
          await backoff(attempt, "connection refused");
          continue;
        }
        throw Object.assign(new Error(
          `Cannot connect to A-Team API at ${shown}. Nothing was sent.\n` +
          `Hint: The service may be down. Check ${health}`
        ), { neverSent: true });
      }
      if (err.cause?.code === "ENOTFOUND") {
        throw Object.assign(new Error(
          `Cannot resolve A-Team API host: ${shown}. Nothing was sent.\n` +
          `Hint: Check your internet connection and ADAS_API_URL setting.`
        ), { neverSent: true });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function get(path, sessionId, opts) {
  return request("GET", path, undefined, sessionId, opts);
}

export async function post(path, body, sessionId, opts) {
  return request("POST", path, body, sessionId, opts);
}

export async function patch(path, body, sessionId, opts) {
  return request("PATCH", path, body, sessionId, opts);
}

export async function del(path, sessionId, opts) {
  return request("DELETE", path, undefined, sessionId, opts);
}

/**
 * List all active tenants (requires master key).
 * Routes through the skill-validator's /deploy/tenants endpoint,
 * which proxies to Core. This works with any BASE_URL (including
 * public domains without explicit ports).
 */
export async function listTenants(sessionId) {
  const session = sessionRecord(sessionId);
  if (!session?.masterKey) throw new Error("listTenants requires master key auth");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/deploy/tenants`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-adas-token": session.masterKey,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tenant list error: GET /deploy/tenants returned ${res.status} — ${text}`);
    }
    const data = await res.json();
    return data.tenants || [];
  } finally {
    clearTimeout(timeout);
  }
}
