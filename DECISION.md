# DECISION.md: what changed, and why

Every portion of work adds one entry here (rules in `INSTRUCTION.md` §3). Nothing is edited out
of this file afterwards; a correction is a new entry that refers to the old one.

Three kinds of id:
- **C-###** a change entry: one per portion, or one per fix.
- **D-##** a decision between options. The full reasoning lives in `docs/decisions.md`; entries
  here only reference it. D-01 to D-13 already exist.
- **O-###** an open item: something noticed but not done yet, with the portion that will do it.

## Entry template

```
### C-### · P?.? · short title · YYYY-MM-DD
Type: feature | fix | chore | docs
Decisions: D-## (or none)
Files:
- New: path: its job
- Changed: path: what changed; why; what depends on it
- Deleted: path: why; what replaces it
Gate: G1 to G12, each pass/fail with the log file name
Mutations (G9): what was broken, which test caught it
Open items: raised O-###, closed O-###
Commit: the one-line message given to the owner
```

---

## Change log

### C-001 · P0.1 · Toolchain, interface, maths, test helpers · 2026-09-29
Type: feature
Decisions: D-01 to D-12 (pre-existing)
Files:
- New: `contracts/foundry.toml`: Solidity 0.8.26, optimizer 200, `via_ir`, fuzz profiles default
  10,000 / ci 100,000 / deep 5,000,000, invariant runs 256 depth 128, deep invariant 10,000 / 256.
- New: `contracts/remappings.txt`, `.gitmodules`: `forge-std` v1.16.2 and OpenZeppelin v5.7.0 as
  pinned submodules.
- New: `contracts/src/interfaces/IIndicoLedger.sol`: every function, event and custom error of
  the ledger, no implementation. The contract between blockchain and backend.
- New: `contracts/src/lib/Math.sol`: `ceilDiv` (written as `(a - 1) / b + 1` so it cannot
  overflow) and `mulDivDown` (512-bit product, named `MathOverflow` instead of a panic).
- New: `contracts/src/lib/Constants.sol`: `BPS`, `LTV_BPS`, `TERM`.
- New: `contracts/test/helpers/MockUSDC.sol`: 6-decimal token with four switchable faults:
  blacklist, fee on transfer, return false, re-entrant callback.
- New: `contracts/test/helpers/Fixture.sol`, `StateSnapshot.sol`, `Actors.sol`, `Matrix.sol`:
  shared setup, before/after state capture, the participant/loan/pool states, and a
  snapshot-and-revert cross-product runner.
- New: `contracts/test/helpers/Helpers.t.sol`: self-checks for the four faults and for the matrix
  runner visiting every cell exactly once.
- New: `contracts/test/unit/Math.t.sol`: 40 tests, one per partition row plus 9 fuzz properties
  at 100,000 runs.
- New: `contracts/test/unit/Smoke.t.sol`: fails until `IndicoLedger.sol` exists, by design.
- New: `.github/workflows/ci.yml`, `.github/workflows/deep.yml`: gate on every push, deep fuzz
  nightly.
- New: `contracts/.gas-snapshot`, `README.md`, `.gitattributes`, `contracts/.gitignore`.
Gate: 48 of 48 tests pass with the ledger-dependent files skipped; `Math.sol` 100% lines (9/9)
and 100% branches (4/4). CI not yet verified green (see O-001).

### C-002 · P0.1 · Corrections before the contract is written · 2026-09-29
Type: fix
Decisions: D-13 (new)
Files:
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: constructor documented as
  `(usdc, admin, guardian)`; `Loan` gains `uint16 extensionCount`; `LoanExtended` carries it;
  `CollateralLocked` emitted by `requestLoan`; `CollateralReleased` carries the loan id; new errors
  `ZeroAddress`, `InsufficientShares`, `WrongTermsHash`, `ExtensionWindowNotOpen`,
  `DivisionByZero`, `MathOverflow`. Depends on it: `Fixture.sol`, `StateSnapshot.sol`, the event
  catalogue, the backend indexer.
- Changed: `contracts/src/lib/Constants.sol`: `EXTENSION_WINDOW = 30 days`, so extensions are at
  least 60 days apart and `uint16 extensionCount` can never overflow (D-13).
- Changed: `contracts/test/helpers/Fixture.sol`, `StateSnapshot.sol`: new constructor and the
  wider `loans()` tuple.
- Changed: `contracts/test/helpers/Actors.sol`: the lent-with-default pool state moves the clock
  into the extension window before extending.
- Changed: event catalogue to 0.2.0; `LoanExtended` topic
  `0x6027ac324f6ff123cb9bfc9e065eb096f60966de89c9fc91f466a101ceb27185`, confirmed by two
  independent computations.
Gate: 48 of 48 tests pass; helpers compile against a constructor-only stub.

### C-003 · chore · Repository history reset · 2026-09-29
Type: chore
Files: none changed in content.
- The original root commit `bd065e3` and tag `interface-v0.1.0` were removed when the repository
  was re-initialised; `interface-v0.2.0` was never created. All work is now in root commit
  `9c15bbf`, pushed to `origin/main`. See O-003.
- `.gitignore` keeps local working notes, specs and prompts out of the repository.

### C-004 · P0.2 · CI skip step for Phase 0 · 2026-10-01
Type: chore
Files:
- Changed: `.github/workflows/ci.yml`, `.github/workflows/deep.yml`: a step that removes the four
  ledger-dependent test files while `contracts/src/IndicoLedger.sol` does not exist. Edited
  locally, not yet pushed. Reviewed as part of P0.2.

### C-005 · docs · Build plan adopted · 2026-10-01
Type: docs
Files:
- New: `INSTRUCTION.md`: portions, the 12-line gate, logging rules.
- New: `DECISION.md`: this file.
- Changed: local spec wording and working notes (not pushed).

### C-006 · P0.2 · Three CI fixes pushed before this log existed · 2026-10-01
Type: fix
Decisions: D-14 (new)
Correction to C-004: its skip step is no longer "not yet pushed". It was pushed in `89e7445`.
Files, by commit:
- `89e7445` "bug fix : cli fix". Changed: `.github/workflows/ci.yml`, `.github/workflows/deep.yml`:
  the Phase-0 skip step from C-004. Result: build and tests went green; the run failed at step 6.
- `9cfe4ba` "ci: regenerate gas snapshot on forge 1.8.3 and pin toolchain version".
  - Changed: `.github/workflows/ci.yml`, `.github/workflows/deep.yml`: `version: stable` became
    `version: v1.8.3`. Root cause of the step-6 failure: `stable` had moved to Forge 1.8.3, which
    measures gas differently from the Forge that wrote the snapshot (every test off by a
    constant, for example +2,500 or +7,000). No code had changed. See D-14.
  - Changed: `contracts/.gas-snapshot`: rebuilt from the gas that Forge 1.8.3 reported in CI run
    36805629184, same 39 tests. Depends on it: CI step 6, gate G8.
  - Result: step 6 green; the run failed at step 7.
- `fc909f2` "ci: scope slither to project sources, triage intentional unused-return in mulDivDown".
  - Changed: `.github/workflows/ci.yml`: Slither gets `--filter-paths "lib/"`. Its three medium
    findings in `lib/` were `incorrect-exp` and `divide-before-multiply` in OpenZeppelin
    `Math.mulDiv`, which uses XOR and division on purpose in audited code. No detector is
    switched off for project code.
  - Changed: `contracts/src/lib/Math.sol`: `// slither-disable-next-line unused-return` on the
    `mul512` call in `mulDivDown`, with the reason in the comment above it. Triage: `mul512`
    returns `(high, low)`; only `high` is needed, because the result fits in 256 bits exactly
    when `high < d`. Ignoring `low` is correct. Comment only, bytecode logic unchanged.
  - Result: CI run 36807503732 green.
Gate: not run under INSTRUCTION.md at the time; covered by the P0.2 gate in C-007.

### C-007 · P0.2 · CI repair · 2026-10-01
Type: chore
Decisions: D-14
Files:
- Changed: `.github/workflows/ci.yml`:
  - Step 4 (invariants) runs only when `contracts/test/invariant/` has files
    (`hashFiles(...) != ''`), so it starts on its own in P2.1. Before this, it ran against no
    tests and passed without checking anything.
  - Slither is installed with `actions/setup-python@v6` (Python 3.12) and pinned
    `slither-analyzer==0.11.6`, instead of plain `pip` on the runner's system Python, which is
    refused on externally-managed images. Scope widened from `lib/` to `(lib|test|script)/`,
    so it scans `src/` only.
  - Comment above step 6 records the one command that regenerates `.gas-snapshot`:
    `FOUNDRY_PROFILE=default forge snapshot --no-match-test testFuzz`, the same profile and
    filter as the check. Fuzz tests are excluded because their gas varies with input.
  - Depends on it: every push, gate G10.
- Unchanged, checked: `.github/workflows/deep.yml`: triggers are only `schedule` and
  `workflow_dispatch`, never push; pinned to v1.8.3.
- Unchanged, checked: submodules pinned by commit: `forge-std` `bf647bd` = v1.16.2,
  `openzeppelin-contracts` `cab1993` = v5.7.0 (matches the v5.7.0 tag on the upstream remote).
  CI checks them out with `submodules: recursive`.
- Unchanged, checked: the Phase-0 skip step keys on `hashFiles('contracts/src/IndicoLedger.sol')`,
  so it stops running the moment that file exists (P1.1 manual check).
- Local toolchain (not in the repo): Forge 1.5.1 replaced by 1.8.3 from the official
  `foundry_v1.8.3_win32_amd64.zip`, SHA-256 `e4d7302f...8946304` matching the release's
  `.sha256`. Old binaries kept in `~/.foundry/bin-1.5.1-backup`. `~/.foundry/bin` added to the
  user PATH. See D-14.
- Local gate note: CI deletes the four Phase-0 files; locally the same files are excluded with
  `--skip Smoke.t.sol Fixture.sol Actors.sol StateSnapshot.sol`. Same 48 tests, same gas.
Gate (logs in `docs/gate-logs/P0.2/`, Forge 1.8.3):
- G1 pass, `G1.log`: 48 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 9/9, branches 4/4.
- G3 pass, `G3.log`: `forge fmt --check` exit 0 on 1.8.3, no formatting change from the upgrade.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 48 passed each.
- G6 pass, `G6.log`: three runs, 48 passed each.
- G7 pass, `G7.log`: `ci` profile, 48 passed, fuzz at 100,000 runs. The nine `Math.t.sol`
  properties pin 100,000 inline (`forge-config: default.fuzz.runs`), so G1 runs them at
  100,000 too.
- G8 pass, `G8.log`: largest artifact `MockUSDC` 4,091 B runtime (no ledger yet); snapshot
  check 39 passed, no diff.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes, then red/green branch run.
- G11 pending: owner's red/green check.
- G12: this entry.
Mutations (G9), each one breaks a CI rule; `.gas-snapshot` restored and confirmed
byte-identical by SHA-256:
- M1 gas check without `--no-match-test testFuzz`: exit 1, "No matching snapshot entry" for the
  fuzz tests. Caught.
- M2 one snapshot entry set to 8,800 against a real 9,873 (over 10%): exit 1,
  `Diff in "MathTest::test_mulDivDown_zeroFactor()"`. Caught.
- M3 Slither without the path filter: OpenZeppelin `incorrect-exp` and `divide-before-multiply`
  return, non-zero exit (with the CI flags it exits 0). Caught.
- M4 Phase-0 skip removed: compile error, `Fixture.sol` imports the missing
  `src/IndicoLedger.sol`. Caught.
Open items: closed O-001, closed O-004 (`gh auth status`: signed in as RupomGg, scopes include
`repo` and `workflow`). O-005 stays open until a fresh terminal shows `forge Version: 1.8.3`.
Raised O-012.
Commit: ci: install slither via setup-python scoped to src, skip invariant step until it exists, pin forge 1.8.3 (P0.2)

### C-008 · P0.2 · CI gate lines G10 and G11 · 2026-10-01
Type: chore
Files: none changed. Completes the two lines C-007 left pending.
- G11 pass: throwaway branch `ci-red-check`. Run 36810436144 on `1d62169` red at step 3,
  `[FAIL: deliberate failure, CI must go red] test_ciTurnsRed()`, the other 48 tests passing.
  Run 36810574636 on `0687a8d` (the test removed) green: step 4 skipped with no
  `test/invariant/`, Slither installed through `setup-python` as 0.11.6, step 7 green.
  Branch deleted locally and on `origin`.
- Process note: `1d62169` also carried the P0.2 `ci.yml` change, because it was staged before
  the branch was cut. The red/green check therefore ran against the new workflow. The test file
  was removed with a new commit instead of `git revert`, which would have undone `ci.yml` too.
  Only `ci.yml` was taken from the branch onto `main`; `CiRedCheck.t.sol` has no history on
  `main`.
- G10 pass, `G10.log`: run 36810874922 on `59332a7` green; steps 1 to 3 and 5 to 7 pass,
  step 4 skipped as designed.
Open items: O-005 still open until a fresh terminal shows `forge Version: 1.8.3`.
Commit: docs: record P0.2 CI gate results

### C-009 · chore · Forge on PATH · 2026-10-01
Type: chore
Files: none changed.
- A fresh PowerShell, with PATH rebuilt from the machine and user registry values only,
  resolves `forge` to `C:\Users\Radwan\.foundry\bin\forge.exe` and prints
  `forge Version: 1.8.3` (commit `cae51ad`). Closes O-005.
- Open-items table: O-001 and O-004 marked closed by C-007, O-005 by this entry.
Commit: docs: close O-005, forge 1.8.3 on PATH

### C-010 · P0.3 · Loan matrix to 180 cells · 2026-10-01
Type: feature
Decisions: D-13 (existing), none new
Files:
- Changed: `contracts/test/helpers/Matrix.sol`: new `LOAN_TIMES = 5`, `_loanDims()`
  (4 states x 3 actions x 3 callers x 5 times = 180), `_loanTimeAt(uint256 t, uint64 dueDate)`
  returning the five moments `dueDate - EXTENSION_WINDOW - 1`, `dueDate - EXTENSION_WINDOW`,
  `dueDate - EXTENSION_WINDOW / 2`, `dueDate`, `dueDate + 1`; named errors
  `LoanTimeOutOfRange(t)` and `DueDateBeforeWindow(dueDate)`; usage comment updated. Why: the
  loan matrix now has one shared definition of its time axis instead of each test choosing its
  own moments. Depends on it: `Actors.sol` (inherits `Matrix`), `Helpers.t.sol`, and the
  P1.11 loan matrix.
  - Overflow: `_loanTimeAt` returns `uint256` and widens `dueDate` before adding, so
    `dueDate + 1` cannot overflow; at `dueDate = type(uint64).max` it returns exactly `2**64`.
  - Underflow: a `dueDate <= EXTENSION_WINDOW` has no moment before its window, so it is a named
    revert, never an arithmetic panic. When both inputs are invalid, the index is checked first.
- Changed: `contracts/test/helpers/Helpers.t.sol`: the cross-product self-check uses `_loanDims()`
  and expects 180 cells, each visited once (was `_dims(4, 3, 3, 3)`, 108). New partition table
  for `_loanTimeAt` as a comment, plus 10 unit tests (`test_loanDims_is4x3x3x5`, the five exact
  points at a typical due date, the smallest valid due date, `uint64` max, index 5, index
  `uint256` max, due date 0, due date exactly the window, both invalid) and 3 fuzz properties
  (exact and strictly increasing for every valid due date; named revert for every due date inside
  the window; named revert for every out-of-range index).
- Changed: `docs/input-testing.md` section 2.1 (local, not pushed): 144 cells became 180, with a
  table of the five time points and a pointer to `_loanTimeAt` and `_loanDims`.
- Changed: `contracts/.gas-snapshot`: regenerated with
  `FOUNDRY_PROFILE=default forge snapshot --no-match-test testFuzz`. Only `HelpersTest` lines
  changed; every `MathTest` value is identical (diff in `G8.log`):
  - `test_crossProduct_everyCellOnceFromCleanState` 7,571,574 to 10,048,005 (+32.7%). Over the
    10% line, explained: the loan self-check now visits 180 cells, not 108.
  - The seven `test_mock_*` lines each rose by 0.03% to 0.18% (for example 216,575 to 216,773).
    No mock code changed; the test contract has ten more functions, so its function dispatch
    costs slightly more.
  - Ten new lines for the new unit tests. Fuzz tests are excluded by the command.
  - The file no longer ends with a newline, because `forge snapshot` does not write one. C-006's
    hand-built copy had one.
- Placement: the helper lives in `Matrix.sol`, not `Actors.sol`. `Actors.sol` imports the
  ledger, so it is excluded from every build until `src/IndicoLedger.sol` exists (the Phase-0
  skip). A helper there could not be compiled or tested in this portion. `Matrix.sol` does not
  depend on the ledger. Cost: `_loanDims()` writes the state count as the literal `4` because
  `LOAN_STATES` is in `Actors.sol`. See O-013.
Gate (logs in `docs/gate-logs/P0.3/`, Forge 1.8.3):
- G1 pass, `G1.log`: 60 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 9/9, branches 4/4 (nothing under `src/` changed).
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 60 passed each.
- G6 pass, `G6.log`: three runs, 60 passed each.
- G7 pass, `G7.log`: `ci` profile, 60 passed.
- G8 pass, `G8.log`: largest artifact `MockUSDC` 4,091 B runtime; snapshot check 48 passed, no
  diff after regeneration; the diff against the committed snapshot is in the same log.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `Matrix.sol`, restored byte-identical by SHA-256 after each:
- M1 `t >= LOAN_TIMES` to `t > LOAN_TIMES`: `test_loanTime_indexPastEnd_reverts`,
  `test_loanTime_bothInvalid_indexCheckedFirst` and the out-of-range fuzz fail. Caught.
- M2 early-dueDate check deleted: `test_loanTime_dueDateZero_reverts` fails with
  `panic: arithmetic underflow or overflow (0x11)`, plus two more. Caught.
- M3 `dueDate <= EXTENSION_WINDOW` to `<`: `test_loanTime_dueDateExactlyWindow_reverts` and the
  inside-window fuzz fail. Caught.
- M4 time axis back to four points: `loan: 144 != 180` and `times: 4 != 5`. Caught.
- M5 `afterDue` without `+ 1`: `afterDue: 1707776000 != 1707776001` and three more. Caught.
Open items: raised O-013.
Commit: test: loan matrix time axis to five points, 180 cells, with named reverts at both ends (P0.3)

### C-011 · P0.3 · CI gate line G10 · 2026-10-01
Type: chore
Files: none changed. Completes the line C-010 left pending.
- G10 pass, `G10.log`: run 36812233212 on `c5c1dbd` green; steps 1 to 3 and 5 to 7 pass,
  step 4 skipped as designed. The regenerated `.gas-snapshot` passes the CI gas check on the
  runner, so local and CI measure the same gas on Forge 1.8.3 (D-14).
Commit: docs: record P0.3 CI gate result

### C-012 · P1.1 · Test helpers that first compiled with the ledger · 2026-10-01
Type: fix
Decisions: none
Root causes and fixes, found when `src/IndicoLedger.sol` made the Phase-0 files compile:
- `Fixture.setUp()` called `setTermsHash`, the approvals and `signTerms` (P1.2, P1.3), so
  every test built on it, `Smoke.t.sol` included, would revert in P1.1. With the CI skip step
  gone, CI would have gone red. Fix: split it.
- `Actors` inherits both `StateSnapshot` and `Fixture`, which after the split both reach
  `setUp`; the compiler requires an explicit override (error 6480).
- `Fixture._default` saved the clock with `block.timestamp` before `vm.warp`; under `via_ir`
  that read can be reused after the warp, so the clock would be restored wrongly. Found by the
  Forge 1.8.3 linter (`environment-read-across-mutation`).
Files:
- Changed: `contracts/test/helpers/Fixture.sol`: new `FixtureBase` (deploy, the six named actors
  funded with `FUND` and the ledger approved, `_addActor`, `_pause`), using only the constructor.
  `Fixture is FixtureBase` keeps the onboarding (terms hash, approvals, signatures) and every
  other helper, unchanged. `_default` now reads `vm.getBlockTimestamp()`. Depends on it: every
  test file.
- Changed: `contracts/test/helpers/StateSnapshot.sol`: inherits `FixtureBase` instead of
  `Fixture`, since it only reads state. Depends on it: `Actors.sol`, the P1.1 unit tests.
- Changed: `contracts/test/helpers/Actors.sol`: `is StateSnapshot, Fixture, Matrix`, with
  `setUp() override(FixtureBase, Fixture)` calling `super.setUp()`, so it still gets full
  onboarding. Compiles in P1.1; nothing runs it until P1.3.
- Changed: `contracts/test/unit/Smoke.t.sol`: inherits `FixtureBase`; its one assertion is
  unchanged. Comment updated: it passes from P1.1.
- New: `contracts/test/helpers/Fixture.t.sol`: the split's own test, 4 tests. `FixtureBase`
  deploys on the mock, tracks exactly the six named actors in order, funds each with `FUND` and
  an unlimited allowance, and onboards nobody (terms hash zero, no approval, no signature).
- Test for `_default` moved to P1.11, because it needs `liquidate` (O-021).
Gate: covered by the P1.1 gate in C-013.
Commit: part of the P1.1 commit.

### C-013 · P1.1 · Constructor, roles, pause · 2026-10-01
Type: feature
Decisions: D-15, D-16, D-17, D-18 (new)
Files:
- New: `contracts/src/IndicoLedger.sol`: `AccessControl` and `Pausable`; `ADMIN_ROLE` and
  `GUARDIAN_ROLE`; the full contract-spec section 4 state, public, nothing reading or writing it
  (D-17), six scalars with a lint suppression (D-18); constructor reverting `ZeroAddress`
  (any argument), then `UsdcNotAContract`, `UsdcDecimalsUnreadable`, `UsdcWrongDecimals`
  (D-16), granting `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` to `admin_` and `GUARDIAN_ROLE` to
  `guardian_`, `admin_ == guardian_` allowed (D-15); `pause` and `unpause`, guardian only. Does
  not inherit `IIndicoLedger` yet (O-014). Depends on it: every test, and the CI skip step,
  which stops running now that the file exists.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: errors `UsdcNotAContract(address)`,
  `UsdcDecimalsUnreadable(address)`, `UsdcWrongDecimals(uint256)`; constructor comment. Depends
  on it: the backend error map (P1.13), `docs/contract-spec.md` sections 6.0 and 8 (updated
  locally).
- Changed: `contracts/src/lib/Constants.sol`: `USDC_DECIMALS = 6`.
- New: `contracts/test/unit/Constructor.t.sol`: partition table for all three arguments, 24
  tests. Zero address per argument and all three; EOA, precompile, the ledger's own future
  address; decimals 0, 5, 7, 18, 256 and a fuzz over every value but 6; `decimals()` that
  reverts, does not exist, returns nothing, or burns all its gas; exactly three `RoleGranted`
  events with exact topics; exact role holders over ten addresses; role ids and role admins;
  admin equal to guardian; every caller x every state-changing function that exists moves no
  USDC.
- New: `contracts/test/unit/Pause.t.sol`: caller x state table, 11 tests. Guardian pauses and
  unpauses with exact events and nothing else changed; `EnforcedPause` and `ExpectedPause`;
  ten non-guardians x both functions x both states get `AccessControlUnauthorizedAccount`
  with state unchanged; revoked and newly granted guardian; fuzz over random callers; the
  2 x 2 pause matrix (IT 2.3) for these two functions.
- Changed: `INSTRUCTION.md`: P1.13 corner case, `grep -rn "forge-lint: disable" src/` returns
  nothing.
- Changed: `contracts/.gas-snapshot`: 38 new lines (Constructor 23, Pause 10, FixtureBase 4,
  Smoke 1). Every existing line unchanged, compared with HEAD; diff in `G8.log`.
- Changed (local, not pushed): `docs/decisions.md` D-15 to D-18; `docs/contract-spec.md` 6.0, 8.
Found on re-reading (INSTRUCTION 1.4): a token whose `decimals()` burns all forwarded gas.
`staticcall` keeps 1/64, so the call fails and the constructor reverts
`UsdcDecimalsUnreadable`; the trace shows `OutOfGas` then the named revert. Now a test.
Slither (CI flags, local 0.11.6): exit 0. Findings on `src/`: `constable-states` on the same six
scalars (optimization), `low-level-calls` on the `decimals()` read (informational, deliberate,
D-16), `naming-convention` on the role getters (informational, pre-existing).
Gate (logs in `docs/gate-logs/P1.1/`, Forge 1.8.3, no Phase-0 skip):
- G1 pass, `G1.log`: 100 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 26/26, branches 8/8.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0, lint included.
- G5 pass, `G5.log`: seeds 1 and 2, 100 passed each.
- G6 pass, `G6.log`: three runs, 100 passed each.
- G7 pass, `G7.log`: `ci` profile, 100 passed.
- G8 pass, `G8.log`: `IndicoLedger` 2,415 B runtime, 22,161 B margin; snapshot check 86 passed.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes.
- G11 pending: owner sees `Smoke.t.sol` pass and the CI Phase-0 skip step not run.
- G12: this entry and C-012.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 `usdc_` zero check dropped: `UsdcNotAContract(0x0) != ZeroAddress()`. Caught.
- M2 has-code check deleted: an EOA gives `UsdcDecimalsUnreadable`, not `UsdcNotAContract`. Caught.
- M3 `!= 6` to `> 6`: decimals 0 and 5 deploy. Caught.
- M4 `!ok ||` dropped: a reverting `decimals()` has its revert data decoded as a number. Caught.
- M5 guardian role granted to `admin_`: `test_guardianPauses` gets `AccessControlUnauthorizedAccount`. Caught.
- M6 `DEFAULT_ADMIN_ROLE` not granted: two events instead of three, role sweep fails. Caught.
- M7 `onlyRole` removed from `pause`: non-guardians pause. Caught.
- M8 `unpause` calls `_pause`: `EnforcedPause`. Caught.
Moved, not dropped: the participant-matrix `pause` column (IT 2.2) to P1.3, because building the
nine participants needs approvals and `signTerms` (O-022); the `_default` test to P1.11 (O-021).
Open items: raised O-014 to O-023.
Commit: feat: IndicoLedger constructor with USDC checks, roles and guardian pause; split test fixture (P1.1)

### C-014 · P1.1 · CI gate lines G10 and G11 · 2026-10-01
Type: chore
Files: none changed. Completes the lines C-013 left pending.
- G10 pass, `G10.log`: run 36815631589 on `b4b2bff` green. Steps 1 to 3 and 5 to 7 pass,
  step 4 skipped as designed, 100 tests passed in CI.
- G11 pass: in the same run `[PASS] test_usdcIsTheMock()` from `test/unit/Smoke.t.sol`, and the
  step "Phase 0 only, drop test files that need src/IndicoLedger.sol until it exists" shows
  `skipped`. It will stay skipped from now on; O-023 deletes it.
Commit: docs: record P1.1 CI gate results

### C-015 · P1.1 reopened · Top admin role behind AccessControlDefaultAdminRules · 2026-10-01
Type: feature
Decisions: D-19 (new, decided: switch, 3-day delay)
Reopens P1.1 (INSTRUCTION 1.3): a change to a signed-off portion, so the full P1.1 gate ran again.
Files:
- Changed: `contracts/src/IndicoLedger.sol`: inherits `AccessControlDefaultAdminRules` instead
  of `AccessControl`. `DEFAULT_ADMIN_ROLE` has one holder, moves only by
  `beginDefaultAdminTransfer` then `acceptDefaultAdminTransfer` by the new address after 3 days,
  and cannot be granted, revoked or renounced in one call. The constructor's checks moved into a
  private `_checkedAdmin(usdc_, admin_, guardian_)` that returns `admin_` into the base
  constructor's arguments, so they run before OpenZeppelin's own zero check: a zero argument
  still reverts the ledger's `ZeroAddress`, never `AccessControlInvalidDefaultAdmin(0)`. The base
  constructor now grants `DEFAULT_ADMIN_ROLE`; the body grants `ADMIN_ROLE` and `GUARDIAN_ROLE`.
  Depends on it: every test; the event catalogue; the deployment runbook (P3.1).
- Changed: `contracts/src/lib/Constants.sol`: `ADMIN_TRANSFER_DELAY = 3 days` (`uint48`).
- New: `contracts/test/unit/DefaultAdmin.t.sol`: partition table, 16 tests, calling the new
  functions through OpenZeppelin's `IAccessControlDefaultAdminRules`, `IAccessControl` and
  `IERC5313` on `address(ledger)`, so the file compiled before the switch and each test failed on
  its own at runtime (16 failed, 100 passed, confirmed before the code change). Covers: single
  holder and 3-day delay after deploy; begin schedules exactly `now + 3 days` with the event;
  accept at the schedule exactly reverts `AccessControlEnforcedDefaultAdminDelay(schedule)`, one
  second later moves only the top role (`ADMIN_ROLE` stays with the old address); accept by eight
  wrong addresses and with nothing pending reverts `AccessControlInvalidDefaultAdmin(caller)`;
  cancel clears the pending transfer and accept then fails; begin by anyone else, including an
  `ADMIN_ROLE` holder, reverts; one-call grant and revoke revert
  `AccessControlEnforcedDefaultAdminRules`; renounce without a schedule reverts; renounce after a
  scheduled transfer to zero is the only way to lose the role; delay change scheduled and rolled
  back with exact events; delay change by a non-default-admin reverts; transfer works while
  paused. Every revert asserts the state snapshot unchanged.
- Changed: `contracts/test/unit/Constructor.t.sol`: the "no caller can move USDC" sweep gains the
  five new state-changing functions (begin, cancel, accept, change delay, rollback); its own
  comment says to extend it as functions are added. No assertion changed.
- Unchanged, checked: `test_deploy_emitsExactlyThreeRoleGrants` still sees exactly three
  `RoleGranted` events in the same order (`DEFAULT_ADMIN_ROLE` now from the base constructor,
  then `ADMIN_ROLE`, `GUARDIAN_ROLE`), with no edit. The three zero-argument tests
  (`test_usdcZero_reverts`, `test_adminZero_reverts`, `test_guardianZero_reverts`) and
  `test_allZero_revertsZeroAddress` still get the ledger's `ZeroAddress` with no edit.
- Changed: `contracts/.gas-snapshot`: 16 new `DefaultAdminTest` lines; 20 existing lines changed;
  every `HelpersTest` and `MathTest` line unchanged. Over 10%: only
  `test_noCallerCanMoveUsdc_throughAnyFunction` 51,924,547 to 91,394,843 (+76.0%), because the
  sweep now makes 12 calls per caller instead of 7, each with a full state snapshot. The other
  19 rose by 0.15% to 1.81%: the ledger has more functions, so dispatch and the per-test
  deployment cost slightly more. Diff in `G8.log`.
- Changed: `INSTRUCTION.md` P3.1: the Safe signers are told in writing that moving the top admin
  role takes two steps and 3 days, and that a `DefaultAdminTransferScheduled` they did not start
  means act immediately.
- Changed (local, not pushed): `docs/decisions.md` D-19 marked decided; `docs/event-catalogue.md`
  gains a "Top admin transfer" section with `DefaultAdminTransferScheduled`,
  `DefaultAdminTransferCanceled`, `DefaultAdminDelayChangeScheduled`,
  `DefaultAdminDelayChangeCanceled` and their full topic0 values, each confirmed by two
  independent computations (`cast keccak` and Python keccak), and notes that an accepted transfer
  shows as `RoleRevoked(0x00, old)` then `RoleGranted(0x00, new)`.
Size: `IndicoLedger` runtime 2,415 B to 4,517 B (+2,102 B), margin 20,059 B.
Slither (CI flags): exit 0, the same 9 findings as C-013; `low-level-calls` now points at
`_checkedAdmin`.
Gate (logs in `docs/gate-logs/P1.1/`, rerun in full, Forge 1.8.3):
- G1 pass, `G1.log`: 116 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 28/28, branches 8/8.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 116 passed each.
- G6 pass, `G6.log`: three runs, 116 passed each.
- G7 pass, `G7.log`: `ci` profile, 116 passed.
- G8 pass, `G8.log`: `IndicoLedger` 4,517 B runtime; snapshot check 102 passed.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes.
- G11: covered by C-014; no new manual check.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 to M5, M7, M8 as in C-013, patterns updated to the new code. All caught.
- M6 `_checkedAdmin` returns `guardian_`, so the top role goes to the guardian: role sweep and
  every transfer test fail. Caught.
- M9 the checks moved after the base constructor (`admin_` passed straight in, `_checkedAdmin`
  called in the body): `test_adminZero_reverts` and `test_allZero_revertsZeroAddress` fail with
  `AccessControlInvalidDefaultAdmin(0x0) != ZeroAddress()`. Caught.
- M10 delay 3 days to 0: `test_deploy_singleDefaultAdmin_threeDayDelay_nothingPending`
  (`0 != 259200`) and `test_begin_schedulesExactlyThreeDaysOut` (`expected=259201, got=1`). Caught.
A first G9 attempt did not run: the script had lost its `mutate` function ("command not
found"), so no mutation was applied; `IndicoLedger.sol` was confirmed identical to its backup
before the rerun.
Open items: none raised.
Commit: feat: top admin role behind AccessControlDefaultAdminRules with a 3-day two-step transfer (P1.1 reopen)

### C-016 · P1.1 reopened · CI gate line G10 · 2026-10-01
Type: chore
Files: none changed. Completes the line C-015 left pending.
- G10 pass, `G10.log`: run 36817863845 on `26f46e0` green. Steps 1 to 3 and 5 to 7 pass; step 4
  and the Phase-0 skip step skipped as designed.
Commit: docs: record P1.1 reopen CI gate result

### C-017 · P1.2 · Membership and terms hash · 2026-10-01
Type: feature
Decisions: D-20, D-21, D-22, D-23, D-24 (new)
Files:
- Changed: `contracts/src/IndicoLedger.sol`:
  - `setTermsHash(newHash)`: `ADMIN_ROLE`; zero reverts `ZeroTermsHash` (D-21); repeats allowed
    and emit (D-20); emits `TermsHashSet`.
  - `setUserApproved(user, approved)` and `setMerchantApproved(m, approved)`: `ADMIN_ROLE`;
    shared private `_admit`: zero reverts `ZeroAddress`; on approval only, the ledger or USDC
    address reverts `InvalidParticipant` (D-23), and an address first approved in the other role
    reverts `ParticipantRoleConflict` (D-22); the first approval records `participantRole`, a
    revoke never does. Repeats allowed and emit (D-20). Emit `UserApprovalSet` /
    `MerchantApprovalSet`.
  - None of the three is `whenNotPaused` (D-24).
  - New state `participantRole` (D-22), added to the D-17 layout.
  - Removed the `uninitialized-state` suppression on `termsHash`, now written (D-18, O-015).
    Five suppressions remain.
  Depends on it: `Fixture`'s onboarding helpers (`_approveUser`, `_approveMerchantAndSign`,
  `_revokeUser`, `_revokeMerchant`) now work; `signTerms` (P1.3) reads `termsHash`.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: errors `ZeroTermsHash()`,
  `ParticipantRoleConflict(address)`, `InvalidParticipant(address)`; view
  `participantRole(address) returns (uint8)`; comments on the three setters. Depends on it: the
  backend error map and indexer (P1.13).
