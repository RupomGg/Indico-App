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

---

## Open items

| Id | Item | Owner | Closed by |
|---|---|---|---|
| O-001 | CI has known problems: Slither installed with plain `pip` (refused on the runner) and scanning tests and libraries; invariant step with no invariant tests; gas snapshot check may use different flags than the committed snapshot | engineer | Closed by C-007 |
| O-002 | Loan matrix: `input-testing.md` says 144 cells, `Helpers.t.sol` checks 108; the agreed figure is 180 (five time points) | engineer | P0.3 |
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
| O-015 | Delete the `uninitialized-state` suppression on `termsHash` (D-18) as part of the gate | engineer | P1.2 |
| O-016 | Delete the `uninitialized-state` suppression on `totalCredit` (D-18) as part of the gate | engineer | P1.4 |
| O-017 | Delete the `uninitialized-state` suppression on `totalShares` (D-18) as part of the gate | engineer | P1.7 |
| O-018 | Delete the `uninitialized-state` suppression on `totalLent` (D-18) as part of the gate | engineer | P1.8 |
| O-019 | Delete the `uninitialized-state` suppression on `nextLoanId` (D-18) as part of the gate | engineer | P1.8 |
| O-020 | Delete the `uninitialized-state` suppression on `poolCredit` (D-18) as part of the gate | engineer | P1.11 |
| O-021 | Test for the `Fixture._default` clock fix (C-012): after `_default`, `block.timestamp` is back to its value before the call | engineer | P1.11 |
| O-022 | Participant matrix (IT 2.2): the `pause` column, nine participants, moved from P1.1 because building them needs approvals and `signTerms` | engineer | P1.3 |
| O-023 | The Phase-0 skip step in `ci.yml` and `deep.yml` no longer runs now that `src/IndicoLedger.sol` exists; delete it | engineer | P1.13 |
