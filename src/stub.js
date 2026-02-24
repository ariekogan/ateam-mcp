/**
 * Minimal MCP OAuth stub — for testing Claude.ai OAuth flow.
 *
 * MCP served at BOTH "/" and "/mcp" (Claude.ai uses root, others use /mcp).
 * PRM served at both /.well-known/oauth-protected-resource and .../mcp.
 * Auto-approve OAuth (no API key page needed).
 * Token auto-injection for Claude.ai proxy bug.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod";

// MCP paths — Claude.ai uses "/" (connector URL root), others may use "/mcp"
const MCP_PATHS = ["/", "/mcp"];

// ─── Minimal OAuth Provider ──────────────────────────────────────────

class StubClientsStore {
  constructor() {
    this.clients = new Map();
  }
  async getClient(clientId) {
    return this.clients.get(clientId);
  }
  async registerClient(metadata) {
    const clientId = metadata.client_id || randomUUID();
    const record = { ...metadata, client_id: clientId };
    this.clients.set(clientId, record);
    return record;
  }
}

class StubOAuthProvider {
  constructor() {
    this._clientsStore = new StubClientsStore();
    this.codes = new Map();
    this.tokens = new Map();
  }

  get clientsStore() {
    return this._clientsStore;
  }

  async authorize(client, params, res) {
    const code = randomUUID();
    const token = `stub_token_${randomUUID()}`;
    this.codes.set(code, { client, params, token });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);

    console.log(`[Stub] Auto-approved, redirecting with code`);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    const entry = this.codes.get(code);
    if (!entry) throw new Error("Invalid code");
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code) {
    const entry = this.codes.get(code);
    if (!entry) throw new Error("Invalid code");
    this.codes.delete(code);

    const token = entry.token;
    this.tokens.set(token, { clientId: client.client_id });

    console.log(`[Stub] Exchanged code for token: ${token.substring(0, 30)}...`);
    return {
      access_token: token,
      refresh_token: `rt_${token}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "claudeai",
    };
  }

  async exchangeRefreshToken(_client, refreshToken) {
    const original = refreshToken.startsWith("rt_") ? refreshToken.slice(3) : refreshToken;
    if (!this.tokens.has(original)) throw new Error("Invalid refresh token");
    return {
      access_token: original,
      refresh_token: `rt_${original}`,
      token_type: "Bearer",
      expires_in: 3600,
    };
  }

  async verifyAccessToken(token) {
    const entry = this.tokens.get(token);
    if (!entry) throw new Error("Invalid token");
    return {
      token,
      clientId: entry.clientId,
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

// Request logging
app.use((req, res, next) => {
  const url = req.originalUrl || req.url;
  const auth = req.headers.authorization;
  console.log(`[Stub] >>> ${req.method} ${url}${auth ? ` Auth: ${auth.substring(0, 30)}...` : ""}`);
  res.on("finish", () => {
    console.log(`[Stub] <<< ${req.method} ${url} → ${res.statusCode}`);
  });
  next();
});

app.use(express.json());

// ─── OAuth ──────────────────────────────────────────────────────────
const baseUrl = process.env.ATEAM_BASE_URL || "https://mcp.ateam-ai.com";
const serverUrl = new URL(baseUrl);
const provider = new StubOAuthProvider();

// Mount OAuth router with resourceServerUrl = root (connector URL is root)
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: serverUrl,
    baseUrl: serverUrl,
    resourceServerUrl: serverUrl,
  })
);

// Also serve PRM at /.well-known/oauth-protected-resource/mcp for clients
// that use /mcp as the connector URL (RFC 9728 path-based discovery)
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: new URL("/mcp", baseUrl).href,
    authorization_servers: [serverUrl.href],
  });
});

const bearerMiddleware = requireBearerAuth({
  verifier: provider,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
});

// ─── Token auto-injection ───────────────────────────────────────────
// Claude.ai's proxy drops the Bearer token (known bug: anthropics/claude-ai-mcp#35).
const recentTokens = new Map();
const TOKEN_TTL = 5 * 60 * 1000;

const origExchange = provider.exchangeAuthorizationCode.bind(provider);
provider.exchangeAuthorizationCode = async function (...args) {
  const result = await origExchange(...args);
  if (result.access_token) {
    recentTokens.set(result.access_token, { token: result.access_token, createdAt: Date.now() });
    console.log(`[Stub] Cached token for auto-injection (${recentTokens.size} active)`);
    for (const [k, v] of recentTokens) {
      if (Date.now() - v.createdAt > TOKEN_TTL) recentTokens.delete(k);
    }
  }
  return result;
};

function getNewestToken() {
  let newest = null;
  for (const [, entry] of recentTokens) {
    if (Date.now() - entry.createdAt > TOKEN_TTL) continue;
    if (!newest || entry.createdAt > newest.createdAt) newest = entry;
  }
  return newest?.token || null;
}

const autoInjectToken = (req, _res, next) => {
  if (req.headers.authorization) return next();
  const token = getNewestToken();
  if (token) {
    req.headers.authorization = `Bearer ${token}`;
    const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "authorization");
    if (idx !== -1) {
      req.rawHeaders[idx + 1] = `Bearer ${token}`;
    } else {
      req.rawHeaders.push("Authorization", `Bearer ${token}`);
    }
    console.log(`[Stub] Auto-injected token into ${req.method} ${req.originalUrl || req.url}`);
  }
  next();
};

// ─── Accept header fix + CORS for MCP paths ─────────────────────────
for (const path of MCP_PATHS) {
  // Fix Accept header (Claude.ai may not send text/event-stream)
  app.use(path, (req, _res, next) => {
    const accept = req.headers.accept || "";
    if (req.method === "POST" && !accept.includes("text/event-stream")) {
      const fixed = "application/json, text/event-stream";
      req.headers.accept = fixed;
      const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = fixed;
      } else {
        req.rawHeaders.push("Accept", fixed);
      }
    }
    next();
  });

  // CORS
  app.use(path, (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, authorization");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
}

// ─── MCP handlers at both "/" and "/mcp" ────────────────────────────
const transports = {};

const mcpPost = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      const server = new McpServer({ name: "stub-server", version: "1.0.0" });
      server.tool("echo", "Echo a message back", { message: z.string() }, async ({ message }) => ({
        content: [{ type: "text", text: `Echo: ${message}` }],
      }));
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Bad request" }, id: null });
  } catch (err) {
    console.error("[Stub] MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
};

const mcpGet = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.json({ ok: true, service: "stub-mcp" });
  }
};

const mcpDelete = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
};

// Mount at both "/" and "/mcp"
for (const path of MCP_PATHS) {
  app.post(path, autoInjectToken, bearerMiddleware, mcpPost);
  app.get(path, autoInjectToken, bearerMiddleware, mcpGet);
  app.delete(path, autoInjectToken, bearerMiddleware, mcpDelete);
}

// ─── Health ─────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "stub-mcp" });
});

// ─── Start ──────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || "3100", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`Stub MCP server on port ${port}`);
  console.log(`  MCP: http://localhost:${port}/ and /mcp`);
  console.log(`  OAuth: ${baseUrl}`);
});
