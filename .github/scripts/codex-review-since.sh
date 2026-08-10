#!/usr/bin/env bash
# THE review command. Arie says "review" / "codex review" → this runs.
#
#   .github/scripts/codex-review-since.sh            # review dev since last checkpoint
#   .github/scripts/codex-review-since.sh status     # what would be reviewed
#   .github/scripts/codex-review-since.sh accept     # checkpoint accepted → advance marker
#   .github/scripts/codex-review-since.sh --from <sha>
#
# NO pull request, NO labels, NO audit branches. It dispatches a workflow over the
# commit range, waits, and prints the findings. `dev` is never modified.
#
# THE MARKER is the git tag `codex-reviewed` on origin — shared across sessions and
# machines, so "since the last review" means the same thing everywhere. It moves
# only on `accept`, i.e. after you have actually dealt with the findings.
set -euo pipefail

# Resolve sibling helpers against THIS script, never the caller's cwd. Run from a
# subdirectory, `node .github/scripts/...` simply does not exist — and the failure
# was silent: the resume check fell through to "fresh" and quietly reintroduced the
# very bug the helper was written to fix.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
MARKER_TAG="codex-reviewed"
# Which branch holds the work. `dev` in ai-dev-assistant, but ateam-mobile and the
# Skill Builder have no `dev` at all — hard-defaulting to it made the review simply
# fail there. Fall back to whatever the repo says its default branch is.
BRANCH="${REVIEW_BRANCH:-}"
if [ -z "$BRANCH" ]; then
  # THE PINNED branch from review-repos.json — the same source the plan and the
  # scheduler use. Deriving it as "dev if it exists" picked ateam-mcp's abandoned
  # dev (94 behind main, 0 ahead) while its marker sits on main, so the run refused
  # itself as a reversed diff. One registry, one answer.
  BRANCH=$(node -e '
    const fs=require("fs");
    const here=process.argv[1], repo=process.argv[2];
    for (const p of [".github/review-repos.json", here+"/../review-repos.json"]) {
      try {
        const e=JSON.parse(fs.readFileSync(p,"utf8")).repos.find(r=>r.repo===repo);
        if (e && e.branch) { console.log(e.branch); process.exit(0); }
      } catch {}
    }
    process.exit(1);
  ' "$SCRIPT_DIR" "$REPO" 2>/dev/null || true)
fi
if [ -z "$BRANCH" ]; then
  # Not in the registry: fall back to dev-if-present, then the default branch.
  if git rev-parse -q --verify refs/remotes/origin/dev >/dev/null 2>&1; then
    BRANCH=dev
  else
    BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)
  fi
fi
WF="codex-review-range.yml"
ACTION="${1:-review}"
# WHO reviews: "codex" (OpenAI, independent of the code author) or "claude".
#   REVIEWER=claude .github/scripts/codex-review-since.sh
#   .github/scripts/codex-review-since.sh --reviewer claude
# In chat this is simply "codex review" vs "claude review".
REVIEWER="${REVIEWER:-codex}"
case "$ACTION" in
  --from)     FROM_SHA="${2:-}"; ACTION=review;;
  --reviewer) REVIEWER="${2:-codex}"; ACTION=review;;
  codex|claude) REVIEWER="$ACTION"; ACTION=review;;
esac
case "$REVIEWER" in codex|claude) ;; *) echo "reviewer must be codex|claude"; exit 1;; esac

# --force because the MARKER TAG IS SUPPOSED TO MOVE. Without it git refuses with
# "would clobber existing tag" and, under set -e, the whole script dies silently —
# no output, exit 0, looking exactly like "nothing to review".
git fetch origin --tags --force --quiet
HEAD_SHA=$(git rev-parse "origin/${BRANCH}")
MARKER=$(git rev-parse -q --verify "refs/tags/${MARKER_TAG}^{commit}" 2>/dev/null || true)
# THE baseline is the LAST REVIEW (the codex-reviewed tag) — everything we did
# since then, regardless of what has or hasn't been promoted to main.
FROM="${FROM_SHA:-$MARKER}"

# The marker must be an ANCESTOR of what we are reviewing. If dev was rewritten or
# the marker points at a diverged commit, a two-dot diff silently INVERTS — the
# reviewer would then review the change backwards and "find" the fix as the bug.
if [ -n "$FROM" ] && ! git merge-base --is-ancestor "$FROM" "$HEAD_SHA" 2>/dev/null; then
  echo "❌ baseline ${FROM:0:9} is NOT an ancestor of ${BRANCH} (${HEAD_SHA:0:9})."
  echo "   Reviewing that range would produce a reversed diff. Pass an explicit"
  echo "   --from <sha> on the current history, or re-point the marker with 'accept <sha>'."
  exit 1
fi

