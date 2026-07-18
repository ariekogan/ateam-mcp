/**
 * A-Team API client — thin HTTP wrapper for the External Agent API.
 *
 * Credentials resolve in this order:
 *   1. Per-session override (set via ateam_auth tool — used by HTTP transport)
 *   2. Environment variables (ADAS_API_KEY, ADAS_TENANT — used by stdio transport)
 *   3. Defaults (no key, tenant "main")
 *
 * Sessions also track activity timestamps and optional context (active solution,
 * last skill) to support TTL-based cleanup and smarter UX.
 */

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
const sessions = new Map();

// ── Bearer-based auth (persistent across sessions) ──────────────
// The OAuth bearer token IS the user's API key (oauth.js exchangeAuthorizationCode).
// Each user has a unique bearer. MCP clients create new sessions per tool call,
// so we use the bearer as the persistent actor identity.
//
// When a user calls ateam_auth to override (e.g., switch tenants), the override
// is stored per bearer and applied to all future sessions from that user.
const authOverrides = new Map();  // bearerToken → { tenant, apiKey, updatedAt }
const sessionBearers = new Map(); // sessionId → bearerToken

/**
 * Parse a tenant-embedded API key.
 * Format: adas_<tenant>_<32hex>
 * Legacy: adas_<32hex> (no tenant embedded)
 * @returns {{ tenant: string|null, isValid: boolean }}
 */
export function parseApiKey(key) {
  if (!key || typeof key !== 'string') return { tenant: null, isValid: false };
  const match = key.match(/^adas_([a-z0-9][a-z0-9-]{0,28}[a-z0-9])_([0-9a-f]{32})$/);
  if (match) return { tenant: match[1], isValid: true };
  const legacy = key.match(/^adas_([0-9a-f]{32})$/);
  if (legacy) return { tenant: null, isValid: true };
  return { tenant: null, isValid: false };
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
  // Fail loudly — silent fallback to "main" previously let malformed API keys
  // or missing tenant args silently pivot all operations onto the wrong tenant.
  // Matches the pattern we killed in ADAS connectors (memory-mcp, docs-index-mcp,
  // nutrition-mcp) — `|| "default"` was the #1 source of cross-tenant leaks.
  if (!resolvedTenant) {
    throw new Error(
      `setSessionCredentials: tenant could not be resolved for session ${sessionId} ` +
      `(tenant arg ${tenant ? "present" : "missing"}, apiKey ${apiKey ? "present but malformed (expected adas_<tenant>_<hex>)" : "absent"}). ` +
      `Refusing to fall back to a default tenant.`
    );
  }
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    tenant: resolvedTenant,
    apiKey,
    apiUrl: apiUrl || existing?.apiUrl || null,
    authExplicit: explicit || existing?.authExplicit || false,
    masterKey: masterKey || existing?.masterKey || null,
    lastActivity: Date.now(),
    context: existing?.context || {},
  });
  const urlNote = apiUrl ? `, url: ${apiUrl}` : "";
  const masterNote = masterKey ? ", MASTER MODE" : "";
  console.log(`[Auth] Credentials set for session ${sessionId} (tenant: ${resolvedTenant}${explicit ? ", explicit" : ""}${urlNote}${masterNote})`);
}

/**
 * Switch the active tenant for a master-key session (no re-auth needed).
 * Returns true if switched, false if not in master mode.
 */
export function switchTenant(sessionId, newTenant) {
  const session = sessions.get(sessionId);
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
  const session = sessions.get(sessionId);
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
  const session = sessionId ? sessions.get(sessionId) : null;
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
  if (apiKey && !tenant) {
    throw new Error(
      `getCredentials: apiKey is present (env ADAS_API_KEY) but tenant could not be resolved ` +
      `(missing ADAS_TENANT env and apiKey is malformed — expected format adas_<tenant>_<hex>). ` +
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
  const session = sessions.get(sessionId);
  if (session?.authExplicit) return true;
  // Bearer has an active auth override from a previous session's ateam_auth
  return hasBearerAuth(sessionId);
}

/**
 * Record activity on a session — called on every tool call.
 * Keeps the session alive and updates context for smarter UX.
 */
export function touchSession(sessionId, { toolName, solutionId, skillId } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.lastActivity = Date.now();

  // Update context — track what the user is working on
  if (toolName) session.context.lastToolName = toolName;
  if (solutionId) session.context.activeSolutionId = solutionId;
  if (skillId) session.context.lastSkillId = skillId;
}

/**
 * Get session context — what the user has been working on.
 * Returns {} if no session or no context.
 */
export function getSessionContext(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return {};
  return { ...session.context };
}

/**
 * Remove session credentials (on disconnect).
 */
export function clearSession(sessionId) {
  sessionBearers.delete(sessionId);
  sessions.delete(sessionId);
}

// ── Bearer identity functions ──────────────────────────────────────

/** Bind a session to its OAuth bearer token. Called from seedCredentials. */
export function bindSessionBearer(sessionId, bearerToken) {
  sessionBearers.set(sessionId, bearerToken);
  console.log(`[Auth] Bearer bound for session ${sessionId}`);
}

/** Store ateam_auth override for this user (by bearer). Called from tools.js. */
export function setAuthOverride(sessionId, { tenant, apiKey, apiUrl }) {
  const bearer = sessionBearers.get(sessionId);
  if (!bearer) {
    console.log(`[Auth] WARNING: No bearer bound for session ${sessionId} — override NOT stored. sessionBearers has ${sessionBearers.size} entries.`);
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
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session?.apiUrl) return session.apiUrl;
  // 2. Bearer override
  if (sessionId) {
    const bearer = sessionBearers.get(sessionId);
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
  const apiBase = getBaseUrl(sessionId);
  const appUrl = apiToAppUrl(apiBase);
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
  const bearer = sessionBearers.get(sessionId);
  return bearer ? authOverrides.has(bearer) : false;
}

/**
 * Sweep expired sessions — removes sessions idle longer than SESSION_TTL.
 * Returns the number of sessions removed.
 */
export function sweepStaleSessions() {
  const now = Date.now();
  let swept = 0;
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL) {
      sessionBearers.delete(sid);
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
  const session = sessionId ? sessions.get(sessionId) : null;

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
    return h;
  }

  // Normal mode: API key auth
  const { tenant, apiKey } = getCredentials(sessionId);
  const h = { "Content-Type": "application/json" };
  if (tenant) h["X-ADAS-TENANT"] = tenant;
  if (apiKey) h["X-API-KEY"] = apiKey;
  return h;
}

/**
 * Format an API error into a user-friendly message with actionable hints.
 */
function formatError(method, path, status, body, baseUrl) {
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

  const hint = hints[status] || "";
  const detail = typeof body === "string" && body.length > 0 && body.length < 2000 ? body : "";

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
        throw new Error(formatError(method, path, res.status, text, baseUrl));
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
  const session = sessionId ? sessions.get(sessionId) : null;
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
