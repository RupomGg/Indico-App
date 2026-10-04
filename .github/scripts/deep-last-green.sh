#!/usr/bin/env bash
# Picks the commit of the latest full, green Deep fuzz run on any branch (D-31, D-42).
# Reads lines "<head_sha> <deep job conclusions, comma separated>" newest first, one per
# successful workflow run, and prints the first sha whose deep jobs all ran and all passed.
# A run whose deep job was skipped (a D-31 skip) is not a full run and is passed over.
while read -r sha conclusions; do
  [ -n "${conclusions:-}" ] || continue
  full=1
  IFS=, read -ra each <<< "$conclusions"
  for c in "${each[@]}"; do [ "$c" = success ] || full=0; done
  if [ "$full" = 1 ]; then
    echo "$sha"
    exit 0
  fi
done
