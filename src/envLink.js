/**
 * ONE CONNECTOR FOR PROD AND DEV — personal sign-in slice 8 (plan: /mnt/project-files/plans/personal-signin/SLICE8.md,
 * the "later" path of its 9Q review, Q5).
 *
 * A person signed in to the PRODUCTION connector asks for one of their DEV workspaces. This server does not hold or
 * ask for any DEV key. It becomes a client of the DEV connector instead:
 *   1. The first time, it starts a device code (RFC 8628) at the DEV connector, and the person approves it once on
 *      the DEV app, signed in as themself (the slice-6 page). The DEV connector gives THIS server a DEV token pair.
 *   2. Every call the person then makes in a DEV workspace is passed on to the DEV connector as an MCP call with that
 *      DEV token, and its answer comes back unchanged. The DEV connector and DEV Core apply their own rules, exactly
 *      as for someone using the DEV connector directly. DEV keys never leave DEV.
 *
 * WHERE THE DEV TOKENS LIVE. The access token (15 minutes) only in this server's memory. The refresh token in memory
 * and, sealed, on the person's PRODUCTION grant in production Core (linkSet), so a restart of this server needs no new
 * approval. Neither ever reaches the client, the chat or a tool result.
 *
 * NEVER SILENTLY INTO PROD. "The active workspace is a DEV one" (remote) is kept in memory and on the production grant,
 * which also forgets the PROD workspace then. While remote, every call is passed on to DEV; when that is impossible (the
 * DEV link ended, was switched off, or DEV is down) the call is refused with the reason, never run in a PROD workspace.
 * Only the person's own switch to a PROD workspace (with its confirmation) leaves DEV.
 *
 * Production Core says whether the link is offered (resolve: `link`, SysAdmin → Agent sign-in, OFF by default); only a
 * production grant on this server's production host gets it, and the DEV connector's address is this server's own
 * (api.js mcpUrlForEnv("dev", KEY_ENVIRONMENTS)), never a setting: no one can point a person's DEV tokens elsewhere.
 * The link goes from production to dev only.
 */

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { coreCall, forgetResolve } from "./grantAuth.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PEER_HTTP_TIMEOUT_MS = 15_000;
// The chat clients give up on a tool call at about 60 s, and the DEV connector answers within about 45 s (its long
// commands go to the background and say so): one wait under the client's.
const FORWARD_TIMEOUT_MS = 55_000;
const ACCESS_MARGIN_MS = 30_000;
const MAX_PEERS = 2000;

/** Calls that stay on this server while a DEV workspace is active: moving between workspaces, and the key refusal. */
export const LOCAL_WHILE_REMOTE = Object.freeze(new Set(["ateam_switch_workspace", "ateam_auth"]));

export class LinkEnded extends Error {}
export class PeerUnavailable extends Error {}

let fetchImpl = (...a) => fetch(...a);
/** Tests replace the network to the DEV connector. */
export function _setPeerFetch(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
  for (const p of peers.values()) p.client.close().catch(() => {});
  offers.clear(); remotes.clear(); links.clear(); pendings.clear(); peers.clear(); people.clear();
}

const offers = new Map();   // gid → { env, mcp_url, linked } | null  (production Core's word, at most 60 s old)
const remotes = new Map();  // gid → { env, tenant, name } | null    (present = known; null = a PROD workspace or none)
const links = new Map();    // gid → { id, mcpUrl, clientId, refresh, saved, access, accessUntil, refreshing }
const pendings = new Map(); // gid → { mcpUrl, clientId, deviceCode, userCode, url, until, interval }
const peers = new Map();    // sessionId → { gid, client, linkId }
const people = new Map();   // gid → the person's email on this side, for the same-person check

/**
 * What production Core said about the grant on this request (http.js → grantSession.js, every request): the DEV
 * link it offers, and — the first time this server sees the grant — whether its active workspace is a DEV one.
 */
export function noteGrant(gid, extra = {}, { devMcpUrl = null } = {}) {
  offers.set(gid, extra.link && extra.env === "prod" && devMcpUrl ? { env: "dev", mcp_url: devMcpUrl, linked: !!extra.link.linked } : null);
  if (extra.email) people.set(gid, String(extra.email).toLowerCase());
  if (!remotes.has(gid)) remotes.set(gid, extra.remote?.tenant ? { env: "dev", tenant: extra.remote.tenant, name: extra.remote.name || null } : null);
}

/** The grant's active DEV workspace, or null. */
export const remoteOf = (gid) => remotes.get(gid) || null;
/** The DEV link production Core offers this grant, or null; `linked` also when this server just linked it. */
export function offerOf(gid) {
  const o = offers.get(gid);
  return o ? { ...o, linked: o.linked || links.has(gid) } : null;
}

