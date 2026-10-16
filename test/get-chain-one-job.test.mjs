// A DEV STUDIO CARD KEEPS EVERY TURN ON ONE CHAIN, AND ateam_get_chain MUST LET YOU READ ANY OF THEM.
//
// Core answers any job id of a chain with the SAME whole chain (every job's steps in one array, oldest job
// first). The 50KB answer cap used to cut the tail of that array mid-token, so on a card the first turn filled
// the answer and every later turn was unreadable: on 2026-10-16 turn 3 of a card reported "full stop added,
// live on dev" and nothing could show what it had done. The `job_id` argument was documented as "that job's
// tree", which it never was.
//
//   - a chain over the cap now comes back as VALID JSON that lists every job and outlines every step
//   - only_this_job:true returns the steps of that one job (arguments and results included)
//   - an id that is not a job of the chain is refused WITH the jobs the chain does have
//
// Run: node --test test/get-chain-one-job.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { setSessionCredentials } from "../src/api.js";
import { createServer } from "../src/server.js";
import { scopeChainToJob, formatResultForTest } from "../src/tools.js";

const CAP = 50_000;

/** A card's chain: one job per turn, every step carrying a big result like a real dev.save does. */
function cardChain({ jobs = 3, stepsPerJob = 40, resultChars = 400 } = {}) {
  const chainJobs = [];
  const executionSteps = [];
  for (let j = 1; j <= jobs; j++) {
    const jobId = `job_turn${j}`;
    chainJobs.push({ jobId, skill: "coder", status: "done", relation: j === 1 ? "root" : "handoff", depth: 0, goal: `turn ${j}` });
    for (let s = 0; s < stepsPerJob; s++) {
      executionSteps.push(
        s % 5 === 4
          ? { tool: "sdk.thinking", status: "done", result: "x".repeat(resultChars), _jobId: jobId, _skill: "coder" }
          : { tool: s % 2 ? "dev.save" : "dev.patch", status: s === 7 ? "failed" : "done", reason: `turn ${j} step ${s}`, args: { path: `f${s}.js` }, result: "r".repeat(resultChars), _jobId: jobId, _skill: "coder" },
      );
    }
  }
  return { ok: true, data: { id: "card-1", goal: "Add a full stop", status: "done", chainJobs, executionSteps } };
}

const SID = "sess-get-chain-one-job";
let client;
let upstream;
let listed;
let hits = [];
let served;

