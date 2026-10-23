// A BACKGROUND JOB IS A CHAIN OF ITS OWN, AND THE TEXT THAT DESCRIBES A CHAIN SAYS SO.
//
// Core's sys.askAnySkill takes background:true (Core 2026-10-23): the routed skill starts as the first job of a chain of its
// own, whose chain id is its job id, and it keeps running after the job that asked answers. It is not a member of the chain
// that started it, so a chain described as "root + handoffs + askAnySkill subcalls" does not hold it, and chain_done on that
// chain never waits for it. An outside agent that polls chain_done and reads the starting chain's tree would call the run
// finished while the job goes on, and would never find it. The chain tools read it by its job id like any chain, so the texts
// say that, wherever a chain is described that way.
//
// Before this, a Dev Studio run was started on a chain id Core minted that was no job's id, and ateam_get_chain said a card
// keeps every turn on one chain. Neither is how a run is started now.
//
// The 1200-character cut on every core tool description is checked in test/core-description-cut.test.mjs.
//
// Run: node --test test/background-job-chain-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, handlers } from "../src/tools.js";

const tool = (name) => tools.find((t) => t.name === name);
const description = (name) => tool(name).description;
const chainIdParam = (name) => tool(name).inputSchema.properties.chain_id.description;
const boot = await handlers.ateam_bootstrap({}, "background-job-chain-text");

// Every tool that describes a chain as root + handoffs + askAnySkill subcalls, and the way each says a background job is not in it.
const DESCRIBES_A_CHAIN = [
  ["ateam_test_skill", /A background job \(askAnySkill background:true\) is a chain of its own, not in this one/],
  ["ateam_test_status", /A background job \(askAnySkill background:true\) is a chain of its own, not part of the chain that started it: its chain_id is its job_id/],
  ["ateam_get_chain", /A background job \(askAnySkill background:true\) is a chain of its own, not in this tree: pass its job_id as chain_id/],
  ["ateam_chain_status", /A background job \(askAnySkill background:true\) is a chain of its own that chain_done does not wait for: poll it with its job_id as chain_id/],
  ["ateam_test_abort", /A background job \(askAnySkill background:true\) is a chain of its own, not part of the chain that started it: its chain_id is its job_id.*Abort it with its own chain_id/],
];

for (const [name, says] of DESCRIBES_A_CHAIN) {
  test(`${name}: the description says a background job is a chain of its own, read by its job id`, () => {
    assert.match(description(name), says);
  });
}

test("the chain_id parameter of the tools that take one says it once, in the same words", () => {
  const names = ["ateam_test_status", "ateam_get_chain", "ateam_test_abort"];
  const [first, ...rest] = names.map(chainIdParam);
  assert.match(first, /A chain is the whole run: root job \+ every handoff \+ every askAnySkill subcall\. A background job \(askAnySkill background:true\) is a chain of its own, not part of the chain that started it: its chain_id is its job_id, and it goes on after that chain is done\./);
  for (const other of rest) assert.equal(other, first);
});

test("bootstrap's conversation_flow says chain_done does not wait for a background job, and where to poll it", () => {
  const important = boot.conversation_flow._important;
  assert.match(important, /A background job \(askAnySkill background:true\) is a chain of its own/);
  assert.match(important, /its chain_id is its job_id/);
  assert.match(important, /chain_done does not wait for it: poll it with its own job_id as chain_id/);
});

test("only_this_job no longer calls a turn of a Dev Studio card the case it is for", () => {
  const d = tool("ateam_get_chain").inputSchema.properties.only_this_job.description;
  assert.match(d, /Use it for one job of a long chain\./);
  assert.doesNotMatch(d, /Dev Studio/);
});

test("no served text names a run started on a minted chain, or says a card keeps every turn on one chain", () => {
  const served = JSON.stringify({ tools, boot });
  assert.doesNotMatch(served, /sys\.startThread|sys\.awaitThread|startThread|awaitThread/);
  assert.doesNotMatch(served, /keeps (all|every) (its |of its )?turns? on one chain/i);
  assert.doesNotMatch(served, /minted (run )?chain/i);
});