show_range() {
  echo "last reviewed : $(git log -1 --format='%h %s' "$FROM")"
  echo "current ${BRANCH}    : $(git log -1 --format='%h %s' "$HEAD_SHA")"
  local n; n=$(git rev-list --count "${FROM}..${HEAD_SHA}")
  local ins; ins=$(git diff --shortstat "${FROM}...${HEAD_SHA}" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
  echo "to review     : ${n} commit(s), ~${ins} insertions"
  [ "$n" -gt 0 ] && git log --oneline "${FROM}..${HEAD_SHA}" | sed 's/^/  /'
  # A review that cannot finish is worse than none — warn before spending.
  [ "${ins:-0}" -gt 900 ] && echo "⚠️  large range — consider 'accept' more often so checkpoints stay reviewable"
  return 0
}

case "$ACTION" in
  status)
    [ -n "$FROM" ] || { echo "No marker yet. Set one: $0 --from <sha>"; exit 0; }
    show_range; exit 0 ;;
  accept)
    git tag -f "$MARKER_TAG" "${2:-$HEAD_SHA}" >/dev/null
    git push -qf origin "refs/tags/${MARKER_TAG}"
    echo "✅ checkpoint accepted — marker → $(git log -1 --format='%h %s' "${2:-$HEAD_SHA}")"
    exit 0 ;;
  review) ;;
  *) echo "usage: $0 [status|accept|--from <sha>]"; exit 1 ;;
esac

[ -n "$FROM" ] || { echo "❌ No '${MARKER_TAG}' marker yet. First run: $0 --from <sha>"; exit 1; }
[ "$(git rev-list --count "${FROM}..${HEAD_SHA}")" -gt 0 ] || { echo "Nothing new to review."; exit 0; }

show_range
echo ""

# ── CHUNKED, CHECKPOINTED REVIEW ───────────────────────────────────────────────
# Reviews are expensive and can die mid-flight (time cap, empty balance). If we
# reviewed the whole range as one shot, a failure at the end threw away everything
# already reviewed — and the next run paid for it all again.
#
# So: split the range at COMMIT BOUNDARIES into slices of about CHUNK_INSERTIONS
# added lines, review them oldest-first, and BANK THE MARKER AFTER EACH SLICE that
# comes back complete. A failure then costs only the current slice; re-running
# resumes from the last banked commit.
# Claude explores per-turn and has a hard turn cap, so it needs smaller slices than
# Codex; a 400-line slice hit error_max_turns and produced nothing.
if [ "$REVIEWER" = "claude" ]; then CHUNK_INSERTIONS="${CHUNK_INSERTIONS:-250}"; else CHUNK_INSERTIONS="${CHUNK_INSERTIONS:-400}"; fi

# Walk the FIRST-PARENT mainline. Plain `rev-list --reverse` also returns commits
# from merged side branches, so a boundary could be OLDER than the previous one —
# the workflow then refused it as a reversed diff (caught live, 2026-08-03). Along
# first-parent every commit is a descendant of the one before it, so slices are
# always ancestry-ordered. Each boundary is re-checked anyway: cheap, and a wrong
# slice wastes a paid review.
# NOTE: no `mapfile` — macOS ships bash 3.2, which does not have it.
BOUNDS=""; slice_start="$FROM"
while IFS= read -r c; do
  [ -n "$c" ] || continue
  git merge-base --is-ancestor "$slice_start" "$c" 2>/dev/null || continue
  ins=$(git diff --shortstat "${slice_start}...${c}" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
  if [ "${ins:-0}" -ge "$CHUNK_INSERTIONS" ]; then BOUNDS="$BOUNDS $c"; slice_start="$c"; fi
done <<EOF
$(git rev-list --reverse --first-parent "${FROM}..${HEAD_SHA}")
EOF
# Always finish at HEAD.
case " $BOUNDS " in *" $HEAD_SHA "*) ;; *) BOUNDS="$BOUNDS $HEAD_SHA";; esac
set -- $BOUNDS

# THE CAP, enforced where slices actually exist. The scheduler decides run-or-hold
# from an ESTIMATE (total insertions / chunk size); the real count comes from
# walking commit boundaries and can be several times larger — a run planned as 3
# slices split into 11. A cap the spender does not enforce is not a cap, so honour
# it here: review the first N slices and leave the rest for the next run. Nothing
# is lost, because the marker is banked after each slice.
#
# The truncation MUST land on BOUNDS, not just on "$@". The slice loop below walks
# $BOUNDS, so capping only the positional parameters left the count and the warning
# capped while every slice was still reviewed and paid for — a cap that announced
# itself and did nothing, which is worse than no cap at all.
CAPPED_AT=""
if [ -n "${MAX_SLICES:-}" ] && [ "$#" -gt "$MAX_SLICES" ]; then
  echo "⚠️  ${#} slices exceeds the cap of ${MAX_SLICES} — reviewing the first ${MAX_SLICES}."
  echo "   The rest is picked up by the next run; the marker advances as each slice completes."
  CAPPED_AT="$#"
  CAPPED=""; i=0
  for b in "$@"; do
    i=$((i+1)); [ "$i" -le "$MAX_SLICES" ] || break
    CAPPED="$CAPPED $b"
  done
  BOUNDS="$CAPPED"
  set -- $CAPPED
