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

commit contracts/src/D.sol >/dev/null
check "cancelled (timed out), unchanged: stay red" run=false 1 schedule "$base" "$(git rev-parse HEAD)" cancelled
commit contracts/src/E.sol >/dev/null
check "cancelled, then contracts changed: run" run=true 0 schedule "$base" "$(git rev-parse HEAD~1)" cancelled

# A full green run on a branch, then main fast-forwarded to that same commit: the nightly on
# main finds the branch run as the last green (deep-last-green.sh) and skips.
git checkout -qb feature
feat=$(commit contracts/src/F.sol)
git checkout -q - && git merge -q --ff-only feature
check "main fast-forwarded to a green branch run: skip" run=false 0 schedule "$feat" "$feat" success

pick=$(cd "$(dirname "$script")" && pwd)/deep-last-green.sh
pickcheck() { # pickcheck <name> <expected sha> <input lines>
  local got; got=$(echo "$3" | bash "$pick")
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: got '$got'"; fail=1; fi
}
pickcheck "newest full green run wins"            aaa "aaa success
bbb success"
pickcheck "a skip (deep skipped) is passed over"  bbb "aaa skipped
bbb success"
pickcheck "a split run counts only if every shard passed" ccc "aaa success,failure,success
bbb success,cancelled
ccc success,success,success"
pickcheck "a run with no deep job is passed over" bbb "aaa
bbb success"
pickcheck "nothing green: empty"                  "" "aaa skipped"

rm -rf "$tmp"
exit $fail
