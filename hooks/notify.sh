#!/bin/sh
# Monish: ping the iPhone when Claude Code stops and waits for the user
# (a permission prompt or an MCP form). Reads the Notification hook JSON on stdin.
# Contract: https://monish.cc/skill, section 4. Always exits 0, never blocks more than 5 s.
# MONISH_DRY_RUN=1 prints the request body (key masked) instead of sending it.

key="${MONISH_KEY:-$(cat "$HOME/.config/monish/key" 2>/dev/null)}"
[ -z "$key" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
kind=$(printf '%s' "$input" | jq -r '.notification_type // ""' 2>/dev/null)
case "$kind" in permission_prompt|elicitation_dialog) ;; *) exit 0 ;; esac

dir=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
[ -z "$dir" ] && dir="$PWD"
project=$(basename "$dir")
# Item ids accept [A-Za-z0-9_.:-], 64 characters at most: one stable line per project.
slug=$(printf '%s' "$project" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-58)
body=$(printf '%s' "$input" | jq -r '(.message // "") | .[0:200]' 2>/dev/null)

# The key goes through the environment, not the command line, so it never shows in ps.
payload=$(MONISH_K="$key" jq -nc --arg id "needs-$slug" --arg t "Needs you · $project" \
  --arg b "$body" --arg a "Claude Code · $project" \
  '{key:env.MONISH_K,id:$id,type:"done",title:$t,body:$b,agent:$a,fields:{severity:"warning"}}') || exit 0

if [ -n "$MONISH_DRY_RUN" ]; then
  printf '%s\n' "$payload" | jq -c '.key = "an_***"'
  exit 0
fi

printf '%s' "$payload" | curl -s -m 5 https://monish.cc/v1/send \
  -H 'content-type: application/json' -d @- >/dev/null 2>&1
exit 0
