# Feature Request: Add "Sync Merchant Deposit" Button on Admin Dashboard

> **Target Page**: `https://indico-admin-dashboard.vercel.app/#dashboard` (Operations Overview / Pool Health)  
> **Context**: When an approved merchant sends USDC directly from a mobile or hardware wallet (e.g. Tangem or MetaMask) to the Indico contract address, the contract requires `syncDeposit` to be broadcasted by the admin to credit the merchant's shares and increment available pool cash. The dashboard currently lacks this button.

---

## 1. UI Placement & Appearance

### Placement:
Add a button in the **Operations Overview** header (next to the `Refresh` button) or inside the **Pool Health** card:
* **Button Label**: `⚡ Sync Merchant Deposit`
* **Style**: Secondary/Purple button with a lightning or plus icon.

---

## 2. Modal Behavior: "Sync Merchant Direct Deposit"

When the admin clicks **`⚡ Sync Merchant Deposit`**, open a modal with the following:

### Modal Content:
1. **Notice Box**:
   > *"Credit USDC that an approved merchant transferred directly to the Indico contract from Tangem or MetaMask."*
2. **Approved Merchant Selector** (`<select>` dropdown):
   * Populate with merchants from `GET /api/v1/admin/merchants` who are approved (`isApproved === true`).
   * Display: `Merchant Name (0x1234...5678)`.
   * Value: Merchant's settlement wallet address.
3. **USDC Amount Input** (`<input type="number" step="0.000001">`):
   * Placeholder: `e.g. 10.000000`
4. **Deposit Escrow Address Display** (for reference):
   * `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF` with a "Copy" button.
5. **Action Button**:
   * Label: `Broadcast syncDeposit`

---

## 3. Web3 Contract Implementation

When the admin submits the modal:

```typescript
import { parseAbi, parseUnits } from 'viem';

const SYNC_DEPOSIT_ABI = parseAbi([
  'function syncDeposit(address merchant, uint256 amount) external'
]);

const INDICO_LEDGER_ADDRESS = '0x422D36E2198863C5b2A6B8E2865fBf5196de96cF'; // Base Sepolia

async function handleSyncDeposit(merchantWallet: string, amountUsdc: string) {
  if (!merchantWallet) {
    alert('Please select an approved merchant');
    return;
  }
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    alert('Please enter a valid USDC amount');
    return;
  }
  if (!walletClient) {
    alert('Please connect your Admin wallet first');
    return;
  }

  try {
    setIsSubmitting(true);

    // USDC has 6 decimals on Base Sepolia
    const units = parseUnits(amountUsdc, 6);

    // Broadcast syncDeposit from Admin wallet
    const txHash = await walletClient.writeContract({
      address: INDICO_LEDGER_ADDRESS,
      abi: SYNC_DEPOSIT_ABI,
      functionName: 'syncDeposit',
      args: [merchantWallet as `0x${string}`, units],
    });

    console.log('Transaction submitted:', txHash);

    // Wait for on-chain confirmation
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    alert(`Deposit successfully synced on-chain! Tx: ${txHash}`);
    closeModal();

    // Refresh dashboard data so Available Liquidity & Total Assets update
    await fetchDashboardMetrics();
  } catch (err: any) {
    console.error('syncDeposit failed:', err);
    alert(err?.message || 'Failed to sync merchant deposit');
  } finally {
    setIsSubmitting(false);
  }
}
```

---

## 4. Verification Checklist
- [ ] Button `⚡ Sync Merchant Deposit` is visible on `#dashboard`.
- [ ] Modal lists all approved merchants from the backend.
- [ ] Input converts amount with 6 decimals (`parseUnits(amount, 6)`).
- [ ] MetaMask / Wallet prompts the admin to sign `syncDeposit(merchant, amount)`.
- [ ] After confirmation, `TOTAL POOL ASSETS` and `AVAILABLE LIQUIDITY` cards refresh to show the new cash balance.

