#!/usr/bin/env bash
# Fails a Deep fuzz shard unless forge really ran it at full strength (O-036).
# Usage: deep-runs-guard.sh <forge output file> <minimum fuzz runs>
# Fails when: no "Ran N test suite(s)" summary line; the summary shows a failed test; or any
# fuzz test reports fewer runs than the minimum. Invariant lines ("runs: N, calls: ...") are not
# fuzz runs and are skipped.
set -u
log="$1"
min="$2"

summary=$(grep -E 'Ran [0-9]+ test suites?' "$log")
if [ -z "$summary" ]; then
  echo "::error::no forge test summary in $log"
  exit 1
fi
if ! grep -qE ' 0 failed' <<< "$summary"; then
  echo "::error::forge reported failures: $summary"
  exit 1
fi

short=$(grep -E '\(runs: [0-9]+, ' "$log" | grep -v 'calls: ' |
  sed -E 's/.*\] ([A-Za-z0-9_]+)\(.*\(runs: ([0-9]+), .*/\2 \1/' |
  awk -v min="$min" '$1 < min')
if [ -n "$short" ]; then
  echo "::error::fuzz tests below $min runs:"
  echo "$short"
  exit 1
fi

checked=$(grep -E '\(runs: [0-9]+, ' "$log" | grep -vc 'calls: ')
echo "ok: $checked fuzz test(s), all at $min runs or more"
