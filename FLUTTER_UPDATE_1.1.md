# Indico Flutter App: Update for Ledger 1.1.0

**For:** the Flutter developer · **Date:** 2026-11-13 · **Network:** Base Sepolia (chain id 84532)

The smart contract was redeployed with two changes to how **merchants** are onboarded and fund
the pool. The user app is barely affected. This note lists exactly what to change, what to leave
alone, and what to retest.

---

## 1. New addresses

| | Old (retired) | New |
|---|---|---|
| Indico Ledger | `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF` | `0xBB1925cf6E5D6C66255B1B13a0430E7643b990D3` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | unchanged |
| Chain id | 84532 | unchanged |
| BaseScan | | https://sepolia.basescan.org/address/0xbb1925cf6e5d6c66255b1b13a0430e7643b990d3 |

The old contract is retired. Nothing sent to it will appear in the app.

---

## 2. What you must change

### 2.1 Replace the ledger address wherever it is hard-coded
Search the Flutter project for `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF` and replace every hit with
`0xBB1925cf6E5D6C66255B1B13a0430E7643b990D3`. Typical places: a constants file, BaseScan links,
an "About / contract" screen.

**Never use a hard-coded address as the transaction `to`.** Every `prepare-*` endpoint returns
`{ to, data, value }`; always send exactly that `to`. If the app already does this, transactions need
no change at all.

### 2.2 Remove any "merchant has not signed the terms" handling
Merchants no longer sign the platform terms with a wallet. They sign a paper agreement and the
admin records it on-chain when approving them. So:

- The error `MerchantTermsNotSigned` no longer exists.
- The backend message *"Merchant has not signed platform terms yet"* is no longer returned by
  `POST /credit/prepare-spend`.

If the app matches on either (to show "merchant not ready", or to hide a merchant), delete that
branch. Every merchant returned by `GET /merchants` can be paid.

### 2.3 Expect every user to onboard again on the new ledger
Approvals and terms signatures live on the contract, and the new contract starts empty. For each
existing test user:

1. The admin approves them again (admin dashboard).
2. They sign the terms again in the app. The terms hash is new:
   `0x632842821eb1ef312e7fba001f40860d852297c119fa9456c34f13f7e98fb3df`.
   Always take it from `GET /terms/current`; never hard-code it.
3. Credit, assets and loans from the old ledger do not carry over. History starts empty.

The app's existing states already cover this ("waiting for approval", "sign the terms"). Just make
sure they are driven by the backend (`GET /profile`, `GET /terms/status`) and not by a cached flag
from an earlier session.

---

## 3. What does NOT change

| Area | Status |
|---|---|
| Login, register, email verification, password reset, JWT | Unchanged |
| Wallet connection (Tangem App and MetaMask over WalletConnect v2), `POST /profile/wallet/bind` | Unchanged |
| Sending transactions: backend prepares `{ to, data, value }`, the wallet signs and broadcasts | Unchanged |
| Terms: `GET /terms/current`, `GET /terms/status`, `POST /terms/prepare-sign` | Unchanged (new hash, same flow) |
| Assets: SHA-256 in the app, `POST /assets/presigned-upload`, upload, `POST /assets/submit`, `POST /assets/:id/prepare-register` | Unchanged |
| Pay a merchant: `GET /merchants`, `POST /credit/prepare-spend` | Unchanged request and response |
| Loans: `POST /loans/prepare-borrow`, `prepare-repay`, `prepare-extend` (including the USDC `approvalTx` step before repay) | Unchanged |
| Balances and history: `GET /history/balance`, `/history/loans`, `/history/transactions` | Unchanged |
| 6-decimal amount handling, gas check (`canAfford`, `ethShortfall`) | Unchanged |
| AI assistant: `POST /ai/user/prompt` | Unchanged |
| Android manifest, Tangem deep links, dependencies | Unchanged |

---

## 4. The merchant signed agreement is NOT part of the Flutter app

Merchants never use the app (signed scope). The signed agreement upload happens in the **admin
dashboard**, when the admin approves a merchant:

1. The merchant signs the arbitration agreement on paper.
2. The admin opens the merchant in the admin dashboard and picks the signed PDF or image.
3. The dashboard computes the file's SHA-256 and sends one admin wallet transaction,
   `setMerchantApproved(merchant, true, sha256OfSignedAgreement)`.
4. That transaction records the agreement on-chain **and** gives the merchant a personal deposit
   address. Merchants fund the pool by sending USDC to that address from any wallet; the backend
   moves it into the pool for them.

