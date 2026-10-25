# Indico Manual Hand-Testing Status & Verification Log

**Environment**: Base Sepolia (`84532`)  
**Active Ledger Contract**: [`0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`](https://sepolia.basescan.org/address/0x422D36E2198863C5b2A6B8E2865fBf5196de96cF)  
**Official Testnet USDC**: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  
**Reference Document**: [docs/feature-list.md](file:///e:/indico-build/indico-build/docs/feature-list.md)  
**Last Updated**: October 26, 2026

---

## 1. Verified & Passed Hand-Tests (Completed)

The following core journeys have been manually hand-tested and verified live against the application UI, backend database, and Base Sepolia smart contract:

| # | Feature / Flow | PRD § | Status | Verification Summary |
|:---|:---|:---:|:---:|:---|
| 1 | **User Registration & Login** | §1 | ✅ **PASS** | Registered user with email & password, generated JWT sessions, logged out and logged back in. |
| 2 | **Wallet Binding** | §1 | ✅ **PASS** | Connected MetaMask/Tangem, verified account ref linking, and bound address to user record. |
| 3 | **Admin User Approval** | §1, §3 | ✅ **PASS** | Account blocked with `⏳ PENDING ADMIN APPROVAL`; approved in Admin Portal; unblocked on-chain. |
| 4 | **On-Chain Terms Signing** | §1, §2 | ✅ **PASS** | User reviewed platform terms and broadcasted `signTerms(termsHash)` on Base Sepolia. |
| 5 | **Merchant Onboarding** | §3 | ✅ **PASS** | Created merchant entity in Admin Portal with name, email, and payout wallet address. |
| 6 | **On-Chain Merchant Authorization** | §3 | ✅ **PASS** | Admin broadcasted `setMerchantApproved` on-chain, automatically assigning `ROLE_MERCHANT`. |
| 7 | **Cataloging Merchant Services** | §3 | ✅ **PASS** | Created service offerings with title, description, and fixed USDC price. |
| 8 | **Spending Credit with Merchant** | §1 | ✅ **PASS** | User executed `spend(merchant, amount)`; credit deducted, merchant received on-chain receipt. |
| 9 | **Borrowing USDC Against Credit** | §1 | ✅ **PASS** | Borrowed USDC instantly from shared pool; locked collateral at 80% LTV ($1.25\times$). |
| 10 | **Full Loan Repayment** | §1 | ✅ **PASS** | Approved USDC allowance and executed `repay(loanId)`; unlocked collateral and returned cash to pool. |
| 11 | **Asset Upload & Credit Minting** | §1 | ✅ **PASS** | Uploaded document, calculated SHA-256 fingerprint in browser, executed `registerAsset`, minted 1:1 credit. |
| 12 | **Duplicate Document Detection** | §1 | ✅ **PASS** | Attempted to register previously recorded document hash; contract cleanly reverted (`AssetAlreadyRegistered`). |
| 13 | **Direct USDC Pool Funding & Sync** | §2, §3 | ✅ **PASS** | Merchant sent 10 USDC directly to ledger; `syncDeposit` minted pool shares and updated admin pool cash. |

---

## 2. Remaining Features for Hand-Testing (Checklist)

### A. User Portal (`http://localhost:5173/`)

- [ ] **1. Multiple Concurrent Loans** (PRD §1)
  - **Rule**: Users can hold more than one active loan at a time as long as total borrowed stays $\le 80\%$ of credit.
  - **How to Test**:
    1. In **`🏦 Borrow USDC`**, borrow `2.00 USDC`.
    2. Once confirmed, immediately borrow another `2.00 USDC`.
    3. Open **`📑 Active Loans`** and verify both appear concurrently with separate IDs, independent countdowns, and individual Repay buttons.

- [ ] **2. Loan Term Extension (+90 Days)** (PRD §1)
  - **Rule**: Borrower can extend an active loan by 90 days if within the 30-day window before due date (`now >= dueDate - 30 days`).
  - **How to Test**:
    1. Under **`📑 Active Loans`**, click **`Extend (+90 Days)`**.
    2. Boundary Test: Because the loan was just created, verify the contract cleanly reverts with `ExtensionWindowNotOpen`.

- [ ] **3. Borrow Rejection Boundaries (LTV & Liquidity)** (PRD §1 & §2)
  - **Test A (Exceeding 80% LTV)**: Enter an amount requiring more collateral than available credit. Verify transaction rejects with `InsufficientAvailableCredit`.
  - **Test B (Exceeding Pool Liquidity)**: Try borrowing `50.00 USDC` when pool cash is `10.00 USDC`. Verify transaction rejects with `InsufficientLiquidity`.

- [ ] **4. Indico User AI Assistant** (PRD §1)
  - **Rule**: Natural language assistant for account queries and preparing transactions.
  - **How to Test**:
    1. Open **`🤖 Indico AI Assistant`** tab.
    2. Ask: `"What is my available credit and current loan balance?"` ➔ Answers immediately without signature.
    3. Prompt: `"I want to borrow 1 USDC"` ➔ Shows transaction summary and prompts MetaMask confirmation.

- [ ] **5. Password Reset Flow** (PRD §1)
  - **How to Test**: On the login screen, select **Reset Password**, input email, enter reset token from console/logs, and verify password update.

---

### B. Admin Portal (`http://localhost:5173/` ➔ Admin Login)

- [ ] **1. CSV Spreadsheet Audit Export** (PRD §3)
  - **Rule**: Operator can export full tamper-proof action log to a spreadsheet.
  - **How to Test**:
    1. Click the top header button **`📥 Export CSV Audit`**.
    2. Verify `indico-audit-log-<timestamp>.csv` downloads containing timestamps, actors, actions, and tx hashes.

- [ ] **2. Merchant Arbitration Agreement Lifecycle** (PRD §3)
  - **Rule**: Tracking off-platform physical merchant contracts.
  - **How to Test**:
    1. In **`🏪 Merchants & Services`**, find your merchant row.
    2. Click **Send Agreement** ➔ updates status to `Sent` with timestamp.
    3. Click **Mark as Signed** (input document storage key) ➔ status transitions to `Signed`.

- [ ] **3. Edit & Delete Merchant Services** (PRD §3)
  - **Rule**: Admin can update titles, descriptions, and prices or remove offerings.
  - **How to Test**:
    1. In **`🏪 Merchants & Services`**, click **View Offerings** on any merchant.
    2. Click **✏️ Edit** on a service to change its USDC price.
    3. Click **🗑️ Delete** to remove a service and verify it disappears from the User's spend catalog.

- [ ] **4. Admin AI Console** (PRD §3)
  - **Rule**: Natural language operations and lookup console.
  - **How to Test**:
    1. Open **`⚡ Admin AI Console`** tab.
    2. Ask: `"What is the current pool liquidity and total lent out?"`
    3. Ask: `"Show details for user..."` or `"Show merchant Apex Arbitration"`.

---

### C. Platform & External Boundary Tests

- [ ] **1. External Merchant Pool Withdrawal (`withdraw` / `withdrawAll`)** (PRD §2)
  - **Rule**: Merchants never use the app. They withdraw available cash directly using their custody wallet/script, burning proportional shares.
  - **How to Test**:
    ```powershell
    cast send 0x422D36E2198863C5b2A6B8E2865fBf5196de96cF "withdraw(uint256)" 5000000 --private-key $env:TEST_MERCHANT_PK --rpc-url https://sepolia.base.org
    ```
    *Verification*:
    1. Merchant wallet receives 5.00 USDC.
    2. Admin Dashboard reflects pool liquidity decrementing from `10.00 USDC` ➔ `5.00 USDC`.

- [ ] **2. Direct Admin Credit Issuance & Cash Settlement** (PRD §3 AD-10, AD-12)
  - **Rule**: Admin can credit users for off-platform fiat wires (`adminIssueCredit`) or debit for private cash settlements (`adminDebitCredit`).

- [ ] **3. Overdue Loan Default & Liquidation** (PRD §2, §3)
  - **Rule**: If a loan reaches `dueDate` without repayment or extension, locked collateral credit is seized and transferred permanently to the pool.
  - **How to Test**: Under Admin **`📊 Pool & Loans`**, click **`⚡ Liquidate Default`** on an overdue loan.

- [ ] **4. Lost Wallet Migration (`adminMoveAccount`)** (PRD §2 D-64)
  - **Rule**: Admin moves account credit and active loans from a compromised wallet to a verified new wallet. The old wallet is retired permanently.

- [ ] **5. Emergency Guardian Pause & Unpause** (PRD §2 D-24)
  - **Rule**: Admin/Guardian calls `pause()` during an emergency. State mutations revert with `EnforcedPause` until `unpause()` is called.

---

## 3. Architecture Notes & Invariants

1. **Zero Fees Policy**: 0% fee on asset minting, 0% fee on merchant spending, 0% fee on borrowing or repayments.
2. **Merchant App Separation**: Merchants never access the web dApp; all merchant interactions (deposits, receipts, withdrawals) occur via external Web3 wallets or direct on-chain calls.
3. **80% Borrowing Ratio**: Borrowers must lock $1.25\times$ collateral ($1 / 0.8$) in credit for every 1.00 USDC borrowed.
4. **Shared Pool Liquidity**: Funds are pooled into an ERC-4626 style vault. Merchants can only withdraw cash that is not actively lent out to borrowers.
