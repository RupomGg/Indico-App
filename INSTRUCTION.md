# INSTRUCTION.md: How we build Indico, portion by portion

This file is the build plan and the rulebook. `docs/PRD.md` and `docs/contract-spec.md` say
**what** to build; this file says **in what order** and **when a portion counts as finished**.
`DECISION.md` records **every** file created or changed, and why.

Audience: the owner (product owner, signs off and pushes) and the engineer (builds). Start every
build session with:

> Read `INSTRUCTION.md`, `DECISION.md` and the spec sections listed for portion **P?.?**. Build
> only that portion, following the rules in INSTRUCTION.md. Stop at the gate.

---

## 1. The rules

### 1.1 One portion at a time
- A portion is small: typically one to three functions plus their tests. Each is listed in §4 with
  its files, spec references and required corner cases.
- **Never start the next portion until the current one passes its gate (§2) and the owner has
  signed off.**
- Never "quickly" add something from a later portion. If a later need shows up, note it in
  DECISION.md under *Open items*.
- A corner case that cannot be tested yet (because the function it needs belongs to a later
  portion) is written into that later portion's list, with a note in DECISION.md. It is moved,
  never dropped.

### 1.2 Tests first, then code
**Every session starts by checking the latest Deep fuzz run** (`gh run list --workflow deep.yml
--limit 1`). A red one reopens the portion whose commit it ran on, and that is fixed before any
new work. A portion is not truly done until a Deep fuzz run on its code is green (C-021: P1.2 was
signed off before its nightly deep run finished, and that run failed).

**Fuzz tests never discard input.** No `vm.assume` and no `assumeNot*` helper in `test/`: an
excluded value is remapped to a valid one (for example `if (d == 6) d = 7;`, or
`_remapForgeAddress`), or the range is set with `bound`. Discarding fails at deep fuzz volumes,
because the fuzzer favours exactly the values a test tends to exclude. Gate line G13 checks it. Any
exception needs its own decision entry.

For every portion:
1. Read the spec sections listed for the portion.
2. Write the **input partition table** (`docs/input-testing.md` §1) as a comment at the top of the
   test file, then write the **corner-case list** from §4 as test names, **before** any
   implementation code. Add any extra corner cases found while reading.
3. Run `forge test` and confirm the new tests fail for the right reason (missing function), not a
   compile error elsewhere.
4. Implement until all tests pass.
5. Run the **whole** suite, not just the new tests, so a new portion cannot silently break an old
   one.
6. Run the gate (§2).
7. Log everything in DECISION.md (§3).
8. Show the gate output to the owner and give a one-line commit message. Wait for sign-off.

### 1.3 Handling bugs
- A bug found at any time gets: (1) a failing test that reproduces it, (2) the fix, (3) the test
  passing, (4) a DECISION.md entry of type `fix` naming the root cause.
- **Fix the root cause in the shared function**, not a patch at one call site. Check every caller.
- A bug in an already-signed-off portion re-opens that portion: its gate must pass again.
- **Never** delete, skip, weaken or edit a test to make the suite pass. If a test is wrong, say
  so, fix it, and log the reason.
- An invariant that fails is never loosened. The contract is fixed instead.

### 1.4 What "sure there is no underlying bug" means
Coverage alone does not prove correctness. A 100%-covered function can still be wrong. So a
portion is only done when **all** of these hold:
- Every corner case in its §4 list has a test, and each test asserts a *specific* outcome: exact
  custom error with exact arguments, exact balances, exact events. "Does not revert" is not an
  assertion.
- Every revert test also asserts that **nothing changed** (`StateSnapshot._assertUnchanged`).
- Failure paths are tested as seriously as happy paths: bad input, zero and max values, wrong
  caller, wrong state, paused, time boundaries, misbehaving token.
- The deliberate-bug check (§2, G9) shows the tests catch real mistakes.
- The code has been re-read once, top to bottom, asking "what input breaks this?". Anything found
  becomes a test.
- The owner has seen the gate output.

### 1.5 What may appear in pushed files
Everything not listed in `.gitignore` is pushed to GitHub, including this file and
DECISION.md. Pushed files, code comments and commit messages never mention the tools used to
write them. The engineer never runs `git commit`, `git tag` or `git push`; the owner does.

---

## 2. The gate ("100/100")

A portion passes only when **every** line below is true. The engineer pastes the real command
output. A summary like "all good" does not count.

All commands run from `contracts/`. Every command writes its full output and exit code to
`docs/gate-logs/P?.?/G?.log` first (that folder is local only), for example:

