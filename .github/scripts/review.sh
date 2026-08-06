#!/usr/bin/env bash
# The scheduled review, across ALL CORE repos, in three words.
#
#   .github/scripts/review.sh show     # is it on? what has it done? what is pending?
#   .github/scripts/review.sh start [codex|claude]   # on, everywhere (default codex)
#   .github/scripts/review.sh stop     # turn it off, everywhere, immediately
#
# One command that covers every repo, because the alternative is remembering four
# `gh variable set` invocations and getting one of them wrong — leaving a repo
# quietly reviewing (or quietly not) while you believe the opposite.
#
# start/stop flip the repo variable SCHEDULED_REVIEW. That takes effect on the next
# tick with no code change, no push, and no deploy — and `stop` cannot orphan
# anything, because a slice already banked stays banked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-show}"
WANT_REVIEWER="${2:-}"
case "${WANT_REVIEWER}" in ''|codex|claude) ;; *) echo "reviewer must be codex or claude"; exit 1;; esac
WF="review-scheduled.yml"

# The same registry the plan and the runner use — never a second list to drift.
REPOS=$(node -e '
  const fs = require("fs");
  for (const p of [".github/review-repos.json", process.argv[1] + "/../review-repos.json"]) {
    try { console.log(JSON.parse(fs.readFileSync(p, "utf8")).repos.map(r => r.repo).join("\n")); process.exit(0); } catch {}
  }
  process.exit(1);
' "$SCRIPT_DIR") || { echo "❌ cannot read .github/review-repos.json"; exit 1; }

var_of() {     # $1=repo $2=var  → value or empty
  gh variable list --repo "$1" --json name,value \
    --jq ".[]|select(.name==\"$2\")|.value" 2>/dev/null || true
}
state_of()    { case "$(var_of "$1" SCHEDULED_REVIEW)" in off) echo off;; *) echo on;; esac; }
reviewer_of() { local v; v=$(var_of "$1" SCHEDULED_REVIEWER); echo "${v:-codex}"; }

case "$ACTION" in
  show)
    printf '%-34s %-5s %-7s %-9s %s\n' "REPO" "SCHED" "BY" "LAST RUN" "PENDING"
    printf '%-34s %-5s %-7s %-9s %s\n' "$(printf '─%.0s' {1..34})" "─────" "───────" "─────────" "──────────────────────"
    while read -r repo; do
      [ -n "$repo" ] || continue
      st=$(state_of "$repo")
      # Last scheduled run: when, and how it ended.
      last=$(gh run list --repo "$repo" --workflow "$WF" --limit 1 \
               --json status,conclusion,createdAt \
               --jq '.[0] | (.createdAt[5:16] | sub("T"; " ")) + " " + (.conclusion // .status)' 2>/dev/null || true)
      printf '%-34s %-5s %-7s %-9s ' "$repo" "$st" "$(reviewer_of "$repo")" "${last:-never}"
      # What a review would cover right now, from the shared plan.
      node "$SCRIPT_DIR/review-plan.mjs" codex --json --repo "$repo" 2>/dev/null \
        | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const r=d.rows[0]||{};
                   console.log(r.note ? r.note : (r.slices ? `${r.commits} commit(s), ${r.slices} slice(s)` : "up to date"));
                  }catch{console.log("?")}'
    done <<< "$REPOS"
    echo ""
    echo "in flight:"
    IF=""
    while read -r repo; do
      [ -n "$repo" ] || continue
      r=$(gh run list --repo "$repo" --workflow "$WF" --status in_progress --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
      [ -n "$r" ] && { echo "  $repo → https://github.com/$repo/actions/runs/$r"; IF=1; }
    done <<< "$REPOS"
    [ -n "$IF" ] || echo "  (none)"
    ;;

  start|stop)
    want=$([ "$ACTION" = "start" ] && echo on || echo off)
    while read -r repo; do
      [ -n "$repo" ] || continue
      ok=1
      gh variable set SCHEDULED_REVIEW --body "$want" --repo "$repo" >/dev/null 2>&1 || ok=0
      # Only set the reviewer when starting AND one was asked for — `stop` must not
      # silently change which agent a later `start` will use.
      if [ "$ACTION" = "start" ] && [ -n "$WANT_REVIEWER" ]; then
        gh variable set SCHEDULED_REVIEWER --body "$WANT_REVIEWER" --repo "$repo" >/dev/null 2>&1 || ok=0
      fi
      if [ "$ok" = "1" ]; then
        echo "✅ $repo → $want$([ "$ACTION" = start ] && echo " ($(reviewer_of "$repo"))")"
      else
        # Loud, not silent: believing it is off when it is on is the expensive mistake.
        echo "❌ $repo — could NOT set SCHEDULED_REVIEW (it is still $(state_of "$repo"))"
      fi
    done <<< "$REPOS"
    if [ "$ACTION" = "stop" ]; then
      echo ""
      echo "note: a run already in flight keeps going — cancel it with:"
      echo "  gh run cancel <id> --repo <repo>     # slices already banked stay banked"
    fi
    ;;

  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
