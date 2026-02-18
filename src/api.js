/**
 * ADAS API client — thin HTTP wrapper for the External Agent API.
 *
 * Credentials resolve in this order:
 *   1. Per-session override (set via adas_auth tool — used by HTTP transport)
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

/**
 * Set credentials for a session (called by adas_auth tool).
 */
export function setSessionCredentials(sessionId, { tenant, apiKey }) {
  sessions.set(sessionId, { tenant, apiKey });
}

/**
 * Get credentials for a session, falling back to env vars.
 */
export function getCredentials(sessionId) {
  const session = sessionId ? sessions.get(sessionId) : null;
  return {
    tenant: session?.tenant || ENV_TENANT || "main",
    apiKey: session?.apiKey || ENV_API_KEY || "",
  };
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
    401: "Your API key may be invalid or expired. Try calling adas_auth again with a valid key.",
    403: "You don't have permission for this operation. Check your tenant and API key.",
    404: "Resource not found. Check the solution_id or skill_id you're using. Use adas_list_solutions to see available solutions.",
    409: "Conflict — the resource may already exist or is in a conflicting state.",
    422: "Validation failed. Check the request payload against the spec (use adas_get_spec).",
    429: "Rate limited. Wait a moment and try again.",
    500: "ADAS server error. The platform may be temporarily unavailable. Try again in a minute.",
    502: "ADAS API is unreachable. The service may be restarting. Try again in a minute.",
    503: "ADAS API is temporarily unavailable. Try again in a minute.",
  };

  const hint = hints[status] || "";
  const detail = typeof body === "string" && body.length > 0 && body.length < 500 ? body : "";

  let msg = `ADAS API error: ${method} ${path} returned ${status}`;
  if (detail) msg += ` — ${detail}`;
  if (hint) msg += `\nHint: ${hint}`;

  return msg;
}

/**
 * Core fetch wrapper with timeout and error formatting.
 */
async function request(method, path, body, sessionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const opts = {
      method,
      headers: headers(sessionId),
      signal: controller.signal,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE_URL}${path}`, opts);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(formatError(method, path, res.status, text));
    }

    return res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `ADAS API timeout: ${method} ${path} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.\n` +
        `Hint: The ADAS API at ${BASE_URL} may be down. Check https://api.ateam-ai.com/health`
      );
    }
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to ADAS API at ${BASE_URL}.\n` +
        `Hint: The service may be down. Check https://api.ateam-ai.com/health`
      );
    }
    if (err.cause?.code === "ENOTFOUND") {
      throw new Error(
        `Cannot resolve ADAS API host: ${BASE_URL}.\n` +
        `Hint: Check your internet connection and ADAS_API_URL setting.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function get(path, sessionId) {
  return request("GET", path, undefined, sessionId);
}

export async function post(path, body, sessionId) {
  return request("POST", path, body, sessionId);
}

export async function patch(path, body, sessionId) {
  return request("PATCH", path, body, sessionId);
}

export async function del(path, sessionId) {
  return request("DELETE", path, undefined, sessionId);
}