- Changed: `contracts/src/lib/Constants.sol`: `ROLE_NONE = 0`, `ROLE_USER = 1`,
  `ROLE_MERCHANT = 2`.
- Changed: `contracts/test/helpers/StateSnapshot.sol`: records `participantRole` per actor and
  compares it in `_assertUnchanged`, so every revert test also proves no role was written.
- New: `contracts/test/unit/Membership.t.sol`: partition tables for `setTermsHash` and both
  setters, 31 tests. Zero, typical, max, same twice, changed hash, fuzz over non-zero hashes;
  zero address for both setters and both values; ledger and USDC refused on approval, allowed
  on revoke with role unchanged; fresh approval sets flag, role and exactly one event; revoke of
  a never-approved address leaves the role at none; approve twice and revoke twice emit both
  times; revoke keeps the role. D-22 as approved: approve as user, revoke, re-approve as user
  succeeds; approve as user, revoke, approve as merchant reverts `ParticipantRoleConflict`
  (and the merchant mirror); active user cannot become merchant and vice versa; revoking the
  other role on an address that never had it is allowed and never sets the role; fuzz over any
  address that the first approval fixes the role. Eight non-admins x both setters x both values,
  and non-admins on `setTermsHash`, revert with state unchanged; a second `ADMIN_ROLE` holder
  works; all three work while paused.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix (IT 2.3) from 2 x 2 to 5 x 2, with
  the three setters shown as "works while paused" (D-24).
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains the three setters
  (15 calls per caller).
- Changed: `contracts/.gas-snapshot`: 29 new `MembershipTest` lines; 33 changed; none removed;
  `HelpersTest` and `MathTest` unchanged. Over 10%, all explained by tests, not the ledger:
  every test that takes a `StateSnapshot` rose about 40,000 gas per snapshot because the snapshot
  now reads `participantRole` for six actors (for example `test_guardianPauses` 780,739 to
  861,058, two snapshots); `test_pauseMatrix_everyCell` +183.7% (10 cells instead of 4);
  `test_noCallerCanMoveUsdc_throughAnyFunction` +39.4% (15 calls per caller instead of 12, plus
  the larger snapshot). Ledger call costs moved by dispatch only (for example
  `test_begin_schedulesExactlyThreeDaysOut` +198 gas, +0.28%). Diff in `G8.log`.
- Changed (local, not pushed): `docs/decisions.md` D-20 to D-24; `docs/contract-spec.md`
  section 4 (`participantRole`), section 6 (the three setters are not `whenNotPaused`), 6.1
  (the rules), 8 (three errors).
Size: `IndicoLedger` runtime 4,517 B to 5,440 B (+923 B), margin 19,136 B.
Slither (CI flags): exit 0, 8 findings, one fewer than C-015: `termsHash` left
`constable-states`, which now lists the five still-unwritten scalars.
Gate (logs in `docs/gate-logs/P1.2/`, Forge 1.8.3):
- G1 pass, `G1.log`: 147 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 48/48, branches 15/15.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 147 passed each.
- G6 pass, `G6.log`: three runs, 147 passed each.
- G7 pass, `G7.log`: `ci` profile, 147 passed.
- G8 pass, `G8.log`: `IndicoLedger` 5,440 B runtime; snapshot check 131 passed.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 zero terms hash accepted: `test_setTermsHash_zero_reverts`. Caught.
- M2 zero-address check removed: `test_checkOrder_zeroBeforeEverything`. Caught.
- M3 the ledger accepted as a participant: `test_approveLedgerOrUsdc_reverts`. Caught.
- M4 role conflict check removed: the role fuzz and the four conflict tests. Caught.
- M5 a revoke runs the approval checks: `InvalidParticipant` on revoking the ledger. Caught.
- M6 `setUserApproved` writes the merchant flag: `user approval untouched`. Caught.
- M7 `MerchantApprovalSet` not emitted: `test_approvalEmitsNothingElse` `0 != 1`. Caught.
- M8 `setTermsHash` blocked while paused: `EnforcedPause()`. Caught.
- M9 `setUserApproved` open to anyone: `test_setters_nonAdmins_revert`. Caught.
- M10 every first approval records the user role: role fuzz `1 != 2`. Caught.
Open items: closed O-015 (suppression on `termsHash` deleted in this gate); raised O-024
(backend admin screen warns that a role is permanent).
Commit: feat: setTermsHash, setUserApproved, setMerchantApproved with permanent participant roles, working while paused (P1.2)

### C-018 · P1.2 · CI gate line G10 · 2026-10-01
Type: chore
Files: none changed. Completes the line C-017 left pending.
- G10 pass, `G10.log`: run 36832278687 on `d85f73d` green. Steps 1 to 3 and 5 to 7 pass; step 4
  and the Phase-0 skip step skipped as designed.
Commit: docs: record P1.2 CI gate result

### C-019 · P1.3 · signTerms, and the first participant-matrix columns · 2026-10-01
Type: feature
Decisions: D-25, D-26 (new)
Files:
- Changed: `contracts/src/IndicoLedger.sol`: `signTerms(acceptedHash)`, `whenNotPaused`, no
  approval check (contract-spec 6.2). Reverts in order `EnforcedPause`, `TermsNotSet`,
  `WrongTermsHash` (`acceptedHash != termsHash`), `AlreadySigned` (caller already signed the
  current version). Sets `termsSigned`, records `signedTermsHash`, emits
  `TermsSigned(caller, hash, block.timestamp)`; the timestamp is a record only (D-26). New state
  `signedTermsHash` (D-25), added to the D-17 layout. Depends on it: `Fixture`'s onboarding,
  which now runs; the `TermsNotSigned` gates from P1.4 on.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: view
  `signedTermsHash(address) returns (bytes32)`; `signTerms` comment with the check order and D-25.
- Changed: `contracts/test/helpers/StateSnapshot.sol`: records `signedTermsHash` per actor.
- New: `contracts/test/unit/SignTerms.t.sol`: partition table, 19 tests. Not set (zero and
  non-zero); current hash signs, records the version, exact event with a warped timestamp,
  nothing else emitted; anyone may sign without approval (fresh address, user, merchant, admin,
  guardian) and signing approves nobody; zero, other, max and fuzzed wrong hashes; stale hash
  after a change, for a signer and a non-signer; second signature of the same version; fuzz over
  callers, once then `AlreadySigned`; a hash change keeps the old signature and its version; a
  newer version can be signed and emits again; as required, the admin setting an old hash again:
  a user whose last signature is that hash gets `AlreadySigned`, a user who signed only the
  newer one can sign it again; paused for a signer and a non-signer; check order.
- New: `contracts/test/unit/ParticipantMatrix.t.sol`: the participant matrix (IT 2.2), 3 of 13
  columns (`signTerms`, `setUserApproved`, `pause`), 27 cells with an expected-outcome table, and
  a self-check that `Actors._participant` builds each of the nine states as named (flags, role,
  access-control roles). Closes O-022.
- Changed: `contracts/test/helpers/Fixture.t.sol`: new `FixtureTest`, 5 tests, for the onboarding
  `Fixture` that first runs here: terms hash, alice and bob approved users who signed, both
  merchants approved merchants who signed, admin and guardian not onboarded, six funded actors.
  `Fixture` and `Actors` passed first time; no fix needed.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains `signTerms` (16 calls
  per caller). Found missing while reviewing the snapshot diff, added before the gate.
- Changed: `contracts/.gas-snapshot`: 24 new lines (SignTerms 17, Fixture 5, ParticipantMatrix 2);
  63 changed; none removed; `HelpersTest` and `MathTest` unchanged. Over 10%: only
  `test_noCallerCanMoveUsdc_throughAnyFunction` 127,369,014 to 149,318,405 (+17.2%), 16 calls per
  caller instead of 15 with a larger snapshot. The rest rose up to 9.5%, all snapshot-heavy tests:
  each `StateSnapshot` now also reads `signedTermsHash` for six actors, about 39,000 gas per
  snapshot. Diff in `G8.log`.
- Changed (local, not pushed): `docs/decisions.md` D-25, D-26; `docs/contract-spec.md` section 4
  (`signedTermsHash`) and 6.2 (versions, check order, timestamp as record);
  `docs/event-catalogue.md`: `TermsSigned` can be emitted more than once per address, one per
  version signed, so the indexer keeps every version and never overwrites on the first;
  `CLAUDE.md`: "`block.timestamp` may be emitted in an event as a record; it is never used in a
  condition except loan deadlines" (D-26).
