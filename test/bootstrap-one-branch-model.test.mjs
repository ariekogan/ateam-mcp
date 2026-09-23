// ateam_bootstrap must not contradict itself INSIDE ONE RESPONSE.
//
// The branch model is deliberate: work on `dev`, ateam_github_promote merges
// dev → main, and build_and_run deploys main. bootstrap is the FIRST thing an
// external agent reads — before any tool description — so whatever it says is
// the model the agent builds against.
//
// It said the opposite from 4eced4f (2026-03-21) until 2026-09-23: "Single-
// branch model: ALL changes go directly to 'main'". That was four months after
// promote became a real dev→main merge (7a75479, 2026-05-19) and a month after
// writes moved to dev (6e4470e).
//
// THEN I FIXED FOUR PLACES AND MISSED TWO, which is worse than leaving it
// alone: an external agent's next run got a response that dated its own former
// error in `branching` while `assistant_behavior_contract.always` still ended
// "ALL changes go directly to main" and `when_to_use_what` still called
// promote "Create a checkpoint (safe-* tag)". The disagreement did not get
// resolved — it moved inside a single tool result, where it is harder to
// notice and impossible to reconcile.
//
// So this test does NOT grep for strings I happened to think of. It walks the
// WHOLE bootstrap response and fails on any surviving claim of the old model,
// wherever it is nested.
//
// Run: node test/bootstrap-one-branch-model.test.mjs
import { handlers } from "../src/tools.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
};

const boot = await handlers.ateam_bootstrap({}, "boot-test");

/** Every string in the response, with the dotted path that reaches it. */
function strings(node, path = "", out = []) {
  if (typeof node === "string") out.push({ path, text: node });
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}
const ALL = strings(boot);

console.log("bootstrap is a response, not a pile of strings");
check("it returned something with strings in it", ALL.length > 50, `${ALL.length} strings`);

// The one place allowed to quote the old model is the note that DATES it, and
// it must be recognisable as a quotation of a past error.
const HISTORY_NOTE = /told every first-turn agent the opposite/;

console.log("no surviving claim of the single-branch model");
const OLD_MODEL = [
  { re: /ALL changes go directly to ['"`]?main/i, why: "the single-branch claim" },
  { re: /[Ss]ingle-branch model/, why: "the single-branch label" },
  { re: /only branch/i, why: '"main is the only branch"' },
  { re: /auto-pushes to main/i, why: '"every deploy pushes main"' },
  { re: /commits? (?:here|to main) automatically/i, why: '"patches commit to main automatically"' },
];
for (const { re, why } of OLD_MODEL) {
  const hits = ALL.filter((s) => re.test(s.text) && !HISTORY_NOTE.test(s.text));
  check(`${why} appears nowhere`, hits.length === 0,
        hits.map((h) => h.path).join(", "));
}

console.log("promote is described as a SHIP, not a checkpoint");
// A tag is a side effect of the merge. Calling it a checkpoint is what left
// agents believing their work was already on main.
// PATH or TEXT. The first cut of this checked only the VALUE for "promote" —
// but `when_to_use_what.ateam_github_promote` has promote in the KEY, so
// restoring the exact string the external agent found ("Create a checkpoint
// (safe-* tag)") slipped straight through. My own mutation caught it.
const mentionsPromote = (s) => /promote/i.test(s.text) || /promote/i.test(s.path);
const checkpointClaims = ALL.filter((s) =>
  mentionsPromote(s) && /creates? a checkpoint|checkpoint \(/i.test(s.text));
check("promote is never called 'create a checkpoint'", checkpointClaims.length === 0,
      checkpointClaims.map((h) => h.path).join(", "));

const safeTag = ALL.filter((s) => /safe-YYYY|safe-\*/.test(s.text) && mentionsPromote(s));
check("promote does not advertise the retired safe-* tag name", safeTag.length === 0,
      safeTag.map((h) => h.path).join(", "));

console.log("the real loop is stated");
const joined = ALL.map((s) => s.text).join("\n");
check("it names dev as where writes land", /lands? on `?dev`?|writes? (?:go to|land on) `?dev`?/i.test(joined));
check("it names promote as the only thing that moves work to main", /ONLY ateam_github_promote|only .{0,20}promote .{0,20}writes it/i.test(joined));
check("it says build_and_run deploys MAIN", /build_and_run deploys MAIN|deploys `?main`?/i.test(joined));
check("it warns that skipping promote is silent", /NOT deployed|not live until|is NOT in this deploy|nothing you wrote is running/i.test(joined));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
