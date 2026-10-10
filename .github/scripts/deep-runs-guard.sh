#!/usr/bin/env bash
# Fails a Deep fuzz shard unless forge really ran it at full strength (O-036).
# Usage: deep-runs-guard.sh <forge output file> <minimum fuzz runs> [<minimum invariant runs> <depth>]
# Fails when: no "Ran N test suite(s)" summary line; the summary shows a failed test; or any
# fuzz test reports fewer runs than the minimum. Invariant lines ("runs: N, calls: M, ...") are
# not fuzz runs: without the last two arguments they are skipped; with them, each must show at
# least the minimum runs and at least runs x depth calls (P2.1).
set -u
log="$1"
min="$2"
inv_min="${3:-}"
depth="${4:-}"

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

if [ -n "$inv_min" ]; then
  inv=$(grep -E '\(runs: [0-9]+, calls: [0-9]+' "$log" |
    sed -E 's/^ *(.*) \(runs: ([0-9]+), calls: ([0-9]+).*/\2 \3 \1/')
  if [ -z "$inv" ]; then
    echo "::error::no invariant result line in $log"
    exit 1
  fi
  bad=$(awk -v min="$inv_min" -v depth="$depth" '$1 < min || $2 < $1 * depth' <<< "$inv")
  if [ -n "$bad" ]; then
    echo "::error::invariant campaigns below $inv_min runs or runs x $depth calls (runs calls name):"
    echo "$bad"
    exit 1
  fi
  echo "ok: invariants at $inv_min runs or more, depth $depth"
fi

checked=$(grep -E '\(runs: [0-9]+, ' "$log" | grep -vc 'calls: ')
echo "ok: $checked fuzz test(s), all at $min runs or more"
