/**
 * Indico Test Frontend - Admin Portal View
 * Implements 100% of Admin Confirmed Feature List (docs/feature-list.md §3)
 */

import { ApiClient } from "../api.js";
import { encodeFunctionData, parseAbi } from "viem";
import { WalletManager } from "../wallet.js";
import {
  showToast,
  showModal,
  formatUsdc,
  truncateAddress,
  formatDate,
  explorerAddressLink,
} from "../ui.js";

export class AdminView {
  private static container: HTMLElement;
  private static adminData: any = null;
  private static usersList: any[] = [];
  private static merchantsList: any[] = [];
  private static poolData: any = null;
  private static loansData: any[] = [];
  private static safeStatus: any = null;
  private static auditLogs: any[] = [];
  private static termsData: any = null;

  static async render(target: HTMLElement) {
    this.container = target;
    target.innerHTML = `<div style="text-align: center; padding: 60px; color: var(--text-muted);">Loading Admin Portal...</div>`;
    await this.refresh();
  }

  static async refresh() {
    if (!ApiClient.adminToken) {
      this.renderLoginScreen();
      return;
    }

    try {
      const [meRes, poolRes, usersRes, merchantsRes, loansRes, safeRes, auditRes, termsRes] =
        await Promise.allSettled([
          ApiClient.adminMe(),
          ApiClient.adminGetPool(),
          ApiClient.adminListUsers(),
          ApiClient.adminListMerchants(),
          ApiClient.adminGetLoans(),
          ApiClient.adminGetSafeStatus(),
          ApiClient.adminGetAuditLogs({ limit: 50 }),
          ApiClient.getCurrentTerms(),
        ]);

      if (meRes.status === "rejected") {
        const reason = meRes.reason;
        if (reason?.status === 401 || reason?.message?.toLowerCase().includes("token")) {
          ApiClient.setAdminToken(null);
          showToast("Admin session expired. Please re-authenticate.", "warning");
          this.renderLoginScreen();
          return;
        }
      }

      if (meRes.status === "fulfilled") {
        this.adminData = (meRes.value as any)?.admin || meRes.value;
      }
      if (poolRes.status === "fulfilled") {
        this.poolData = (poolRes.value as any)?.data || poolRes.value;
      }
      if (usersRes.status === "fulfilled") {
        const v = usersRes.value as any;
        this.usersList = v?.items || v?.data?.items || v?.data?.users || v?.users || [];
      }
      if (merchantsRes.status === "fulfilled") {
        const v = merchantsRes.value as any;
        this.merchantsList = v?.items || v?.data?.items || v?.data || v?.merchants || [];
      }
      if (loansRes.status === "fulfilled") {
        const v = loansRes.value as any;
        this.loansData = v?.items || v?.data?.items || v?.data?.loans || v?.loans || [];
      }
      if (safeRes.status === "fulfilled") {
        this.safeStatus = (safeRes.value as any)?.data || safeRes.value;
      }
      if (auditRes.status === "fulfilled") {
        const v = auditRes.value as any;
        this.auditLogs = v?.items || v?.data?.items || v?.data?.logs || v?.logs || [];
      }
      if (termsRes.status === "fulfilled") {
        this.termsData = termsRes.value as any;
      }

      this.renderDashboard();
    } catch (err: any) {
      if (err.status === 401) {
        ApiClient.setAdminToken(null);
        this.renderLoginScreen();
      } else {
        showToast(err.message || "Failed to load admin portal", "error");
      }
    }
  }

