/**
 * PERSONAL SIGN-IN — the session side (http.js seedCredentials calls it on every request of a grant).
 * grantAuth.js talks to Core; this file puts the grant's workspace into the session (api.js).
 */
import { bindSessionGrant, dropSessionWorkspace, getCredentials, setSessionCredentials, baseUrlForKeyEnv } from "./api.js";
import { activeWorkspace, chooseWorkspace, listGrantWorkspaces } from "./grantAuth.js";
/**
 * A PERSONAL SIGN-IN SESSION (grantAuth.js): bind the grant, then put the grant's active workspace in.
 *
 * The workspace's key comes from Core into this server's memory and goes into the session record like any
 * key the user signed in with; it never reaches the client. With no active workspace yet (a new chat, or
 * this server restarted), the grant starts on the one Core remembers (the person's last), or on the only
 * one they have. More than one and none remembered: nothing is chosen, and the session is told to ask the
 * user (signInSteps.js). Core re-checks the person's role at least every 60 s (activeWorkspace): when they
 * are no longer owner or admin there, the key is dropped from every session of the grant.
 *
 * A Core outage throws CoreUnavailable; it reaches the client as a 5xx, never as a sign-out.
 */
export async function seedGrantSession(req, sessionId) {
  const { token, extra } = req.auth;
  const gid = extra.grant;
  bindSessionGrant(sessionId, { gid, token, env: extra.env });
  let w = await activeWorkspace(token, gid);
  if (w?.dropped) {
    console.warn(`[Auth] Grant session ${sessionId}: no longer allowed in "${w.tenant}"; its key is dropped.`);
    w = null;
  }
  if (!w) w = await startingWorkspace(token, gid, extra.lastTenant);
  if (!w) {
    dropSessionWorkspace(sessionId);
    return;
  }
  const current = getCredentials(sessionId);
  if (current?.apiKey === w.apiKey && current?.tenant === w.tenant) return;
  setSessionCredentials(sessionId, { tenant: w.tenant, apiKey: w.apiKey, apiUrl: baseUrlForKeyEnv(w.apiKey) || undefined, explicit: true });
}

// gid → the time a start was last tried with no result, so a person with several workspaces and none
// remembered is not asked about on every request.
const startTried = new Map();

async function startingWorkspace(token, gid, lastTenant) {
  const tried = startTried.get(gid);
  if (tried && Date.now() - tried < 60_000) return null;
  let tenant = lastTenant || null;
  if (!tenant) {
    const listed = await listGrantWorkspaces(token);
    const mine = listed.ok && Array.isArray(listed.workspaces) ? listed.workspaces : [];
    if (mine.length === 1) tenant = mine[0].tenant;
  }
  if (tenant) {
    const chosen = await chooseWorkspace(token, gid, tenant);
    if (chosen.ok) { startTried.delete(gid); return chosen.workspace; }
  }
  startTried.set(gid, Date.now());
  if (startTried.size > 5000) startTried.delete(startTried.keys().next().value);
  return null;
}
