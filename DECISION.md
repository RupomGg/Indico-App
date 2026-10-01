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

---

## Open items

| Id | Item | Owner | Closed by |
|---|---|---|---|
| O-001 | CI has known problems: Slither installed with plain `pip` (refused on the runner) and scanning tests and libraries; invariant step with no invariant tests; gas snapshot check may use different flags than the committed snapshot | engineer | P0.2 |
| O-002 | Loan matrix: `input-testing.md` says 144 cells, `Helpers.t.sol` checks 108; the agreed figure is 180 (five time points) | engineer | P0.3 |
| O-003 | Re-create the lost tag: `git tag interface-v0.2.0` on current `main`, then push it, and tell the backend that v0.1.0 no longer exists | owner | |
| O-004 | GitHub CLI not installed; gate line G10 needs it | owner | before P0.2 sign-off |
| O-005 | Foundry was not on PATH on 2026-09-29 | owner | before P1.1 |
| O-006 | Backend stack: NestJS container, or Next.js + Supabase + a committed worker. The backend owner decides before Level 4 | backend | |
| O-007 | Client: what defaulted collateral held by the pool is for. Until answered it is inert and a default is a straight USDC loss to depositors | owner, client | |
| O-008 | Client: what merchants do with credit they receive. No redemption path is built until answered | owner, client | |
| O-009 | Client: arbitration wording. Clause 5 makes a merchant bound after 72 hours of silence; the confirmed admin flow has only not sent / sent / signed and cannot record that | owner, client | |
| O-010 | Client: written acknowledgement that no external audit was bought, before any real money | owner, client | before P3.3 |
| O-011 | Decisions due inside portions: duplicate approvals, zero terms hash, one address as user and merchant (P1.2); maximum declared asset value so `totalCredit` cannot overflow, zero document hash (P1.4); issuing credit to an unapproved address (P1.5); first-deposit inflation mitigation (P1.7) | engineer proposes, owner approves | P1.2, P1.4, P1.5, P1.7 |
| O-012 | CI warnings: `actions/checkout@v4` runs on deprecated Node.js 20 (move to v5 in both workflows); `ubuntu-latest` becomes Ubuntu 26 from 2026-10-19, so recheck CI after that date | engineer | |
