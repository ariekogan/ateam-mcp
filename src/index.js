#!/usr/bin/env node

/**
 * ADAS MCP Server
 * Build, validate, and deploy multi-agent solutions from any AI environment.
 *
 * Transports:
 *   --http [port]   Start Streamable HTTP server (default port 3100)
 *   (default)       Start stdio transport for Claude Code, Cursor, etc.
 */

import { createServer } from "./server.js";

const httpFlag = process.argv.includes("--http");

if (httpFlag) {
  // ─── HTTP transport (for ChatGPT, remote clients) ─────────────
  const { startHttpServer } = await import("./http.js");
  const portArg = process.argv[process.argv.indexOf("--http") + 1];
  const port = portArg && !portArg.startsWith("-") ? parseInt(portArg, 10) : 3100;
  startHttpServer(port);
} else {
  // ─── Stdio transport (for Claude Code, Cursor, Windsurf, VS Code) ──
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
