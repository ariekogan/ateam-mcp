/**
 * PERSONAL SIGN-IN FOR AGENTS — the ateam-mcp side.
 *
 * Plan: Core /mnt/project-files/plans/personal-signin/PLAN.md and its Opus 9Q review. Core's
 * services/agentAuth.js holds every rule; this file only talks to it and keeps what a session needs.
 *
 * A person connects Claude or ChatGPT once and approves in the A-Team app, signed in as themself. The
 * client then holds an OPAQUE access token (atg_..., 15 minutes, renewed with a rotating atr_ refresh
 * token). It is not a key and names no workspace. This server asks Core, through its OWN door (a value
 * derived from CORE_MCP_SECRET with the purpose "ateam-mcp/agent-auth/v1", the same construction as
 * Core's utils/serviceDoors.js), who the token is (resolve), which workspaces the person owns or
 * administers (listWorkspaces), and the key of the one they pick (workspaceKey). The key stays in this
 * server's memory for the person's grant; it never goes to the client, the chat or a tool result.
 *
 * ONE ACTIVE WORKSPACE PER GRANT. A grant is one person in one app. Switching is asking
 * (ateam_switch_workspace); every session of the grant follows, and each new chat starts on the last
 * workspace the person used (Core remembers it on the grant).
 *
 * DERIVE, NEVER STORE (9Q Q3). The person's role in the active workspace is re-checked by Core at every
 * resolve (cached 60 s here); when it says "no longer allowed", the key is dropped from the grant.
 *
 * A CORE OUTAGE IS NOT A SIGN-OUT. A failed call to Core throws CoreUnavailable, which the bearer gate
 * turns into a 5xx, never a 401: a 401 makes the client refresh, and a refresh that also fails makes the
 * person approve again.
 *
 * Each environment is its own: this server only uses the grant path on the MCP host whose environment
 * is its own Core's (Core says which in every answer).
 */

import { createHmac, createHash } from "node:crypto";

const ACCESS_PREFIX = "atg_";
const REFRESH_PREFIX = "atr_";
const CODE_PREFIX = "atc_";
const PURPOSE = "ateam-mcp/agent-auth/v1";
const RESOLVE_CACHE_MS = 60_000;
const CORE_TIMEOUT_MS = 10_000;

export class CoreUnavailable extends Error {}

/** ateam-mcp's value at Core's door. Same master, same value (Core: deriveServiceSecret). */
export function deriveServiceSecret(master) {
  if (!master || typeof master !== "string") throw new Error("deriveServiceSecret: the master secret is required");
  return createHmac("sha256", master).update(PURPOSE).digest("hex");
}

export const isGrantAccessToken = (t) => typeof t === "string" && t.startsWith(ACCESS_PREFIX);
export const isGrantRefreshToken = (t) => typeof t === "string" && t.startsWith(REFRESH_PREFIX);
export const isGrantCode = (t) => typeof t === "string" && t.startsWith(CODE_PREFIX);
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

let fetchImpl = (...a) => fetch(...a);
/** Tests replace Core. */
export function _setCoreFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); resolveCache.clear(); grantWorkspaces.clear(); }

/**
 * One call to cp.agent_auth_api. Returns Core's answer ({ ok:true, ... } or a refusal
 * { ok:false, status, body:{code,error} }); throws CoreUnavailable when Core cannot be asked.
 */
export async function coreCall(method, params = {}) {
  const master = process.env.CORE_MCP_SECRET || "";
  const base = (process.env.ADAS_CORE_URL || "").replace(/\/+$/, "");
  if (!master || !base) throw new CoreUnavailable("personal sign-in needs this server's Core (ADAS_CORE_URL and CORE_MCP_SECRET)");
  let r;
  try {
    r = await fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-adas-token": deriveServiceSecret(master),
        "x-adas-service": "ateam-mcp",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cp.agent_auth_api", arguments: { method, params } } }),
      signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CoreUnavailable(`A-Team sign-in service unreachable: ${err.message}`);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) throw new CoreUnavailable(`A-Team sign-in service answered ${r.status}`);
  if (data.error) throw new CoreUnavailable(`A-Team sign-in service refused the call: ${data.error.message || "error"}`);
  const res = data.result;
  if (res?.isError) throw new CoreUnavailable(`A-Team sign-in service failed: ${res?.content?.[0]?.text || "error"}`);
  const out = res?.structuredContent ?? (() => { try { return JSON.parse(res?.content?.[0]?.text || "null"); } catch { return null; } })();
  if (!out || typeof out !== "object") throw new CoreUnavailable("A-Team sign-in service gave no answer");
  return out;
}

/** A refusal's short words, for an OAuth error or a tool message. */
export const refusalText = (out) => out?.body?.error || out?.error || "refused";
export const refusalCode = (out) => out?.body?.code || out?.code || null;

// ── Token check, cached 60 s by the token's hash ─────────────────────────────

const resolveCache = new Map(); // sha(token) → { at, value }

/** Who an access token is: { gid, userId, email, name, env, exp, lastTenant } or null when Core refuses it. */
export async function resolveToken(token) {
  const key = sha(token);
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) return hit.value;
  const out = await coreCall("resolve", { access_token: token });
  const value = out.ok ? out : null;
  resolveCache.set(key, { at: Date.now(), value });
  if (resolveCache.size > 5000) resolveCache.delete(resolveCache.keys().next().value);
  return value;
}

// ── The grant's active workspace (server memory only) ────────────────────────

const grantWorkspaces = new Map(); // gid → { tenant, name, env, apiKey, keyMintedBy, checkedAt }

/** The grant's active workspace, re-checked with Core at most every 60 s; null when none or no longer allowed. */
export async function activeWorkspace(token, gid) {
  const w = grantWorkspaces.get(gid);
  if (!w) return null;
  if (Date.now() - w.checkedAt < RESOLVE_CACHE_MS) return w;
  const out = await coreCall("resolve", { access_token: token, tenant: w.tenant });
  if (!out.ok || !out.workspace?.allowed) {
    grantWorkspaces.delete(gid);
    return { dropped: true, tenant: w.tenant, name: w.name };
  }
  w.checkedAt = Date.now();
  return w;
}

/** Make `tenant` the grant's active workspace: Core checks the person NOW and hands its key to this server. */
export async function chooseWorkspace(token, gid, tenant) {
  const out = await coreCall("workspaceKey", { access_token: token, tenant });
  if (!out.ok) return out;
  const w = { tenant: out.tenant, name: out.name || out.tenant, env: out.env, apiKey: out.api_key, keyMintedBy: out.key_minted_by || null, person: out.person || null, checkedAt: Date.now() };
  grantWorkspaces.set(gid, w);
  return { ok: true, workspace: w };
}

/** The grant's active workspace as last checked, with no call to Core (for labels only, never for a decision). */
export function peekGrantWorkspace(gid) { return grantWorkspaces.get(gid) || null; }

/** The person's owner/admin workspaces (no key). */
export async function listGrantWorkspaces(token) {
  return coreCall("listWorkspaces", { access_token: token });
}

/** Who acts in a workspace: the person signed in, with that workspace's key (9Q Q4: say it honestly). */
export function actsAs(w) {
  const who = w?.person?.email || w?.person?.name || "you";
  return `Signed in as ${who}; acting with ${w?.name || w?.tenant}'s workspace key${w?.keyMintedBy ? ` (minted by ${w.keyMintedBy})` : " (minted by no person)"}.`;
}
