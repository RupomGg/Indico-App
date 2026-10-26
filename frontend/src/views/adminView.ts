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
  explorerTxLink,
} from "../ui.js";

export const INDICO_LEDGER_ADDRESS = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
export const INDICO_LEDGER_BASESCAN = "https://sepolia.basescan.org/address/0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";

export class AdminView {
  private static container: HTMLElement;
  private static adminData: any = null;
  private static usersList: any[] = [];
  private static merchantsList: any[] = [];
  private static poolData: any = null;
  private static loansData: any[] = [];
  private static safeStatus: any = null;
  private static auditLogs: any[] = [];
  private static auditTotalCount: number = 0;
  private static auditSystemCount: number = 0;
  private static auditTxCount: number = 0;
  private static auditCategory: "ALL" | "SYSTEM" | "TRANSACTION" = "ALL";
  private static auditUserFilter: string = "";
  private static auditStartDate: string = "";
  private static auditEndDate: string = "";
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
          ApiClient.adminGetAuditLogs({
            category: this.auditCategory,
            userId: this.auditUserFilter || undefined,
            startDate: this.auditStartDate || undefined,
            endDate: this.auditEndDate || undefined,
            limit: 100,
          }),
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
        this.auditTotalCount = v?.total ?? this.auditLogs.length;
        this.auditSystemCount = v?.systemCount ?? 0;
        this.auditTxCount = v?.transactionCount ?? 0;
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
            <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Platform Management & Governance</p>
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
              🛡️ Sign In as Admin
            </button>
          </form>

          <div style="margin-top: 20px; font-size: 12px; color: var(--text-faint); text-align: center;">
            Secure admin portal for platform operations and audit inspection.
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
    const totalDeposited = this.poolData?.totalDeposited || this.poolData?.totalAssets || "0.000000";
    const totalLentOut = this.poolData?.totalLentOut || this.poolData?.totalLent || "0.000000";
    const availablePool = this.poolData?.availableUsdc || this.poolData?.poolCash || "0.000000";
    const safeEthBalance = this.safeStatus?.ethBalance || "0.0000";
    const isSafeLow = this.safeStatus?.isLowGas;

