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
import {
  clearSession, setSessionCredentials, parseApiKey,
  startSessionSweeper, getSessionStats, sweepStaleSessions,
  bindSessionBearer, getAuthOverride, getSessionBearer, bearerOwnershipOk,
} from "./api.js";
import { mountOAuth } from "./oauth.js";
import { connectGithubPage } from "./pages.js";

// Read once at import: the version of the code in THIS process, and when it
// started. See the /health handler for why both matter.
const PKG_VERSION = await (async () => {
  try {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    // Never let a liveness probe fail over its own labelling.
    return "unknown";
  }
})();
const STARTED_AT = new Date().toISOString();

// Active sessions
const transports = {};

// MCP paths — Claude.ai uses "/" (connector URL), others may use "/mcp"
const MCP_PATHS = ["/", "/mcp"];

// Recently exchanged OAuth tokens — for auto-injection into MCP requests that
// follow the /token exchange within the same user's OAuth→MCP handshake window.
//
// ⚠️ SECURITY: This cache is scoped by CLIENT IP. A previous version keyed by
// token value and used `getNewestToken()` for injection — in multi-user HTTP
// mode (e.g., mcp.ateam-ai.com), that caused cross-user auth bypass: if User A
// completed OAuth and then User B sent an unauth'd MCP request, User B was
// injected with User A's token. IP-scoping prevents that: injection only
// happens for the same client IP that completed the token exchange.
//
// Key: client IP string, Value: { token, createdAt }
const recentTokensByIp = new Map();
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes — OAuth→MCP handshake window only

