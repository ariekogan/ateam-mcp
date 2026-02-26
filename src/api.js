/**
 * A-Team API client — thin HTTP wrapper for the External Agent API.
 *
 * Credentials resolve in this order:
 *   1. Per-session override (set via ateam_auth tool — used by HTTP transport)
 *   2. Environment variables (ADAS_API_KEY, ADAS_TENANT — used by stdio transport)
 *   3. Defaults (no key, tenant "main")
 */

const BASE_URL = process.env.ADAS_API_URL || "https://api.ateam-ai.com";
const ENV_TENANT = process.env.ADAS_TENANT || "";
const ENV_API_KEY = process.env.ADAS_API_KEY || "";

// Request timeout (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

// Per-session credential store (sessionId → { tenant, apiKey })
const sessions = new Map();

// Per-tenant credential fallback — for MCP clients that don't persist sessions
// (e.g., ChatGPT's bridge creates a new session per tool call).
// Keyed by tenant to prevent cross-user credential leaks in shared MCP servers.
const tenantFallbacks = new Map(); // tenant → { tenant, apiKey, createdAt }
const FALLBACK_TTL = 60 * 60 * 1000; // 60 minutes

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
 * Also updates the global fallback so new sessions inherit credentials.
 */
export function setSessionCredentials(sessionId, { tenant, apiKey }) {
  let resolvedTenant = tenant;
  if (!resolvedTenant && apiKey) {
    const parsed = parseApiKey(apiKey);
    if (parsed.tenant) resolvedTenant = parsed.tenant;
  }
  const creds = { tenant: resolvedTenant || "main", apiKey };
  sessions.set(sessionId, creds);

  // Update per-tenant fallback — only sessions for the SAME tenant will inherit this
  tenantFallbacks.set(creds.tenant, { ...creds, createdAt: Date.now() });
  console.log(`[Auth] Credentials set for session ${sessionId}, tenant fallback updated (tenant: ${creds.tenant})`);
}

/**
 * Get credentials for a session, falling back to env vars.
 * Resolution order:
 *   1. Per-session (from ateam_auth or seedCredentials)
 *   2. Environment variables (ADAS_API_KEY, ADAS_TENANT)
 *
 * Note: tenantFallbacks are NOT used in getCredentials() to prevent
 * cross-user credential leaks. They are only used in seedFromFallback()
 * which requires explicit tenant matching.
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
 * Seed a session's credentials from a matching tenant fallback.
 * Called by HTTP transport when a new session is created with a known tenant
 * (e.g., from OAuth token). Only inherits from the SAME tenant.
 */
export function seedFromFallback(sessionId, tenant) {
  const fallback = tenantFallbacks.get(tenant);
  if (fallback && (Date.now() - fallback.createdAt < FALLBACK_TTL)) {
    sessions.set(sessionId, { tenant: fallback.tenant, apiKey: fallback.apiKey });
    console.log(`[Auth] Seeded session ${sessionId} from tenant fallback (tenant: ${tenant})`);
    return true;
  }
  return false;
}

/**
 * Check if a session is authenticated (has an API key from any source).
 */
export function isAuthenticated(sessionId) {
  const { apiKey } = getCredentials(sessionId);
  return apiKey.length > 0;
}

/**
 * Remove session credentials (on disconnect).
 */
export function clearSession(sessionId) {
  sessions.delete(sessionId);
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