Nothing in this flow touches the Flutter app. The admin dashboard team has its own update.

---

## 5. Retest checklist (Base Sepolia)

- [ ] No `0x422D36E2…96cF` left anywhere in the project.
- [ ] New user: register, verify email, connect wallet, bind wallet, wait for approval.
- [ ] Sign terms through the wallet; `GET /terms/status` then shows signed.
- [ ] Register an asset; credit appears after a few seconds.
- [ ] Pay a merchant (the admin must have approved one on the new ledger first).
- [ ] Borrow, then repay (two wallet prompts: USDC approve, then repay).
- [ ] Extend a loan only inside its last 30 days (otherwise the backend returns a readable refusal).
- [ ] Every transaction hash opens on BaseScan under the new contract.
- [ ] A refused action shows the backend's readable message, never raw hex.

---

## 6. Found in the 2026-11-14 end-to-end test: check the app does this

The full user journey (register, bind wallet, approval, terms, asset, pay a merchant, borrow, repay)
was run on Base Sepolia against the new ledger. Every on-chain step worked. These are the
behaviours the test web client got wrong; make sure the Flutter app gets them right.

| # | Rule | Why |
|---|---|---|
| 6.1 | **Asset type numbers are 0 to 5**: 0 Arbitration award, 1 Bill of exchange, 2 Promissory note, 3 Bond, 4 Real estate, 5 Jewellery. Send the number, show the label from this table. | The test client sent 3 for "Promissory note"; the ledger recorded a **Bond**, permanently. |
| 6.2 | **After every confirmed transaction, refresh balances by polling** `GET /history/balance` (and loans) every 2 s for up to ~30 s until the change appears. | The indexer runs a few seconds behind the chain; the test client kept showing 0 credit after minting 1,000. |
| 6.3 | **Terms screen shows the full terms text** (`content` from `GET /terms/current`) and the estimated network cost before the user signs. | U-06, U-12. The test client showed only a title and the hash. |
| 6.4 | **Review screen before registering an asset**: every field and the declared value, then confirm. | A-05. |
| 6.5 | **Repay screen states the exact amount** ("Repay 10.00 USDC"), and that two wallet prompts follow (USDC approve, then repay). | The amount was missing in the test client. |
| 6.6 | **Extend button**: disabled until the window opens, with the date it opens ("Extension opens on 13 Jan 2027"). The backend's refusal message contains a Unix timestamp; format it as a date. | |
| 6.7 | **Max you can borrow now** = the smaller of the user's limit and the pool's available USDC. | The test client showed 760 while the pool held 20. |
| 6.8 | **Logout always clears the local session**, even if the server answers 401 (expired session). Otherwise the user is stuck signed in to a dead session. | |
| 6.9 | **Switching the wallet account** in Tangem or MetaMask must not lose the app's place; re-read the connected address and, if it differs from the bound wallet, say so instead of sending. | |
| 6.10 | A refused action shows the backend's message (tested: "requested loan exceeds available pool liquidity", "spend exceeds available credit", "extension window is not open yet"), and **no wallet prompt opens**. | These all worked; keep it that way. |

---

## 7. Found in the review of `indico-debug.apk` (2026-11-14): still to do

The app was checked against the PRD. Almost everything is implemented correctly. These are
the gaps.

| # | PRD / guide | What the app does now | What it should do |
|---|---|---|---|
| 7.1 | U-02 | An unapproved user can tap "Continue to App" and browse. | Show a waiting screen and nothing else until the admin approves: "Your account is waiting for approval", plus a **Check again** button (`GET /profile`, `GET /profile/wallet`) and **Log out**. |
| 7.2 | U-10 | The ETH balance only appears on the Wallet settings screen. | On the connect-wallet screen, once the wallet is connected, show its Base ETH balance (`GET /profile/wallet` → `ethBalance`) and one plain sentence: "You need a small amount of ETH on Base to pay network costs." No jargon, no "gas". |
| 7.3 | Guide 6.7 | "Estimated maximum" = available credit × 80%, ignoring the pool. | Show the **smaller** of your limit and the pool's available USDC, and say which one limits you ("Limited by pool liquidity"). Until the API exposes pool cash, keep the server's refusal message as the final word. |
| 7.4 | Guide 6.6 | The Extend button shows a generic message. | Disabled until the window opens, labelled with the date: "Extension opens on 13 Jan 2027" (due date − 30 days). |
| 7.5 | D-58 | `canExtend` is false after the due date. | After a pause, the contract allows a late extension until the grace period ends. Don't hide the button after the due date: call `POST /loans/prepare-extend` and show its refusal if it refuses. |
| 7.6 | C-02 | 6 filter chips. | Filters for every type the PRD lists: minted, spent, borrowed, repaid, **locked, released, defaulted, admin adjustment**. A `CreditMinted` or `CreditBurned` that is not from an asset registration (no matching `AssetRegistered` in the same transaction) is an **admin adjustment**. |
| 7.7 | AI-01 to AI-07 | The assistant matches phrases on the device. "Send credit" and "borrow" only open a screen, only "balance" is answered, and there is no repay or extend. | Use the backend assistant, section 7.8. |

