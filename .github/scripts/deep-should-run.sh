#!/usr/bin/env bash
# Decides whether a Deep fuzz run is needed (D-31). Prints run=true or run=false.
# usage: deep-should-run.sh <event> <last-green-sha> <last-completed-sha> <last-conclusion>
# <last-green-sha> is the latest full green run on any branch (deep-last-green.sh), so a branch
# run counts for main once main holds the same code. Exits 1 when nothing changed since a red
# or cancelled (timed-out) run, so that night stays red instead of looking green; nothing is
# re-run.
set -u
event=$1 green=$2 last=$3 last_conclusion=$4
paths=(contracts .github/workflows/deep.yml .github/scripts)

# True unless $1 is a commit with the same test-relevant files as HEAD.
changed() {
  [ -z "$1" ] || ! git cat-file -e "$1^{commit}" 2>/dev/null || ! git diff --quiet "$1" HEAD -- "${paths[@]}"
}

if [ "$event" = workflow_dispatch ]; then
  echo run=true
elif ! changed "$green"; then
  echo "unchanged since green run on $green, skipping" >&2
  echo run=false
elif { [ "$last_conclusion" = failure ] || [ "$last_conclusion" = cancelled ]; } && ! changed "$last"; then
  echo "unchanged since red run on $last, staying red" >&2
  echo run=false
  exit 1
else
  echo run=true
fi
