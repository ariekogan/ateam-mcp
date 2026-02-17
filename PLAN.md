# ateam-mcp — Master Plan

## Goal
Ship a working MCP server that lets any AI assistant (ChatGPT, Claude, Cursor, Windsurf, VS Code, Gemini) build, validate, and deploy ADAS multi-agent solutions through natural conversation. End-to-end: a developer installs it, their AI reads the spec, builds a solution, deploys it, and it runs.

---

## Completed

### Phase 1 — Stdio transport ✅
- Claude Code integration working
- All 17 tools connected and responding
- Full workflow tested: spec → validate → deploy → manage

### Phase 2 — HTTP transport (ChatGPT) ✅
- Streamable HTTP transport at mcp.ateam-ai.com
- ChatGPT "Ateam" app created and working in Developer Mode
- Fixed array schemas for ChatGPT's stricter validation

### Phase 4 — npm publish ✅
- @ateam-ai org created on npmjs.com
- Published: `@ateam-ai/mcp@0.1.2`
- Install: `npx -y @ateam-ai/mcp`

### Phase 5 — Marketplaces (partial) ✅
- **Official MCP Registry**: Published (`io.github.ariekogan/ateam-mcp`)
- **awesome-mcp-servers**: PR open — https://github.com/punkpeye/awesome-mcp-servers/pull/2097
- **Smithery CLI**: Authenticated, namespace needs web creation

---

## Manual Action Items (Arie)

These require browser/web form submissions and can't be automated from CLI:

### Marketplace Submissions
- [ ] **Smithery** — Go to https://smithery.ai/new → enter `https://mcp.ateam-ai.com/mcp` → Smithery auto-scans tools and lists the server
- [ ] **PulseMCP** — Go to https://www.pulsemcp.com/use-cases/submit → fill form (name: ateam-mcp, URL: https://github.com/ariekogan/ateam-mcp, npm: @ateam-ai/mcp)
- [ ] **mcp.so** — Go to https://mcp.so → click "Submit" in nav → fill form
- [ ] **mcpservers.org** — Go to https://mcpservers.org/submit → fill form
- [ ] **MCP Market** — Go to https://mcpmarket.com/submit → submit GitHub repo URL + 400x400 PNG logo
- [ ] **Cline Marketplace** — Create issue at https://github.com/cline/mcp-marketplace/issues/new → provide repo URL + 400x400 PNG logo

### GitHub Repo
- [ ] **Make repo public** — Currently private. Go to Settings → Danger Zone → Change visibility → Public
- [ ] **Add topics** — Add: `mcp`, `model-context-protocol`, `ai-agents`, `multi-agent`, `adas`, `mcp-server`
- [ ] **Add Glama config** — After awesome-mcp-servers PR merges, add `glama.json` to repo root for claiming ownership

### npm Token
- [ ] **Renew npm token before Feb 24, 2026** — Current granular token expires in 7 days. Go to https://www.npmjs.com/settings/ariekogan/tokens to create a new one with 90-day expiry

### ChatGPT App
- [ ] **Publish ChatGPT app** — Currently in Drafts. When ready for public, go to ChatGPT Settings → Developer → Apps → Ateam → publish from draft to live

---

## Remaining Phases

### Phase 3 — Polish & Harden
*Goal: production-ready quality*

- [ ] **3.1** Error handling & user-friendly messages
- [ ] **3.2** Tool descriptions tuning (test with multiple LLMs)
- [ ] **3.3** Response formatting (summarize large payloads, structured errors)

### Phase 6 — Onboarding & Developer Experience
*Goal: new developer goes from zero to deployed solution in under 10 minutes*

- [ ] **6.1** Quick-start guide for each platform (Claude, ChatGPT, Cursor)
- [ ] **6.2** API key provisioning (self-service signup?)
- [ ] **6.3** Example prompts library (customer support, document processing, etc.)

### Phase 7 — Infrastructure
*Goal: api.ateam-ai.com stays up reliably*

- [ ] **7.1** Run cloudflared as system service (auto-start on boot)
- [ ] **7.2** Uptime monitoring (health checks, alerts)
- [ ] **7.3** Plan migration to cloud deployment for production reliability
- [ ] **7.4** OAuth / multi-tenant support (when user demand requires per-user isolation)

---

## Milestone Checklist

| Milestone | Status |
|---|---|
| **M1: Works locally** — Claude Code calls adas_deploy_solution → solution runs | ✅ Done |
| **M2: Works for ChatGPT** — ChatGPT user pastes URL → deploys through chat | ✅ Done |
| **M3: Published on npm** — `npx @ateam-ai/mcp` works anywhere | ✅ Done |
| **M4: Discoverable** — Listed on MCP Registry + community directories | ✅ Registry + PR open |
| **M5: Self-service** — New dev installs, gets key, deploys first solution < 10 min | ⬜ Pending |
