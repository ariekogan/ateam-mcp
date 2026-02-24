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
 * Token Auto-Injection (workaround for Claude.ai):
 *   Claude.ai uses two separate clients: a Python backend for OAuth and a
 *   Node.js client for MCP. The Node.js client never receives the Bearer
 *   token from the Python OAuth handler. As a workaround:
 *   1. Initial unauthenticated requests pass through → get 401 → trigger OAuth
 *   2. Once OAuth is detected (client registration), hold subsequent requests
 *   3. After token exchange, inject the token into held requests
 *   Tokens are cached for 5 minutes to serve future connections.
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

// Recently exchanged tokens — workaround for Claude.ai's split-client bug
// Key: token string, Value: { token, expiresAt }
const recentTokens = new Map();
const TOKEN_WINDOW = 5 * 60 * 1000; // 5 minutes

// Tracks whether an OAuth flow is currently in progress.
// When true, unauthenticated MCP requests are held (instead of getting 401)
// until the token arrives from the parallel OAuth flow.
let oauthInProgress = false;

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
  let oauthProvider = null;
  if (!oauthDisabled) {
    // ─── Track OAuth flow start ──────────────────────────────────
    // Detect when Claude.ai starts OAuth (client registration or authorization).
    // Must be mounted BEFORE mcpAuthRouter so our middleware runs first.
    for (const oauthPath of ["/register", "/authorize"]) {
      app.use(oauthPath, (req, _res, next) => {
        if (!oauthInProgress) {
          oauthInProgress = true;
          console.log(`[Auth] OAuth flow detected (${req.method} ${oauthPath})`);
        }
        next();
      });
    }

    const oauth = mountOAuth(app, baseUrl);
    bearerMiddleware = oauth.bearerMiddleware;
    oauthProvider = oauth.provider;

    // ─── Token capture: store recently exchanged tokens ────────────
    // Intercept token responses to capture access_tokens for auto-injection.
    const origExchange = oauthProvider.exchangeAuthorizationCode.bind(oauthProvider);
    oauthProvider.exchangeAuthorizationCode = async function (...args) {
      const result = await origExchange(...args);
      if (result.access_token) {
        recentTokens.set(result.access_token, {
          token: result.access_token,
          expiresAt: Date.now() + TOKEN_WINDOW,
        });
        oauthInProgress = false; // OAuth completed — stop holding requests
        console.log(`[Auth] Stored token for auto-injection (${recentTokens.size} active)`);
        // Cleanup expired tokens
        for (const [key, val] of recentTokens) {
          if (val.expiresAt < Date.now()) recentTokens.delete(key);
        }
      }
      return result;
    };

    console.log(`  OAuth: enabled (issuer: ${baseUrl})`);
  } else {
    console.log("  OAuth: disabled (ATEAM_OAUTH_DISABLED=1)");
  }

  // ─── Token auto-injection middleware ────────────────────────────
  // Workaround for Claude.ai's split-client architecture:
  //   - Python httpx client handles OAuth → gets token
  //   - Node.js client makes MCP requests → never gets the token
  //
  // Phased approach (avoids deadlock):
  //   Phase 1: No token, no OAuth → pass through → bearer returns 401 → triggers OAuth
  //   Phase 2: No token, OAuth in progress → HOLD request, poll every 2s
  //   Phase 3: Token arrives → inject into held request → bearer validates → success
  const autoInjectToken = (req, _res, next) => {
    if (req.headers.authorization) return next();

    // If we already have a token, inject immediately (any method: POST, GET, DELETE)
    const immediate = getNewestToken();
    if (immediate) {
      injectTokenIntoReq(req, immediate);
      return next();
    }

    // Only hold POST requests during active OAuth flow.
    // GET/DELETE pass through immediately (bearer returns 401).
    if (req.method !== "POST" || !oauthInProgress) {
      return next();
    }

    // OAuth IS in progress — hold this POST request and wait for the token
    console.log(`[Auth] Holding ${req.method} ${req.originalUrl || req.url} — OAuth in progress, waiting for token...`);
    let resolved = false;

    const timer = setInterval(() => {
      if (resolved) return;
      const token = getNewestToken();
      if (token) {
        resolved = true;
        clearInterval(timer);
        clearTimeout(timeout);
        injectTokenIntoReq(req, token);
        console.log(`[Auth] Token arrived! Injecting into held request`);
        next();
      }
    }, 2000);

    // Timeout after 120 seconds → let bearerMiddleware return 401
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      oauthInProgress = false;
      console.log(`[Auth] Token wait timed out after 120s — giving up`);
      next();
    }, 120_000);

    // Cancel if client disconnects
    req.on("close", () => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      clearTimeout(timeout);
      console.log(`[Auth] Client disconnected while waiting for token`);
    });
  };

  function getNewestToken() {
    let newest = null;
    for (const [, entry] of recentTokens) {
      if (entry.expiresAt > Date.now()) {
        if (!newest || entry.expiresAt > newest.expiresAt) newest = entry;
      }
    }
    return newest?.token || null;
  }

  function injectTokenIntoReq(req, token) {
    req.headers.authorization = `Bearer ${token}`;
    const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "authorization");
    if (idx !== -1) {
      req.rawHeaders[idx + 1] = `Bearer ${token}`;
    } else {
      req.rawHeaders.push("Authorization", `Bearer ${token}`);
    }
    console.log(`[Auth] Injected Bearer token into ${req.method} ${req.originalUrl || req.url}`);
  }

  // Build middleware chain: auto-inject → bearer validate (if OAuth enabled)
  const mcpAuth = bearerMiddleware
    ? [autoInjectToken, bearerMiddleware]
    : [];

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