export function startHttpServer(port = 3100) {
  const app = express();
  app.set("trust proxy", 1); // behind Cloudflare tunnel

  // ─── Request logging ────────────────────────────────────────────
  app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    const start = Date.now();
    const auth = req.headers.authorization;
    console.log(`[HTTP] >>> ${req.method} ${url}${auth ? " Auth: [Bearer ...]" : ""}${MCP_PATHS.includes(url.split("?")[0]) ? ` Accept: ${req.headers.accept || "(none)"}` : ""}`);
    res.on("finish", () => {
      console.log(`[HTTP] <<< ${req.method} ${url} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.use(express.json());

  // ─── Fix Accept header for MCP endpoints ──────────────────────────
  // The MCP SDK requires Accept to include BOTH application/json and
  // text/event-stream. Different clients send different combinations:
  //   - Claude.ai web: may omit text/event-stream
  //   - Claude.ai mobile: may send only text/event-stream
  //   - ChatGPT: may send only application/json
  // We normalize to always include both to satisfy the SDK.
  // Must patch both parsed headers AND rawHeaders since @hono/node-server
  // reads from rawHeaders when converting to Web Standard Request.
  for (const path of MCP_PATHS) {
    app.use(path, (req, _res, next) => {
      if (req.method === "POST") {
        const accept = req.headers.accept || "";
        const needsFix = !accept.includes("text/event-stream") || !accept.includes("application/json");
        if (needsFix) {
          const fixed = "application/json, text/event-stream";
          req.headers.accept = fixed;
          const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
          if (idx !== -1) {
            req.rawHeaders[idx + 1] = fixed;
          } else {
            req.rawHeaders.push("Accept", fixed);
          }
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
          // IP-scoped cache: only the same client IP can consume this token
          // via auto-injection. Prevents cross-user token leakage in shared HTTP mode.
          const ip = req.ip || "unknown";
          recentTokensByIp.set(ip, {
            token: data.access_token,
            createdAt: Date.now(),
          });
          console.log(`[Auth] Cached OAuth token for ip=${ip} (${recentTokensByIp.size} active IPs)`);
          // Prune expired
          for (const [k, v] of recentTokensByIp) {
            if (Date.now() - v.createdAt > TOKEN_TTL) recentTokensByIp.delete(k);
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
  // If a request has no Authorization header, check if THIS CLIENT IP recently
  // completed /token exchange. If so, inject that IP's cached token. Prevents
  // cross-user token leakage (fix for mcp-audit finding #1, round 009).
  const autoInjectToken = (req, _res, next) => {
    if (req.headers.authorization) return next();
    const ip = req.ip || "unknown";
    const entry = recentTokensByIp.get(ip);
    if (!entry) return next();
    if (Date.now() - entry.createdAt > TOKEN_TTL) {
      recentTokensByIp.delete(ip);
      return next();
    }
    const token = entry.token;
    req.headers.authorization = `Bearer ${token}`;
    const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "authorization");
    if (idx !== -1) {
      req.rawHeaders[idx + 1] = `Bearer ${token}`;
    } else {
      req.rawHeaders.push("Authorization", `Bearer ${token}`);
    }
    console.log(`[Auth] Auto-injected IP-scoped token for ip=${ip} into ${req.method} ${req.originalUrl || req.url}`);
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
  // Origin allowlist (round 014 security hardening).
  // ATEAM_CORS_ALLOWED_ORIGINS env = comma-separated list, or "*" / unset for
  // wildcard (default — preserves compat with third-party MCP clients).
  // When set, Origin must match exactly; otherwise no ACAO header is sent.
  const CORS_ALLOWED_LIST = String(process.env.ATEAM_CORS_ALLOWED_ORIGINS || "*")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const CORS_ALLOW_ANY = CORS_ALLOWED_LIST.includes("*");
  function resolveOrigin(req) {
    const o = req.headers?.origin;
    if (CORS_ALLOW_ANY) return o || "*";
    if (o && CORS_ALLOWED_LIST.includes(o)) return o;
    return null;
  }
  for (const path of MCP_PATHS) {
    app.use(path, (req, res, next) => {
      const origin = resolveOrigin(req);
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      if (!CORS_ALLOW_ANY) res.setHeader("Vary", "Origin");
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
  //
  // version + startedAt are the whole point of this probe, not decoration.
  //
  // Without them every field here was TRUE while the agent served seven-day-old
  // code: ok, service, transport and sessions all reported correctly, and not
  // one of them could reveal that the process had been running since Aug 15
  // across ~10 publishes. A liveness probe that cannot answer "is this the code
  // I shipped?" is the truthful-but-useless shape — and a stale server that
  // ANSWERS is worse than one that is down, because its errors describe bugs
  // that were already fixed. (2026-08-22: it returned a 401 from a code path
  // deleted in 2ff2a34, and a session went debugging a system that was correct.)
  //
  // version comes from the package.json NEXT TO THIS FILE, read at import, so it
  // describes the code actually loaded — not what npm has, and not what a
  // container was built with.
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ateam-mcp",
      version: PKG_VERSION,
      startedAt: STARTED_AT,
      uptime_s: Math.round(process.uptime()),
      transport: "http",
      sessions: getSessionStats(),
    });
  });

  // ─── Get API Key — redirect to the main web app's Tenant Admin →
  //     Tokens & Keys (the key now lives in the main UI, not the builder). ──
  app.get("/get-api-key", (_req, res) => {
    res.redirect("https://app.ateam-ai.com/?admin=tokens");
  });

  // ─── Connect GitHub — user-facing guide an agent links to on
  //     github_not_connected (see formatError in api.js). ──
  app.get("/connect-github", (_req, res) => {
    res.type("html").send(connectGithubPage());
  });

  // ─── MCP POST — handle tool calls + initialize ───────────────
  // Mounted at both "/" and "/mcp" for Claude.ai compatibility
  // SECURITY (multi-client isolation): a session-id is client-supplied and
  // non-secret (logged + echoed in the mcp-session-id response header). If a
  // session was authenticated with a Bearer, ONLY a request presenting that SAME
  // validated Bearer may reuse it — for POST (tool calls), GET (SSE stream) and
  // DELETE (terminate). Without this, a client could send another client's
  // session-id on the optional-auth /mcp path with no/other Authorization and be
  // served that client's tenant + api key (or read its stream / kill its
  // session). A session with no bound bearer (the no-bearer ateam_auth flow) has
  // nothing to match against, so this is a no-op there.
  const denySessionReuse = (req, res, sessionId) => {
    if (sessionId && !bearerOwnershipOk(getSessionBearer(sessionId), req.auth?.token)) {
      console.warn(`[Auth] DENY session reuse: bearer mismatch for session ${sessionId} (presented=${req.auth?.token ? "other-bearer" : "none"})`);
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: this session belongs to a different credential. Re-initialize with your own Authorization." },
        id: req.body?.id ?? null,
      });
      return true;
    }
    return false;
  };

  const mcpPost = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (denySessionReuse(req, res, sessionId)) return;

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing session — seed credentials if Bearer token present
        transport = transports[sessionId];
        seedCredentials(req, sessionId);
      } else if (isInitializeRequest(req.body) || (sessionId && !transports[sessionId])) {
        // New session, OR stale session with any request type (server restart recovery).
        // Many MCP clients (Claude mobile, Claude Code) cache the session ID and fail to
        // re-initialize on 400. To survive container restarts transparently, we synthesize
        // a fresh initialize under the hood whenever we see a stale session.
        const isStaleRecovery = sessionId && !transports[sessionId] && !isInitializeRequest(req.body);
        if (sessionId && isInitializeRequest(req.body)) {
          console.log(`[HTTP] Stale session ${sessionId} — client re-initialized`);
        } else if (isStaleRecovery) {
          console.log(`[HTTP] Stale session ${sessionId} — auto-reinitializing transparently (${req.body?.method || "unknown"})`);
        }

        // Reuse the client's existing session id instead of rotating to a fresh
        // one. Many MCP clients (Claude Code, desktop) cache their session id and
        // keep resending it, ignoring a rotated id we hand back. If we minted a
        // new id here, every subsequent call would look stale again → another new
        // id → the id set by ateam_auth is abandoned by the next call → the agent
        // must re-auth "every few calls" (OPEN-6). Reusing the incoming id keeps
        // it stable, so credentials set under it survive across recovery. Only
        // mint a fresh id for a truly new client that has none yet.
        const newSessionId = sessionId || randomUUID();

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

        if (isStaleRecovery) {
          // Force the underlying web-standard transport into "initialized" state without
          // requiring a real initialize handshake. This bypasses the SDK's built-in check
          // (`Bad Request: Server not initialized`) so the non-initialize request dispatches.
          const inner = transport._webStandardTransport;
          if (inner) {
            inner.sessionId = newSessionId;
            inner._initialized = true;
            // Neutralize session-id validation for this transport — the client's header
            // still carries the stale id and the SDK would otherwise 404. We trust that
            // we already looked up the transport ourselves.
            inner.validateSession = () => undefined;
            // Also accept any protocol version the client sends.
            inner.validateProtocolVersion = () => undefined;
          }
          transports[newSessionId] = transport;
          // Rewrite the request's session-id header so downstream code also sees the new id.
          req.headers["mcp-session-id"] = newSessionId;
          // Tell the client about the new session id so future requests use it.
          res.setHeader("mcp-session-id", newSessionId);
          await transport.handleRequest(req, res, req.body);
          return;
        }

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
    if (denySessionReuse(req, res, sessionId)) return;
    await transports[sessionId].handleRequest(req, res);
  };

  // ─── MCP DELETE — session termination ────────────────────────
  const mcpDelete = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    if (denySessionReuse(req, res, sessionId)) return;
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

  // Start periodic session cleanup (sweeps stale sessions every 5 min)
  startSessionSweeper();

  // Graceful shutdown — close all transports and clear sessions
  process.on("SIGINT", async () => {
    console.log(`[HTTP] Shutting down — closing ${Object.keys(transports).length} transport(s)...`);
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

// getNewestToken() removed — replaced by IP-scoped lookup in autoInjectToken.
// Global "newest token" injection caused cross-user auth bypass in multi-user
// HTTP deployments. IP scoping restores the intended semantics (same browser
// that completed OAuth gets its token injected on the follow-up MCP request).

/**
 * Seed session credentials from the OAuth bearer token.
 *
 * The bearer IS the user's API key (set during OAuth authorization).
 * If the user previously called ateam_auth to override (e.g., switch tenants),
 * that override is stored per bearer and takes priority here.
 */
function seedCredentials(req, sessionId) {
  const token = req.auth?.token;
  if (!token) return;

  // Track bearer → session (persistent actor identity)
  bindSessionBearer(sessionId, token);

  // Check for ateam_auth override for this bearer
  const override = getAuthOverride(token);
  if (override) {
    setSessionCredentials(sessionId, { ...override, explicit: true });
    return;
  }

  // Default: use the bearer token itself as credentials.
  // `explicit: true` — a Bearer is a per-connection credential the user
  // deliberately configured (OAuth authorize page, or the plugin's userConfig
  // key injected as `Authorization: Bearer`). Unlike an ambient ADAS_API_KEY
  // env var baked into shared MCP config, it carries explicit tenant intent, so
  // it satisfies isExplicitlyAuthenticated and tenant tools work without a
  // redundant ateam_auth call. (The env-var guard in tools.js is unaffected —
  // env creds never flow through here; this path only fires for a real Bearer.)
  const parsed = parseApiKey(token);
  if (parsed.isValid) {
    setSessionCredentials(sessionId, { tenant: parsed.tenant, apiKey: token, explicit: true });
  }
}
