/**
 * Streamable HTTP transport for ateam-mcp.
 * Enables ChatGPT and remote MCP clients to connect via HTTPS.
 *
 * OAuth2 (enabled by default):
 *   Serves /.well-known/*, /authorize, /token, /register endpoints.
 *   /mcp routes require a Bearer token — triggers OAuth discovery in Claude.ai.
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

export function startHttpServer(port = 3100) {
  const app = express();
  app.set("trust proxy", 1); // behind Cloudflare tunnel
  app.use(express.json());

  // ─── Request logging ─────────────────────────────────────────────
  app.use((req, res, next) => {
    const skip = req.path === "/" || req.path === "/health";
    if (!skip) {
      const start = Date.now();
      if (req.path === "/mcp") {
        console.log(`[HTTP] ${req.method} ${req.path} Accept: ${req.headers.accept || "(none)"}`);
      }
      res.on("finish", () => {
        console.log(`[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
      });
    }
    next();
  });

  // ─── Fix Accept header for MCP endpoint ─────────────────────────
  // Claude.ai may not send the required Accept header with text/event-stream.
  // The MCP SDK requires it per spec, so we inject it if missing.
  // Must patch both parsed headers AND rawHeaders since @hono/node-server
  // reads from rawHeaders when converting to Web Standard Request.
  app.use("/mcp", (req, _res, next) => {
    const accept = req.headers.accept || "";
    if (req.method === "POST" && !accept.includes("text/event-stream")) {
      const fixed = "application/json, text/event-stream";
      req.headers.accept = fixed;
      // Patch rawHeaders array (alternating key/value pairs)
      const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = fixed;
      } else {
        req.rawHeaders.push("Accept", fixed);
      }
    }
    next();
  });

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

  // Middleware array for /mcp routes — empty when OAuth is disabled
  const mcpAuth = bearerMiddleware ? [bearerMiddleware] : [];

  // ─── CORS — required for ChatGPT connector ────────────────────
  app.use("/mcp", (req, res, next) => {
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

  // ─── Root health check (ChatGPT connector validation) ─────────
  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "ateam-mcp", transport: "http" });
  });

  // ─── Health check ─────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ateam-mcp", transport: "http" });
  });

  // ─── Get API Key — redirect to Skill Builder with auto-open ──
  app.get("/get-api-key", (_req, res) => {
    res.redirect("https://app.ateam-ai.com/builder/?show=api-key");
  });

  // ─── MCP POST — handle tool calls + initialize ───────────────
  app.post("/mcp", ...mcpAuth, async (req, res) => {
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
  });

  // ─── MCP GET — SSE stream for notifications ──────────────────
  app.get("/mcp", ...mcpAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // ─── MCP DELETE — session termination ────────────────────────
  app.delete("/mcp", ...mcpAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // ─── Start ────────────────────────────────────────────────────
  app.listen(port, "0.0.0.0", () => {
    console.log(`ateam-mcp HTTP server listening on port ${port}`);
    console.log(`  MCP endpoint: http://localhost:${port}/mcp`);
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
