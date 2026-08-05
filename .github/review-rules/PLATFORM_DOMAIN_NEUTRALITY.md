# PLATFORM DOMAIN NEUTRALITY — the platform must not know what a customer sells

**Applies to:** `apps/backend/skills/platform/**`, `apps/backend/ai/prompts/**`,
`apps/backend/worker/**`, `apps/backend/tools/impl/system/**`,
`apps/backend/storage/**`, `connectors/**` (PLATFORM connectors only),
`apps/acs/**`, `packages/**`.

**Does NOT apply to:** solution skills, tenant data, `_builder/` output, test
fixtures, or a connector whose entire purpose is one external service (a Gmail
connector may of course say "gmail"). Naming a domain inside the thing that IS
that domain is not drift.

## The rule

Platform code must work for a tenant whose business you have never heard of. A
platform file that names a business domain — `nutrition`, `invoice`, `accounting`,
`CRM`, `steps`, `inbox`, `workout`, `thermostat` — is claiming to know the set of
domains in advance. It doesn't. Every domain it did not think of routes worse, or
not at all.

**This is the single easiest rule to break while trying to make something work.**
It happens when an engineer (or an agent) is debugging one scenario and adds the
noun that makes THAT scenario pass. It always looks like a small fix.

## What to flag as BLOCKING

1. **An enumerated domain list in a platform skill** — intents, routing examples,
   `handoff_when`, or capability descriptions naming specific verticals.
2. **A domain noun in a kernel decision path** — anything in `worker/`,
   `tools/impl/system/`, or `storage/` that branches, scores, matches, or filters
   on a domain word.
3. **A prompt that teaches the model a fixed domain vocabulary** where the point
   of the prompt is to route or classify ARBITRARY user intent.
4. **A test made to pass by adding a noun to platform code** rather than by making
   the platform mechanism general. Check what the same commit changed: a domain
   noun appearing in platform code alongside a scenario test is the signature.

## What is FINE

- Domain nouns in **comments and doc-strings** used as illustration, where the
  code around them is generic (`// e.g. "show my steps"`). Provenance and examples
  are not behaviour.
- A **solution** skill naming its own domain — that is what a solution is.
- A connector named for the service it wraps.

The distinguishing question is always: **does the behaviour change if a tenant's
domain is absent from this list?** If yes, it is drift. If the code would treat an
unknown domain identically, it is illustration.

## Verified example of the failure (2026-08-05, on `dev`)

`apps/backend/skills/platform/ui-companion.json` — a PLATFORM skill — enumerates
its supported intents by domain: `display_emails`, `display_steps`,
`display_sleep`, `display_nutrition`, `display_calendar`, `display_weather`,
`display_messages` (whatsapp), `display_notifications`. Nine of twelve intents name
a specific vertical.

The consequence is exactly what the rule predicts: a tenant whose domain is
invoicing, inventory, or patient scheduling has no matching intent, so a display
request routes on a weaker signal or not at all — while the platform reports
itself as working, because the domains someone happened to test still match.

The generic form of the same skill is intent by SHAPE, not by subject:
`display_records`, `display_timeseries`, `display_single_value`, `build_widget`,
`refine_widget` — which is what the widget layer already does internally with its
ten canonical shapes. The shapes are domain-free; the intents are not.

## How to report it

Cite the file and the enumeration, and state which tenant domain would fail. A
finding that says "contains the word nutrition" is not actionable; a finding that
says "a tenant selling insurance has no matching intent here, so display requests
fall through to keyword scoring" is.
