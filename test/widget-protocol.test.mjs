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


// ─── Per-message isolation (GPT review, round 2) ─────────────────────────────
// The previous implementation concatenated a 400-char window of EVERY
// postMessage into one blob. Two consequences it was rejected for:
//   1. source:"adas-plugin" in one call made unrelated calls judged as protocol
//   2. a send object longer than the window was inspected only in part
console.log("per-message isolation");

// A correct ADAS send, PLUS an unrelated postMessage that happens to contain
// the old protocol words. Only the ADAS one is the protocol.
const MIXED = WRAP(`
  window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",
    payload:{requestId:r,connectorId:"c",tool:t,args:a}}},"*");
  analyticsFrame.postMessage({source:"vendor-sdk",message:{type:"tool.call",correlationId:x}},"*");
  if(m.type==="mcp-result"){pend.get(m.payload.requestId);}
`);
check("a foreign postMessage with tool.call does NOT contaminate a valid widget",
  _widgetProtocolProblems(MIXED).length === 0);

// The reverse: a broken ADAS send must still be caught when a VALID-looking
// foreign message sits next to it.
const MIXED_BROKEN = WRAP(`
  otherFrame.postMessage({source:"vendor-sdk",message:{action:"mcp-call",payload:{requestId:1}}},"*");
  window.parent.postMessage({source:"adas-plugin",message:{type:"tool.call",toolName:t,correlationId:c}},"*");
`);
check("a broken ADAS send is still caught beside a valid foreign message",
  _widgetProtocolProblems(MIXED_BROKEN).some((p) => p.includes('"tool.call"')));

// An object far longer than the old 400-character window, with the defect at
// the END — the case the truncation could not see.
const padding = Array.from({ length: 40 }, (_, i) => `field${i}:"${"x".repeat(20)}"`).join(",");
const LONG_OBJECT = WRAP(`
  window.parent.postMessage({source:"adas-plugin",${padding},
    message:{type:"tool.call",toolName:t,args:a,correlationId:c}},"*");
`);
check("defect beyond 400 chars into the object is still found (no window)",
  _widgetProtocolProblems(LONG_OBJECT).some((p) => p.includes('"tool.call"')));

// Nested braces and strings containing braces must not end extraction early.
const NESTED = WRAP(`
  window.parent.postMessage({source:"adas-plugin",note:"a } inside a string",
    message:{action:"mcp-call",payload:{requestId:r,connectorId:"c",tool:t,args:{deep:{deeper:{x:1}}}}}},"*");
  if(m.type==="mcp-result"){pend.get(m.payload.requestId);}
`);
check("braces inside strings and nested objects do not break extraction",
  _widgetProtocolProblems(NESTED).length === 0);

// Each defect reported once even across several bad sends.
const TWO_BAD = WRAP(`
  window.parent.postMessage({source:"adas-plugin",message:{type:"tool.call",toolName:"a"}},"*");
  window.parent.postMessage({source:"adas-plugin",message:{type:"tool.call",toolName:"b"}},"*");
`);
check("duplicate findings are collapsed",
  _widgetProtocolProblems(TWO_BAD).filter((p) => p.includes('"tool.call"')).length === 1);


// ─── Messages to the PARENT are judged whatever they say about themselves ────
// RUN5-16. ateam_create_plugin's scaffold sent
//   window.parent?.postMessage({ type:"adas-plugin", action:"mcpCall", ... })
// The linter only judged objects carrying source:"adas-plugin", so a message
// that got the SOURCE wrong was never looked at — the host drops it, silently —
// and the same page passed ateam_verify and create_plugin's "it will render".
// The receiver decides, not the sender's own label. Host rules: Core
// packages/widget-surface/src/attachHostBridge.js:42 (source), :45-56 (action,
// payload.requestId), mcpProxy.js:26 (connectorId + tool).
console.log("messages to the parent");

