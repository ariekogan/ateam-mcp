/**
 * ATTACHMENTS ON A TEST MESSAGE — the file a user drops into the chat, sent by a tool.
 *
 * ateam_conversation and ateam_test_skill take `attachments` so an agent (the
 * solution-builder, an outside agent, the canonical e2e) can drive an
 * attachment-driven feature without a human in the browser. They must reach
 * the skill EXACTLY as a file dropped into dev-app does:
 *
 *   dev-app (ai-dev-assistant apps/frontend/src/chat/InputDock.jsx) reads each
 *   file as base64 with the data: prefix stripped and sends
 *     POST /api/chat { goal, …, attachments: [{ data, mimeType, name }] }
 *   Core (apps/backend/server.js /api/chat) stores each one in its artifact
 *   store and the planner analyses it (apps/backend/ai/realPlanner.js).
 *
 * So what leaves here is that list, unchanged: [{ data, mimeType, name }]. The
 * Builder's test routes pass it to Core's /api/chat as the web does.
 *
 * WHAT CORE CAN USE (realPlanner.js, detectIntent.js): image/* becomes a vision
 * block (Core converts HEIC and shrinks oversize images on upload),
 * application/pdf a document block, and text/*, application/json and
 * application/xml inline text. Core STORES anything else and then ignores it:
 * the skill never sees the file and nothing says so. That is refused here,
 * before anything is sent.
 *
 * HOW MUCH: Core parses a request body up to 10 MB (express.json limit "10mb",
 * and the validator and the Builder use the same), and base64 is 4/3 of the
 * file. So one message carries at most 7 MB of files, decoded, all attachments
 * together, which leaves room for the message itself. Core reads at most 10.
 * (dev-app checks 10 MB per FILE, which the same body limit makes unreachable
 * above about 7.5 MB. Its bug, not copied here.)
 *
 * A URL: fetched by THIS process, and only when it runs locally over stdio (the
 * caller's own machine and network). The hosted server does not fetch URLs; a
 * caller there sends the bytes as base64 `data`. Which transport a call arrived
 * on is api.js callTransport, stated by the code that built the server.
 */
import { callTransport } from "./api.js";

export const ATTACHMENT_MAX_ITEMS = 10;
export const ATTACHMENT_MAX_TOTAL_BYTES = 7 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 30_000;
const ITEM_KEYS = new Set(["url", "data", "mimeType", "name"]);
const BASE64_RX = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME_RX = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The one inputSchema entry both tools declare. */
export const ATTACHMENTS_INPUT_SCHEMA = {
  type: "array",
  maxItems: ATTACHMENT_MAX_ITEMS,
  description:
    "Optional files sent with the message, exactly as a file dropped into the chat: Core stores and analyses them the same way " +
    "(image/* → vision, application/pdf → document, text/*, application/json, application/xml → inline text). " +
    "Each item is { data: base64 (no data: prefix), mimeType, name? } OR { url, name?, mimeType? }: exactly one of data or url. " +
    "Up to 10 files and 7 MB in total (decoded) per message: Core accepts a request of at most 10 MB, and base64 adds a third. " +
    "Any other type, or more, is refused before anything is sent. " +
    "A url is fetched by this MCP process only when it runs locally over stdio (its type comes from the response unless you give mimeType, its name from the URL path). " +
    "The hosted server does not fetch URLs: send the file as base64 data.",
  items: {
    type: "object",
    properties: {
      data: { type: "string", description: "The file's bytes, base64-encoded, without a data: prefix." },
      url: { type: "string", description: "http(s) URL of the file. Local stdio only; the hosted server refuses it." },
      mimeType: { type: "string", description: "The file's MIME type. Required with data. With url, overrides the type the server answered with." },
      name: { type: "string", description: "File name shown to the skill (e.g. invoice.pdf). With url, defaults to the URL's last path segment." },
    },
    additionalProperties: false,
  },
};

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

function tooLarge(bytes, detail = "") {
  return refuse(
    "ATTACHMENTS_TOO_LARGE",
    `attachments: ${mb(bytes)} (${bytes} bytes) decoded${detail} is over the ${mb(ATTACHMENT_MAX_TOTAL_BYTES)} ` +
    `(${ATTACHMENT_MAX_TOTAL_BYTES} bytes) cap for all files of one message. Core accepts a request of at most 10 MB, ` +
    "and base64 adds a third. Nothing was sent: send fewer or smaller files.",
  );
}

/** What Core turns into content the skill sees (realPlanner.js); anything else it stores and ignores. */
export function attachmentTypeUsable(mimeType) {
  if (typeof mimeType !== "string" || !MIME_RX.test(mimeType)) return false;
  return mimeType.startsWith("image/")
    || mimeType === "application/pdf"
    || mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/xml";
}

function unsupported(where, mimeType) {
  return refuse(
    "ATTACHMENT_TYPE_UNSUPPORTED",
    `${where}: type ${JSON.stringify(mimeType ?? null)} is not one Core can show the skill. It takes image/*, application/pdf, ` +
    "text/*, application/json and application/xml, and stores anything else without the skill ever seeing it. Nothing was sent.",
  );
}

async function readCapped(res, cap, where) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return { over: declared };
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { over: total, partial: true };
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks) };
}

