/**
 * Minimal MCP OAuth stub — follows the official example-remote-server pattern exactly.
 * Used to test if Claude.ai OAuth works with our infrastructure (Cloudflare tunnel).
 *
 * Differences from our main server:
 *   - MCP only at /mcp (NOT at /)
 *   - Minimal PRM (no extra fields)
 *   - Simple echo tool only
 *   - No auto-injection, no Accept fix, no extra middleware
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

// ─── Minimal OAuth Provider (matches official example pattern) ──────

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
    this.pending = new Map();
  }

  get clientsStore() {
    return this._clientsStore;
  }

  async authorize(client, params, res) {
    // Auto-approve: generate code immediately, redirect back
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

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: serverUrl,
    baseUrl: serverUrl,
    resourceServerUrl: serverUrl,
  })
);

const bearerMiddleware = requireBearerAuth({
  verifier: provider,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
});

// ─── CORS for /mcp ─────────────────────────────────────────────────
app.use("/mcp", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ─── MCP at /mcp only ──────────────────────────────────────────────
const transports = {};

app.post("/mcp", bearerMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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
});

app.get("/mcp", bearerMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

app.delete("/mcp", bearerMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

// ─── Health ─────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "stub-mcp" });
});

// ─── Start ──────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || "3100", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`Stub MCP server on port ${port}`);
  console.log(`  MCP: http://localhost:${port}/mcp`);
  console.log(`  OAuth: ${baseUrl}`);
});
