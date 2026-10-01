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
import { setSessionCredentials } from '../src/api.js';
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

const DONE = 'Done means ateam_get_solution(view:"triggers") lists the trigger with a next run AND system_halted:false.';
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
  assert.match(def.inputSchema.properties.view.description, /'triggers' = .*registered:true\/false.*system_halted/);
});

test('every text that says when a schedule is done says registered:true — the view also lists defined-only triggers', () => {
  const view = TOOLS.tools.find((t) => t.name === 'ateam_get_solution').inputSchema.properties.view.description;
  const spec = TOOLS.tools.find((t) => t.name === 'ateam_get_spec').inputSchema.properties.topic.description;
  const triggersLine = spec.slice(spec.indexOf("'triggers' ="), spec.indexOf("'sub-agent' ="));
  for (const [where, text] of [['get_solution view', view], ['get_spec triggers', triggersLine]]) {
    assert.match(text, /done only when/, `${where} no longer states the done rule`);
    assert.match(text, /registered:true with a next run and system_halted:false/,
      `${where}: "listed" is not "registered" — a trigger only in skill.json is listed with registered:false`);
  }
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
