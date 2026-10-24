/**
 * Indico Asset Ledger - Browser & Simulated Wallet Manager
 * Supports EIP-1193 (MetaMask/Brave/Coinbase) and built-in Viem Simulator
 */

import { type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

export interface WalletState {
  address: string | null;
  chainId: number | null;
  isSimulated: boolean;
  isConnected: boolean;
}

export class WalletManager {
  private static simAccount: ReturnType<typeof privateKeyToAccount> | null = null;
  private static isSimMode = localStorage.getItem("indico_sim_wallet") === "true";

  // Persistent simulated private key if user chooses simulated mode
  private static getSimPrivateKey(): `0x${string}` {
    let key = localStorage.getItem("indico_sim_privkey") as `0x${string}` | null;
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      key = generatePrivateKey();
      localStorage.setItem("indico_sim_privkey", key);
    }
    return key;
  }

  static isSimulated(): boolean {
    if (typeof window !== "undefined" && !!(window as any).ethereum && localStorage.getItem("indico_sim_wallet") !== "true") {
      this.isSimMode = false;
      return false;
    }
    return this.isSimMode;
  }

  static setSimulated(enabled: boolean) {
    this.isSimMode = enabled;
    localStorage.setItem("indico_sim_wallet", enabled ? "true" : "false");
    this.simAccount = null;
  }

  static async getAccount(): Promise<string | null> {
    const hasEthereum = typeof window !== "undefined" && !!(window as any).ethereum;
    if (hasEthereum && !this.isSimMode) {
      try {
        const accounts = (await (window as any).ethereum.request({
          method: "eth_accounts",
        })) as string[];
        return accounts[0] ? (accounts[0].toLowerCase() as Address) : null;
      } catch {
        return null;
      }
    }

    if (this.isSimMode) {
      if (!this.simAccount) {
        this.simAccount = privateKeyToAccount(this.getSimPrivateKey());
      }
      return this.simAccount.address;
    }

    return null;
  }

  static async connect(forceBrowser = false): Promise<string> {
    const hasEthereum = typeof window !== "undefined" && !!(window as any).ethereum;

    // Prioritize real browser wallet whenever available
    if (hasEthereum && (forceBrowser || localStorage.getItem("indico_sim_wallet") !== "true")) {
      this.isSimMode = false;
      localStorage.setItem("indico_sim_wallet", "false");

      const accounts = (await (window as any).ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts authorized in browser wallet");
      }

      if (typeof window !== "undefined" && (window as any).ethereum?.on && !(window as any)._hasWalletListeners) {
        (window as any)._hasWalletListeners = true;
        (window as any).ethereum.on("accountsChanged", () => {
          window.location.reload();
        });
      }

      return accounts[0].toLowerCase();
    }

    if (this.isSimMode) {
      this.simAccount = privateKeyToAccount(this.getSimPrivateKey());
      return this.simAccount.address;
    }

    if (!hasEthereum) {
      this.setSimulated(true);
      this.simAccount = privateKeyToAccount(this.getSimPrivateKey());
      return this.simAccount.address;
    }

    const accounts = (await (window as any).ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    return accounts[0].toLowerCase();
  }

  static async signMessage(message: string): Promise<string> {
    const hasEthereum = typeof window !== "undefined" && !!(window as any).ethereum;

    if (!this.isSimMode && hasEthereum) {
      const account = await this.connect(true);
      const signature = await (window as any).ethereum.request({
        method: "personal_sign",
        params: [message, account],
      });
      return signature;
    }

    if (!this.simAccount) {
      this.simAccount = privateKeyToAccount(this.getSimPrivateKey());
    }
    return await this.simAccount.signMessage({ message });
  }

  static async ensureBaseSepolia(): Promise<void> {
    if (this.isSimMode || typeof window === "undefined" || !(window as any).ethereum) {
      return;
    }
    const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532 in hex
    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }],
      });
    } catch (switchError: any) {
      // 4902 indicates chain has not been added to MetaMask yet
      if (switchError.code === 4902 || switchError?.data?.originalError?.code === 4902) {
        await (window as any).ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: BASE_SEPOLIA_CHAIN_ID,
              chainName: "Base Sepolia",
              rpcUrls: ["https://sepolia.base.org"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: ["https://sepolia.basescan.org"],
            },
          ],
        });
      } else {
        console.warn("Network switch warning:", switchError);
      }
    }
  }

  static async sendPreparedTx(tx: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
    estimatedGasUnits?: string;
  }): Promise<string> {
    const hasEthereum = typeof window !== "undefined" && !!(window as any).ethereum;
    if (this.isSimMode && !hasEthereum) {
      // In simulation mode, generate a mock Base Sepolia transaction hash
      const randomHex = Array.from({ length: 64 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");
      return `0x${randomHex}`;
    }

    await this.ensureBaseSepolia();

    const from = await this.connect(true);

    // Determine gas limit from backend response (estimatedGasUnits or gasLimit)
    // Capped at 5,000,000 so it strictly stays under Base Sepolia's 16,777,216 max transaction gas limit
    const rawGas =
      tx.gasLimit ||
      tx.estimatedGasUnits ||
      (tx as any)?.transaction?.gasLimit ||
      (tx as any)?.transaction?.estimatedGasUnits;

    let gasHex: string | undefined = undefined;
    if (rawGas) {
      const gasBig = BigInt(rawGas);
      const safeGas = gasBig > 5_000_000n ? 5_000_000n : gasBig;
      gasHex = `0x${safeGas.toString(16)}`;
    } else {
      gasHex = "0x493e0"; // 300,000 gas fallback (well within Base Sepolia limits)
    }

    try {
      const hash = await (window as any).ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: tx.to,
            data: tx.data,
            value: tx.value ? `0x${BigInt(tx.value).toString(16)}` : "0x0",
            gas: gasHex,
          },
        ],
      });

      return hash;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes("AlreadySigned") || msg.includes("0xb0bd6aca")) {
        throw new Error("This wallet has already signed the current platform terms on-chain.");
      }
      if (msg.includes("exceeds max transaction gas limit")) {
        throw new Error("Transaction would revert on-chain or exceeds Base Sepolia gas limits. Check if terms are already signed.");
      }
      throw err;
    }
  }
}
