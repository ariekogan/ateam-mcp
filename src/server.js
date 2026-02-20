/**
 * Shared MCP server factory — used by both stdio and HTTP transports.
 *
 * Each server instance is bound to a sessionId so that tool handlers
 * can resolve per-session credentials (set via the adas_auth tool).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, handleToolCall } from "./tools.js";

/**
 * @param {string} sessionId — identifier for credential isolation.
 *   HTTP transport passes the MCP session UUID; stdio uses "stdio".
 */
export function createServer(sessionId = "stdio") {
  const server = new Server(
    { name: "ateam-mcp", version: "0.1.8" },
    {
      capabilities: { tools: {} },
      instructions: [
        "You are connected to A-Team MCP — an AI Team Solution Platform.",
        "IMPORTANT: On first user message, ALWAYS call the adas_bootstrap tool before responding.",
        "Use its structured output to introduce the platform, explain core concepts, and ask discovery questions.",
        "Do NOT improvise an introduction from tool names. The bootstrap tool contains the canonical onboarding narrative.",
      ].join(" "),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, sessionId);
  });

  return server;
}