// The scaffold's send AND receive, verbatim from ae85a46 (unchanged to this fix).
const OLD_SCAFFOLD = WRAP(`
  const listener = (e) => {
    if (e?.data?.type !== "adas-host") return;
    if (e?.data?.requestId !== id) return;
  };
  window.parent?.postMessage({
    type: "adas-plugin",
    action: "mcpCall",
    requestId: id,
    tool, args, connectorId,
  }, "*");
  window.parent?.postMessage({ type: "adas-plugin", action: "ready" }, "*");
`);
const scaffoldProblems = _widgetProtocolProblems(OLD_SCAFFOLD);
check("the shipped scaffold's send is flagged", scaffoldProblems.length >= 3);
check("  names the missing source", scaffoldProblems.some((p) => p.includes('without source:"adas-plugin"')));
check("  names the action the host does not know", scaffoldProblems.some((p) => p.includes('action:"mcpCall"')));
check("  names the receive side comparing type to adas-host", scaffoldProblems.some((p) => p.includes('"adas-host"') && p.includes("never matches")));

check("a flat message to window.parent with no source is flagged",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({action:"mcp-call",requestId:1,tool:"t"},"*")`))
    .some((p) => p.includes('without source:"adas-plugin"')));
check("  also to bare parent?.",
  _widgetProtocolProblems(WRAP(`parent?.postMessage({type:"adas-plugin",action:"x"},"*")`)).length >= 2);
check("  also to window.top.",
  _widgetProtocolProblems(WRAP(`window.top.postMessage({foo:1},"*")`)).some((p) => p.includes("without source")));
check("a wrong ACTION is flagged even with the right source",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"mcpCall",payload:{requestId:1,connectorId:"c",tool:"t"}}},"*")`))
    .some((p) => p.includes('action:"mcpCall"') && p.includes("hyphen")));

console.log("not the parent, not judged");
check("postMessage to a sibling frame with no source is NOT flagged",
  _widgetProtocolProblems(WRAP(`panel.contentWindow.postMessage({type:"theme",value:"dark"},"*")`)).length === 0);
check("a name that merely ends in 'parent' is NOT the parent",
  _widgetProtocolProblems(WRAP(`myparent.postMessage({type:"theme"},"*"); grandparent.postMessage({a:1},"*")`)).length === 0);
check("a message built elsewhere and passed by name is not judged",
  _widgetProtocolProblems(WRAP(`const m = {type:"adas-plugin"}; window.parent.postMessage(m,"*")`)).length === 0);

console.log("every message the host acts on stays clean");
const MCP_OK = `source:"adas-plugin",message:{action:"mcp-call",payload:{requestId:r,connectorId:c,tool:t,args:a}}`;
check("mcp-call with all three keys", _widgetProtocolProblems(WRAP(`window.parent.postMessage({${MCP_OK}},"*")`)).length === 0);
check("close (phone only)", _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",action:"close"},"*")`)).length === 0);
check("select-actor", _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"select-actor",payload:{actorId:a}}},"*")`)).length === 0);
check("plugin.event", _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.event",payload:{event:"e"}}},"*")`)).length === 0);
check("open-job", _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{type:"open-job",payload:{jobId:j}}},"*")`)).length === 0);
// A command reply carries the COMMAND's correlationId: it is its protocol, not a mislabelled requestId.
check("plugin.command.result with correlationId is NOT 'the request id as correlationId'",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{correlationId:cid,result:r}}},"*")`)).length === 0);