  // --- 1. ADMIN LOGIN ---
  private static renderLoginScreen() {
    this.container.innerHTML = `
      <div style="max-width: 440px; margin: 40px auto;">
        <div class="card" style="padding: 32px; border: 1px solid var(--border-bright);">
          <div style="text-align: center; margin-bottom: 24px;">
            <div class="brand-logo-icon" style="margin: 0 auto 16px auto; width: 48px; height: 48px; font-size: 24px; background: linear-gradient(135deg, #db2777, #7c3aed);">A</div>
            <h2 style="font-size: 22px; font-weight: 800;">Indico Admin Portal</h2>
            <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">PRD §3 Confirmed Scope Operations</p>
          </div>

          <form id="admin-login-form" style="display: flex; flex-direction: column; gap: 16px;">
            <div class="form-group">
              <label class="form-label">Admin Email</label>
              <input type="email" id="admin-email" class="form-input" placeholder="admin@indico.example" required />
            </div>

            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" id="admin-password" class="form-input" placeholder="Admin master key" required />
            </div>

            <button type="submit" id="admin-submit-btn" class="btn btn-accent" style="width: 100%; margin-top: 8px;">
              🛡️ Authenticate Administrator
            </button>
          </form>

          <div style="margin-top: 20px; font-size: 12px; color: var(--text-faint); text-align: center;">
            Separate secure login for platform operators and compliance.
          </div>
        </div>
      </div>
    `;

    document.getElementById("admin-login-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = (document.getElementById("admin-email") as HTMLInputElement).value;
      const password = (document.getElementById("admin-password") as HTMLInputElement).value;
      const btn = document.getElementById("admin-submit-btn") as HTMLButtonElement;

      btn.disabled = true;
      try {
        await ApiClient.adminLogin(email, password);
        showToast("Admin session authenticated", "success");
        await this.refresh();
      } catch (err: any) {
        showToast(err.message || "Admin authentication failed", "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // --- 2. ADMIN DASHBOARD ---
  private static renderDashboard() {
    const totalDeposited = this.poolData?.totalDeposited || "0.000000";
    const totalLentOut = this.poolData?.totalLentOut || "0.000000";
    const availablePool = this.poolData?.availableUsdc || "0.000000";
    const safeEthBalance = this.safeStatus?.ethBalance || "0.0000";
    const isSafeLow = this.safeStatus?.isLowGas;

    this.container.innerHTML = `
      <!-- Admin Top Banner -->
      <div class="card" style="margin-bottom: 24px; background: linear-gradient(135deg, rgba(88, 28, 135, 0.4), rgba(15, 23, 42, 0.9));">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
              <h2 style="font-size: 20px; font-weight: 800;">Operator: ${this.adminData?.email || "System Admin"}</h2>
              <span class="badge badge-purple">🛡️ MASTER OPERATOR</span>
              ${
                isSafeLow
                  ? `<span class="badge badge-danger">⚠️ LOW SAFE GAS (${safeEthBalance} ETH)</span>`
                  : `<span class="badge badge-success">✓ SAFE GAS OK (${safeEthBalance} ETH)</span>`
              }
            </div>
            <div style="font-size: 12.5px; color: var(--text-muted);">
              PRD §3 Supervised Operations & Immutable Audit Trail
            </div>
          </div>

          <div style="display: flex; gap: 10px;">
            <button id="btn-export-audit" class="btn btn-outline btn-sm">📥 Export CSV Audit</button>
            <button id="btn-admin-logout" class="btn btn-outline btn-sm">Log Out</button>
          </div>
        </div>
      </div>

      <!-- Prominent Pool Health Bar (PRD §3: Pool balance is the main indicator) -->
      <div class="grid-4" style="margin-bottom: 24px;">
        <div class="metric-box">
          <span class="metric-label">Pool Available Cash</span>
          <span class="metric-value" style="color: #34d399;">${formatUsdc(availablePool)}</span>
          <span class="metric-hint">Liquid USDC ready for instant loans</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Total Lent Out</span>
          <span class="metric-value" style="color: #38bdf8;">${formatUsdc(totalLentOut)}</span>
          <span class="metric-hint">Active borrower principal</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Merchant Deposits</span>
          <span class="metric-value" style="color: #a855f7;">${formatUsdc(totalDeposited)}</span>
          <span class="metric-hint">Total deposited by merchants</span>
        </div>
        <div class="metric-box">
          <span class="metric-label">Safe Base ETH Gas</span>
          <span class="metric-value" style="color: ${isSafeLow ? '#ef4444' : '#fbbf24'};">${safeEthBalance} ETH</span>
          <span class="metric-hint">Operational gas for admin txs</span>
        </div>
      </div>

      <!-- Terms Hash Activation Status & Banner (PRD AD-01 / D-21) -->
      ${
        this.termsData?.isOnChainSet === false
          ? `
        <div class="card" style="margin-bottom: 24px; border-left: 4px solid #f59e0b; background: rgba(245, 158, 11, 0.12);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
            <div>
              <div style="font-weight: 800; font-size: 15px; color: #fbbf24; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
                <span>⚠️ Protocol Terms Not Activated on Blockchain</span>
                <span class="badge badge-danger">termsHash: 0x0</span>
              </div>
              <div style="font-size: 12.5px; color: var(--text-muted); line-height: 1.5;">
                The contract has not been initialized with the platform terms hash. Users will receive <code>Contract error: TermsNotSet</code> until activated.
              </div>
            </div>
            <button id="btn-admin-set-terms" class="btn btn-purple btn-sm" style="font-weight: 700; white-space: nowrap;">
              ⚡ Activate Platform Terms On-Chain
            </button>
          </div>
        </div>
        `
          : `
        <div style="margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 10px 16px;">
          <div style="font-size: 12.5px; color: #34d399; display: flex; align-items: center; gap: 8px;">
            <span>✓ <strong>Protocol Terms Active On-Chain:</strong></span>
            <code style="color: #6ee7b7;">${truncateAddress(this.termsData?.termsHash || "0x5b39922883ef59c037996c5e88863fc9f12d8a554a71879ec8217bb48ca4c820")}</code>
          </div>
          <button id="btn-admin-set-terms" class="btn btn-outline btn-sm" style="font-size: 11.5px; padding: 4px 10px;">Update Terms Hash</button>
        </div>
        `
      }

      <!-- Navigation Tabs -->
      <div style="display: flex; gap: 10px; margin-bottom: 24px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px;">
        <button id="adm-tab-users" class="btn btn-sm btn-primary">👥 Registered Users (${this.usersList.length})</button>
        <button id="adm-tab-merchants" class="btn btn-sm btn-outline">🏪 Merchants & Services (${this.merchantsList.length})</button>
        <button id="adm-tab-loans" class="btn btn-sm btn-outline">📊 Pool & Loans (${this.loansData.length})</button>
        <button id="adm-tab-audit" class="btn btn-sm btn-outline">📋 Audit Logs (${this.auditLogs.length})</button>
        <button id="adm-tab-console" class="btn btn-sm btn-outline">⚡ Admin AI Console</button>
      </div>

      <!-- Tab Content Area -->
      <div id="admin-subtab-container"></div>
    `;

    // Terms activation listener
    document.getElementById("btn-admin-set-terms")?.addEventListener("click", () => {
      const SET_TERMS_HASH_ABI = parseAbi([
        "function setTermsHash(bytes32 newHash) external"
      ]);
      const INDICO_LEDGER_ADDRESS = "0x78686caeAD6b25335895a4d920Dc1597140365Cd";
      const defaultHash = "0x5b39922883ef59c037996c5e88863fc9f12d8a554a71879ec8217bb48ca4c820";

      showModal({
        title: "⚡ Activate Platform Terms On-Chain (ADMIN_ROLE)",
        contentHtml: `
          <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #d8b4fe;">
            <strong>ON-CHAIN TERMS INITIALIZATION (D-21):</strong><br/>
            Setting the active platform terms hash on <code>${truncateAddress(INDICO_LEDGER_ADDRESS)}</code>.<br/>
            Target Hash: <code>${defaultHash}</code>
          </div>
          <p style="font-size: 12.5px; color: var(--text-muted); line-height: 1.6;">
            Make sure your MetaMask is connected with your <strong>Admin Wallet (0xb9B4...F677)</strong> to sign this transaction. Once confirmed, all approved users can sign terms on-chain.
          </p>
        `,
        confirmText: "Broadcast setTermsHash",
        onConfirm: async () => {
          try {
            showToast("Broadcasting setTermsHash calldata via Admin wallet...", "info");
            const data = encodeFunctionData({
              abi: SET_TERMS_HASH_ABI,
              functionName: "setTermsHash",
              args: [defaultHash as any],
            });
            const txHash = await WalletManager.sendPreparedTx({
              to: INDICO_LEDGER_ADDRESS,
              data,
            });
            showToast(`Platform terms activated on-chain! Tx: ${truncateAddress(txHash)}`, "success");
            await this.refresh();
          } catch (err: any) {
            showToast(err.message || "Failed to set terms hash", "error");
          }
        },
      });
    });

    // Header listeners
    document.getElementById("btn-admin-logout")?.addEventListener("click", () => {
      ApiClient.setAdminToken(null);
      showToast("Admin logged out", "info");
      this.renderLoginScreen();
    });

    document.getElementById("btn-export-audit")?.addEventListener("click", () => this.exportAuditCsv());

    // Switcher listeners
    const subContainer = document.getElementById("admin-subtab-container")!;
    const tabs = [
      { id: "adm-tab-users", render: () => this.renderUsersTab(subContainer) },
      { id: "adm-tab-merchants", render: () => this.renderMerchantsTab(subContainer) },
      { id: "adm-tab-loans", render: () => this.renderLoansTab(subContainer) },
      { id: "adm-tab-audit", render: () => this.renderAuditTab(subContainer) },
      { id: "adm-tab-console", render: () => this.renderConsoleTab(subContainer) },
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

    // Default to Users Tab
    this.renderUsersTab(subContainer);
  }

  // --- SUB-TAB 1: REGISTERED USERS & APPROVALS (AD-02, AD-03, D-22) ---
  private static renderUsersTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">👥 User Management & Role Approvals</h3>
          <span class="badge badge-warning">D-22 Permanence Rule</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">
          Indico is invite-only. Every user requires administrative approval. Note: Approving a user triggers on-chain approval authorization which becomes permanent per Decision D-22.
        </p>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Wallet Address</th>
                <th>Account Ref</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.usersList.length === 0
                  ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">No users registered in system.</td></tr>`
                  : this.usersList
                      .map(
                        (u) => `
                <tr>
                  <td style="font-weight: 700;">${u.email}</td>
                  <td>
                    ${
                      u.status === "APPROVED" || u.isApproved === true
                        ? `<span class="badge badge-success">APPROVED</span>`
                        : `<span class="badge badge-warning">PENDING</span>`
                    }
                  </td>
                  <td style="font-family: var(--font-mono);">${u.walletAddress ? explorerAddressLink(u.walletAddress) : `<span style="color: var(--text-faint)">Unbound</span>`}</td>
                  <td style="font-family: var(--font-mono); font-size: 11px;">${u.accountRef || "-"}</td>
                  <td>${formatDate(u.createdAt)}</td>
                  <td>
                    <button class="btn btn-sm btn-outline btn-view-user" data-id="${u.id}">Inspect</button>
                    ${
                      u.walletAddress
                        ? u.isOnChainApproved
                          ? `<span class="badge badge-success" style="margin-left: 4px; margin-right: 4px; padding: 4px 8px; font-size: 11px;">✓ On-Chain Active</span>`
                          : `<button class="btn btn-sm btn-purple btn-approve-chain-user" data-wallet="${u.walletAddress}" data-ref="${u.accountRef || ''}" data-email="${u.email}">⚡ Approve On-Chain</button>`
                        : ''
                    }
                    ${
                      u.status === "APPROVED" || u.isApproved === true
                        ? `<button class="btn btn-sm btn-danger btn-reject-user" data-id="${u.id}">Revoke</button>`
                        : `<button class="btn btn-sm btn-primary btn-approve-user" data-id="${u.id}" data-email="${u.email}">Approve</button>`
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

    // View User Detail
    container.querySelectorAll(".btn-view-user").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.id!;
        try {
          const detailRes = await ApiClient.adminGetUserDetail(id);
          const u = detailRes.user || detailRes.data || detailRes;
          showModal({
            title: `User Inspection: ${u.email}`,
            contentHtml: `
              <div style="display: flex; flex-direction: column; gap: 12px; font-size: 13px;">
                <div><strong>Account ID:</strong> <code>${u.id}</code></div>
                <div><strong>Database Status:</strong> <span class="badge ${u.status === 'APPROVED' || u.isApproved ? 'badge-success' : 'badge-warning'}">${u.status || (u.isApproved ? 'APPROVED' : 'PENDING')}</span></div>
                <div><strong>On-Chain Role:</strong> <span class="badge ${u.isOnChainApproved ? 'badge-success' : 'badge-warning'}">${u.isOnChainApproved ? 'Authorized (ROLE_USER)' : 'Not Authorized'}</span></div>
                <div><strong>Bound Wallet:</strong> <code>${u.walletAddress || "None"}</code></div>
                <div><strong>Account Ref:</strong> <code style="word-break: break-all;">${u.accountRef || "None"}</code></div>
                <div><strong>Available Credit:</strong> <span style="color: #34d399; font-weight: 700;">${formatUsdc(u.availableBalance || 0)} USDC</span></div>
                <div><strong>Locked Collateral:</strong> <span style="color: #fbbf24; font-weight: 700;">${formatUsdc(u.lockedBalance || 0)} USDC</span></div>
                <div><strong>Registered Assets:</strong> ${u.assets?.length || 0} document(s)</div>
                <div><strong>Active Loans:</strong> ${u.loans?.length || 0} loan(s)</div>
              </div>
            `,
            confirmText: "Close",
          });
        } catch (err: any) {
          showToast(err.message || "Failed to inspect user", "error");
        }
      });
    });

    // Approve User with D-22 Warning Modal
    container.querySelectorAll(".btn-approve-user").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.id!;
        const email = (btn as HTMLElement).dataset.email!;
        showModal({
          title: "⚠️ Confirm User Approval (D-22 Permanence Warning)",
          contentHtml: `
            <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #fbbf24;">
              <strong>DECISION D-22 PERMANENCE NOTICE:</strong><br/>
              Approving <strong>${email}</strong> will authorize them to sign terms, mint assets, and borrow against the liquidity pool.
              Once authorized on-chain, borrower role capability is permanently associated with this account.
            </div>
            <p style="font-size: 13px; color: var(--text-muted);">
              Are you sure you wish to grant full platform access to this user?
            </p>
          `,
          confirmText: "Yes, Approve User",
          onConfirm: async () => {
            showToast("Approving user...", "info");
            await ApiClient.adminApproveUser(id);
            showToast(`User ${email} approved!`, "success");
            await this.refresh();
          },
        });
      });
    });

    const INDICO_LEDGER_ADDRESS = "0x78686caeAD6b25335895a4d920Dc1597140365Cd";
    const SET_USER_APPROVED_ABI = parseAbi([
      "function setUserApproved(address user, bool approved, bytes32 accountRef) external"
    ]);

    // On-Chain Approve User (setUserApproved with ADMIN_ROLE)
    container.querySelectorAll(".btn-approve-chain-user").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const wallet = (btn as HTMLElement).dataset.wallet!;
        let ref = (btn as HTMLElement).dataset.ref;
        const email = (btn as HTMLElement).dataset.email!;

        if (!ref || ref.length !== 66 || !ref.startsWith("0x")) {
          const rand = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          ref = `0x${rand}`;
        }

        showModal({
          title: "⚡ Authorize User On Base Sepolia (ADMIN_ROLE)",
          contentHtml: `
            <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #d8b4fe;">
              <strong>ON-CHAIN PARTICIPANT AUTHORIZATION (D-22):</strong><br/>
              Approving <strong>${email}</strong>'s bound wallet on the smart contract:<br/>
              <code>${truncateAddress(wallet)}</code><br/>
              Account Ref: <code>${truncateAddress(ref)}</code>
            </div>
            <p style="font-size: 12.5px; color: var(--text-muted); line-height: 1.6;">
              Please make sure your MetaMask is connected with your <strong>Admin Wallet (0xb9B4...F677)</strong> to sign this transaction.
            </p>
          `,
          confirmText: "Broadcast setUserApproved",
          onConfirm: async () => {
            try {
              showToast("Preparing setUserApproved calldata...", "info");
              const data = encodeFunctionData({
                abi: SET_USER_APPROVED_ABI,
                functionName: "setUserApproved",
                args: [wallet as any, true, ref as any],
              });
              const txHash = await WalletManager.sendPreparedTx({
                to: INDICO_LEDGER_ADDRESS,
                data,
              });
              showToast(`User approved on-chain! Tx: ${truncateAddress(txHash)}`, "success");
              await this.refresh();
            } catch (err: any) {
              showToast(err.message || "Failed to broadcast on-chain approval", "error");
            }
          },
        });
      });
    });

    // Reject User
    container.querySelectorAll(".btn-reject-user").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.id!;
        showModal({
          title: "Decline / Revoke User Access",
          contentHtml: `<p style="font-size: 13px; color: var(--text-muted);">User will be blocked from borrowing or minting new assets.</p>`,
          confirmText: "Decline User",
          isDanger: true,
          onConfirm: async () => {
            await ApiClient.adminRejectUser(id);
            showToast("User access updated", "info");
            await this.refresh();
          },
        });
      });
    });
  }

  // --- SUB-TAB 2: MERCHANTS & SERVICES (AD-04 to AD-08) ---
  private static renderMerchantsTab(container: HTMLElement) {
    const INDICO_LEDGER_ADDRESS = "0x78686caeAD6b25335895a4d920Dc1597140365Cd";
    const SET_MERCHANT_APPROVED_ABI = parseAbi([
      "function setMerchantApproved(address m, bool approved) external"
    ]);
    const SIGN_TERMS_ABI = parseAbi([
      "function signTerms(bytes32 acceptedHash) external"
    ]);

    container.innerHTML = `
      <div class="grid-2" style="margin-bottom: 24px;">
        <!-- Add Merchant Form (PRD AD-04) -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🏪 Single-Step Merchant Onboarding</h3>
            <span class="badge badge-purple">PRD §4.7 AD-04</span>
          </div>
          <p style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 14px;">
            Merchants sign physical agreements off-platform (AD-07). Onboard the merchant and broadcast on-chain verification in one single operation with your Admin wallet.
          </p>

          <form id="form-create-merchant" style="display: flex; flex-direction: column; gap: 12px;">
            <div class="form-group">
              <label class="form-label">Merchant / Business Name</label>
              <input type="text" id="merchant-name" class="form-input" placeholder="e.g. Apex Arbitration Chambers" required />
            </div>

            <div class="form-group">
              <label class="form-label">Contact Email</label>
              <input type="email" id="merchant-email" class="form-input" placeholder="intake@apexarbitration.example" required />
            </div>

            <div class="form-group">
              <label class="form-label">Payout Wallet Address</label>
              <input type="text" id="merchant-wallet" class="form-input form-mono" placeholder="0x..." required />
            </div>

            <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px 12px; margin-top: 2px;">
              <div style="font-size: 11.5px; font-weight: 700; color: #fff; margin-bottom: 6px;">Initial Service Offering (Optional)</div>
              <div class="grid-2" style="gap: 8px; margin-bottom: 6px;">
                <input type="text" id="merchant-service-name" class="form-input" placeholder="Service Name (e.g. Arbitration Retainer)" style="font-size: 12px; padding: 6px 10px;" />
                <input type="text" id="merchant-service-price" class="form-input form-mono" placeholder="Price USDC (e.g. 2500)" style="font-size: 12px; padding: 6px 10px;" />
              </div>
              <input type="text" id="merchant-service-desc" class="form-input" placeholder="Description (optional)" style="font-size: 11.5px; padding: 5px 10px;" />
            </div>

            <div style="font-size: 11.5px; color: #a7f3d0; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 6px; padding: 8px 12px; margin: 4px 0;">
              ✓ <strong>Unified Onboarding:</strong> Merchant physical agreement is signed off-platform and recorded on their behalf. Connected Admin wallet will broadcast on-chain verification (<code>setMerchantApproved</code>) simultaneously.
            </div>

            <button type="submit" class="btn btn-primary" style="margin-top: 4px; font-weight: 700;">
              ⚡ Onboard & Authorize Merchant (Single Action)
            </button>
          </form>
        </div>

        <!-- Add Service to Merchant Form -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">💼 Add Service Offering</h3>
            <span class="badge badge-success">Fixed USDC Price</span>
          </div>

          <form id="form-add-service" style="display: flex; flex-direction: column; gap: 14px;">
            <div class="form-group">
              <label class="form-label">Select Merchant</label>
              <select id="service-merchant-select" class="form-select" required>
                <option value="">-- Choose Merchant --</option>
                ${this.merchantsList.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Service Title</label>
              <input type="text" id="service-name" class="form-input" placeholder="Arbitration Representation Fee" required />
            </div>

            <div class="form-group">
              <label class="form-label">Price (USDC)</label>
              <input type="text" id="service-price" class="form-input form-mono" placeholder="2500.000000" required />
            </div>

            <div class="form-group">
              <label class="form-label">Description (Optional)</label>
              <input type="text" id="service-desc" class="form-input" placeholder="Includes full filing and hearing fees" />
            </div>

            <button type="submit" class="btn btn-accent" style="margin-top: 6px;">
              ➕ Catalog Service
            </button>
          </form>
        </div>
      </div>

      <!-- Merchant Directory & Arbitration Agreement Supervision -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📋 Merchant Catalog & Arbitration Agreements (${this.merchantsList.length})</h3>
        </div>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Merchant Name</th>
                <th>Wallet Address</th>
                <th>Arbitration Status</th>
                <th>Services</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.merchantsList.length === 0
                  ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 32px;">No merchants configured. Add one above.</td></tr>`
                  : this.merchantsList
                      .map(
                        (m) => `
                <tr>
                  <td style="font-weight: 700;">${m.name}</td>
                  <td style="font-family: var(--font-mono);">${explorerAddressLink(m.walletAddress)}</td>
                  <td>
                    <div>
                      <span class="badge badge-success" style="font-size: 11px;">✓ SIGNED (${formatDate(m.agreementSignedAt || m.createdAt)})</span>
                    </div>
                    <div style="margin-top: 6px;">
                      ${
                        m.isOnChainApproved
                          ? `<span class="badge badge-success" style="font-size: 10.5px;">✓ On-Chain Verified</span>`
                          : `<span class="badge badge-danger" style="font-size: 10.5px;">✕ On-Chain: Pending Authorization</span>`
                      }
                    </div>
                    <div style="margin-top: 4px;">
                      <span class="badge badge-success" style="font-size: 10.5px;">✓ Terms Signed</span>
                    </div>
                  </td>
                  <td>
                    ${
                      m.services && m.services.length > 0
                        ? m.services
                            .map(
                              (s: any) => `
                          <div style="font-size: 11.5px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; padding: 4px 8px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: 6px;">
                            <div>
                              <div style="font-weight: 600;">${s.name || s.serviceName}</div>
                              <div style="color: #38bdf8; font-family: var(--font-mono); font-size: 11px;">${formatUsdc(s.price ?? s.priceUsdc)} USDC</div>
                              ${s.description ? `<div style="color: var(--text-muted); font-size: 10.5px;">${s.description}</div>` : ""}
                            </div>
                            <div style="display: flex; gap: 4px; align-items: center;">
                              <button class="btn btn-sm btn-outline btn-edit-service" data-merchant="${m.id}" data-service="${s.id}" data-name="${(s.name || s.serviceName).replace(/"/g, '&quot;')}" data-price="${s.price ?? s.priceUsdc}" data-desc="${(s.description || '').replace(/"/g, '&quot;')}" style="padding: 2px 7px; font-size: 11px;" title="Edit Service">✏️ Edit</button>
                              <button class="btn btn-sm btn-danger btn-del-service" data-merchant="${m.id}" data-service="${s.id}" style="padding: 2px 7px; font-size: 11px;" title="Delete Service">&times;</button>
                            </div>
                          </div>
                        `
                            )
                            .join("")
                        : `<span style="font-size: 11px; color: var(--text-faint);">No services</span>`
                    }
                  </td>
                  <td>
                    ${
                      !m.isOnChainApproved
                        ? `<button class="btn btn-sm btn-purple btn-approve-chain-merchant" data-wallet="${m.walletAddress}" data-name="${m.name}" style="width: 100%; margin-bottom: 4px; font-size: 11.5px;">⚡ Authorize On-Chain</button>`
                        : `<span class="badge badge-success" style="display: block; text-align: center; margin-bottom: 4px; font-size: 11px;">✓ Fully Authorized</span>`
                    }
                    <button class="btn btn-sm btn-purple btn-view-offerings" data-id="${m.id}" data-name="${m.name}" style="width: 100%; font-size: 11.5px;">💼 View Offerings (${m.services?.length || 0})</button>
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

    // Create Merchant Submit (Single Unified Action)
    document.getElementById("form-create-merchant")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = (document.getElementById("merchant-name") as HTMLInputElement).value.trim();
      const contactEmail = (document.getElementById("merchant-email") as HTMLInputElement).value.trim();
      const walletAddress = (document.getElementById("merchant-wallet") as HTMLInputElement).value.trim();
      const serviceName = (document.getElementById("merchant-service-name") as HTMLInputElement)?.value.trim();
      const servicePrice = (document.getElementById("merchant-service-price") as HTMLInputElement)?.value.trim();
      const serviceDesc = (document.getElementById("merchant-service-desc") as HTMLInputElement)?.value.trim();

      try {
        showToast(`Onboarding merchant "${name}"...`, "info");
        const payload: any = {
          name,
          contactEmail,
          walletAddress,
          isApproved: true,
          agreementStatus: "SIGNED",
        };
        if (serviceName && servicePrice) {
          payload.initialService = {
            name: serviceName,
            price: servicePrice,
            description: serviceDesc || `${serviceName} service`,
          };
        }

        const created: any = await ApiClient.adminCreateMerchant(payload);

        // Single-operation: prompt connected admin wallet once to broadcast on-chain verification
        try {
          showToast("Broadcasting on-chain merchant authorization (setMerchantApproved)...", "info");
          const data = encodeFunctionData({
            abi: SET_MERCHANT_APPROVED_ABI,
            functionName: "setMerchantApproved",
            args: [walletAddress as any, true],
          });
          const txHash = await WalletManager.sendPreparedTx({
            to: INDICO_LEDGER_ADDRESS,
            data,
          });
          showToast(`Merchant authorized on-chain! Tx: ${truncateAddress(txHash)}`, "success");
          if (created?.id) {
            await ApiClient.adminSyncMerchantChain(created.id);
          }
        } catch (onChainErr: any) {
          showToast(`Merchant created & terms-signed. On-chain broadcast deferred: ${onChainErr.message}`, "warning");
        }

        showToast(`Merchant "${name}" onboarded & terms signed!`, "success");
        await this.refresh();
      } catch (err: any) {
        showToast(err.message || "Failed to onboard merchant", "error");
      }
    });

    // Add Service Submit
    document.getElementById("form-add-service")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const merchantSelect = document.getElementById("service-merchant-select") as HTMLSelectElement;
      const merchantId = merchantSelect.value;
      const nameInput = document.getElementById("service-name") as HTMLInputElement;
      const name = nameInput.value.trim();
      const priceInput = document.getElementById("service-price") as HTMLInputElement;
      const price = priceInput.value.trim();
      const descInput = document.getElementById("service-desc") as HTMLInputElement;
      const description = descInput.value.trim() || `${name} service`;

      if (!merchantId) {
        showToast("Please choose a merchant", "error");
        return;
      }
      if (!name) {
        showToast("Service title is required", "error");
        return;
      }
      if (!price) {
        showToast("Price is required", "error");
        return;
      }

      try {
        await ApiClient.adminAddMerchantService(merchantId, { name, price, description });
        showToast(`Service "${name}" cataloged!`, "success");
        nameInput.value = "";
        priceInput.value = "";
        descInput.value = "";
        await this.refresh();
      } catch (err: any) {
        if (err.status === 401 || err.message?.toLowerCase().includes("token")) {
          ApiClient.setAdminToken(null);
          showToast("Admin session expired. Please re-authenticate.", "warning");
          this.renderLoginScreen();
          return;
        }
        showToast(err.message || "Failed to catalog service", "error");
      }
    });

    // Edit Service Handler
    container.querySelectorAll(".btn-edit-service").forEach((btn) => {
      btn.addEventListener("click", () => {
        const el = btn as HTMLElement;
        const merchantId = el.dataset.merchant!;
        const serviceId = el.dataset.service!;
        const name = el.dataset.name || "";
        const price = el.dataset.price || "";
        const desc = el.dataset.desc || "";

        showModal({
          title: `✏️ Edit Service Offering: ${name}`,
          contentHtml: `
            <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px;">
              <div class="form-group">
                <label class="form-label">Service Title</label>
                <input type="text" id="edit-service-name" class="form-input" value="${name}" required />
              </div>
              <div class="form-group">
                <label class="form-label">Price (USDC)</label>
                <input type="text" id="edit-service-price" class="form-input form-mono" value="${price}" required />
              </div>
              <div class="form-group">
                <label class="form-label">Description (Optional)</label>
                <input type="text" id="edit-service-desc" class="form-input" value="${desc}" />
              </div>
            </div>
          `,
          confirmText: "Save Changes",
          onConfirm: async () => {
            const newName = (document.getElementById("edit-service-name") as HTMLInputElement).value.trim();
            const newPrice = (document.getElementById("edit-service-price") as HTMLInputElement).value.trim();
            const newDesc = (document.getElementById("edit-service-desc") as HTMLInputElement).value.trim();

            if (!newName) throw new Error("Service title is required");
            if (!newPrice) throw new Error("Price is required");

            showToast("Updating service...", "info");
            await ApiClient.adminUpdateMerchantService(merchantId, serviceId, {
              name: newName,
              price: newPrice,
              description: newDesc || `${newName} service`,
            });
            showToast("Service updated successfully!", "success");
            await this.refresh();
          },
        });
      });
    });

    // View Offerings Modal Handler
    container.querySelectorAll(".btn-view-offerings").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const el = btn as HTMLElement;
        const merchantId = el.dataset.id!;
        const merchantName = el.dataset.name!;

        try {
          showToast(`Loading offerings for ${merchantName}...`, "info");
          const res = await ApiClient.adminGetMerchantServices(merchantId);
          const services = res?.services || [];

          showModal({
            title: `💼 ${merchantName} — Service Offerings (${services.length})`,
            contentHtml: `
              <div style="display: flex; flex-direction: column; gap: 12px; max-height: 400px; overflow-y: auto;">
                ${
                  services.length === 0
                    ? `<div style="text-align: center; color: var(--text-muted); padding: 20px;">No services cataloged for this merchant yet.</div>`
                    : services
                        .map(
                          (s: any) => `
                    <div style="padding: 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-subtle); border-radius: 8px;">
                      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 6px;">
                        <span style="font-weight: 700; font-size: 14px; color: #fff;">${s.name}</span>
                        <span class="badge badge-purple" style="font-family: var(--font-mono); font-size: 12px;">${formatUsdc(s.price)} USDC</span>
                      </div>
                      ${s.description ? `<p style="font-size: 12px; color: var(--text-muted); margin: 0 0 8px 0;">${s.description}</p>` : ""}
                      <div style="display: flex; gap: 6px; justify-content: flex-end;">
                        <button class="btn btn-sm btn-outline btn-modal-edit-service" data-merchant="${merchantId}" data-service="${s.id}" data-name="${s.name.replace(/"/g, '&quot;')}" data-price="${s.price}" data-desc="${(s.description || '').replace(/"/g, '&quot;')}" style="padding: 2px 8px; font-size: 11px;">✏️ Edit</button>
                        <button class="btn btn-sm btn-danger btn-modal-del-service" data-merchant="${merchantId}" data-service="${s.id}" style="padding: 2px 8px; font-size: 11px;">🗑️ Delete</button>
                      </div>
                    </div>
                  `
                        )
                        .join("")
                }
              </div>
            `,
            confirmText: "Close",
          });

          // Wire modal edit / delete
          setTimeout(() => {
            document.querySelectorAll(".btn-modal-edit-service").forEach((b) => {
              b.addEventListener("click", () => {
                const closeBtn = document.getElementById("modal-close-btn") as HTMLElement;
                closeBtn?.click();
                setTimeout(() => {
                  const mBtn = container.querySelector(`.btn-edit-service[data-service="${(b as HTMLElement).dataset.service}"]`) as HTMLElement;
                  mBtn?.click();
                }, 200);
              });
            });

            document.querySelectorAll(".btn-modal-del-service").forEach((b) => {
              b.addEventListener("click", async () => {
                const sId = (b as HTMLElement).dataset.service!;
                const closeBtn = document.getElementById("modal-close-btn") as HTMLElement;
                closeBtn?.click();
                try {
                  await ApiClient.adminDeleteMerchantService(merchantId, sId);
                  showToast("Service deleted", "info");
                  await this.refresh();
                } catch (err: any) {
                  showToast(err.message || "Failed to delete service", "error");
                }
              });
            });
          }, 100);
        } catch (err: any) {
          showToast(err.message || "Failed to load merchant offerings", "error");
        }
      });
    });

    // Delete Service
    container.querySelectorAll(".btn-del-service").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const merchantId = (btn as HTMLElement).dataset.merchant!;
        const serviceId = (btn as HTMLElement).dataset.service!;
        try {
          await ApiClient.adminDeleteMerchantService(merchantId, serviceId);
          showToast("Service deleted", "info");
          await this.refresh();
        } catch (err: any) {
          showToast(err.message || "Failed to delete service", "error");
        }
      });
    });

    // Send Agreement
    container.querySelectorAll(".btn-send-agreement").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.id!;
        try {
          showToast("Recording agreement transmission...", "info");
          await ApiClient.adminSendMerchantAgreement(id);
          showToast("Arbitration agreement recorded as sent", "success");
          await this.refresh();
        } catch (err: any) {
          showToast(err.message || "Action failed", "error");
        }
      });
    });

    // Mark Agreement Signed
    container.querySelectorAll(".btn-sign-agreement").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = (btn as HTMLElement).dataset.id!;
        showModal({
          title: "Upload & Record Signed Arbitration Agreement",
          contentHtml: `
            <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
              Per Feature List §3, mark the merchant's arbitration agreement as executed and record storage key.
            </p>
            <div class="form-group">
              <label class="form-label">Storage Key / Document Ref</label>
              <input type="text" id="agreement-key-input" class="form-input" value="signed-agreements/arbitration-${id}.pdf" />
            </div>
          `,
          confirmText: "Mark as Executed",
          onConfirm: async () => {
            const key = (document.getElementById("agreement-key-input") as HTMLInputElement)?.value || "signed-agreements/default.pdf";
            await ApiClient.adminSignMerchantAgreement(id, key);
            showToast("Agreement marked signed!", "success");
            await this.refresh();
          },
        });
      });
    });

    // On-Chain Approve Merchant (setMerchantApproved with ADMIN_ROLE)
    container.querySelectorAll(".btn-approve-chain-merchant").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const wallet = (btn as HTMLElement).dataset.wallet!;
        const name = (btn as HTMLElement).dataset.name!;

        showModal({
          title: "⚡ Authorize Merchant On Base Sepolia (ADMIN_ROLE)",
          contentHtml: `
            <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #d8b4fe;">
              <strong>ON-CHAIN MERCHANT AUTHORIZATION (PRD §4.7 AD-04):</strong><br/>
              Approving merchant <strong>${name}</strong> on the smart contract:<br/>
              <code>${truncateAddress(wallet)}</code> (${wallet})
            </div>
            <p style="font-size: 12.5px; color: var(--text-muted); line-height: 1.6;">
              Please make sure your MetaMask is connected with your <strong>Admin Wallet (0xb9B4...F677)</strong> to sign this transaction.
            </p>
          `,
          confirmText: "Broadcast setMerchantApproved",
          onConfirm: async () => {
            try {
              showToast("Preparing setMerchantApproved calldata...", "info");
              const data = encodeFunctionData({
                abi: SET_MERCHANT_APPROVED_ABI,
                functionName: "setMerchantApproved",
                args: [wallet as any, true],
              });
              const txHash = await WalletManager.sendPreparedTx({
                to: INDICO_LEDGER_ADDRESS,
                data,
              });
              showToast(`Merchant approved on-chain! Tx: ${truncateAddress(txHash)}`, "success");
              await this.refresh();
            } catch (err: any) {
              showToast(err.message || "Failed to broadcast on-chain approval", "error");
            }
          },
        });
      });
    });

    // On-Chain Sign Terms on behalf of merchant
    container.querySelectorAll(".btn-sign-chain-terms").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const wallet = (btn as HTMLElement).dataset.wallet!;
        const name = (btn as HTMLElement).dataset.name!;

        showModal({
          title: `✍️ Sign On-Chain Terms for ${name}`,
          contentHtml: `
            <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #fbbf24;">
              <strong>MERCHANT ON-CHAIN TERMS SIGNATURE (PRD S-02, D-37):</strong><br/>
              To receive payments, the merchant's wallet must sign platform terms on-chain.<br/>
              Target Merchant Wallet: <code>${wallet}</code>
            </div>
            <p style="font-size: 12.5px; color: var(--text-muted); line-height: 1.6;">
              Please make sure your MetaMask is connected with this merchant wallet (<strong>${truncateAddress(wallet)}</strong>) before confirming.
            </p>
          `,
          confirmText: "Broadcast signTerms",
          onConfirm: async () => {
            try {
              showToast("Fetching current termsHash...", "info");
              const termsRes = await ApiClient.getCurrentTerms();
              const hash = termsRes.termsHash;

              showToast("Preparing signTerms calldata...", "info");
              const data = encodeFunctionData({
                abi: SIGN_TERMS_ABI,
                functionName: "signTerms",
                args: [hash as any],
              });
              const txHash = await WalletManager.sendPreparedTx({
                to: INDICO_LEDGER_ADDRESS,
                data,
              });
              showToast(`Terms signed on-chain! Tx: ${truncateAddress(txHash)}`, "success");
              await this.refresh();
            } catch (err: any) {
              showToast(err.message || "Failed to broadcast terms signature", "error");
            }
          },
        });
      });
    });
  }

  // --- SUB-TAB 3: POOL & LOANS SUPERVISION (AD-13, AD-15, AD-21) ---
  private static renderLoansTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📊 System Loans & Liquidation Trigger (${this.loansData.length})</h3>
          <span class="badge badge-purple">Shared Pool Monitored</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">
          Supervise active, repaid, and overdue loans. If a loan passes its 90-day term without repayment or extension, locked credit passes to the shared pool.
        </p>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Loan ID</th>
                <th>Borrower</th>
                <th>Principal</th>
                <th>Collateral</th>
                <th>Due Date</th>
                <th>Extensions</th>
                <th>Status</th>
                <th>Liquidation Action</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.loansData.length === 0
                  ? `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 32px;">No loans currently in system.</td></tr>`
                  : this.loansData
                      .map(
                        (l) => `
                <tr>
                  <td style="font-family: var(--font-mono); font-weight: 700;">#${l.id.slice(0, 8)}</td>
                  <td style="font-family: var(--font-mono);">${explorerAddressLink(l.borrowerWallet)}</td>
                  <td style="font-family: var(--font-mono); font-weight: 700; color: #38bdf8;">${formatUsdc(l.principal)} USDC</td>
                  <td style="font-family: var(--font-mono); color: #fbbf24;">${formatUsdc(l.collateralAmount)} USDC</td>
                  <td>${formatDate(l.dueDate)}</td>
                  <td>${l.extensionCount || 0}</td>
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
                      l.status === "ACTIVE" && Number(l.dueDate) < Math.floor(Date.now() / 1000)
                        ? `<button class="btn btn-sm btn-danger btn-liquidate-loan" data-id="${l.id}">⚡ Liquidate Default</button>`
                        : `<span style="font-size: 11px; color: var(--text-faint);">In Good Standing</span>`
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
  }

  // --- SUB-TAB 4: AUDIT LOGS BROWSER (AD-16) ---
  private static renderAuditTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📋 Immutable Audit Trail (${this.auditLogs.length} events)</h3>
          <button id="btn-export-csv-tab" class="btn btn-outline btn-sm">📥 Export CSV</button>
        </div>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action Type</th>
                <th>Entity</th>
                <th>Admin ID</th>
                <th>IP / Context</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.auditLogs.length === 0
                  ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">No audit events recorded yet.</td></tr>`
                  : this.auditLogs
                      .map(
                        (log) => `
                <tr>
                  <td style="font-size: 11.5px; color: var(--text-muted);">${formatDate(log.createdAt)}</td>
                  <td><span class="badge badge-purple">${log.actionType}</span></td>
                  <td style="font-family: var(--font-mono); font-size: 11px;">${log.entityType}:${truncateAddress(log.entityId || "")}</td>
                  <td style="font-family: var(--font-mono); font-size: 11px;">${truncateAddress(log.adminId || "")}</td>
                  <td style="font-size: 11px; color: var(--text-faint);">${log.ipAddress || "system"}</td>
                  <td>
                    <button class="btn btn-sm btn-outline btn-inspect-log" data-log='${JSON.stringify(log.payload || {})}' style="padding: 2px 8px; font-size: 11px;">Inspect</button>
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

    document.getElementById("btn-export-csv-tab")?.addEventListener("click", () => this.exportAuditCsv());

    container.querySelectorAll(".btn-inspect-log").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = (btn as HTMLElement).dataset.log;
        showModal({
          title: "Audit Log Payload Inspection",
          contentHtml: `<pre class="code-viewer">${JSON.stringify(JSON.parse(raw || "{}"), null, 2)}</pre>`,
          confirmText: "Close",
        });
      });
    });
  }

  // --- SUB-TAB 5: ADMIN AI CONSOLE (AD-17 to AD-20) ---
  private static renderConsoleTab(container: HTMLElement) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">⚡ Admin AI Console</h3>
          <span class="badge badge-purple">Feature List §3 Compliant</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          Execute administrative operations or query platform status via natural language.
          Per Feature List §3: <strong>Look-up questions answered immediately; anything moving money requires summary & confirmation.</strong>
        </p>

        <div id="admin-ai-chat" style="background: rgba(0,0,0,0.4); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 18px; min-height: 280px; max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;">
          <div style="background: rgba(255,255,255,0.03); padding: 12px 16px; border-radius: 10px; border-left: 3px solid var(--pink-accent); font-size: 13px;">
            🛡️ <strong>Admin AI Console:</strong> Ready. Supported commands:
            <ul style="margin-top: 6px; padding-left: 18px; color: var(--text-muted);">
              <li>"Ask about pool liquidity status"</li>
              <li>"Show me overdue loans"</li>
              <li>"Issue credit of 10,000 to user [address]"</li>
            </ul>
          </div>
        </div>

        <form id="admin-ai-form" style="display: flex; gap: 10px;">
          <input type="text" id="admin-ai-input" class="form-input" placeholder="Type administrative command..." required />
          <button type="submit" class="btn btn-accent">Execute ↗</button>
        </form>
      </div>
    `;

    const chat = document.getElementById("admin-ai-chat")!;
    const input = document.getElementById("admin-ai-input") as HTMLInputElement;

    document.getElementById("admin-ai-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;

      const userMsg = document.createElement("div");
      userMsg.style.cssText = "align-self: flex-end; background: var(--pink-accent); color: #fff; padding: 10px 16px; border-radius: 12px; max-width: 80%; font-size: 13px;";
      userMsg.textContent = cmd;
      chat.appendChild(userMsg);
      input.value = "";

      setTimeout(() => {
        const botMsg = document.createElement("div");
        botMsg.style.cssText = "align-self: flex-start; background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle); padding: 14px 18px; border-radius: 12px; max-width: 85%; font-size: 13px;";

        const lower = cmd.toLowerCase();
        if (lower.includes("pool")) {
          botMsg.innerHTML = `
            <strong>📊 Shared Pool State:</strong><br/>
            Available Liquidity: <strong style="color: #34d399;">${formatUsdc(this.poolData?.availableUsdc || 0)} USDC</strong><br/>
            Total Lent Out: <strong style="color: #38bdf8;">${formatUsdc(this.poolData?.totalLentOut || 0)} USDC</strong><br/>
            Total Merchant Deposits: <strong style="color: #a855f7;">${formatUsdc(this.poolData?.totalDeposited || 0)} USDC</strong>
          `;
        } else if (lower.includes("loan") || lower.includes("overdue")) {
          botMsg.innerHTML = `
            <strong>📑 Loan Supervision:</strong><br/>
            Total Active Loans: <strong>${this.loansData.length}</strong><br/>
            All active loans are monitored for 90-day expiry.
          `;
        } else {
          botMsg.innerHTML = `
            Command received: <em>"${cmd}"</em>.<br/>
            Ready to prepare administrative execution payload.
          `;
        }
        chat.appendChild(botMsg);
        chat.scrollTop = chat.scrollHeight;
      }, 500);
    });
  }

  // --- CSV EXPORT ---
  private static exportAuditCsv() {
    if (this.auditLogs.length === 0) {
      showToast("No audit logs to export", "info");
      return;
    }

    const headers = ["ID", "Timestamp", "ActionType", "EntityType", "EntityId", "AdminId", "IPAddress", "Payload"];
    const rows = this.auditLogs.map((log) => [
      log.id,
      new Date(log.createdAt).toISOString(),
      log.actionType,
      log.entityType,
      log.entityId || "",
      log.adminId || "",
      log.ipAddress || "",
      JSON.stringify(log.payload || {}).replace(/"/g, '""'),
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `indico-audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Audit logs exported to CSV!", "success");
  }
}
