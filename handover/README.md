# IndicoLedger backend handover, interface 1.0.0

Everything the backend needs to build against the ledger. Tagged `interface-v1.0.0`. From this tag
the interface is frozen: any change to a function, event or error is a new decision entry and a
version bump, announced through this folder, never a quiet edit.

| File | What it is |
|---|---|
| `abi/IndicoLedger.json` | The full ABI: every function, event and error, the inherited OpenZeppelin ones included. |
| `client/indicoLedger.ts` | `indicoLedgerAbi` (`as const`, so viem infers every type) and `indicoLedgerErrors`. |
| `errors.json` | Every revert the backend can see: selector, name, arguments, a plain-English message. |
| `events.json` | Every event: topic0, indexed and data fields, and what it changes in the read model. |
| `gas.md` | Gas per function, typical and worst seen in the tests. |
| `build.py` | Generates the first four from the compiled contract. CI runs `--check`, so they cannot drift. |

Regenerate after `forge build` in `contracts/`: `python handover/build.py` (and `--gas` for
`gas.md`). The files are generated: never edit them by hand.

## Using the client

```ts
import { encodeFunctionData, decodeErrorResult, decodeEventLog } from "viem";
import { indicoLedgerAbi, indicoLedgerErrors } from "./indicoLedger";

const data = encodeFunctionData({ abi: indicoLedgerAbi, functionName: "requestLoan", args: [400_000000n] });
// on a failed eth_call / eth_estimateGas, take the first 4 bytes of the revert data:
const known = indicoLedgerErrors[revertData.slice(0, 10)]; // { name, message }
const decoded = decodeErrorResult({ abi: indicoLedgerAbi, data: revertData }); // the arguments
```

The backend never sends a transaction and holds no key that can call the ledger. It encodes the
calldata, simulates it with `eth_call` (refusing anything that would revert, with the message from
`errors.json`), estimates gas, and hands the hex to Flutter, which relays it to the user's wallet.

Amounts are `uint256` with 6 decimals everywhere: 1 credit = 1 USDC = `1_000000`. Never use a float.
Timestamps are unix seconds. Loan ids start at 1; 0 means "no loan".

## Deployment parameters

| Network | Chain id | USDC (Circle, native) | Ledger | Deployment block |
|---|---|---|---|---|
| Base Sepolia | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | at P3.1 | at P3.1 |
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | at P3.3 | at P3.3 |

USDC addresses from Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses
(checked 2026-10-09). The constructor takes `(usdc, admin, guardian)` and refuses any token that is
not a contract with 6 decimals.

- **Admin**: a Safe multisig, at least 2 of 3, never a single key. Holds `DEFAULT_ADMIN_ROLE` and
  `ADMIN_ROLE`. Address set at P3.1.
- **Guardian**: a Safe, may be the same one or a faster second Safe. Holds `GUARDIAN_ROLE`
  (pause and unpause only). Address set at P3.1.
- **Moving the top admin role takes two steps and 3 days** (D-19): `beginDefaultAdminTransfer(new)`,
  then after 3 days the new address itself calls `acceptDefaultAdminTransfer()`. A
  `DefaultAdminTransferScheduled` event the Safe signers did not start means act immediately:
  `cancelDefaultAdminTransfer()`. Signer changes inside the Safe never need this.
- The indexer starts from the deployment block.

## Views to call instead of rebuilding state

The read model is rebuilt from events, but these give the contract's own answer; use them for
anything a user is about to act on, and for reconciliation.

| View | Use |
|---|---|
| `available(user)` | Credit the user can spend or lock now: `credit - lockedCredit`. |
| `maxBorrow(user)` | The largest loan the user can take now (80% of available, rounded down). Always passes `collateralFor`. |
| `collateralFor(principal)` | Credit a loan locks: 1.25 x principal, rounded up. Show it before the user signs (L-02). |
| `poolAvailable()` | USDC in the pool now, the most any loan or withdrawal can take. The headline figure (AD-13). |
| `poolTotalAssets()` | USDC in the pool plus USDC lent out. |
| `maxWithdraw(merchant)` | What `withdrawAll()` would pay right now. |
| `sharesToAssets(shares)`, `assetsToShares(assets)` | Share conversions, rounded down. |
| `loans(id)` | `(borrower, dueDate, extensionCount, status, principal, collateral)`; status 0 Active, 1 Repaid, 2 Defaulted. |
| `credit`, `lockedCredit`, `shares`, `approvedUser`, `approvedMerchant`, `termsSigned`, `signedTermsHash`, `participantRole` | Per address. `participantRole`: 0 none, 1 user, 2 merchant, 3 retired wallet (moved away, D-64). |
| `accountRefOf(wallet)`, `walletOfAccount(ref)` | The wallet and app account link (D-60, D-64). |
| `termsHash()` | The terms version users sign now. |
| `paused()`, `lastPausedAt()`, `lastUnpausedAt()` | Pause state and the dates behind the grace period. |
| `totalCredit`, `poolCredit`, `totalLent`, `totalShares`, `poolUsdc`, `nextLoanId` | Totals, for reconciliation. |

