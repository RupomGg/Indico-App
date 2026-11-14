# Indico Admin Dashboard: Required Changes for Ledger 1.1.0

**For:** the admin dashboard developer (`indico-admin-dashboard.vercel.app`) · **Date:** 2026-11-14
**Network:** Base Sepolia (84532) · **Backend:** `https://indico-app-backend.onrender.com/api/v1`
**API details:** `admin_api_audit.md`, section 0 (endpoints, request and response bodies, errors).

This list comes from a full test of the live dashboard against the new ledger on 2026-11-14. Items
are ordered by priority. **P0 items must ship before anyone uses the dashboard again**: with them
unfixed, the dashboard sends transactions to a retired contract.

---

## P0. Blocking

### 1. Replace the hard-coded ledger address

The dashboard still uses the retired ledger `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`.
Observed on 2026-11-14:

- **"Onboard merchant" sent its wallet transaction to `0x422D…e96cF`**. On the old contract that
  call still works, so the merchant would have been approved on a contract nothing uses, while the
  dashboard showed success. The test transaction was cancelled.
- **Credits** page and **Settings → Network & contracts** both show `0x422D36E2…96de96cF`.

Fix:

- One constant (or `VITE_LEDGER_ADDRESS`) used everywhere: wallet transactions, labels, explorer links.
- New value: `0xBB1925cf6E5D6C66255B1B13a0430E7643b990D3`.
- Before every wallet transaction, check the target equals that constant and that the wallet is on
  chain 84532; refuse otherwise.
- Search the codebase for `0x422D` and `422D36E2` until nothing is left.

### 2. Merchant onboarding: the signed agreement is now required

The ledger's call is now **three arguments**:
`setMerchantApproved(address merchant, bool approved, bytes32 agreementHash)`.
The old two-argument call does not exist on the new ledger.

**Add merchant** form changes:

1. Add a required field **"Signed agreement (PDF, PNG or JPEG, max 20 MB)"**.
2. Remove the note "the backend currently records every new merchant's agreement as signed". It is
   no longer true.
3. Flow on submit, in this order:
   1. `POST /admin/merchants` with `agreementStatus: "SIGNED"`.
   2. `POST /admin/merchants/:id/agreement/file`, `multipart/form-data`, field `file`. Response
      `201` with `sha256`.
   3. Optional safety check: compute SHA-256 of the file in the browser and stop if it differs
      from the response's `sha256`.
   4. Admin wallet sends `setMerchantApproved(wallet, true, sha256)` to the **new** ledger.
   5. `POST /admin/merchants/:id/sync-chain`, then reload the list.
