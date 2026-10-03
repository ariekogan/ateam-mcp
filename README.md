# ateam-mcp

[![MCP Queen operational grade](https://mcpqueen.com/badge/io.github.ariekogan/ateam-mcp.svg)](https://mcpqueen.com/s/io.github.ariekogan/ateam-mcp)

**Give any AI the ability to build, validate, and deploy production multi-agent systems.**

This is an MCP server that connects AI assistants — ChatGPT, Claude, Gemini, Copilot, Cursor, Windsurf, and any MCP-compatible environment — directly to the [ADAS](https://ateam-ai.com) platform.

An AI developer says *"Build me a customer support system with order tracking and escalation"* — and their AI assistant handles the entire lifecycle: reads the spec, builds skill definitions, validates them, deploys to production, and verifies health. No manual JSON authoring, no docs reading, no copy-paste workflows.

## Why this matters

Today, building multi-agent systems requires deep platform knowledge, manual configuration, and switching between docs, editors, and dashboards. **ateam-mcp eliminates all of that** by making the ADAS platform a native capability of the AI tools developers already use.

The AI assistant becomes the developer interface:

```
Developer: "Create an identity verification agent that checks documents,
            validates faces, and escalates fraud cases"

AI Assistant:
  → reads ADAS spec (adas_get_spec)
  → studies working examples (adas_get_examples)
  → builds skill + solution definitions
  → validates iteratively (adas_validate_skill, adas_validate_solution)
  → deploys to production (adas_deploy_solution)
  → verifies everything is running (adas_get_solution → health)

Developer: "Add a new skill that handles address verification"

AI Assistant:
  → deploys into the existing solution (adas_deploy_skill)
  → redeploys (adas_redeploy)
  → confirms health
```

No context switching. No manual steps. The full ADAS platform — specs, validation, deployment, monitoring — is available as natural language.

## How it reaches the AI community

### ChatGPT users

ChatGPT supports MCP connectors in Developer Mode. Users connect by pasting a single URL:

**Settings → Connectors → Developer Mode → paste `https://mcp.ateam-ai.com`**

That's it. All 12 ADAS tools appear in ChatGPT. Any ChatGPT Pro, Plus, Business, or Enterprise user can build and deploy multi-agent solutions through conversation.

### Claude users

**claude.ai and Claude Desktop** — add the hosted connector: open [Customize > Connectors](https://claude.ai/customize/connectors) (Claude Desktop: Customize in the sidebar, then Connectors), click **Add custom connector**, enter `https://mcp.ateam-ai.com`, and click **Connect**. The A-Team sign-in page opens in the browser and asks for your workspace's key: copy it from [app.ateam-ai.com/connect](https://app.ateam-ai.com/connect) (a workspace owner or admin) and paste it there. The key decides the workspace; to switch, Disconnect and Connect again with the other workspace's key.

**Claude Code** — the hosted connector, signed in the same way:

```bash
claude mcp add --transport http ateam https://mcp.ateam-ai.com
```

then `/mcp` and authenticate in the browser.

Never paste a key into a chat. `ateam_bootstrap`'s `session` field says which workspace a session is on and how to switch.

### Cursor / Windsurf / VS Code (Copilot)

Add the hosted server to `.cursor/mcp.json`, `mcp_config.json`, or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "ateam": { "url": "https://mcp.ateam-ai.com/mcp" }
  }
}
```

A client with OAuth opens the A-Team sign-in page; one without sends the key as `Authorization: Bearer <key>` from its own config (see below). A local process (`npx -y @ateam-ai/mcp`) signs in only through `ateam_auth`: an `ADAS_API_KEY` in its environment does not sign it in.

### Gemini and other platforms

As MCP adoption grows (it's now governed by the Agentic AI Foundation under the Linux Foundation, co-founded by Anthropic, OpenAI, and Block), every AI platform that implements MCP gets access to ateam-mcp automatically. The remote HTTP endpoint (`https://mcp.ateam-ai.com`, also at `/mcp`) works with any client that supports Streamable HTTP transport.

The HTTP endpoint needs a credential on every request: OAuth (clients that support it follow the `401` challenge on their own), or your A-Team API key sent as `Authorization: Bearer <key>`. An anonymous request is refused with `401`; since 0.4.93 there is no anonymous session to call `ateam_auth` from. See [CHANGELOG.md](CHANGELOG.md).

### Discovery

Developers find ateam-mcp through:

- **npm** — `npm search mcp ai-agents` → `@ateam-ai/mcp`
- **Official MCP Registry** — registry.modelcontextprotocol.io
- **Claude Desktop Extensions** — built-in extension browser
- **Claude Code Plugin Marketplace** — `/plugin` → Discover tab
- **Windsurf MCP Marketplace** — built-in marketplace
- **VS Code MCP Gallery** — Extensions view
- **Community directories** — Smithery, mcp.so, PulseMCP (30,000+ combined listings)

## Available tools

| Tool | What it does |
|---|---|
| `adas_get_spec` | Read the ADAS specification — skill schema, solution architecture, enums, agent guides |
| `adas_get_examples` | Get complete working examples — skills, connectors, solutions |
| `adas_validate_skill` | Validate a skill definition through the 5-stage pipeline |
| `adas_validate_solution` | Validate a solution — cross-skill contracts + quality scoring |
| `adas_deploy_solution` | Deploy a complete solution to production |
| `adas_deploy_skill` | Add a skill to an existing solution |
| `adas_deploy_connector` | Deploy a connector to ADAS Core |
| `adas_list_solutions` | List all deployed solutions |
| `adas_get_solution` | Inspect a solution — definition, skills, health, status, export |
| `adas_update` | Update a solution or skill incrementally (PATCH) |
| `adas_redeploy` | Push changes live — regenerates MCP servers, deploys to ADAS Core |
| `adas_solution_chat` | Talk to the Solution Bot for guided modifications |

## Setup

```bash
# Clone
git clone https://github.com/ariekogan/ateam-mcp.git
cd ateam-mcp

# Install
npm install

# Run (a local stdio process)
npm start
```

A local process signs in with `ateam_auth`, given a workspace key the agent reads from a file outside the chat; an `ADAS_API_KEY` in the environment does not sign it in and is never sent. `ADAS_API_URL` in its environment points it at a self-hosted API. Most people use the hosted connector instead (above).

## Architecture

```
┌─────────────────────────────────────────────┐
│  AI Environment                             │
│  (ChatGPT / Claude / Cursor / Windsurf)     │
│                                             │
│  Developer: "build me a support system"     │
└──────────────────┬──────────────────────────┘
                   │ MCP protocol
                   │ (stdio or HTTP)
┌──────────────────▼──────────────────────────┐
│  ateam-mcp                                  │
│  12 tools — spec, validate, deploy, manage  │
└──────────────────┬──────────────────────────┘
                   │ HTTPS
                   │ X-ADAS-TENANT / X-API-KEY
┌──────────────────▼──────────────────────────┐
│  ADAS External Agent API                    │
│  api.ateam-ai.com                           │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  ADAS Core                                  │
│  Multi-agent runtime                        │
└─────────────────────────────────────────────┘
```

## License

MIT
