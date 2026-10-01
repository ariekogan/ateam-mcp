/**
 * OAuth2 authorization server for ateam-mcp.
 * Wraps existing API keys (adas_*) in a standard OAuth 2.1 + PKCE flow
 * so that Claude.ai (and other MCP clients) can auto-authenticate via
 * the connector's OAuth settings.
 *
 * Uses the MCP SDK's built-in auth router and bearer middleware.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { parseApiKey, clearAuthOverride, KEY_ENVIRONMENTS, mcpUrlForEnv, envForMcpHost } from "./api.js";
import { KEY_IS_THE_WORKSPACE, whereTheKeyIs, KEY_PAGE_URL } from "./signInSteps.js";

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
// code is redeemed only at the issuer that issued it.
class ATeamOAuthProvider {
  constructor(environment) {
    this.environment = environment;
    this._clientsStore = new ATeamClientsStore();
    this.codes = new Map();     // code -> { client, params, apiKey, expiresAt }
    this.pending = new Map();   // pendingId -> { client, params, expiresAt }
  }

  get clientsStore() {
    return this._clientsStore;
  }

  /**
   * Called by the SDK's /authorize handler.
   * Serves an HTML page where the user enters their API key.
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
    const pendingId = randomUUID();
    this.pending.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL,
    });
    res.setHeader("Content-Type", "text/html");
    res.send(generateAuthPage(pendingId, requester, { environment: this.environment }));
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");

    if (entry.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
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

/**
 * The bearer gate's verifier, the same on every host: a token is valid when it
 * is a structurally valid adas_* API key. Returns AuthInfo in the MCP SDK's
 * shape.
 */
const accessTokens = {
  async verifyAccessToken(token) {
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
// `environment` is the one the addressed host names (mountOAuth): production's
// page links production's key page; any other environment's says "your
// environment's own A-Team app", with no URL (signInSteps.js whereTheKeyIs).
// It took no environment, so the dev MCP's page sent people to production for
// a key.
function keyHintHtml(environment) {
  const where = escapeHtml(whereTheKeyIs(environment)).replace(
    escapeHtml(KEY_PAGE_URL),
    `<a href="${escapeHtml(KEY_PAGE_URL)}" target="_blank" rel="noopener">${escapeHtml(KEY_PAGE_URL)}</a>`,
  );
  return `${escapeHtml(KEY_IS_THE_WORKSPACE)} ${where}`;
}

// `requester` is redirectRequester(redirect_uri): who the code goes to, by the
// redirect's host. Never the client_name, which the caller chooses.
// Exported so the page's words can be tested as rendered.
export function generateAuthPage(pendingId, requester, { error = null, environment = null } = {}) {
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
      <div class="hint">${keyHintHtml(environment)}</div>
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
 * started on dev bound a production workspace. Now each environment
 * (KEY_ENVIRONMENTS, via mcpUrlForEnv) gets its own SDK router and provider,
 * built from that environment's URL, and each request is dispatched by the
 * environment its host names: req.hostname, which is X-Forwarded-Host under
 * http.js's `trust proxy`, else Host, classified by envForMcpHost.
 *
 * A HOST THIS SERVER CANNOT NAME (a forged X-Forwarded-Host, a local run on
 * localhost, a self-hosted domain) gets no browser sign-in: every sign-in path
 * answers 421 with no URL, and the bearer gate's 401 names no metadata. It is
 * never echoed and never given production's URLs. A client there sends the
 * key as an Authorization: Bearer header, which the gate accepts on any host.
 *
 * @param {express.Application} app
 * @returns {{ providers: Record<string, ATeamOAuthProvider>, bearerMiddlewareFor: (mountPath: string) => express.RequestHandler }}
 *   bearerMiddlewareFor("/") / ("/mcp"): the bearer gate for that mount, whose
 *   401 challenge names that mount's protected-resource metadata on the
 *   addressed host, or none on a host this server cannot name.
 */
export function mountOAuth(app) {
  // The PRM document for the resource mounted at `mountPath` ("/" or "/mcp").
  // The SDK's own rule: /.well-known/oauth-protected-resource + the resource's
  // path. One function for the route that serves it and the challenge that
  // points at it.
  const prmUrlFor = (serverUrl, mountPath) => getOAuthProtectedResourceMetadataUrl(new URL(mountPath, serverUrl));

  const hosts = new Map(); // environment → { provider, router, serverUrl }
  for (const environment of Object.keys(KEY_ENVIRONMENTS)) {
    const origin = mcpUrlForEnv(environment);
    if (!origin) continue;
    const serverUrl = new URL(origin);
    const provider = new ATeamOAuthProvider(environment);
    const router = express.Router();

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
          environment,
          error: "Authorization request expired. Please close this page and try connecting again.",
        }));
        return;
      }

      const parsed = parseApiKey(api_key);
      if (!parsed.isValid) {
        // Re-render the page with an error
        res.status(400).send(generateAuthPage(pending_id, redirectRequester(entry.params.redirectUri), {
          environment,
          error: `That is not an A-Team API key. ${whereTheKeyIs(environment)}`,
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
    const host = hosts.get(envForMcpHost(req.hostname));
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
      verifier: accessTokens,
      requiredScopes: [],
      resourceMetadataUrl: prmUrlFor(serverUrl, mountPath),
    })]));
    const unnamed = requireBearerAuth({ verifier: accessTokens, requiredScopes: [] });
    return (req, res, next) => (gates.get(envForMcpHost(req.hostname)) || unnamed)(req, res, next);
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