```bash
mkdir -p ../docs/gate-logs/P1.1
forge test > ../docs/gate-logs/P1.1/G1.log 2>&1; echo "exit $?" >> ../docs/gate-logs/P1.1/G1.log
```

The summary shown to the owner is taken from those files. Never pipe a gate run straight into
`tail`. A blank or missing summary line is a failure until proven otherwise.

| # | Check | Command | Pass condition |
|---|---|---|---|
| G1 | All tests pass | `forge test` | 0 failed, 0 skipped, exit 0 |
| G2 | Full coverage on `src` | `forge coverage --report lcov --no-match-coverage "(test\|script)/"`, then sum `LF/LH` and `BRF/BRH` for `src/` files | 100% lines **and** 100% branches |
| G3 | Format | `forge fmt --check` | No diff |
| G4 | No compiler warnings | `forge build` with warnings denied (`deny_warnings = true` or `--deny-warnings`, whichever the pinned Forge version supports) | Builds clean |
| G5 | Not a lucky seed | `forge test --fuzz-seed 1` and `forge test --fuzz-seed 2` | Both pass |
| G6 | Stable | G1 run three times in a row | Same result every time |
| G7 | Heavy fuzz | `FOUNDRY_PROFILE=ci forge test` (100,000 runs) | Passes |
| G8 | Size and gas | `forge build --sizes`; `forge snapshot --check --tolerance 10` | Under 24,576 bytes; any gas change over 10% is explained in DECISION.md and the snapshot regenerated |
| G9 | Deliberate-bug check | At least 3 hand-made mutations of the portion's code (flip `<=`/`<`, delete a check, swap rounding direction, drop an event) | Every mutation makes at least one test fail |
| G10 | CI green | After the owner pushes: `gh run list --branch main --limit 1`, then `gh run watch <id> --exit-status`; on failure `gh run view <id> --log-failed` into the G10 log | The run for the pushed commit is green |
| G11 | Manual check | The portion's "Manual check" line in §4 | Owner sees it |
| G12 | Logged | DECISION.md entry for this portion | Lists every new or changed file, why, and the gate result |
| G13 | No discarded fuzz input | `grep -rn "vm.assume\|assumeNot" test/` | Returns nothing (§1.2); an exception needs its own decision entry |

**Deliberate-bug checks must be crash-safe.** Before breaking a file on purpose, copy it to a
backup **outside the project**; restore from that backup in a `finally`; finish by confirming the
file is byte-identical to the backup (SHA-256). At the start of any session after an interrupted
check, verify the file against the backup before anything else.

**CI is part of the gate.** A portion is signed off only when GitHub Actions is green for the
pushed commit. A red run is fixed before the next portion starts, never "later".

**Escape sequences in files.** File-writing tools and pasted scripts can turn a written `\n`,
`\t` or `\uXXXX` into the real character. Never put a backslash escape inside text that a script
writes into another file; edit the file directly instead. After writing any line containing a
backslash, show that exact line (`grep -n`) and confirm the escape survived.

**After a crash or power loss:** before anything else, (1) scan project files for blank or
zero-filled files, (2) verify files against the last mutation backups, (3) run `forge clean`,
(4) rerun the full gate.

**A single unexplained failure blocks the gate.** Rerunning until it is green is not a fix. Find
the root cause, fix it, add a test, log it.

`// coverage:ignore` style exclusions are not allowed in `src/`. If a branch is unreachable,
delete the branch, not the gate.

---

## 3. How to log in DECISION.md

Every portion adds one entry (format in DECISION.md). Every file touched is listed:
- **New file:** path + one line on its job.
- **Changed file:** path + what changed + why + which other files depend on it.
- **Deleted file:** path + why + what replaces it.

Choices between options get a `D-##` id in `docs/decisions.md` and are referenced from the entry.
Things noticed but not done get an `O-###` open item.

---

## 4. The portions

Levels group portions. Finish a level before starting the next one. Every portion lists:
**Goal · Files · Spec refs · Corner cases (each must be a test) · Manual check.**

Spec refs use: **CS** = `docs/contract-spec.md`, **PRD** = `docs/PRD.md` requirement IDs,
**D** = `docs/decisions.md`, **IT** = `docs/input-testing.md`, **TS** = `docs/testing-strategy.md`.

### Level 0: Foundation

**P0.1 Toolchain, interface, maths, helpers** · **Signed off 2026-09-29** (C-001, C-002)
- Foundry project, three fuzz profiles, `IIndicoLedger.sol`, `Math.sol`, `Constants.sol`,
  `MockUSDC`, `Fixture`, `StateSnapshot`, `Actors`, `Matrix`, `Helpers.t.sol`. 48 of 48 tests,
  `Math.sol` at 100% lines and branches.

