# ateam-mcp — Master Plan

## Goal
Ship a working MCP server that lets any AI assistant (ChatGPT, Claude, Cursor, Windsurf, VS Code, Gemini) build, validate, and deploy ADAS multi-agent solutions through natural conversation. End-to-end: a developer installs it, their AI reads the spec, builds a solution, deploys it, and it runs.

## Current State
- [x] GitHub repo created (private): ariekogan/ateam-mcp
- [x] 12 MCP tools defined (spec, examples, validate, deploy, manage)
- [x] API client (api.js) with GET/POST/PATCH/DELETE
- [x] MCP stdio server (index.js) using @modelcontextprotocol/sdk
- [x] HTTP transport (http.js) using StreamableHTTPServerTransport
- [x] ADAS public API live at api.ateam-ai.com (via Cloudflare Tunnel)
- [x] MCP HTTP endpoint live at mcp.ateam-ai.com (via Cloudflare Tunnel)
- [x] README with purpose + distribution guide
- [x] **ChatGPT integration working** — "Ateam" app created, tools callable from ChatGPT 5.2
- [x] Claude Code integration working — `claude mcp add ateam` connected + verified

---

## Phase 1 — Make it work locally (stdio)
*Goal: install it, connect Claude Code or Cursor, do a full build→validate→deploy cycle*

- [ ] **1.1** Test the MCP server end-to-end with Claude Code
  - `claude mcp add ateam -- node /Users/arie/Projects/ateam-mcp/src/index.js`
  - Set env vars (ADAS_TENANT, ADAS_API_KEY)
  - Verify all 12 tools appear and respond
- [ ] **1.2** Fix any bugs found during live testing
  - Test each tool against the real API
  - Handle edge cases (empty responses, validation errors, large payloads)
- [ ] **1.3** Full workflow test: spec → example → build skill → validate → deploy → health check
  - This is the real proof — can an AI go from zero to deployed solution?
- [ ] **1.4** Test with Cursor (add to .cursor/mcp.json, verify tools work in Agent mode)

## Phase 2 — Add HTTP transport (for ChatGPT)
*Goal: host a remote HTTP endpoint so ChatGPT users can connect via URL*

- [ ] **2.1** Add Streamable HTTP transport to the server
  - Express or native HTTP server alongside stdio
  - Same tool handlers, just a different transport
- [ ] **2.2** Add API key authentication for the HTTP endpoint
  - Validate incoming requests (user's ADAS credentials)
  - Rate limiting basics
- [ ] **2.3** Deploy the HTTP server
  - Option A: run on your Mac via Cloudflare Tunnel at mcp.ateam-ai.com
  - Option B: deploy to a cloud service (Fly.io, Railway, etc.)
- [ ] **2.4** Test with ChatGPT Developer Mode
  - Settings → Connectors → paste URL
  - Verify tools appear and work

## Phase 3 — Polish & harden
*Goal: production-ready quality*

- [ ] **3.1** Error handling & user-friendly messages
  - Validation errors should explain what's wrong and how to fix it
  - API failures should give clear guidance, not raw stack traces
  - Timeout handling for long operations (deploy can take time)
- [ ] **3.2** Tool descriptions tuning
  - The tool descriptions ARE the UX — they teach the AI how to use ADAS
  - Test with multiple LLMs: does Claude understand the workflow? Does GPT?
  - Iterate on descriptions until AIs reliably follow the spec→validate→deploy loop
- [ ] **3.3** Add tool response formatting
  - Large spec responses: summarize or chunk for readability
  - Validation errors: structured format the AI can parse and act on
  - Deploy results: clear success/failure with next steps

## Phase 4 — Publish to npm
*Goal: `npx @ateam-ai/mcp` works for anyone*

- [ ] **4.1** Create npm organization (@ateam-ai)
  - Register at npmjs.com
  - Set up org, add team members if needed
- [ ] **4.2** Prepare for publish
  - Verify package.json (name, version, bin, files, license)
  - Add .npmignore (exclude .env, tests, dev files)
  - Test `npm pack` — verify the tarball contents are correct
- [ ] **4.3** Publish
  - `npm publish --access public`
  - Verify `npx -y @ateam-ai/mcp` works on a clean machine
- [ ] **4.4** Automate releases
  - Version bumping strategy (semver)
  - GitHub Actions: test → publish on tag

## Phase 5 — Register on marketplaces & directories
*Goal: developers can discover ateam-mcp from inside their AI tools*

- [ ] **5.1** Official MCP Registry (registry.modelcontextprotocol.io)
  - Install `mcp-publisher` CLI
  - Generate server.json, authenticate, publish
- [ ] **5.2** Claude Desktop Extensions
  - Build .mcpb bundle (manifest.json + server)
  - Submit to Anthropic's extensions directory for review
- [ ] **5.3** Claude Code Plugin Marketplace
  - Submit to claude-plugins-official repo
- [ ] **5.4** Community directories
  - Smithery (smithery.ai) — submit for listing
  - mcp.so — create GitHub issue to add
  - PulseMCP (pulsemcp.com) — submit
- [ ] **5.5** GitHub repo goes public
  - Add topics: mcp, model-context-protocol, ai-agents, multi-agent, adas
  - Clean up commit history if needed

## Phase 6 — Onboarding & developer experience
*Goal: a new developer goes from zero to deployed solution in under 10 minutes*

- [ ] **6.1** Quick-start guide
  - "Install in 30 seconds" for each platform (Claude, ChatGPT, Cursor)
  - First-deploy tutorial: "Say this to your AI and watch it build"
- [ ] **6.2** API key provisioning
  - How do developers get ADAS_TENANT + ADAS_API_KEY?
  - Self-service signup? Request form? Tied to ateam-ai.com account?
- [ ] **6.3** Example prompts library
  - "Build a customer support system with 3 tiers"
  - "Create an identity verification pipeline"
  - "Deploy a document processing workflow"
  - Show the AI's full tool-call sequence for each

## Phase 7 — Cloudflare Tunnel persistence
*Goal: api.ateam-ai.com stays up reliably*

- [ ] **7.1** Run cloudflared as a system service
  - `sudo cloudflared service install` or launchd plist
  - Auto-start on boot, auto-restart on crash
- [ ] **7.2** Monitor uptime
  - Health check endpoint monitoring (UptimeRobot, Cloudflare health checks)
  - Alert on downtime
- [ ] **7.3** Plan migration path
  - Current: Mac → Cloudflare Tunnel → api.ateam-ai.com
  - Future: cloud deployment for production reliability

---

## Milestone checklist

| Milestone | Definition of done |
|---|---|
| **M1: Works locally** | Claude Code calls adas_deploy_solution → solution runs on ADAS Core |
| **M2: Works for ChatGPT** | ChatGPT user pastes URL → can deploy a solution through chat |
| **M3: Published on npm** | `npx @ateam-ai/mcp` works anywhere, zero-config |
| **M4: Discoverable** | Listed on MCP Registry + at least 3 community directories |
| **M5: Self-service** | New developer installs, gets API key, deploys first solution < 10 min |

---

## What we're doing RIGHT NOW → Phase 1
