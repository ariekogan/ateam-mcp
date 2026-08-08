#!/usr/bin/env bash
# The UNATTENDED review. Runs on a timer, reviews what has landed since the last
# checkpoint, and — unlike the interactive path — nobody is reading the plan table
# when it fires.
#
#   .github/scripts/review-scheduled.sh            # codex, cap 3 slices/repo
#   MAX_SLICES=5 .github/scripts/review-scheduled.sh claude
#   .github/scripts/review-scheduled.sh --dry      # decide, print, spend nothing
#
# WHY A CAP. Idle is free: with nothing committed the runner exits "Nothing new to
# review" at zero cost, so a frequent timer is harmless on a quiet repo. The risk is
# the opposite case — two hours of heavy work across four repos is a large unattended
# spend, decided by nobody. So a repo over MAX_SLICES is REPORTED AND SKIPPED, not
# reviewed: its marker does not move, nothing is lost, and the next interactive
# `codex review` picks it up with a human looking at the numbers.
#
# This deliberately does NOT auto-fix, auto-merge, or move any marker beyond what a
# completed slice banks. It reviews and files findings. That is all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEWER="codex"
DRY=0
for a in "$@"; do
  case "$a" in
    codex|claude) REVIEWER="$a" ;;
    --dry)        DRY=1 ;;
  esac
done
MAX_SLICES="${MAX_SLICES:-3}"

# Plan for THIS repo only. Inside Actions the token is scoped to its own repo, so
# every other row came back "repo/branch unreachable" — an alarming note for a
# non-problem, since each repo runs its own scheduler and reviews only itself.
# Outside Actions (a hand run) the full table is still what you want.
THIS_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$THIS_REPO" ]; then
  PLAN=$(node "$SCRIPT_DIR/review-plan.mjs" "$REVIEWER" --json --repo "$THIS_REPO")
else
  PLAN=$(node "$SCRIPT_DIR/review-plan.mjs" "$REVIEWER" --json)
fi

# Decide per repo from the SAME numbers the human table shows.
DECISIONS=$(printf '%s' "$PLAN" | MAX="$MAX_SLICES" node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const max = Number(process.env.MAX);
  for (const r of d.rows) {
    if (!r.slices)            { console.log(`skip\t${r.repo}\t${r.branch||"?"}\t${r.note||"nothing to review"}`); continue; }
    if (r.note)               { console.log(`skip\t${r.repo}\t${r.branch}\t${r.note}`); continue; }
    if (r.slices > max)       { console.log(`hold\t${r.repo}\t${r.branch}\t${r.slices} slices > cap ${max} — left for an interactive review`); continue; }
    console.log(`run\t${r.repo}\t${r.branch}\t${r.slices} slice(s), ${r.commits} commit(s)`);
    // branch travels with the decision so the runner cannot re-derive a different one
  }
')

echo "scheduled review — reviewer: $REVIEWER, cap ${MAX_SLICES} slice(s)/repo"
printf '%s\n' "$DECISIONS" | while IFS=$'\t' read -r what repo branch why; do
  [ -n "${what:-}" ] || continue
  printf '  %-5s %-34s %s\n' "$what" "$repo" "$why"
done

if [ "$DRY" = "1" ]; then echo "(dry run — nothing dispatched)"; exit 0; fi

# A held repo is not a failure, but it must be VISIBLE — an unattended run that
# quietly declines to review is the same as no review at all.
HELD=$(printf '%s\n' "$DECISIONS" | awk -F'\t' '$1=="hold"{print $2": "$4}')
if [ -n "$HELD" ]; then
  echo ""
  echo "⚠️  held back (needs a human to look at the numbers):"
  printf '%s\n' "$HELD" | sed 's/^/     · /'
fi

# Carry the BRANCH the plan decided on. The runner used to re-derive its own, and a
# repo whose pinned branch differs from that guess got planned on one branch and
# reviewed on another — the cap, the cost and the findings would all describe work
# that was never looked at.
RUN=$(printf '%s\n' "$DECISIONS" | awk -F'\t' '$1=="run"{print $2"\t"$3}')
[ -n "$RUN" ] || { echo ""; echo "nothing to review — \$0 spent."; exit 0; }

# Only this repo can be reviewed from this checkout; the runner reads the local
# git history to slice the range. Other repos need their own checkout, so say so
# rather than pretending they were covered.
THIS=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
rc=0
# NOT `printf | while` — a pipeline runs its right-hand side in a SUBSHELL, so `rc`
# set inside it is discarded and the script exits 0 no matter what happened. For an
# UNATTENDED job that is the worst possible bug: a failed review reports success and
# nobody looks. Feed the loop from a here-string so it runs in this shell.
while IFS=$'\t' read -r repo branch; do
  [ -n "$repo" ] || continue
  if [ "$repo" = "$THIS" ]; then
    echo ""
    echo "▶ reviewing $repo (${branch})"
    # Hand the cap DOWN. The decision above used an estimate; only the runner
    # knows the real slice count, so it is the one that must honour the limit.
    REVIEW_BRANCH="$branch" MAX_SLICES="$MAX_SLICES" \
      "$SCRIPT_DIR/codex-review-since.sh" "$REVIEWER" || rc=$?
  else
    echo "  · $repo has work but needs its own checkout — run this script from there"
  fi
done <<< "$RUN"
[ "$rc" = "0" ] || echo "::error::the review did not complete (exit $rc) — see the log above"
exit $rc
