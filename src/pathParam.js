// src/pathParam.js
//
// ONE way to put a caller's value into an API URL. Every tool builds its paths
// with apiPath`/deploy/solutions/${solution_id}/…`, never with a bare template.
//
// Why: tools.js pasted ids into paths raw, at over a hundred sites. An id is a
// path SEGMENT, and a raw one can rewrite the request it sits in:
//   - `?` starts a query:  skill_id:"x?force=true"
//   - `#` ends the URL:    solution_id:"walkmate?force=true#"
//   - `..` climbs a level: fetch normalizes /skills/../test/.. away, so
//     ateam_test_abort(skill_id:"..", job_id:"..?force=true") sent
//     DELETE /deploy/solutions/walkmate?force=true, a FORCED tenant wipe with
//     no confirm at all. ateam_delete_skill and ateam_delete_connector did the
//     same with "..?force=true".
// A value that could not be an id is refused before any request is sent; every
// other value is percent-encoded, so it stays one segment.
//
//   test/raw-path-ids.test.mjs holds every API path in tools.js to this.

/** Thrown before any request when a value cannot be a path segment. */
export class InvalidPathParam extends Error {
  constructor(value, why) {
    super(
      `⚠️ REFUSED: ${JSON.stringify(value)} cannot be used as an id in a URL path (${why}). Nothing was sent.`,
    );
    this.code = "INVALID_PATH_PARAM";
  }
}

// `?` `#` start a query or fragment, `%` would smuggle a pre-encoded one
// (%2e%2e is a dot-segment to a URL parser), `\` is a separator to some
// parsers, and whitespace or a control character is in no id.
const NOT_IN_AN_ID = /[?#%\\\s\x00-\x1f\x7f]/;

/**
 * One path segment: the value checked, then percent-encoded. A `/` is allowed
 * and encoded (%2F), because older skill-validators minted job ids that
 * contain one; it cannot climb, since only a whole "." or ".." segment does.
 * @param {unknown} value
 * @returns {string}
 */
export function pathSeg(value) {
  const s = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof s !== "string" || s === "") throw new InvalidPathParam(value, "an id must be a non-empty string");
  if (s === "." || s === "..") throw new InvalidPathParam(value, "a dot segment climbs the path");
  const bad = NOT_IN_AN_ID.exec(s);
  if (bad) throw new InvalidPathParam(value, `it contains ${JSON.stringify(bad[0])}`);
  return encodeURIComponent(s);
}

const RAW_QUERY = Symbol("rawQuery");

/**
 * A query string built elsewhere (URLSearchParams, "?a=b"), appended as is.
 * Only for strings whose values are already encoded.
 * @param {string} qs
 */
export const rawQuery = (qs) => ({ [RAW_QUERY]: qs == null ? "" : String(qs) });

/**
 * The tag for every API path. Before the first `?` in the literal, each value
 * is a path segment (pathSeg). After it, each value is a query value and is
 * percent-encoded. rawQuery(...) is appended untouched wherever it appears.
 * @returns {string}
 */
export function apiPath(strings, ...values) {
  let out = strings[0];
  let inQuery = strings[0].includes("?");
  values.forEach((v, i) => {
    if (v && typeof v === "object" && RAW_QUERY in v) {
      out += v[RAW_QUERY];
      if (v[RAW_QUERY].includes("?")) inQuery = true;
    } else {
      out += inQuery ? encodeURIComponent(String(v)) : pathSeg(v);
    }
    out += strings[i + 1];
    if (strings[i + 1].includes("?")) inQuery = true;
  });
  return out;
}