before(async () => {
  upstream = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(served));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${upstream.address().port}`,
    explicit: true,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(SID).connect(serverSide);
  client = new Client({ name: "get-chain-one-job-test", version: "1" });
  await client.connect(clientSide);
  listed = (await client.listTools()).tools;
});
after(async () => { await client?.close(); upstream?.close(); });

test("(control) the synthetic card chain really is over the cap", () => {
  assert.ok(JSON.stringify(cardChain(), null, 2).length > CAP);
});

test("scopeChainToJob keeps one job's steps whole and counts the rest", () => {
  const chain = cardChain();
  const scoped = scopeChainToJob(chain, "job_turn3");
  const steps = scoped.data.executionSteps;
  assert.equal(steps.length, 40);
  assert.ok(steps.every((s) => s._jobId === "job_turn3"));
  assert.ok(steps.some((s) => s.args && s.result), "arguments and results stay");
  assert.deepEqual(scoped.data._scoped, { only_this_job: "job_turn3", steps_in_this_job: 40, steps_in_other_jobs: 80 });
  assert.equal(scoped.data.chainJobs.length, 3, "the chain's jobs stay listed");
  assert.equal(chain.data.executionSteps.length, 120, "the input is not changed");
});

test("scopeChainToJob refuses an id that is not a job of the chain, and lists the jobs", () => {
  assert.throws(() => scopeChainToJob(cardChain(), "card-1"), (e) => /"card-1" is not one/.test(e.message) && /job_turn1 \(coder, done\).*job_turn3/.test(e.message));
});

test("scopeChainToJob leaves an error answer alone", () => {
  const err = { ok: false, error: "NOT_FOUND" };
  assert.equal(scopeChainToJob(err, "job_x"), err);
});

test("a chain over the cap is valid JSON, within the cap, with EVERY job and the way to read one in full", () => {
  const text = formatResultForTest(cardChain(), "ateam_get_chain");
  assert.ok(text.length <= CAP, `${text.length} chars`);
  const out = JSON.parse(text); // the old tail-slice was not parseable
  assert.deepEqual(out.data.chainJobs.map((j) => j.jobId), ["job_turn1", "job_turn2", "job_turn3"]);
  assert.deepEqual(Object.keys(out.data.steps_outline), ["job_turn1", "job_turn2", "job_turn3"], "the LAST turn is there, not only the first");
  assert.equal(out.data.steps_total, 120);
  for (const job of Object.values(out.data.steps_outline)) {
    assert.equal(job.steps, 40);
    assert.equal(job.thinking_steps_not_listed, 8);
  }
  assert.match(out._truncation, /only_this_job/);
  assert.match(out._truncation, /ateam_get_chain/);
  assert.doesNotMatch(text, /rrrrrrrrrr/, "results are left out of the outline");
});

test("a chain too big even for its outline still comes back as valid JSON that names what was left out", () => {
  const text = formatResultForTest(cardChain({ jobs: 3, stepsPerJob: 3000, resultChars: 10 }), "ateam_get_chain");
  assert.ok(text.length <= CAP, `${text.length} chars`);
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out.data.steps_outline), ["job_turn1", "job_turn2", "job_turn3"]);
  for (const job of Object.values(out.data.steps_outline)) assert.ok(job.rows_left_out > 0, "the rows left out are counted per job");
  assert.match(out._truncation, /left out/);
});

test("thousands of jobs: still valid JSON within the cap, and says the job list is cut", () => {
  const text = formatResultForTest(cardChain({ jobs: 3000, stepsPerJob: 1 }), "ateam_get_chain");
  assert.ok(text.length <= CAP, `${text.length} chars`);
  const out = JSON.parse(text);
  assert.match(out._truncation, /job list is cut/);
});

test("a chain under the cap is returned whole", () => {
  const small = cardChain({ jobs: 2, stepsPerJob: 3, resultChars: 20 });
  assert.deepEqual(JSON.parse(formatResultForTest(small, "ateam_get_chain")), small);
});

test("another tool's oversized answer is not turned into a chain outline", () => {
  const text = formatResultForTest(cardChain(), "ateam_get_solution");
  assert.doesNotMatch(text, /steps_outline/);
});

test("the schema accepts only_this_job as a boolean and refuses anything else", () => {
  const schema = listed.find((t) => t.name === "ateam_get_chain").inputSchema;
  assert.ok(schema.properties.only_this_job, "only_this_job is not declared");
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  assert.equal(validate({ job_id: "job_turn2", only_this_job: true }).valid, true);
  assert.equal(validate({ job_id: "job_turn2", only_this_job: "yes" }).valid, false);
});

test("the description tells a reader how to get one job, and the job_id text no longer says it narrows the tree", () => {
  const t = listed.find((x) => x.name === "ateam_get_chain");
  assert.match(t.description, /only_this_job: true/);
  assert.doesNotMatch(t.inputSchema.properties.job_id.description, /that job's tree/i);
});

test("end to end: only_this_job returns the steps of that job, in full, through the real protocol", async () => {
  served = cardChain();
  hits = [];
  const r = await client.callTool({ name: "ateam_get_chain", arguments: { job_id: "job_turn3", only_this_job: true } });
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.ok(hits.includes("GET /deploy/jobs/job_turn3/chain"), `hit: ${hits.join(", ")}`);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.data.executionSteps.length, 40);
  assert.ok(out.data.executionSteps.every((s) => s._jobId === "job_turn3"));
  assert.equal(out.data._scoped.steps_in_other_jobs, 80);
  assert.equal(out._truncation, undefined, "one job fits the answer: nothing was cut");
});

test("end to end: the same call with a card id refuses and lists the jobs", async () => {
  served = cardChain();
  const r = await client.callTool({ name: "ateam_get_chain", arguments: { job_id: "card-1", only_this_job: true } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /job_turn1.*job_turn2.*job_turn3/);
});

test("end to end: without only_this_job a long chain is an outline of every job, not the first turn's tail", async () => {
  served = cardChain();
  const r = await client.callTool({ name: "ateam_get_chain", arguments: { chain_id: "card-1" } });
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(Object.keys(out.data.steps_outline), ["job_turn1", "job_turn2", "job_turn3"]);
});