### 7.8 Password rule (sign-up, reset, change password)

The backend now refuses a new password unless it has:
- 8 to 128 characters,
- at least one uppercase letter (A-Z),
- at least one number (0-9),
- at least one symbol: any character that is not a letter, a number or a space (`! @ # $ % - _ .`
  and so on). An accented letter such as `é` is not a symbol.

Show the rule under the password field on all three screens: "At least 8 characters, with at least
one uppercase letter, one number and one symbol." Check it in the app before submitting, with one
tick per rule as the user types. If the app sends a weak password anyway, the backend answers 400
and lists every missing part, for example "Password must contain at least one uppercase letter,
Password must contain at least one symbol".

**Login is unchanged:** it accepts any non-empty password, so accounts created under the old
8-character rule can still sign in. They meet the new rule the next time they change or reset it.

### 7.9 User AI assistant endpoint

The backend parses the command, prepares the transaction and checks it would succeed. The app
shows the result and, for a transaction, asks the user to sign. The assistant never signs anything
itself.

```
POST /api/v1/ai/user/prompt
Authorization: Bearer <user token>        (approved users only; otherwise 403)
Content-Type: application/json

{ "prompt": "Borrow 500 USDC" }           (1 to 500 characters)
```

Response (200 for any valid request):

```json
{
  "success": true,
  "type": "MESSAGE | TRANSACTION_PREVIEW | UNKNOWN | ERROR",
  "intent": "READ_STATUS | REQUEST_LOAN | REPAY_LOAN | EXTEND_LOAN | SPEND_CREDIT | UNKNOWN",
  "text": "Prepared borrow preview for 500.000000 USDC …",
  "requiresWalletSignature": true,
  "preview": { "action": "Request Loan", "principal": "500.000000 USDC", "…": "…" },
  "preparedTx": { "to": "0xBB19…90D3", "data": "0x…", "value": "0", "estimatedGasEth": "0.000…" },
  "preparedTxs": [ { "to": "…", "data": "…", "value": "0", "estimatedGasEth": "…" } ]
}
```

`preparedTxs` lists every transaction to sign, in order. `preparedTx` is present only when there is
exactly one. **Always sign `preparedTxs`, in order, waiting for each receipt.** A repay whose USDC
allowance is missing has two entries (USDC approval, then repay) and no `preparedTx`.

For a balance question, `preview.maxBorrowable` is already the smaller of the user's 80% limit and
the pool's cash, and `preview.poolAvailable` is the pool's cash (`null` if it could not be read).

What it understands:

| Example | `intent` | `type` |
|---|---|---|
| "What is my balance?", "Show my active loans" | `READ_STATUS` | `MESSAGE` |
| "Borrow 500 USDC" | `REQUEST_LOAN` | `TRANSACTION_PREVIEW` |
| "Repay loan #4" | `REPAY_LOAN` | `TRANSACTION_PREVIEW` |
| "Extend loan #4" | `EXTEND_LOAN` | `TRANSACTION_PREVIEW` |
| "What does TestMerchant offer?" | `SPEND_CREDIT` | `MESSAGE` (service list) |
| "Buy Legal consultation from TestMerchant", "Pay TestMerchant 50" | `SPEND_CREDIT` | `TRANSACTION_PREVIEW` |
| anything it can't map for certain | `UNKNOWN` | `UNKNOWN` (it never guesses an amount or a recipient) |

How the screen must behave:

1. `MESSAGE`, `UNKNOWN`, `ERROR`: show `text` with its line breaks. Nothing else happens.
2. `TRANSACTION_PREVIEW`: show a confirmation card built from `preview` (action, amount, merchant
   or loan), plus a **Confirm in wallet** button. Never send automatically. On tap, run the same
   `sendPrepared` flow as the normal screens (fee dialog, bound-wallet check, receipt, then poll
   the balance), passing the `preparedTxs` list (the `List<PreparedTx>` case `sendPrepared` already
   handles). The fee dialog shows each transaction's `estimatedGasEth`.
