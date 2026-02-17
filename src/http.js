/**
 * Streamable HTTP transport for ateam-mcp.
 * Enables ChatGPT and remote MCP clients to connect via HTTPS.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "./server.js";

// Active sessions
const transports = {};

export function startHttpServer(port = 3100) {
  const app = express();
  app.use(express.json());

  // ─── Health check ─────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ateam-mcp", transport: "http" });
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
        // New session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        const server = createServer();
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
    }
    process.exit(0);
  });
}
