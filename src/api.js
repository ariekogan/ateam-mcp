/**
 * A-Team API client — thin HTTP wrapper for the External Agent API.
 *
 * Credentials resolve in this order:
 *   1. Per-session record (set via ateam_auth, or seeded from the bearer), as
 *      the CURRENT TOOL CALL sees it — see runToolCall
 *   2. Environment variables (ADAS_API_KEY, ADAS_TENANT — used by stdio transport)
 *   3. Nothing: no key and no tenant. There is no default tenant.
 *
 * Sessions also track activity timestamps and optional context (active solution,
 * last skill) to support TTL-based cleanup and smarter UX.
 */

import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const BASE_URL = process.env.ADAS_API_URL || "https://api.ateam-ai.com";
// CORE_URL removed — all requests now route through BASE_URL (skill-validator)
const ENV_TENANT = process.env.ADAS_TENANT || "";
const ENV_API_KEY = process.env.ADAS_API_KEY || "";

// Request timeout (120 seconds — deploys can take 60-90s)
const REQUEST_TIMEOUT_MS = 120_000;

// Session TTL — sessions idle longer than this are swept
const SESSION_TTL = 60 * 60 * 1000; // 60 minutes

// Sweep interval — how often we check for stale sessions
const SWEEP_INTERVAL = 5 * 60 * 1000; // every 5 minutes

// Per-session store (sessionId → { tenant, apiKey, lastActivity, context })
// context: { activeSolutionId, lastSkillId, lastToolName }
// A record is REPLACED, never edited, when a session signs in again
// (setSessionCredentials builds a new object), which is what lets a tool call
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
 * from it for the whole call, across every await. A sign-in by ANOTHER call
 * replaces the session's record and leaves this one alone. A sign-in by THIS
 * call (ateam_auth) is the one change it adopts: setSessionCredentials and
 * resetPlatformSession update the call's record as well as the session's.
 *
 * Outside a tool call (seedCredentials on an incoming request, the sweep, a test
 * calling a handler directly) sessionRecord reads the session store, as before.
 */
const toolCall = new AsyncLocalStorage(); // { sessionId, record }

