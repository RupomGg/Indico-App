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

## 7. Corrections to the old FLUTTER_DEVELOPER_GUIDE.md

These were wrong before this update; fix them if the app followed the old guide:

| Old guide says | Actual |
|---|---|
| Login by `POST /auth/nonce` and `POST /auth/verify` | Login is email and password (`/auth/register`, `/auth/login`); the wallet is linked with `POST /profile/wallet/bind` |
| Borrow via `POST /loans/prepare-request` | `POST /loans/prepare-borrow` |
| Loans show "Accrued Interest" | There is no interest and no fee, ever. Show principal, collateral locked, due date, status |
| Pay a merchant by scanning a QR invoice | The user picks a merchant from `GET /merchants`, taps a service to prefill the amount, or types any amount |