3. Loan numbers in commands are the on-chain loan id, the same number the loan screens show.
4. Minting an asset stays as it is now: the assistant fills in the upload form and the user
   uploads the document. No document or file content is ever sent to the assistant (AI-06).
5. Keep the local "mint" parser. Send every other command to the endpoint.

## 8. Corrections to the old FLUTTER_DEVELOPER_GUIDE.md

These were wrong before this update; fix them if the app followed the old guide:

| Old guide says | Actual |
|---|---|
| Login by `POST /auth/nonce` and `POST /auth/verify` | Login is email and password (`/auth/register`, `/auth/login`); the wallet is linked with `POST /profile/wallet/bind` |
| Borrow via `POST /loans/prepare-request` | `POST /loans/prepare-borrow` |
| Loans show "Accrued Interest" | There is no interest and no fee, ever. Show principal, collateral locked, due date, status |
| Pay a merchant by scanning a QR invoice | The user picks a merchant from `GET /merchants`, taps a service to prefill the amount, or types any amount |

---

## 9. MetaMask on a phone: slow connect, endless loading after paying, double payment (2026-11-15)

**Reported:** connecting MetaMask takes a long time; after confirming a payment in MetaMask the app
loads forever; and every time the user opens MetaMask again it asks to confirm the same payment, so
the user can pay two or more times.

**Cause, from the app code (`wallet_service.dart`, `transaction_flow.dart`):**
- Android pauses the app while MetaMask is in front, and the WalletConnect relay connection drops. The
  app never reconnects it when it comes back: `reconnectRelay()` is never called. So MetaMask's answer
  ("approved", "here is the transaction hash") never reaches the app.
- `_request` waits for that answer with **no timeout**, so `sendPrepared` and the payment screen wait
  forever.
- The answer was never delivered, so MetaMask keeps the request pending and shows it again each time
  it opens. Confirming again sends a **second, separate transaction**, and the contract executes it:
  a second payment. The contract can't tell a repeat from a real new payment, and that is correct.
- The modal is only created on the first connect (`_ensureModal`), so the first connect also has to
  start the relay and load the wallet list. That's part of the slow connect. The dropped relay
  connection is the rest of it, because the session approval is lost the same way.

**Fix (all in the app):**

1. **Reconnect the relay whenever the app comes back.** Add `Future<void> reconnectRelay()` to
   `WalletService` (`ReownWalletService`: `await _modal?.reconnectRelay();`). Call it on resume, once
   for the whole app, for example in `main.dart` or the app shell:
   ```dart
   late final _lifecycle = AppLifecycleListener(
     onResume: () => ledger.walletService.reconnectRelay(),
   );
   ```
   This is the main fix: MetaMask's answer arrives, the screen continues, and MetaMask stops showing
   the request again.

2. **Create the wallet modal early.** Call `_ensureModal(context)` once the user is signed in (shell
   `initState`), not on the first tap. Optionally list only MetaMask and Tangem with
   `featuredWalletIds` or `includedWalletIds`, so the wallet list loads faster.

3. **Never wait forever, and detect a transaction sent without an answer.** In `sendTransaction`,
   before the request, read the wallet's mined nonce (`eth_getTransactionCount(address, "latest")`,
   the same RPC as `waitForReceipt`). Then wait for whichever comes first:
   - MetaMask's answer (the hash): continue as now;
   - the mined nonce going up: the transaction was sent and mined without the answer reaching the app.
     Continue without a hash and let `afterTransaction`/`syncUntil` confirm it from the backend;
   - 3 minutes: stop and say "We could not confirm this in your wallet. Check Activity before trying
     again."

4. **Stop a second payment.** While a transaction is pending, or after one was detected in step 3:
   - keep the Pay / Borrow / Repay button disabled until the backend shows the change;
   - on the confirmation screen, and whenever the app resumes with a payment already sent, show:
     **"Your payment went through. If MetaMask asks you to confirm it again, tap Reject. Confirming
     again pays twice."**

5. **Test on a real Android phone with MetaMask** (no emulator):
   - Connect: the app returns connected within a few seconds of approving in MetaMask.
   - Pay a merchant: after confirming in MetaMask and coming back, the confirmation page appears.
     Open MetaMask again: no second prompt.
   - Kill the app's connection on purpose (airplane mode for 5 s while in MetaMask, then back on):
     the app still reaches the confirmation page, from step 3.
   - Repeat for borrow and repay (the repay has two prompts).
   - Balance drops by exactly one payment each time.

This is a **mainnet blocker**: with real USDC, a repeated prompt costs the user real money.