Size: `IndicoLedger` runtime 5,440 B to 5,719 B (+279 B), margin 18,857 B.
Slither (CI flags): exit 0, 8 findings, unchanged from C-017.
Gate (logs in `docs/gate-logs/P1.3/`, Forge 1.8.3):
- G1 pass, `G1.log`: 173 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 56/56, branches 18/18.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 173 passed each.
- G6 pass, `G6.log`: three runs, 173 passed each.
- G7 pass, `G7.log`: `ci` profile, 173 passed.
- G8 pass, `G8.log`: `IndicoLedger` 5,719 B runtime; snapshot check 155 passed.
- G9 pass, `G9.log`: see Mutations.
- G10 pending: owner pushes.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 `TermsNotSet` check removed: `WrongTermsHash() != TermsNotSet()`. Caught.
- M2 `WrongTermsHash` check removed: wrong-hash fuzz signs. Caught.
- M3 `AlreadySigned` check removed: the participant matrix. Caught.
- M4 one signature per address ever (the spec's `bool`, no D-25):
  `test_newVersion_canBeSigned_recordsAndEmitsAgain` gets `AlreadySigned()`. Caught.
- M5 works while paused: `AlreadySigned() != EnforcedPause()`. Caught.
- M6 version not recorded: `signedTermsHash` zero. Caught.
- M7 `termsSigned` not set: the participant matrix `signed`. Caught.
- M8 event time 0: `expected=1800000000, got=0`. Caught.
- M9 `AlreadySigned` checked before `WrongTermsHash`: `test_order_wrongHashBeforeAlreadySigned`. Caught.
- M10 `WrongTermsHash` only for zero, so a stale hash is accepted: wrong-hash fuzz. Caught.
Open items: closed O-022; raised O-025 (participant matrix 27 of 117 cells, all 13 columns by
P1.13, each portion adds its own at its gate).
Commit: feat: signTerms with per-address terms version, and the first participant-matrix columns (P1.3)

### C-020 · P1.3 · CI gate line G10 · 2026-10-01
Type: chore
Files: none changed. Completes the line C-019 left pending.
- G10 pass, `G10.log`: run 36835961990 on `04b3c1b` green. Steps 1 to 3 and 5 to 7 pass; step 4
  and the Phase-0 skip step skipped as designed. The run registered a few minutes after the push.
- Noted, not part of this gate: the scheduled Deep fuzz run 36833476286 on `a16c2b8` (P1.2 plus
  docs) was still in progress when this was written; its result is recorded when it finishes.
Commit: docs: record P1.3 CI gate result

### C-021 · P1.2 reopened · Deep fuzz run 36833476286 failed · 2026-10-01
Type: fix (result recorded; fix pending owner approval)
Result of the scheduled Deep fuzz run noted in C-020: run 36833476286 on `a16c2b8`
(5,000,000 fuzz runs), **failed**, 146 passed, 1 failed:
`[FAIL: vm.assume rejected too many inputs (65536 allowed)]
testFuzz_firstApprovalFixesRole(address,bool) (runs: 591248)` in `test/unit/Membership.t.sol`.
No counterexample: the contract did not break a property. The test stopped because its
`vm.assume(a != 0 && a != ledger && a != usdc)` threw away more than Forge's limit of 65,536
inputs. Forge's fuzzer deliberately feeds addresses it finds in contract state, and the ledger
and USDC addresses are among them, so about 11% of inputs were rejected. At the default 10,000
runs and the `ci` 100,000 runs that stays under the limit; at 5,000,000 it does not.
Reopens P1.2, the portion that wrote the test. Six other fuzz tests use the same
`vm.assume` pattern on values the fuzzer favours and are exposed to the same failure at 5,000,000
runs: `Constructor.t.sol:180`, `Membership.t.sol:146`, `Pause.t.sol:125-126`,
`SignTerms.t.sol:132` and `:156`.
Fix: see the entry that follows this one, once approved.

### C-022 · P1.2 reopened · Fuzz tests remap instead of discarding input · 2026-10-03
Type: fix
Decisions: none (process rules added to INSTRUCTION.md)
Root cause (C-021): fuzz tests discarded input with `vm.assume` on values Forge's fuzzer
deliberately favours (addresses and constants it finds in state). At 5,000,000 runs the rejects
pass Forge's limit of 65,536 and the test stops. No property of the contract was broken.
Confirmed again by the next nightly, run 36979982138 on `9249add` (P1.3, fix not yet pushed):
the same test, `vm.assume rejected too many inputs (runs: 587534)`, 172 other tests passing.
Fix, every caller (INSTRUCTION 1.3): no test discards input any more. Each excluded value is
remapped to a valid one, so every run tests something. No assertion or property changed.
Files:
- Changed: `contracts/test/helpers/Fixture.sol`: `FixtureBase._remapForgeAddress(a)` returns one
  ordinary address for Forge's own three (the cheatcode VM, console, the CREATE2 deployer) and
  every other address unchanged.
- Changed: `contracts/test/helpers/Fixture.t.sol`: two tests for it: the three are remapped and
  five ordinary addresses (zero, alice, ledger, USDC, `address(1)`) are not; a fuzz that the
  result is never a Forge address and is unchanged for any other.
- Changed: `contracts/test/unit/Constructor.t.sol`: `testFuzz_decimalsNotSix_alwaysNamedRevert`,
  `d == 6` becomes `7`.
- Changed: `contracts/test/unit/Membership.t.sol`: `testFuzz_setTermsHash_anyNonZero_stored`, a
  zero hash becomes `keccak256("remapped-zero")`; `testFuzz_firstApprovalFixesRole`, zero, the
  ledger or USDC becomes `makeAddr("remapped")`.
- Changed: `contracts/test/unit/Pause.t.sol`: `testFuzz_randomCaller_cannotPause`, a Forge address
  is remapped, then the guardian becomes `makeAddr("remapped-not-guardian")`.
- Changed: `contracts/test/unit/SignTerms.t.sol`: `testFuzz_anyHashButCurrent_revertsWrongTermsHash`,
  the current hash becomes the other one; `testFuzz_anyCaller_signsOnce_thenAlreadySigned`, a
  Forge address is remapped.
- Changed: `INSTRUCTION.md` 1.2: every session starts by checking the latest Deep fuzz run, and a
  red one reopens the portion it ran on before any new work (the gap: P1.2 was signed off before
  its nightly deep run finished); fuzz tests never discard input, they remap or `bound`. Gate
  table: new line G13, `grep -rn "vm.assume\|assumeNot" test/` returns nothing; an exception needs
  its own decision entry.
- Changed: `contracts/.gas-snapshot`: one new line,
  `FixtureBaseTest:test_remapForgeAddress_remapsExactlyTheThree`; the four other `FixtureBaseTest`
  lines rose 0.02% to 0.44% (the test contract has more functions); nothing else changed.
- Changed (local, not pushed): `prompts/RUNBOOK.md` session opener starts by checking the latest
  Deep fuzz run.
Proof, local, at the deep profile (`docs/gate-logs/P1.2/deep-local.log`):
`FOUNDRY_PROFILE=deep forge test` on the six fixed tests and the new remap fuzz,
**5,000,000 runs each, 7 passed, 0 failed**, exit 0, 5,794 s. That includes
`testFuzz_firstApprovalFixesRole`, the test that failed on CI.
Gate (logs in `docs/gate-logs/P1.2/`, rerun in full after crash recovery, Forge 1.8.3):
- G1 pass, `G1.log`: 175 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 56/56, branches 18/18.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 175 passed each.
- G6 pass, `G6.log`: three runs, 175 passed each.
- G7 pass, `G7.log`: `ci` profile, 175 passed.
- G8 pass, `G8.log`: `IndicoLedger` 5,719 B runtime (unchanged, nothing under `src/` touched);
  snapshot check 156 passed.
- G9 pass, `G9.log`: the P1.2 mutations M1 to M10 rerun on `IndicoLedger.sol`, all caught,
  restored byte-identical by SHA-256 after each.
- G13 pass, `G13.log`: the grep returns nothing (exit 1). Negative check: a planted
  `test/unit/G13Probe.t.sol` containing `vm.assume` is found (exit 0), then removed.
- G10 pending: owner pushes.
- Deep fuzz on CI pending: after the push, `deep.yml` is triggered by hand; the run that failed
  is the run that has to go green, and its result is recorded in the next entry.
- G12: this entry.
Crash recovery: the session running the first gate attempt ended mid-G2. Before the rerun:
`IndicoLedger.sol` matched its mutation backup by SHA-256, no probe file was left, no project file
was blank or zero-filled, `forge clean`. That attempt had already deleted two local logs kept from
before the reopen, `G10-d85f73d.log` and `G9-before-reopen.log`, because the script's
`rm -f G*.log` matched their new names; their results stand in C-017 and C-018. The script now
deletes only `G1` to `G9` and `G13`.
Open items: none raised.
Commit: test: fuzz tests remap excluded values instead of discarding them, G13 gate check (P1.2 reopen)

### C-023 · P1.2 reopened · CI and Deep fuzz green · 2026-10-03
Type: chore
Files: none changed. Completes the lines C-022 left pending.
- G10 pass, `G10.log`: CI run 37090198074 on `4fabf1f` green. Steps 1 to 3 and 5 to 7 pass;
  step 4 and the Phase-0 skip step skipped as designed. The commit subject reached GitHub as
  " fuzz tests remap excluded values ..." without the `test:` prefix given in C-022; cosmetic.
- Deep fuzz pass, `deep-ci.log`: run 37090561580 on `4fabf1f`, triggered by hand
  (`gh workflow run deep.yml`), **175 passed, 0 failed, 0 skipped** at 5,000,000 runs, 6,635 s.
  All seven tests changed in C-022 at 5,000,000 runs, including
  `testFuzz_firstApprovalFixesRole`, the test that failed in runs 36833476286 and 36979982138.
  This is the first green Deep fuzz run in the project; it covers P1.2 and P1.3, whose code it
  ran on.
Commit: docs: record P1.2 reopen CI and Deep fuzz results

### C-024 · P1.4 · registerAsset and the shared mint · 2026-10-03
Type: feature
Decisions: D-27, D-28, D-29, D-30 (new)
Session start (INSTRUCTION 1.2): latest Deep fuzz run 37090561580 green (C-023), so P1.4 began.
Files:
- Changed: `contracts/src/IndicoLedger.sol`:
  - `registerAsset(docHash, assetType, value)`, `whenNotPaused`. Reverts in order
    `NotApprovedUser`, `TermsNotSigned` (any signed version counts, D-25), `ZeroAmount`,
    `ZeroDocHash` (D-28), `InvalidAssetType` above 5 (D-29), `AssetAlreadyRegistered`, then
    `CreditCapExceeded` from the mint. Marks the hash, emits `AssetRegistered`, mints.
  - Private `_mint(account, amount, reason)`: the only way credit enters circulation; refuses a
    mint that would push one account above `CREDIT_CAP = 2^128 - 1`, computing `room` first so it
    cannot overflow for any `amount` (D-27); updates `credit` and `totalCredit`; emits
    `CreditMinted(account, amount, reason)`. For an asset, `reason` is the `docHash`, linking a
    mint to its asset, never a loan to a document (D-12). `adminIssueCredit` (P1.5) will use it.
  - Removed the `uninitialized-state` suppression on `totalCredit`, now written (D-18, O-016).
    Four remain: `poolCredit`, `totalShares`, `totalLent`, `nextLoanId`.
  - Added the D-30 suppression above `approvedUser[user] = approved;` in `setUserApproved`, with
    a reason comment: `registerAsset` is the first gate on `approvedUser`, and Forge 1.8.3's
    `missing-events-access-control` lint cannot match the `UserApprovalSet` event to a mapping
    write. `approvedMerchant` gets none yet (D-30: only when a portion triggers it).
  Depends on it: P1.5 (`adminIssueCredit` uses `_mint`), loans (credit is what they lock).
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: errors `ZeroDocHash()`,
  `InvalidAssetType(uint8)`, `CreditCapExceeded(uint256 requested, uint256 room)`; the
  `registerAsset` comment with the check order and `reason = docHash`.
- Changed: `contracts/src/lib/Constants.sol`: `CREDIT_CAP = type(uint128).max`,
  `MAX_ASSET_TYPE = 5`.
- New: `contracts/test/unit/RegisterAsset.t.sol`: partition tables for value, docHash, assetType
  and caller, 31 tests. Exact mint, hash marked, exactly two events with exact arguments; one wei;
  max hash; several assets sum into one balance and `totalCredit` equals the sum; signed only an
  older terms version is enough (D-25); fuzz over value and hash within the cap. Value: zero;
  exactly the cap; cap plus one; `uint256` max (named revert, no panic); exactly the room left;
  room plus one; a full account; fuzz over every value above the room. As required (D-27): one
  user at the cap does not stop another, and `totalCredit` then exceeds `2^128`. docHash: zero;
  again by the same user and by another. assetType: all 256 `uint8` values, 0 to 5 registered and
  emitted as given, 6 to 255 `InvalidAssetType(t)` (IT 2.5). Caller: six non-users, approved but
  unsigned, revoked, paused. Check order: seven pairwise tests. Every revert asserts the full
  snapshot unchanged.
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `registerAsset` column (O-025), 4 of
  13 columns, 36 of 117 cells: only `ApprovedAndSigned` registers; `ApprovedNotSigned` gets
  `TermsNotSigned`; the other seven get `NotApprovedUser`.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 6 x 2 with `registerAsset`
  (unpaused succeeds, paused `EnforcedPause`); that row onboards alice before pausing.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains `registerAsset`
  (17 calls per caller).
- Changed: `contracts/.gas-snapshot`: 29 new `RegisterAssetTest` lines; 63 changed; none
  removed; `HelpersTest` and `MathTest` unchanged. Over 10%, both matrices that grew:
  `test_participantMatrix_everyCell` 30,609,045 to 41,351,100 (+35.1%, 36 cells instead of 27)
  and `test_pauseMatrix_everyCell` 9,700,883 to 12,078,413 (+24.5%, 12 cells instead of 10, the
  new row onboarding a user). All others +0.01% to +6.62%. Diff in `G8.log`.
- Changed (local, not pushed): `docs/decisions.md` D-27 to D-30;
  `docs/lint-probes/missing-events-access-control/` (the D-30 probe and its 1.8.3 result).
Found on re-reading (INSTRUCTION 1.4): `_mint`'s `CREDIT_CAP - credit[account]` would underflow
for an account already above the cap, which only a merchant can be (D-27). Unreachable in P1.4,
which mints only to users; moved to P1.5 with its test (O-027), not dropped.
Size: `IndicoLedger` runtime 5,719 B to 6,188 B (+469 B), margin 18,388 B.
Slither (CI flags): exit 0, 7 findings, one fewer than C-022: `totalCredit` left
`constable-states`.
Gate (logs in `docs/gate-logs/P1.4/`, Forge 1.8.3):
- G1 pass, `G1.log`: 206 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 72/72, branches 25/25.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0, after the D-30 suppression.
- G5 pass, `G5.log`: seeds 1 and 2, 206 passed each.
- G6 pass, `G6.log`: three runs, 206 passed each.
- G7 pass, `G7.log`: `ci` profile, 206 passed.
- G8 pass, `G8.log`: `IndicoLedger` 6,188 B runtime; snapshot check 185 passed.
- G9 pass, `G9.log`: see Mutations.
- G13 pass, `G13.log`: grep finds nothing; the planted probe is found, then removed.
- G10 pending: owner pushes. Deep fuzz on this code: the next run after the push.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 approved-user check removed: participant matrix `TermsNotSigned() != NotApprovedUser()`. Caught.
- M2 terms check removed: participant matrix. Caught.
- M3 zero value accepted: `ZeroDocHash() != ZeroAmount()`. Caught.
- M4 zero hash accepted: `test_docHash_zero_revertsZeroDocHash`. Caught.
- M5 type 5 rejected: `InvalidAssetType(5)` in the 256-value loop. Caught.
- M6 duplicate hash accepted: `test_docHash_againByOtherUser_reverts`. Caught.
- M7 hash not marked: participant matrix. Caught.
- M8 exact room rejected: `CreditCapExceeded` at exactly the cap. Caught.
- M9 `totalCredit` not increased: `total: 0 != 1000000000`. Caught.
- M10 mint reason zero: `CreditMinted param mismatch at reason`. Caught.
- M11 works while paused: pause matrix. Caught.
- M12 cap on the total, not the account (the design D-27 rejected):
  `test_oneUserAtCap_doesNotStopAnother` gets `CreditCapExceeded(2^128 - 1, 0)`. Caught.
Open items: closed O-016; O-025 now 36 of 117 cells; raised O-026 (re-run the D-30 probe on
any Forge upgrade) and O-027 (`_mint` above-cap underflow, for P1.5).
Commit: feat: registerAsset with per-account credit cap, six asset types, shared mint (P1.4)

### C-025 · P1.4 · CI gate line G10 · 2026-10-03
Type: chore
Files: none changed. Completes the line C-024 left pending.
- Session start (INSTRUCTION 1.2): latest Deep fuzz run 37090561580 on `4fabf1f` green.
- G10 pass, `G10.log`: CI run 37101839327 on `62e45b9` green. Steps 1 to 3 and 5 to 7 pass;
  step 4 and the Phase-0 skip step skipped as designed.
- Deep fuzz on P1.4's code (`62e45b9`): pending. P1.4 is not done until it is green (1.2).
Commit: docs: record P1.4 CI gate result

### C-026 · chore · Nightly Deep fuzz skips unchanged code; P1.5 decisions · 2026-10-03
Type: chore
Decisions: D-31, D-32, D-33 (new)
Why: the repository is private; one full Deep fuzz run is about 115 to 120 Actions minutes, so
running every night would be about 3,600 minutes a month, above the private-repository allowance.
Measured from the job timings of October 1 to 3: CI 20 runs, 70 minutes; Deep fuzz 3 runs,
271 minutes (122, 112, and 37 for the run that stopped early); 341 in total. The account plan and
the official usage figure were not readable: both endpoints need the `user` scope, which the
`gh` login does not have (`gh auth refresh -h github.com -s user`).
Files:
- Changed: `.github/workflows/deep.yml`: `permissions: contents: read, actions: read`; new `check`
  job (`actions/checkout` with `fetch-depth: 0`) that looks up the last green and the last
  finished Deep fuzz run on `main` with `gh api` and runs the gate script; the `deep` job now
  `needs: check` and runs only when it says `run=true`. Steps of the `deep` job unchanged.
- New: `.github/scripts/deep-should-run.sh`: the decision (D-31). Manual dispatch always runs;
  skip and stay green when `contracts/`, `deep.yml` and `.github/scripts/` are unchanged since the
  last green run; skip and fail (stay red) when unchanged since a red run; otherwise run. Called
  with `bash`, so no executable bit is needed; `.gitattributes` keeps it LF.
- New: `.github/scripts/deep-should-run.test.sh`: self-check in a throwaway git repository, 11
  cases, all `ok`: dispatch; no green run yet; unknown sha; unchanged; docs-only change; contracts
  change; red unchanged; red with docs-only change; red then contracts change; workflow change;
  gate-script change.
- Changed: `INSTRUCTION.md` P2.1: new corner case, every user's `credit` is at most `CREDIT_CAP`
  (D-33).
- Changed (local, not pushed): `docs/decisions.md` D-31 to D-33.
Checks before push: the YAML parses (`check`, `deep`; `deep` needs `check`); the two `gh api`
queries run live and return the last green run (`4fabf1f`, success); a dry run of the gate on the
real repository says `run=true` against `4fabf1f` (P1.4 changed `contracts/` since) and
`run=false` with `HEAD` as the green sha.
Proof on CI, pending (two nights, as agreed): one night where the run is skipped because
`contracts/` is unchanged, and one real run after a `contracts/` change. The first night after this
push is a real run (this commit changes `deep.yml`). Recorded in a later entry.
Open items: closed O-027 by D-33 (no guard; reopens if D-22, D-27 or users-only minting changes).
Commit: ci: nightly deep fuzz skips itself when contracts/ is unchanged since the last green or red run

### C-027 · P1.4 done; CI for C-026 · 2026-10-03
Type: chore
Files: none changed.
- Deep fuzz pass, `docs/gate-logs/P1.4/deep-ci.log`: scheduled run 37105728701 on `d397496`
  (P1.4's code, `62e45b9`, plus a docs-only commit), **206 passed, 0 failed, 0 skipped** at
  5,000,000 runs, 6,065 s, including both `RegisterAsset` fuzz tests. P1.4 is done (1.2).
- CI for C-026: run 37108382319 on `dca7318` green. The new `deep.yml` was accepted with no
  workflow-file error; its first run is the next nightly, a full run because `deep.yml` changed.
Commit: docs: record P1.4 Deep fuzz result and C-026 CI

### C-028 · P1.5 · adminIssueCredit, adminDebitCredit · 2026-10-03
Type: feature
Decisions: D-32, D-33 (C-026), D-34 (new)
Session start (INSTRUCTION 1.2): latest Deep fuzz run 37105728701 on `d397496` green (C-027).
Files:
- Changed: `contracts/src/IndicoLedger.sol`:
  - `adminIssueCredit(user, amount, memo)`: `onlyRole(ADMIN_ROLE)`, `whenNotPaused`; then the
    shared `_mint`, so the per-account cap applies (D-27); emits `CreditMinted(user, amount,
    memo)`.
  - `adminDebitCredit(user, amount, memo)`: same guards; reverts
    `InsufficientAvailableCredit(amount, available)` above `credit - lockedCredit`; decreases
    `credit` and `totalCredit`; emits `CreditBurned(user, amount, memo)`.
  - Private `_checkCreditTarget(user, amount)`, shared by both, in `_admit`'s order:
    `ZeroAddress`, then `NotAUser` unless `participantRole` is `ROLE_USER` (approved or revoked,
    D-32), then `ZeroAmount`. Full order: AccessControl, `EnforcedPause`, `ZeroAddress`,
    `NotAUser`, `ZeroAmount`, then the cap or the available-credit check.
  - D-34: `// slither-disable-next-line uninitialized-state` above the `lockedCredit`
    declaration, with a reason comment. Slither reports the finding once per variable at its
    declaration, so the planned per-read-site line had no effect (tried); the one line covers
    every read site, `spend` (P1.6) included.
  Depends on it: the participant and pause matrices; `Fixture._mintCredit` now works; P1.6 and
  P1.8 read available credit the same way.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: error `NotAUser(address)`; the two
  functions' comments with guards and check order.
- New: `contracts/test/unit/AdminCredit.t.sol`: partition tables for user, amount and memo, 32
  tests. Issue: exact mint and event, exactly one event, one wei, zero and max memo emitted as
  given, revoked user, adds to registered credit in one balance, exactly the room, room plus
  one, `uint256` max (named, no panic). Debit: exact burn and event, one event, one wei, exactly
  available to zero, available plus one, `uint256` max, empty balance, revoked user, fuzz within
  and above available. As required: user zero reverts `ZeroAddress` first; never-approved,
  merchant, revoked merchant, the ledger and USDC revert `NotAUser` on both functions (for issue
  to a merchant, the D-33 evidence); approved and revoked users succeed; signed-but-unapproved is
  `NotAUser`, approved-but-unsigned can be issued; debit to zero then issue the full cap again
  succeeds (the cap limits balance, not lifetime issuance); a property fuzz over 24-step
  sequences of issues and debits (valid or not) on three users asserting `totalCredit` equals the
  sum of all balances and every user is at most `CREDIT_CAP` (D-33, ahead of P2.1). Seven
  non-admins on both, paused on both, and four check-order tests. Every revert asserts the full
  snapshot unchanged.
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `adminIssueCredit` and
  `adminDebitCredit` columns (O-025), 6 of 13 columns, 54 of 117 cells: only Admin succeeds,
  every other participant is denied `ADMIN_ROLE`. The debit cells mint to bob before the
  snapshot.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 8 x 2 with both functions (unpaused
  succeeds, paused `EnforcedPause`); the debit row issues credit before pausing.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains both functions
  (19 calls per caller).
- Changed: `INSTRUCTION.md`: P1.8 carried-in item names the exact locked-collateral debit test
  (lock everything, a debit of 1 reverts `InsufficientAvailableCredit(1, 0)`, a debit of exactly
  the unlocked part succeeds), moved from P1.5; P1.13 close-out grep now covers both
  `forge-lint: disable` and `slither-disable` in `src/`, with D-30 as the only allowed survivor
  so far.
- Changed: `contracts/.gas-snapshot`: 29 new `AdminCreditTest` lines; 115 changed; none removed;
  `HelpersTest` and `MathTest` unchanged. Over 10%, the three harnesses that grew: the no-USDC
  sweep 159,207,849 to 179,306,245 (+12.6%, 19 calls instead of 17), the participant matrix
  41,351,100 to 63,900,315 (+54.5%, 54 cells instead of 36, debit cells mint first), the pause
  matrix 12,078,413 to 16,955,676 (+40.4%, 16 cells instead of 12). All others +0.02% to
  +0.40%. Diff in `G8.log`.
- Changed (local, not pushed): `docs/decisions.md` D-34.
Slither: with the D-34 line, exit 0, 7 findings (`low-level-calls`, `naming-convention`,
`constable-states`), `slither.log`. Without it, 8 findings including `uninitialized-state`
(high) on `lockedCredit`, so CI step 7 would have failed. **Exit code:** on findings Slither
calls `sys.exit(-1)`; Linux reports 255 (CI run 36807172474, the P0.2 failure), Git Bash on
Windows reports 127 (a bare `sys.exit(-1)` in the same venv also gives 127). The local 127 meant
findings, not "command not found"; Slither ran and printed its results.
Also seen, and pre-existing: `ERROR:ContractSolcParsing: Impossible to generate IR for
Math.mulDivDown`, in every Slither run since P1.3, locally and on CI; raised as O-030.
Size: `IndicoLedger` runtime 6,188 B to 6,598 B (+410 B), margin 17,978 B.
Gate (logs in `docs/gate-logs/P1.5/`, Forge 1.8.3), final run on verified-clean source:
- G1 pass, `G1.log`: 238 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 86/86, branches 29/29.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 238 passed each.
- G6 pass, `G6.log`: three runs, 238 passed each.
- G7 pass, `G7.log`: `ci` profile, 238 passed.
- G8 pass, `G8.log`: `IndicoLedger` 6,598 B runtime; snapshot check 214 passed.
- G9 pass, `G9.log`: see Mutations.
- G13 pass, `G13.log`: grep finds nothing; the planted probe is found, then removed.
- G10 pending: owner pushes. Deep fuzz on this code: the next nightly after the push.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 issue open to anyone: participant matrix. Caught.
- M2 debit works while paused: pause matrix. Caught.
- M3 zero-address check removed: `NotAUser(0x0) != ZeroAddress()`. Caught.
- M4 only merchants refused, never-approved accepted: `test_user_notAUser_bothFunctions`. Caught.
- M5 users refused too: participant matrix `NotAUser(...)`. Caught.
- M6 zero amount accepted: `test_amount_zero_revertsZeroAmount_bothFunctions`. Caught.
- M7 exact available rejected: `InsufficientAvailableCredit(1, 1)`. Caught.
- M8 debit leaves `totalCredit`: `total: 2000000 != 1000000`. Caught.
- M9 debit leaves the balance: `bob: 2000000 != 1000000`. Caught.
- M10 `CreditBurned` memo dropped: `param mismatch at reason`. Caught.
- M11 issue memo dropped: `CreditMinted param mismatch at reason`. Caught.
Incident, the first full gate run (recovered, INSTRUCTION 2 crash rule): the background run that
held G1 to G9 was stopped by the session's background time limit during M10, but its child
process kept running. It left M10 in `IndicoLedger.sol` (found by comparing against the backup,
restored, verified by SHA-256), then went on to apply and restore M11 on its own. A recovery
rerun started inside that window, so its G1 compiled the M11 source and failed
(`CreditMinted param mismatch at reason`), while G2 to G8, built after the restore, passed. No
mutation process was left (`ps`), the source matched its backup, `forge clean`, and the whole
gate ran again: G1 to G8 and G13 in one run, G9 and Slither alone in another. All the results
above are from that final run. The mutation script was also fixed: it refuses to start if a
leftover backup differs from the source (before, it would have copied a still-mutated source
over the good backup), and deletes the backup only after a verified clean finish.
Open items: closed O-027 (C-026); O-025 now 54 of 117 cells; raised O-028 (remove the D-34 line
in P1.8), O-029 (`Math.sol`'s C-006 Slither triage needs its own decision to survive P1.13), and
O-030 (the `mulDivDown` IR error).
Commit: feat: adminIssueCredit and adminDebitCredit, users only, with per-account cap and available-credit debit (P1.5)

### C-029 · P1.5 · CI gate line G10 · 2026-10-03
Type: chore
Files: none changed. Completes the line C-028 left pending.
- Session start (INSTRUCTION 1.2): latest Deep fuzz run 37105728701 on `d397496` green.
- G10 pass, `G10.log`: CI run 37145112275 on `76af755` green. Steps 1 to 3 and 5 to 7 pass,
  step 7 (Slither) with the D-34 line in place; step 4 skipped as designed. The GitHub API
  returned HTTP 504 several times while watching; the run itself was not affected.
- Deep fuzz on P1.5's code (`76af755`): pending, the next nightly. It is also the first night
  under the new `deep.yml` (C-026); `deep.yml` and `contracts/` both changed since the last green
  run, so the gate should run the full deep job. P1.5 is not done until that run is green.
Commit: docs: record P1.5 CI gate result

### C-030 · P0.1 reopened · `Math` renamed `LedgerMath`; CI fails when Slither skips code · 2026-10-04
Type: fix
Decisions: D-35 (new); D-36, D-37 logged for P1.6
Root cause (O-030): two libraries named `Math` in one build, ours and OpenZeppelin's; Slither
resolved `OZMath.mul512` by name to ours and could not build IR for most of `mulDivDown`. Present
from P1.3 to P1.5, bisected by portion. CI step 7 stayed green throughout (runs 36835961990,
37101839327, 37145112275, each logging the error once), because Slither's exit code reflects
findings only. Full analysis in D-35.
Files:
- Changed: `contracts/src/lib/Math.sol`: `library Math` becomes `library LedgerMath` (and the
  `@title`); the OpenZeppelin import stays `Math as OZMath`. Behaviour, error selectors and
  bytecode logic unchanged.
- Changed: `contracts/test/unit/Math.t.sol` (12 references) and `contracts/test/helpers/Fixture.sol`
  (2): `LedgerMath`. No assertion changed.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: two comments name
  `LedgerMath.DivisionByZero` / `LedgerMath.MathOverflow`.
- Changed: `.github/workflows/ci.yml` step 7: Slither's output is kept (`2>&1 | tee slither.log`;
  the runner's `bash -eo pipefail` still fails the step on findings), and the step fails with an
  `::error::` line if it contains `Impossible to generate IR` or `Traceback (most recent call
  last)`.
- Unchanged: `contracts/.gas-snapshot` is byte-identical; the rename costs no gas.
- Changed (local, not pushed): `docs/decisions.md` D-35, D-36, D-37.
Proof:
- IR printer (`--print slithir`), after the rename: `LedgerMath.mulDivDown` has IR for every
  statement: `LIBRARY_CALL, dest:Math, function:Math.mul512(...)`, `UNPACK TUPLE_16 index: 0`,
  `high >= d`, `SOLIDITY_CALL revert MathOverflow()()`, `LIBRARY_CALL ... Math.mulDiv(...)`,
  `RETURN`. Before, everything from the `mul512` call on had empty IR.
- The step-7 body run locally under `bash -eo pipefail`: on the pre-rename source (`76af755`)
  it finds `Impossible to generate IR`, prints `::error::` and exits 1
  (`slither-red-pre-rename.log`); on the renamed source it exits 0 with 7 results
  (`slither.log`). CI red/green on a branch: pending, owner pushes (next entry).
- The C-006 `unused-return` triage in `mulDivDown` is now actually exercised (the tuple has IR) and
  still holds: 7 findings, unchanged.
Gate (logs in `docs/gate-logs/P0.1-reopen/`, Forge 1.8.3):
- G1 pass, `G1.log`: 238 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 86/86, branches 29/29.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 238 passed each.
- G6 pass, `G6.log`: three runs, 238 passed each.
- G7 pass, `G7.log`: `ci` profile, 238 passed.
- G8 pass, `G8.log`: `IndicoLedger` 6,598 B, `MathHarness` 469 B; snapshot check 214 passed, no
  change.
- G9 pass, `G9.log`: see Mutations.
- G13 pass, `G13.log`.
- G10 pending: owner pushes the branch (red, then green), then `main`.
- G12: this entry.
Mutations (G9), each on `src/lib/Math.sol`, restored byte-identical by SHA-256 after each:
- M1 `ceilDiv` rounds down: the rounding property `true != false`. Caught.
- M2 `ceilDiv` zero divisor unchecked: panic `0x12` instead of `DivisionByZero`. Caught.
- M3 `mulDivDown` overflow check removed: panic `0x11` instead of `MathOverflow`. Caught.
- M4 overflow check `>=` to `>`: panic `0x11` instead of `MathOverflow`. Caught.
- M5 `mulDivDown` zero divisor unchecked: `MathOverflow` instead of `DivisionByZero`. Caught.
Open items: closed O-030; raised O-031 (backend: merchant terms status and "merchant not ready").
Commit: fix: rename Math to LedgerMath so Slither analyses mulDivDown in full; CI fails on Slither IR errors (P0.1 reopen)

### C-031 · P0.1 reopened · CI red/green for the Slither guard · 2026-10-04
Type: chore
Files: none changed. Completes the CI proof C-030 left pending.
- Red: branch `slither-guard`, commit `adff058` (guard only, pre-rename code), run 37161519237
  failed at step 7 on `4:ERROR:ContractSolcParsing:Impossible to generate IR for Math.mulDivDown`,
  while Slither itself reported "7 result(s) found" and would have passed.
- Green: commit `300ec28` (rename added), run 37161530402, step 7 green; the only log line
  matching "Impossible to generate IR" is the runner echoing the guard's own `grep` command.
- Both commits go to `main` by fast-forward; the branch is then deleted.
Commit: docs: record CI red/green for the Slither guard

### C-032 · P1.6 · spend · 2026-10-04
Type: feature
Decisions: D-36, D-37 (logged in C-030); D-22, D-26, D-27, D-30, D-34 applied
Session start (INSTRUCTION 1.2): latest Deep fuzz run 37105728701 green; P1.5's own deep run
(next nightly) still pending. `main` CI after the P0.1 reopen, run 37162976091 on `b16bd30`,
green including the guarded step 7.
Files:
- Changed: `contracts/src/IndicoLedger.sol`: `spend(merchant, amount)`, `whenNotPaused`. Reverts
  in order `NotApprovedUser`, `TermsNotSigned`, `ZeroAddress` (D-37), `NotApprovedMerchant`,
  `MerchantTermsNotSigned(merchant)` (D-37), `ZeroAmount`,
  `InsufficientAvailableCredit(amount, available)`. Moves exactly `amount` from payer to
  merchant, no fee (S-05); `totalCredit` unchanged; emits `Spent` and `MerchantReceipt(...,
  block.timestamp)`, the time a record only (D-26). Paying yourself is refused by the merchant
  check: a user is never an approved merchant (D-22). A merchant may exceed `CREDIT_CAP`, since
  `spend` is not a mint (D-27).
  - D-34: no new line. `spend` reads `lockedCredit`; Slither reports per declaration, and the
    existing line above `lockedCredit` covers it (CI-guarded step 7 exits 0, 7 results).
  - D-30: no line yet. The Forge linter does not flag `approvedMerchant`: it treats a check
    against `msg.sender` as access control (`approvedUser[msg.sender]`), and `spend` checks the
    payee parameter (`approvedMerchant[merchant]`). Confirmed with a fresh build, and in a scratch
    copy without the existing `approvedUser` line only `approvedUser` is flagged. It should fire
    in P1.7, when `deposit` checks `approvedMerchant[msg.sender]`.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: error
  `MerchantTermsNotSigned(address merchant)`; the `spend` comment with the check order.
- New: `contracts/test/unit/Spend.t.sol`: partition tables for merchant and amount, 28 tests.
  Exact move with both events and the warped time, exactly two events, one wei, exactly
  available, two merchants, signed only older terms on both sides, a merchant above the cap via
  two spends (D-27), fuzz within available conserving `totalCredit`. Amount: zero, available plus
  one, `uint256` max, no credit, fuzz above available. Merchant: zero (`ZeroAddress`); the
  ledger, USDC, a stranger, another user, a revoked merchant and the admin
  (`NotApprovedMerchant`); `test_spendToSelf_revertsNotApprovedMerchant_D22`; an approved but
  unsigned merchant reverts `MerchantTermsNotSigned` and can be paid once signed. Caller: five
  non-users, revoked (credit kept), approved but unsigned, paused. Seven check-order tests.
  Every revert asserts the full snapshot unchanged.
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `spend` column (O-025), 7 of 13, 63 of
  117 cells; every participant holding the user role gets credit first, so each cell fails on
  access alone: only ApprovedAndSigned pays, ApprovedNotSigned gets `TermsNotSigned`, the other
  seven `NotApprovedUser`.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 9 x 2 with `spend` (paused
  `EnforcedPause`); the row approves and signs merchantA and issues alice credit before pausing.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains `spend` (20 calls).
- Changed: `contracts/.gas-snapshot`: 26 new `SpendTest` lines; 122 changed; none removed;
  `HelpersTest` and `MathTest` unchanged. Over 10%: the participant matrix 63,900,315 to
  75,247,520 (+17.8%, 63 cells instead of 54) and the pause matrix 16,955,676 to 19,779,603
  (+16.7%, 18 cells instead of 16). All others -0.01% to +5.62%. Diff in `G8.log`.
Size: `IndicoLedger` runtime 6,598 B to 6,974 B (+376 B), margin 17,602 B.
Slither, CI step 7 body under `bash -eo pipefail`: exit 0, no IR error, 7 findings (`slither.log`).
Gate (logs in `docs/gate-logs/P1.6/`, Forge 1.8.3; G1 to G8 and G13 in one run, G9 and Slither in
another):
- G1 pass, `G1.log`: 266 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 99/99, branches 36/36.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 266 passed each.
- G6 pass, `G6.log`: three runs, 266 passed each.
- G7 pass, `G7.log`: `ci` profile, 266 passed.
- G8 pass, `G8.log`: `IndicoLedger` 6,974 B runtime; snapshot check 240 passed.
- G9 pass, `G9.log`: see Mutations.
- G13 pass, `G13.log`.
- G10 pending: owner pushes. Deep fuzz: the next nightly covers P1.5, the P0.1 reopen and P1.6.
- G11: none beyond the gate.
- G12: this entry.
Mutations (G9), each on `IndicoLedger.sol`, restored byte-identical by SHA-256 after each:
- M1 payer approval removed: `TermsNotSigned() != NotApprovedUser()`. Caught.
- M2 payer terms removed: participant matrix. Caught.
- M3 zero merchant unchecked: `NotApprovedMerchant() != ZeroAddress()`. Caught.
- M4 merchant approval removed: `MerchantTermsNotSigned(...) != NotApprovedMerchant()`. Caught.
- M5 merchant terms removed (D-37): `test_merchant_approvedNotSigned_reverts`. Caught.
- M6 zero amount accepted: `test_amount_zero_revertsZeroAmount`. Caught.
- M7 exact available rejected: `InsufficientAvailableCredit(1e6, 1e6)`. Caught.
- M8 merchant not credited: `merchant: 0 != 1000000`. Caught.
- M9 payer not debited: `payer: 1000000 != 0`. Caught.
- M10 a hidden 1% fee (S-05): `merchant: 990000 != 1000000`. Caught.
- M11 receipt time zero: `MerchantReceipt param mismatch at at`. Caught.
- M12 works while paused: pause matrix. Caught.
Open items: O-025 now 63 of 117 cells. None raised.
Commit: feat: spend with no fee, merchant must be approved and have signed, receipt with time (P1.6)

### C-033 · P1.6 · CI gate line G10 · 2026-10-04
Type: chore
Files: none changed. Completes the line C-032 left pending.
- G10 pass, `G10.log`: CI run 37166966600 on `1a9c993` green. Steps 1 to 3 and 5 to 7 pass,
  step 7 with the IR guard (C-030); step 4 and the Phase-0 skip step skipped as designed.
- Deep fuzz on P1.6's code: pending, the next nightly, which also covers P1.5 (`76af755`) and the
  P0.1 reopen (`300ec28`). `contracts/` and `deep.yml` changed since the last green run
  (`d397496`), so the check job must choose the full run. P1.5, the P0.1 reopen and P1.6 are not
  done until it is green.
Commit: docs: record P1.6 CI gate result

### C-034 · P1.7 · Pool: deposit, withdraw, withdrawAll · 2026-10-04
Type: feature
Decisions: D-38, D-39 (owner approved), D-40 (proposed, for approval at this gate); D-06, D-30
applied
Session start (INSTRUCTION 1.2): latest finished Deep fuzz run 37105728701 green. The owner had
Deep fuzz dispatched on `main` instead of waiting for the night: run 37169050467 on `1a9c993`
(P1.6, covering P1.5, the P0.1 reopen and P1.6), check job `run=true`, deep job in progress when
this gate finished. P1.7 is built on branch `p1.7` under the new branch rule (INSTRUCTION 1.1) and
merges only after that run is green.
Files:
- Changed: `contracts/src/IndicoLedger.sol`:
  - Inherits OpenZeppelin `ReentrancyGuard`; `SafeERC20` for every USDC call.
  - New state `poolUsdc` (D-38), added to the D-17 layout.
  - `deposit(amount)`: `nonReentrant`, `whenNotPaused`; reverts in order `NotApprovedMerchant`,
    `TermsNotSigned`, `ZeroAmount`; `safeTransferFrom`, then shares on the change in balance,
    `ZeroShares` if none; `poolUsdc += received`; emits `Deposited(m, received, shares)`.
  - `withdraw(assets)` (D-39): reverts in order `ZeroAmount`, `InsufficientShares(needed, held)`,
    `InsufficientLiquidity(assets, poolUsdc)`; burns shares rounded up; no approval check, so a
    revoked merchant withdraws.
  - `withdrawAll()` (D-39): pays `min(claim, poolUsdc)`; a whole claim burns every share; short of
    cash it burns only the rounded-up shares for the cash; `ZeroAmount` if worth 0,
    `InsufficientLiquidity(owed, 0)` with no cash.
  - Private `_toShares(assets, roundUp)`, `_toAssets(shares)`: `S + 1e6` and
    `poolUsdc + totalLent + 1` (D-38), never `balanceOf`; `_payOut`: effects, event, transfer.
  - Lint: removed the D-18 suppression on `totalShares`, now written (O-017). Added the D-30 line
    above `approvedMerchant[m] = approved;`, first triggered by `deposit` gating on
    `approvedMerchant[msg.sender]`, as predicted in C-032. Added D-40: `reentrancy-events` on
    `Deposited` and `Withdrawn`, Slither `incorrect-equality` on `minted == 0` and `owed == 0`, and
    Slither `uninitialized-state` around `totalLent` until P1.8.
- Changed: `contracts/src/lib/Math.sol`: `mulDivUp`, rounding up with named reverts, including a
  floor of exactly 2^256 - 1 with a remainder. `ceilDiv` and `mulDivDown` unchanged.
- Changed: `contracts/src/lib/Constants.sol`: `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: `withdraw(uint256 assets)`, new
  `withdrawAll()`, view `poolUsdc()`, error `ZeroShares()`, `InsufficientShares(needed, held)`;
  pool comments with the check order and the direct-transfer warning. Depends on it: the backend
  error map and calldata builders (P1.13).
- New: `contracts/test/unit/Pool.t.sol`: partition tables for deposit, withdraw and withdrawAll,
  54 tests: exact effects and events, emits nothing else, one wei, offset shares, after a loss,
  after a total wipeout (no division by zero), fee-on-transfer, 100% fee (`ZeroShares`),
  balance, allowance, `uint256` max, token returns false, blacklisted, re-entry 3 x 3, every
  caller class, check orders, revoked merchant withdraws, burn rounds up, short of cash then the
  rest, share price unchanged, two equal depositors split a loss within one wei, two merchants in
  either order, `test_merchantDirectTransfer_isStuck_noShareNoPoolUsdcNoPriceChange`, a fuzz over
  direct transfers in four pool states, the classic inflation attack (victim exact), and the
  rounding pump after a loss (attacker never profits, victim loss <= 1 wei + attacker loss / 1e6).
  Books (`usdc.balanceOf(ledger) >= poolUsdc`) asserted after every test that moves USDC. A loan's
  pool side is simulated by writing storage (O-033).
- Changed: `contracts/test/helpers/Fixture.sol`: pool model with its own copy of the offset
  (`_modelSharesFor`, `_modelSharesToBurn`, `_modelClaim`), `_deposit`, and `_simulateLend`,
  `_simulateRepay`, `_simulateDefault` (stdstore on `poolUsdc`/`totalLent`, USDC to and from a
  sink address).
- Changed: `contracts/test/helpers/StateSnapshot.sol`: records `poolUsdc`.
- Changed: `contracts/test/unit/Math.t.sol`: `mulDivUp` partition table, 11 rows and 2 fuzz
  properties (down plus remainder; named reverts for exactly the right reason over the domain).
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `deposit` and `withdraw` columns (O-025),
  9 of 13, 81 of 117 cells: only Merchant deposits; Merchant and MerchantRevoked withdraw; the rest
  `NotApprovedMerchant` / `InsufficientShares(1e12, 0)`.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 12 x 2 with `deposit`, `withdraw`,
  `withdrawAll`, each `EnforcedPause` while paused: contract-spec 6 makes every 6.5 function
  `whenNotPaused` and states no exception.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains the three pool
  functions (23 calls). Its assertion changes, because a merchant may now move its own USDC: no
  caller moves anyone else's USDC, any movement is between the caller and the ledger and booked in
  `poolUsdc`, and the 500,000 USDC sent to the ledger outside the pool never leaves. Stricter on the
  books than before, not looser: the old check could not tell booked from unbooked USDC.
- Changed: `INSTRUCTION.md`: branch rule (1.1); P1.7 scope; carried-in items for P1.8, P1.9 and
  P1.11 (O-033, O-034).
- Changed: `contracts/.gas-snapshot`: 65 new lines (Pool 54, Math 11); 204 changed; none removed;
  `HelpersTest` unchanged. Over 10%, the three harnesses that grew: pause matrix 19,779,603 to
  29,343,310 (+48.4%, 24 cells instead of 18), participant matrix 75,247,520 to 98,793,820
  (+31.3%, 81 cells instead of 63), no-USDC sweep 189,389,846 to 226,433,923 (+19.6%, 23 calls
  instead of 20). `MathTest` lines rose up to 5.5%: its harness has one more function.
- Changed (local, not pushed): `docs/decisions.md` D-38 to D-40; `docs/contract-spec.md` 4, 5,
  6.5, 8, 9 (I1, I10, new I14); `docs/lint-probes/reentrancy-events/`.
Test fixed during the gate (INSTRUCTION 1.3): the first G5 to G7 runs failed
`testFuzz_withdrawAll_shortOfCash_twoPaymentsWithinTwoWei` with `ZeroAmount()` at args
`[7, 6, 16395, 18]`: claim 6, cash 5; the first `withdrawAll` paid 5 and its rounded-up burn left
shares worth 0.99999 wei, so the second correctly reverted `ZeroAmount` (total 5, within the
2-wei bound). The test wrongly called the second unconditionally; it now expects `ZeroAmount`
when the rest is worth under 1 wei. Bound assertions unchanged. Also removed six inline
`forge-config: default.fuzz.runs = 10000` lines from `Pool.t.sol`, which would have capped those
fuzz tests below the `ci` and `deep` profiles. The whole gate then ran again; results below.
Size: `IndicoLedger` runtime 6,974 B to 8,771 B (+1,797 B), margin 15,805 B.
Slither, CI step 7 body under `bash -eo pipefail`: exit 0, no IR error, 6 findings
(`low-level-calls`, `naming-convention`, `constable-states`), `slither.log`. Without D-40, 9
findings including `uninitialized-state` (high) and `incorrect-equality` (medium).
Gate (logs in `docs/gate-logs/P1.7/`, Forge 1.8.3; red phase in `red.log`):
- G1 pass, `G1.log`: 339 passed, 0 failed, 0 skipped, exit 0.
- G2 pass, `G2.log`: src lines 145/145, branches 49/49.
- G3 pass, `G3.log`: exit 0.
- G4 pass, `G4.log`: `forge build --deny warnings` exit 0.
- G5 pass, `G5.log`: seeds 1 and 2, 339 passed each.
- G6 pass, `G6.log`: three runs, 339 passed each.
- G7 pass, `G7.log`: `ci` profile, 339 passed.
- G8 pass, `G8.log`: `IndicoLedger` 8,771 B runtime; snapshot check 305 passed.
- G9 pass, `G9.log`: see Mutations.
- G13 pass, `G13.log`.
- G10 pending: owner pushes `p1.7`. Merge to `main` waits for Deep fuzz run 37169050467.
- G11: none beyond the gate; the owner reads this report line by line.
- G12: this entry.
Mutations (G9), on `IndicoLedger.sol` and `Math.sol`, restored byte-identical by SHA-256 after each:
- M1 virtual offset removed: `DivisionByZero()` in the pause matrix. Caught.
- M2 burn rounds down (`mulDivUp` to `mulDivDown`): withdraw fuzz `kept more than the rest`. Caught.
- M3 assets from `usdc.balanceOf`: pause matrix shares `999999 != 1e12`. Caught.
- M4 `withdrawAll` leaves dust shares: `dust shares left: 190654 != 0`. Caught.
- M5 shares on the amount asked: `Deposited param mismatch at shares`. Caught.
- M6 deposit merchant check removed: `TermsNotSigned() != NotApprovedMerchant()`. Caught.
- M7 deposit terms check removed: `did not revert`. Caught.
- M8 `ZeroShares` removed: the 100% fee test `did not revert`. Caught.
- M9 withdraw share check removed: `InsufficientLiquidity != InsufficientShares`. Caught.
- M10 withdraw liquidity check removed: panic `0x11` instead of the named error. Caught.
- M11 exactly the claim rejected: `InsufficientShares(1e12, 1e12)`. Caught.
- M12 `nonReentrant` off `withdraw`: the re-entry loop gets the wrong revert. Caught.
- M13 `withdrawAll` while paused: pause matrix. Caught.
- M14 withdraw refuses a revoked merchant: participant matrix. Caught.
- M15 short of cash burns every share: `burned everything on a partial payment`. Caught.
- M16 no-cash check removed: `did not revert`. Caught.
- M17 `Deposited` reports the amount asked: `param mismatch at assets`. Caught.
- M18 `mulDivUp` never rounds up: `17452 != 17453`. Caught.
- M19 `mulDivUp` max check removed: panic `0x11` instead of `MathOverflow`. Caught.
Open items: closed O-017; O-018 now covers both `totalLent` suppressions; O-025 now 81 of 117;
raised O-032, O-033, O-034.
Commit: feat: share pool with internal USDC accounting and virtual offset, withdraw by amount and withdrawAll (P1.7)

### C-035 · P1.7 · CI gate line G10 · 2026-10-04
Type: chore
Files: none changed. Completes the line C-034 left pending.
- G10 pass, `G10.log`: CI run 37176543026 on `13bfa7d` (branch `p1.7`) green. Steps 1 to 3 and 5
  to 7 pass, step 7 with the D-40 suppressions in place; step 4 and the Phase-0 skip step skipped
  as designed. A second run, 37176538588, is the branch's first push at `6b91448` (P1.6 docs),
  also green.
- Deep fuzz run 37169050467 on `1a9c993` (P1.6, covering P1.5 and the P0.1 reopen): still in
  progress. `p1.7` merges to `main` only once it is green (INSTRUCTION 1.1, branch rule).
Commit: docs: record P1.7 CI gate result

### C-036 · Deep fuzz green on P1.6; P1.7 pause decision; D-40 evidence · 2026-10-04
Type: chore
Decisions: D-41 (new, owner decided); D-40 evidence corrected before approval
Files:
- Deep fuzz pass, `docs/gate-logs/P1.6/deep-ci.log`: run 37169050467 on `1a9c993`, dispatched by
  hand, check job `run=true`, **266 passed, 0 failed, 0 skipped**, 15,706.83 s (4h22m, 73% of the
  job's `timeout-minutes: 360`). It covers P1.5 (`76af755`), the P0.1 reopen (`300ec28`) and P1.6:
  all three are done (INSTRUCTION 1.2). `p1.7` may merge under the branch rule.
- Found in that log: the 9 `Math.t.sol` properties ran **100,000** times, not 5,000,000. Their
  inline `forge-config: default.fuzz.runs = 100000` applies to the `deep` profile too, so
  `LedgerMath` has never been Deep-fuzzed at 5M since P0.1. The two `mulDivUp` properties added in
  C-034 carry the same line. Raised O-036.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 12 x 3, adding "paused then
  unpaused", expected to equal "unpaused" in every row: the three pool functions revert
  `EnforcedPause` while paused and work again after the unpause (D-41).
- Changed: `contracts/src/IndicoLedger.sol`: the D-40 comment on `Withdrawn` now says what the
  probe showed (flagged with no external call on the path). Comment only.
- Changed (local, not pushed): `docs/decisions.md` D-41; D-40 rows for `Withdrawn` and
  `incorrect-equality` corrected with the new probes; `docs/lint-probes/reentrancy-events/`
  (`RESULT.md` rewritten, `ProbeEvents.sol`, `IndicoLedger.stripped.sol`) and
  `docs/lint-probes/slither-incorrect-equality/`.
- Correction to C-034: it said the `reentrancy-events` rule "flags an event in any function that
  also makes an external call, whatever the order". Wrong as a general statement: a minimal
  contract emitting before a call is not flagged. On `Withdrawn` it fires even with no external
  call on the path at all, so it is a false positive there; the trigger was not isolated.
Gate: rerun in full on `p1.7` after these changes, in the entry that follows.
Open items: raised O-035, O-036.
Commit: test: pool functions work again after unpause (D-41); record Deep fuzz green on P1.6

### C-037 · P1.7 · Gate rerun after C-036 · 2026-10-04
Type: chore
Files: none beyond C-036.
- `contracts/.gas-snapshot`: `PauseTest:test_pauseMatrix_everyCell` 29,343,310 to 44,979,359
  (+53.3%, 36 cells instead of 24, the new column pausing and unpausing first);
  `ConstructorTest:test_decimalsReverts_reverts` 127,898 to 127,886 (-12). Nothing else.
Gate (logs in `docs/gate-logs/P1.7/`, Forge 1.8.3, rerun in full):
- G1 pass: 339 passed, 0 failed, 0 skipped, exit 0.
- G2 pass: src lines 145/145, branches 49/49.
- G3 pass, G4 pass: exit 0 each.
- G5 pass: seeds 1 and 2, 339 passed each.
- G6 pass: three runs, 339 passed each.
- G7 pass: `ci` profile, 339 passed.
- G8 pass: `IndicoLedger` 8,771 B runtime; snapshot check 305 passed.
- G9 pass: M1 to M19 rerun, all caught, sources byte-identical, backups removed.
- G13 pass.
- G10 pending: owner pushes `p1.7`.
Commit: part of the C-036 commit.

### C-038 · chore · Deep fuzz split by test file, run-count guard, Math at 5M; D-40 approved · 2026-10-05
Type: chore
Decisions: D-42 (new, owner decided), D-43 (new, decided in principle, not built); D-40 approved
by the owner, all five lines
Files:
- Changed: `.github/workflows/deep.yml`: the `check` job also lists `test/**/*.t.sol` into a JSON
  matrix (`files`) and runs the guard's self-check; the `deep` job runs once per file
  (`fail-fast: false`, 360 minutes each), `forge test --profile deep --match-path <file>`, its
  output kept in `deep.log`, then the guard. D-31's skip logic unchanged (D-42).
- New: `.github/scripts/deep-runs-guard.sh`: fails a shard with no forge summary, with a failure,
  or with any fuzz test under 5,000,000 runs; invariant lines skipped (O-036).
- New: `.github/scripts/deep-runs-guard.test.sh`: 9 cases, all `ok`: all at 5M; one capped at
  100,000; above the minimum; an invariant line; unit tests only; no summary; a failed test; a
  multi-suite summary; a failed fuzz with few runs.
- Changed: `contracts/test/unit/Math.t.sol`: each of the 11 properties gains
  `forge-config: deep.fuzz.runs = 5000000` under its `default.fuzz.runs = 100000` (O-036). No
  assertion changed; G1 still runs them at 100,000.
- Changed: `INSTRUCTION.md` P1.13: the suppressions allowed to survive the grep are D-30's two and
  D-40's four permanent lines; D-34's line and D-40's `totalLent` pair must be gone.
- Changed: `DECISION.md` O-026: also covers D-40's `reentrancy-events` and `incorrect-equality`
  probes.
- Changed (local, not pushed): `docs/decisions.md` D-40 marked approved with the owner's
  conditions; D-42, D-43.
Proof (`docs/gate-logs/P1.7/deep-split/`), real forge output under the `deep` profile on a
scratch copy, through the guard:
- A: `testFuzz_remapForgeAddress_neverAForgeAddress` uncapped: `runs: 5000000`, guard exit 0.
- B: the same test with `deep.fuzz.runs = 100000`: `runs: 100000`, guard exit 1, naming it.
  Cap removed; scratch file restored byte-identical.
- C: `testFuzz_ceilDiv_revertsCleanlyNeverPanics` as committed before this change:
  `runs: 100000`, guard exit 1 (the O-036 defect).
- D: the same with the `deep` override line: `runs: 5000000`, guard exit 0.
Gate for this change (`chore-gate.log`): `forge fmt --check` exit 0; `forge build --deny warnings`
exit 0; `forge test` 339 passed, 0 failed, 0 skipped; snapshot check 305 passed; G13 grep finds
nothing. `src/` unchanged, so G2 and G9 stand from C-037.
Pending: the first Deep fuzz run under the split, on P1.7's code, is the CI proof; its per-shard
times are recorded against the D-42 estimates.
Open items: O-036 closed when that run shows every Math property at 5,000,000; raised O-037.
Commit: ci: deep fuzz one shard per test file with a 5M run-count guard; Math properties at 5M under deep

### C-039 · chore · Deep fuzz "last green" matched by commit on any branch; cancelled counts as red · 2026-10-05
Type: chore
Decisions: D-31 amended (owner's request)
Context: the owner's push of `cc5d15e` and `bda482b` went to `main`, not `p1.7`, so P1.7 merged
before its own Deep run. Also found: the scheduled run 37186138489 on `23072b6` (P1.7's code, the
old single-job workflow) was **cancelled at 6h00m** with no test failing, as D-42 predicted.
- G10 for `23072b6`: CI run 37181776408 green. G10 for `cc5d15e`: run 37206681236 green.
- G10 for `bda482b` (C-038, the Deep split): CI run 37228930106 green; only the designed skips.
Files:
- New: `.github/scripts/deep-last-green.sh`: from "<sha> <deep job conclusions>" lines, newest
  first, prints the first sha whose deep jobs all ran and all passed; skips runs whose deep job was
  skipped, partly failed or cancelled, or that have no deep job.
- Changed: `.github/workflows/deep.yml` (`check` job): "last green" from successful runs on any
  branch (30 newest), each with its deep job conclusions, through `deep-last-green.sh`; the last
  completed run is still looked up on `main`.
- Changed: `.github/scripts/deep-should-run.sh`: a `cancelled` last run stays red like a
  `failure` when nothing changed since it; header comment updated.
- Changed: `.github/scripts/deep-should-run.test.sh`: 8 new cases, 19 in all, all `ok`:
  cancelled and unchanged stays red; cancelled then contracts changed runs; `main` fast-forwarded
  to a green branch run's commit skips; and five for `deep-last-green.sh` (newest full green wins;
  a skip is passed over; a split run counts only if every shard passed; a run with no deep job is
  passed over; nothing green gives empty).
- Changed (local, not pushed): `docs/decisions.md` D-31 amendment.
Checks: YAML parses; the backslash lines in `deep.yml` are the jq `\(...)` interpolations, shown
and intact (two line continuations written by a script had collapsed and were rewritten by hand;
a `printf` escape that had become a real newline was replaced by `echo`); the query run live
against the repository returns `1a9c993`, run 37169050467, the last full green run.
Open items: none.
Commit: ci: deep fuzz counts a full green run on any branch by commit; a cancelled run stays red

### C-040 · P1.7 done · First split Deep fuzz run green; O-036 closed · 2026-10-05
Type: chore
Files: none changed.
- G10 for `b39b4f3` (C-039): CI run 37229897755 green.
- Deep fuzz pass, `docs/gate-logs/P1.7/deep-ci/`: run 37231202052 on `b39b4f3`, dispatched on
  `main`, the first run under D-42. `check` green (its guard self-check included); **14 of 14
  shards green, 339 tests passed, 0 failed, 0 skipped**. P1.7 is done (INSTRUCTION 1.2).
- Guard (O-036): every shard printed `ok`; **all 34 fuzz tests ran 5,000,000 times**, including
  all 11 `Math.t.sol` properties (`fuzz-runs.txt`). O-036 closed.
- Shard times against the D-42 estimates (job wall time; the suite time forge printed is in
  brackets):

  | Shard | Estimate | Actual | % of 360 |
  |---|---|---|---|
  | `Pool.t.sol` | 208 | 268.5 (16,079 s) | 75% |
  | `AdminCredit.t.sol` | 87 | 100.0 (5,977 s) | 28% |
  | `SignTerms.t.sol` | 89 | 65.2 (3,885 s) | 18% |
  | `RegisterAsset.t.sol` | 83 | 57.1 (3,400 s) | 16% |
  | `Spend.t.sol` | 80 | 56.5 (3,358 s) | 16% |
  | `Pause.t.sol` | 85 | 45.5 (2,700 s) | 13% |
  | `Math.t.sol` | 27 | 10.7 (618 s) | 3% |
  | the other 7 | under 20 each | under 6 each | under 2% |

  About 620 billed minutes in all (estimate 740).
- Why `Pool.t.sol` ran over its estimate: forge printed the same CPU time as wall time for every
  shard (for example 16,078.94 s and 16,078.94 s CPU), so within one file the fuzz tests ran one
  after another, not on both cores. The estimate assumed two. A shard's time is therefore the sum
  of its fuzz tests, and `Pool.t.sol` is at 75%, close to D-42's 80% split line; the tests O-033
  adds to it in P1.8 to P1.11 would cross it. D-43 (O-037, next) is the planned fix; if it does not
  bring the shard well under, `Pool.t.sol` is split by test name per D-42.
- The next nightly should find this run as the last full green (C-039) and skip; recorded when it
  happens.
Open items: closed O-036.
Commit: docs: record P1.7 Deep fuzz green under the split; O-036 closed

### C-041 · D-43 · Revert and fuzz tests prove "nothing else changed" with the state diff · 2026-10-05
Type: chore (tests only; `src/` unchanged)
Decisions: D-43 (built; owner decided in principle, measurements and scope recorded before code)
Why: the full re-read `StateSnapshot` was about 95% of a revert fuzz run's gas (432,554 +
458,752 around a 50,503-gas call), which drove Deep fuzz to about 620 billed minutes and
`Pool.t.sol` to 75% of its 360-minute limit (C-040).
Files:
- Changed: `contracts/test/helpers/StateSnapshot.sol`: `_revertsUnchanged(who, data, err)` (low-level
  call, exact revert bytes, then `_assertNoChange`), `_startDiff`, `_stopDiff` (net changed slots on
  every account, writes in reverted frames dropped, plus ETH moved or accounts created),
  `_assertNoChange`, `_assertWrites(expected)` (exact set of net changed slots with values),
  `Write`, `_key`, `_w`. The value snapshot stays for non-fuzz success tests.
- Changed: `contracts/test/helpers/Fixture.sol`: storage slot constants (from `forge inspect
  storageLayout`) moved here; the loan simulation writes them with `vm.store` instead of searching
  with `stdstore` (537,328 gas a call before).
- New: `contracts/test/helpers/StateDiff.t.sol`: 11 tests: every slot constant checked against its
  getter; `_assertNoChange` passes after a revert (including a write made before the revert) and
  fails after a write or an ETH move; `_assertWrites` passes on the exact set and fails on a
  missing, extra or wrong-valued write; a slot restored within the call and a write in a reverted
  inner call are not net changes. Each failing case checked to fail for its own reason.
- Changed: revert helpers in `AdminCredit`, `RegisterAsset`, `SignTerms`, `Spend`, `Pool` and
  `Pause` (`_assertDenied`) use `_revertsUnchanged`; the fuzz success paths in `AdminCredit`,
  `RegisterAsset`, `SignTerms`, `Spend`, `Membership` and `Pool` assert their exact net writes;
  `AdminCreditTest` builds its revoked user once in `setUp` instead of on every fuzz run.
- Changed: `INSTRUCTION.md` 1.4: a revert test proves nothing changed with `_revertsUnchanged` (or,
  non-fuzz, `_assertUnchanged`); every fuzz success path asserts its exact net writes.
- Changed: `contracts/.gas-snapshot`: 11 new `StateDiffTest` lines; 160 changed; none removed.
  107 over 10%, all from this change: revert tests 40% to 95% lower (for example
  `AdminCreditTest:test_nonAdmins_revert_bothFunctions` 13,113,438 to 625,962); two AdminCredit
  success tests about 12% higher, because `setUp` now adds one actor to every value snapshot.
- Changed (local, not pushed): `docs/decisions.md` D-43 (measurements, the Forge finding, scope).
Found while building, and why `_revertsUnchanged` uses a low-level call: under `vm.expectRevert`,
Forge 1.8.3's state diff reports the reverted frame as not reverted. Shown on `registerAsset`
(marks the hash, then the mint reverts on the cap): with `expectRevert` the write is reported as
surviving although `assetRegistered` is still false; with a low-level call it is reported as
reverted. A false alarm, never a false pass, but the helper avoids it.
Strictness proof (`docs/gate-logs/D-43/`):
- Every earlier G9 mutation rerun against the new tests: P0.1 reopen 5/5, P1.1 10/10, P1.2 10/10,
  P1.3 10/10, P1.4 12/12, P1.5 11/11, P1.6 12/12, P1.7 19/19: **89 of 89 caught**, sources
  restored byte-identical after each. Three (P1.4 M1, M2; P1.5 M7) were not applied on the first
  pass, because their old pattern now also matches `spend` and `requestLoan`; rerun with patterns
  scoped to their function (`G9-redo.log`), all three caught.
- New mutation the old check missed: `spend` also writes `assetRegistered[merchant]`, a slot the
  snapshot never read. Old tests: 308 passed, missed (`stray-slot-old.log`). New tests: caught,
  `unexpected write` in `testFuzz_spend_withinAvailable_conserves` (`stray-slot-new.log`).
Gas per fuzz run, same seed (`gas-compare.txt`), the three heaviest: rounding pump 2,424,273 to
2,006,590 (-17%; its 40-step loop of real calls is the remaining cost); admin-credit sequence
1,438,664 to 1,131,598 (-21%); direct transfer 1,345,800 to 312,461 (-77%). Revert fuzz tests
-80% to -94%; success fuzz tests +24% to +30% (the exact-write check).
New Deep estimate per shard (`deep-estimate.md`, run 37231202052 scaled by the gas ratio):
`Pool.t.sol` 268.5 to about 164 minutes (75% to 46%); `AdminCredit` 100 to about 56; every other
shard under 20. All shards about 620 to about 294 billed minutes.
Gate (logs in `docs/gate-logs/D-43/`, Forge 1.8.3):
- G1 pass: 350 passed, 0 failed, 0 skipped, exit 0.
- G2 pass: src lines 145/145, branches 49/49 (`src/` unchanged).
- G3 pass, G4 pass: exit 0 each.
- G5 pass: seeds 1 and 2, 350 passed each.
- G6 pass: three runs, 350 passed each.
- G7 pass: `ci` profile, 350 passed.
- G8 pass: `IndicoLedger` 8,771 B runtime, unchanged; snapshot check 316 passed.
- G9 pass: the strictness proof above.
- G13 pass.
- G10 pending: owner pushes. Slither: `src/` unchanged since C-040, same result.
Open items: closed O-037.
Commit: test: prove "nothing else changed" with the state diff instead of re-reading state (D-43)

### C-042 · P1.8 · requestLoan · 2026-10-05
Type: feature
Decisions: D-44, D-45, D-46 (owner approved), D-47 (owner decided: Option X); D-05, D-27, D-32,
D-34, D-40 applied
Session context: built on branch `p1.8` from `1e63f3d` (D-43, C-041) under the branch rule; D-43's
Deep fuzz run 37281472022 on `1e63f3d` is in progress, and `p1.8` merges only once it is green.
Correction to C-041: its commit line contains double quotes, which Windows PowerShell 5.1 split
when passing them to git, so that commit failed; it went in as `1e63f3d` "test: prove nothing
else changed with the state diff instead of re-reading state (D-43)".
Files:
- Changed: `contracts/src/IndicoLedger.sol`:
  - `requestLoan(principal)`: `nonReentrant`, `whenNotPaused`; reverts in order (D-45)
    `NotApprovedUser`, `TermsNotSigned`, `ZeroAmount`, `InsufficientAvailableCredit(collateral,
    available)`, `InsufficientLiquidity(principal, poolUsdc)`; collateral
    `LedgerMath.mulDivUp(principal, BPS, LTV_BPS)` (never a panic; above `uint128` it exceeds any
    user's credit, D-27); `loanId = ++nextLoanId` (D-44); stores the loan (due `now + TERM`,
    `SafeCast` for the three narrowed fields), `lockedCredit += collateral`, `totalLent +=
    principal`, `poolUsdc -= principal`; emits `LoanOpened` and `CollateralLocked`, then
    `usdc.safeTransfer` last (checks-effects-interactions).
  - Suppressions deleted, now that the state is written: D-34's Slither line on `lockedCredit`
    (O-028), D-40's Slither pair and D-18's lint line on `totalLent` (O-018), D-18's lint line on
    `nextLoanId` (O-019). Added D-46's two `reentrancy-events` lines on the events.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: the `requestLoan` comment (order, ids,
  events, USDC last).
- New: `contracts/test/unit/RequestLoan.t.sol`: partition table, 32 tests: exact loan, events and
  only those two, exact net writes (state diff, D-43); one wei locks 2; collateral exactly
  available and one wei short; `maxBorrow` opens, one more reverts; above `uint128` and `uint256`
  max named; exactly the pool cash and one more; three loans lock exactly the sum, ids 1 to 3;
  many loans to the limit then one more wei; carried in from P1.5 and P1.6: locked credit can be
  neither spent nor debited (`InsufficientAvailableCredit(1, 0)`), a debit or spend of exactly the
  unlocked part succeeds; revoked user cannot borrow and revocation leaves the loan untouched;
  every caller class, paused, blacklisted borrower, re-entry, five check-order tests; fuzz: opens
  if and only if within credit and cash (exact writes on success, nothing on failure); collateral
  always 1.25x rounded up within one wei.
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `requestLoan` column (O-025), 10 of 13,
  90 of 117 cells: only ApprovedAndSigned borrows; ApprovedNotSigned `TermsNotSigned`; the rest
  `NotApprovedUser`.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 13 x 3 with `requestLoan`.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains `requestLoan` (24
  calls).
- Changed: `contracts/test/unit/Pool.t.sol`: three tests on real loans (O-033, P1.8 part): a loan
  lowers `poolUsdc` by the principal and leaves the price alone; `withdraw` above the cash and
  `withdrawAll` with everything lent revert `InsufficientLiquidity`.
- Changed: `contracts/test/helpers/Fixture.sol` (`SLOT_LOANS = 20`) and `StateDiff.t.sol` (the
  `loans` slots checked against the getter).
- Changed: `contracts/.gas-snapshot`: 33 new lines (RequestLoan 30, Pool 3); 219 changed; none
  removed. Over 10%: participant matrix 98,793,820 to 112,520,116 (+13.9%, 90 cells instead of
  81) and pause matrix 44,982,177 to 51,083,135 (+13.6%, 39 cells instead of 36); all others at
  most +4.8%.
- Changed (local, not pushed): `docs/decisions.md` D-44 to D-47;
  `docs/lint-probes/reentrancy-events/RESULT-requestLoan.md`, `docs/lint-probes/slither-reentrancy/`.
Size: `IndicoLedger` runtime 8,771 B to 9,632 B (+861 B), margin 14,944 B.
Slither, CI step 7 body: exit 0, no IR error, 4 findings (`low-level-calls`, `naming-convention`,
`constable-states` now on `poolCredit` only); with D-34 and D-40's `totalLent` lines gone, no
`uninitialized-state` finding remains.
Gate (logs in `docs/gate-logs/P1.8/`, Forge 1.8.3; red phase `red.log`: 32 of 32 failing on the
missing function):
- G1 pass: 385 passed, 0 failed, 0 skipped, exit 0.
- G2 pass: src lines 164/164, branches 54/54.
- G3 pass, G4 pass (with D-46's two lines): exit 0 each.
- G5 pass: seeds 1 and 2, 385 passed each.
- G6 pass: three runs, 385 passed each.
- G7 pass: `ci` profile, 385 passed.
- G8 pass: `IndicoLedger` 9,632 B; snapshot check 349 passed.
- G9 pass, `G9.log`: 18 of 18 caught (run on a scratch copy with the same source and tests).
- G13 pass.
- G10 pending: owner pushes `p1.8`.
Mutations (G9), each restored byte-identical by SHA-256:
- M1 approval removed; M2 terms removed; M3 zero accepted; M4 collateral rounds down; M5 equal lock
  (the reading D-05 rejected); M6 exactly-available rejected; M7 available ignores locked credit;
  M8 liquidity check removed; M9 liquidity before credit; M10 collateral not locked; M11 `totalLent`
  not raised; M12 `poolUsdc` not lowered; M13 ids from 0; M14 due date a second short; M15 borrower
  paid a wei less; M16 `nonReentrant` removed; M17 works while paused; M18 `CollateralLocked` loan
  id 0. All caught.
Open items: closed O-018, O-019, O-028; O-025 now 90 of 117; O-033 P1.8 part done (P1.9, P1.11
remain).
Commit: feat: requestLoan with 1.25x collateral rounded up, ids from 1, USDC sent last (P1.8)

### C-043 · D-43 Deep fuzz green; P1.8 CI; P1.8 may merge · 2026-10-05
Type: chore
Files: none changed.
- G10 for `1e63f3d` (D-43): CI run 37280156591 green. G10 for `bc1d493` (P1.8, branch `p1.8`): CI
  run 37283697382 green.
- Deep fuzz pass, `docs/gate-logs/D-43/deep-ci/`: run 37281472022 on `1e63f3d`, dispatched by
  hand on `main`: `check` green, **15 of 15 shards green, 350 tests passed, 0 failed, 0 skipped**.
  The guard printed `ok` on every shard; **all 34 fuzz tests ran 5,000,000 times**, including all
  11 `Math.t.sol` properties (`fuzz-runs.txt`). D-43 is done; `p1.8` may merge (branch rule).
- The scheduled nightly 37280242427 had already started a full run on the same commit at 07:53,
  twelve minutes before the dispatch, and also passed. The dispatch duplicated it, about 470 billed
  minutes wasted. From now on the run list is checked before any manual dispatch.
- Shard times (job wall minutes) against the D-43 estimate and the run before D-43 (C-040):

  | Shard | Before | Estimate | Actual | % of 360 |
  |---|---|---|---|---|
  | `Pool.t.sol` | 268.5 | 164 | 153.3 | 43% |
  | `AdminCredit.t.sol` | 100.0 | 56 | 62.4 | 17% |
  | `RegisterAsset.t.sol` | 57.1 | 18 | 63.4 | 18% |
  | `SignTerms.t.sol` | 65.2 | 17 | 59.2 | 16% |
  | `Membership.t.sol` | 5.4 | 7 | 52.3 | 15% |
  | `Spend.t.sol` | 56.5 | 12 | 50.2 | 14% |
  | `Pause.t.sol` | 45.5 | 3 | 13.6 | 4% |
  | `Math.t.sol` | 10.7 | 11 | 6.5 | 2% |
  | the other 7 | under 6 each | | under 5 each | under 2% |

  About 470 billed minutes in all, against about 620 before and the 294 estimated.
- Why the estimate missed: it scaled each shard's time by its gas, but the state-diff cheatcodes
  (`vm.startStateDiffRecording`, `vm.stopAndReturnStateDiff`) cost wall time without costing gas.
  Revert-heavy shards therefore gained less than their gas fell, and `Membership.t.sol`, whose two
  fuzz success paths now record a diff (one of them twice), got slower. Future estimates use
  measured shard times, not gas. The goal that mattered holds: `Pool.t.sol` is at 43%, far from
  D-42's 80% split line, and no shard is above 45%.
Commit: docs: record D-43 Deep fuzz green; P1.8 CI green

### C-044 · P1.8 done · Deep fuzz green on P1.8; repository public · 2026-10-06
Type: chore
Files: none changed.
- `p1.8` merged to `main` by fast-forward; `2573a15` (the `.gitignore` line moved out of the
  repository) on top.
- CI runs 37301601202 (`p1.8`) and 37301622247 (`main`) on `ad2d81d` failed in seconds with no
  step run: the account's Actions minutes were used up. Not a code failure. The owner made the
  repository public, which has no minutes limit. G10 for `2573a15` (same code plus `.gitignore`): CI run
  37302230961 green, `docs/gate-logs/P1.8/G10-main.log`.
- Deep fuzz pass, `docs/gate-logs/P1.8/deep-ci/`: run 37303144897 on `2573a15`, dispatched on
  `main` after checking the run list (no run existed for this code): `check` green, **16 of 16
  shards green, 385 tests passed, 0 failed, 0 skipped**. The guard printed `ok` on every shard;
  **all 36 fuzz tests ran 5,000,000 times**, the two `RequestLoan.t.sol` properties included
  (`fuzz-runs.txt`). P1.8 is done (INSTRUCTION 1.2).
- Shard times (job wall minutes) against the previous run (C-043):

  | Shard | C-043 | Actual | % of 360 |
  |---|---|---|---|
  | `Pool.t.sol` | 153.3 | 84.1 | 23% |
  | `AdminCredit.t.sol` | 62.4 | 33.3 | 9% |
  | `Spend.t.sol` | 50.2 | 30.3 | 8% |
  | `SignTerms.t.sol` | 59.2 | 30.1 | 8% |
  | `Membership.t.sol` | 52.3 | 29.4 | 8% |
  | `RequestLoan.t.sol` | new | 21.9 | 6% |
  | `RegisterAsset.t.sol` | 63.4 | 17.8 | 5% |
  | `Math.t.sol` | 6.5 | 5.8 | 2% |
  | the other 8 | under 5 each | under 6 each | under 2% |

  The whole run took 84 minutes. Every shard ran about 1.8 times faster than on the private
  repository: GitHub's standard runner for a public repository has 4 cores instead of 2. The same
  tests, seeds and run counts; only the hardware changed. Estimates from here use these times.
Commit: docs: record P1.8 Deep fuzz green and the switch to a public repository

### C-045 · P1.9 · repay · 2026-10-06
Type: feature
Decisions: D-48 (proposed, for approval at this gate); D-09, D-38, D-43, D-47 applied
Session start (INSTRUCTION 1.2): Deep fuzz run 37303144897 on P1.8's code green (C-044), so P1.9
was built straight on `main`, with no branch.
Files:
- Changed: `contracts/src/IndicoLedger.sol`: `repay(loanId)`, `nonReentrant`, `whenNotPaused`;
  reverts in order (D-48) `LoanNotFound` (no borrower stored), `LoanNotActive`, `NotBorrower`; no
  approval or terms check, so a revoked borrower repays; after the due date allowed until
  liquidated (D-09). Effects: status Repaid (principal, collateral, due date kept as a record),
  `lockedCredit -= collateral`, `totalLent -= principal`, `poolUsdc += principal`; emits
  `LoanRepaid` and `CollateralReleased`; then `safeTransferFrom(msg.sender, ...)` and the
  balance-delta check, `RepaymentShort(principal, received)` below the principal. No lint or
  Slither suppression: `reentrancy-events` did not fire, and pulling from `msg.sender` instead of
  the stored borrower cleared Slither's `arbitrary-send-erc20` (high), found during the gate.
- Changed: `contracts/src/interfaces/IIndicoLedger.sol`: error
  `RepaymentShort(uint256 principal, uint256 received)`; the `repay` comment (order, revoked
  borrower, approval, events, USDC last).
- New: `contracts/test/unit/Repay.t.sol`: partition table, 27 tests: exact repayment with both
  events, only those two, exact net writes (state diff); repay then borrow the same principal
  again; at the due date, one second after, 1000 days after; three loans, repay the middle, the
  other two byte-identical and available credit up by exactly its collateral; id 0, one past the
  end, `uint256` max (`LoanNotFound`); repaid twice (`LoanNotActive`); six non-borrowers
  (`NotBorrower`); revoked borrower repays; paused; allowance short, balance short, token returns
  false, blacklisted (full rollback); fee on transfer (`RepaymentShort(800e6, 792e6)`); re-entry;
  three check-order tests; fuzz: any principal gives exactly the repayment's writes and restores
  `lockedCredit`, `totalLent` and `poolUsdc`, then borrows again; any other caller
  `NotBorrower`; any unissued id `LoanNotFound`. A defaulted loan needs `liquidate`: in the
  P1.11 loan matrix.
- Changed: `contracts/test/unit/Pool.t.sol`: two tests on real loans (O-033, P1.9 part): a
  repayment raises `poolUsdc` by exactly the principal and leaves the price alone;
  `withdrawAll` short of cash, the loan repaid, a second `withdrawAll` pays the rest exactly.
- Changed: `contracts/test/unit/ParticipantMatrix.t.sol`: `repay` column (O-025), 11 of 13, 99 of
  117 cells: ApprovedAndSigned repays its own loan; ApprovedThenRevoked borrowed before the
  revocation and repays (nothing trapped, TS 2.2); everyone else `NotBorrower` on alice's loan.
- Changed: `contracts/test/unit/Pause.t.sol`: pause matrix 14 x 3 with `repay`.
- Changed: `contracts/test/unit/Constructor.t.sol`: the no-USDC sweep gains `repay` (25 calls).
- Changed: `INSTRUCTION.md` P1.11: before code, the owner decides O-038.
- Changed: `contracts/.gas-snapshot`: 26 new lines (Repay 24, Pool 2); 268 changed; none
  removed. Over 10%: participant matrix 112,520,116 to 127,907,910 (+13.7%, 99 cells instead of
  90) and pause matrix 51,083,135 to 57,610,611 (+12.8%, 42 cells instead of 39); all others at
  most +4.7%.
- Changed (local, not pushed): `docs/decisions.md` D-48.
Size: `IndicoLedger` runtime 9,632 B to 10,304 B (+672 B), margin 14,272 B.
Slither, CI step 7 body (on a scratch copy, since Slither runs `forge clean`): exit 0, no IR
error, 4 findings, the same as P1.8 (`slither.log`).
Gate (logs in `docs/gate-logs/P1.9/`, Forge 1.8.3; red phase `red.log`: 27 of 27 failing on the
missing function). The first gate run was stopped after the Slither fix and rerun in full:
- G1 pass: 414 passed, 0 failed, 0 skipped, exit 0.
- G2 pass: src lines 183/183, branches 58/58.
- G3 pass, G4 pass: exit 0 each.
- G5 pass: seeds 1 and 2, 414 passed each.
- G6 pass: three runs, 414 passed each.
- G7 pass: `ci` profile, 414 passed.
- G8 pass: `IndicoLedger` 10,304 B; snapshot check 375 passed.
- G9 pass, `G9.log`: 16 of 16 caught (on a scratch copy of `contracts/` with the same source and
  tests, then confirmed byte-identical to the real source by SHA-256).
- G13 pass (grep finds nothing).
- G10 pending: owner pushes.
Mutations (G9): M1 `LoanNotFound` removed; M2 status check removed (repaid twice panics on
underflow instead of the named error); M3 borrower check removed; M4 status not set; M5 collateral
not released; M6 `totalLent` not lowered; M7 `poolUsdc` not raised; M8 short-delivery check
removed; M9 `<` to `<=`; M10 a wei less pulled; M11 `nonReentrant` removed; M12 works while
paused; M13 `CollateralReleased` loan id 0; M14 `LoanRepaid` principal 0; M15 borrower checked
before status; M16 a revoked borrower refused. All caught.
Open items: O-025 now 99 of 117; O-033 P1.9 part done (P1.11 remains); raised O-038.
Commit: feat: repay the exact principal, revoked borrowers included, short delivery reverts (P1.9)

---

## Open items

| Id | Item | Owner | Closed by |
|---|---|---|---|
| O-001 | CI has known problems: Slither installed with plain `pip` (refused on the runner) and scanning tests and libraries; invariant step with no invariant tests; gas snapshot check may use different flags than the committed snapshot | engineer | Closed by C-007 |
| O-002 | Loan matrix: `input-testing.md` says 144 cells, `Helpers.t.sol` checks 108; the agreed figure is 180 (five time points) | engineer | Closed by C-010 |
| O-003 | Re-create the lost tag: `git tag interface-v0.2.0` on current `main`, then push it, and tell the backend that v0.1.0 no longer exists | owner | |
| O-004 | GitHub CLI not installed; gate line G10 needs it | owner | Closed by C-007 |
| O-005 | Foundry was not on PATH on 2026-09-29 | owner | Closed by C-009 |
| O-006 | Backend stack: NestJS container, or Next.js + Supabase + a committed worker. The backend owner decides before Level 4 | backend | |
| O-007 | Client: what defaulted collateral held by the pool is for. Until answered it is inert and a default is a straight USDC loss to depositors | owner, client | |
| O-008 | Client: what merchants do with credit they receive. No redemption path is built until answered | owner, client | |
| O-009 | Client: arbitration wording. Clause 5 makes a merchant bound after 72 hours of silence; the confirmed admin flow has only not sent / sent / signed and cannot record that | owner, client | |
| O-010 | Client: written acknowledgement that no external audit was bought, before any real money | owner, client | before P3.3 |
| O-011 | Decisions due inside portions: duplicate approvals, zero terms hash, one address as user and merchant (P1.2); maximum declared asset value so `totalCredit` cannot overflow, zero document hash (P1.4); issuing credit to an unapproved address (P1.5); first-deposit inflation mitigation (P1.7) | engineer proposes, owner approves | P1.2, P1.4, P1.5, P1.7 |
| O-012 | CI warnings: `actions/checkout@v4` runs on deprecated Node.js 20 (move to v5 in both workflows); `ubuntu-latest` becomes Ubuntu 26 from 2026-10-19, so recheck CI after that date | engineer | |
| O-013 | Reconsider where the loan time axis lives: `_loanTimeAt` and `_loanDims` sit in `Matrix.sol` because `Actors.sol` could not build in Phase 0. Once it builds, decide whether to move them next to `LoanState` and replace the literal `4` with `LOAN_STATES` | engineer | P1.11 |
| O-014 | `IndicoLedger` must inherit `IIndicoLedger`, so the compiler proves the implementation matches the interface the backend builds against | engineer | P1.13 at the latest |
| O-015 | Delete the `uninitialized-state` suppression on `termsHash` (D-18) as part of the gate | engineer | Closed by C-017 |
| O-016 | Delete the `uninitialized-state` suppression on `totalCredit` (D-18) as part of the gate | engineer | Closed by C-024 |
| O-017 | Delete the `uninitialized-state` suppression on `totalShares` (D-18) as part of the gate | engineer | Closed by C-034 |
| O-018 | Delete both suppressions on `totalLent` as part of the gate: the D-18 lint line and the D-40 Slither `uninitialized-state` start/end pair (read by the pool from P1.7) | engineer | Closed by C-042 |
| O-019 | Delete the `uninitialized-state` suppression on `nextLoanId` (D-18) as part of the gate | engineer | Closed by C-042 |
| O-020 | Delete the `uninitialized-state` suppression on `poolCredit` (D-18) as part of the gate | engineer | P1.11 |
| O-021 | Test for the `Fixture._default` clock fix (C-012): after `_default`, `block.timestamp` is back to its value before the call | engineer | P1.11 |
| O-022 | Participant matrix (IT 2.2): the `pause` column, nine participants, moved from P1.1 because building them needs approvals and `signTerms` | engineer | Closed by C-019 |
| O-023 | The Phase-0 skip step in `ci.yml` and `deep.yml` no longer runs now that `src/IndicoLedger.sol` exists; delete it | engineer | P1.13 |
| O-024 | Backend admin screen (AD-04, AD-02): before approving a wallet as user or merchant, warn that its role becomes permanent (D-22); a mistaken approval can only be fixed by the person using a different wallet | backend | Level 4 |
| O-025 | Participant matrix (IT 2.2): 11 of 13 action columns (`signTerms`, `setUserApproved`, `pause`, `registerAsset`, `adminIssueCredit`, `adminDebitCredit`, `spend`, `deposit`, `withdraw`, `requestLoan`, `repay`), 99 of 117 cells. Each later portion adds its own column at its gate; all 13 columns, 117 cells, by P1.13 | engineer | P1.13 |
| O-026 | On any Forge upgrade (D-14), re-run the D-30 probe (`docs/lint-probes/missing-events-access-control`, `forge build --deny warnings`); if the mapping rows are no longer flagged, delete every `missing-events-access-control` suppression in the same commit as the upgrade. Same for D-40's `reentrancy-events` probe (`docs/lint-probes/reentrancy-events/`): if `Withdrawn` or `Deposited` no longer fires, delete that line. On a Slither upgrade, the D-40 `incorrect-equality` probe likewise | engineer | next Forge upgrade |
| O-027 | `_mint` computes `room = CREDIT_CAP - credit[account]`, which underflows (panic) if the account already holds more than the cap. Only a merchant can (via `spend`, D-27), and P1.4 mints only to users, so it is unreachable now. P1.5 decides whether `adminIssueCredit` may credit a merchant (O-011); if it can, P1.5 writes the failing test first (mint to a merchant above the cap must revert `CreditCapExceeded(amount, 0)`, never panic) and fixes `_mint` | engineer | Closed by D-33 (C-026) |
| O-028 | Delete the `slither-disable-next-line uninitialized-state` above `lockedCredit` (D-34) as part of the gate; it covers every read site (`adminDebitCredit`, and `spend` in P1.6) | engineer | Closed by C-042 |
| O-029 | `src/lib/Math.sol` carries `slither-disable-next-line unused-return` (C-006 triage). The P1.13 grep now covers Slither, so it fails close-out unless it gets its own decision allowing it to survive, or is removed | engineer, owner | before P1.13 |
| O-030 | Slither has logged `ERROR:ContractSolcParsing: Impossible to generate IR for Math.mulDivDown (src/lib/Math.sol#27-34): 'NoneType' object has no attribute 'parameters'` since P1.3, locally and on CI (run 37108382319); P1.1 and P1.2 runs did not. Detectors still run on everything else and the exit code ignores it, so CI stays green, but `mulDivDown` is not being analysed. Find the trigger and fix or triage in writing | engineer | Closed by C-030 |
| O-031 | Backend (AD-04, AD-08, U-13): the admin merchant screen shows each merchant's on-chain terms signature (`termsSigned`, `signedTermsHash`); a user paying a merchant who has not signed gets a readable "merchant not ready" instead of `MerchantTermsNotSigned` (D-36, D-37) | backend | Level 4 |
| O-032 | Merchant guide (merchants use the block explorer): step 0, in bold at the top, says never to send USDC to the ledger address with `transfer`; only `approve` on the USDC contract, then `deposit`. A direct transfer is counted nowhere and cannot be recovered (D-38) | owner | before the first merchant deposits |
| O-033 | `Pool.t.sol` simulates a loan's pool side by writing `poolUsdc`/`totalLent` (`_simulateLend`, `_simulateRepay`, `_simulateDefault`). Rerun those cases on real loans: beyond-liquidity withdraws (P1.8), short-of-cash `withdrawAll` then repay (P1.9, done in C-045), loss split, rounding pump and total wipeout (P1.11); then delete the helpers | engineer | P1.8, P1.9, P1.11 |
| O-034 | Pool-state matrix (IT 2.4, 24 cells) moved from P1.7: it needs `requestLoan`, `repay` and a real default | engineer | P1.11 |
| O-035 | Merchant guide and terms: while the pool is paused no merchant can deposit or withdraw, for as long as the pause lasts, and nothing can rescue the funds (D-41, CS §10); with the client's written pause policy (decisions, open non-blocking 2) | owner, client | before the first merchant deposits |
| O-036 | The 11 `Math.t.sol` properties pinned by `forge-config: default.fuzz.runs = 100000` also run 100,000 times under `deep` (run 37169050467), so `LedgerMath` has never had 5,000,000 runs. Fix: a `deep` inline line per test, or move the pin; reopens P0.1 | engineer, owner | Closed by C-040 |
| O-037 | Build D-43 (state-diff assertions instead of the full re-read snapshot) as its own change with the full gate: every G9 mutation from P1.1 to P1.7 still caught plus one new unexpected-slot mutation, gas per run before and after on the three heaviest fuzz tests, new Deep estimate per shard. After P1.7 merges, before P1.8 | engineer | Closed by C-041 |
| O-038 | `repay` is `whenNotPaused` (contract-spec 6), so a pause that lasts past a loan's due date stops the borrower repaying, and at the unpause anyone may liquidate it. Owner decides before P1.11: accept and say so in the terms and pause policy, exempt `repay` from the pause, or handle it in `liquidate` (D-48) | owner | P1.11 |
