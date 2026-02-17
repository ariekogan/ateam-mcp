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

export async function get(path, sessionId) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers(sessionId) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function post(path, body, sessionId) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(sessionId),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function patch(path, body, sessionId) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: headers(sessionId),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function del(path, sessionId) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: headers(sessionId),
  });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
