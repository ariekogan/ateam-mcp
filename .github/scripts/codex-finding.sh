#!/usr/bin/env bash
# Work a Codex finding safely when SEVERAL sessions share an area.
#
#   .github/scripts/codex-finding.sh claim <issue> <finding-id>   # "I'm taking this"
#   .github/scripts/codex-finding.sh done  <issue> <finding-id> [commit]  # tick it
#   .github/scripts/codex-finding.sh skip  <issue> <finding-id> "why"     # not valid / won't fix
#   .github/scripts/codex-finding.sh show  <issue>                        # status of each finding
#
# WHY: an area issue holds several findings and several sessions may touch the same
# area. Two problems follow — duplicate/conflicting work, and "is this one done?".
# So: each finding is a CHECKBOX with a stable `id:` (see codex-file-findings.mjs).
#   • claim → a comment other sessions can see before starting (a soft lock)
#   • done  → ticks THAT finding's box, records the fixing commit, and closes the
#             issue automatically once every box is ticked
# Closing the whole issue for one fix would falsely mark the rest done.
#
# A finding lives in the issue BODY *or* in a COMMENT — codex-file-findings.mjs
# appends to an already-open area issue instead of opening a second one. So this
# script reads and edits both. Reading only the body made every appended finding
# report "not found", and the auto-close then counted the body's boxes alone and
# closed an issue whose comment findings were still open.
set -euo pipefail

ACTION="${1:-}"; ISSUE="${2:-}"; ID="${3:-}"; EXTRA="${4:-}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
SESSION="${CLAUDE_SESSION_TITLE:-$(basename "$(pwd)")}"
[ -n "$ACTION" ] && [ -n "$ISSUE" ] || { sed -n '2,16p' "$0"; exit 1; }

# Every surface a finding can live on: the body, plus each comment.
#
# The comment's REST id comes from its url (`…#issuecomment-<id>`): `gh issue view
# --json comments` exposes only the GraphQL node id, so asking for `.databaseId`
# yields null and the edit PATCHes `/issues/comments/null` — a 404 that looks like
# a missing comment rather than a wrong id.
places() {
  gh issue view "$ISSUE" --repo "$REPO" --json body,comments \
    --jq '[{kind:"body",cid:0,text:.body}]
          + [.comments[]|{kind:"comment",cid:(.url|capture("#issuecomment-(?<n>[0-9]+)").n),text:.body}]'
}

case "$ACTION" in
  show)
    # `grep` exits 1 when nothing matches, and with `set -o pipefail` that used to
    # kill the script before the claims were ever printed. Do the filtering in node
    # so an empty result is an empty result, not a failure.
    places | node -e '
      const p=JSON.parse(require("fs").readFileSync(0,"utf8"));
      for (const s of p) for (const l of s.text.split("\n"))
        if (/^- \[[ x]\]/.test(l) || /id: `/.test(l))
          console.log("  " + (s.kind === "comment" ? "(c" + s.cid + ") " : "        ") + l.trim());
    ' || true
    echo ""
    echo "claims:"
    gh issue view "$ISSUE" --repo "$REPO" --json comments \
      --jq '.comments[]|select(.body|test("🔒 claim"))|"  \(.createdAt[0:16])  \(.body|split("\n")[0])"' || true
    ;;

  claim)
    [ -n "$ID" ] || { echo "need <finding-id>"; exit 1; }
    # Warn if someone already claimed it — don't silently double-book.
    PRIOR=$(gh issue view "$ISSUE" --repo "$REPO" --json comments \
      --jq ".comments[]|select(.body|test(\"🔒 claim.*$ID\"))|.createdAt" | tail -1 || true)
    if [ -n "$PRIOR" ]; then
      echo "⚠️  finding $ID was already claimed at $PRIOR — check that comment before proceeding."
    fi
    gh issue comment "$ISSUE" --repo "$REPO" \
      --body "🔒 claim \`$ID\` — being worked by **${SESSION}**. Other sessions: skip this one unless the claim is stale." >/dev/null
    echo "✅ claimed $ID as ${SESSION}"
    ;;

  done)
    [ -n "$ID" ] || { echo "need <finding-id>"; exit 1; }
    COMMIT="${EXTRA:-$(git rev-parse --short HEAD 2>/dev/null || echo '')}"

    # Find the finding wherever it lives, tick its box, and say which surface it was on.
    RESULT=$(places | ID="$ID" node -e '
      const p=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const id=process.env.ID;
      const hit=p.find(s=>s.text.includes("id: `"+id+"`"));
      if(!hit){ console.log(JSON.stringify({found:false})); process.exit(0); }
      const lines=hit.text.split("\n");
      const idx=lines.findIndex(l=>l.includes("id: `"+id+"`"));
      for(let i=idx;i>=0;i--){
        if(/^- \[[ x]\]/.test(lines[i])){ lines[i]=lines[i].replace(/^- \[ \]/,"- [x]"); break; }
      }
      console.log(JSON.stringify({found:true,kind:hit.kind,cid:hit.cid,text:lines.join("\n")}));
    ')
    node -e 'process.exit(JSON.parse(process.argv[1]).found ? 0 : 9)' "$RESULT" \
      || { echo "❌ finding $ID not found in issue #$ISSUE (searched body + comments)"; exit 1; }

    KIND=$(node -e 'console.log(JSON.parse(process.argv[1]).kind)' "$RESULT")
    CID=$(node -e 'console.log(JSON.parse(process.argv[1]).cid)' "$RESULT")
    NEWTEXT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).text)' "$RESULT")

    if [ "$KIND" = "body" ]; then
      gh issue edit "$ISSUE" --repo "$REPO" --body "$NEWTEXT" >/dev/null
    else
      gh api -X PATCH "repos/${REPO}/issues/comments/${CID}" -f body="$NEWTEXT" >/dev/null
    fi
    gh issue comment "$ISSUE" --repo "$REPO" \
      --body "✅ fixed \`$ID\` by **${SESSION}**${COMMIT:+ in \`$COMMIT\`}" >/dev/null
    echo "✅ marked $ID done (in ${KIND})"

    # Close only when EVERY box, across body AND comments, is ticked. The per-finding
    # comments this script writes carry no checkbox, so they cannot skew the count.
    LEFT=$(places | node -e '
      const p=JSON.parse(require("fs").readFileSync(0,"utf8"));
      let n=0; for(const s of p) for(const l of s.text.split("\n")) if(/^- \[ \]/.test(l)) n++;
      console.log(n);
    ')
    if [ "$LEFT" -eq 0 ]; then
      gh issue close "$ISSUE" --repo "$REPO" --comment "All findings handled — closing. A later review opens a fresh issue if new findings appear in this area." >/dev/null
      echo "🎉 all findings handled — issue #$ISSUE closed"
    else
      echo "   $LEFT finding(s) still open in #$ISSUE"
    fi
    ;;

  skip)
    [ -n "$ID" ] || { echo "need <finding-id>"; exit 1; }
    [ -n "$EXTRA" ] || { echo "give a reason: skip <issue> <id> \"why\""; exit 1; }
    gh issue comment "$ISSUE" --repo "$REPO" \
      --body "⏭️ skipping \`$ID\` (**${SESSION}**): $EXTRA" >/dev/null
    echo "⏭️  recorded skip for $ID (box left unticked on purpose — a human should see it)"
    ;;

  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
