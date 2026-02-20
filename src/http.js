/**
 * Streamable HTTP transport for ateam-mcp.
 * Enables ChatGPT and remote MCP clients to connect via HTTPS.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "./server.js";
import { clearSession, parseApiKey, setSessionCredentials } from "./api.js";

const BASE_URL = process.env.MCP_BASE_URL || "https://mcp.ateam-ai.com";

// Active sessions
const transports = {};

export function startHttpServer(port = 3100) {
  const app = express();
  app.use(express.json());

  // ─── Health check ─────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ateam-mcp", transport: "http" });
  });

  // ─── Get API Key page ─────────────────────────────────────────
  app.get("/get-api-key", (_req, res) => {
    res.type("html").send(GET_API_KEY_PAGE);
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

// ─── Static HTML: Get API Key page ──────────────────────────────

const GET_API_KEY_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Get Your ADAS API Key</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1a1b23;
      border: 1px solid #2a2b35;
      border-radius: 16px;
      max-width: 520px;
      width: 100%;
      padding: 40px;
    }
    .logo { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .logo span { color: #f97316; }
    .subtitle { color: #71717a; font-size: 14px; margin-bottom: 32px; }
    h2 { font-size: 20px; font-weight: 600; margin-bottom: 20px; }
    .steps { list-style: none; counter-reset: step; }
    .steps li {
      counter-increment: step;
      padding: 14px 0;
      border-bottom: 1px solid #2a2b35;
      font-size: 15px;
      line-height: 1.6;
      display: flex;
      gap: 12px;
    }
    .steps li:last-child { border-bottom: none; }
    .steps li::before {
      content: counter(step);
      background: #f97316;
      color: #fff;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }
    a { color: #f97316; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      background: #2a2b35;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 13px;
      font-family: "SF Mono", Monaco, Consolas, monospace;
    }
    .key-format {
      margin-top: 24px;
      padding: 16px;
      background: #2a2b35;
      border-radius: 8px;
      font-family: "SF Mono", Monaco, Consolas, monospace;
      font-size: 14px;
      color: #f97316;
      text-align: center;
      letter-spacing: 0.5px;
    }
    .then {
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid #2a2b35;
    }
    .then h3 { font-size: 16px; margin-bottom: 12px; font-weight: 600; }
    .then p { font-size: 14px; color: #a1a1aa; line-height: 1.6; }
    .then code { color: #e4e4e7; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span>A</span>-Team</div>
    <div class="subtitle">ADAS Multi-Agent Platform</div>

    <h2>Get Your API Key</h2>

    <ol class="steps">
      <li><span>Go to <a href="https://app.ateam-ai.com" target="_blank">app.ateam-ai.com</a> and sign in</span></li>
      <li><span>Click the <strong>Agent API</strong> button (top bar)</span></li>
      <li><span>Your API key is shown — click <strong>Copy</strong></span></li>
      <li><span>Paste it when your AI agent asks for it</span></li>
    </ol>

    <div class="key-format">adas_&lt;tenant&gt;_&lt;32-char-hex&gt;</div>

    <div class="then">
      <h3>Then tell your agent:</h3>
      <p>
        Call <code>adas_auth</code> with your API key. The tenant is auto-extracted from the key — no extra config needed.
      </p>
    </div>
  </div>
</body>
</html>`;
