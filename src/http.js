/**
 * Streamable HTTP transport for ateam-mcp.
 * Enables ChatGPT and remote MCP clients to connect via HTTPS.
 *
 * MCP endpoint is served at BOTH "/" and "/mcp" because:
 *   - Claude.ai sends requests to the connector URL (root "/")
 *   - Claude Code and other clients may use "/mcp"
 *
 * OAuth2 (enabled by default):
 *   Serves /.well-known/*, /authorize, /token, /register endpoints.
 *   MCP routes require a Bearer token — triggers OAuth discovery in Claude.ai.
 *   Set ATEAM_OAUTH_DISABLED=1 to bypass (for ChatGPT or legacy clients).
 *
 * Token Auto-Injection:
 *   Claude.ai's OAuth client and MCP client don't share Bearer tokens.
 *   After a successful token exchange, we cache the token server-side and
 *   inject it into subsequent unauthenticated MCP requests. This is a
 *   simple cache lookup — no request holding, no polling, no flags.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "./server.js";
import { clearSession, setSessionCredentials, parseApiKey } from "./api.js";
import { mountOAuth } from "./oauth.js";

// Active sessions
const transports = {};

// MCP paths — Claude.ai uses "/" (connector URL), others may use "/mcp"
const MCP_PATHS = ["/", "/mcp"];

// Recently exchanged tokens — for auto-injection into MCP requests.
// Key: token string, Value: { token, createdAt }
const recentTokens = new Map();
const TOKEN_TTL = 60 * 60 * 1000; // 60 minutes

export function startHttpServer(port = 3100) {
  const app = express();
  app.set("trust proxy", 1); // behind Cloudflare tunnel

  // ─── Request logging ────────────────────────────────────────────
  app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    const start = Date.now();
    const auth = req.headers.authorization;
    console.log(`[HTTP] >>> ${req.method} ${url}${auth ? ` Auth: ${auth.substring(0, 30)}...` : ""}${MCP_PATHS.includes(url.split("?")[0]) ? ` Accept: ${req.headers.accept || "(none)"}` : ""}`);
    res.on("finish", () => {
      console.log(`[HTTP] <<< ${req.method} ${url} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.use(express.json());

  // ─── Fix Accept header for MCP endpoints ──────────────────────────
  // Claude.ai may not send the required Accept header with text/event-stream.
  // The MCP SDK requires it per spec, so we inject it if missing.
  // Must patch both parsed headers AND rawHeaders since @hono/node-server
  // reads from rawHeaders when converting to Web Standard Request.
  for (const path of MCP_PATHS) {
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
  }

  // ─── OAuth setup ────────────────────────────────────────────────
  const oauthDisabled = process.env.ATEAM_OAUTH_DISABLED === "1";
  const baseUrl = process.env.ATEAM_BASE_URL || "https://mcp.ateam-ai.com";

  let bearerMiddleware = null;
  if (!oauthDisabled) {
    // ─── Token capture middleware — MUST be BEFORE mcpAuthRouter ───
    // Intercepts POST /token responses to cache access_tokens for
    // auto-injection. Placed before mountOAuth so it can monkey-patch
    // res.json() before the SDK's token handler sends the response.
    app.use("/token", (req, res, next) => {
      if (req.method !== "POST") return next();
      const origJson = res.json.bind(res);
      res.json = (data) => {
        if (data && data.access_token && res.statusCode >= 200 && res.statusCode < 300) {
          recentTokens.set(data.access_token, {
            token: data.access_token,
            createdAt: Date.now(),
          });
          console.log(`[Auth] Cached token from /token response (${recentTokens.size} active)`);
          // Prune expired
          for (const [k, v] of recentTokens) {
            if (Date.now() - v.createdAt > TOKEN_TTL) recentTokens.delete(k);
          }
        }
        return origJson(data);
      };
      next();
    });

    const oauth = mountOAuth(app, baseUrl);
    bearerMiddleware = oauth.bearerMiddleware;

    console.log(`  OAuth: enabled (issuer: ${baseUrl})`);
  } else {
    console.log("  OAuth: disabled (ATEAM_OAUTH_DISABLED=1)");
  }

  // ─── Token auto-injection middleware ────────────────────────────
  // If a request has no Authorization header but we have a recently
  // exchanged token, inject it. Simple cache lookup — never blocks.
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
      console.log(`[Auth] Auto-injected token into ${req.method} ${req.originalUrl || req.url}`);
    }
    next();
  };

  // Bearer auth middleware chains for MCP routes:
  // - "/" (Claude.ai): strict OAuth — Bearer token required
  // - "/mcp" (ChatGPT): optional OAuth — validate Bearer if present, pass through if not
  const mcpAuthStrict = bearerMiddleware
    ? [autoInjectToken, bearerMiddleware]
    : [];

  // Optional auth: if Bearer token present, validate it (sets req.auth for seedCredentials).
  // If no token, let the request through — user can authenticate via ateam_auth tool.
  const optionalBearerAuth = bearerMiddleware
    ? (req, res, next) => {
        if (!req.headers.authorization) return next();
        bearerMiddleware(req, res, next);
      }
    : (_req, _res, next) => next();

  const mcpAuthOptional = [autoInjectToken, optionalBearerAuth];

  // ─── CORS — required for browser-based MCP clients ──────────────
  for (const path of MCP_PATHS) {
    app.use(path, (req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, authorization");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  // ─── Health check ─────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ateam-mcp", transport: "http" });
  });

  // ─── Get API Key — redirect to Skill Builder with auto-open ──
  app.get("/get-api-key", (_req, res) => {
    res.redirect("https://app.ateam-ai.com/builder/?show=api-key");
  });

  // ─── MCP POST — handle tool calls + initialize ───────────────
  // Mounted at both "/" and "/mcp" for Claude.ai compatibility
  const mcpPost = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing session — seed credentials if Bearer token present
        transport = transports[sessionId];
        seedCredentials(req, sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session — generate ID upfront so we can bind it to the server
        const newSessionId = randomUUID();

        // Seed credentials from OAuth Bearer token before server starts
        seedCredentials(req, newSessionId);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            clearSession(sid); // drop per-session credentials
          }
        };

        const server = createServer(newSessionId);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  // ─── MCP GET — SSE stream for notifications ──────────────────
  const mcpGet = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      // No session: return health-check JSON (for ChatGPT connector validation)
      res.json({ ok: true, service: "ateam-mcp", transport: "http" });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  // ─── MCP DELETE — session termination ────────────────────────
  const mcpDelete = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  // Mount MCP handlers at both "/" and "/mcp"
  // "/" (Claude.ai): strict OAuth — requires Bearer token
  // "/mcp" (ChatGPT): optional auth — accepts OAuth OR ateam_auth tool
  for (const path of MCP_PATHS) {
    const auth = path === "/" ? mcpAuthStrict : mcpAuthOptional;
    app.post(path, ...auth, mcpPost);
    app.get(path, ...auth, mcpGet);
    app.delete(path, ...auth, mcpDelete);
  }

  // ─── Catch-all: log unhandled requests ──────────────────────────
  app.use((req, res, next) => {
    console.log(`[HTTP] UNMATCHED: ${req.method} ${req.originalUrl || req.url}`);
    if (!res.headersSent) res.status(404).json({ error: "Not found" });
  });

  // ─── Error handler ──────────────────────────────────────────────
  app.use((err, req, res, next) => {
    console.error(`[HTTP] ERROR in ${req.method} ${req.originalUrl}:`, err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── Start ────────────────────────────────────────────────────
  app.listen(port, "0.0.0.0", () => {
    console.log(`ateam-mcp HTTP server listening on port ${port}`);
    console.log(`  MCP endpoint: http://localhost:${port}/mcp (also at /)`);
    console.log(`  Health check: http://localhost:${port}/health`);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
      } catch {}
      delete transports[sid];
      clearSession(sid);
    }
    process.exit(0);
  });
}

/** Returns the most recently issued non-expired token, or null. */
function getNewestToken() {
  let newest = null;
  for (const [, entry] of recentTokens) {
    if (Date.now() - entry.createdAt > TOKEN_TTL) continue;
    if (!newest || entry.createdAt > newest.createdAt) newest = entry;
  }
  return newest?.token || null;
}

/**
 * If the request has a validated Bearer token (set by requireBearerAuth),
 * auto-seed session credentials so the user doesn't need to call ateam_auth.
 */
function seedCredentials(req, sessionId) {
  const token = req.auth?.token;
  if (!token) return;

  const parsed = parseApiKey(token);
  if (parsed.isValid) {
    setSessionCredentials(sessionId, { tenant: parsed.tenant, apiKey: token });
  }
}
