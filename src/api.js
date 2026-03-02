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
const ENV_TENANT = process.env.ADAS_TENANT || "";
const ENV_API_KEY = process.env.ADAS_API_KEY || "";

// Request timeout (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

// Session TTL — sessions idle longer than this are swept
const SESSION_TTL = 60 * 60 * 1000; // 60 minutes

// Sweep interval — how often we check for stale sessions
const SWEEP_INTERVAL = 5 * 60 * 1000; // every 5 minutes

// Per-session store (sessionId → { tenant, apiKey, lastActivity, context })
// context: { activeSolutionId, lastSkillId, lastToolName }
const sessions = new Map();

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
 * Set credentials for a session (called by ateam_auth tool).
 * If tenant is not provided, it's auto-extracted from the key.
 */
export function setSessionCredentials(sessionId, { tenant, apiKey }) {
  let resolvedTenant = tenant;
  if (!resolvedTenant && apiKey) {
    const parsed = parseApiKey(apiKey);
    if (parsed.tenant) resolvedTenant = parsed.tenant;
  }
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    tenant: resolvedTenant || "main",
    apiKey,
    lastActivity: Date.now(),
    context: existing?.context || {},
  });
  console.log(`[Auth] Credentials set for session ${sessionId} (tenant: ${resolvedTenant || "main"})`);
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
  return { tenant: tenant || "main", apiKey };
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
 * This checks ONLY per-session credentials, ignoring env vars.
 * Used to gate tenant-aware operations — env vars alone are not sufficient
 * to deploy, update, or read solutions.
 */
export function isExplicitlyAuthenticated(sessionId) {
  if (!sessionId) return false;
  return sessions.has(sessionId);
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
  sessions.delete(sessionId);
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
      sessions.delete(sid);
      swept++;
    }
  }
  if (swept > 0) {
    console.log(`[Session] Swept ${swept} stale session(s). ${sessions.size} active.`);
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
  const { tenant, apiKey } = getCredentials(sessionId);
  const h = { "Content-Type": "application/json" };
  if (tenant) h["X-ADAS-TENANT"] = tenant;
  if (apiKey) h["X-API-KEY"] = apiKey;
  return h;
}

/**
 * Format an API error into a user-friendly message with actionable hints.
 */
function formatError(method, path, status, body) {
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

  const hint = hints[status] || "";
  const detail = typeof body === "string" && body.length > 0 && body.length < 2000 ? body : "";

  let msg = `A-Team API error: ${method} ${path} returned ${status}`;
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

    const res = await fetch(`${BASE_URL}${path}`, fetchOpts);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(formatError(method, path, res.status, text));
    }

    return res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `A-Team API timeout: ${method} ${path} did not respond within ${timeoutMs / 1000}s.\n` +
        `Hint: The A-Team API at ${BASE_URL} may be down. Check https://api.ateam-ai.com/health`
      );
    }
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to A-Team API at ${BASE_URL}.\n` +
        `Hint: The service may be down. Check https://api.ateam-ai.com/health`
      );
    }
    if (err.cause?.code === "ENOTFOUND") {
      throw new Error(
        `Cannot resolve A-Team API host: ${BASE_URL}.\n` +
        `Hint: Check your internet connection and ADAS_API_URL setting.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
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
