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
  assert.match(def.inputSchema.properties.view.description, /'triggers' = .*REGISTERED.*system_halted/);
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