/** Production Core: remember the link's refresh token or the active DEV workspace on the grant. */
async function saveOnGrant(prodToken, patch) {
  const out = await coreCall("linkSet", { access_token: prodToken, env: "dev", ...patch });
  if (!out.ok) throw new PeerUnavailable(`production Core refused to remember the DEV link: ${out?.body?.error || "refused"}`);
  return out;
}

/**
 * Put the link's newest refresh token on the grant, over the one the grant holds (compare-and-set in Core), so a late
 * save never puts back a token DEV already rotated away. A failed save is tried again at the next call; memory works.
 */
function saveRefresh(prodToken, gid, link) {
  if (link.saved === link.refresh) return Promise.resolve();
  const sending = link.refresh;
  return saveOnGrant(prodToken, { refresh_token: sending, ...(link.saved && { previous_refresh_token: link.saved }) })
    .then(() => { if (link.refresh === sending) link.saved = sending; }, (err) => {
      console.warn(`[Link] grant ${gid}: the newest DEV refresh token is not saved on the grant yet: ${err.message}`);
    });
}

/** Make a DEV workspace the active one (remote), or forget it (null). Production Core first, then memory. */
export async function setRemote(prodToken, gid, remote) {
  if (remote) await saveOnGrant(prodToken, { remote: { tenant: remote.tenant, name: remote.name || null } });
  remotes.set(gid, remote ? { env: "dev", tenant: remote.tenant, name: remote.name || null } : null);
}

/** A PROD workspace was chosen: production Core already cleared remote (workspaceKey); memory follows. */
export function leftRemote(gid) { remotes.set(gid, null); }

// ── The DEV connector's OAuth endpoints ──────────────────────────────────────

