// ateam_get_solution(view:"triggers") — IS THE SCHEDULE REGISTERED, AND WILL IT FIRE?
//
// No tool a builder could call showed Core's trigger registry or the platform
// trigger switch. On 2026-09-28 a builder reported an 8am schedule as set up;
// nothing had checked it, and both trigger-runners had been HALTED since July
// with no reason recorded. This view reads the registry per skill through the
// Builder's probe (GET /deploy/solutions/:id/skills/:sk/triggers → Core
// cp.triggers_api) and reports system_halted — Core's value when Core sends it,
// otherwise null with system_halted_source "not reported by Core yet", never a
// guessed false.
//
// Drives the real handler against a local stand-in Builder.
// Run: node --test test/solution-view-triggers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setSessionCredentials, formatError, KEY_ENVIRONMENTS } from '../src/api.js';
import * as TOOLS from '../src/tools.js';

const SID = 'sess-solution-view-triggers';
let routes = {};
let hits = [];
const server = createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  hits.push(key);
  const reply = routes[key];
  if (reply?.html) { // what Express itself answers for a route it does not have
    res.writeHead(reply.status, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(reply.html);
  }
  res.writeHead(reply?.status || (reply ? 200 : 404), { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply ? reply.body : { error: 'no route' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setSessionCredentials(SID, { apiKey: 'adas_tenanta_00000000000000000000000000000000', apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
test.after(() => server.close());

// Builder #114's decision_guide.done, as the Builder serves it.
const DONE = 'Done means ateam_get_solution(view:"triggers") shows the trigger registered:true, with a next run, AND system_halted:false. system_halted:true: tell the user the schedule is saved but the platform trigger switch is OFF, so it will not run. system_halted:null: Core did not say — report that. Never report that a schedule will run on anything less.';
const probe = (over = {}) => ({
  ok: true, skillSlug: 'x', system_halted: null, system_halted_source: 'not reported by Core yet', halt: null,
  next_run_at_source: 'not reported by Core yet', done_rule: DONE, triggers: [], ...over,
});
const BASE = {
  'GET /deploy/solutions/sol/skills': { body: { skills: [{ id: 'inbox' }, { id: 'digest' }] } },
  'GET /deploy/solutions/sol/skills/inbox/triggers': { body: probe({ skillSlug: 'inbox', triggers: [
    { id: 'morning-scan', registered: true, defined_in_skill: { cron: '0 8 * * *' }, core: { scheduleType: 'cron', scheduleValue: '0 8 * * *', timezone: 'Europe/Berlin', paused: false, next_run_at: null } },
  ] }) },
  'GET /deploy/solutions/sol/skills/digest/triggers': { body: probe({ skillSlug: 'digest', triggers: [
    { id: 'weekly', registered: false, defined_in_skill: { cron: '0 9 * * 1' }, core: null },
  ] }) },
};
async function view(args, extra = {}) {
  routes = { ...BASE, ...extra };
  hits = [];
  const r = await TOOLS.handleToolCall('ateam_get_solution', { solution_id: 'sol', view: 'triggers', ...args }, SID);
  return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
}

test('"triggers" is an offered view, and says what done means', () => {
  const def = TOOLS.tools.find((t) => t.name === 'ateam_get_solution');
  assert.ok(def.inputSchema.properties.view.enum.includes('triggers'), 'view:"triggers" is not offered');
  assert.match(def.inputSchema.properties.view.description, /'triggers' = .*registered:true\/false \(null for an event trigger, with registered_source\).*system_halted/);
});

test('every text that says when a schedule is done says registered:true — the view also lists defined-only triggers', () => {
  const view = TOOLS.tools.find((t) => t.name === 'ateam_get_solution').inputSchema.properties.view.description;
  const spec = TOOLS.tools.find((t) => t.name === 'ateam_get_spec').inputSchema.properties.topic.description;
  const triggersLine = spec.slice(spec.indexOf("'triggers' ="), spec.indexOf("'sub-agent' ="));
  for (const [where, text] of [['get_solution view', view], ['get_spec triggers', triggersLine]]) {
    assert.match(text, /done only when/, `${where} no longer states the done rule`);
    assert.match(text, /registered:true with a next run and system_halted:false/,
      `${where}: "listed" is not "registered" — a trigger only in skill.json is listed with registered:false`);
    assert.match(text, /[Aa]nything less is not done/, `${where}: say what happens short of done`);
    assert.match(text, /done_rule/, `${where}: name what to report instead — the result's done_rule`);
    // No live-environment claim: it goes stale the moment Core reports the
    // switch and the next run (CORE-7) or the halt is lifted (CORE-8). The
    // result's named nulls say what Core did not report; the schema must not.
    assert.doesNotMatch(text, /switch is OFF|\b20\d\d-\d\d-\d\d\b|today/, `${where}: a dated or live-state claim in a static description`);
  }
});

// Builder #128 (3bc59da6): a recurring check the user gave no cadence for gets
// no trigger — the in-app builder had given an untimed check every:"PT5M".
// /spec/triggers decision_guide.implied_repetition_without_cadence is the one
// home; this line POINTS at it (a05eb2b's line named only time words).
test('the get_spec triggers line points at the no-cadence row, without copying it', () => {
  const spec = TOOLS.tools.find((t) => t.name === 'ateam_get_spec').inputSchema.properties.topic.description;
  const triggersLine = spec.slice(spec.indexOf("'triggers' ="), spec.indexOf("'sub-agent' ="));
  assert.ok(triggersLine.includes('a recurring check the user gave no cadence for gets none (ask, add no trigger: decision_guide.implied_repetition_without_cadence)'), triggersLine);
  // A pointer: none of the row's own wording, and no interval offered.
  assert.doesNotMatch(triggersLine, /reasonable" interval|how often, and in which time zone|PT5M/);
});

test('every skill\'s registry is read, and each trigger says which skill it belongs to', async () => {
  const { out } = await view({});
  assert.deepEqual(hits, [
    'GET /deploy/solutions/sol/skills',
    'GET /deploy/solutions/sol/skills/inbox/triggers',
    'GET /deploy/solutions/sol/skills/digest/triggers',
  ]);
  assert.deepEqual(out.skills_checked, ['inbox', 'digest']);
  assert.deepEqual(out.triggers.map((t) => [t.skill_id, t.id, t.registered]), [['inbox', 'morning-scan', true], ['digest', 'weekly', false]]);
  assert.equal(out.triggers[0].core.timezone, 'Europe/Berlin');
  assert.equal(out.done_rule, DONE, 'the done rule is passed on from the Builder, not rewritten here');
});

test('Core has not reported the halt: system_halted is null and SAYS so — never a guessed false', async () => {
  const { out } = await view({});
  assert.equal(out.system_halted, null);
  assert.equal(out.system_halted_source, 'not reported by Core yet');
});

test('Core reports the halt: its value and its record are passed on', async () => {
  const halt = { haltedAt: '2026-07-20T19:19:39Z', haltedBy: 'sysadmin', reason: null, unreadable: false };
  const { out } = await view({}, {
    'GET /deploy/solutions/sol/skills/inbox/triggers': { body: probe({ system_halted: true, system_halted_source: 'core', halt }) },
  });
  assert.equal(out.system_halted, true);
  assert.equal(out.system_halted_source, 'core');
  assert.deepEqual(out.halt, halt);
});

test('with skill_id: that skill only', async () => {
  const { out } = await view({ skill_id: 'digest' });
  assert.deepEqual(hits, ['GET /deploy/solutions/sol/skills/digest/triggers']);
  assert.deepEqual(out.triggers.map((t) => t.id), ['weekly']);
});

test('a Core failure is an error, not an empty registry', async () => {
  const { r } = await view({}, {
    'GET /deploy/solutions/sol/skills/inbox/triggers': { status: 502, body: { ok: false, code: 'CORE_TRIGGERS_UNAVAILABLE', error: 'trigger-runner /triggers failed: 401' } },
  });
  assert.equal(r.isError, true, 'a failed registry read was reported as a result');
  assert.match(r.content[0].text, /trigger-runner \/triggers failed: 401|CORE_TRIGGERS_UNAVAILABLE|502/);
});

test('a deployment WITHOUT the Builder route: named as such — not "check the solution_id or skill_id"', async () => {
  const { r } = await view({}, {
    'GET /deploy/solutions/sol/skills/inbox/triggers': {
      status: 404,
      html: '<!DOCTYPE html><html><head><title>Error</title></head><body><pre>Cannot GET /deploy/solutions/sol/skills/inbox/triggers</pre></body></html>',
    },
  });
  assert.equal(r.isError, true);
  const text = r.content[0].text;
  assert.match(text, /does not serve the trigger probe yet/);
  assert.match(text, /do NOT report the schedule as registered/);
  assert.doesNotMatch(text, /Check the solution_id or skill_id/, 'a missing route read like a wrong id');
});

test('the route\'s own JSON not-found keeps the id hint', async () => {
  const { r } = await view({}, {
    'GET /deploy/solutions/sol/skills/inbox/triggers': { status: 404, body: { error: 'Skill not found' } },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Check the solution_id or skill_id/);
});

test('Core\'s refusal keeps the Builder\'s hint — never "unreachable, try again"', async () => {
  const { r } = await view({}, {
    'GET /deploy/solutions/sol/skills/inbox/triggers': { status: 502, body: {
      ok: false, code: 'CORE_TRIGGERS_UNAVAILABLE', error: 'Core GET /api/triggers: Invalid or missing service token',
      hint: 'Core answered: it could not list the triggers (its error is above). Retrying will not help until that is fixed.',
    } },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Retrying will not help/);
  assert.doesNotMatch(r.content[0].text, /unreachable/i);
});

test('next_run_at_source is "core" when ANY skill\'s registered triggers carried a next run', async () => {
  const { out } = await view({}, {
    'GET /deploy/solutions/sol/skills/digest/triggers': { body: probe({ skillSlug: 'digest', next_run_at_source: 'core', triggers: [
      { id: 'weekly', registered: true, core: { next_run_at: '2026-10-05T07:00:00.000Z' } },
    ] }) },
  });
  assert.equal(out.next_run_at_source, 'core', 'the first skill (no registered triggers) spoke for the whole solution');
});

test('no skills: the sources say nothing was asked — not that Core was silent', async () => {
  const { out } = await view({}, { 'GET /deploy/solutions/sol/skills': { body: { skills: [] } } });
  assert.deepEqual(hits, ['GET /deploy/solutions/sol/skills']);
  assert.equal(out.system_halted, null);
  assert.match(out.system_halted_source, /no skill to check/);
  assert.match(out.next_run_at_source, /no skill to check/);
});

test('the missing-probe hint names no non-production host — shownBase, as every served hint (97f0a42)', () => {
  const html = '<!DOCTYPE html><html><body><pre>Cannot GET /deploy/solutions/sol/skills/inbox/triggers</pre></body></html>';
  const msg = formatError('GET', '/deploy/solutions/sol/skills/inbox/triggers', 404, html, KEY_ENVIRONMENTS.dev);
  const hint = msg.slice(msg.indexOf('Hint:'));
  assert.match(hint, /does not serve the trigger probe yet/, 'the hint under test did not fire — the assertion below would be vacuous');
  assert.ok(!hint.includes(new URL(KEY_ENVIRONMENTS.dev).host), `the hint names the dev host: ${hint}`);
  assert.match(hint, /the dev API/);
  // Production is named as itself.
  assert.match(formatError('GET', '/deploy/solutions/sol/skills/inbox/triggers', 404, html, KEY_ENVIRONMENTS.prod), new RegExp(KEY_ENVIRONMENTS.prod.replace(/[.]/g, '\\.')));
});
