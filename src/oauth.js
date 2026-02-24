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
import { parseApiKey } from "./api.js";

// ─── TTLs ─────────────────────────────────────────────────────────
const AUTH_CODE_TTL = 5 * 60 * 1000;   // 5 minutes
const PENDING_TTL = 10 * 60 * 1000;    // 10 minutes

// ─── Clients Store ────────────────────────────────────────────────

class ATeamClientsStore {
  constructor() {
    this.clients = new Map();
    // Pre-register the well-known public client for Claude.ai
    this.clients.set("ateam-public", {
      client_id: "ateam-public",
      client_name: "A-Team MCP Public Client",
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
        "http://localhost",
        "http://127.0.0.1",
      ],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    const clientId = clientMetadata.client_id || randomUUID();
    const record = { ...clientMetadata, client_id: clientId };
    this.clients.set(clientId, record);
    return record;
  }
}

// ─── OAuth Provider ───────────────────────────────────────────────

class ATeamOAuthProvider {
  constructor() {
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
    const pendingId = randomUUID();
    this.pending.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL,
    });
    res.setHeader("Content-Type", "text/html");
    res.send(generateAuthPage(pendingId, client.client_name || client.client_id));
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

    return {
      access_token: entry.apiKey,
      token_type: "bearer",
      // Long-lived — the API key doesn't expire on its own
      expires_in: 86400 * 365,
    };
  }

  async exchangeRefreshToken() {
    throw new Error("Refresh tokens not supported");
  }

  /**
   * Validates that the token is a structurally valid adas_* API key.
   */
  async verifyAccessToken(token) {
    const parsed = parseApiKey(token);
    if (!parsed.isValid) throw new Error("Invalid access token");
    return {
      token,
      clientId: "ateam-public",
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365,
    };
  }
}

// ─── Auth Page HTML ───────────────────────────────────────────────

function generateAuthPage(pendingId, clientName, error) {
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
      <span class="client-name">${escapeHtml(clientName)}</span> wants to connect to your A-Team account
    </div>
    ${errorHtml}
    <form id="authForm" method="POST" action="/authorize-submit">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
      <label for="api_key">API Key</label>
      <input type="text" id="api_key" name="api_key"
             placeholder="adas_tenant_abc123..." required autofocus
             autocomplete="off" spellcheck="false">
      <div class="hint">
        Don't have a key?
        <a href="/get-api-key" target="_blank">Get your API key</a>
      </div>
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
      status.textContent = 'Redirecting you back to Claude\u2026';
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

/**
 * Mounts OAuth2 discovery, authorization, token, and registration
 * endpoints on the Express app.
 *
 * @param {express.Application} app
 * @param {string} baseUrl - Public URL of the server (e.g. https://mcp.ateam-ai.com)
 * @returns {{ provider: ATeamOAuthProvider, bearerMiddleware: express.RequestHandler }}
 */
export function mountOAuth(app, baseUrl) {
  const serverUrl = new URL(baseUrl);
  const mcpUrl = new URL("/mcp", serverUrl);
  const provider = new ATeamOAuthProvider();

  // Mount SDK OAuth router (/.well-known/*, /authorize, /token, /register)
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: serverUrl,
    baseUrl: serverUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "A-Team MCP",
    serviceDocumentationUrl: new URL("https://ateam-ai.com"),
    scopesSupported: [],
  }));

  // ─── Duplicate protected-resource metadata at root path ───────────
  // Claude.ai derives metadata URL from the connector URL (https://mcp.ateam-ai.com)
  // → /.well-known/oauth-protected-resource (root). The SDK mounts at /mcp suffix.
  // Serve both so discovery works regardless of how the connector URL is configured.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [serverUrl.href],
      bearer_methods_supported: ["header"],
    });
  });

  // ─── Custom POST /authorize-submit — processes the auth page form ──
  app.post("/authorize-submit", express.urlencoded({ extended: false }), (req, res) => {
    const { pending_id, api_key } = req.body;

    const entry = provider.pending.get(pending_id);
    if (!entry || entry.expiresAt < Date.now()) {
      provider.pending.delete(pending_id);
      res.status(400).send(generateAuthPage("expired", "A-Team",
        "Authorization request expired. Please close this page and try connecting again."));
      return;
    }

    const parsed = parseApiKey(api_key);
    if (!parsed.isValid) {
      // Re-render the page with an error
      res.status(400).send(generateAuthPage(pending_id, entry.client.client_name || entry.client.client_id,
        "Invalid API key format. Keys look like: adas_tenant_abc123..."));
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

  // ─── Bearer middleware for /mcp routes ──────────────────────────
  const bearerMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // ─── Periodic cleanup of expired entries ────────────────────────
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [code, data] of provider.codes) {
      if (data.expiresAt < now) provider.codes.delete(code);
    }
    for (const [id, data] of provider.pending) {
      if (data.expiresAt < now) provider.pending.delete(id);
    }
  }, 60_000);
  cleanup.unref();

  return { provider, bearerMiddleware };
}