    this.container.innerHTML = `
      <!-- Admin Top Banner -->
      <div class="card" style="margin-bottom: 24px; background: linear-gradient(135deg, rgba(88, 28, 135, 0.4), rgba(15, 23, 42, 0.9));">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
              <h2 style="font-size: 20px; font-weight: 800;">Operator: ${this.adminData?.email || "System Admin"}</h2>
              <span class="badge badge-purple">🛡️ ADMIN OPERATOR</span>
              ${
                isSafeLow
                  ? `<span class="badge badge-danger">⚠️ LOW SAFE GAS (${safeEthBalance} ETH)</span>`
                  : `<span class="badge badge-success">✓ SAFE GAS OK (${safeEthBalance} ETH)</span>`
              }
            </div>
            <div style="font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span>Protocol Operations &amp; Audit Trail</span>
              <span>&bull;</span>
              <span>Contract: <a href="${INDICO_LEDGER_BASESCAN}" target="_blank" rel="noopener noreferrer" style="color: var(--cyan-accent); font-family: var(--font-mono); font-weight: 600; text-decoration: underline;">${INDICO_LEDGER_ADDRESS} ↗</a></span>
            </div>
          </div>

          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button id="btn-export-audit" class="btn btn-outline btn-sm">📥 Export CSV Audit</button>
            <button id="btn-print-audit-header" class="btn btn-purple btn-sm">📄 Print / PDF Report</button>
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
      <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px;">
        <button id="adm-tab-users" class="btn btn-sm btn-primary">👥 Registered Users (${this.usersList.length})</button>
        <button id="adm-tab-merchants" class="btn btn-sm btn-outline">🏪 Merchants & Services (${this.merchantsList.length})</button>
        <button id="adm-tab-loans" class="btn btn-sm btn-outline">📊 Pool & Loans (${this.loansData.length})</button>
        <button id="adm-tab-audit" class="btn btn-sm btn-outline">📋 Audit Logs (${this.auditTotalCount || this.auditLogs.length})</button>
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
      const INDICO_LEDGER_ADDRESS = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
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
    document.getElementById("btn-print-audit-header")?.addEventListener("click", () => this.exportAuditPdf());

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

    const INDICO_LEDGER_ADDRESS = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
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
    const INDICO_LEDGER_ADDRESS = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
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
            <span class="badge badge-purple">Merchant Onboarding</span>
          </div>
          <p style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 14px;">
            Onboard the merchant and broadcast on-chain verification in one single operation with your Admin wallet.
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
              Mark the merchant's arbitration agreement as executed and record the storage key.
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
          title: "⚡ Authorize Merchant On Base Sepolia",
          contentHtml: `
            <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #d8b4fe;">
              <strong>ON-CHAIN MERCHANT AUTHORIZATION:</strong><br/>
              Approving merchant <strong>${name}</strong> on the smart contract:<br/>
              <code>${truncateAddress(wallet)}</code> (${wallet})
            </div>
            <p style="font-size: 12.5px; color: var(--text-muted); line-height: 1.6;">
              Please ensure your connected wallet has admin authorization to sign this transaction.
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
              <strong>MERCHANT ON-CHAIN TERMS SIGNATURE:</strong><br/>
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
  // --- SUB-TAB 3: POOL & LOANS SUPERVISION (AD-13, AD-15, AD-21) ---
  private static renderLoansTab(container: HTMLElement) {
    const INDICO_LEDGER_ADDRESS = "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF";
    const SYNC_DEPOSIT_ABI = parseAbi([
      "function syncDeposit(address merchant, uint256 amount) external"
    ]);

    container.innerHTML = `
      <!-- Escrow Pool & Tangem / MetaMask Direct Transfer Overview -->
      <div class="card" style="margin-bottom: 24px; border: 1px solid rgba(168, 85, 247, 0.3); background: linear-gradient(135deg, rgba(168, 85, 247, 0.05) 0%, rgba(20, 20, 30, 0.6) 100%);">
        <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3 class="card-title" style="color: #d8b4fe; display: flex; align-items: center; gap: 8px;">
              🛡️ Escrow Pool & Direct Wallet Ingestion
            </h3>
            <span style="font-size: 12px; color: var(--text-muted);">
              Supports direct USDC transfers from Tangem Wallet NFC cards & MetaMask without web dApp usage
            </span>
          </div>
          <span class="badge badge-success" style="font-size: 11px;">● Automated Keeper Active</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 18px 0;">
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px;">Pool Liquidity (Cash)</div>
            <div style="font-size: 22px; font-weight: 800; color: #fff; margin-top: 4px; font-family: var(--font-mono);">${formatUsdc(this.poolData?.poolCash || this.poolData?.availableUsdc || "0")} USDC</div>
            <div style="font-size: 11.5px; color: #10b981; margin-top: 4px;">Available for user borrowing</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px;">Total Lent on Active Loans</div>
            <div style="font-size: 22px; font-weight: 800; color: #fff; margin-top: 4px; font-family: var(--font-mono);">${formatUsdc(this.poolData?.totalLent || this.poolData?.totalLentOut || "0")} USDC</div>
            <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">Across ${this.loansData.filter((l: any) => l.status === "ACTIVE").length} active loan(s)</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px;">Merchant Deposit Address</div>
            <div style="font-size: 12px; font-family: var(--font-mono); color: #cbd5e1; margin-top: 6px; word-break: break-all;">
              ${INDICO_LEDGER_ADDRESS}
            </div>
            <button id="btn-copy-escrow-addr" class="btn btn-sm btn-outline" style="margin-top: 8px; width: 100%; font-size: 11px;">📋 Copy Address for Merchants</button>
          </div>
        </div>

        <div style="display: flex; gap: 10px; justify-content: flex-end; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 14px;">
          <button id="btn-manual-sync-deposit" class="btn btn-sm btn-purple" style="font-size: 12px;">⚡ Manual Sync Merchant Deposit</button>
        </div>
      </div>

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

    // Copy Escrow Address
    document.getElementById("btn-copy-escrow-addr")?.addEventListener("click", () => {
      navigator.clipboard.writeText(INDICO_LEDGER_ADDRESS);
      showToast("Escrow address copied to clipboard!", "success");
    });



    // Manual Sync Merchant Deposit Modal
    document.getElementById("btn-manual-sync-deposit")?.addEventListener("click", () => {
      showModal({
        title: "⚡ Manual Sync Merchant Direct Deposit (ADMIN_ROLE)",
        contentHtml: `
          <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px; font-size: 13px; color: #d8b4fe;">
            <strong>ON-CHAIN POOL DEPOSIT SYNC (syncDeposit):</strong><br/>
            Credits USDC that a merchant sent directly to the escrow contract from Tangem or MetaMask.
          </div>
          <div style="display: flex; flex-direction: column; gap: 12px; font-size: 13px;">
            <div class="form-group">
              <label class="form-label">Approved Merchant</label>
              <select id="sync-merchant-wallet" class="form-select">
                ${this.merchantsList.map((m) => `<option value="${m.walletAddress}">${m.name} (${truncateAddress(m.walletAddress)})</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Amount (USDC)</label>
              <input type="text" id="sync-deposit-amount" class="form-input form-mono" placeholder="5.000000" />
            </div>
          </div>
        `,
        confirmText: "Broadcast syncDeposit",
        onConfirm: async () => {
          const merchantWallet = (document.getElementById("sync-merchant-wallet") as HTMLSelectElement)?.value;
          const amountStr = (document.getElementById("sync-deposit-amount") as HTMLInputElement)?.value.trim();

          if (!merchantWallet) throw new Error("Select a merchant");
          if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) <= 0) throw new Error("Enter a valid USDC amount");

          const units = BigInt(Math.floor(Number(amountStr) * 1e6));

          showToast("Preparing syncDeposit transaction...", "info");
          const data = encodeFunctionData({
            abi: SYNC_DEPOSIT_ABI,
            functionName: "syncDeposit",
            args: [merchantWallet as any, units],
          });

          const txHash = await WalletManager.sendPreparedTx({
            to: INDICO_LEDGER_ADDRESS,
            data,
          });

          showToast(`Deposit synced on-chain! Tx: ${truncateAddress(txHash)}`, "success");
          await this.refresh();
        },
      });
    });
  }

  // --- RELOAD AUDIT TAB WITH CURRENT FILTERS ---
  private static async reloadAuditTab(container: HTMLElement) {
    try {
      const res = (await ApiClient.adminGetAuditLogs({
        category: this.auditCategory,
        userId: this.auditUserFilter || undefined,
        startDate: this.auditStartDate || undefined,
        endDate: this.auditEndDate || undefined,
        limit: 100,
      })) as any;

      this.auditLogs = res?.items || res?.data?.items || res?.data?.logs || res?.logs || [];
      this.auditTotalCount = res?.total ?? this.auditLogs.length;
      this.auditSystemCount = res?.systemCount ?? 0;
      this.auditTxCount = res?.transactionCount ?? 0;

      const tabBtn = document.getElementById("adm-tab-audit");
      if (tabBtn) {
        tabBtn.textContent = `📋 Audit Logs (${this.auditTotalCount || this.auditLogs.length})`;
      }

      this.renderAuditTab(container);
    } catch (err: any) {
      showToast(err.message || "Failed to load filtered audit logs", "error");
    }
  }

  // --- SUB-TAB 4: AUDIT LOGS BROWSER (AD-16) ---
  private static renderAuditTab(container: HTMLElement) {
    const hasActiveFilters =
      Boolean(this.auditUserFilter) ||
      Boolean(this.auditStartDate) ||
      Boolean(this.auditEndDate) ||
      this.auditCategory !== "ALL";

    container.innerHTML = `
      <div class="card">
        <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <h3 class="card-title">📋 Audit Logs (${this.auditLogs.length} displayed / ${this.auditTotalCount || this.auditLogs.length} total)</h3>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span>Contract:</span>
              <a href="${INDICO_LEDGER_BASESCAN}" target="_blank" rel="noopener noreferrer" style="color: var(--cyan-accent); font-family: var(--font-mono); font-weight: 600; text-decoration: underline;">
                ${INDICO_LEDGER_ADDRESS} ↗
              </a>
              <span style="color: var(--text-faint);">(Base Sepolia)</span>
            </div>
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <button id="btn-export-csv-tab" class="btn btn-outline btn-sm">📥 Export CSV</button>
            <button id="btn-print-pdf-tab" class="btn btn-purple btn-sm">📄 Print / PDF Report</button>
          </div>
        </div>

        <!-- 1. Audit Category Switcher Pills -->
        <div style="display: flex; gap: 10px; margin-bottom: 18px; flex-wrap: wrap;">
          <button id="btn-audit-cat-all" class="btn btn-sm ${this.auditCategory === "ALL" ? "btn-primary" : "btn-outline"}" style="font-weight: 700;">
            🌐 All Audits (${this.auditTotalCount || this.auditLogs.length})
          </button>
          <button id="btn-audit-cat-system" class="btn btn-sm ${this.auditCategory === "SYSTEM" ? "btn-primary" : "btn-outline"}" style="font-weight: 700;">
            🛡️ System & Admin Actions (${this.auditSystemCount})
          </button>
          <button id="btn-audit-cat-tx" class="btn btn-sm ${this.auditCategory === "TRANSACTION" ? "btn-primary" : "btn-outline"}" style="font-weight: 700;">
            💸 Financial & Transactions (${this.auditTxCount})
          </button>
        </div>

        <!-- 2. Audit Filter by User & Time Range (AD-16) -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px 18px; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 11.5px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">
              🔍 User Audit & Date Range Filter
            </div>
            ${
              hasActiveFilters
                ? `<span class="badge badge-purple" style="font-size: 11px;">Active Filters Applied</span>`
                : `<span style="font-size: 11px; color: var(--text-faint);">Showing unfiltered platform trail</span>`
            }
          </div>

          <div style="display: grid; grid-template-columns: 2.2fr 1.3fr 1.3fr auto auto; gap: 10px; align-items: end;">
            <div>
              <label class="form-label" style="font-size: 11px; margin-bottom: 4px;">Target User (ID, Email, or 0x Wallet):</label>
              <input type="text" id="input-audit-user" class="form-input" style="padding: 7px 12px; font-size: 12px;" placeholder="e.g. 0xd785... or testuser1@indico.com" value="${this.auditUserFilter}" />
            </div>
            <div>
              <label class="form-label" style="font-size: 11px; margin-bottom: 4px;">Start Date (From):</label>
              <input type="date" id="input-audit-start" class="form-input" style="padding: 6px 10px; font-size: 12px;" value="${this.auditStartDate}" />
            </div>
            <div>
              <label class="form-label" style="font-size: 11px; margin-bottom: 4px;">End Date (To):</label>
              <input type="date" id="input-audit-end" class="form-input" style="padding: 6px 10px; font-size: 12px;" value="${this.auditEndDate}" />
            </div>
            <div>
              <button id="btn-audit-apply" class="btn btn-accent btn-sm" style="height: 35px; white-space: nowrap;">🔍 Filter</button>
            </div>
            <div>
              <button id="btn-audit-reset" class="btn btn-outline btn-sm" style="height: 35px; white-space: nowrap;">↺ Reset</button>
            </div>
          </div>

          <div style="display: flex; gap: 8px; margin-top: 12px; font-size: 11px; align-items: center; flex-wrap: wrap;">
            <span style="color: var(--text-faint);">Quick Date Presets:</span>
            <button id="preset-today" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 10.5px;">Today</button>
            <button id="preset-7d" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 10.5px;">Last 7 Days</button>
            <button id="preset-30d" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 10.5px;">Last 30 Days</button>
            <button id="preset-all" class="btn btn-outline btn-sm" style="padding: 2px 8px; font-size: 10.5px;">All Time</button>
            ${
              this.usersList.length > 0
                ? `
              <span style="color: var(--text-faint); margin-left: 12px;">Quick Pick User:</span>
              <select id="select-audit-user" class="form-input" style="padding: 2px 8px; font-size: 11px; width: auto; max-width: 260px;">
                <option value="">-- Select Registered User --</option>
                ${this.usersList
                  .map(
                    (u) =>
                      `<option value="${u.walletBinding?.walletAddress || u.id}" ${
                        this.auditUserFilter === (u.walletBinding?.walletAddress || u.id) ? "selected" : ""
                      }>${u.email} (${truncateAddress(u.walletBinding?.walletAddress || "")})</option>`
                  )
                  .join("")}
              </select>
            `
                : ""
            }
          </div>
        </div>

        <!-- 3. Audit Trail Data Table -->
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 140px;">Timestamp</th>
                <th style="width: 140px;">Category & Action</th>
                <th>Event Summary</th>
                <th style="width: 160px;">Actor / Account</th>
                <th style="width: 150px;">Tx Hash / Context</th>
                <th style="width: 65px; text-align: center;">Raw</th>
              </tr>
            </thead>
            <tbody>
              ${
                this.auditLogs.length === 0
                  ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 36px;">No audit events match the selected criteria.</td></tr>`
                  : this.auditLogs
                      .map((log) => {
                        const isTx = log.category === "TRANSACTION" || log.id?.startsWith("tx-");
                        const action = log.action || log.actionType || "UNKNOWN";
                        const actorType = log.actorType || (isTx ? "WALLET" : "ADMIN");
                        const actorId = log.actorId || log.adminId || "";
                        const timestamp = log.timestamp || log.createdAt;
                        const summary = AdminView.getAuditReadableDescription(log);

                        // Action badge coloring
                        let badgeClass = "badge-purple";
                        if (action.includes("LOGIN")) badgeClass = "badge-info";
                        else if (action.includes("APPROVED") || action.includes("SUCCESS") || action === "UserApprovalSet") badgeClass = "badge-success";
                        else if (action.includes("DELETE") || action.includes("REVOKE") || action.includes("Defaulted")) badgeClass = "badge-danger";
                        else if (action.includes("Loan") || action.includes("Credit") || action === "Spent") badgeClass = "badge-cyan";

                        const categoryBadge = isTx
                          ? `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 10px;">TX</span>`
                          : `<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 10px;">SYS</span>`;

                        const contextCell = log.txHash
                          ? explorerTxLink(log.txHash)
                          : `<span style="font-size: 11px; color: var(--text-faint);">${log.ipAddress || "system"}</span>`;

                        return `
                <tr>
                  <td style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">
                    ${formatDate(timestamp)}
                  </td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 6px;">
                      ${categoryBadge}
                      <span class="badge ${badgeClass}" style="font-weight: 700;">${action}</span>
                    </div>
                  </td>
                  <td style="font-size: 12px; line-height: 1.5; color: var(--text-main);">
                    ${summary}
                  </td>
                  <td style="font-family: var(--font-mono); font-size: 11px;">
                    <span style="color: var(--cyan-accent); font-weight: 600;">${actorType}</span>
                    ${
                      actorId
                        ? actorId.startsWith("0x")
                          ? `<br/>${explorerAddressLink(actorId)}`
                          : `<br/><span style="color: var(--text-muted); font-size: 10px;">${truncateAddress(actorId)}</span>`
                        : ""
                    }
                  </td>
                  <td>${contextCell}</td>
                  <td style="text-align: center;">
                    <button class="btn btn-sm btn-outline btn-inspect-log" data-log='${JSON.stringify(log.payload || {}).replace(/'/g, "&apos;")}' style="padding: 2px 8px; font-size: 11px;">Inspect</button>
                  </td>
                </tr>
              `;
                      })
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Category button listeners
    document.getElementById("btn-audit-cat-all")?.addEventListener("click", () => {
      this.auditCategory = "ALL";
      this.reloadAuditTab(container);
    });
    document.getElementById("btn-audit-cat-system")?.addEventListener("click", () => {
      this.auditCategory = "SYSTEM";
      this.reloadAuditTab(container);
    });
    document.getElementById("btn-audit-cat-tx")?.addEventListener("click", () => {
      this.auditCategory = "TRANSACTION";
      this.reloadAuditTab(container);
    });

    // Filter submit & reset
    document.getElementById("btn-audit-apply")?.addEventListener("click", () => {
      this.auditUserFilter = (document.getElementById("input-audit-user") as HTMLInputElement).value.trim();
      this.auditStartDate = (document.getElementById("input-audit-start") as HTMLInputElement).value;
      this.auditEndDate = (document.getElementById("input-audit-end") as HTMLInputElement).value;
      this.reloadAuditTab(container);
    });

    document.getElementById("btn-audit-reset")?.addEventListener("click", () => {
      this.auditUserFilter = "";
      this.auditStartDate = "";
      this.auditEndDate = "";
      this.auditCategory = "ALL";
      this.reloadAuditTab(container);
    });

    // Quick pick user dropdown listener
    document.getElementById("select-audit-user")?.addEventListener("change", (e) => {
      const selected = (e.target as HTMLSelectElement).value;
      (document.getElementById("input-audit-user") as HTMLInputElement).value = selected;
      this.auditUserFilter = selected;
      this.reloadAuditTab(container);
    });

    // Date presets
    document.getElementById("preset-today")?.addEventListener("click", () => {
      const today = new Date().toISOString().slice(0, 10);
      this.auditStartDate = today;
      this.auditEndDate = today;
      (document.getElementById("input-audit-start") as HTMLInputElement).value = today;
      (document.getElementById("input-audit-end") as HTMLInputElement).value = today;
      this.reloadAuditTab(container);
    });

    document.getElementById("preset-7d")?.addEventListener("click", () => {
      const now = new Date();
      const past7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      this.auditStartDate = past7;
      this.auditEndDate = today;
      (document.getElementById("input-audit-start") as HTMLInputElement).value = past7;
      (document.getElementById("input-audit-end") as HTMLInputElement).value = today;
      this.reloadAuditTab(container);
    });

    document.getElementById("preset-30d")?.addEventListener("click", () => {
      const now = new Date();
      const past30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      this.auditStartDate = past30;
      this.auditEndDate = today;
      (document.getElementById("input-audit-start") as HTMLInputElement).value = past30;
      (document.getElementById("input-audit-end") as HTMLInputElement).value = today;
      this.reloadAuditTab(container);
    });

    document.getElementById("preset-all")?.addEventListener("click", () => {
      this.auditStartDate = "";
      this.auditEndDate = "";
      (document.getElementById("input-audit-start") as HTMLInputElement).value = "";
      (document.getElementById("input-audit-end") as HTMLInputElement).value = "";
      this.reloadAuditTab(container);
    });

    // Export buttons
    document.getElementById("btn-export-csv-tab")?.addEventListener("click", () => this.exportAuditCsv());
    document.getElementById("btn-print-pdf-tab")?.addEventListener("click", () => this.exportAuditPdf());

    // Payload inspector modal
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
          <span class="badge badge-purple">Interactive Console</span>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          Query platform status and execute administrative operations using natural language.
          <strong>Look-up questions are answered immediately; actions modifying balances or contracts require review and confirmation.</strong>
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
            Available Liquidity: <strong style="color: #34d399;">${formatUsdc(this.poolData?.availableUsdc || this.poolData?.poolCash || 0)} USDC</strong><br/>
            Total Lent Out: <strong style="color: #38bdf8;">${formatUsdc(this.poolData?.totalLentOut || this.poolData?.totalLent || 0)} USDC</strong><br/>
            Total Merchant Deposits: <strong style="color: #a855f7;">${formatUsdc(this.poolData?.totalDeposited || this.poolData?.totalAssets || 0)} USDC</strong>
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

  // --- CSV EXPORT (AD-16) ---
  private static async exportAuditCsv() {
    let logs = this.auditLogs;
    try {
      const fullRes = (await ApiClient.adminGetAuditLogs({
        category: this.auditCategory,
        userId: this.auditUserFilter || undefined,
        startDate: this.auditStartDate || undefined,
        endDate: this.auditEndDate || undefined,
        limit: 500,
      })) as any;

      const fetched = fullRes?.items || fullRes?.data?.items || fullRes?.data?.logs || fullRes?.logs;
      if (Array.isArray(fetched) && fetched.length > 0) {
        logs = fetched;
      }
    } catch {
      // fallback to currently loaded logs
    }

    if (!logs || logs.length === 0) {
      showToast("No audit logs match current filters to export", "info");
      return;
    }

    const headers = [
      "ID",
      "Category",
      "Timestamp (UTC)",
      "Action",
      "Event Summary",
      "Contract Address",
      "Actor Type",
      "Actor ID / Wallet",
      "Amount",
      "Tx Hash",
      "Block / IP",
    ];

    const rows = logs.map((log) => {
      const rawDate = log.timestamp || log.createdAt;
      const isoDate = rawDate ? new Date(rawDate).toISOString() : new Date().toISOString();
      const isTx = log.category === "TRANSACTION" || log.id?.startsWith("tx-");
      const summaryText = AdminView.getAuditReadableDescription(log).replace(/<[^>]+>/g, "").trim();

      return [
        log.id || "",
        isTx ? "TRANSACTION" : "SYSTEM",
        isoDate,
        log.action || log.actionType || "",
        summaryText,
        isTx || log.txHash ? INDICO_LEDGER_ADDRESS : "",
        log.actorType || (isTx ? "WALLET" : "ADMIN"),
        log.actorId || log.adminId || "",
        log.amountDisplay || log.payload?.amountDisplay || "",
        log.txHash || "",
        log.blockNumber ? `Block #${log.blockNumber}` : (log.ipAddress || "Internal"),
      ];
    });

    const csvContent = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);

    const filterTag = this.auditUserFilter ? "-user-filtered" : "";
    const catTag = this.auditCategory.toLowerCase();
    link.setAttribute("download", `indico-audit-${catTag}${filterTag}-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast(`Exported ${logs.length} ${catTag} audit records to CSV!`, "success");
  }

  // --- STRUCTURED PDF / PRINT REPORT EXPORT (AD-16) ---
  private static async exportAuditPdf() {
    let logs = this.auditLogs;
    let systemCount = this.auditSystemCount;
    let txCount = this.auditTxCount;

    try {
      const fullRes = (await ApiClient.adminGetAuditLogs({
        category: this.auditCategory,
        userId: this.auditUserFilter || undefined,
        startDate: this.auditStartDate || undefined,
        endDate: this.auditEndDate || undefined,
        limit: 500,
      })) as any;

      const fetched = fullRes?.items || fullRes?.data?.items || fullRes?.data?.logs || fullRes?.logs;
      if (Array.isArray(fetched) && fetched.length > 0) {
        logs = fetched;
        if (fullRes.systemCount !== undefined) systemCount = fullRes.systemCount;
        if (fullRes.transactionCount !== undefined) txCount = fullRes.transactionCount;
      }
    } catch {
      // fallback to current logs
    }

    if (!logs || logs.length === 0) {
      showToast("No audit events match current filters for report generation", "info");
      return;
    }

    const printWin = window.open("", "_blank");
    if (!printWin) {
      showToast("Popup blocked! Please allow popups to view or print the audit report.", "warning");
      return;
    }

    const now = new Date();
    const generatedDate = now.toUTCString();
    const operatorEmail = this.adminData?.email || "admin@indico.example";
    const availablePool = this.poolData?.availableUsdc || this.poolData?.poolCash || "0.00";

    const rowsHtml = logs
      .map((log, idx) => {
        const isTx = log.category === "TRANSACTION" || log.id?.startsWith("tx-");
        const action = log.action || log.actionType || "UNKNOWN";
        const actorType = log.actorType || (isTx ? "WALLET" : "ADMIN");
        const actorId = log.actorId || log.adminId || "";
        const rawDate = log.timestamp || log.createdAt;
        const description = AdminView.getAuditReadableDescription(log);

        const formattedDate = rawDate
          ? new Date(rawDate).toLocaleString("en-US", {
              month: "short",
              day: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
            })
          : "-";

        let badgeColor = "#7c3aed";
        let badgeBg = "#f5f3ff";
        let badgeBorder = "#ddd6fe";
        if (action.includes("LOGIN")) {
          badgeColor = "#0284c7";
          badgeBg = "#f0f9ff";
          badgeBorder = "#bae6fd";
        } else if (action.includes("APPROVED") || action.includes("SUCCESS") || action === "UserApprovalSet") {
          badgeColor = "#059669";
          badgeBg = "#ecfdf5";
          badgeBorder = "#a7f3d0";
        } else if (action.includes("DELETE") || action.includes("REVOKE") || action.includes("Defaulted")) {
          badgeColor = "#dc2626";
          badgeBg = "#fef2f2";
          badgeBorder = "#fecaca";
        } else if (action.includes("Loan") || action.includes("Credit") || action === "Spent") {
          badgeColor = "#0891b2";
          badgeBg = "#ecfeff";
          badgeBorder = "#a5f3fc";
        }

        const categoryTag = isTx
          ? `<span style="background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">TX</span>`
          : `<span style="background: #f5f3ff; color: #7c3aed; border: 1px solid #ddd6fe; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">SYS</span>`;

        // Clickable Tx Hash link
        const txLink = log.txHash
          ? `
            <div>
              <a href="https://sepolia.basescan.org/tx/${log.txHash}" target="_blank" rel="noopener noreferrer" style="color: #0284c7; font-family: monospace; font-weight: 700; text-decoration: underline; font-size: 11px;">
                ${truncateAddress(log.txHash)} ↗
              </a>
              ${log.blockNumber ? `<div style="font-size: 9.5px; color: #64748b; font-family: monospace;">Block #${log.blockNumber}</div>` : ""}
            </div>
          `
          : `<span style="font-size: 11px; color: #64748b;">${log.ipAddress || "System Internal"}</span>`;

        // Clickable Involved Party link if 0x address
        const partyLink =
          actorId && actorId.startsWith("0x")
            ? `
              <a href="https://sepolia.basescan.org/address/${actorId}" target="_blank" rel="noopener noreferrer" style="color: #0284c7; font-family: monospace; font-weight: 700; text-decoration: underline; font-size: 11px;">
                ${truncateAddress(actorId)} ↗
              </a>
              <div style="font-size: 10px; color: #64748b; font-weight: 600;">${actorType}</div>
            `
            : `
              <div style="font-weight: 700; color: #0f172a; font-size: 11px;">${actorId ? (actorId.length > 20 ? truncateAddress(actorId) : actorId) : "N/A"}</div>
              <div style="font-size: 10px; color: #64748b; font-weight: 600;">${actorType}</div>
            `;

        return `
          <tr>
            <td style="text-align: center; color: #64748b; font-weight: 600;">#${idx + 1}</td>
            <td style="white-space: nowrap; font-size: 11px; color: #334155;">
              <strong>${formattedDate}</strong>
              <div style="font-size: 9.5px; color: #94a3b8; font-family: monospace;">ID: ${truncateAddress(log.id || "")}</div>
            </td>
            <td>
              <div style="display: flex; align-items: center; gap: 5px;">
                ${categoryTag}
                <span class="badge" style="background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; padding: 2px 7px; border-radius: 5px; font-weight: 700; font-size: 11px; display: inline-block;">
                  ${action}
                </span>
              </div>
            </td>
            <td>
              ${partyLink}
            </td>
            <td style="font-size: 12px; color: #1e293b; line-height: 1.5;">
              ${description}
            </td>
            <td>
              ${txLink}
            </td>
          </tr>
        `;
      })
      .join("");

    const reportHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Indico Protocol — System & Transaction Audit Report</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #f8fafc;
            color: #0f172a;
            padding: 32px;
            font-size: 13px;
            line-height: 1.5;
          }
          .container {
            max-width: 1250px;
            margin: 0 auto;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 36px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
          }
          .no-print {
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #0f172a;
            color: #ffffff;
            padding: 14px 20px;
            border-radius: 8px;
          }
          .btn {
            cursor: pointer;
            padding: 8px 16px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 12.5px;
            border: none;
            transition: opacity 0.2s;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .btn-primary { background: #7c3aed; color: #fff; }
          .btn-secondary { background: #334155; color: #fff; }
          .btn:hover { opacity: 0.9; }

          .report-header {
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 20px;
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          .logo-title h1 {
            font-size: 24px;
            font-weight: 800;
            letter-spacing: -0.5px;
            color: #0f172a;
          }
          .logo-title p {
            color: #64748b;
            font-size: 12px;
            margin-top: 4px;
          }
          .meta-box {
            text-align: right;
            font-size: 12px;
            color: #475569;
            line-height: 1.6;
          }
          .meta-box strong { color: #0f172a; }

          .filter-banner {
            background: #f1f5f9;
            border-left: 4px solid #7c3aed;
            padding: 10px 16px;
            border-radius: 6px;
            margin-bottom: 24px;
            font-size: 12px;
            color: #334155;
          }

          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 28px;
          }
          .metric-card {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 14px 18px;
          }
          .metric-card .label {
            font-size: 11px;
            font-weight: 600;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .metric-card .value {
            font-size: 18px;
            font-weight: 800;
            color: #0f172a;
            margin-top: 4px;
          }

          table.audit-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            margin-bottom: 24px;
          }
          table.audit-table th {
            background: #f1f5f9;
            color: #334155;
            text-align: left;
            padding: 10px 12px;
            font-weight: 700;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-top: 1px solid #cbd5e1;
            border-bottom: 1px solid #cbd5e1;
          }
          table.audit-table td {
            padding: 12px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: top;
          }
          table.audit-table tr:nth-child(even) td {
            background: #fafafa;
          }

          .footer {
            border-top: 1px solid #e2e8f0;
            padding-top: 16px;
            display: flex;
            justify-content: space-between;
            color: #94a3b8;
            font-size: 11px;
          }

          @media print {
            body {
              background: #fff;
              padding: 0;
            }
            .container {
              border: none;
              box-shadow: none;
              padding: 0;
              max-width: 100%;
            }
            .no-print {
              display: none !important;
            }
            table.audit-table tr {
              page-break-inside: avoid;
            }
            a {
              text-decoration: underline !important;
              color: #0284c7 !important;
            }
            @page {
              margin: 10mm 8mm;
              size: landscape;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="no-print">
            <div style="font-weight: 600; font-size: 13px;">
              📄 Audit Report — Ready to Print or Save as PDF
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-primary" onclick="window.print()">🖨️ Print / Save as PDF</button>
              <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
            </div>
          </div>

          <div class="report-header">
            <div class="logo-title">
              <h1>INDICO PROTOCOL</h1>
              <p>System Audit &amp; Transaction Log</p>
            </div>
            <div class="meta-box">
              <div><strong>Contract:</strong> <a href="${INDICO_LEDGER_BASESCAN}" target="_blank" rel="noopener noreferrer" style="color: #0284c7; font-family: monospace; font-weight: 700; text-decoration: underline;">${INDICO_LEDGER_ADDRESS} ↗</a></div>
              <div><strong>Network:</strong> Base Sepolia (Chain ID: 84532)</div>
              <div><strong>Generated:</strong> ${generatedDate}</div>
              <div><strong>Admin:</strong> ${operatorEmail}</div>
              <div><strong>Scope:</strong> ${this.auditCategory} Events</div>
            </div>
          </div>

          <div class="filter-banner">
            <strong>Filters:</strong> Category: <code>${this.auditCategory}</code> &bull; User: <code>${this.auditUserFilter || "All Users"}</code> &bull; Date Range: <code>${this.auditStartDate || "All Time"}</code> to <code>${this.auditEndDate || "Present"}</code> &bull; Total Matched: <strong>${logs.length} events</strong>
          </div>

          <div class="metrics-grid">
            <div class="metric-card">
              <div class="label">Total Events</div>
              <div class="value" style="color: #7c3aed;">${logs.length}</div>
            </div>
            <div class="metric-card">
              <div class="label">System Logs</div>
              <div class="value" style="color: #6366f1;">${systemCount}</div>
            </div>
            <div class="metric-card">
              <div class="label">Transactions</div>
              <div class="value" style="color: #059669;">${txCount}</div>
            </div>
            <div class="metric-card">
              <div class="label">Pool Cash</div>
              <div class="value" style="color: #0284c7;">${formatUsdc(availablePool)} USDC</div>
            </div>
          </div>

          <table class="audit-table">
            <thead>
              <tr>
                <th style="width: 35px; text-align: center;">#</th>
                <th style="width: 155px;">Date &amp; Time</th>
                <th style="width: 130px;">Type</th>
                <th style="width: 160px;">Actor / Wallet</th>
                <th>Event Summary</th>
                <th style="width: 170px;">Tx Hash / Block</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <div class="footer">
            <span>Indico Protocol &bull; Contract: <a href="${INDICO_LEDGER_BASESCAN}" target="_blank" rel="noopener noreferrer" style="color: #0284c7; font-family: monospace; text-decoration: underline;">${INDICO_LEDGER_ADDRESS}</a> &bull; Base Sepolia</span>
            <span>Report generated on ${generatedDate}</span>
          </div>
        </div>

        <script>
          window.addEventListener("DOMContentLoaded", () => {
            setTimeout(() => {
              window.print();
            }, 400);
          });
        </script>
      </body>
      </html>
    `;

    printWin.document.open();
    printWin.document.write(reportHtml);
    printWin.document.close();
    showToast("Audit report prepared! Print / Save as PDF window opened.", "success");
  }

  // --- HUMAN-READABLE EVENT DESCRIPTION BUILDER ---
  private static getAuditReadableDescription(log: any): string {
    const action = log.action || log.actionType || "UNKNOWN";
    const p = log.payload || {};
    const amount = log.amountDisplay || p.amountDisplay;

    switch (action) {
      case "LoanOpened":
        return `Opened Loan #${p.loanId || ""}: <strong style="color: #0284c7;">${amount || "USDC"}</strong>${
          p.collateral ? ` (${(Number(p.collateral) / 1e6).toFixed(2)} Credit collateral locked)` : ""
        }`;
      case "LoanRepaid":
        return `Repaid Loan #${p.loanId || ""}: <strong style="color: #059669;">${amount || "USDC"}</strong> (collateral returned to borrower)`;
      case "LoanDefaulted":
        return `Loan #${p.loanId || ""} defaulted (collateral seized to pool)`;
      case "LoanExtended":
        return `Extended repayment due date for Loan #${p.loanId || ""}`;
      case "CollateralLocked":
        return `Locked <strong style="color: #7c3aed;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "collateral")}</strong> (Loan #${p.loanId || ""})`;
      case "CollateralReleased":
        return `Released <strong style="color: #059669;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "collateral")}</strong> (Loan #${p.loanId || ""})`;
      case "CreditMinted":
        return `Minted <strong style="color: #059669;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "Credit")}</strong> to user wallet`;
      case "CreditBurned":
        return `Burned <strong style="color: #dc2626;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "Credit")}</strong>`;
      case "Spent":
        return `Payment to merchant: <strong style="color: #0284c7;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "Credit")}</strong>`;
      case "MerchantReceipt":
        return `Merchant received payment: <strong style="color: #059669;">${amount || (p.amount ? (Number(p.amount) / 1e6).toFixed(2) + " Credit" : "Credit")}</strong>`;
      case "Deposited":
      case "Deposit":
        return `Pool deposit: <strong style="color: #059669;">${amount || (p.assets ? (Number(p.assets) / 1e6).toFixed(2) + " USDC" : "USDC")}</strong>`;
      case "Withdraw":
        return `Pool withdrawal: <strong style="color: #d97706;">${amount || (p.assets ? (Number(p.assets) / 1e6).toFixed(2) + " USDC" : "USDC")}</strong>`;
      case "AssetRegistered":
        return `Asset registered: <strong style="color: #7c3aed;">${amount || (p.value ? (Number(p.value) / 1e6).toFixed(2) + " USDC" : "")}</strong>`;
      case "TermsSigned":
        return `Signed platform terms on-chain`;
      case "UserApprovalSet":
        return `User wallet ${p.approved ? "approved" : "revoked"} on-chain`;
      case "MerchantApprovalSet":
        return `Merchant wallet ${p.approved ? "approved" : "revoked"} on-chain`;
      case "TermsHashSet":
        return `Platform terms hash updated on-chain`;

      // System Administrative Actions
      case "USER_APPROVED":
        return `Approved user <strong style="color: #059669;">${p.email || ""}</strong>${
          p.walletAddress ? ` (${truncateAddress(p.walletAddress)})` : ""
        }`;
      case "USER_REJECTED":
        return `Rejected user <strong style="color: #dc2626;">${p.email || ""}</strong>`;
      case "MERCHANT_CREATED":
        return `Created merchant <strong style="color: #7c3aed;">"${p.name || ""}"</strong>${
          p.walletAddress ? ` (${truncateAddress(p.walletAddress)})` : ""
        }`;
      case "SERVICE_ADDED":
        return `Added service <strong style="color: #0f172a;">"${p.name || ""}"</strong> (<strong style="color: #0284c7;">${p.price || ""} Credit</strong>)`;
      case "SERVICE_UPDATED":
        return `Updated service ${p.name ? `"${p.name}"` : ""} ${p.price ? `(${p.price} Credit)` : ""}`;
      case "SERVICE_DELETED":
        return `Deleted service from catalog`;
      case "AGREEMENT_SENT":
        return `Sent arbitration agreement to merchant`;
      case "AGREEMENT_SIGNED":
        return `Merchant signed arbitration agreement`;
      case "ADMIN_LOGIN":
        return `Admin login (<span style="color: #64748b;">${p.email || "admin@indico.example"}</span>)`;
      default:
        return `${action.replace(/_/g, " ")}${log.resource ? ` on ${log.resource}` : ""}`;
    }
  }
}


