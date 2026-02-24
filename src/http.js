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
    const oauth = mountOAuth(app, baseUrl);
    bearerMiddleware = oauth.bearerMiddleware;
    console.log(`  OAuth: enabled (issuer: ${baseUrl})`);
  } else {
    console.log("  OAuth: disabled (ATEAM_OAUTH_DISABLED=1)");
  }

  // Bearer auth middleware for MCP routes (if OAuth enabled)
  const mcpAuth = bearerMiddleware ? [bearerMiddleware] : [];

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
  for (const path of MCP_PATHS) {
    app.post(path, ...mcpAuth, mcpPost);
    app.get(path, ...mcpAuth, mcpGet);
    app.delete(path, ...mcpAuth, mcpDelete);
  }

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