4. If the wallet step is cancelled or fails, keep the record and show **"Not approved on-chain"**
   with an **Approve on-chain** button (today's behaviour here is good; keep it).

**"Approve on-chain"** on the merchant details panel must also ask for the agreement file (or reuse
the stored one's `sha256`) and send the three-argument call. **Revoke** sends
`setMerchantApproved(wallet, false, 0x0000…0000)`; a non-zero hash on revoke reverts
`AgreementHashOnRevoke()`.

### 3. Remove "Sync merchant deposit"

The dashboard overview still has **Sync merchant deposit**, which calls `syncDeposit`. That function
no longer exists. Remove the button. See item 5 for its replacement.

---

## P1. Required for the release

### 4. Merchant details panel

Observed on the TestMerchant panel:

| Today | Change to |
|---|---|
| "Terms signed: Yes" | **"Agreement recorded on-chain: Yes"**, with the `agreementHash` from `GET /admin/merchants` (shortened, copy button) |
| No deposit address | **"Deposit address"**: `depositBox` from `GET /admin/merchants`, copy button and BaseScan link |
| "Signed copy —" and "Record signed copy" (asks for a path) | **Upload signed copy** (item 2, step 3.2) and **Download signed copy** (`GET /admin/merchants/:id/agreement/file`) |
| Note "the backend does not … store agreement files" | Remove. Show a ✓ when the downloaded file's `X-Agreement-SHA256` header equals `agreementHash`, and a red warning when it differs |
| "Mark agreement sent" shown for a signed agreement | Hide it once the status is `SIGNED` |

After an upload the response has `matchesOnChain`: `true` show ✓, `false` show a red warning
("This file is not the agreement recorded on-chain"), `null` show "Not yet recorded on-chain".

### 5. Merchant deposits: each merchant has its own deposit address

Merchants no longer send USDC to the ledger. Each approved merchant has a personal deposit address
(`depositBox`). The backend's keeper moves USDC from there into the pool automatically, usually
within a few seconds (verified: a 20 USDC deposit became 20 USDC of pool shares for that merchant).

- Wherever the dashboard shows "where merchants send USDC", show **that merchant's** `depositBox`,
  never the ledger address. Add the warning: **"Send USDC on Base only. USDC sent to the ledger
  address, or any other token, is lost."**
- Optional manual action **"Sweep deposit address"** on a merchant: the admin wallet calls
  `sweep(merchant)` on the ledger, no amount. Errors: `ZeroShares()` = the address is empty;
  `NotApprovedMerchant()` = not approved.
- Merchant details: show the merchant's pool position (USDC withdrawable) if the API exposes it; if
  not, ask the backend team (it is `maxWithdraw(merchant)` on the ledger).

### 6. Users: on-chain approval with the account reference

Could not be tested on the live dashboard (no user registered there yet). Verify:

- Approving a user must send `setUserApproved(wallet, true, accountRef)` from the admin wallet to the
  new ledger, where `accountRef` is the value the backend returns for the user's wallet binding.
  Never generate it in the browser.
- Revoking sends `setUserApproved(wallet, false, accountRef)` with the **same** reference, or it
  reverts `AccountRefMismatch`.
- Show the D-22 warning before approving: a wallet approved as a user can never become a merchant,
  and the reverse.
- Database approval and chain approval must not drift: show both states, as the Merchants page does.

### 7. Credits: issue and debit (AD-10, AD-11, AD-12)

The Credits page only explains that credit is issued "from the Safe". There is no way to do it.
The signed list requires: issue credit to a user, record a payment received, record a cash
settlement. Add:

- **Issue credit**: user, amount (6 decimals), payment reference. Admin wallet sends
  `adminIssueCredit(user, amount, memo)`.
- **Debit credit (cash settlement)**: `adminDebitCredit(user or merchant, amount, memo)`.
- The `memo` is public on-chain forever. It must be an opaque reference (a random id), **never** a
  name, email, bank reference or description.
- On testnet the admin wallet signs directly. On mainnet the admin is a Safe, so the button creates
  a Safe proposal instead; design for both.

### 8. Loans: extension rule and liquidation

- The page says **"can be extended up to 3 times"** and shows **"0 / 3"**; Settings says **"at most
  3 extensions"**. Wrong: extensions are **unlimited**, 90 days each, only in the last 30 days before
  the due date. Show the count only ("0 extensions").
- Overdue loans (AD-21): a **Liquidate** action that sends `liquidate(loanId)`. Show it only when
  `now > dueDate` **and** the 7-day grace after the last unpause has passed; otherwise show when it
  becomes possible. (`canLiquidate` from the API ignores the grace today, finding P2.)

### 9. Treasury card

"Treasury ETH: 0 ETH, Low balance" is wrong: the backend reads the **ledger's** balance, not the
admin wallet's or the Safe's (finding P3). Until the backend adds `SAFE_ADDRESS`, label the card
"Admin wallet ETH" and read the connected admin wallet's balance in the browser, or hide it.

### 10. Admin AI console (AD-19), admin only

The dashboard has no AI console page yet. The backend endpoint exists and is admin-only.

**Endpoint**

```
POST /api/v1/ai/admin/prompt
Authorization: Bearer <admin token>        (a user token gets 403, no token 401)
Content-Type: application/json

{ "prompt": "Pool liquidity status" }      (1 to 500 characters, trimmed)
```

**Response (always 200 for a valid request)**

```json
{
  "success": true,
  "type": "MESSAGE | ACTION_PREVIEW | UNKNOWN | ERROR",
  "intent": "ADMIN_READ_POOL",
  "text": "📊 Pool Operations State: …",
  "requiresWalletSignature": false,
  "preview": { "…": "structured details, optional" },
  "preparedTx": { "to": "0x…", "data": "0x…", "value": "0" }
}
```

`preparedTx` is present only when `type` is `ACTION_PREVIEW`.

**What it understands today** (keyword-based, deterministic, no outside model):

| Command (example) | `intent` | `type` | Wallet? |
|---|---|---|---|
| "Pool liquidity status" | `ADMIN_READ_POOL` | `MESSAGE` | No |
| "Show active and overdue loans" | `ADMIN_READ_LOANS` | `MESSAGE` | No |
| "Lookup user alice@example.com" or "… user 0x…" | `ADMIN_LOOKUP_USER` | `MESSAGE` | No |
| "Issue credit of 1,000 to 0x… ref INV-001" | `ADMIN_ISSUE_CREDIT` | `ACTION_PREVIEW` | Yes, `adminIssueCredit` |
| "Debit credit of 500 from 0x… ref CASH-001" | `ADMIN_DEBIT_CREDIT` | `ACTION_PREVIEW` | Yes, `adminDebitCredit` |
| "Add service Legal consultation to merchant TestMerchant price 50" | `ADMIN_ADD_SERVICE` | `MESSAGE` | No, saved at once |
| "Update price of Legal consultation for merchant TestMerchant to 60" | `ADMIN_UPDATE_SERVICE` | `MESSAGE` | No, saved at once |
| "Send agreement to merchant TestMerchant" | `ADMIN_SEND_AGREEMENT` | `MESSAGE` | No; records it as sent, **no email is sent** |
| anything else | `ADMIN_UNKNOWN` | `UNKNOWN` | No (the text lists the supported commands) |

**How the page must behave**

1. A chat panel: input box, the admin's command, then the response `text` (keep line breaks).
2. `MESSAGE` and `UNKNOWN`: show `text` only. Nothing else happens.
3. `ACTION_PREVIEW`: show a **confirmation card** built from `preview` (action, wallet, amount),
   and a button **"Sign with admin wallet"**. Never send automatically. On click:
   - Check `preparedTx.to` equals the ledger constant (`0xBB19…90D3`, item 1) and the wallet is on
     chain 84532 and is the admin wallet; refuse otherwise.
   - Send `{ to, data, value }` exactly as returned. Do not rebuild or edit the calldata.
   - Show the transaction hash with a BaseScan link, then poll until `CreditMinted` /
     `CreditBurned` appears (item 14).
4. A cancelled or failed wallet step leaves nothing changed; say so.
5. Never send the console's text anywhere but this endpoint, and never put document contents in it.

**What the backend guarantees for credit commands**

- The amount is read with the wallet address and the reference removed, in any order ("Issue credit
  to 0x… amount 1000" is 1000). A missing amount, 0, or more than 6 decimals returns `UNKNOWN`.
- Before a preview, the backend reads the ledger and returns `ERROR` (no `preparedTx`) if the
  transaction would revert: ledger paused; issue to anything but a user; issue past the per-account
  cap; debit of anything but a user or merchant; debit above available credit; ledger unreadable.
- The on-chain memo is 32 random bytes, different on every preview, returned as `preview.memo`. The
  admin's own reference (`ref …`) never goes on-chain; it is returned as `preview.reference` and
  saved with the memo in the audit log (`AI_CREDIT_PREPARED`). Show both on the confirmation card.
- A merchant is found by its wallet or its exact name; an unknown or ambiguous name returns
  `UNKNOWN`. A merchant whose agreement is already signed cannot be marked sent again (`ERROR` here; `409` from `POST /admin/merchants/:id/agreement/send`).
- "Lookup user" searches the database only (email or bound wallet).

---

## P2. Should fix

11. **Transactions filter**: the event list shows `MerchantAgreementRecorded` and
    `DepositBoxAssigned`, but the filter has no options for them. Add both.
12. **Settings → Protocol parameters**: fix the extension row (item 8) and the ledger address
    (item 1). Show the deposit-address rule.
13. **Asset types**: the ledger numbers are **0 Arbitration award, 1 Bill of exchange, 2 Promissory
    note, 3 Bond, 4 Real estate, 5 Jewellery**. Wherever the dashboard shows an asset's type, map it
    with this table.
14. **After any wallet transaction**, poll the backend for a few seconds until the change appears
    (the indexer runs a few seconds behind the chain), instead of showing the old values.
15. **Pause**: if the dashboard offers pause/unpause (guardian), show that while paused no merchant
    can deposit or withdraw and no user can borrow, repay or extend.

---

## What does not change

Login, the dashboard overview figures (pool, lent, available, depositors), Loans list, Assets
registry, Blockchain Proofs (verified: the registered test asset shows "Verified on-chain"),
Transactions list, Reports, Audit Logs. These worked correctly against the new ledger in the test.

---

## Acceptance test (Base Sepolia)

- [ ] `grep -r 422D` in the dashboard finds nothing.
- [ ] Add a merchant with a PDF: the wallet prompt shows **Interacting with `0xBB19…90D3`**; after
      confirming, the panel shows Approved, the agreement hash, the deposit address and a downloadable
      signed copy whose hash matches.
- [ ] Send USDC to that deposit address: within a minute the Dashboard shows the pool up by that
      amount and a `Deposited` event for the merchant.
- [ ] Approve a user: the wallet prompt targets `0xBB19…90D3`; the user row shows approved in both
      database and chain.
- [ ] Issue 10 credit to the user, then debit 5: `CreditMinted` and `CreditBurned` appear.
- [ ] Loans page shows "0 extensions", no "/ 3".
- [ ] "Sync merchant deposit" is gone.
- [ ] AI console: "Pool liquidity status" answers with no wallet prompt; "Issue credit of 5 to
      0x…" shows a confirmation card, and only the button opens the wallet, targeting `0xBB19…90D3`;
      a user token on `/ai/admin/prompt` gets 403.
