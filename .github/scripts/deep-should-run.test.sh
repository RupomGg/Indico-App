#!/usr/bin/env bash
# Self-check for deep-should-run.sh in a throwaway git repo. Run: bash deep-should-run.test.sh
set -u
script=$(cd "$(dirname "$0")" && pwd)/deep-should-run.sh
tmp=$(mktemp -d) && cd "$tmp" && git init -q && git config user.email t@t && git config user.name t
commit() { mkdir -p "$(dirname "$1")"; echo "$RANDOM" >> "$1"; git add -A; git commit -qm x; git rev-parse HEAD; }

base=$(commit contracts/src/A.sol)
fail=0
check() { # check <name> <expected-output> <expected-exit> <args...>
  local name=$1 want=$2 want_rc=$3; shift 3
  local got rc; got=$(bash "$script" "$@" 2>/dev/null); rc=$?
  if [ "$got" = "$want" ] && [ "$rc" = "$want_rc" ]; then echo "ok   $name"; else echo "FAIL $name: got '$got' exit $rc"; fail=1; fi
}

check "manual dispatch always runs"        run=true  0 workflow_dispatch "$base" "$base" success
check "no green run yet"                   run=true  0 schedule "" "" ""
check "unknown green sha"                  run=true  0 schedule deadbeef deadbeef success
check "unchanged since green: skip"        run=false 0 schedule "$base" "$base" success
docs=$(commit DECISION.md)
check "docs-only change since green: skip" run=false 0 schedule "$base" "$docs" success
code=$(commit contracts/src/B.sol)
check "contracts changed: run"             run=true  0 schedule "$base" "$docs" success
check "red, unchanged since red: stay red" run=false 1 schedule "$base" "$code" failure
commit DECISION.md >/dev/null
check "red, docs-only since red: stay red" run=false 1 schedule "$base" "$code" failure
commit contracts/src/C.sol >/dev/null
check "red, then contracts changed: run"   run=true  0 schedule "$base" "$code" failure
commit .github/workflows/deep.yml >/dev/null
check "workflow changed since green: run"  run=true  0 schedule "$(git rev-parse HEAD~1)" "$(git rev-parse HEAD~1)" success
commit .github/scripts/deep-should-run.sh >/dev/null
check "gate script changed: run"           run=true  0 schedule "$(git rev-parse HEAD~1)" "$(git rev-parse HEAD~1)" success

rm -rf "$tmp"
exit $fail
