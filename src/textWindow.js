// Reading a big text file in parts, and finding lines in files: ateam_github_read and ateam_get_connector_source.
//
// A tool answer carries about 50 KB (tools.js MAX_RESPONSE_CHARS); a bigger file was cut there, and a 183 KB connector
// file could not be read past its first quarter. Now a file is read by line range (offset = first line, 1-based; limit =
// how many lines), like a code editor's Read, and a file too big for one answer comes back in parts with next_offset.
// One line too long for an answer (a minified bundle) is read in pieces too: char_offset, then next_char_offset.
// `search` finds the lines that contain a text, in one file or in all of a connector's files, with their line numbers;
// it returns as many matches as fit in one answer.

/** The most file text one answer carries: under the ~50 KB cap, with room for the rest of the answer. */
export const WINDOW_CHARS = 40_000;
/** The most matching lines one search returns. */
export const MAX_MATCHES = 200;
const MATCH_TEXT_CHARS = 300;

const whole = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : null);

/**
 * The part of `text` to return, or null when the whole text fits and no range was asked for (the answer is unchanged).
 * @param {string} text
 * @param {{ offset?: number, limit?: number, char_offset?: number }} [range]  offset: first line (1-based); limit: number
 *   of lines; char_offset: where to start inside line `offset` (0-based), for a line too long for one answer
 * @returns {null | { content: string, lines: { from: number, to: number, total: number }, chars?: { from: number, to: number, of: number },
 *   next_offset: number|null, next_char_offset?: number|null, note: string }}
 */
export function lineWindow(text, { offset, limit, char_offset } = {}) {
  const asked = offset != null || limit != null || char_offset != null;
  if (!asked && text.length <= WINDOW_CHARS) return null;
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(1, whole(offset) || 1);
  const at = Math.max(0, whole(char_offset) || 0);
  if (from <= total && (at > 0 || lines[from - 1].length > WINDOW_CHARS)) return linePiece(lines[from - 1], from, total, at);
  const want = limit != null ? Math.max(1, whole(limit) || 1) : total;
  const last = Math.min(total, from + want - 1);
  let end = from - 1;
  let chars = 0;
  for (let i = from; i <= last; i++) {
    const n = lines[i - 1].length + 1;
    if (chars + n > WINDOW_CHARS && i > from) break; // a line too long for one answer starts the next part, read in pieces
    chars += n;
    end = i;
  }
  const next = end < total ? end + 1 : null;
  const note = from > total
    ? `Line ${from} is past the end: the file has ${total} lines.`
    : next
      ? `Lines ${from}-${end} of ${total}. Read on with offset:${next}${end < last ? " (this part stopped early to fit one answer)" : ""}.`
      : `Lines ${from}-${end} of ${total} (to the end of the file).`;
  return { content: lines.slice(from - 1, end).join("\n"), lines: { from, to: end, total }, next_offset: next, note };
}

/** One piece of a line too long for one answer, from character `at`: the next piece, or the line after it, is named. */
function linePiece(line, n, total, at) {
  const content = line.slice(at, at + WINDOW_CHARS);
  const stop = Math.min(line.length, at + content.length);
  const more = stop < line.length;
  const next = more ? n : n < total ? n + 1 : null;
  const note = at >= line.length && at > 0
    ? `Line ${n} has only ${line.length} characters.`
    : more
      ? `Line ${n} is ${line.length} characters long: this is characters ${at}-${stop}. Read on with offset:${n}, char_offset:${stop}.`
      : `The end of line ${n} (characters ${at}-${stop} of ${line.length}).${next ? ` Read on with offset:${next}.` : " That is the end of the file."}`;
  return { content, lines: { from: n, to: n, total }, chars: { from: at, to: stop, of: line.length }, next_offset: next, next_char_offset: more ? stop : null, note };
}

/**
 * The lines that contain `search` (letter case ignored), with their file and line number.
 * @param {Array<{ path: string, content: string, encoding?: string }>} files  binary (base64) files are skipped
 * @param {string} search
 * @returns {{ search: string, matches: Array<{ path: string, line: number, text: string }>, total_matches: number, files_searched: number, truncated: boolean, note?: string }}
 */
export function findLines(files, search) {
  const needle = String(search || "").toLowerCase();
  const matches = [];
  let total = 0;
  let searched = 0;
  let size = 0; // what the matches kept so far take in the answer
  let full = false;
  for (const f of files || []) {
    if (typeof f?.content !== "string" || (f.encoding && f.encoding !== "utf8")) continue;
    searched += 1;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!needle || !lines[i].toLowerCase().includes(needle)) continue;
      total += 1;
      if (full || matches.length >= MAX_MATCHES) continue;
      const t = lines[i].trim();
      const m = { path: f.path, line: i + 1, text: t.length > MATCH_TEXT_CHARS ? t.slice(0, MATCH_TEXT_CHARS - 1) + "…" : t };
      const n = JSON.stringify(m).length + 16; // with the answer's indentation
      if (size + n > WINDOW_CHARS) { full = true; continue; } // no more fit in one answer
      size += n;
      matches.push(m);
    }
  }
  const truncated = total > matches.length;
  return {
    search: String(search || ""),
    matches,
    total_matches: total,
    files_searched: searched,
    truncated,
    note: total === 0
      ? `No line contains "${search}".`
      : `${total} matching line${total === 1 ? "" : "s"}${truncated ? `, the first ${matches.length} shown: search for something narrower` : ""}. Read around one with path and offset (a few lines before its line number).`,
  };
}
