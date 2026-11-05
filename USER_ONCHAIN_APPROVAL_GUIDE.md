# Unified Implementation Guide: User Management & On-Chain Approval

> **Goal**: Make the **Users** section look and function **exactly like the Merchants section**, with a **`⚙️ Manage`** button in the table and an **`⚡ Connect wallet & approve on-chain`** button inside the side drawer.

---

## 1. The Design Blueprint (Reusing the Merchant Pattern)

Currently, the **Merchants** drawer has this exact UI layout under `On-chain approval`:
* **Purple Button**: `⚡ Connect wallet & approve on-chain` (or `⚡ Approve on-chain` if connected)
* **Outline Button**: `🔄 Sync on-chain status`

### Comparison:
| Screen | Current Implementation | Target (Unified) |
| :--- | :--- | :--- |
| **Merchants Table** | Has `⚙️ Manage` button | Keep as is (works great) |
| **Users Table** | Has `Approve` / `Revoke` text buttons | Change `ACTIONS` column to a clean **`⚙️ Manage`** button |
| **Users Side Drawer** | Has no on-chain buttons | Add **`⚡ Approve on-chain`** and **`🔄 Sync on-chain status`** under On-chain approval |

---

## 2. Table Update: Replace Actions with `⚙️ Manage`

In the Users table `ACTIONS` column:
Replace the direct `Revoke` / `Approve` buttons with the same `Manage` button used in Merchants:

```tsx
<td className="px-6 py-4 text-right">
  <button
    onClick={() => openUserDrawer(user)}
    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700"
  >
    <SlidersHorizontal className="w-3.5 h-3.5" />
    Manage
  </button>
</td>
```

---

## 3. Side Drawer Update: Add On-Chain Approval & Sync Buttons

Inside the **User Details** side drawer, locate the **`On-chain approval`** status section.  
Add the action buttons right below it, matching the Merchant drawer:

```tsx
<div className="mt-4">
  <div className="flex items-center justify-between">
    <div>
      <span className="text-xs text-gray-500">On-chain approval</span>
      <p className="text-sm font-semibold">
        {user.isOnChainApproved ? (
          <span className="text-emerald-600">Approved</span>
        ) : (
          <span className="text-gray-600">Not approved</span>
        )}
      </p>
    </div>
  </div>

  {/* On-Chain Action Buttons */}
  <div className="flex items-center gap-2 mt-3">
    {!user.isOnChainApproved && (
      <button
        onClick={() => handleApproveUserOnChain(user)}
        disabled={!user.walletAddress || isApproving}
        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50"
      >
        {!walletClient
          ? "Connect wallet & approve on-chain"
          : isApproving
          ? "Broadcasting..."
          : "⚡ Approve on-chain"}
      </button>
    )}

    {user.isOnChainApproved && (
      <button
        onClick={() => handleRevokeUserOnChain(user)}
        disabled={isRevoking}
        className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
      >
        Revoke on-chain
      </button>
    )}

    <button
      onClick={() => handleSyncUserOnChain(user)}
      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
    >
      <RefreshCw className="w-3.5 h-3.5" />
      Sync on-chain status
    </button>
  </div>
</div>
```

---

## 4. Web3 Contract Logic (`setUserApproved`)

When the admin clicks **`⚡ Approve on-chain`**, broadcast the transaction using the connected admin wallet:

```typescript
import { parseAbi } from 'viem';

const SET_USER_APPROVED_ABI = parseAbi([
  'function setUserApproved(address user, bool approved, bytes32 accountRef) external',
  'function approvedUser(address user) external view returns (bool)'
]);

const INDICO_LEDGER_ADDRESS = '0xF6903fF1FD15858E5F706d39d91979313aD4Bf1e'; // Base Sepolia

// 1. Approve On-Chain
async function handleApproveUserOnChain(user) {
  if (!user.walletAddress) {
    alert('User has not bound a wallet yet. On-chain approval requires a bound wallet address.');
    return;
  }

  if (!walletClient) {
    await connectWallet(); // Trigger wallet connection if not connected
    return;
  }

  try {
    setIsApproving(true);

    // Also ensure DB status is approved
    if (!user.isApproved) {
      await api.patch(`/admin/users/${user.id}/approve`);
    }

    // Generate accountRef if missing
    const accountRef = user.accountRef && user.accountRef.startsWith('0x') && user.accountRef.length === 66
      ? user.accountRef
      : '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');

    // Broadcast setUserApproved to Base Sepolia
    const hash = await walletClient.writeContract({
      address: INDICO_LEDGER_ADDRESS,
      abi: SET_USER_APPROVED_ABI,
      functionName: 'setUserApproved',
      args: [user.walletAddress as `0x${string}`, true, accountRef as `0x${string}`],
    });

    await publicClient.waitForTransactionReceipt({ hash });
    alert('User successfully approved on-chain!');

    // Refresh user state
    await refreshUser(user.id);
  } catch (err: any) {
    console.error('On-chain approval failed:', err);
    alert(err?.message || 'Transaction failed');
  } finally {
    setIsApproving(false);
  }
}

// 2. Sync On-Chain Status
async function handleSyncUserOnChain(user) {
  if (!user.walletAddress) return;
  try {
    const isApproved = await publicClient.readContract({
      address: INDICO_LEDGER_ADDRESS,
      abi: SET_USER_APPROVED_ABI,
      functionName: 'approvedUser',
      args: [user.walletAddress as `0x${string}`],
    });

    // Update local state or trigger list re-fetch
    setUserState(prev => ({ ...prev, isOnChainApproved: Boolean(isApproved) }));
  } catch (err) {
    console.error('Sync failed:', err);
  }
}
```

---

## 5. Summary Checklist

- [ ] In **Users table**: Change action column to `⚙️ Manage` button (opening side drawer).
- [ ] In **User Details side drawer**: Under `On-chain approval`, add:
  - `⚡ Connect wallet & approve on-chain` button
  - `🔄 Sync on-chain status` button
- [ ] Call `setUserApproved(user.walletAddress, true, accountRef)` on `0xF6903fF1FD15858E5F706d39d91979313aD4Bf1e`.
- [ ] Refresh UI so the badge switches from `Not approved` to `Approved` (green).