**P0.2 CI repair** · **Open, do first**
- Goal: every push runs the gate automatically, and the run is actually green.
- Files: `.github/workflows/ci.yml`, `.github/workflows/deep.yml`.
- Spec refs: TS §4.
- Corner cases:
  - Slither installs on the `ubuntu-latest` runner (plain `pip install` is refused there; use
    `actions/setup-python` or `pipx`) and scans `src/` only, not `test/` or `lib/`;
  - the invariant step is skipped cleanly while `test/invariant/` does not exist, and runs once it
    does;
  - the gas snapshot check uses exactly the same flags that generated `.gas-snapshot`;
  - the Phase-0 skip step disappears on its own once `src/IndicoLedger.sol` exists;
  - `deep.yml` runs only on its schedule and by hand, never on push;
  - submodules check out (`forge-std`, `openzeppelin-contracts` at the pinned tags);
  - a deliberately failing test turns the run red; reverting it turns it green.
- Manual check: owner pushes a branch with a failing test and sees red, then green after revert.

**P0.3 Loan matrix to 180 cells** · **Open**
- Goal: the finite loan state matrix covers the whole extension window.
- Files: `docs/input-testing.md` §2.1 (currently says 144), `contracts/test/helpers/Helpers.t.sol`
  (currently checks `_dims(4, 3, 3, 3)` = 108).
- Spec refs: IT §2.1, D-13.
- Corner cases: time axis is exactly five points (`dueDate - EXTENSION_WINDOW - 1`,
  `dueDate - EXTENSION_WINDOW`, `dueDate - EXTENSION_WINDOW / 2`, `dueDate`, `dueDate + 1`);
  self-check visits 4 × 3 × 3 × 5 = 180 cells, each exactly once.
- Manual check: none beyond the gate.

### Level 1: The contract (`contracts/src/IndicoLedger.sol`)

Every portion follows the per-function loop in `prompts/01-contracts-tdd.md` and extends the
pause matrix (IT §2.3) and the participant matrix (IT §2.2) with its own functions.

**P1.1 Constructor, roles, pause**
- Files: `src/IndicoLedger.sol` (new), `test/unit/Constructor.t.sol`, `test/unit/Pause.t.sol`.
- Spec refs: CS §3, §6.0, §6.1 (`pause`, `unpause`); PRD §5 Security.
- Corner cases: each of the three constructor arguments zero → `ZeroAddress`; roles granted to
  exactly the right addresses and nobody else; guardian can pause and unpause; admin and a random
  address cannot; pause while paused and unpause while unpaused revert with the named errors; no
  role can move USDC (asserted by trying every role against every function that exists).
- Manual check: `Smoke.t.sol` passes and the CI Phase-0 skip step stops running.

**P1.2 Membership and terms hash**
- Functions: `setTermsHash`, `setUserApproved`, `setMerchantApproved`.
- Spec refs: CS §6.1; PRD U-02, AD-02, AD-04; D-10.
- Corner cases: non-admin → revert for all three; zero address → `ZeroAddress`; approving the
  contract itself or the USDC address; setting the same value twice (decide: allowed and emits, or
  no-op; log the decision); zero terms hash (decide and log); one address as both user and
  merchant (decide and log, because it enables spending to yourself); events with exact arguments;
  revocation touches no balance (re-checked in P1.8 and P1.9 once balances exist).
- Manual check: none beyond the gate.

**P1.3 `signTerms`**
- Spec refs: CS §6.2; PRD U-06 to U-08, S-02; D-10.
- Corner cases: current hash → signed, event carries the hash passed in; wrong hash →
  `WrongTermsHash`; stale hash after the admin changed it → `WrongTermsHash`; second signature →
  `AlreadySigned`; before any hash is set → `TermsNotSet`; unapproved address can sign (deliberate,
  documented in CS §6.2); changing the hash does not clear existing signatures; paused.
- Manual check: none beyond the gate.