## Backend rules the contract cannot enforce

1. **`accountRef` is random** (O-041): 32 random bytes or a UUIDv4 per app account, kept in
   Postgres next to the email. Never derived from the email or any personal data: a hash of an
   email is reversed by hashing a list of known emails. Everything on chain is public for ever.
2. **The `memo` of `adminIssueCredit` and `adminDebitCredit` is public too** (O-043): a random id,
   or a hash of an internal record id with a secret salt. Never a name, email, bank reference or
   description of the amount.
3. **A merchant deposit is two transactions**: `approve(ledger, amount)` on the USDC contract, then
   `deposit(amount)` on the ledger. Merchants use the block explorer, so the merchant guide says this
   first (O-032).
4. **USDC sent straight to the ledger is lost for good** (D-38): a plain `transfer` to the ledger
   address is counted nowhere, buys no share, and no function can send it back. The surplus shows as
   `usdc.balanceOf(ledger) - poolUsdc()`.
5. **Roles are permanent** (D-22): a wallet approved as a user can never be a merchant and the
   other way round. Warn the admin before the first approval (O-024).
6. **Revoking never traps money**: a revoked user can still repay; a revoked merchant can still
   withdraw. A revoked user cannot borrow, spend or extend.
7. **A lost wallet** is moved with `adminMoveAccount(oldWallet, newWallet, accountRef)` (D-64):
   only with no open loan, only to a wallet never used on the platform. The whole credit moves; the
   old wallet is retired for good. The new wallet must sign the terms before it spends or borrows.
8. **The merchant must have signed the terms** before a user can pay them; show "merchant not
   ready" rather than the raw error (O-031).

## What the pause blocks

While `paused()` is true every user and pool function reverts `EnforcedPause`: `signTerms`,
`registerAsset`, `spend`, `deposit`, `withdraw`, `withdrawAll`, `requestLoan`, `repay`, `extend`,
`liquidate`, `adminIssueCredit`, `adminDebitCredit`. Merchants cannot withdraw while paused (D-41).
Still allowed: `setTermsHash`, `setUserApproved`, `setMerchantApproved`, `adminMoveAccount`, the
role functions and `unpause`.

**After an unpause** (D-54, D-58), take both dates from the latest `PauseTimesSet` event, never from
`Paused`/`Unpaused` (back-to-back pauses merge into one disruption):
- no loan can be liquidated until `lastUnpausedAt + 7 days` (`LiquidationGracePeriod`);
- a loan whose due date is on or after `lastPausedAt` can still be extended after its due date
  until `lastUnpausedAt + 7 days`, once per 90 days of disruption;
- repayment works throughout.

## Loan timing

Term 90 days from opening. `extend` works only in the last 30 days before the due date (from
`dueDate - 30 days` to `dueDate` inclusive) and adds 90 days to the due date, not to now, as many
times as the borrower likes. Repayment works at any time until the loan is liquidated. From
`dueDate + 1 second` (and after any grace) anyone may `liquidate`; the admin dashboard lists
overdue loans for it (AD-21).

## Invariants: what must always be true

The indexer and the reconciliation job can check themselves against these after every block. A
mismatch is an alert, never something to correct silently: the contract is the source of truth.

| Id | Must always hold |
|---|---|
| I1 | `poolUsdc + totalLent >= sum(sharesToAssets(shares[m]))` over all merchants. |
| I2 | `totalLent == sum(principal)` over Active loans. |
| I3 | `lockedCredit[u] <= credit[u]` for every address. |
| I4 | `lockedCredit[u] == sum(collateral)` over u's Active loans. |
| I5 | Every Active loan: `collateral == ceil(principal * 10000 / 8000)`. |
| I6 | `totalCredit == sum(credit[a])` over every address. |
| I7 | `totalShares == sum(shares[m])`. |
| I8 | A user's credit falls only through `spend`, `adminDebitCredit`, `liquidate`, or `adminMoveAccount` (to its new wallet). |
| I9 | `spend` and `adminDebitCredit` never take credit below `lockedCredit`. |
| I10 | No withdrawal pays more than `poolUsdc`. |
| I11 | `deposit`, `withdraw` and `withdrawAll` never lower the share price and cost the caller at most 1 wei of rounding; `liquidate` lowers pool assets by exactly the principal; every other call leaves pool assets and shares unchanged. |
| I12 | Nobody but the admin changes another address's credit, except `spend` raising a merchant's and `liquidate` burning a defaulted borrower's collateral. |
| I13 | `sum(credit) + poolCredit == total minted - total burned` (from events). |
| I14 | `usdc.balanceOf(ledger) >= poolUsdc`. |
| L1 | `walletOfAccount[accountRefOf[w]] == w` for every linked wallet, and the reverse: the link is one to one. |
| L2 | A retired wallet (`participantRole == 3`) has no credit, no approval and no link. |
| C1 | Every user's credit is at most `2^128 - 1` (D-27); merchants may exceed it. |
