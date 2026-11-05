# Indico Admin Dashboard — Web3 Wallet Module & On-Chain Governance Guide

> **Target Dashboard:** `https://indico-admin-dashboard.vercel.app`  
> **Reference Local Code:** `frontend/src/wallet.ts` & `frontend/src/views/adminView.ts`  
> **Network:** Base Sepolia (`Chain ID: 84532`, RPC: `https://sepolia.base.org`)  
> **Indico Ledger Contract:** `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`  
> **USDC Contract:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  
> **Live Backend API:** `https://indico-app-backend.onrender.com/api/v1`  
> **Target Audience:** Frontend Web Developers (Vercel Admin Dashboard Team)  

---

## 1. Overview & Current Gap

On `https://indico-admin-dashboard.vercel.app/#users`:
- **No Wallet Connection:** There is currently no wallet connect button in the header.
- **Approving a User is Web2-Only:** Clicking "Approve" only updates the PostgreSQL database (`POST /api/v1/admin/users/:id/approve`). The smart contract (`IndicoLedger`) is never notified. When that user attempts to mint an asset or borrow on the mobile app, the contract reverts with `ParticipantNotApproved`.
- **Merchants Not Authorized On-Chain:** Adding a merchant only saves them in the database; `IndicoLedger.setMerchantApproved` is never called, blocking credit spends with that merchant.

This guide provides the exact wallet module code and button handlers needed to add standard Web3 wallet connectivity (MetaMask, Brave, Coinbase, WalletConnect) to the admin dashboard.

---

## 2. Standard Web3 Wallet Module (`src/wallet.ts`)

Install `viem` in your admin dashboard frontend (or use ethers.js/wagmi if preferred):

```bash
npm install viem
```

Add this lightweight, robust wallet manager (identical to our local setup in `frontend/src/wallet.ts`):

```typescript
import { encodeFunctionData, parseAbi, type Address } from "viem";

export const INDICO_LEDGER_ADDRESS: Address = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34"; // 84532 in hex

export class AdminWalletManager {
  private static activeAccount: string | null = null;

  /**
   * Prompts browser wallet connection (MetaMask, Brave, Coinbase, EIP-1193)
   */
  static async connect(): Promise<string> {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      throw new Error("No Web3 wallet extension detected. Please install MetaMask or use a Web3 browser.");
    }

    const accounts = (await (window as any).ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];

    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts authorized in wallet");
    }

    this.activeAccount = accounts[0].toLowerCase();
    await this.ensureBaseSepolia();

    // Listen for account change
    if ((window as any).ethereum.on && !(window as any)._hasWalletListeners) {
      (window as any)._hasWalletListeners = true;
      (window as any).ethereum.on("accountsChanged", () => window.location.reload());
      (window as any).ethereum.on("chainChanged", () => window.location.reload());
    }

    return this.activeAccount;
  }

  static async getAccount(): Promise<string | null> {
    if (this.activeAccount) return this.activeAccount;
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        const accounts = (await (window as any).ethereum.request({ method: "eth_accounts" })) as string[];
        if (accounts && accounts[0]) {
          this.activeAccount = accounts[0].toLowerCase();
          return this.activeAccount;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Ensures wallet is on Base Sepolia (Chain ID: 84532)
   */
  static async ensureBaseSepolia(): Promise<void> {
    if (typeof window === "undefined" || !(window as any).ethereum) return;
    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_SEPOLIA_CHAIN_ID_HEX }],
      });
    } catch (err: any) {
      if (err.code === 4902) {
        await (window as any).ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_SEPOLIA_CHAIN_ID_HEX,
            chainName: "Base Sepolia",
            rpcUrls: ["https://sepolia.base.org"],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          }],
        });
      }
    }
  }

  /**
   * Dispatches prepared transaction to connected wallet
   */
  static async sendPreparedTx(tx: { to: string; data: string; value?: string }): Promise<string> {
    const from = await this.getAccount();
    if (!from) throw new Error("Wallet not connected. Please connect your Admin Wallet first.");

    await this.ensureBaseSepolia();

    const hash = await (window as any).ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from,
        to: tx.to,
        data: tx.data,
        value: tx.value ? `0x${BigInt(tx.value).toString(16)}` : "0x0",
        gas: "0x493e0", // 300,000 gas fallback (within Base Sepolia limits)
      }],
    });

    return hash;
  }
}
```

