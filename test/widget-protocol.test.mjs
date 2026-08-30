// Widget postMessage protocol detector — precision tests.
//
// The first version of this detector matched /correlationId/ ANYWHERE in the
// file, so a correct widget that happened to use that word was reported broken,
// and its `fix_with` would have steered an agent into editing working code.
// GPT review rejected it on exactly that ground. These tests exist to keep the
// detector anchored to protocol STRUCTURE, and the false-positive cases below
// are the point of the file, not padding.
//
// Run: node test/widget-protocol.test.mjs

import { _widgetProtocolProblems } from "../src/tools.js";

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

const WRAP = (body) => `<html><script>${body}</script></html>`;

// ─── The shape the host actually accepts ─────────────────────────────────────
const GOOD = WRAP(`
  window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",
    payload:{requestId:rid,connectorId:"clinic-mcp",tool:t,args:a}}},"*");
  window.addEventListener("message",function(ev){
    var m=(ev.data||{}).message; if(!m) return;
    if(m.type==="mcp-result"){var p=pend.get(m.payload&&m.payload.requestId);}
  });
`);

console.log("valid widget");
check("clean widget reports no problems", _widgetProtocolProblems(GOOD).length === 0);

// ─── FALSE POSITIVES — the reason this file exists ───────────────────────────
console.log("false positives");

// A correct widget that ALSO tracks its own internal correlation id for logging.
const CORRELATION_LOCAL = WRAP(`
  var correlationId = "trace-" + Date.now();      // internal telemetry, not the protocol
  console.log("render", correlationId);
  window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",
    payload:{requestId:rid,connectorId:"c",tool:t,args:a}}},"*");
  if(m.type==="mcp-result"){pend.get(m.payload.requestId);}
`);
check("unrelated local named correlationId is NOT flagged",
  _widgetProtocolProblems(CORRELATION_LOCAL).length === 0);

// The word appearing only in prose/comments must not trip it either.
const CORRELATION_COMMENT = WRAP(`
  // NOTE: we used to send correlationId here; the host wants requestId.
  window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",
    payload:{requestId:rid,connectorId:"c",tool:t,args:a}}},"*");
  if(m.type==="mcp-result"){pend.get(m.payload.requestId);}
`);
check("correlationId in a comment is NOT flagged",
  _widgetProtocolProblems(CORRELATION_COMMENT).length === 0);

// Not a host-protocol widget at all.
check("html without postMessage is NOT flagged",
  _widgetProtocolProblems("<html><body>static</body></html>").length === 0);
check("non-string input is NOT flagged", _widgetProtocolProblems(null).length === 0);

// A page posting to something OTHER than the host must not be judged.
const OTHER_TARGET = WRAP(`
  someIframe.postMessage({source:"my-own-thing",message:{type:"tool.call"}},"*");
`);
check("postMessage from a non-adas-plugin source is NOT flagged",
  _widgetProtocolProblems(OTHER_TARGET).length === 0);

// ─── TRUE POSITIVES — each fatal on its own ──────────────────────────────────
console.log("true positives");

const OLD_PROTOCOL = WRAP(`
  window.parent.postMessage({source:"adas-plugin",pluginId:"d",
    message:{type:"tool.call",toolName:t,args:a,correlationId:cid}},"*");
  if(m.type==="tool.response"){var p=pend.get(m.payload&&m.payload.correlationId);}
`);
const oldProblems = _widgetProtocolProblems(OLD_PROTOCOL);
check("the shipped-broken widget is flagged", oldProblems.length >= 3);
check("  names tool.call on send", oldProblems.some((p) => p.includes('"tool.call"')));
check("  names correlationId on receive", oldProblems.some((p) => p.includes("payload.correlationId")));
check("  names tool.response on receive", oldProblems.some((p) => p.includes('"tool.response"')));

// Right name, wrong key — the near-miss my own first correction shipped.
const TYPE_NOT_ACTION = WRAP(`
  window.parent.postMessage({source:"adas-plugin",
    message:{type:"mcp-call",payload:{requestId:r,connectorId:"c",tool:t}}},"*");
  if(m.type==="mcp-result"){pend.get(m.payload.requestId);}
`);
const nearMiss = _widgetProtocolProblems(TYPE_NOT_ACTION);
check("type:'mcp-call' (instead of action) is flagged", nearMiss.length === 1);
check("  and says the host matches on message.ACTION",
  nearMiss[0].includes("ACTION"));

// Sends the request id under the wrong key.
const SENDS_CORRELATION = WRAP(`
  window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",
    payload:{correlationId:cid,connectorId:"c",tool:t,args:a}}},"*");
`);
check("sending correlationId in the payload is flagged",
  _widgetProtocolProblems(SENDS_CORRELATION).some((p) => p.includes("request id as correlationId")));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