fi
TOTAL=$#

echo "reviewer: $REVIEWER"
[ "$TOTAL" -gt 1 ] && echo "Splitting into $TOTAL slice(s) of ~${CHUNK_INSERTIONS} insertions — the marker is banked after each one."

run_slice() {  # $1=from $2=to $3=index
  local f="$1" t="$2" i="$3"
  echo ""
  echo "▶ slice ${i}/${TOTAL}: $(git rev-list --count "${f}..${t}") commit(s)  ${f:0:9}..${t:0:9}"
  local PREV RID CAND ST
  PREV=$(gh run list --repo "$REPO" --workflow "$WF" --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  gh workflow run "$WF" --repo "$REPO" --ref "$BRANCH" -f from_sha="$f" -f to_sha="$t" -f tier=auto -f reviewer="$REVIEWER" >/dev/null
  RID=""
  for _ in $(seq 1 20); do
    sleep 4
    CAND=$(gh run list --repo "$REPO" --workflow "$WF" --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    if [ "$CAND" != "$PREV" ] && [ "$CAND" != "0" ]; then RID="$CAND"; break; fi
  done
  [ -n "$RID" ] || { echo "  ❌ could not identify the dispatched run"; return 1; }
  echo "  run: https://github.com/${REPO}/actions/runs/${RID}"
  for _ in $(seq 1 120); do
    ST=$(gh run view "$RID" --repo "$REPO" --json status --jq .status 2>/dev/null || echo "")
    [ "$ST" = "completed" ] && break
    sleep 30
  done
  local OUT="/tmp/codex-slice-${i}-$$"
  rm -rf "$OUT"; mkdir -p "$OUT"
  gh run download "$RID" --repo "$REPO" -n codex-review-findings -D "$OUT" >/dev/null 2>&1 \
    || { echo "  ❌ no findings artifact — run did not finish"; return 1; }
  node -e '
    const fs=require("fs");
    const v=JSON.parse(fs.readFileSync(process.argv[1]+"/codex-review-output.json","utf8"));
    if (v.incomplete) { console.error("  ❌ INCOMPLETE: "+(v.reason||"unknown")+"\n     "+(v.advice||"")); process.exit(2); }
    const r=v._range||{};
    // Verify BOTH ends. `gh run list --limit 1` picks the newest run, which may be
    // a DIFFERENT session dispatch; matching only `from` let a run that shared a
    // baseline pass, and this same path then force-moves the shared marker tag.
    if ((r.from && r.from!==process.argv[2]) || (r.to && r.to!==process.argv[3])) {
      console.error(`  ❌ artifact is for ${(r.from||"?").slice(0,9)}..${(r.to||"?").slice(0,9)}, expected ${process.argv[2].slice(0,9)}..${process.argv[3].slice(0,9)} — refusing (the marker will NOT be moved).`);
      process.exit(3);
    }
    const b=v.blocking_findings||[], n=v.non_blocking_findings||[];
    console.log(`  VERDICT: ${v.decision}  (${b.length} blocking, ${n.length} non-blocking)`);
    if (v._cost && v._cost.text) console.log(`  💲 slice cost: ${v._cost.text}`);
    if (v.summary) console.log("  "+v.summary.split("\n")[0]);
    for(const f of b) console.log(`\n  🔴 ${f.severity||""} ${f.file}:${f.line} — ${f.title}\n     ${f.required_change||""}`);
    for(const f of n) console.log(`  🟡 ${f.file}:${f.line} — ${f.title}`);
    // accumulate across slices so the dispatcher can group them by area
    const acc="/tmp/codex-last-findings.json";
    let all={blocking_findings:[],non_blocking_findings:[],slices:[]};
    try{ all=JSON.parse(fs.readFileSync(acc,"utf8")); }catch{}
    all.blocking_findings=(all.blocking_findings||[]).concat(b);
    all.non_blocking_findings=(all.non_blocking_findings||[]).concat(n);
    // Re-running the same slice must not double-count it.
    all.slices=(all.slices||[]).filter(s=>!(s.from===r.from&&s.to===r.to));
    all.slices.push({from:r.from,to:r.to,decision:v.decision,summary:v.summary,cost:v._cost||null});
    all.total_usd=all.slices.reduce((a,s)=>a+((s.cost&&s.cost.usd)||0),0);
    all.total_tokens=all.slices.reduce((a,s)=>a+((s.cost&&s.cost.tokens)||0),0);
    fs.writeFileSync(acc, JSON.stringify(all,null,2));
  ' "$OUT" "$f" "$t" || return 1
  # BANK IT: this slice is reviewed, so the next run never pays for it again.
  git tag -f "$MARKER_TAG" "$t" >/dev/null && git push -qf origin "refs/tags/${MARKER_TAG}"
  echo "  ✅ banked — marker now at ${t:0:9}"
  return 0
}

# DO NOT delete the accumulator. A run that banks slices 1-3 and dies on 4 has
# already paid for and moved past 1-3; wiping the file on the resume run threw
# their findings away permanently, because banked slices are never re-reviewed.
# A fresh review (marker still where this run started) legitimately starts empty;
# a resume keeps what is there and de-duplicates by slice range.
# Resume or fresh? Decided by a tested helper — this has been got wrong twice.
# `[ "$FROM" != "$MARKER" ]` could never be true (FROM defaults to MARKER), and
# "the last slice's to equals FROM" is ALSO true after a run that FINISHED, since
# it banks the marker at its final slice and the next review starts there. The
# distinguishing fact is not in the shas: a resume happens because the previous run
# DIED, so a run that completed records it and is never resumed.
if [ -f /tmp/codex-last-findings.json ]; then
  KEPT=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync("/tmp/codex-last-findings.json","utf8"));console.log((a.slices||[]).length)}catch{console.log(0)}')
  if [ "${KEPT:-0}" -gt 0 ]; then
    if [ "$(node "$SCRIPT_DIR/review-accumulator.mjs" mode "$FROM")" = "resume" ]; then
      echo "resuming — keeping findings from ${KEPT} already-banked slice(s)"
    else
      echo "new review — archiving ${KEPT} slice(s) from the previous run"
      mv /tmp/codex-last-findings.json "/tmp/codex-findings-prev-$$.json"
    fi
  fi