---

## 3. Top Navigation Header: "Connect Wallet" Button

Add the wallet button into your top navigation bar (matching `frontend/src/main.ts`):

```html
<!-- Top Navigation Header -->
<div class="nav-actions" style="display: flex; gap: 8px; align-items: center;">
  <button id="btn-admin-wallet" class="btn btn-primary btn-sm">
    Connect Wallet
  </button>
</div>
```

```typescript
// Header Event Listener
const walletBtn = document.getElementById("btn-admin-wallet");

// Auto-check on load if already connected
AdminWalletManager.getAccount().then((account) => {
  if (account && walletBtn) {
    walletBtn.textContent = `${account.substring(0, 6)}...${account.substring(account.length - 4)}`;
    walletBtn.className = "btn btn-outline btn-sm";
  }
});

walletBtn?.addEventListener("click", async () => {
  try {
    const account = await AdminWalletManager.connect();
    walletBtn.textContent = `${account.substring(0, 6)}...${account.substring(account.length - 4)}`;
    walletBtn.className = "btn btn-outline btn-sm";
    alert(`Wallet connected: ${account}`);
  } catch (err: any) {
    alert(err.message || "Failed to connect wallet");
  }
});
```

---

## 4. Single-Click User Approval (Database + On-Chain Contract)

In your Users view (`#users`), update the **Approve** button action to perform both:
1. **Web2 API Approval:** `POST /api/v1/admin/users/:id/approve`
2. **Web3 On-Chain Authorization:** `IndicoLedger.setUserApproved(userAddress, true, accountRef)`

### 4.1 Contract Function
```solidity
function setUserApproved(address user, bool approved, bytes32 accountRef) external;
```

### 4.2 Implementation
```typescript
const SET_USER_APPROVED_ABI = parseAbi([
  "function setUserApproved(address user, bool approved, bytes32 accountRef) external"
]);

async function handleApproveUser(user: { id: string; email: string; walletAddress?: string; accountRef?: string }) {
  // 1. Check if admin wallet is connected
  const adminAccount = await AdminWalletManager.getAccount();
  if (!adminAccount) {
    alert("Please connect your Admin Wallet (top right) before approving users on-chain.");
    return;
  }

  const token = sessionStorage.getItem("admin_token") || localStorage.getItem("indico_admin_token");

  try {
    // 2. Call Web2 Backend API
    const res = await fetch(`https://indico-app-backend.onrender.com/api/v1/admin/users/${user.id}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to approve user in database");
    }

    // 3. Broadcast on-chain transaction if user has a bound wallet
    if (user.walletAddress && user.walletAddress.startsWith("0x")) {
      // Format 32-byte accountRef (fallback: SHA-256 of email)
      let ref = user.accountRef;
      if (!ref || !ref.startsWith("0x") || ref.length !== 66) {
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(user.email));
        ref = "0x" + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      }

      // Encode function data
      const data = encodeFunctionData({
        abi: SET_USER_APPROVED_ABI,
        functionName: "setUserApproved",
        args: [user.walletAddress as `0x${string}`, true, ref as `0x${string}`],
      });

      // Triggers browser wallet signature prompt
      const txHash = await AdminWalletManager.sendPreparedTx({
        to: INDICO_LEDGER_ADDRESS,
        data,
      });

      alert(`✓ User approved in Database & On-Chain!\nBaseScan Tx: https://sepolia.basescan.org/tx/${txHash}`);
    } else {
      alert("✓ User approved in Database! (User has not bound a wallet yet).");
    }

    window.location.reload();
  } catch (err: any) {
    alert(`Approval Failed: ${err.message}`);
  }
}
```

---

## 5. Merchant Onboarding, Terms & On-Chain Authorization

Per **PRD §4.7 AD-04 to AD-08**:
- Merchants sign their legal agreement off-platform.
- The Admin registers the merchant, attaches catalog services, marks terms as signed, and authorizes them on the smart contract (`setMerchantApproved`).

### 5.1 Contract Function
```solidity
function setMerchantApproved(address m, bool approved) external;
```

### 5.2 Implementation
```typescript
const SET_MERCHANT_APPROVED_ABI = parseAbi([
  "function setMerchantApproved(address m, bool approved) external"
]);

