# Implementation Guide: Audit Logs & Reports PDF Export

> **Objective**: 
> 1. Fix the confusion in the Audit Logs & Reports pages.
> 2. Add high-quality **PDF Export** to the Admin Dashboard with the **exact same layout and styling** as the local Indico report (landscape, summary metric cards, BaseScan links, and human-readable event summaries).

---

## 1. What Makes the Current Pages Confusing & How to Improve

### Issue 1: Cryptic Database IDs instead of Human-Readable Events
* **Current**: The table displays `AFFECTED RECORD` with raw UUIDs like `MerchantService · 63315ebd-f_0a7e65` or `User · fca782fb-f_679c9c`.
* **Fix**: Replace or enrich this column with an **Event Summary** column that translates actions into plain English:
  * *Instead of*: `Service added` + `63315ebd...`  
    $\rightarrow$ **`Added service "Software Dev package 1" (2,121 Credit)`**
  * *Instead of*: `User approved` + `fca782fb...`  
    $\rightarrow$ **`Approved user verify_flow@indico.test`**
  * *Instead of*: `LoanOpened` + `Loan #4`  
    $\rightarrow$ **`Opened Loan #4: 3.00 USDC (3.75 Credit collateral locked)`**

### Issue 2: Export Button on `#audit-logs` only exports CSV
* **Current**: On `#audit-logs`, clicking Export only downloads a raw CSV file. The PDF option is hidden inside `#reports` cards.
* **Fix**: In the toolbar above the Audit Logs table (next to `Filter` and `Export CSV`), add a dedicated **`📄 Export PDF`** button. Clicking it instantly renders and prints the active filtered logs into the official PDF layout.

### Issue 3: Missing Summary Stat Cards
* **Fix**: Add the 4 top metric cards above the table / report:
  * **Total Events**
  * **System Logs (SYS)**
  * **Transactions (TX)**
  * **Pool Cash (USDC)**

---

## 2. Complete Code: Native Browser PDF Generator

This uses the native browser printing engine (`window.print()`). It requires **zero external PDF libraries** (no `jspdf` or `pdfmake`), outputs sharp vector text and links, and automatically opens the "Save as PDF" dialog in landscape format.

### Step 1: Human-Readable Description Helper

```typescript
export function getAuditReadableDescription(log: any): string {
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

    // System / Admin Actions
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
      return `Admin login (<span style="color: #64748b;">${p.email || "admin"}</span>)`;
    default:
      return `${action.replace(/_/g, " ")}${log.resource ? ` on ${log.resource}` : ""}`;
  }
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr || "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
```

---

### Step 2: The Print / Save as PDF Function

Add this function to trigger the exact same local report window:

