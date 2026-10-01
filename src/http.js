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
 *   MCP routes on BOTH paths require a Bearer token; a request without one gets
 *   a 401 challenge, which is how an OAuth client learns to send its token.
 *   ATEAM_OAUTH_DISABLED=1 removes the gate entirely. It is an escape hatch, not
 *   a client mode: with no validated bearer there is nothing to bind a session
 *   to, so anyone holding a session id can reuse that session (see
 *   denySessionReuse).
 *
 * Platform sign-in (`x-adas-token`):
 *   The one other way in, for the platform's own proxy (ai-dev-assistant's
 *   ateam-proxy-mcp). Checked BEFORE the bearer gate; see platformGate. Off
 *   unless CORE_MCP_SECRET is set.
 *
 * No token is ever supplied by the server: a request carries its own bearer or
 * gets the 401 challenge. (There was a per-IP token auto-injection until
 * BUILDER-SEC-SIGNIN-P0; see the note above mcpAuthFor.)
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "./server.js";
import { MCP_VERSION } from "./tools.js";
import {
  clearSession, setSessionCredentials, parseApiKey, whoami, baseUrlForKeyEnv, getCredentials,
  startSessionSweeper, getSessionStats, sweepStaleSessions,
  bindSessionBearer, bindSessionPlatform, getAuthOverride, getSessionOwner, sessionOwnershipOk,
  presentsPlatformSecret, PLATFORM_PRINCIPAL, getBaseUrl,
} from "./api.js";
import { mountOAuth } from "./oauth.js";
import { connectGithubPage } from "./pages.js";
import { KEY_PAGE_URL } from "./signInSteps.js";

