# ateam-mcp

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

**Claude Desktop** — install as an extension (one-click) or add to config:

```json
{
  "mcpServers": {
    "ateam": {
      "command": "npx",
      "args": ["-y", "@ateam-ai/mcp"],
      "env": {
        "ADAS_TENANT": "your-tenant",
        "ADAS_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Claude Code** — one command:

```bash
claude mcp add ateam -- npx -y @ateam-ai/mcp
```

### Cursor / Windsurf / VS Code (Copilot)

Add to `.cursor/mcp.json`, `mcp_config.json`, or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "ateam": {
      "command": "npx",
      "args": ["-y", "@ateam-ai/mcp"],
      "env": {
        "ADAS_TENANT": "your-tenant",
        "ADAS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Gemini and other platforms

As MCP adoption grows (it's now governed by the Agentic AI Foundation under the Linux Foundation, co-founded by Anthropic, OpenAI, and Block), every AI platform that implements MCP gets access to ateam-mcp automatically. The remote HTTP endpoint (`https://mcp.ateam-ai.com`) works with any client that supports Streamable HTTP transport.

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

# Configure
cp .env.example .env
# Edit .env with your ADAS tenant and API key

# Run
npm start
```

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
