# WIP — Auto-generate `CLAUDE.md` on solution repo creation

**Status:** proposed
**Date:** 2026-04-21
**Motivation:** make it possible for a developer given only an A-Team API key + GitHub access to their solution repo to clone it and have their agent immediately be productive, without needing tribal knowledge from the original builder.

## Problem

Today, when a solution is first deployed:
- `ateam_build_and_run` / `ateam_github_push` auto-creates a GitHub repo named `<tenant>--<solution-id>`
- The repo gets `solution.json`, `skills/**/skill.json`, `connectors/**/*`, `.ateam/export.json`
- But no agent onboarding doc

Any new agent session cloning the repo hits the same traps we all hit:
- Stale `.ateam/export.json` after manual edits
- `_adas_actor` being stripped to `_system_service` by Core in `ateam_test_connector`
- Which tool to use for what change (`github_patch` vs `patch` vs `build_and_run` vs `redeploy`)
- Silent-failure patterns in connectors
- Solution-specific quirks (shared corpora, OAuth flows, etc.)

Result: first few agent sessions on a given solution flail, burn cycles, sometimes regress things.

## Proposed change

On solution repo creation, seed a `CLAUDE.md` at the repo root. Two sections:

### 1. Static (same for every solution)
- A-Team GitHub-first workflow (single `main` branch, `safe-*` checkpoints)
- MCP tool decision table (`github_patch` vs `patch` vs `build_and_run` vs `redeploy`)
- Universal pitfalls:
  - `ateam_test_connector` runs as `_system_service` (actor stripping)
  - `.ateam/export.json` is auto-generated — don't hand-edit
  - `ateam_patch` is preferred over `github_patch + build_and_run` for skill-def changes
  - Always `git pull` / `ateam_github_read` before editing (don't rely on cached content)
- Links: `ateam_get_spec`, `ateam_get_examples`, `ateam_get_workflows`

### 2. Generated (rendered from the solution definition)
- Solution name + description
- Skills list (id, role, description)
- Connectors list (id + whether platform or solution)
- UI plugins list
- Repo layout (derived from which connectors exist)

### 3. Optional manual section
A sentinel like:
```markdown
<!-- SOLUTION-SPECIFIC NOTES BELOW — not auto-regenerated -->
```
Below this marker, the solution owner adds per-solution quirks (business rules, OAuth gotchas, data model surprises). On regenerate, we only rewrite the content ABOVE the marker.

## Where the change lives

`ateam-mcp/src/tools.js` — the tool implementations for `ateam_build_and_run` and `ateam_github_push`. Specifically wherever new-repo seeding happens (initial commit with `solution.json` + skills + connectors).

Proposed addition:
1. Template file shipped with ateam-mcp: `src/templates/CLAUDE.md.hbs` (or similar)
2. On first repo create: render template with `{ solution, skills, connectors, ui_plugins }` → commit as `CLAUDE.md` alongside the other files
3. On subsequent `build_and_run`: DON'T overwrite — the user may have added solution-specific notes. Only regenerate the section above the sentinel.

## Backfill for existing solutions

Add a new tool: `ateam_write_agent_doc(solution_id, overwrite?: bool)`
- Renders the same template against the current solution definition
- Writes to `CLAUDE.md` in the solution's GitHub repo
- If `overwrite=false` (default) and a `CLAUDE.md` already exists, only replace the auto-generated section (above the sentinel)

## Test plan

1. Delete a test solution's CLAUDE.md
2. Run `ateam_write_agent_doc(test_solution)` → file appears with correct rendered skills/connectors
3. Add manual notes below sentinel
4. Re-run `ateam_write_agent_doc(test_solution)` → manual notes preserved, top section refreshed if skills changed
5. Spawn a fresh agent session cloning the repo and reading only CLAUDE.md → verify it can complete a basic edit (e.g. add a new intent to a skill) without asking the builder for help

## Out of scope (follow-ups)

- Per-connector `CLAUDE.md` inside each connector dir (more granular)
- Auto-index the doc in memory-mcp / docs-index-mcp for cross-solution agent search

## Reference implementation (draft for the static section)

See the `docs-retrieval` solution's `CLAUDE.md` (commit `2b7180d` on `main` of `ariekogan/dark-data--docs-retrieval`) — written by hand during the session that motivated this WIP. Use it as the baseline for the template.