async function handleOnboardMerchant(payload: {
  name: string;
  contactEmail: string;
  walletAddress: string;
  serviceName: string;
  servicePriceUsdc: string;
}) {
  const adminAccount = await AdminWalletManager.getAccount();
  if (!adminAccount) {
    alert("Please connect your Admin Wallet before onboarding merchants.");
    return;
  }

  const token = sessionStorage.getItem("admin_token") || localStorage.getItem("indico_admin_token");

  try {
    // 1. Create Merchant in Backend Database (agreement pre-signed)
    const res = await fetch("https://indico-app-backend.onrender.com/api/v1/admin/merchants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        name: payload.name,
        contactEmail: payload.contactEmail,
        walletAddress: payload.walletAddress,
        isApproved: true,
        agreementStatus: "SIGNED",
        initialService: {
          name: payload.serviceName,
          price: payload.servicePriceUsdc,
          description: `${payload.serviceName} verified service offering`,
        }
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to create merchant in database");
    }

    const data = await res.json();
    const merchantId = data?.merchant?.id || data?.id;

    // 2. Broadcast on-chain authorization (IndicoLedger.setMerchantApproved)
    const calldata = encodeFunctionData({
      abi: SET_MERCHANT_APPROVED_ABI,
      functionName: "setMerchantApproved",
      args: [payload.walletAddress as `0x${string}`, true],
    });

    // Triggers wallet confirmation prompt
    const txHash = await AdminWalletManager.sendPreparedTx({
      to: INDICO_LEDGER_ADDRESS,
      data: calldata,
    });

    // 3. Mark on-chain sync in database
    if (merchantId) {
      await fetch(`https://indico-app-backend.onrender.com/api/v1/admin/merchants/${merchantId}/sync-chain`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
    }

    alert(`✓ Merchant "${payload.name}" fully onboarded and authorized on Base Sepolia!\nTx: https://sepolia.basescan.org/tx/${txHash}`);
    window.location.reload();
  } catch (err: any) {
    alert(`Merchant Onboarding Error: ${err.message}`);
  }
}
```

---

## 6. Smart Contract Reference Cheat Sheet

- **Contract Address:** `0x422D36E2198863C5b2A6B8E2865fBf5196de96cF` (Base Sepolia)
- **Explorer:** `https://sepolia.basescan.org/address/0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`

| Action | Function Signature | Required Sender |
| :--- | :--- | :--- |
| **Authorize User** | `setUserApproved(address user, bool approved, bytes32 accountRef)` | `ADMIN_ROLE` (`0xb9B4...F677`) |
| **Authorize Merchant** | `setMerchantApproved(address m, bool approved)` | `ADMIN_ROLE` (`0xb9B4...F677`) |
| **Activate Terms** | `setTermsHash(bytes32 newHash)` | `ADMIN_ROLE` (`0xb9B4...F677`) |
| **Sign Terms** | `signTerms(bytes32 acceptedHash)` | Participant / Merchant |

---

## 7. Developer Acceptance Checklist

- [ ] **Connect Wallet Button:** Visible in top header. Clicking prompts wallet extension and displays truncated address (`0x...`).
- [ ] **Network Enforcement:** Automatically prompts to switch to **Base Sepolia (`84532`)** if wallet is on another network.
- [ ] **Dual User Approval:** Clicking "Approve" updates database status AND prompts wallet to sign `setUserApproved`.
- [ ] **Clickable BaseScan Link:** Successful transaction displays a BaseScan link (`https://sepolia.basescan.org/tx/{hash}`).
- [ ] **Merchant Onboarding:** Saves merchant in database AND prompts wallet to sign `setMerchantApproved`.
