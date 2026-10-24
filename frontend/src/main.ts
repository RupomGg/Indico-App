/**
 * Indico Asset Ledger - Main Web Application Entry
 */

import "./style.css";
import { UserView } from "./views/userView.js";
import { AdminView } from "./views/adminView.js";
import { ChecklistView } from "./views/checklistView.js";
import { WalletManager } from "./wallet.js";
import { ApiClient } from "./api.js";
import { showToast, truncateAddress } from "./ui.js";

class App {
  private static viewContainer: HTMLElement;

  static async init() {
    this.renderShell();
    this.viewContainer = document.getElementById("view-container")!;
    this.bindEvents();
    this.checkBackendHealth();
    this.updateWalletUI();
    this.switchTab("checklist");
  }

  private static renderShell() {
    const isSimulated = WalletManager.isSimulated();

    document.getElementById("app")!.innerHTML = `
      <div class="app-container">
        <!-- Top Nav Bar -->
        <header class="top-nav">
          <div class="brand-wrapper">
            <div class="brand-logo-icon">I</div>
            <div class="brand-text">
              <h1>INDICO LEDGER</h1>
              <p>Asset RWA & Shared Liquidity Protocol</p>
            </div>
          </div>

          <!-- Main View Tabs -->
          <nav class="nav-tabs">
            <button id="nav-btn-checklist" class="tab-btn active">
              <span>✅</span> Feature Verifier
            </button>
            <button id="nav-btn-user" class="tab-btn">
              <span>👤</span> User Portal
            </button>
            <button id="nav-btn-admin" class="tab-btn">
              <span>🛡️</span> Admin Portal
            </button>
          </nav>

          <!-- System Status & Wallet Connection -->
          <div class="nav-actions">
            <!-- Backend Health Pill -->
            <div id="backend-health-pill" class="badge badge-neutral" style="cursor: pointer;" title="Fastify API on http://localhost:3000">
              <span id="health-dot" style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #94a3b8;"></span>
              <span id="health-text">API: Checking...</span>
            </div>

            <!-- Simulation Toggle -->
            <button id="btn-toggle-sim" class="btn btn-outline btn-sm" title="Toggle browser wallet vs in-memory simulated wallet">
              ${isSimulated ? "🧪 Wallet: Simulated" : "🦊 Wallet: Browser"}
            </button>

            <!-- Wallet Connect Button -->
            <button id="btn-main-wallet" class="btn btn-primary btn-sm">
              Connect Wallet
            </button>
          </div>
        </header>

        <!-- Main Dynamic View Container -->
        <main id="view-container"></main>
      </div>
    `;
  }

  private static bindEvents() {
    document.getElementById("nav-btn-checklist")?.addEventListener("click", () => this.switchTab("checklist"));
    document.getElementById("nav-btn-user")?.addEventListener("click", () => this.switchTab("user"));
    document.getElementById("nav-btn-admin")?.addEventListener("click", () => this.switchTab("admin"));

    document.getElementById("btn-toggle-sim")?.addEventListener("click", () => {
      const current = WalletManager.isSimulated();
      WalletManager.setSimulated(!current);
      showToast(
        !current
          ? "Switched to Simulated Wallet (Private key generated in-memory)"
          : "Switched to Browser Wallet (MetaMask / EIP-1193)",
        "info"
      );
      this.updateWalletUI();
      const simBtn = document.getElementById("btn-toggle-sim");
      if (simBtn) {
        simBtn.textContent = !current ? "🧪 Wallet: Simulated" : "🦊 Wallet: Browser";
      }
    });

    document.getElementById("btn-main-wallet")?.addEventListener("click", async () => {
      try {
        const address = await WalletManager.connect();
        showToast(`Wallet connected: ${truncateAddress(address)}`, "success");
        this.updateWalletUI();
      } catch (err: any) {
        showToast(err.message || "Failed to connect wallet", "error");
      }
    });

    document.getElementById("backend-health-pill")?.addEventListener("click", () => this.checkBackendHealth());
  }

  private static async checkBackendHealth() {
    const dot = document.getElementById("health-dot");
    const text = document.getElementById("health-text");
    try {
      const res = await ApiClient.checkHealth();
      if (res.status === "ok") {
        if (dot) dot.style.background = "#10b981";
        if (text) text.textContent = "API: Online";
      }
    } catch {
      if (dot) dot.style.background = "#ef4444";
      if (text) text.textContent = "API: Offline (Start backend on :3000)";
    }
  }

  private static async updateWalletUI() {
    const address = await WalletManager.getAccount();
    const btn = document.getElementById("btn-main-wallet");
    if (btn) {
      if (address) {
        btn.textContent = truncateAddress(address);
        btn.className = "btn btn-outline btn-sm";
      } else {
        btn.textContent = "Connect Wallet";
        btn.className = "btn btn-primary btn-sm";
      }
    }
  }

  static switchTab(tab: "user" | "admin" | "checklist") {
    const checklistBtn = document.getElementById("nav-btn-checklist");
    const userBtn = document.getElementById("nav-btn-user");
    const adminBtn = document.getElementById("nav-btn-admin");

    if (checklistBtn) checklistBtn.className = `tab-btn ${tab === "checklist" ? "active" : ""}`;
    if (userBtn) userBtn.className = `tab-btn ${tab === "user" ? "active" : ""}`;
    if (adminBtn) adminBtn.className = `tab-btn ${tab === "admin" ? "active" : ""}`;

    if (tab === "checklist") {
      ChecklistView.render(this.viewContainer);
    } else if (tab === "user") {
      UserView.render(this.viewContainer);
    } else {
      AdminView.render(this.viewContainer);
    }
  }
}

// Start Application on DOM Ready
window.addEventListener("DOMContentLoaded", () => {
  App.init();
});
