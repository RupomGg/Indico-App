#!/usr/bin/env bash
# Self-check for deep-runs-guard.sh: each case is a forge output excerpt and the expected verdict.
set -u
guard="$(dirname "$0")/deep-runs-guard.sh"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
fails=0

check() { # check <name> <expected exit 0|1> <forge output>
  printf '%s\n' "$3" > "$tmp"
  bash "$guard" "$tmp" 5000000 > /dev/null 2>&1
  local got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" -eq "$2" ]; then echo "ok   $1"; else echo "FAIL $1 (exit $got, expected $2)"; fails=1; fi
}

PASS5M='[PASS] testFuzz_a(uint256) (runs: 5000000, μ: 1000, ~: 1000)'
SUM='Ran 1 test suite in 9.1s (9.1s CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)'

check "all fuzz at 5M" 0 "$PASS5M
[PASS] test_unit() (gas: 1234)
$SUM"
check "one fuzz capped at 100,000" 1 "$PASS5M
[PASS] testFuzz_capped(uint256) (runs: 100000, μ: 900, ~: 900)
$SUM"
check "fuzz above the minimum" 0 "[PASS] testFuzz_b(uint256) (runs: 6000000, μ: 1, ~: 1)
$SUM"
check "invariant line not counted as fuzz" 0 "[PASS] invariant_x() (runs: 256, calls: 32768, reverts: 0)
$SUM"
check "unit tests only" 0 "[PASS] test_unit() (gas: 1234)
$SUM"
check "no summary line" 1 "$PASS5M"
check "a failed test" 1 "$PASS5M
Ran 1 test suite in 9.1s (9.1s CPU time): 1 tests passed, 1 failed, 0 skipped (2 total tests)"
check "several suites summary" 0 "$PASS5M
Ran 3 test suites in 9.1s (9.1s CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)"
check "failed fuzz with counterexample, low runs" 1 "[FAIL: x; counterexample: calldata=0x args=[1]] testFuzz_c(uint256) (runs: 4, μ: 1, ~: 1)
$SUM"

exit $fails