async function fetchUrl(item, where, budget) {
  let u;
  try { u = new URL(item.url); } catch { throw refuse("ATTACHMENT_INVALID", `${where}.url is not a URL: ${JSON.stringify(item.url)}.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw refuse("ATTACHMENT_INVALID", `${where}.url must be http(s), not ${u.protocol}`);
  }
  let res;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw refuse("ATTACHMENT_FETCH_FAILED", `${where}: could not fetch ${u.href}: ${err?.message || err}. Nothing was sent.`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw refuse("ATTACHMENT_FETCH_FAILED", `${where}: ${u.href} answered HTTP ${res.status}. Nothing was sent.`);
  }
  const answered = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mimeType = item.mimeType ?? answered;
  if (!attachmentTypeUsable(mimeType)) {
    await res.body?.cancel().catch(() => {});
    throw unsupported(`${where} (${u.href})`, mimeType || null);
  }
  const read = await readCapped(res, budget, where);
  if (read.over !== undefined) return { over: read.over, partial: read.partial };
  const segment = u.pathname.split("/").filter(Boolean).pop();
  let name = item.name;
  if (name === undefined && segment) {
    try { name = decodeURIComponent(segment); } catch { name = segment; }
  }
  return { att: { data: read.buf.toString("base64"), mimeType, ...(name !== undefined ? { name } : {}) }, bytes: read.buf.length };
}

/**
 * Check a tool's `attachments` and return what goes on the wire, or throw a
 * named error (err.code) before any request to the Builder.
 * @returns {Promise<Array<{data:string, mimeType:string, name?:string}>|undefined>}
 *   undefined when there are none: the request body then carries no field, as
 *   dev-app sends none.
 */
export async function prepareTestAttachments(attachments) {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) {
    throw refuse("ATTACHMENT_INVALID", "attachments must be a list of { data, mimeType, name? } or { url, name? }.");
  }
  if (attachments.length === 0) return undefined;
  if (attachments.length > ATTACHMENT_MAX_ITEMS) {
    throw refuse("ATTACHMENTS_TOO_MANY", `attachments: ${attachments.length} files; Core reads at most ${ATTACHMENT_MAX_ITEMS} per message. Nothing was sent.`);
  }

  // Everything that can be judged without a request, for every item, first.
  const local = callTransport() === "stdio";
  let dataBytes = 0;
  attachments.forEach((item, i) => {
    const where = `attachments[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw refuse("ATTACHMENT_INVALID", `${where} must be an object { data, mimeType, name? } or { url, name? }.`);
    }
    const extra = Object.keys(item).filter((k) => !ITEM_KEYS.has(k));
    if (extra.length) throw refuse("ATTACHMENT_INVALID", `${where} has unknown field(s) ${extra.join(", ")}: an item takes data, url, mimeType and name.`);
    const hasUrl = item.url !== undefined, hasData = item.data !== undefined;
    if (hasUrl === hasData) throw refuse("ATTACHMENT_INVALID", `${where} needs exactly one of data (base64) or url.`);
    if (item.name !== undefined && (typeof item.name !== "string" || !item.name)) {
      throw refuse("ATTACHMENT_INVALID", `${where}.name must be a non-empty string.`);
    }
    if (hasUrl) {
      if (typeof item.url !== "string" || !item.url) throw refuse("ATTACHMENT_INVALID", `${where}.url must be a string.`);
      if (!local) {
        throw refuse("ATTACHMENT_URL_NOT_FETCHED", `${where}.url: send the file as base64 \`data\`; the hosted server does not fetch URLs. Nothing was sent.`);
      }
      if (item.mimeType !== undefined && !attachmentTypeUsable(item.mimeType)) throw unsupported(where, item.mimeType);
      return;
    }
    if (typeof item.data !== "string" || !item.data) throw refuse("ATTACHMENT_INVALID", `${where}.data must be a non-empty base64 string.`);
    if (item.data.startsWith("data:")) {
      throw refuse("ATTACHMENT_INVALID", `${where}.data starts with "data:": send the base64 payload alone, without the data:<type>;base64, prefix (as dev-app does).`);
    }
    if (!BASE64_RX.test(item.data) || item.data.length % 4 === 1) {
      throw refuse("ATTACHMENT_INVALID", `${where}.data is not base64 (A-Z a-z 0-9 + / with = padding; no whitespace).`);
    }
    if (item.mimeType === undefined) throw refuse("ATTACHMENT_INVALID", `${where}.mimeType is required with data: Core ignores a file without one.`);
    if (!attachmentTypeUsable(item.mimeType)) throw unsupported(where, item.mimeType);
    dataBytes += Buffer.byteLength(item.data, "base64");
  });
  if (dataBytes > ATTACHMENT_MAX_TOTAL_BYTES) throw tooLarge(dataBytes);

  // URLs (local stdio only, checked above), each read no further than what is left of the cap.
  let total = dataBytes;
  const out = [];
  for (const [i, item] of attachments.entries()) {
    if (item.data !== undefined) {
      out.push({ data: item.data, mimeType: item.mimeType, ...(item.name !== undefined ? { name: item.name } : {}) });
      continue;
    }
    const got = await fetchUrl(item, `attachments[${i}]`, ATTACHMENT_MAX_TOTAL_BYTES - total);
    if (got.over !== undefined) throw tooLarge(total + got.over, got.partial ? " (at least; the download was stopped there)" : "");
    total += got.bytes;
    out.push(got.att);
  }
  return out;
}
