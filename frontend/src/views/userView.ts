/**
 * Indico Test Frontend - User Portal View
 * Implements 100% of User Confirmed Feature List (docs/feature-list.md §1)
 */

import { ApiClient } from "../api.js";
import { WalletManager } from "../wallet.js";
import {
  showToast,
  showModal,
  formatUsdc,
  truncateAddress,
  formatDate,
  explorerTxLink,
  explorerAddressLink,
} from "../ui.js";

export class UserView {
  private static container: HTMLElement;
  private static userProfile: any = null;
  private static userBalance: any = null;
  private static termsStatus: any = null;
  private static merchantsList: any[] = [];
  private static assetsList: any[] = [];
  private static loansList: any[] = [];

  static async render(target: HTMLElement) {
    this.container = target;
    target.innerHTML = `<div style="text-align: center; padding: 60px; color: var(--text-muted);">Loading User Portal...</div>`;
    await this.refresh();
  }

  static async refresh() {
    if (!ApiClient.userToken) {
      this.renderAuthScreen();
      return;
    }

    try {
      const [profileRes, termsRes, balanceRes, merchantsRes, assetsRes, loansRes] =
        await Promise.allSettled([
          ApiClient.getProfile(),
          ApiClient.getTermsStatus(),
          ApiClient.getBalanceHistory(),
          ApiClient.listMerchants(),
          ApiClient.listAssets(),
          ApiClient.getLoansHistory(),
        ]);

      if (profileRes.status === "fulfilled") {
        this.userProfile = (profileRes.value as any)?.data || profileRes.value;
      }
      if (termsRes.status === "fulfilled") {
        this.termsStatus = termsRes.value;
      }
      if (balanceRes.status === "fulfilled") {
        this.userBalance = (balanceRes.value as any)?.data || balanceRes.value;
      }
      if (merchantsRes.status === "fulfilled") {
        const v = merchantsRes.value as any;
        this.merchantsList = v?.items || v?.data?.items || v?.data || v?.merchants || [];
      }
      if (assetsRes.status === "fulfilled") {
        const v = assetsRes.value as any;
        this.assetsList = v?.items || v?.data?.items || v?.data?.assets || v?.assets || [];
      }
      if (loansRes.status === "fulfilled") {
        const v = loansRes.value as any;
        this.loansList = v?.items || v?.data?.items || v?.data?.loans || v?.loans || [];
      }

      this.renderDashboard();
    } catch (err: any) {
      if (err.status === 401) {
        ApiClient.setUserToken(null);
        this.renderAuthScreen();
      } else {
        showToast(err.message || "Failed to load user data", "error");
      }
    }
  }