**P1.4 `registerAsset`**
- Spec refs: CS §6.3; PRD A-06 to A-08, U-08, C-01; D-12.
- Corner cases: value 0 → `ZeroAmount`; value 1 wei; **value large enough to overflow
  `totalCredit` must be a named revert, never a panic** (decide the maximum declared value, log it
  as a new D-##); zero `docHash` (decide and log); same hash by the same user and by another user
  → `AssetAlreadyRegistered`; `assetType` over all 256 `uint8` values (IT §2.5); unapproved;
  approved but unsigned; paused; both `AssetRegistered` and `CreditMinted` emitted exactly.
- Manual check: none beyond the gate.

**P1.5 `adminIssueCredit`, `adminDebitCredit`**
- Spec refs: CS §6.3; PRD AD-10 to AD-12.
- Corner cases: non-admin; amount 0; issue to an unapproved address or a merchant (decide and
  log); debit more than available → `InsufficientAvailableCredit(requested, available)`; debit
  exactly available; zero memo allowed; `totalCredit` stays equal to the sum of balances.
  **Moved to P1.8:** debit can never reach locked collateral.
- Manual check: none beyond the gate.

**P1.6 `spend`**
- Spec refs: CS §6.4; PRD C-03 to C-08, S-05, S-06.
- Corner cases: amount 0; exactly available; one wei more; unapproved merchant; revoked merchant;
  spending to yourself (per the P1.2 decision); merchant receives exactly the amount, no fee;
  `Spent` and `MerchantReceipt` exact; paused. **Moved to P1.8:** locked credit cannot be spent.
- Manual check: none beyond the gate.

**P1.7 Pool: `deposit`, `withdraw`** · **stops for owner decision before code**
- Spec refs: CS §5, §6.5; PRD §3.4; D-06.
- Before code: the engineer proposes the first-deposit inflation-attack mitigation (virtual offset
  or seeded burned deposit), the owner approves, it is logged as a new D-##.
- Corner cases: the inflation attack written as a test (1 wei deposit, large direct donation,
  victim deposits and loses nothing); share price unchanged by deposit and by withdraw; two equal
  depositors split a later loss within one wei; withdraw more shares than held →
  `InsufficientShares(requested, held)`; withdraw beyond liquidity → `InsufficientLiquidity`;
  zero shares; revoked merchant can still withdraw but cannot deposit; fee-on-transfer token
  credits the amount actually received; blacklisted merchant → full rollback; pool-state matrix
  (IT §2.4, 24 cells).
- Manual check: none beyond the gate. The owner reads this portion's report line by line.

**P1.8 `requestLoan`**
- Spec refs: CS §5, §6.6; PRD L-01 to L-10; D-05.
- Corner cases: exactly `collateralFor(p)` available → succeeds, one wei less → reverts;
  `requestLoan(maxBorrow(u))` succeeds; principal above `uint128` max → named revert; principal
  above pool liquidity; three concurrent loans lock exactly the sum; revoked user cannot borrow;
  blacklisted borrower → full rollback; `LoanOpened` and `CollateralLocked` exact.
  **Carried in:** `spend` and `adminDebitCredit` can never reach locked collateral; revocation
  leaves balances and loans untouched.
- Manual check: none beyond the gate.

**P1.9 `repay`**
- Spec refs: CS §6.6; PRD R-01 to R-03, R-08; D-09.
- Corner cases: not the borrower → `NotBorrower`; unknown loan → `LoanNotFound`; repaid twice →
  `LoanNotActive`; repay after `dueDate` while not liquidated succeeds; revoked user can repay;
  allowance short → full rollback; fee-on-transfer token delivering less than principal must
  revert; repaying the middle of three loans leaves the others untouched; borrow then repay
  returns pool USDC to exactly its starting value; `LoanRepaid` and `CollateralReleased` exact.
- Manual check: none beyond the gate.

**P1.10 `extend`**
- Spec refs: CS §6.6; PRD R-04 to R-06; D-13.
- Corner cases: one second before the window → `ExtensionWindowNotOpen(opensAt)`; exactly at
  opening; inside; exactly at `dueDate`; one second after → `ExtensionWindowClosed`; new due date
  is old due date + 90 days, never now + 90 days; `extensionCount` increments; twice in one block
  → second reverts; a loop of 100 in one block reverts on the second; not the borrower; repaid or
  defaulted loan.
- Manual check: none beyond the gate.

**P1.11 `liquidate`** and the full loan matrix
- Spec refs: CS §6.6; PRD R-07, AD-21; D-07, D-12.
- Corner cases: before due → `NotYetDue(dueDate)`; exactly at due → reverts; one second after →
  succeeds from any address; twice; after repay; credit burns from the user, `poolCredit` rises,
  `totalLent` falls, no USDC moves; every depositor's share price drops together; revoked user's
  loan can still be liquidated. Then the full 180-cell loan matrix (IT §2.1).
- Manual check: none beyond the gate.

**P1.12 Views**
- Functions: `available`, `maxBorrow`, `collateralFor`, `poolAvailable`, `poolTotalAssets`,
  `maxWithdraw`.
- Spec refs: CS §5; IT §3.2.
- Corner cases: `maxBorrow`/`collateralFor` boundary both directions; empty pool; fully lent pool;
  after a default; `maxWithdraw` capped by liquidity.
- Manual check: none beyond the gate.

**P1.13 Close-out and interface freeze**
- Spec refs: IT §5; TS §2.2; `docs/ownership.md` §3.
- Corner cases: every negative-space test (unknown selector, calldata one byte short, 100 bytes
  appended, raw ETH sent, stray ERC-20 sent); reentrancy cross product (4 USDC functions × 11
  re-entry targets) as one loop; Slither on `src/` clean or triaged in writing;
  `grep -rn "forge-lint: disable" src/` returns nothing (any suppression still there fails the
  gate unless it has its own written decision; see D-18).
- Handover produced: ABI JSON, TypeScript client package (viem), custom-error decoder map, gas
  table per function.
- Manual check: owner tags `interface-v1.0.0` and sends the handover to the backend. From here the
  interface is frozen; a change needs a decision entry and a version bump.

### Level 2: Proof

**P2.1 Handler and permissive invariants** · TS §2.3, CS §9 (I1 to I13), `prompts/02-invariants.md` §1 to §2.
Corner cases: every handler action reachable (revert counts reported per action); warp crosses
the 90-day boundary; each invariant is its own `invariant_` function; every user's `credit` is at
most `CREDIT_CAP` (D-33, the no-underflow guarantee for `_mint`).

**P2.2 Strict invariants** · same refs. `fail_on_revert = true`, handler only makes calls it has
computed to be valid.

**P2.3 Differential model** · IT §4, `prompts/02-invariants.md` §3. Naive model, agreement on
state **and** on the revert decision after every call, 1,000,000 sequences. Never change the model
to match the contract.

**P2.4 Fork tests and journeys** · TS §2.4, §2.5. Real Base USDC: full journey, blacklisted
borrower and merchant; the five integration journeys. Skipped cleanly without an RPC URL.

**P2.5 Deep run and analysis** · `forge test --profile deep` once overnight; Slither plus one
other analyser, every finding fixed or triaged in writing.

### Level 3: Deployment

**P3.1 Deploy script and Base Sepolia** · `script/Deploy.s.sol`; Circle's official Sepolia USDC
address with its source shown; Safe addresses for admin and guardian; keystore account only, no
private key in any file; source verified; `docs/deployments.md` written. **The owner runs the
broadcast.** The Safe signers are told, in writing: moving the top admin role takes two steps
and 3 days (D-19), and a `DefaultAdminTransferScheduled` event they did not start means act
immediately.

**P3.2 Liquidation keeper script** · `docs/ownership.md` §2. Finds overdue loans, calls
`liquidate`; idempotent; safe to run twice at once; tested on Sepolia.

**P3.3 Mainnet** · only after every box in TS §5 is ticked, including the client's written
acknowledgement that no audit was bought.

### Level 4 and later: Backend

Written once the backend stack is chosen (NestJS container, or Next.js + Supabase + worker).
Until then `prompts/03-backend-core.md`, `04-indexer.md` and `05-ai-assistant.md` describe the
work. The same rules and gate apply, with the backend's own commands in G1 to G8.

---

## 5. Prerequisites by level

| Needed | From | Status |
|---|---|---|
| Foundry, pinned version, on PATH | P0.1 | Installed; was not on PATH on 2026-09-29, check |
| GitHub CLI (`gh`), signed in | P0.2 (G10) | Not installed: `winget install GitHub.cli`, then `gh auth login` |
| `forge-std` v1.16.2, OpenZeppelin v5.7.0 | P0.1 | Pinned, verified as published releases |
| Base mainnet RPC URL (fork tests) | P2.4 | Not set |
| Base Sepolia RPC URL | P3.1 | Not set |
| Safe multisig on Base Sepolia (admin, guardian) | P3.1 | Not created |
| Test ETH and test USDC on Base Sepolia | P3.1 | Not requested |
| Block explorer API key (verification) | P3.1 | Not set |

---

## 6. Commands

```bash
cd contracts
forge build
forge test
FOUNDRY_PROFILE=ci forge test
forge coverage --report summary --no-match-coverage "(test|script)/"
forge fmt --check
forge snapshot --check --tolerance 10
gh run list --branch main --limit 1
gh run watch <run-id> --exit-status
```