/** Run one tool call as `sessionId` was when it arrived. */
export function runToolCall(sessionId, fn) {
  return toolCall.run({ sessionId, record: sessions.get(sessionId) || null }, fn);
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
// When a user calls ateam_auth to override (e.g., switch tenants), the override
// is stored per bearer and applied to all future sessions from that user.
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
    throw new Error(`whoami failed at ${baseUrl} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`whoami returned non-JSON from ${baseUrl}: ${text.slice(0, 200)}`); }
  if (!json?.ok || !json?.tenant) {
    throw new Error(`whoami did not name a tenant at ${baseUrl}: ${text.slice(0, 300)}`);
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
    context: existing?.context || {},
  };
  sessions.set(sessionId, record);
  adoptRecord(sessionId, record);
  const urlNote = apiUrl ? `, url: ${apiUrl}` : "";
  const masterNote = masterKey ? ", MASTER MODE" : "";
  console.log(`[Auth] Credentials set for session ${sessionId} (tenant: ${resolvedTenant || "unresolved — sealed key"}${explicit ? ", explicit" : ""}${urlNote}${masterNote})`);
}

/**
 * Switch the active tenant for a master-key session (no re-auth needed).
 * Returns true if switched, false if not in master mode.
 */
export function switchTenant(sessionId, newTenant) {
  const session = sessionRecord(sessionId);
  if (!session?.masterKey) return false;
  session.tenant = newTenant;
  session.lastActivity = Date.now();
  console.log(`[Auth] Master mode tenant switch: ${newTenant} (session ${sessionId})`);
  return true;
}

/**
 * Check if a session is in master key mode.
 */
export function isMasterMode(sessionId) {
  const session = sessionRecord(sessionId);
  return !!(session?.masterKey);
}

/**
 * Get credentials for a session, falling back to env vars.
 * Resolution order:
 *   1. Per-session (from ateam_auth or seedCredentials)
 *   2. Environment variables (ADAS_API_KEY, ADAS_TENANT)
 */
export function getCredentials(sessionId) {
  // 1. Per-session credentials
  const session = sessionRecord(sessionId);
  if (session) {
    return { tenant: session.tenant, apiKey: session.apiKey };
  }

  // 2. Environment variables
  const apiKey = ENV_API_KEY || "";
  let tenant = ENV_TENANT;
  if (!tenant && apiKey) {
    const parsed = parseApiKey(apiKey);
    if (parsed.tenant) tenant = parsed.tenant;
  }
  // If apiKey is present but tenant couldn't be derived, the key is malformed.
  // Previously fell back to "main" — this silently routed credentials to the
  // wrong tenant. Now we fail loudly.
  //
  // UNLESS THE KEY IS SEALED, where no tenant in the string is the design and
  // not a defect. Same split as setSessionCredentials: "not stated" is not
  // "wrong". Requests still authenticate, because the tenant is inside the key
  // and Core reads it; headers() omits X-ADAS-TENANT rather than guessing one.
  if (apiKey && !tenant && !parseApiKey(apiKey).sealed) {
    throw new Error(
      `getCredentials: apiKey is present (env ADAS_API_KEY) but tenant could not be resolved ` +
      `(missing ADAS_TENANT env and apiKey is malformed — expected format adas_<env>_<key>). ` +
      `Refusing to fall back to a default tenant.`
    );
  }
  // No apiKey at all = unauthenticated; return nulls (callers check apiKey.length).
  return { tenant: tenant || null, apiKey };
}

/**
 * Check if a session is authenticated (has an API key from any source).
 */
export function isAuthenticated(sessionId) {
  const { apiKey } = getCredentials(sessionId);
  return apiKey.length > 0;
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
function apiToAppUrl(baseUrl) {
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
  const appUrl = apiToAppUrl(getBaseUrl(sessionId));
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
 * Format an API error into a user-friendly message with actionable hints.
 *
 * Exported so the hints can be TESTED as behaviour rather than as source text.
 * A test that greps for the right-looking code passes on code that never runs.
 */
export function formatError(method, path, status, body, baseUrl) {
  const hints = {
    400: "Bad request — see the error details above for what to fix.",
    401: "Your API key may be invalid or expired. Get a valid key at https://mcp.ateam-ai.com/get-api-key then call ateam_auth(api_key: \"your_key\").",
    403: "You don't have permission for this operation. Check your tenant and API key. Get a key at https://mcp.ateam-ai.com/get-api-key",
    404: "Resource not found. Check the solution_id or skill_id you're using. Use ateam_list_solutions to see available solutions.",
    409: "Conflict — the resource may already exist or is in a conflicting state.",
    422: "Validation failed. Check the request payload against the spec (use ateam_get_spec).",
    429: "Rate limited. Wait a moment and try again.",
    500: "A-Team server error. The platform may be temporarily unavailable. Try again in a minute.",
    502: "A-Team API is unreachable. The service may be restarting. Try again in a minute.",
    503: "A-Team API is temporarily unavailable. Try again in a minute.",
  };

  // A 401 IS NOT ALWAYS AN AUTH PROBLEM, AND SAYING SO COSTS A RUN.
  //
  // The table below attaches "your API key may be invalid or expired — get a
  // new key and call ateam_auth" to EVERY 401, by status code, never by cause.
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
    hints[status] =
      `NOT an auth problem — your key is fine. Core does not recognise the ACTOR "${who}" in this tenant. ` +
      `Re-authenticating will not help. Either pass a real actor id (the one ateam_conversation returned for the thread), ` +
      `or omit the actor entirely to act as the tenant. If you never sent an actor, the session is bound to a stale one: ` +
      `call ateam_auth again to reset the session binding.`;
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
      `${baseUrl || "this URL"} does not serve the topic "${topic}". Either the topic name is wrong (ateam_get_spec ` +
      `with topic:"overview" lists what this deployment has), or this backend is OLDER than the tool you are ` +
      `calling from and the topic has not been deployed here yet. Retrying will not change either.`;
  }

  // A 500 THAT NAMES A MISSING CONFIGURATION IS NOT "TRY AGAIN IN A MINUTE".
  //
  // /chat answered 500 {"message":"OPENAI_API_KEY is not set"} and this table
  // labelled it "the platform may be temporarily unavailable — try again in a
  // minute". Every part is wrong: nothing is unavailable, a minute changes
  // nothing, and the fix is to set a key. An agent obeying that hint burns its
  // retries on a condition that cannot clear on its own. The body already said
  // so; only the hint disagreed. (2026-08-22, found by sweeping every tool.)
  if (status >= 500) {
    // `body` is what this function receives; asText is derived further down, so
    // read the body directly here rather than a variable that is not yet in scope.
    const bodyText = typeof body === "string"
      ? body
      : (() => { try { return JSON.stringify(body || ""); } catch { return ""; } })();
    const m = /\b([A-Z][A-Z0-9_]{3,})\s+is not set\b|\bmissing (?:env|environment) (?:var|variable)\s+([A-Z0-9_]+)/i.exec(bodyText);
    if (m) {
      const name = m[1] || m[2];
      hints[status] =
        `CONFIGURATION, not an outage: the server reports ${name} is not set. Retrying will not help and nothing is down — ` +
        `this needs ${name} configured on the A-Team backend serving ${baseUrl || "this API"}. Other tools are unaffected.`;
    }
  }

  // Special-case: GitHub App not connected for this tenant. This is the wall a
  // user hits the first time they iterate on CONNECTOR CODE (github_patch /
  // github_write / github_push / build_and_run auto-pull). The raw
  // "github_not_connected" code + a generic 409 hint tells them nothing — so
  // guide them explicitly to the one-time connect step and note the repo-less
  // escape hatch for definition edits.
  const bodyStr = typeof body === "string" ? body : (body ? JSON.stringify(body) : "");
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
  const hint = hasSpecificHint ? "" : (hints[status] || "");
  // A JSON error body used to be dropped entirely — only a string body became
  // `detail`. So an endpoint that answers 4xx WITH the diagnosis (ui.surfaceProbe
  // returns 422 + the failures that explain why the surface is broken) reached
  // the caller as a bare "returned 422", throwing away the very thing it was
  // asked to produce. Serialize objects too, capped the same way.
  let detail = "";
  const asText = typeof body === "string"
    ? body
    : (body && typeof body === "object" ? (() => { try { return JSON.stringify(body); } catch { return ""; } })() : "");
  if (asText.length > 0) {
    // Previously a body of 2000+ chars was dropped ENTIRELY, so the richer the
    // error the less the caller was told — a 422 carrying the full diagnosis
    // arrived as a bare status code. Truncate instead of discarding.
    detail = asText.length < 2000 ? asText : asText.slice(0, 2000) + "… (truncated)";
  }

  // Always show the FULL URL actually hit — ateam-mcp is a PUBLIC MCP with a
  // configurable base (prod default, dev/self-host overrides), so a bare
  // "POST /deploy/..." 404 is ambiguous: is the route missing, or did the
  // request go to the wrong base? The full URL disambiguates instantly.
  const target = baseUrl ? `${baseUrl}${path}` : path;
  let msg = `A-Team API error: ${method} ${target} returned ${status}`;
  if (detail) msg += ` — ${detail}`;
  if (hint) msg += `\nHint: ${hint}`;

  return msg;
}

/**
 * Core fetch wrapper with timeout and error formatting.
 * @param {string} method
 * @param {string} path
 * @param {*} body
 * @param {string} sessionId
 * @param {{ timeoutMs?: number }} [opts]
 */
async function request(method, path, body, sessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  // Default to 2 retries on transient proxy errors (502/504). Existing
  // gate further down only retries on those status codes — real errors
  // (4xx, 5xx other than 502/504) still fail fast on attempt 0. Bumping
  // the default from 0 → 2 protects every wrapper call against a
  // skill-builder mid-restart 502 (bug #6 in parallel-agent feedback)
  // without callers having to remember to pass retries everywhere.
  const maxRetries = opts.retries ?? 2;
  const baseUrl = getBaseUrl(sessionId);

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

      // Auto-retry on 502/504 (proxy timeout during long deploys)
      if ((res.status === 502 || res.status === 504) && attempt < maxRetries) {
        const wait = Math.min(5000 * (attempt + 1), 15000);
        console.error(`[MCP] ${method} ${path} returned ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
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
        const e = new Error(formatError(method, path, res.status, text, baseUrl));
        e.status = res.status;
        // Keep the RAW body on the error. formatError truncates for humans, and
        // an endpoint that answers 4xx WITH the diagnosis (ui.surfaceProbe's 422
        // carries the failures explaining why a surface is broken) is exactly the
        // case where the body matters more than the status. A caller that knows
        // how to read its own error shape should not have to scrape a message.
        e.body = text;
        throw e;
      }

      return res.json();
    } catch (err) {
      if (err.name === "AbortError") {
        if (attempt < maxRetries) {
          const wait = Math.min(5000 * (attempt + 1), 15000);
          console.error(`[MCP] ${method} ${path} timed out, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(
          `A-Team API timeout: ${method} ${path} did not respond within ${timeoutMs / 1000}s.\n` +
          `Hint: The A-Team API at ${baseUrl} may be down. Check ${baseUrl}/health`
        );
      }
      if (err.cause?.code === "ECONNREFUSED") {
        if (attempt < maxRetries) {
          const wait = Math.min(5000 * (attempt + 1), 15000);
          console.error(`[MCP] ${method} ${path} connection refused, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(
          `Cannot connect to A-Team API at ${baseUrl}.\n` +
          `Hint: The service may be down. Check ${baseUrl}/health`
        );
      }
      if (err.cause?.code === "ENOTFOUND") {
        throw new Error(
          `Cannot resolve A-Team API host: ${baseUrl}.\n` +
          `Hint: Check your internet connection and ADAS_API_URL setting.`
        );
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