fi
i=0; slice_from="$FROM"; FAILED=0
# Iterate "$@" — the SAME list TOTAL was counted from, and the one the cap rewrote.
# Walking $BOUNDS here instead is what let a capped run review every slice anyway.
for b in "$@"; do
  i=$((i+1))
  if ! run_slice "$slice_from" "$b" "$i"; then FAILED=1; break; fi
  slice_from="$b"
done

echo ""
if [ "$FAILED" -eq 1 ]; then
  BANKED=$(git rev-parse --short "$(git rev-parse refs/tags/${MARKER_TAG})")
  node -e '
    try { const a=JSON.parse(require("fs").readFileSync("/tmp/codex-last-findings.json","utf8"));
      const bits=[]; if(a.total_usd) bits.push("$"+a.total_usd.toFixed(2));
      if(a.total_tokens) bits.push(a.total_tokens.toLocaleString()+" tokens");
      if(bits.length) console.log("💲 spent so far: "+bits.join(" · ")); } catch {}
  ' 2>/dev/null || true
  echo "⚠️  stopped at slice ${i}/${TOTAL}. Everything before it is BANKED (marker: ${BANKED})."
  echo "   Re-run the same command to resume — you will not pay for the reviewed slices again."
  exit 1
fi
node -e '
  try { const a=JSON.parse(require("fs").readFileSync("/tmp/codex-last-findings.json","utf8"));
    const bits=[]; if(a.total_usd) bits.push("$"+a.total_usd.toFixed(2));
    if(a.total_tokens) bits.push(a.total_tokens.toLocaleString()+" tokens");
    if(bits.length) console.log("💲 TOTAL for this review: "+bits.join(" · ")); } catch {}
' 2>/dev/null || true
node "$SCRIPT_DIR/review-accumulator.mjs" complete || true
# Report the marker where it ACTUALLY ended up, not HEAD. Under a cap the run stops
# short of HEAD on purpose, and claiming "all slices reviewed, marker at HEAD" told
# you the range was covered when part of it had never been looked at.
MARKER_NOW=$(git rev-parse --short "$(git rev-parse "refs/tags/${MARKER_TAG}")")
if [ -n "$CAPPED_AT" ]; then
  echo "✅ ${TOTAL} of ${CAPPED_AT} slice(s) reviewed and banked (marker at ${MARKER_NOW})."
  echo "   ⚠️  capped — $(( CAPPED_AT - TOTAL )) slice(s) up to $(git rev-parse --short "$HEAD_SHA") are NOT reviewed yet; re-run to continue."
else
  echo "✅ all ${TOTAL} slice(s) reviewed and banked (marker at ${MARKER_NOW})."
fi
echo "   findings: /tmp/codex-last-findings.json"
echo "   dispatch:  node .github/scripts/codex-findings.mjs --file /tmp/codex-last-findings.json"