```typescript
export function exportAuditLogsToPdf(params: {
  logs: any[];
  filters?: { category?: string; user?: string; startDate?: string; endDate?: string };
  poolCashUsdc?: string;
  adminEmail?: string;
}) {
  const { logs, filters = {}, poolCashUsdc = "7.00", adminEmail = "admin@indico.example" } = params;

  const printWin = window.open("", "_blank");
  if (!printWin) {
    alert("Please allow pop-ups to generate the PDF report.");
    return;
  }

  const generatedDate = new Date().toUTCString();
  const INDICO_LEDGER_ADDRESS = "0xF6903fF1FD15858E5F706d39d91979313aD4Bf1e";
  const BASESCAN_URL = `https://sepolia.basescan.org/address/${INDICO_LEDGER_ADDRESS}`;

  // Counts
  const systemCount = logs.filter((l) => l.actorType === "ADMIN" || l.source === "system" || l.category === "System").length;
  const txCount = logs.length - systemCount;

  // Build table rows
  const rowsHtml = logs
    .map((log, idx) => {
      const isTx = log.source === "on-chain" || log.category === "On-chain" || Boolean(log.txHash);
      const action = log.action || "EVENT";
      const description = getAuditReadableDescription(log);
      const formattedDate = new Date(log.timestamp || log.createdAt).toLocaleString("en-US", {
        timeZoneName: "short",
      });

      const categoryBadge = isTx
        ? `<span style="background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">TX</span>`
        : `<span style="background: #f5f3ff; color: #7c3aed; border: 1px solid #ddd6fe; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">SYS</span>`;

      const actorDisplay = log.actorAddress || log.actorId || log.walletAddress || "ADMIN";
      const actorLink = actorDisplay.startsWith("0x")
        ? `<a href="https://sepolia.basescan.org/address/${actorDisplay}" target="_blank" style="color: #0284c7; font-family: monospace; font-weight: 700; text-decoration: underline; font-size: 11px;">${truncateAddress(actorDisplay)} ↗</a>`
        : `<div style="font-weight: 700; color: #0f172a; font-size: 11px;">${truncateAddress(actorDisplay)}</div>`;

      const txLink = log.txHash
        ? `<a href="https://sepolia.basescan.org/tx/${log.txHash}" target="_blank" style="color: #0284c7; font-family: monospace; font-weight: 700; text-decoration: underline; font-size: 11px;">${truncateAddress(log.txHash)} ↗</a>`
        : `<span style="font-size: 11px; color: #94a3b8;">system</span>`;

      return `
        <tr>
          <td style="text-align: center; color: #64748b; font-weight: 600;">#${idx + 1}</td>
          <td style="white-space: nowrap; font-size: 11px; color: #334155;">
            <strong>${formattedDate}</strong>
            <div style="font-size: 9.5px; color: #94a3b8; font-family: monospace;">ID: ${truncateAddress(log.id || "")}</div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${categoryBadge}
              <span style="font-weight: 700; font-size: 11px; color: #334155;">${action}</span>
            </div>
          </td>
          <td>
            ${actorLink}
            <div style="font-size: 9.5px; color: #64748b; font-weight: 600;">${log.actorType || (isTx ? "WALLET" : "ADMIN")}</div>
          </td>
          <td style="font-size: 12px; color: #1e293b; line-height: 1.5;">
            ${description}
          </td>
          <td>${txLink}</td>
        </tr>
      `;
    })
    .join("");

  const reportHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Indico Protocol — System & Transaction Audit Report</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background-color: #f8fafc;
          color: #0f172a;
          padding: 32px;
          font-size: 13px;
        }
        .container {
          max-width: 1250px;
          margin: 0 auto;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 36px;
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
        }
        .btn-primary { background: #7c3aed; color: #fff; }
        .btn-secondary { background: #334155; color: #fff; margin-left: 8px; }
        .report-header {
          border-bottom: 2px solid #e2e8f0;
          padding-bottom: 20px;
          margin-bottom: 24px;
          display: flex;
          justify-content: space-between;
        }
        .logo-title h1 { font-size: 24px; font-weight: 800; color: #0f172a; }
        .logo-title p { color: #64748b; font-size: 12px; margin-top: 4px; }
        .meta-box { text-align: right; font-size: 12px; color: #475569; line-height: 1.6; }
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
        .metric-card .label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; }
        .metric-card .value { font-size: 20px; font-weight: 800; margin-top: 4px; }
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
          border-top: 1px solid #cbd5e1;
          border-bottom: 1px solid #cbd5e1;
        }
        table.audit-table td {
          padding: 12px;
          border-bottom: 1px solid #e2e8f0;
          vertical-align: top;
        }
        table.audit-table tr:nth-child(even) td { background: #fafafa; }
        .footer {
          border-top: 1px solid #e2e8f0;
          padding-top: 16px;
          display: flex;
          justify-content: space-between;
          color: #94a3b8;
          font-size: 11px;
        }
        @media print {
          body { background: #fff; padding: 0; }
          .container { border: none; box-shadow: none; padding: 0; max-width: 100%; }
          .no-print { display: none !important; }
          table.audit-table tr { page-break-inside: avoid; }
          @page { margin: 10mm 8mm; size: landscape; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="no-print">
          <div style="font-weight: 600; font-size: 13px;">📄 Audit Report — Ready to Print or Save as PDF</div>
          <div>
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
            <div><strong>Contract:</strong> <a href="${BASESCAN_URL}" target="_blank" style="color: #0284c7; font-family: monospace; font-weight: 700;">${INDICO_LEDGER_ADDRESS} ↗</a></div>
            <div><strong>Network:</strong> Base Sepolia (Chain ID: 84532)</div>
            <div><strong>Generated:</strong> ${generatedDate}</div>
            <div><strong>Admin:</strong> ${adminEmail}</div>
            <div><strong>Scope:</strong> ${filters.category || "ALL"} Events</div>
          </div>
        </div>

        <div class="filter-banner">
          <strong>Filters:</strong> Category: <code>${filters.category || "ALL"}</code> &bull; User: <code>${filters.user || "All Users"}</code> &bull; Date Range: <code>${filters.startDate || "All Time"}</code> to <code>${filters.endDate || "Present"}</code> &bull; Total Matched: <strong>${logs.length} events</strong>
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
            <div class="value" style="color: #0284c7;">${poolCashUsdc} USDC</div>
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
          <span>Indico Protocol &bull; Contract: ${INDICO_LEDGER_ADDRESS} &bull; Base Sepolia</span>
          <span>Report generated on ${generatedDate}</span>
        </div>
      </div>

      <script>
        window.addEventListener("DOMContentLoaded", () => {
          setTimeout(() => { window.print(); }, 400);
        });
      </script>
    </body>
    </html>
  `;

  printWin.document.open();
  printWin.document.write(reportHtml);
  printWin.document.close();
}
```

---

## 3. How to Wire This to the Dashboard Toolbar

On both `#audit-logs` and `#reports`:

```tsx
<div className="flex items-center gap-2">
  {/* Existing CSV Export Button */}
  <button onClick={handleExportCsv} className="...">
    <Download className="w-4 h-4 mr-1.5" />
    Export CSV
  </button>

  {/* New PDF Export Button */}
  <button
    onClick={() => exportAuditLogsToPdf({
      logs: currentFilteredLogs,
      filters: {
        category: selectedCategory,
        user: filterUserEmail,
        startDate: startDateFilter,
        endDate: endDateFilter,
      },
      poolCashUsdc: poolLiquidityFormatted,
      adminEmail: currentAdminEmail,
    })}
    className="inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 shadow-sm"
  >
    <Printer className="w-4 h-4 mr-1.5" />
    Print / Save as PDF
  </button>
</div>
```