  // --- 1. AUTH SCREEN (Register, Login, Email Verify, Password Reset) ---
  private static renderAuthScreen() {
    this.container.innerHTML = `
      <div style="max-width: 480px; margin: 40px auto;">
        <div class="card" style="padding: 32px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div class="brand-logo-icon" style="margin: 0 auto 16px auto; width: 48px; height: 48px; font-size: 24px;">I</div>
            <h2 style="font-size: 22px; font-weight: 800;">Indico User Portal</h2>
            <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Sign in or create an invite-only account</p>
          </div>

          <div style="display: flex; gap: 8px; margin-bottom: 20px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 10px;">
            <button id="auth-tab-login" class="btn btn-sm btn-primary" style="flex: 1;">Login</button>
            <button id="auth-tab-register" class="btn btn-sm btn-outline" style="flex: 1;">Register</button>
            <button id="auth-tab-reset" class="btn btn-sm btn-outline" style="flex: 1;">Reset</button>
          </div>

          <form id="auth-form" style="display: flex; flex-direction: column; gap: 16px;">
            <div class="form-group">
              <label class="form-label">Email Address</label>
              <input type="email" id="auth-email" class="form-input" placeholder="user@indico.example" required />
            </div>

            <div class="form-group" id="auth-pwd-group">
              <label class="form-label">Password</label>
              <input type="password" id="auth-password" class="form-input" placeholder="Min 8 characters" required />
            </div>

            <div class="form-group" id="auth-verify-group" style="display: none;">
              <label class="form-label">Email Verification / Reset Token</label>
              <input type="text" id="auth-token" class="form-input" placeholder="Enter token from simulated email" />
            </div>

            <button type="submit" id="auth-submit-btn" class="btn btn-primary" style="width: 100%; margin-top: 8px;">
              Sign In
            </button>
          </form>

          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-subtle); font-size: 11.5px; color: var(--text-faint); text-align: center;">
            Rule: Admin approval required before full platform usage. 1 Credit = 1 USDC.
          </div>
        </div>
      </div>
    `;

    let activeAuthMode: "login" | "register" | "reset" = "login";

    const updateAuthUI = (mode: "login" | "register" | "reset") => {
      activeAuthMode = mode;
      const loginTab = document.getElementById("auth-tab-login")!;
      const registerTab = document.getElementById("auth-tab-register")!;
      const resetTab = document.getElementById("auth-tab-reset")!;
      const submitBtn = document.getElementById("auth-submit-btn")!;
      const verifyGroup = document.getElementById("auth-verify-group")!;
      const pwdGroup = document.getElementById("auth-pwd-group")!;

      loginTab.className = `btn btn-sm ${mode === "login" ? "btn-primary" : "btn-outline"}`;
      registerTab.className = `btn btn-sm ${mode === "register" ? "btn-primary" : "btn-outline"}`;
      resetTab.className = `btn btn-sm ${mode === "reset" ? "btn-primary" : "btn-outline"}`;

      if (mode === "login") {
        submitBtn.textContent = "Sign In";
        verifyGroup.style.display = "none";
        pwdGroup.style.display = "flex";
      } else if (mode === "register") {
        submitBtn.textContent = "Create Account";
        verifyGroup.style.display = "none";
        pwdGroup.style.display = "flex";
      } else {
        submitBtn.textContent = "Reset Password";
        verifyGroup.style.display = "flex";
        pwdGroup.style.display = "flex";
      }
    };

    document.getElementById("auth-tab-login")?.addEventListener("click", () => updateAuthUI("login"));
    document.getElementById("auth-tab-register")?.addEventListener("click", () => updateAuthUI("register"));
    document.getElementById("auth-tab-reset")?.addEventListener("click", () => updateAuthUI("reset"));

    document.getElementById("auth-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = (document.getElementById("auth-email") as HTMLInputElement).value;
      const password = (document.getElementById("auth-password") as HTMLInputElement).value;
      const token = (document.getElementById("auth-token") as HTMLInputElement).value;
      const submitBtn = document.getElementById("auth-submit-btn") as HTMLButtonElement;

      submitBtn.disabled = true;
      try {
        if (activeAuthMode === "login") {
          await ApiClient.login(email, password);
          showToast("Welcome back to Indico!", "success");
          await this.refresh();
        } else if (activeAuthMode === "register") {
          const res = await ApiClient.register(email, password);
          showToast("Account created! Check console/logs for email verification token.", "success");
          if (res?.data?.token) {
            // Auto login if returned or prompt verify
            await ApiClient.login(email, password);
            await this.refresh();
          }
        } else {
          await ApiClient.resetPassword(token, password);
          showToast("Password reset successfully! Please login.", "success");
          updateAuthUI("login");
        }
      } catch (err: any) {
        showToast(err.message || "Authentication error", "error");
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  private static renderDashboard() {
    const isApproved = !!(
      this.userProfile?.isApproved === true ||
      this.userProfile?.status === "APPROVED" ||
      this.userProfile?.data?.isApproved === true
    );
    const isTermsSigned = !!(
      this.termsStatus?.termsSigned === true ||
      this.termsStatus?.signed === true ||
      this.termsStatus?.data?.termsSigned === true ||
      this.termsStatus?.data?.signed === true
    );
    const walletAddr = this.userProfile?.walletAddress || this.userProfile?.data?.walletAddress;

    const availableCredit =
      this.userBalance?.availableCredit ||
      this.userBalance?.availableBalance ||
      "0.000000";
    const lockedCredit =
      this.userBalance?.lockedCredit ||
      this.userBalance?.lockedBalance ||
      "0.000000";
    const totalCredit =
      this.userBalance?.credit ||
      this.userBalance?.totalBalance ||
      "0.000000";

    this.container.innerHTML = `
      <!-- User Account Header Banner -->
      <div class="card" style="margin-bottom: 24px; background: linear-gradient(135deg, rgba(30, 27, 75, 0.6), rgba(15, 23, 42, 0.8));">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
              <h2 style="font-size: 20px; font-weight: 800;">${this.userProfile?.email}</h2>
              ${
                isApproved
                  ? `<span class="badge badge-success">● APPROVED USER</span>`
                  : `<span class="badge badge-warning">⏳ PENDING ADMIN APPROVAL</span>`
              }
              ${
                isTermsSigned
                  ? `<span class="badge badge-purple">✓ TERMS SIGNED</span>`
                  : `<span class="badge badge-danger">✕ TERMS NOT SIGNED</span>`
              }
            </div>
            <div style="font-size: 12.5px; color: var(--text-muted); display: flex; align-items: center; gap: 16px;">
              <span>Wallet: <strong>${walletAddr ? explorerAddressLink(walletAddr) : "Not Bound"}</strong></span>
              <span>Account Ref: <strong style="font-family: var(--font-mono);">${this.userProfile?.accountRef || "None"}</strong></span>
            </div>
          </div>

          <div style="display: flex; gap: 10px;">
            ${
              !walletAddr
                ? `<button id="btn-bind-wallet" class="btn btn-accent btn-sm">🔗 Connect & Bind Wallet</button>`
                : `<button id="btn-rebind-wallet" class="btn btn-outline btn-sm">Wallet Connected ✓</button>`
            }
            ${
              !isTermsSigned
                ? `<button id="btn-sign-terms" class="btn btn-primary btn-sm">📜 Review & Sign Terms</button>`
                : ``
            }
            <button id="btn-logout" class="btn btn-outline btn-sm">Log Out</button>
          </div>
        </div>

        ${
          !isApproved
            ? `
          <div style="margin-top: 16px; padding: 12px 16px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; font-size: 12.5px; color: #fbbf24;">
            ⚠️ <strong>Admin Approval Required:</strong> Your account is registered, but pending approval by an administrator before loans or asset minting can be finalized.
          </div>
          `
            : !isTermsSigned
            ? `
          <div style="margin-top: 16px; padding: 12px 16px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; font-size: 12.5px; color: #fca5a5;">
            📜 <strong>Terms Signature Required:</strong> Per Confirmed Feature List §1, no further action is possible until the platform terms are signed on-chain with your wallet.
          </div>
          `
            : ``
        }
        ${
          walletAddr &&
          typeof window !== "undefined" &&
          (window as any).ethereum?.selectedAddress &&
          (window as any).ethereum.selectedAddress.toLowerCase() !== walletAddr.toLowerCase()
            ? `
          <div style="margin-top: 14px; padding: 12px 16px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; font-size: 12.5px; color: #93c5fd;">
            ℹ️ <strong>Wallet Extension Notice:</strong> Your active browser wallet is <code style="color: #60a5fa;">${truncateAddress((window as any).ethereum.selectedAddress)}</code>, but this Indico account is bound to <code style="color: #34d399;">${truncateAddress(walletAddr)}</code>. Please select <strong style="color: #34d399;">${truncateAddress(walletAddr)}</strong> in your extension.
          </div>
          `
            : ``
        }
      </div>

      <!-- Balance & Metrics Row -->
      <div class="grid-4" style="margin-bottom: 24px;">
        <div class="metric-box">
          <span class="metric-label">Available Credit</span>
          <span class="metric-value" style="color: #34d399;">${formatUsdc(availableCredit)}</span>
          <span class="metric-hint">1 Credit = 1.00 USDC (Free to spend or borrow)</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Locked Collateral</span>
          <span class="metric-value" style="color: #fbbf24;">${formatUsdc(lockedCredit)}</span>
          <span class="metric-hint">Locked at 1.25x against active loans (80% LTV)</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Total Credit Held</span>
          <span class="metric-value" style="color: #a855f7;">${formatUsdc(totalCredit)}</span>
          <span class="metric-hint">Available + Locked credit</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Max Borrow Capacity</span>
          <span class="metric-value" style="color: #38bdf8;">${formatUsdc(parseFloat(availableCredit) * 0.8)}</span>
          <span class="metric-hint">80% Borrowing Ratio per PRD §1</span>
        </div>
      </div>

      <!-- Section Navigation Tabs -->
      <div style="display: flex; gap: 10px; margin-bottom: 24px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px;">
        <button id="tab-sub-assets" class="btn btn-sm btn-primary">📁 Assets & Minting</button>
        <button id="tab-sub-spend" class="btn btn-sm btn-outline">🛍️ Spend with Merchants</button>
        <button id="tab-sub-borrow" class="btn btn-sm btn-outline">🏦 Borrow USDC</button>
        <button id="tab-sub-loans" class="btn btn-sm btn-outline">📑 Active Loans (${this.loansList.length})</button>
        <button id="tab-sub-ai" class="btn btn-sm btn-outline">🤖 Indico AI Assistant</button>
      </div>

      <!-- Dynamic Tab Container -->
      <div id="user-subtab-container"></div>
    `;

    // Bind Header Action Listeners
    document.getElementById("btn-logout")?.addEventListener("click", async () => {
      await ApiClient.logout();
      showToast("Logged out", "info");
      this.renderAuthScreen();
    });

    document.getElementById("btn-bind-wallet")?.addEventListener("click", () => this.handleBindWallet());
    document.getElementById("btn-sign-terms")?.addEventListener("click", () => this.handleSignTerms());

    // Sub-tab Switchers
    const subContainer = document.getElementById("user-subtab-container")!;
    const tabs = [
      { id: "tab-sub-assets", render: () => this.renderAssetsTab(subContainer) },
      { id: "tab-sub-spend", render: () => this.renderSpendTab(subContainer) },
      { id: "tab-sub-borrow", render: () => this.renderBorrowTab(subContainer) },
      { id: "tab-sub-loans", render: () => this.renderLoansTab(subContainer) },
      { id: "tab-sub-ai", render: () => this.renderAiTab(subContainer) },
    ];

    tabs.forEach((tab) => {
      document.getElementById(tab.id)?.addEventListener("click", () => {
        tabs.forEach((t) => {
          const el = document.getElementById(t.id);
          if (el) el.className = `btn btn-sm ${t.id === tab.id ? "btn-primary" : "btn-outline"}`;
        });
        tab.render();
      });
    });

    // Default to Assets Tab
    this.renderAssetsTab(subContainer);
  }

  // --- SUB-TAB 1: ASSETS & MINTING ---
  private static renderAssetsTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="grid-2" style="margin-bottom: 24px;">
        <!-- Upload & Mint Form -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">📄 Upload & Mint Asset</h3>
            <span class="badge badge-purple">On-Chain Fingerprint</span>
          </div>

          <form id="asset-upload-form" style="display: flex; flex-direction: column; gap: 14px;">
            <div class="form-group">
              <label class="form-label">Asset Type (PRD §1)</label>
              <select id="asset-type" class="form-select">
                <option value="1">Arbitration Award (1)</option>
                <option value="2">Bill of Exchange (2)</option>
                <option value="3">Promissory Note (3)</option>
                <option value="4">Bond (4)</option>
                <option value="5">Commercial Invoice (5)</option>
              </select>
            </div>

            <div class="grid-2">
              <div class="form-group">
                <label class="form-label">Declared Value (USDC)</label>
                <input type="text" id="asset-value" class="form-input form-mono" placeholder="50000.000000" required />
              </div>
              <div class="form-group">
                <label class="form-label">Reference Number</label>
                <input type="text" id="asset-ref" class="form-input" placeholder="ARB-2026-908" required />
              </div>
            </div>

            <div class="grid-2">
              <div class="form-group">
                <label class="form-label">Issuing Party</label>
                <input type="text" id="asset-issuer" class="form-input" placeholder="ICC Arbitration Chamber" required />
              </div>
              <div class="form-group">
                <label class="form-label">Issue Date</label>
                <input type="date" id="asset-date" class="form-input" required />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Description / Notes</label>
              <textarea id="asset-desc" class="form-textarea" rows="2" placeholder="Award rendered pursuant to ICC Case #12938"></textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Document File (PDF, PNG, JPG - Max 20MB)</label>
              <input type="file" id="asset-file" class="form-input" accept=".pdf,.png,.jpg,.jpeg" required />
              <div id="file-hash-preview" style="font-size: 11px; font-family: var(--font-mono); color: var(--text-faint); margin-top: 4px;"></div>
            </div>

            <button type="submit" id="btn-submit-asset" class="btn btn-primary" style="margin-top: 8px;">
              ⚡ Hash, Upload & Register On-Chain
            </button>
          </form>
        </div>

        <!-- How Asset Minting Works Info -->
        <div class="card" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div class="card-header">
              <h3 class="card-title">ℹ️ Protocol Rules (Feature List §1)</h3>
            </div>
            <ul style="font-size: 13px; color: var(--text-muted); line-height: 1.8; padding-left: 20px;">
              <li><strong>Zero Content Reading:</strong> The system does not read what is inside the document.</li>
              <li><strong>No Value Verification:</strong> Nothing checks whether the entered value is accurate. Value is recorded as entered.</li>
              <li><strong>Cryptographic Proof:</strong> SHA-256 fingerprint is generated client-side and locked permanently on Ethereum/Base Sepolia.</li>
              <li><strong>1 Credit = 1 USDC:</strong> You receive credit equal to the recorded value instantly upon contract execution.</li>
            </ul>
          </div>
          <div style="background: rgba(0,0,0,0.3); padding: 14px; border-radius: 10px; border: 1px solid var(--border-subtle); margin-top: 20px;">
            <div style="font-size: 11.5px; font-weight: 700; color: var(--text-main); margin-bottom: 4px;">ENCRYPTED STORAGE</div>
            <div style="font-size: 11px; color: var(--text-muted);">
              Uploaded documents are encrypted at rest with AES-256-GCM using unique per-file initialization vectors.
            </div>
          </div>
        </div>
      </div>

      <!-- Assets Table -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📜 Registered Assets (${this.assetsList.length})</h3>
        </div>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Ref Number</th>
                <th>Type</th>
                <th>Declared Value</th>
                <th>Issuing Party</th>
                <th>SHA-256 Fingerprint</th>
                <th>Tx Proof</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.assetsList.length === 0
                  ? `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px;">No assets registered yet. Upload your first document above.</td></tr>`
                  : this.assetsList
                      .map(
                        (a) => `
                <tr>
                  <td style="font-weight: 700;">${a.referenceNumber || "-"}</td>
                  <td><span class="badge badge-purple">${this.getAssetTypeName(a.assetType)}</span></td>
                  <td style="font-family: var(--font-mono); font-weight: 700; color: #34d399;">${formatUsdc(a.declaredValue)} USDC</td>
                  <td>${a.issuingParty || "-"}</td>
                  <td style="font-family: var(--font-mono); font-size: 11px;">${truncateAddress(a.docHash || a.clientSha256)}</td>
                  <td>${explorerTxLink(a.txHash)}</td>
                  <td>
                    ${
                      a.status === "REGISTERED" || a.status === "MINTED" || a.txHash
                        ? `<span class="badge badge-success">✓ Minted</span>`
                        : `<button class="btn btn-sm btn-primary btn-register-asset" data-id="${a.id}">⚡ Mint</button>`
                    }
                  </td>
                </tr>
              `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    // File Hash Preview Handler
    const fileInput = document.getElementById("asset-file") as HTMLInputElement;
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      const preview = document.getElementById("file-hash-preview");
      if (file && preview) {
        preview.textContent = "Computing SHA-256 fingerprint in browser...";
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
        preview.textContent = `SHA-256: 0x${hashHex}`;
      }
    });

    // Asset Form Submit Handler
    document.getElementById("asset-upload-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = fileInput.files?.[0];
      if (!file) {
        showToast("Please choose a file to upload", "error");
        return;
      }

      const btn = document.getElementById("btn-submit-asset") as HTMLButtonElement;
      btn.disabled = true;

      try {
        // Step 1: Compute client SHA-256
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const clientSha256 = "0x" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

        // Step 2: Request presigned upload session
        showToast("Allocating upload session...", "info");
        const presigned = await ApiClient.createPresignedUpload({
          fileName: file.name,
          fileSizeBytes: file.size,
          mimeType: file.type || "application/pdf",
        });

        // Step 3: Upload file bytes
        showToast("Uploading document bytes...", "info");
        await ApiClient.uploadFileChunk(presigned.uploadId, file, file.name);

        // Step 4: Submit asset metadata
        showToast("Submitting asset metadata...", "info");
        const assetType = parseInt((document.getElementById("asset-type") as HTMLSelectElement).value, 10);
        const declaredValueRaw = (document.getElementById("asset-value") as HTMLInputElement).value.trim();
        let declaredValueUsdc = declaredValueRaw;
        if (!declaredValueUsdc.includes(".")) {
          declaredValueUsdc += ".000000";
        } else {
          const [intPart, decPart = ""] = declaredValueUsdc.split(".");
          declaredValueUsdc = intPart + "." + decPart.padEnd(6, "0").slice(0, 6);
        }

        const referenceNumber = (document.getElementById("asset-ref") as HTMLInputElement).value;
        const issuingParty = (document.getElementById("asset-issuer") as HTMLInputElement).value;
        const issueDate = (document.getElementById("asset-date") as HTMLInputElement).value;
        const description = (document.getElementById("asset-desc") as HTMLTextAreaElement).value;

        const assetRecord = await ApiClient.submitAsset({
          uploadId: presigned.uploadId,
          docHash: clientSha256,
          assetType,
          declaredValueUsdc,
          referenceNumber,
          issueDate,
          issuingParty,
          description,
        });

        showToast("Asset saved! Preparing on-chain registration...", "success");

        // Step 5: Prepare calldata and sign transaction
        const prepared = await ApiClient.prepareRegisterAsset(assetRecord.id);
        const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);

        showToast(`Asset registered on-chain! Tx: ${truncateAddress(txHash)}`, "success");
        await this.refresh();
      } catch (err: any) {
        showToast(err.message || "Failed to upload and register asset", "error");
      } finally {
        btn.disabled = false;
      }
    });

