# Realtime Voice Review Rules

> **Scope guard:** these rules apply **only** when the diff touches the realtime
> voice path (`apps/voice/**`, the Realtime session/transport, VAD, or the voice
> turn/tool loop). If the PR does not touch voice, skip this dimension entirely —
> do **not** invent voice findings for non-voice changes.

## Turn ownership (BLOCKING)

- **Server VAD owns normal user turns.** The client/app must not also drive
  turn-taking for ordinary speech. Two owners of turn detection ⇒ BLOCKING.
- **Manual `response.create` exists ONLY for tool continuation** — i.e. to
  resume the model after a tool result. Using `response.create` to answer a
  normal user turn (which VAD already drives) causes a **duplicate
  `response.create`** ⇒ BLOCKING.
- **No duplicate `response.create`.** Two code paths that can both emit
  `response.create` for the same turn ⇒ BLOCKING.

## Transport & tool-execution ownership (BLOCKING)

- **Unique tool-execution ownership.** Exactly one place executes a given tool
  call and feeds the result back. Duplicated execution or duplicated result
  submission ⇒ BLOCKING.
- **No duplicated transport ownership.** One owner of the Realtime socket /
  session lifecycle. A second writer to the same transport ⇒ BLOCKING.
- The voice **frontend is a dumb forwarder** — business logic and tool decisions
  live in voice-backend, not the FE. Logic leaking into the FE is BLOCKING.

## Fluency & loop integrity (BLOCKING)

- The realtime loop must stay fluent: no added synchronous work between VAD
  end-of-speech and `response.create` that would stall the reply. Breaking the
  voice loop (dropped continuation, deadlock between tool result and next
  response) is BLOCKING.
- **Held-skill handoff** during a call must remain correct — a handoff must not
  break the audio loop or strand the held skill (see `CONCURRENCY_AND_STATE.md`).
- Mid-flight chain progress must still surface to the caller during long tool
  runs.

## Cost levers specific to voice (BLOCKING for regressions)

- Keep the **prompt prefix cache-friendly and stable** — realtime calls are
  expensive (an 8-min call can run ~$10). See `COST_ACCOUNTING.md`.
- `truncation.retention_ratio` is the primary context-cost lever; a change that
  disables/miscomputes truncation and lets context grow unbounded is BLOCKING.

## Deploy note (not a code finding, but verify)

- **voice-backend is IMAGE-built**, not bind-mounted — a code change requires a
  rebuild to take effect. Flag PRs that change voice-backend code but assume a
  bind-mount hot-reload.

## Security note

- Voice endpoints have had auth-bypass gaps before; a new voice route or handler
  that skips the standard auth/gate is BLOCKING (see `SECURITY.md`).

## Non-blocking

- Prompt wording that doesn't change turn logic or cache prefix, log verbosity,
  minor audio-buffer tuning without measured impact. Report under
  `non_blocking_findings`.
