/**
 * WHO A TEST RUNS AS — ONE statement, rendered into every ateam-mcp surface
 * that says who a test job runs as: ateam_test_skill's and ateam_conversation's
 * actor_id, ateam_test_voice, ateam_test_connector (KEY_PERSON), bootstrap's
 * conversation_flow, the tenant CLAUDE.md (agentDoc.js) and the scaffolded
 * connector's missing-actor error.
 * Its own module because agentDoc.js cannot import tools.js (tools.js imports
 * agentDoc.js).
 *
 * The words are the Builder's, verbatim: capabilitySpecs.js TEST_RUNS_AS
 * (Builder #103, D7, 4c593eda), served on /spec/skill (conversation_testing
 * key_concepts.actor_id, supports_actor_id, voice who_it_runs_as). The
 * Builder's /spec is the source of truth; when it changes, this is the one
 * place to change here.
 *
 * What it replaced, and why each was wrong after #103: the Builder's test
 * routes now run the job as req.auth.actorId (the key's person, from Core's
 * verify-agent-key), a caller's actor_id only names the thread, and every
 * reply carries ran_as beside actor_id. ateam-mcp still said
 *   - "Omit to auto-generate a test actor (test_<timestamp>_<random> …)"
 *     (ateam_test_skill.actor_id, 2d59cb6);
 *   - "Omit for a new conversation" / "the same actor_id maintains
 *     conversation context" (ateam_conversation, ff1cbd2) — with a person on
 *     the key the thread IS that person;
 *   - "synthetic test actor with no channels" (ateam_test_notification,
 *     836c9c5);
 *   - "use ateam_test_skill / ateam_conversation for per-user-actor flows"
 *     (CLAUDE.md, e75feac; scaffold 4ac07a8) with no word on whose actor;
 *   - "Use the same actor_id you passed to ateam_conversation" for a job's
 *     detail (ed1aa1f) — the job belongs to ran_as, not to that actor_id;
 *   - "Runs the full voice pipeline … end-to-end" (ateam_test_voice, 32dec97).
 */

/**
 * WHO THAT PERSON IS, in the words CORE approved after PRE-1 (2026-10-01).
 *
 * PRE-1 ran live, on the external hosted path and from inside an in-app
 * builder run: a test started with a key runs as the person the key belongs
 * to — ran_as, the actor_id and Core's jobs.actorId all named that person on
 * turn 1, on turn 2, and on ateam_test_connector (no NO_INDIVIDUAL_USER). That
 * test_connector call came after the conversation had latched the session's
 * actor; on a fresh session it ran as _system_service, which Builder #115
 * fixed (CORE review M41-1) — so ateam_test_connector is in the list below.
 * The in-app builder still read its own admin's id in ran_as as a synthetic test
 * id, because "the person" did not say WHICH person. This does, with no name
 * or email lookup. Rendered in ran_as below and in ateam_test_connector's
 * description.
 */
export const KEY_PERSON =
  "the person whose key started the test — the person you are talking to";

/**
 * The reply field. Part of TEST_RUNS_AS below (not a second wording of it), and
 * rendered alone where an ateam-mcp result or description names the field.
 */
export const RAN_AS_IN_REPLY =
  "Every reply's ran_as is the actor the job ran as: " + KEY_PERSON + " — or null for an anonymous run.";

/**
 * A KEY WHOSE PERSON IS GONE (Builder #117, Core 9f32bac37): Core's
 * verify-agent-key refuses it by name and the Builder answers that refusal
 * before anything runs. Part of TEST_RUNS_AS below, byte for byte the
 * Builder's capabilitySpecs.js KEY_OWNER_GONE.
 */
export const KEY_OWNER_GONE =
  "A key whose person has since been deleted, or is no longer active in the workspace, runs nothing: it is refused " +
  "(401 KEY_OWNER_DELETED or KEY_OWNER_INACTIVE) and never run as anyone else, until a workspace owner or admin " +
  "rotates the key in Tokens & Keys (the new key belongs to whoever rotated it) or reactivates that person.";

export const TEST_RUNS_AS =
  "WHO A TEST RUNS AS: a test an agent starts through the Builder with an API key (ateam_conversation, " +
  "ateam_test_skill, ateam_test_connector, ateam_test_voice) runs AS THE PERSON that key belongs to — the signed-in user who generated it " +
  "in Tokens & Keys — so the job, its memory and its per-user data are that person's and show in that person's " +
  "product. actor_id never picks the identity: it names the conversation thread, and with a person on the key the " +
  "thread IS that person (Core keys a conversation by its actor), so a different actor_id is not honoured. Only a " +
  "key no person minted (a service-provisioned key) still runs as before: anonymously, under the test_ thread that " +
  "actor_id names or a fresh one. " + KEY_OWNER_GONE + " " + RAN_AS_IN_REPLY + " A voice test (ateam_test_voice) runs as the person only " +
  "once the voice backend verifies the API key the Builder sends it (Core follow-up); until then it is anonymous — " +
  "or, given a phone_number, the phone caller (phone::<number>) — and its ran_as says so.";
