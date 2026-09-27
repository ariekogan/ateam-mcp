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
 * as `_system_service` (Core attachActor). Since Core C3 (fdb0cec71) a service
 * actor's planner gets an empty transcript, so the "thread" carries nothing.
 * When C2 ships a real test actor, this is the one place to change.
 */
export const ACTOR_ID_TODAY =
  "actor_id TODAY: the id of an actor that EXISTS in this tenant runs the call as that actor (Core refuses an id it cannot find). " +
  "Anything else (no actor_id, or the test_<ts>_<rand> id a response hands back) runs as the tenant's shared _system_service actor. " +
  "That test_ id is a LABEL, not an identity: Core never runs the job as it, so passing it back does NOT continue a conversation " +
  "(the planner is given no earlier turns), and per-user tools (actorStore, a connector's _adas_actor) see no user. " +
  "Put everything a turn needs into one message, and test per-user behaviour with a real actor's id.";
