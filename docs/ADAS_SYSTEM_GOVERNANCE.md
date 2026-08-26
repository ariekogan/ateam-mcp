# ADAS/A-Team System Architecture Governance

This repository participates in the system-wide ADAS Architecture/Product Governor.

Canonical governance lives in:

`ariekogan/ai-dev-assistant` -> `Docs/ADAS_ARCHITECTURE_GOVERNOR.md`

For significant product/architecture or cross-repo changes, perform the Governor's Architecture/Product Challenge before implementation and use:

`ariekogan/ai-dev-assistant` -> `Docs/templates/SYSTEM_CHANGE_RECORD.md`

A-Team MCP remains an agent-facing design/control surface. The system governor is specifically intended to prevent this repo from becoming an independent owner of product/domain state or lifecycle semantics that belong to Builder/Core.

Initial adoption implementation instructions are in:

`ariekogan/ai-dev-assistant` -> `Docs/handoff/2026-08-26-adas-architecture-governor/IMPLEMENTATION_HANDOFF.md`

## When two documents disagree

`ariekogan/ai-dev-assistant` -> `Docs/ARCHITECTURE_SOURCES_OF_TRUTH.md` ranks the
architecture documents and answers the storage question for the whole system:

- **GitHub** is what a solution IS (authored, versioned).
- **Core Mongo** is what it is DOING (runtime projection).
- **Builder FS (`_builder/`)** is what someone is currently CHANGING it to
  (design-time working state).

Disagreement between them is normal — it means an authored change is not deployed,
or a runtime change was never captured. Do not reconcile one into another assuming
either is complete; that doc records REALITY vs TARGET, verified against code on
2026-08-26, and the two are not the same yet.

Anything under `Docs/WIP/` in any repo is historical context, never authority.
