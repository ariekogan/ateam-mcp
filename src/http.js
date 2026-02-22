/**
 * Streamable HTTP transport for ateam-mcp.
 * Enables ChatGPT and remote MCP clients to connect via HTTPS.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "./server.js";
import { clearSession } from "./api.js";

// Active sessions
const transports = {};

export function startHttpServer(port = 3100) {
  const app = express();
  app.use(express.json());

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
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing session
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session — generate ID upfront so we can bind it to the server
        const newSessionId = randomUUID();

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
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // ─── MCP DELETE — session termination ────────────────────────
  app.delete("/mcp", async (req, res) => {
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
