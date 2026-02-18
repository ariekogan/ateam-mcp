# ateam-mcp — Master Plan

## Goal
Ship a working MCP server that lets any AI assistant (ChatGPT, Claude, Cursor, Windsurf, VS Code, Gemini) build, validate, and deploy ADAS multi-agent solutions through natural conversation. End-to-end: a developer installs it, their AI reads the spec, builds a solution, deploys it, and it runs.

---

## Completed

### Phase 1 — Stdio transport ✅
- Claude Code integration working
- All 14 tools connected and responding
- Full workflow tested: spec → validate → deploy → manage

### Phase 2 — HTTP transport (ChatGPT) ✅
- Streamable HTTP transport at mcp.ateam-ai.com
- ChatGPT "Ateam" app created and working in Developer Mode
- Fixed array schemas for ChatGPT's stricter validation

### Phase 4 — npm publish ✅
- @ateam-ai org created on npmjs.com
- Published: `@ateam-ai/mcp@0.1.3`
- Install: `npx -y @ateam-ai/mcp`

### Phase 5 — Marketplaces ✅
- **Official MCP Registry**: Published (`io.github.ariekogan/ateam-mcp`)
- **awesome-mcp-servers**: ✅ Merged — https://github.com/punkpeye/awesome-mcp-servers/pull/2097
- **Smithery**: Published & public — https://smithery.ai/servers/ateam-ai/ateam
- **MCP Registry config**: Added to repo (`registry.yaml`), v0.1.3

### Phase 7 — Infrastructure ✅
- All services run on **mac1** (Docker + launchd agents)
- Cloudflare tunnel runs on mac1 directly
- MCP HTTP server runs on mac1 as launchd agent
- See "Infrastructure" section below for full details

---

## Infrastructure — What's Running on mac1

### Architecture

mac1 is the **solution host**. All backend services run there in Docker containers. The Cloudflare tunnel and MCP HTTP server run as native launchd agents on mac1.

```
Internet → Cloudflare → mac1 tunnel → localhost services
                                        ├── :3201 Skill Validator (Docker)
                                        ├── :4311 Skill Builder (Docker)
                                        ├── :4100 ADAS Core (Docker)
                                        └── :3101 MCP HTTP Server (native)
```

### Services

| Service | How it runs | What it does | Port |
|---|---|---|---|
| **Cloudflare Tunnel** | launchd `com.cloudflare.cloudflared` | Routes api/mcp.ateam-ai.com → localhost | — |
| **MCP HTTP Server** | launchd `com.ateam-ai.mcp-http` | Streamable HTTP MCP endpoint for ChatGPT | 3101 |
| **Skill Validator** | Docker `adas_mcp_toolbox_builder-backend-1` | ADAS API (validates + stores skills) | 3201 |
| **Skill Builder** | Docker (same container) | Generates MCP servers from skill defs | 4311 |
| **ADAS Core** | Docker `ai-dev-assistant-backend-1` | Runs agent solutions | 4100 |

### Commands (run via `ssh mac1`)

```bash
# Check launchd services
launchctl list | grep -E 'cloudflare|ateam'

# Check Docker containers
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# Restart cloudflared
launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
launchctl load ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist

# Restart MCP HTTP
launchctl unload ~/Library/LaunchAgents/com.ateam-ai.mcp-http.plist
launchctl load ~/Library/LaunchAgents/com.ateam-ai.mcp-http.plist

# View logs
tail -f /tmp/cloudflared.log
tail -f /tmp/ateam-mcp-http.log
```

### Health checks

```bash
# ADAS API (Skill Validator)
curl https://api.ateam-ai.com/health

# MCP HTTP server
curl https://mcp.ateam-ai.com/health
```

### File locations (on mac1)

| What | Path |
|---|---|
| MCP server code | `~/Projects/ateam-mcp/` |
| Cloudflare tunnel config | `~/.cloudflared/config.yml` |
| Cloudflare tunnel credentials | `~/.cloudflared/f5642a85-*.json` |
| cloudflared binary | `~/bin/cloudflared` |
| LaunchAgent plists | `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`, `com.ateam-ai.mcp-http.plist` |

### DNS / Domains

| Domain | Routes to | Via |
|---|---|---|
| `ateam-ai.com` | Lovable hosting | DNS A record (185.158.133.1) |
| `www.ateam-ai.com` | Lovable hosting | DNS A record |
| `api.ateam-ai.com` | mac1 localhost:3201 | Cloudflare Tunnel |
| `mcp.ateam-ai.com` | mac1 localhost:3101 | Cloudflare Tunnel |

### npm / Registry

| What | Value |
|---|---|
| npm package | `@ateam-ai/mcp` v0.1.3 |
| npm org | `@ateam-ai` |
| npm user | `ariekogan` |
| MCP Registry name | `io.github.ariekogan/ateam-mcp` |
| GitHub repo | `ariekogan/ateam-mcp` (public) |
| Smithery | `ateam-ai/ateam` — https://smithery.ai/servers/ateam-ai/ateam |

---

## Manual Action Items (Arie)

### Marketplace Submissions
- [x] **Smithery** — Published & public
- [x] **awesome-mcp-servers** — PR merged
- [ ] **PulseMCP** — Go to https://www.pulsemcp.com/use-cases/submit → fill form
- [ ] **mcp.so** — Go to https://mcp.so → click "Submit" in nav → fill form
- [ ] **mcpservers.org** — Go to https://mcpservers.org/submit → fill form
- [ ] **MCP Market** — Go to https://mcpmarket.com/submit → needs 400x400 PNG logo
- [ ] **Cline Marketplace** — Create issue at https://github.com/cline/mcp-marketplace/issues/new → needs 400x400 PNG logo

### GitHub Repo
- [x] **Make repo public** — Done
- [x] **Add topics** — Done (mcp, model-context-protocol, ai-agents, multi-agent, adas, mcp-server)
- [x] **Add Glama config** — `glama.json` added to repo root
- [x] **Add Dockerfile** — Dockerfile added for Docker-based usage

### npm Token
- [ ] ⚠️ **Renew npm token before Feb 24, 2026** — Expires in ~6 days! Go to https://www.npmjs.com/settings/ariekogan/tokens

### ChatGPT App
- [ ] **Publish ChatGPT app** — Currently in Drafts. Go to ChatGPT Settings → Developer → Apps → Ateam → publish

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

### Phase 7 — Infrastructure (remaining)
*Goal: production reliability*

- [x] **7.1** Run all services as launchd agents (auto-start, auto-restart)
- [ ] **7.2** Uptime monitoring (health checks, alerts — UptimeRobot or similar)
- [ ] **7.3** Plan migration to cloud deployment for production reliability
- [ ] **7.4** OAuth / multi-tenant support (when user demand requires per-user isolation)

---

## Milestone Checklist

| Milestone | Status |
|---|---|
| **M1: Works locally** — Claude Code calls adas_deploy_solution → solution runs | ✅ Done |
| **M2: Works for ChatGPT** — ChatGPT user pastes URL → deploys through chat | ✅ Done |
| **M3: Published on npm** — `npx @ateam-ai/mcp` works anywhere | ✅ Done |
| **M4: Discoverable** — Listed on MCP Registry + community directories | ✅ Registry + Smithery + awesome-mcp-servers |
| **M5: Self-service** — New dev installs, gets key, deploys first solution < 10 min | ⬜ Pending |