async function peerPost(mcpUrl, path, form) {
  let r;
  try {
    r = await fetchImpl(new URL(path, mcpUrl).href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(PEER_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PeerUnavailable(`the DEV connector could not be reached: ${err.message}`);
  }
  const body = await r.json().catch(() => null);
  if (r.status >= 500 || !body) throw new PeerUnavailable(`the DEV connector answered ${r.status}`);
  return { status: r.status, body };
}

/** The DEV link of a grant, from memory or (after a restart) from production Core. Null when there is none. */
async function loadLink(prodToken, gid) {
  const offer = offerOf(gid);
  if (!offer) return null;
  const have = links.get(gid);
  if (have && have.mcpUrl === offer.mcp_url) return have;
  if (have) links.delete(gid); // the DEV connector moved: the old tokens belong to the old one
  if (!offer.linked) return null;
  const out = await coreCall("linkGet", { access_token: prodToken });
  if (!out.ok || !out.refresh_token) return null;
  const link = { id: randomUUID(), mcpUrl: offer.mcp_url, clientId: `ateam-link-${randomUUID()}`, refresh: out.refresh_token, saved: out.refresh_token, access: null, accessUntil: 0, refreshing: null };
  links.set(gid, link);
  return link;
}

/** The link ended on the DEV side (revoked, expired, approved too long ago): forget it everywhere. */
async function endLink(prodToken, gid) {
  links.delete(gid);
  offers.set(gid, offers.get(gid) ? { ...offers.get(gid), linked: false } : null);
  await coreCall("linkSet", { access_token: prodToken, env: "dev", refresh_token: null }).catch(() => {});
  forgetResolve(prodToken); // the next request reads "not linked" from Core, not from a cached answer
}

/**
 * A DEV access token for the grant, renewed with the rotating refresh token when it is (nearly) expired, or when DEV
 * refused `refused` (a 401) and no newer one has arrived since.
 */
export async function peerAccess(prodToken, gid, { refused = null } = {}) {
  const link = await loadLink(prodToken, gid);
  if (!link) throw new LinkEnded("not linked");
  const force = refused !== null && link.access === refused;
  if (!force && link.access && link.accessUntil - ACCESS_MARGIN_MS > Date.now()) {
    if (!link.refreshing) saveRefresh(prodToken, gid, link);
    return link.access;
  }
  // One renewal at a time per grant: a second one would present a refresh token the first already rotated.
  link.refreshing ||= (async () => {
    const used = link.refresh;
    const { status, body } = await peerPost(link.mcpUrl, "/token", { grant_type: "refresh_token", refresh_token: used, client_id: link.clientId });
    if (status !== 200 || !body.access_token) {
      if (body?.error === "invalid_grant") { await endLink(prodToken, gid); throw new LinkEnded(body.error_description || "the DEV link ended"); }
      throw new PeerUnavailable(`the DEV connector refused to renew: ${body?.error || status}`);
    }
    link.access = body.access_token;
    link.accessUntil = Date.now() + (Number(body.expires_in) || 900) * 1000;
    if (body.refresh_token && body.refresh_token !== used) {
      link.refresh = body.refresh_token;
      // Saved before this renewal ends, so the next one (one at a time) never races it.
      await saveRefresh(prodToken, gid, link);
    }
    return link.access;
  })().finally(() => { link.refreshing = null; });
  return link.refreshing;
}

/**
 * Make sure the grant is linked to DEV. Returns { linked: true }, or { approve } with the link and code the person
 * opens on DEV, or { refused } with why. A started approval is polled at each call until the person approves.
 */
export async function ensureLink(prodToken, gid) {
  const offer = offerOf(gid);
  if (!offer) return { refused: "This connector does not reach DEV workspaces (SysAdmin → Agent sign-in → One Connector for Prod and Dev is OFF)." };
  if (await loadLink(prodToken, gid)) return { linked: true };
  let p = pendings.get(gid);
  if (p && (p.until <= Date.now() || p.mcpUrl !== offer.mcp_url)) { pendings.delete(gid); p = null; }
  if (p) {
    const { status, body } = await peerPost(p.mcpUrl, "/token", { grant_type: DEVICE_GRANT, device_code: p.deviceCode, client_id: p.clientId });
    if (status === 200 && body.access_token && body.refresh_token) {
      pendings.delete(gid);
      const link = { id: randomUUID(), mcpUrl: p.mcpUrl, clientId: p.clientId, refresh: body.refresh_token, saved: null, access: body.access_token,
        accessUntil: Date.now() + (Number(body.expires_in) || 900) * 1000, refreshing: null };
      links.set(gid, link);
      offers.set(gid, { ...offer, linked: true });
      await saveRefresh(prodToken, gid, link);
      forgetResolve(prodToken);
      return { linked: true, fresh: true };
    }
    if (body?.error === "authorization_pending" || body?.error === "slow_down") return { approve: p, waiting: true };
    pendings.delete(gid); // denied, expired or unknown: a new approval below
    if (body?.error === "access_denied") return { refused: "The DEV approval was denied. Nothing changed. Ask again to get a new link." };
  }
  const clientId = `ateam-link-${randomUUID()}`;
  const { status, body } = await peerPost(offer.mcp_url, "/device_authorization", { client_id: clientId });
  if (status !== 200 || !body.device_code || !body.user_code) {
    return { refused: `The DEV connector could not start an approval: ${body?.error_description || body?.error || status}.` };
  }
  p = {
    mcpUrl: offer.mcp_url, clientId, deviceCode: body.device_code, userCode: body.user_code,
    url: body.verification_uri_complete || body.verification_uri, until: Date.now() + (Number(body.expires_in) || 600) * 1000,
  };
  pendings.set(gid, p);
  return { approve: p };
}

/** The answer that asks the person to approve DEV once (the link and code are for the person; they are not secrets). */
export function approveDevResult(approve, { waiting = false } = {}) {
  const mins = Math.max(1, Math.round((approve.until - Date.now()) / 60_000));
  return {
    ok: false,
    code: "APPROVE_DEV",
    needs_user: true,
    approve_url: approve.url,
    user_code: approve.userCode,
    expires_in_minutes: mins,
    message: (waiting ? "DEV is not approved yet. " : "") +
      `To reach the user's DEV workspaces, they approve once on DEV: ask them to open ${approve.url} , sign in if asked, ` +
      `check that the code is ${approve.userCode}, and press Approve (valid ${mins} min). When they say it is done, call ` +
      "ateam_switch_workspace again with the same arguments. Nothing changed yet; after this, DEV workspaces are just a switch away.",
  };
}

// ── Passing calls on to the DEV connector ────────────────────────────────────

/** This session's MCP client at the DEV connector (one per session, so per-chat state stays per chat on DEV too). */
async function peerClient(sessionId, gid, prodTokenOf) {
  const link = await loadLink(prodTokenOf(), gid);
  if (!link) throw new LinkEnded("not linked");
  // A session at the DEV connector belongs to ONE DEV grant (its owner check): after a new approval, a new session.
  const have = peers.get(sessionId);
  if (have && have.gid === gid && have.linkId === link.id) return have.client;
  if (have) { peers.delete(sessionId); have.client.close().catch(() => {}); }
  const authed = async (url, init = {}) => {
    // No standing event stream to DEV: answers come back on the call itself (405 = "none offered", RFC-allowed).
    if ((init.method || "GET").toUpperCase() === "GET") return new Response(null, { status: 405 });
    let sent = null;
    const send = async (refused) => {
      const headers = new Headers(init.headers);
      sent = await peerAccess(prodTokenOf(), gid, { refused });
      headers.set("Authorization", `Bearer ${sent}`);
      try { return await fetchImpl(url, { ...init, headers }); } catch (err) { throw new PeerUnavailable(`the DEV connector could not be reached: ${err.message}`); }
    };
    const r = await send(null);
    // DEV refused this token: renew it once (or take the one a parallel call already renewed), then try once more.
    return r.status === 401 ? send(sent) : r;
  };
  const client = new Client({ name: "ateam-mcp-prod-link", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", link.mcpUrl), { fetch: authed }));
  peers.set(sessionId, { gid, client, linkId: link.id });
  if (peers.size > MAX_PEERS) {
    const [oldest, p] = peers.entries().next().value;
    peers.delete(oldest);
    p.client.close().catch(() => {});
  }
  return client;
}

/** Forget this session's client at the DEV connector (the session closed). */
export function dropPeer(sessionId) {
  const p = peers.get(sessionId);
  if (!p) return;
  peers.delete(sessionId);
  p.client.close().catch(() => {});
}

const refusal = (code, text) => ({ content: [{ type: "text", text }], isError: true, structuredContent: { ok: false, code } });

/**
 * Pass one tool call on to the DEV connector, for a grant whose active workspace is a DEV one. The DEV answer comes back
 * as it is (it already leads with "Workspace: <name> (dev)"). When the call cannot be passed on, it is refused with the
 * reason: never run here, in a PROD workspace.
 */
export async function forwardToolCall(sessionId, grant, name, args) {
  const remote = remoteOf(grant.gid);
  const where = `Workspace: ${remote?.name || remote?.tenant} (dev)`;
  if (!offerOf(grant.gid)) {
    return refusal("DEV_LINK_OFF", `${where}\n\nReaching DEV workspaces from this connector was switched off (SysAdmin → Agent sign-in). ${name} did not run. ` +
      "To work in a PROD workspace, ask to switch (ateam_switch_workspace).");
  }
  try {
    const client = await peerClient(sessionId, grant.gid, () => grant.token);
    return await client.callTool({ name, arguments: args || {} }, undefined, { timeout: FORWARD_TIMEOUT_MS, resetTimeoutOnProgress: true });
  } catch (err) {
    if (err instanceof LinkEnded) {
      dropPeer(sessionId);
      return refusal("DEV_LINK_ENDED", `${where}\n\nThe DEV link of this connection ended (it was revoked on DEV, or not used for too long). ${name} did not run. ` +
        `Call ateam_switch_workspace with tenant "${remote?.tenant}" to approve DEV again, or switch to a PROD workspace.`);
    }
    dropPeer(sessionId);
    const timedOut = /timed? ?out/i.test(String(err?.message));
    console.warn(`[Link] ${name} for grant ${grant.gid} was not answered by DEV: ${err?.message}`);
    return refusal(timedOut ? "DEV_TIMEOUT" : "DEV_UNAVAILABLE", `${where}\n\n` + (timedOut
      ? `DEV did not answer ${name} within ${FORWARD_TIMEOUT_MS / 1000} s. It may still be running there: check its state (for a run, ateam_test_status or ateam_get_progress) before calling it again.`
      : `The DEV connector could not be reached (${String(err?.message || err).slice(0, 200)}). ${name} may not have run; if it changes something, check whether it happened before calling it again.`));
  }
}

/** One call at the DEV connector whose JSON answer this server reads (the workspace list and the switch). */
export async function peerJson(sessionId, grant, name, args) {
  const r = await forwardToolCallRaw(sessionId, grant, name, args);
  const text = Array.isArray(r?.content) ? r.content.map((c) => c?.text || "").join("\n") : "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* a refusal sentence */ }
  return { result: r, json, text };
}

async function forwardToolCallRaw(sessionId, grant, name, args) {
  // The same path as a passed-on call, but with no active DEV workspace needed yet (listing or switching into one).
  if (!offerOf(grant.gid)) return refusal("DEV_LINK_OFF", "This connector does not reach DEV workspaces.");
  try {
    const client = await peerClient(sessionId, grant.gid, () => grant.token);
    return await client.callTool({ name, arguments: args || {} }, undefined, { timeout: FORWARD_TIMEOUT_MS });
  } catch (err) {
    dropPeer(sessionId);
    if (err instanceof LinkEnded) return refusal("DEV_LINK_ENDED", "The DEV link of this connection ended. Approve DEV again.");
    return refusal("DEV_UNAVAILABLE", `The DEV connector could not be reached (${String(err?.message || err).slice(0, 200)}).`);
  }
}

/** The person's email on this side (production), for the check that DEV was approved by the same person. */
export const personOf = (gid) => people.get(gid) || null;

/** DEV was approved by someone else: forget the link and say so (nothing of theirs is used). */
export async function refuseOtherPerson(prodToken, gid, sessionId) {
  dropPeer(sessionId);
  await endLink(prodToken, gid);
}
