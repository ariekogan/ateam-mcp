/**
 * ONE answer to "what does actor_id do on ateam_conversation / ateam_test_skill
 * TODAY?" Rendered into both tools' schemas, the bootstrap conversation_flow,
 * the conversation's own _poll block and the tenant CLAUDE.md, so they cannot
 * drift apart. Its own module because agentDoc.js cannot import tools.js
 * (tools.js imports agentDoc.js).
 *
 * Those surfaces promised per-actor threads: "pass the actor_id back to continue
 * the conversation", "the same actor_id maintains conversation context", "use
 * ateam_test_skill / ateam_conversation for per-user-actor flows" (ff1cbd2,
 * 2d59cb6, c631e03, e75feac). None of it is true today (Core C2). The Builder
 * mints test_<ts>_<rand> and hands it back as actor_id, but it forwards to Core
 * only an actor Core can find (realActorId), and an API key with no actor runs
 * as `_system_service` (Core middleware/attachActor.js:496-503).
 *
 * c847a4b then said the opposite of the old promise, and that was false too:
 * "the planner is given no earlier turns … per-user tools see no user". What
 * Core (origin/dev b87074553) actually does with a `_system_service` job:
 *   - its transcript is empty: getChatTranscript.js:40-41 returns nothing for a
 *     `_`-prefixed actor (C3, 9d63f326d);
 *   - but chain continuation is keyed on the actor, not on a thread: a message
 *     classified `continue` (worker/chainContinuation.js:87, :225; `clarify`
 *     needs >50 chars of transcript, :241-247, so never here) inherits the
 *     working memory (:113-118, the plan at :281-296, scratchpads at :305-328)
 *     of the tenant's most recently finished job of the SAME actor within 30
 *     min (:250, store.js:1263-1284, storage/jobs.js:215-231). For
 *     `_system_service` that is whichever thread finished last;
 *   - the job's actor is injected into every tool call (jobRunner.js:206, :834,
 *     :943; utils/callerContext.js:224-226), so a connector receives
 *     `_system_service`, and actorStore throws on it (actorstore-mcp/pool.js:23,
 *     :28-35; server.js:64-72).
 * When C2 ships a real test actor, this is the one place to change.
 */

/**
 * What a per-user tool receives when the job runs as `_system_service`. ONE
 * text, rendered into ACTOR_ID_TODAY and into the scaffolded connector's
 * missing-actor error (tools.js), which named a `_system_service` caller as a
 * cause of a MISSING _adas_actor (4ac07a8, c847a4b). Single quotes only: the
 * scaffold embeds it in a double-quoted string of generated code.
 */
export const SERVICE_ACTOR_AT_TOOLS =
  "a connector's tools receive _adas_actor '_system_service' (Core injects the caller's actor into every call), " +
  "and actorStore refuses a per-actor call made with it ('actorstore-mcp: unsafe actor segment')";

export const ACTOR_ID_TODAY =
  "actor_id TODAY: the id of an actor that EXISTS in this tenant runs the call as that actor (Core refuses an id it cannot find). " +
  "Anything else (no actor_id, or the test_<ts>_<rand> id a response hands back) runs as the tenant's shared _system_service actor. " +
  "That test_ id is a LABEL, not an identity: Core never runs the job as it, and passing it back does not choose what a turn continues. " +
  "A _system_service turn gets no earlier turns (its chat transcript is empty), but a message Core classifies as intent 'continue' " +
  "inherits the plan, notes, constraints, artifacts, tool failures and scratchpads of the tenant's most recently finished " +
  "_system_service chain (last 30 min), whichever thread ran it: two unrelated test threads can share context. " +
  `Per-user tools: ${SERVICE_ACTOR_AT_TOOLS}. ` +
  "Put everything a turn needs into one message, and test per-user behaviour with a real actor's id.";
