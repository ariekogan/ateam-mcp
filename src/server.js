/**
 * Shared MCP server factory — used by both stdio and HTTP transports.
 *
 * Each server instance is bound to a sessionId so that tool handlers
 * can resolve per-session credentials (set via the ateam_auth tool).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, coreTools, handleToolCall } from "./tools.js";

/**
 * @param {string} sessionId — identifier for credential isolation.
 *   HTTP transport passes the MCP session UUID; stdio uses "stdio".
 */
export function createServer(sessionId = "stdio") {
  const server = new Server(
    { name: "ateam-mcp", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "You are connected to A-Team MCP — an AI Team Solution Platform.",
        "IMPORTANT: On first user message, ALWAYS call the ateam_bootstrap tool before responding.",
        "Use its structured output to introduce the platform, explain core concepts, and ask discovery questions.",
        "Do NOT improvise an introduction from tool names. The bootstrap tool contains the canonical onboarding narrative.",
      ].join(" "),
    }
  );

  // Only advertise core tools — advanced tools are still callable but not listed.
  // This reduces cognitive load from 23+ tools to ~11 in the tool surface.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: coreTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, sessionId);
  });

  return server;
}
