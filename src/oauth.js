/**
 * OAuth2 authorization server for ateam-mcp.
 * Wraps existing API keys (adas_*) in a standard OAuth 2.1 + PKCE flow
 * so that Claude.ai (and other MCP clients) can auto-authenticate via
 * the connector's OAuth settings.
 *
 * Uses the MCP SDK's built-in auth router and bearer middleware.
 */

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { authenticateClient } from "@modelcontextprotocol/sdk/server/auth/middleware/clientAuth.js";
import { InvalidTokenError, InvalidClientMetadataError, InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { parseApiKey, clearAuthOverride, mcpUrlForEnv, envForMcpHost, keyPageForEnv } from "./api.js";
import { KEY_IS_THE_WORKSPACE, whereTheKeyIsAt } from "./signInSteps.js";
import {
  coreCall, CoreUnavailable, resolveToken, refusalText, refusalCode,
  isGrantAccessToken, isGrantRefreshToken, isGrantCode,
} from "./grantAuth.js";

// ─── TTLs ─────────────────────────────────────────────────────────
const AUTH_CODE_TTL = 5 * 60 * 1000;   // 5 minutes
const PENDING_TTL = 10 * 60 * 1000;    // 10 minutes

// ─── Clients Store ────────────────────────────────────────────────

// ─── Redirect allowlist ───────────────────────────────────────────
//
// A code goes wherever redirect_uri says, so redirect_uri decides who receives
// the key a person types on the consent page. Until BUILDER-SEC-SIGNIN-P0 this
// server trusted it: registerClient merged in whatever URIs a caller sent,
// getClient accepted any client_id, and the consent page named the client by
// the client_name the caller chose. Anyone could register "Claude" with their
// own callback, send a person the /authorize link, and receive that person's
// tenant key (Core Docs/handoff/2026-09-27-agent-signin, §6).
//
// Now a redirect is accepted only if it is one of these, at registration AND at
// /authorize. Adding a client is a code change here.
//   - the exact https callbacks below;
//   - ChatGPT's per-connection callback, https://chatgpt.com/connector/oauth/
//     followed by exactly ONE segment of unreserved characters (OpenAI's
//     connector registration, used when the server lacks RFC 9207). Matched on
//     the raw string, so no other host, port, userinfo, "/", "..", query or
//     fragment gets through;
//   - loopback, http://localhost or http://127.0.0.1 on any port and path, for
//     native clients (Claude Code, VS Code's 127.0.0.1:33418) — RFC 8252 §7.3;
//     a code sent there stays on the person's own machine;
//   - Cursor's app scheme (RFC 8252 §7.1), on Cursor's own hosts only.
// The consent page names the requester from THIS table, by the redirect's host,
// never by client_name.
const HTTPS_REDIRECTS = new Map([
  ["https://claude.ai/api/mcp/auth_callback", "Claude"],
  ["https://claude.com/api/mcp/auth_callback", "Claude"],
  ["https://chatgpt.com/connector_platform_oauth_redirect", "ChatGPT"],
  // Cursor desktop registers this with cursor://anysphere.cursor-mcp/oauth/callback
  // and authorizes with this one.
  ["https://www.cursor.com/agents/mcp/oauth/callback", "Cursor"],
  ["https://vscode.dev/redirect", "VS Code"],
  ["https://insiders.vscode.dev/redirect", "VS Code Insiders"],
]);
const HTTPS_PREFIX_REDIRECTS = [
  { prefix: "https://chatgpt.com/connector/oauth/", name: "ChatGPT", host: "chatgpt.com" },
];
// One path segment of RFC 3986 unreserved characters, and not "." or "..".
const ONE_SEGMENT = /^(?!\.+$)[A-Za-z0-9._~-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const APP_SCHEME_HOSTS = new Map([
  ["cursor:", { hosts: new Set(["anysphere.cursor-mcp", "anysphere.cursor-retrieval"]), name: "Cursor" }],
]);

/**
 * Who a redirect_uri delivers the code to, or null when it is not allowlisted.
 * @returns {{ name: string, host: string } | null}
 */
export function redirectRequester(uri) {
  if (typeof uri !== "string") return null;
  let url;
  try { url = new URL(uri); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (HTTPS_REDIRECTS.has(uri)) return { name: HTTPS_REDIRECTS.get(uri), host: url.host };
  for (const { prefix, name, host } of HTTPS_PREFIX_REDIRECTS) {
    if (uri.startsWith(prefix) && ONE_SEGMENT.test(uri.slice(prefix.length))) return { name, host };
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return { name: "an app on this computer", host: url.host };
  }
  const app = APP_SCHEME_HOSTS.get(url.protocol);
  if (app && app.hosts.has(url.hostname)) return { name: app.name, host: url.host };
  return null;
}

// The redirects of a client this server does not know: the pre-registered
// public client, and any client_id after a restart wiped the in-memory
// registrations (fafb812). Every entry is on the allowlist, so the fallback can
// no longer hand out a caller's redirect.
const KNOWN_REDIRECT_URIS = [...HTTPS_REDIRECTS.keys(), "http://localhost", "http://127.0.0.1"];

class ATeamClientsStore {
  constructor() {
    this.clients = new Map();
    // Pre-register the well-known public client
    this.clients.set("ateam-public", {
      client_id: "ateam-public",
      client_name: "A-Team MCP Public Client",
      redirect_uris: KNOWN_REDIRECT_URIS,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  }

  async getClient(clientId) {
    const known = this.clients.get(clientId);
    if (known) return known;

    // Unknown client_id (e.g. after a container restart wiped in-memory
    // registrations): accept it, with the allowlisted redirects only.
    return {
      client_id: clientId,
      client_name: clientId,
      redirect_uris: KNOWN_REDIRECT_URIS,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  async registerClient(clientMetadata) {
    const uris = clientMetadata.redirect_uris || [];
    const refused = uris.filter((u) => !redirectRequester(u));
    if (uris.length === 0 || refused.length > 0) {
      throw new InvalidClientMetadataError(uris.length === 0
        ? "redirect_uris is required"
        : `redirect_uri not allowed: ${refused.join(", ")}. This server issues codes only to Claude, ChatGPT, Cursor, VS Code, and loopback (http://localhost or http://127.0.0.1) redirects.`);
    }
    const clientId = clientMetadata.client_id || randomUUID();
    const record = { ...clientMetadata, client_id: clientId, redirect_uris: uris };
    this.clients.set(clientId, record);
    return record;
  }
}

// ─── OAuth Provider ───────────────────────────────────────────────

// ONE PROVIDER PER ENVIRONMENT (mountOAuth): its sign-in page, its pending
// sign-ins and the codes it issues belong to that environment's MCP host, so a
// code is redeemed only at the issuer that issued it. `keyPage` is the key page
// its sign-in page may link (api.js keyPageForEnv), or null for none.
class ATeamOAuthProvider {
  constructor(keyPage, environment = null) {
    this.keyPage = keyPage;
    // The environment of the MCP host this provider serves. Personal sign-in is used only when this
    // server's own Core answers for the same environment (grantAuth.js).
    this.environment = environment;
    // PKCE is checked where the code lives: Core for a personal sign-in code (atc_), here for a key
    // page code (verifyPkce below). The SDK then hands the verifier to exchangeAuthorizationCode.
    this.skipLocalPkceValidation = true;
    this._clientsStore = new ATeamClientsStore();
    this.codes = new Map();     // code -> { client, params, apiKey, expiresAt }
    this.pending = new Map();   // pendingId -> { client, params, expiresAt }
  }

  get clientsStore() {
    return this._clientsStore;
  }

  /**
   * Called by the SDK's /authorize handler.
   *
   * PERSONAL SIGN-IN FIRST: when this environment has it switched on (SysAdmin → Agent sign-in) and
   * this server's Core is the environment the host names, the browser goes to the A-Team app's
   * approval page (/connect?request=…), where the person signs in as themself and taps Approve.
   * Otherwise, or when Core cannot be asked, the key page as before (now the "Advanced" way).
   */
  async authorize(client, params, res) {
    // The SDK has already matched redirect_uri against the client's record, and
    // every record holds allowlisted redirects only. This check does not rely on
    // that: a redirect off the list gets no page, and no redirect either (an
    // error thrown here would be sent TO the redirect).
    const requester = redirectRequester(params.redirectUri);
    if (!requester) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is not an allowed client redirect" });
      return;
    }
    if (params.codeChallenge && this.environment) {
      try {
        const out = await coreCall("open", {
          client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge,
          code_challenge_method: "S256", state: params.state, requester,
          ip: res.req?.ip || null, ua: res.req?.headers?.["user-agent"] || null,
        });
        if (out.ok && out.env === this.environment && out.approve_url) {
          res.redirect(302, out.approve_url);
          return;
        }
      } catch (err) {
        if (!(err instanceof CoreUnavailable)) throw err;
        // No personal sign-in reachable here: the key page below.
      }
    }
    const pendingId = randomUUID();
    this.pending.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL,
    });
    res.setHeader("Content-Type", "text/html");
    res.send(generateAuthPage(pendingId, requester, { keyPage: this.keyPage }));
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri) {
    if (isGrantCode(authorizationCode)) {
      // A personal sign-in code: Core checks PKCE, the client and the redirect, and burns it.
      const out = await askCore("redeem", { code: authorizationCode, code_verifier: codeVerifier, client_id: client.client_id, redirect_uri: redirectUri });
      if (!out.ok) throw new InvalidGrantError(refusalText(out));
      return { access_token: out.access_token, refresh_token: out.refresh_token, token_type: "Bearer", expires_in: out.expires_in };
    }
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");

    if (entry.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    // The SDK skips its own PKCE check for every code (skipLocalPkceValidation, for Core's); a key page code is checked here.
    if (!verifyPkce(codeVerifier, entry.params.codeChallenge)) {
      throw new InvalidGrantError("code_verifier does not match the challenge");
    }
    if (entry.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }

    // One-time use
    this.codes.delete(authorizationCode);

    // A NEW SIGN-IN ON THIS PAGE IS THE WORKSPACE THE PERSON CHOSE. An
    // ateam_auth override kept for this key (api.js setAuthOverride) would put
    // every new session of it back on the workspace that override names, so a
    // person who signed in again to get back to this key's workspace did not.
    clearAuthOverride(entry.apiKey);

    // PHASE-1: the access token is the RAW tenant key the person typed, and the
    // refresh token is rt_<that key>. Phase 1 of the agent sign-in design
    // (Core Docs/handoff/2026-09-27-agent-signin) replaces both with a
    // Core-minted grant. Unchanged here on purpose; see ATEAM_MCP_INVARIANTS §1.
    return {
      access_token: entry.apiKey,
      refresh_token: `rt_${entry.apiKey}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "claudeai",
    };
  }

  async exchangeRefreshToken(_client, refreshToken) {
    if (isGrantRefreshToken(refreshToken)) {
      const out = await askCore("refresh", { refresh_token: refreshToken });
      if (!out.ok) throw new InvalidGrantError(refusalText(out));
      return { access_token: out.access_token, refresh_token: out.refresh_token, token_type: "Bearer", expires_in: out.expires_in };
    }
    // PHASE-1: the refresh token is rt_<raw tenant key>, so "refreshing" is
    // handing the key back. Phase 1 replaces it with Core's rotating refresh
    // (revocable, idle and absolute limits). Unchanged here on purpose.
    // Refresh token is rt_<apiKey> — extract the API key
    const apiKey = refreshToken.startsWith("rt_") ? refreshToken.slice(3) : refreshToken;
    const parsed = parseApiKey(apiKey);
    if (!parsed.isValid) throw new Error("Invalid refresh token");
    return {
      access_token: apiKey,
      refresh_token: `rt_${apiKey}`,
      token_type: "Bearer",
      expires_in: 3600,
    };
  }
}

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// No redirect names a device client, so the approval page cannot name it from the allowlist; it says
// what it is instead (never a client_name the caller chose).
const DEVICE_REQUESTER = { name: "An app using a sign-in code", host: "device" };

function mountDeviceFlow(router, provider, serverUrl) {
  const form = [express.urlencoded({ extended: false }), express.json()];
  const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });
  const core = async (res, method, params) => {
    try { return await coreCall(method, params); } catch (err) {
      if (err instanceof CoreUnavailable) { oauthError(res, 503, "temporarily_unavailable", err.message); return null; }
      throw err;
    }
  };

  // The client is authenticated at both endpoints the same way as at the SDK's /token (RFC 8628 §3.1, §3.4):
  // a registered client_id, and its secret when it was issued one.
  const clientAuth = authenticateClient({ clientsStore: provider.clientsStore });

  router.post("/device_authorization", ...form, clientAuth, async (req, res) => {
    const out = await core(res, "deviceOpen", { client_id: req.client.client_id, requester: DEVICE_REQUESTER, ua: req.headers["user-agent"] || null });
    if (!out) return;
    if (!out.ok) return oauthError(res, 400, refusalCode(out) || "invalid_request", refusalText(out));
    if (out.env !== provider.environment) return oauthError(res, 400, "unsupported_grant_type", "Sign-in codes are not offered on this connector");
    res.set("Cache-Control", "no-store").json({
      device_code: out.device_code, user_code: out.user_code,
      verification_uri: out.verification_uri, verification_uri_complete: out.verification_uri_complete,
      expires_in: out.expires_in, interval: out.interval,
    });
  });

  router.post("/token", ...form, (req, res, next) => (req.body?.grant_type === DEVICE_GRANT ? clientAuth(req, res, next) : next("route")), async (req, res) => {
    const out = await core(res, "devicePoll", { device_code: req.body.device_code, client_id: req.client.client_id });
    if (!out) return;
    if (!out.ok) return oauthError(res, 400, refusalCode(out) || "invalid_grant", refusalText(out));
    res.set("Cache-Control", "no-store").json({ access_token: out.access_token, refresh_token: out.refresh_token, token_type: "Bearer", expires_in: out.expires_in });
  });

  // The authorization server metadata names the device endpoint (RFC 8628 §4), on top of the SDK's document.
  router.get("/.well-known/oauth-authorization-server", (_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => send({
      ...body,
      device_authorization_endpoint: new URL("/device_authorization", serverUrl).href,
      grant_types_supported: [...new Set([...(body?.grant_types_supported || []), DEVICE_GRANT])],
    });
    next();
  });
}

/** OAuth /revoke (RFC 7009): a personal sign-in token ends its grant at Core. A key cannot be revoked here. */
ATeamOAuthProvider.prototype.revokeToken = async function revokeToken(_client, request) {
  const t = request?.token;
  if (isGrantAccessToken(t) || isGrantRefreshToken(t)) await askCore("revoke", { token: t });
};

/** Core's answer, or a 5xx-shaped OAuth error when Core cannot be asked (never a 4xx that signs the person out). */
async function askCore(method, params) {
  try {
    return await coreCall(method, params);
  } catch (err) {
    if (err instanceof CoreUnavailable) throw new ServerError(err.message);
    throw err;
  }
}

/** RFC 7636 S256, constant time. */
function verifyPkce(verifier, challenge) {
  if (typeof verifier !== "string" || typeof challenge !== "string" || !verifier || !challenge) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return computed.length === want.length && timingSafeEqual(computed, want);
}

/**
 * The verifier for one MCP host: a personal sign-in token is valid only on the host of the environment
 * Core says it belongs to (one process may serve several hosts with one Core). A host this server cannot
 * name accepts none. A key is checked the same on every host, as before.
 */
function verifierFor(environment) {
  return {
    async verifyAccessToken(token) {
      const info = await accessTokens.verifyAccessToken(token);
      if (info.extra?.grant && (!environment || info.extra.env !== environment)) {
        throw new InvalidTokenError("This sign-in belongs to another A-Team environment's connector");
      }
      return info;
    },
  };
}

/**
 * The bearer gate's verifier, the same on every host: a token is valid when it
 * is a structurally valid adas_* API key. Returns AuthInfo in the MCP SDK's
 * shape.
 */
const accessTokens = {
  async verifyAccessToken(token) {
    if (isGrantAccessToken(token)) {
      // A personal sign-in token: Core says who it is (cached 60 s). Core unreachable is a 5xx, never a 401.
      let who;
      try { who = await resolveToken(token); } catch (err) {
        if (err instanceof CoreUnavailable) throw new ServerError(err.message);
        throw err;
      }
      if (!who) throw new InvalidTokenError("Sign-in token is not valid any more");
      return {
        token,
        clientId: "ateam-public",
        scopes: ["mcp"],
        expiresAt: who.exp,
        extra: { grant: who.gid, userId: who.userId, email: who.email, env: who.env, lastTenant: who.lastTenant },
      };
    }
    const parsed = parseApiKey(token);
    if (!parsed.isValid) throw new InvalidTokenError("Invalid access token");
    return {
      token,
      clientId: "ateam-public",
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: {
        userId: parsed.tenant,
      },
    };
  },
};

// ─── Auth Page HTML ───────────────────────────────────────────────

// Under the key field: the key picks the workspace, and where a key is — the
// words of signInSteps.js, with Core's key page linked. It said "Don't have a
// key? Get your API key" (293c43b), a link to /get-api-key, which landed on
// the app's home page: nothing in the app read the ?admin=tokens it sent.
// `keyPage` is the key page of the environment the addressed host names
// (mountOAuth, api.js keyPageForEnv): production's on production, a
// self-hosted box's own on that box, and null on any other environment, whose
// page says "your environment's own A-Team app" with no URL. Until #51 it was
// production's on every host, so the dev MCP's page sent people to production
// for a key.
function keyHintHtml(keyPage) {
  const where = !keyPage ? escapeHtml(whereTheKeyIsAt(null)) : escapeHtml(whereTheKeyIsAt(keyPage)).replace(
    escapeHtml(keyPage),
    `<a href="${escapeHtml(keyPage)}" target="_blank" rel="noopener">${escapeHtml(keyPage)}</a>`,
  );
  return `${escapeHtml(KEY_IS_THE_WORKSPACE)} ${where}`;
}

// `requester` is redirectRequester(redirect_uri): who the code goes to, by the
// redirect's host. Never the client_name, which the caller chooses.
// Exported so the page's words can be tested as rendered.
export function generateAuthPage(pendingId, requester, { error = null, keyPage = null } = {}) {
  const errorHtml = error
    ? `<div style="background:#3a1c1c;border:1px solid #7f1d1d;color:#fca5a5;padding:12px;border-radius:8px;margin-bottom:16px;font-size:14px">${escapeHtml(error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize - A-Team</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #171717; border: 1px solid #262626;
      border-radius: 12px; padding: 32px;
      max-width: 420px; width: 100%;
    }
    .logo { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #a3a3a3; font-size: 14px; margin-bottom: 24px; }
    .client-name { color: #60a5fa; font-weight: 500; }
    .client-host { color: #a3a3a3; font-family: monospace; }
    label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
    input[type="text"] {
      width: 100%; padding: 10px 12px; font-size: 14px;
      background: #0a0a0a; border: 1px solid #404040;
      border-radius: 8px; color: #e5e5e5;
      font-family: monospace;
    }
    input[type="text"]:focus { outline: none; border-color: #60a5fa; }
    .hint {
      font-size: 12px; color: #737373; margin-top: 6px;
    }
    .hint a { color: #60a5fa; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button {
      flex: 1; padding: 10px 16px; font-size: 14px; font-weight: 500;
      border: none; border-radius: 8px; cursor: pointer;
    }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled { background: #1e3a5f; color: #6b7280; cursor: not-allowed; }
    .btn-cancel { background: #262626; color: #a3a3a3; }
    .btn-cancel:hover { background: #333; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid #6b7280; border-top-color: #fff;
      border-radius: 50%; animation: spin 0.6s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    .status {
      text-align: center; padding: 12px; border-radius: 8px;
      margin-top: 16px; font-size: 14px; display: none;
    }
    .status.success {
      display: block; background: #1a2e1a; border: 1px solid #166534; color: #86efac;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">A-Team</div>
    <div class="subtitle">
      ${requester
        ? `<span class="client-name">${escapeHtml(requester.name)}</span> (<span class="client-host">${escapeHtml(requester.host)}</span>) wants to connect to an A-Team workspace`
        : "Connect to an A-Team workspace"}
    </div>
    ${errorHtml}
    <form id="authForm" method="POST" action="/authorize-submit">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
      <label for="api_key">API Key</label>
      <input type="text" id="api_key" name="api_key"
             placeholder="adas_…" required autofocus
             autocomplete="off" spellcheck="false">
      <div class="hint">${keyHintHtml(keyPage)}</div>
      <div class="actions">
        <button type="submit" id="submitBtn" class="btn-primary">Authorize</button>
      </div>
      <div id="status" class="status"></div>
    </form>
  </div>
  <script>
    document.getElementById('authForm').addEventListener('submit', function() {
      var btn = document.getElementById('submitBtn');
      var status = document.getElementById('status');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Authorizing\u2026';
      status.className = 'status success';
      status.style.display = 'block';
      status.textContent = 'Redirecting you back\u2026';
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── Mount OAuth Routes ───────────────────────────────────────────

// Every path the sign-in serves. On a host this server cannot name, each one
// answers 421 (refuseUnnamedHost) instead of falling through to the 404.
const SIGN_IN_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/authorize",
  "/authorize-submit",
  "/token",
  "/register",
];
const isSignInPath = (path) => SIGN_IN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

// RFC 9110 §15.5.20: this server will not answer for the host the request
// named. No URL in it, and not the host it was sent.
function refuseUnnamedHost(res) {
  res.status(421).json({
    error: "misdirected_request",
    error_description: "This server signs in only on the A-Team MCP host it serves, and this request did not " +
      "address one, so there is no sign-in here and no sign-in URL to give. Connect to the A-Team MCP by its own " +
      "address, or send the key as an Authorization: Bearer header from the client's config.",
  });
}

/**
 * Mounts OAuth2 discovery, authorization, token, and registration endpoints on
 * the Express app — once for each environment this server can name.
 *
 * THE URLS BELONG TO THE HOST THE REQUEST ADDRESSED. They came from one
 * process-wide base (ATEAM_BASE_URL, 293c43b), which the Dockerfile set to
 * production's MCP, so the dev MCP's 401 challenge, metadata, issuer, and
 * authorize and token endpoints all named production, and a browser sign-in
 * started on dev bound a production workspace. Now each environment of
 * `environments` (api.js hostEnvironments: KEY_ENVIRONMENTS, plus a
 * self-hosted box's own from DOMAIN) gets its own SDK router and provider,
 * built from that environment's URL (mcpUrlForEnv), and each request is
 * dispatched by the environment its host names: req.hostname, which is
 * X-Forwarded-Host under http.js's `trust proxy`, else Host, classified by
 * envForMcpHost.
 *
 * A HOST THIS SERVER CANNOT NAME (a forged X-Forwarded-Host, a local run on
 * localhost, a self-hosted domain DOMAIN does not name) gets no browser sign-in: every sign-in path
 * answers 421 with no URL, and the bearer gate's 401 names no metadata. It is
 * never echoed and never given production's URLs. A client there sends the
 * key as an Authorization: Bearer header, which the gate accepts on any host.
 *
 * @param {express.Application} app
 * @param {Readonly<Record<string, string>>} environments - api.js hostEnvironments(), read once at startup
 * @returns {{ providers: Record<string, ATeamOAuthProvider>, bearerMiddlewareFor: (mountPath: string) => express.RequestHandler }}
 *   bearerMiddlewareFor("/") / ("/mcp"): the bearer gate for that mount, whose
 *   401 challenge names that mount's protected-resource metadata on the
 *   addressed host, or none on a host this server cannot name.
 */
export function mountOAuth(app, environments) {
  // The PRM document for the resource mounted at `mountPath` ("/" or "/mcp").
  // The SDK's own rule: /.well-known/oauth-protected-resource + the resource's
  // path. One function for the route that serves it and the challenge that
  // points at it.
  const prmUrlFor = (serverUrl, mountPath) => getOAuthProtectedResourceMetadataUrl(new URL(mountPath, serverUrl));

  const hosts = new Map(); // environment → { provider, router, serverUrl }
  for (const environment of Object.keys(environments)) {
    const origin = mcpUrlForEnv(environment, environments);
    if (!origin) continue;
    const serverUrl = new URL(origin);
    const provider = new ATeamOAuthProvider(keyPageForEnv(environment, environments), environment);
    const router = express.Router();

    // ─── DEVICE CODE (RFC 8628) — personal sign-in for an app with no browser (a terminal) ───────
    // Before the SDK router, which knows only authorization_code and refresh_token. Core holds every
    // rule (services/agentAuth.js deviceOpen/devicePoll); this host only speaks the protocol, and only
    // when its Core is the environment this host names.
    mountDeviceFlow(router, provider, serverUrl);

    // SDK OAuth router (/.well-known/*, /authorize, /token, /register)
    // IMPORTANT: resourceServerUrl MUST match the connector URL that users configure
    // in Claude.ai. Claude.ai validates resource == connector URL after token exchange.
    // Connector URL is the root (the MCP's origin), NOT /mcp.
    router.use(mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      baseUrl: serverUrl,
      resourceServerUrl: serverUrl,
      resourceName: "A-Team MCP",
      serviceDocumentationUrl: new URL("https://ateam-ai.com"),
      scopesSupported: [],
    }));

    // ─── PRM at /mcp path (RFC 9728 path-based discovery) ────────────
    // Claude.ai looks for /.well-known/oauth-protected-resource/mcp when
    // connecting to /mcp. The SDK only serves PRM at the root resource path.
    // Its URL comes from the same function as the challenge that points at it
    // (prmUrlFor), so the two cannot name different documents.
    router.get(new URL(prmUrlFor(serverUrl, "/mcp")).pathname, (_req, res) => {
      res.json({
        resource: new URL("/mcp", serverUrl).href,
        authorization_servers: [serverUrl.href],
      });
    });

    // ─── POST /authorize-submit — processes the auth page form ───────
    router.post("/authorize-submit", express.urlencoded({ extended: false }), (req, res) => {
      const { pending_id, api_key } = req.body;

      const entry = provider.pending.get(pending_id);
      if (!entry || entry.expiresAt < Date.now()) {
        provider.pending.delete(pending_id);
        res.status(400).send(generateAuthPage("expired", null, {
          keyPage: provider.keyPage,
          error: "Authorization request expired. Please close this page and try connecting again.",
        }));
        return;
      }

      const parsed = parseApiKey(api_key);
      if (!parsed.isValid) {
        // Re-render the page with an error
        res.status(400).send(generateAuthPage(pending_id, redirectRequester(entry.params.redirectUri), {
          keyPage: provider.keyPage,
          error: `That is not an A-Team API key. ${whereTheKeyIsAt(provider.keyPage)}`,
        }));
        return;
      }

      // Generate one-time auth code
      const code = randomUUID();
      provider.codes.set(code, {
        client: entry.client,
        params: entry.params,
        apiKey: api_key,
        expiresAt: Date.now() + AUTH_CODE_TTL,
      });
      provider.pending.delete(pending_id);

      // Redirect back to the client with the auth code
      const redirectUrl = new URL(entry.params.redirectUri);
      redirectUrl.searchParams.set("code", code);
      if (entry.params.state) {
        redirectUrl.searchParams.set("state", entry.params.state);
      }
      res.redirect(redirectUrl.toString());
    });

    hosts.set(environment, { provider, router, serverUrl });
  }

  // Dispatch by the addressed host. Every other path goes on untouched.
  app.use((req, res, next) => {
    const host = hosts.get(envForMcpHost(req.hostname, environments));
    if (host) return host.router(req, res, next);
    if (isSignInPath(req.path)) return refuseUnnamedHost(res);
    next();
  });

  // ─── Bearer middleware for MCP routes — one per mount ────────────
  // A 401 names the protected-resource metadata a client should read next
  // (WWW-Authenticate resource_metadata, RFC 9728), and a client checks that
  // the document's `resource` is the URL it called (§3.3). So the challenge on
  // "/" points at the root PRM (resource = the root) and the challenge on
  // "/mcp" at the /mcp PRM above (resource = …/mcp), on the addressed host.
  //
  // There was ONE middleware, pointing every challenge at the root PRM
  // (8661ca0). That was inert while "/mcp" never challenged; since 39ff024 made
  // "/mcp" strict, every anonymous /mcp request was sent to a document naming a
  // different resource than the one it asked for.
  //
  // A host this server cannot name gets the same gate with no resource_metadata:
  // the 401 still refuses, and points nowhere.
  const bearerMiddlewareFor = (mountPath) => {
    const gates = new Map([...hosts].map(([environment, { serverUrl }]) => [environment, requireBearerAuth({
      verifier: verifierFor(environment),
      requiredScopes: [],
      resourceMetadataUrl: prmUrlFor(serverUrl, mountPath),
    })]));
    const unnamed = requireBearerAuth({ verifier: verifierFor(null), requiredScopes: [] });
    return (req, res, next) => (gates.get(envForMcpHost(req.hostname, environments)) || unnamed)(req, res, next);
  };

  // ─── Periodic cleanup of expired entries ────────────────────────
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const { provider } of hosts.values()) {
      for (const [code, data] of provider.codes) {
        if (data.expiresAt < now) provider.codes.delete(code);
      }
      for (const [id, data] of provider.pending) {
        if (data.expiresAt < now) provider.pending.delete(id);
      }
    }
  }, 60_000);
  cleanup.unref();

  const providers = Object.fromEntries([...hosts].map(([environment, { provider }]) => [environment, provider]));
  return { providers, bearerMiddlewareFor };
}