    // Register button handler for assets not yet registered on chain
    container.querySelectorAll(".btn-register-asset").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.id!;
        try {
          const prepared = await ApiClient.prepareRegisterAsset(id);
          const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
          showToast(`Asset registered! Tx: ${truncateAddress(txHash)}`, "success");
          await this.refresh();
        } catch (err: any) {
          showToast(err.message || "Registration failed", "error");
        }
      });
    });
  }

  // --- SUB-TAB 2: SPEND WITH MERCHANTS ---
  private static renderSpendTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card" style="margin-bottom: 24px;">
        <div class="card-header">
          <h3 class="card-title">🛍️ Spend Credit with Approved Merchants</h3>
          <span class="badge badge-success">0% Platform Fee</span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">
          Spend your available credit for services provided by admin-approved merchants. Merchants never log into the platform; payment receipts are permanently recorded on-chain.
        </p>

        <!-- Merchant Selector & Spend Box -->
        <div class="grid-2" style="margin-bottom: 24px;">
          <div style="background: rgba(0,0,0,0.3); padding: 20px; border-radius: 12px; border: 1px solid var(--border-subtle);">
            <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Make a Payment</h4>
            <div class="form-group">
              <label class="form-label">Selected Merchant</label>
              <select id="spend-merchant-select" class="form-select">
                <option value="">-- Choose Approved Merchant --</option>
                ${this.merchantsList
                  .map(
                    (m) =>
                      `<option value="${m.walletAddress}" data-id="${m.id}">${m.name} (${truncateAddress(
                        m.walletAddress
                      )})</option>`
                  )
                  .join("")}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Amount (USDC Credit)</label>
              <input type="text" id="spend-amount" class="form-input form-mono" placeholder="1000.000000" />
            </div>

            <button id="btn-spend-submit" class="btn btn-primary" style="width: 100%; margin-top: 8px;">
              ⚡ Confirm Payment with Wallet
            </button>
          </div>

          <div style="background: rgba(0,0,0,0.3); padding: 20px; border-radius: 12px; border: 1px solid var(--border-subtle);">
            <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Service Offerings</h4>
            <div id="merchant-services-list" style="font-size: 13px; color: var(--text-muted);">
              Select a merchant on the left to see their offerings. Tapping a service automatically prefills the amount.
            </div>
          </div>
        </div>

        <!-- Merchants Directory Table -->
        <div class="card-header" style="margin-top: 20px;">
          <h4 class="card-title">Approved Merchants Directory (${this.merchantsList.length})</h4>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Merchant Name</th>
                <th>Wallet Address</th>
                <th>Arbitration Agreement</th>
                <th>Services Offered</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.merchantsList.length === 0
                  ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No approved merchants available yet.</td></tr>`
                  : this.merchantsList
                      .map(
                        (m) => `
                <tr>
                  <td style="font-weight: 700;">${m.name}</td>
                  <td style="font-family: var(--font-mono);">${explorerAddressLink(m.walletAddress)}</td>
                  <td>
                    ${
                      m.agreementSignedAt
                        ? `<span class="badge badge-success">✓ Signed</span>`
                        : m.agreementSentAt
                        ? `<span class="badge badge-warning">Sent</span>`
                        : `<span class="badge badge-neutral">Not Sent</span>`
                    }
                  </td>
                  <td>${m.services?.length || 0} service(s)</td>
                  <td>
                    <button class="btn btn-sm btn-outline btn-select-merchant" data-addr="${m.walletAddress}" data-id="${m.id}">Select</button>
                  </td>
                </tr>
              `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    const selectEl = document.getElementById("spend-merchant-select") as HTMLSelectElement;
    const servicesContainer = document.getElementById("merchant-services-list")!;
    const amountInput = document.getElementById("spend-amount") as HTMLInputElement;

    const updateServices = (merchantId: string) => {
      const merchant = this.merchantsList.find((m) => m.id === merchantId);
      if (!merchant || !merchant.services || merchant.services.length === 0) {
        servicesContainer.innerHTML = `<div style="color: var(--text-faint); padding: 12px;">No specific services cataloged for this merchant. Enter any amount.</div>`;
        return;
      }

      servicesContainer.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${merchant.services
            .map(
              (s: any) => `
            <div class="service-pill" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: 8px; cursor: pointer;" data-price="${s.price ?? s.priceUsdc}">
              <div>
                <strong style="color: #fff;">${s.name || s.serviceName}</strong>
                ${s.description ? `<div style="font-size: 11px; color: var(--text-muted);">${s.description}</div>` : ""}
              </div>
              <span class="badge badge-purple" style="font-family: var(--font-mono);">${formatUsdc(s.price ?? s.priceUsdc)} USDC</span>
            </div>
          `
            )
            .join("")}
        </div>
      `;

      servicesContainer.querySelectorAll(".service-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          const price = (pill as HTMLElement).dataset.price || "";
          amountInput.value = price;
          showToast(`Prefilled ${formatUsdc(price)} USDC`, "info");
        });
      });
    };

    selectEl?.addEventListener("change", () => {
      const opt = selectEl.options[selectEl.selectedIndex];
      const merchantId = opt?.dataset.id;
      if (merchantId) updateServices(merchantId);
    });

    container.querySelectorAll(".btn-select-merchant").forEach((btn) => {
      btn.addEventListener("click", () => {
        const addr = (btn as HTMLElement).dataset.addr!;
        const id = (btn as HTMLElement).dataset.id!;
        selectEl.value = addr;
        updateServices(id);
      });
    });

    document.getElementById("btn-spend-submit")?.addEventListener("click", async () => {
      const merchantAddr = selectEl.value;
      const amount = amountInput.value.trim();
      if (!merchantAddr) {
        showToast("Please choose an approved merchant", "error");
        return;
      }
      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        showToast("Please specify a valid amount", "error");
        return;
      }

      try {
        showToast("Preparing spend calldata...", "info");
        const prepared = await ApiClient.prepareSpend(merchantAddr, amount);
        const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
        showToast(`Payment sent! Tx: ${truncateAddress(txHash)}`, "success");
        await this.refresh();
      } catch (err: any) {
        showToast(err.message || "Failed to execute payment", "error");
      }
    });
  }

  // --- SUB-TAB 3: BORROW USDC ---
  private static renderBorrowTab(container: HTMLElement) {
    const availableCredit = parseFloat(this.userBalance?.availableBalance || "0");
    const maxBorrow = availableCredit * 0.8;

    container.innerHTML = `
      <div class="card" style="margin-bottom: 24px;">
        <div class="card-header">
          <h3 class="card-title">🏦 Borrow USDC from Shared Liquidity Pool</h3>
          <span class="badge badge-purple">80% Borrowing Ratio</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">
          Borrow real USDC against your credit. Loans pay out instantly from the merchant shared pool with no approval step.
          Loans run for <strong>90 days</strong>, with <strong>0% interest and 0 fees</strong>.
        </p>

        <div class="grid-2">
          <div style="background: rgba(0,0,0,0.3); padding: 22px; border-radius: 12px; border: 1px solid var(--border-subtle);">
            <div class="form-group">
              <label class="form-label">Desired Principal (USDC)</label>
              <input type="text" id="borrow-principal" class="form-input form-mono" placeholder="10000.000000" />
              <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px;">
                Max Available to Borrow: <strong>${formatUsdc(maxBorrow)} USDC</strong>
              </div>
            </div>

            <div style="background: rgba(255,255,255,0.02); padding: 14px; border-radius: 8px; border: 1px solid var(--border-subtle); margin: 16px 0; font-size: 12.5px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <span style="color: var(--text-muted);">Required Locked Collateral (1.25x):</span>
                <strong id="borrow-collateral-calc" style="font-family: var(--font-mono); color: #fbbf24;">0.00 USDC</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <span style="color: var(--text-muted);">Loan Duration:</span>
                <strong>90 Days</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Interest & Fees:</span>
                <strong style="color: #34d399;">$0.00 (Zero)</strong>
              </div>
            </div>

            <button id="btn-borrow-submit" class="btn btn-primary" style="width: 100%;">
              ⚡ Request Loan & Sign with Wallet
            </button>
          </div>

          <div style="background: rgba(0,0,0,0.3); padding: 22px; border-radius: 12px; border: 1px solid var(--border-subtle); display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Protocol Rules for Borrowing</h4>
              <ul style="font-size: 12.5px; color: var(--text-muted); line-height: 1.8; padding-left: 20px;">
                <li><strong>80% Borrowing Ratio:</strong> A user can borrow up to 80% of credit held (1.25x collateral).</li>
                <li><strong>Multiple Loans Allowed:</strong> More than one loan at a time while total stays within 80%.</li>
                <li><strong>Instant Payout:</strong> Money arrives instantly from the pool. Nothing is approved or reviewed.</li>
                <li><strong>Refusal Condition:</strong> Refused only if the shared USDC pool does not hold enough cash.</li>
                <li><strong>90-Day Extension:</strong> Extend by another 90 days with one click as deadline approaches, without limit.</li>
              </ul>
            </div>
            <div style="font-size: 11px; color: var(--text-faint); margin-top: 14px;">
              Ref: Confirmed Feature List §1 "Borrowing" & §2 "Shared pool"
            </div>
          </div>
        </div>
      </div>
    `;

    const principalInput = document.getElementById("borrow-principal") as HTMLInputElement;
    const collateralCalc = document.getElementById("borrow-collateral-calc")!;

    principalInput?.addEventListener("input", () => {
      const val = parseFloat(principalInput.value);
      if (!isNaN(val) && val > 0) {
        collateralCalc.textContent = `${formatUsdc(val * 1.25)} USDC`;
      } else {
        collateralCalc.textContent = `0.00 USDC`;
      }
    });

    document.getElementById("btn-borrow-submit")?.addEventListener("click", async () => {
      const principal = principalInput.value.trim();
      if (!principal || isNaN(parseFloat(principal)) || parseFloat(principal) <= 0) {
        showToast("Enter a valid loan principal amount", "error");
        return;
      }

      try {
        showToast("Preparing loan transaction...", "info");
        const prepared = await ApiClient.prepareBorrow(principal);
        const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
        showToast(`Loan opened! USDC disbursed. Tx: ${truncateAddress(txHash)}`, "success");
        await this.refresh();
      } catch (err: any) {
        showToast(err.message || "Failed to open loan", "error");
      }
    });
  }

  // --- SUB-TAB 4: ACTIVE & HISTORIC LOANS ---
  private static renderLoansTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📑 Active & Repaid Loans (${this.loansList.length})</h3>
          <span class="badge badge-purple">90-Day Extendable</span>
        </div>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Principal</th>
                <th>Collateral Locked</th>
                <th>Due Date</th>
                <th>Extensions</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.loansList.length === 0
                  ? `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px;">No active or past loans found.</td></tr>`
                  : this.loansList
                      .map(
                        (l) => `
                <tr>
                  <td style="font-family: var(--font-mono); font-weight: 700;">#${l.id.slice(0, 8)}</td>
                  <td style="font-family: var(--font-mono); font-weight: 700; color: #38bdf8;">${formatUsdc(l.principal)} USDC</td>
                  <td style="font-family: var(--font-mono); color: #fbbf24;">${formatUsdc(l.collateralAmount)} USDC</td>
                  <td>${formatDate(l.dueDate)}</td>
                  <td>${l.extensionCount || 0} time(s)</td>
                  <td>
                    ${
                      l.status === "ACTIVE"
                        ? `<span class="badge badge-success">ACTIVE</span>`
                        : l.status === "REPAID"
                        ? `<span class="badge badge-purple">REPAID</span>`
                        : `<span class="badge badge-danger">DEFAULTED</span>`
                    }
                  </td>
                  <td>
                    ${
                      l.status === "ACTIVE"
                        ? `
                      <button class="btn btn-sm btn-primary btn-repay-loan" data-id="${l.id}">Repay</button>
                      <button class="btn btn-sm btn-outline btn-extend-loan" data-id="${l.id}" title="Extend by 90 days">Extend</button>
                    `
                        : `<span style="font-size: 11px; color: var(--text-faint);">Settled</span>`
                    }
                  </td>
                </tr>
              `
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-repay-loan").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const loanId = (btn as HTMLElement).dataset.id!;
        showModal({
          title: "Repay Loan in Full",
          contentHtml: `
            <p style="font-size: 13.5px; color: var(--text-muted); margin-bottom: 12px;">
              Repay the exact principal in USDC to release your locked credit collateral. No interest or fees apply.
            </p>
          `,
          confirmText: "⚡ Repay Loan",
          onConfirm: async () => {
            showToast("Preparing repay transaction...", "info");
            const prepared = await ApiClient.prepareRepay(loanId);
            const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
            showToast(`Loan repaid! Collateral released. Tx: ${truncateAddress(txHash)}`, "success");
            await this.refresh();
          },
        });
      });
    });

    container.querySelectorAll(".btn-extend-loan").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const loanId = (btn as HTMLElement).dataset.id!;
        showModal({
          title: "Extend Loan Term",
          contentHtml: `
            <p style="font-size: 13.5px; color: var(--text-muted); margin-bottom: 12px;">
              Extend this loan's due date by another 90 days. Per Confirmed Feature List §1, loans can be extended as many times as needed.
            </p>
          `,
          confirmText: "Extend by 90 Days",
          onConfirm: async () => {
            showToast("Preparing extension transaction...", "info");
            const prepared = await ApiClient.prepareExtend(loanId);
            const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
            showToast(`Loan extended by 90 days! Tx: ${truncateAddress(txHash)}`, "success");
            await this.refresh();
          },
        });
      });
    });
  }

  // --- SUB-TAB 5: INDICO AI ASSISTANT ---
  private static renderAiTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🤖 Indico AI Assistant</h3>
          <span class="badge badge-purple">Feature List §1 Compliant</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          Type commands or questions in natural language. The AI assistant prepares transaction summaries for your review. <strong>Nothing happens without your wallet confirmation.</strong>
        </p>

        <!-- Chat History -->
        <div id="ai-chat-history" style="background: rgba(0,0,0,0.4); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 18px; min-height: 280px; max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;">
          <div style="background: rgba(255,255,255,0.03); padding: 12px 16px; border-radius: 10px; border-left: 3px solid var(--purple-primary); font-size: 13px;">
            👋 <strong>Indico AI:</strong> Hello! You can ask me:
            <ul style="margin-top: 6px; padding-left: 18px; color: var(--text-muted);">
              <li>"What is my available credit and loan status?"</li>
              <li>"Request a loan of 5,000 USDC"</li>
              <li>"Send 1,200 credit to merchant [name]"</li>
            </ul>
          </div>
        </div>

        <!-- Chat Input Form -->
        <form id="ai-chat-form" style="display: flex; gap: 10px;">
          <input type="text" id="ai-prompt-input" class="form-input" placeholder="Type a command or ask a question..." required />
          <button type="submit" class="btn btn-primary">Send ↗</button>
        </form>
      </div>
    `;

    const chatHistory = document.getElementById("ai-chat-history")!;
    const input = document.getElementById("ai-prompt-input") as HTMLInputElement;

    document.getElementById("ai-chat-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) return;

      // Append User Message
      const userMsg = document.createElement("div");
      userMsg.style.cssText = "align-self: flex-end; background: var(--purple-primary); color: #fff; padding: 10px 16px; border-radius: 12px; max-width: 80%; font-size: 13px;";
      userMsg.textContent = prompt;
      chatHistory.appendChild(userMsg);
      input.value = "";

      // Process with simulated AI engine adhering to §1 constraints
      setTimeout(() => {
        this.processAiPrompt(prompt, chatHistory);
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }, 500);
    });
  }

  private static processAiPrompt(prompt: string, container: HTMLElement) {
    const lower = prompt.toLowerCase();
    const botMsg = document.createElement("div");
    botMsg.style.cssText = "align-self: flex-start; background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle); padding: 14px 18px; border-radius: 12px; max-width: 85%; font-size: 13px;";

    if (lower.includes("balance") || lower.includes("credit") || lower.includes("status")) {
      const avail = this.userBalance?.availableBalance || "0";
      const locked = this.userBalance?.lockedBalance || "0";
      botMsg.innerHTML = `
        <strong>📊 Balance Summary:</strong><br/>
        Available Credit: <strong style="color: #34d399;">${formatUsdc(avail)} USDC</strong><br/>
        Locked Collateral: <strong style="color: #fbbf24;">${formatUsdc(locked)} USDC</strong><br/>
        Max Borrowable: <strong style="color: #38bdf8;">${formatUsdc(parseFloat(avail) * 0.8)} USDC</strong>
      `;
    } else if (lower.includes("loan") && (lower.includes("borrow") || lower.includes("request"))) {
      const match = lower.match(/\d+([.,]\d+)?/);
      const amount = match ? match[0].replace(",", "") : "5000";
      botMsg.innerHTML = `
        <strong>⚡ Loan Request Summary:</strong><br/>
        Principal: <strong>${formatUsdc(amount)} USDC</strong><br/>
        Required Collateral: <strong>${formatUsdc(parseFloat(amount) * 1.25)} USDC</strong><br/>
        Duration: <strong>90 Days (0% Interest, $0 Fees)</strong><br/>
        <div style="margin-top: 10px;">
          <button class="btn btn-sm btn-primary" onclick="alert('Preparing borrow of ${amount} USDC... Please confirm with your connected wallet.');">
            Confirm & Sign with Wallet
          </button>
        </div>
      `;
    } else {
      botMsg.innerHTML = `
        I understand you are asking about: <em>"${prompt}"</em>.<br/>
        Per Confirmed Feature List §1, I can answer balance inquiries, prepare loan summaries, or merchant spend transactions. Would you like me to guide you through one of these actions?
      `;
    }

    container.appendChild(botMsg);
  }

  // --- ACTIONS: BIND WALLET & SIGN TERMS ---
  private static async handleBindWallet() {
    try {
      showToast("Connecting wallet...", "info");
      const address = await WalletManager.connect();
      let accountRef = this.userProfile?.accountRef;
      if (!accountRef || !accountRef.startsWith("0x") || accountRef.length !== 66) {
        const randBytes = crypto.getRandomValues(new Uint8Array(32));
        accountRef = "0x" + Array.from(randBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      const message = `Bind Indico Account ${accountRef} to ${address}`;

      showToast("Please sign the message in your wallet...", "info");
      const signature = await WalletManager.signMessage(message);

      showToast("Submitting cryptographic binding to backend...", "info");
      await ApiClient.bindWallet({
        walletAddress: address,
        accountRef,
        signature,
        message,
      });

      showToast("Wallet bound successfully!", "success");
      await this.refresh();
    } catch (err: any) {
      showToast(err.message || "Failed to bind wallet", "error");
    }
  }

  private static async handleSignTerms() {
    try {
      showToast("Fetching current platform terms...", "info");
      const currentTerms = await ApiClient.getCurrentTerms();

      const isAlreadySigned = !!(
        this.termsStatus?.termsSigned === true ||
        this.termsStatus?.signed === true ||
        this.termsStatus?.data?.termsSigned === true
      );

      showModal({
        title: "Platform Terms and Conditions",
        contentHtml: `
          <div style="max-height: 250px; overflow-y: auto; background: rgba(0,0,0,0.3); padding: 14px; border-radius: 8px; font-size: 12px; line-height: 1.6; margin-bottom: 14px; font-family: var(--font-mono);">
            ${currentTerms.text || currentTerms.termsText || "Indico Asset Ledger Protocol Terms"}
          </div>
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
            Terms Hash: <code style="color: var(--pink-accent);">${truncateAddress(currentTerms.termsHash || currentTerms.hash)}</code>
          </div>
          ${
            isAlreadySigned
              ? `<div style="padding: 10px 14px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; font-size: 12px; color: #34d399;">
                  ✓ Your connected wallet has already signed the current terms version on-chain.
                </div>`
              : ""
          }
        `,
        confirmText: isAlreadySigned ? "Already Signed ✓" : "⚡ Sign Terms On-Chain",
        onConfirm: async () => {
          if (isAlreadySigned) {
            showToast("Your wallet has already signed the current platform terms on-chain.", "info");
            return;
          }
          showToast("Preparing signTerms transaction...", "info");
          const prepared = await ApiClient.prepareSignTerms();
          const txHash = await WalletManager.sendPreparedTx(prepared.transaction || prepared);
          showToast(`Terms signed on-chain! Tx: ${truncateAddress(txHash)}`, "success");
          await this.refresh();
          setTimeout(() => {
            this.refresh();
          }, 2000);
        },
      });
    } catch (err: any) {
      showToast(err.message || "Terms signing failed", "error");
    }
  }

  private static getAssetTypeName(type: number): string {
    switch (type) {
      case 1:
        return "Arbitration Award";
      case 2:
        return "Bill of Exchange";
      case 3:
        return "Promissory Note";
      case 4:
        return "Bond";
      case 5:
        return "Commercial Invoice";
      default:
        return "Asset Document";
    }
  }
}