// When THIS process started. The version beside it on /health is MCP_VERSION —
// the same value the MCP handshake and ateam_bootstrap report, read once from
// the package.json next to the code (tools.js). This file used to read
// package.json a second time for itself (9d6d10b), a second answer to "which
// build is running?" that nothing kept equal to the first.
const STARTED_AT = new Date().toISOString();

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
    // Never the value: only that a platform token was presented.
    const platform = req.headers["x-adas-token"] !== undefined;
    console.log(`[HTTP] >>> ${req.method} ${url}${platform ? " Auth: [platform]" : ""}${auth ? " Auth: [Bearer ...]" : ""}${MCP_PATHS.includes(url.split("?")[0]) ? ` Accept: ${req.headers.accept || "(none)"}` : ""}`);
    res.on("finish", () => {
      console.log(`[HTTP] <<< ${req.method} ${url} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  // ─── Request bodies ─────────────────────────────────────────────
  // A tool call can carry test attachments (src/testAttachments.js): up to 7 MB
  // of files as base64, about 9.3 MB of JSON. express.json()'s default limit,
  // 100 KB, unchanged since this transport was added (eabb430) and never chosen
  // for it, refused any real image or PDF before the tool ran, so the base64
  // path the hosted server offers could not carry one. An MCP POST is parsed on
  // its own route, AFTER the auth gate, up to 10 MB: Core's own request limit,
  // and what the validator and the Builder behind it accept. Nothing is raised
  // past that, and every other route keeps the default.
  const MCP_BODY_LIMIT = "10mb";
  const isMcpPost = (req) => req.method === "POST" && MCP_PATHS.includes(req.path.replace(/(.)\/+$/, "$1"));
  const defaultJson = express.json();
  app.use((req, res, next) => (isMcpPost(req) ? next() : defaultJson(req, res, next)));
  const mcpJson = express.json({ limit: MCP_BODY_LIMIT });

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

  let bearerMiddlewareFor = null;
  if (!oauthDisabled) {
    const oauth = mountOAuth(app, baseUrl);
    bearerMiddlewareFor = oauth.bearerMiddlewareFor;

    console.log(`  OAuth: enabled (issuer: ${baseUrl})`);
  } else {
    console.log("  OAuth: disabled (ATEAM_OAUTH_DISABLED=1)");
  }

  // Bearer auth middleware for MCP routes — STRICT ON BOTH PATHS.
  //
  // "/mcp" used to be optional-auth (704206e): validate a Bearer if one is
  // present, otherwise let the request through so the caller could authenticate
  // in-band with the ateam_auth tool. That reads as permissive, and it is —
  // but permissiveness is not free, because SILENCE IS AN ANSWER TO A CLIENT.
  //
  // An OAuth client discovers that it must send a token by being REFUSED one
  // that lacks it: 401 plus WWW-Authenticate pointing at the resource metadata
  // (RFC 9728, and what the MCP authorization spec builds on). Answering 200 to
  // an anonymous request tells the client the endpoint is public, so it never
  // attaches the token it is holding.
  //
  // That is exactly what happened to ChatGPT, measured rather than guessed:
  // 107 requests to /mcp, ZERO carrying an Authorization header, while the
  // connector had completed OAuth and held a valid token. Every session was
  // anonymous, so every tenant tool refused, and ChatGPT disabled the connector
  // — a failure that looks like a broken server and is actually a server that
  // never asked. The token was there the whole time.
  //
  // The in-band ateam_auth path is NOT lost: a client authenticated with its
  // bearer may still call ateam_auth with a key it holds outside the chat (a
  // platform proxy, a script); an ACCEPTED key is then kept for that bearer's
  // later sessions (api.js setAuthOverride) until a new sign-in on the A-Team
  // page drops it. A person switches workspace by signing in again on that
  // page, never by giving an agent a key. What is gone is authenticating with
  // nothing at all, which never worked for an OAuth client anyway — it only
  // looked like it did.
  //
  // It was also a security hole, not only a discovery problem. A session opened
  // with no bearer has no owner (denySessionReuse has nothing to compare), so
  // anyone holding its id, which is logged and echoed, could use whatever
  // tenant key ateam_auth had put into it. Do not reopen this gate for a client
  // that still sends no Authorization.
  // test/session-isolation.test.mjs fails if the gate is reopened.
  //
  // THE ONE OTHER WAY IN: PLATFORM SIGN-IN. ai-dev-assistant's ateam-proxy-mcp
  // (the in-product Solution Builder) opens one tenant-less session for the
  // catalog handshake and signs each tenant in with ateam_auth before that
  // tenant's calls. It has no bearer to send, since the handshake belongs to no
  // tenant, so this gate answered it 401 from 2026-09-11 on every host: Core
  // logged "MCP server error: 401 Unauthorized" for "A-Team Builder (proxy)".
  // It sends `x-adas-token`, the platform secret it already presents to Core.
  //
  // platformGate runs FIRST. A request that presents x-adas-token is decided by
  // it alone:
  //   - it matches CORE_MCP_SECRET (constant time; see presentsPlatformSecret)
  //     → the PLATFORM principal. The bearer gate is skipped, and
  //     any Authorization it also sent is ignored: it is never bound or seeded.
  //   - it does not, or CORE_MCP_SECRET is unset → 401. A credential that was
  //     presented and failed is a failure, not "no credential": it does not fall
  //     through to the bearer gate.
  // A request with no x-adas-token is untouched: it meets the bearer gate, and
  // an anonymous one still gets the 401 challenge above.
  //
  // What the platform principal can do is what an anonymous session could do
  // before 39ff024, with an OWNER this time: the global tools and ateam_auth.
  // It carries no tenant and no key (see PLATFORM_PRINCIPAL in src/api.js), and
  // denySessionReuse keeps its sessions and bearer sessions apart both ways.
  const platformGate = (req, res, next) => {
    const presented = req.headers["x-adas-token"];
    if (presented === undefined) return next();
    if (!presentsPlatformSecret(presented)) {
      console.warn(`[Auth] DENY platform sign-in on ${req.method} ${req.originalUrl || req.url}: ${process.env.CORE_MCP_SECRET ? "x-adas-token does not match" : "CORE_MCP_SECRET is unset, so platform sign-in is off here"}`);
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: the x-adas-token presented is not accepted by this server (platform sign-in)." },
        id: req.body?.id ?? null,
      });
      return;
    }
    req.platformPrincipal = true;
    next();
  };
  const unlessPlatform = (mw) => (req, res, next) => (req.platformPrincipal ? next() : mw(req, res, next));
  // ONE rule on both mounts. Only the challenge differs: each names the
  // protected-resource metadata for the URL the client called (see mountOAuth).
  //
  // NO TOKEN INJECTION. Until BUILDER-SEC-SIGNIN-P0 a middleware ran here,
  // BEFORE the bearer gate: it cached every /token response by client IP
  // (recentTokensByIp, 5 min) and put that token into any request from the same
  // IP that arrived without Authorization (autoInjectToken, e23bd3e, IP-scoped
  // in d61465b). Claude.ai and ChatGPT reach this server from SHARED provider
  // egress IPs (prod logged the cache filling from 160.79.106.x), so one
  // person's tenant key could be handed to another person's bearer-less
  // request, and the injection defeated the strict gate below. It was a
  // workaround for Claude.ai dropping the token its OAuth client had just
  // obtained (anthropics/claude-ai-mcp#35; e23bd3e: "the MCP client sends POST
  // /mcp without auth"). Prod logs now show Claude.ai sending its own bearer
  // (POST / answered 200 with the client's bearer, and no "Auto-injected" line),
  // which is why removing it is safe. A request without a bearer gets the 401.
  // test/session-isolation.test.mjs §6 fails if any injection comes back.
  const mcpAuthFor = (path) => [
    platformGate,
    ...(bearerMiddlewareFor ? [unlessPlatform(bearerMiddlewareFor(path))] : []),
  ];

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
      // WWW-Authenticate is not a CORS-safelisted response header. Without it
      // here a browser client gets the 401 but cannot read the challenge that
      // tells it where to authenticate — the discovery pointer this gate exists
      // to send (39ff024) never reached that class of client.
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
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
  // version is MCP_VERSION: the package.json NEXT TO THE CODE, read at import,
  // so it describes the code actually loaded — not what npm has, and not what a
  // container was built with.
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ateam-mcp",
      version: MCP_VERSION,
      startedAt: STARTED_AT,
      uptime_s: Math.round(process.uptime()),
      transport: "http",
      sessions: getSessionStats(),
    });
  });

  // ─── Get API Key — redirect to Core's key page (/connect). ──
  // Added in c61e60b. No text served from this repo links here; the steps link
  // the key page itself (signInSteps.js KEY_PAGE_URL). It redirected to
  // https://app.ateam-ai.com/?admin=tokens, which nothing in the app reads, so
  // it landed on the home page. Kept for links outside this repo (the
  // Builder's docs/PUBLIC_MCP_DOCUMENTATION.md, Core's docs): DEAD once those
  // link KEY_PAGE_URL instead — then delete this route.
  app.get("/get-api-key", (_req, res) => {
    res.redirect(KEY_PAGE_URL);
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
  // DELETE (terminate).
  //
  // This is the second of two layers. mcpAuth (the first) refuses a request
  // with NO valid bearer. It cannot refuse a request with SOMEONE ELSE'S
  // bearer: verifyAccessToken checks only the key's shape, so any well-formed
  // key gets past it. Without this check, such a request would be served the
  // session owner's tenant and api key, or could read its stream or kill the
  // session.
  //
  // With OAuth on, every LIVE session is bound: seedCredentials binds on every
  // POST, and the binding lives until the transport closes (the idle sweep keeps
  // it; see sweepStaleSessions). An id with no binding therefore has no live
  // session behind it, and stale-recovery gives the caller a fresh session with
  // its OWN credentials. With ATEAM_OAUTH_DISABLED=1 nothing is bound, so this
  // check has nothing to compare and lets everything through. That is why the
  // escape hatch must stay unset on a shared server.
  //
  // A platform session (x-adas-token) is bound to PLATFORM_PRINCIPAL the same
  // way, so the same comparison keeps it apart from bearers in BOTH directions.
  const denySessionReuse = (req, res, sessionId) => {
    const presented = req.platformPrincipal ? PLATFORM_PRINCIPAL : req.auth?.token;
    if (sessionId && !sessionOwnershipOk(getSessionOwner(sessionId), presented)) {
      console.warn(`[Auth] DENY session reuse: owner mismatch for session ${sessionId} (presented=${req.platformPrincipal ? "platform" : req.auth?.token ? "other-bearer" : "none"})`);
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
        await seedCredentials(req, sessionId);
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
        await seedCredentials(req, newSessionId);

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

        const server = createServer(newSessionId, { transport: "http" });
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
      // No live session: answer with health-check JSON. Added (6b81137) for an
      // anonymous connector-validation probe; with OAuth on that probe now gets
      // mcpAuth's 401 challenge, so only an authenticated GET (a bearer, or the
      // platform secret) reaches here.
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

  // Mount MCP handlers at both "/" (Claude.ai) and "/mcp" (ChatGPT).
  // ONE auth rule for both — see mcpAuthFor above for why the split was removed.
  for (const path of MCP_PATHS) {
    const mcpAuth = mcpAuthFor(path);
    app.post(path, ...mcpAuth, mcpJson, mcpPost);
    app.get(path, ...mcpAuth, mcpGet);
    app.delete(path, ...mcpAuth, mcpDelete);
  }

  // ─── Catch-all: log unhandled requests ──────────────────────────
  app.use((req, res, next) => {
    console.log(`[HTTP] UNMATCHED: ${req.method} ${req.originalUrl || req.url}`);
    if (!res.headersSent) res.status(404).json({ error: "Not found" });
  });

  // ─── Error handler ──────────────────────────────────────────────
  app.use((err, req, res, next) => {
    console.error(`[HTTP] ERROR in ${req.method} ${req.originalUrl}:`, err.message || err);
    if (res.headersSent) return;
    // A body over the limit is the caller's to fix, and says so: it was a 500.
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: `Request body is ${err.length} bytes, over the ${err.limit}-byte limit of this route.` +
            (isMcpPost(req) ? " Test attachments are capped at 7 MB of files per message." : ""),
        },
        id: null,
      });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  // ─── Start ────────────────────────────────────────────────────
  const listener = app.listen(port, "0.0.0.0", () => {
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

  // The listening server, so a caller (a test) can close it.
  return listener;
}

/**
 * Seed session credentials from the OAuth bearer token.
 *
 * The bearer IS the user's API key (set during OAuth authorization).
 * If ateam_auth signed one of this bearer's sessions in to another key the API
 * accepted, that override is stored per bearer and takes priority here, until
 * a new sign-in on the A-Team page drops it (oauth.js).
 *
 * A platform request binds its owner and seeds NOTHING: no key, no tenant, no
 * override. The tenant arrives in-band through ateam_auth.
 */
async function seedCredentials(req, sessionId) {
  if (req.platformPrincipal) {
    bindSessionPlatform(sessionId);
    return;
  }
  const token = req.auth?.token;
  if (!token) return;

  // Track bearer → session (persistent actor identity)
  bindSessionBearer(sessionId, token);

  // An ateam_auth override for this bearer: only a key the API accepted, and
  // dropped when the person signs in again on the A-Team page (api.js
  // setAuthOverride / clearAuthOverride).
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
  if (!parsed.isValid) return;

  // The key's own environment decides the base. Without this a dev bearer
  // silently used the process default, which is PRODUCTION — the same
  // never-guess-the-environment rule ateam_auth already follows, applied to the
  // path that had been missed.
  const apiUrl = baseUrlForKeyEnv(token) || undefined;

  if (parsed.tenant) {
    setSessionCredentials(sessionId, { tenant: parsed.tenant, apiKey: token, apiUrl, explicit: true });
    return;
  }

  // A key that does not spell out its tenant has to be asked — ONCE. This runs
  // on every request for an existing session, so without the guard below it
  // would be a network round trip per MCP call. Two shapes get here: a SEALED
  // key (adas_<env>_<blob>) and a LEGACY one (adas_<32hex>).
  const current = (() => { try { return getCredentials(sessionId); } catch { return null; } })();
  if (current?.tenant && current.apiKey === token) return;

  // WHERE TO ASK is the rule ateam_auth follows for the same key: the key's own
  // environment, else this session's base (the process default for a key that
  // names none). This asked `apiUrl` alone, which a legacy key does not have,
  // so whoami threw "no base url" without asking anyone.
  const base = apiUrl || getBaseUrl(sessionId);
  try {
    const me = await whoami(token, base);
    setSessionCredentials(sessionId, { tenant: me.tenant, apiKey: token, apiUrl, explicit: true });
  } catch (err) {
    if (!parsed.sealed) {
      // A LEGACY key carries no tenant anywhere Core can read without one, so
      // there is nothing to seed. Recording tenant:null for it throws — by
      // design, setSessionCredentials never invents a tenant — and that throw
      // used to escape into the request handler as an opaque 500 on every call.
      // The session stays signed out instead: tenant tools refuse and say how
      // to sign in, and the next request asks again.
      console.warn(`[Auth] whoami failed for session ${sessionId} at ${base}: ${err.message} — a legacy key names no tenant, so this session is left signed out (ateam_auth, or a key that names its tenant).`);
      return;
    }
    // A SEALED key: credentials are still set. The tenant lives INSIDE the key
    // and Core reads it, so calls authenticate correctly with no X-ADAS-TENANT
    // header at all. What we must not do is fill the gap with a guess — an
    // unresolved tenant is recorded as null and retried on the next request.
    // Anything that needs the name will say it does not have it.
    console.warn(`[Auth] whoami failed for session ${sessionId} at ${base}: ${err.message} — proceeding with the tenant unresolved, never assumed.`);
    setSessionCredentials(sessionId, { tenant: null, apiKey: token, apiUrl, explicit: true });
  }
}