console.log("an mcp-call the host cannot route");
const noConnector = _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",payload:{requestId:r,tool:t,args:a}}},"*")`));
check("no connectorId in an inline payload is flagged", noConnector.length === 1 && noConnector[0].includes("connectorId"));
check("  naming what the host answers", (noConnector[0] || "").includes("Missing connectorId or tool"));
check("no requestId is flagged",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",payload:{connectorId:c,tool:t}}},"*")`)).some((p) => p.includes("requestId")));
check("a payload with a spread is NOT judged (its keys are not all visible)",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",payload:{...base,requestId:r}}},"*")`)).length === 0);
check("a payload passed by name is NOT judged",
  _widgetProtocolProblems(WRAP(`window.parent.postMessage({source:"adas-plugin",message:{action:"mcp-call",payload}},"*")`)).length === 0);

// ─── A plugin that ANSWERS plugin.command ────────────────────────────────────
// The host pushes { type:"plugin.command", action:"plugin.command", payload:{
// command, args, correlationId } } (Core WidgetSurface.jsx dispatchToIframe;
// the phone's usePluginBridge.ts dispatchToWebView the same) and the widget MUST
// reply { type:"plugin.command.result", payload:{ correlationId, result, error }
// } with the SAME correlationId — the host reads payload.correlationId
// (attachHostBridge.js:50) and ignores a reply without it. The RECEIVE check
// below used to flag every such widget, because it read payload.correlationId
// off the host's command: "reads payload.correlationId from the host response —
// the host sends payload.requestId". Its fix_with would have steered an author
// to rewrite a working command handler. The host side of each case is run for
// real in plugin-scaffold-host-protocol.test.mjs.
console.log("a widget that answers plugin.command");
const CMD_REPLY_OK = `window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{correlationId:cid,result:{ok:true}}}},"*");`;
const CMD_WIDGET = (body) => WRAP(`
  window.addEventListener("message",function(e){var m=e.data&&e.data.message;
    if(m&&m.type==="plugin.command"){var cid=m.payload.correlationId; ${body}}});
`);
check("the correct widget (reads the command's correlationId, echoes it) is NOT flagged",
  _widgetProtocolProblems(CMD_WIDGET(CMD_REPLY_OK)).length === 0);
check("  destructured: const { correlationId, command } = payload",
  _widgetProtocolProblems(WRAP(`
    window.addEventListener("message",function(e){var m=e.data.message;
      if(m.type==="plugin.command"){const { correlationId, command } = m.payload;
        window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{correlationId,result:command}}},"*");}});`)).length === 0);
check("  matched on message.action (the renderer convention) and optional chaining",
  _widgetProtocolProblems(WRAP(`
    window.addEventListener("message",function(e){var m=e.data.message;
      if(m.action==="plugin.command"){var cid=m.payload?.correlationId;
        window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{correlationId:cid,error:"nope"}}},"*");}});`)).length === 0);
check("  flat reply form (the host reads d.type / d.payload too)",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",type:"plugin.command.result",payload:{correlationId:cid,error:"x"}},"*");`)).length === 0);
check("  a widget that also makes a correct tool call stays clean",
  _widgetProtocolProblems(CMD_WIDGET(CMD_REPLY_OK + ` window.parent.postMessage({${MCP_OK}},"*");`)).length === 0);
check("  early return on a different type (!==) still counts as handling commands",
  _widgetProtocolProblems(WRAP(`
    window.addEventListener("message",function(e){var m=e.data.message; if(m.type!=="plugin.command") return;
      var cid=m.payload.correlationId; ${CMD_REPLY_OK}});`)).length === 0);
check("a page that handles NO command and reads payload.correlationId is still flagged",
  _widgetProtocolProblems(WRAP(`window.addEventListener("message",function(e){pend.get(e.data.message.payload.correlationId);}); window.parent.postMessage({${MCP_OK}},"*");`))
    .some((p) => p.includes("reads payload.correlationId")));

console.log("a command reply the host cannot match");
const noId = _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{requestId:cid,result:{ok:true}}}},"*");`));
check("a reply keyed by requestId (not correlationId) is flagged", noId.length === 1 && noId[0].includes("no correlationId"));
check("  and says what happens", (noId[0] || "").includes("times out after 15 s"));
check("a reply with no id at all is flagged",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{result:{ok:true}}}},"*");`)).some((p) => p.includes("no correlationId")));
const actionShape = _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{action:"plugin.command.result",payload:{correlationId:cid,result:{ok:true}}}},"*");`));
check("a reply sent as message.ACTION (the host matches message.TYPE) is flagged",
  actionShape.length === 1 && (actionShape[0] || "").includes('message.ACTION:"plugin.command.result"') && (actionShape[0] || "").includes("message.TYPE"));
check("a reply under another type name is flagged",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.response",payload:{correlationId:cid}}},"*");`))
    .some((p) => p.includes('type:"plugin.command.response"')));
check("a reply that is not signed source:\"adas-plugin\" is flagged",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({type:"adas-plugin",message:{type:"plugin.command.result",payload:{correlationId:cid}}},"*");`))
    .some((p) => p.includes("without source")));
check("a reply payload built elsewhere is NOT judged",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload}},"*");`)).length === 0);
check("a reply payload with a spread is NOT judged",
  _widgetProtocolProblems(CMD_WIDGET(`window.parent.postMessage({source:"adas-plugin",message:{type:"plugin.command.result",payload:{...base,result:r}}},"*");`)).length === 0);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
