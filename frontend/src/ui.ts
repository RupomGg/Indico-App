/**
 * Indico UI Helpers: Toasts, Modals, Formatters & Explorers
 */

export function showToast(message: string, type: "success" | "error" | "info" | "warning" = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icon =
    type === "success"
      ? "✓"
      : type === "error"
      ? "✕"
      : type === "warning"
      ? "⚠️"
      : "ℹ";

  toast.innerHTML = `
    <span style="font-weight: 800; font-size: 16px;">${icon}</span>
    <div style="flex: 1; font-size: 13px;">${message}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(40px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

export function showModal(options: {
  title: string;
  contentHtml: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  onConfirm?: () => Promise<void> | void;
}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  backdrop.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3 style="font-size: 17px; font-weight: 700;">${options.title}</h3>
        <button id="modal-close-btn" style="background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer;">&times;</button>
      </div>
      <div class="modal-body">
        ${options.contentHtml}
      </div>
      <div class="modal-footer">
        <button id="modal-cancel-btn" class="btn btn-outline btn-sm">${options.cancelText || "Cancel"}</button>
        <button id="modal-confirm-btn" class="btn ${options.isDanger ? "btn-danger" : "btn-primary"} btn-sm">${options.confirmText || "Confirm"}</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.style.opacity = "0";
    setTimeout(() => backdrop.remove(), 150);
  };

  backdrop.querySelector("#modal-close-btn")?.addEventListener("click", close);
  backdrop.querySelector("#modal-cancel-btn")?.addEventListener("click", close);

  backdrop.querySelector("#modal-confirm-btn")?.addEventListener("click", async () => {
    const confirmBtn = backdrop.querySelector("#modal-confirm-btn") as HTMLButtonElement;
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      if (options.onConfirm) await options.onConfirm();
      close();
    } catch (err: any) {
      showToast(err.message || "Action failed", "error");
      if (confirmBtn) confirmBtn.disabled = false;
    }
  });
}

export function truncateAddress(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatUsdc(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "0.00";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function formatDate(timestamp: number | string | Date): string {
  if (!timestamp) return "-";
  const d =
    typeof timestamp === "number"
      ? new Date(timestamp > 1e11 ? timestamp : timestamp * 1000)
      : new Date(timestamp);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function explorerTxLink(txHash?: string | null): string {
  if (!txHash) return `<span style="color: var(--text-faint)">None</span>`;
  const url = `https://sepolia.basescan.org/tx/${txHash}`;
  return `<a href="${url}" target="_blank" rel="noreferrer" style="color: var(--pink-accent); font-family: var(--font-mono); text-decoration: none; font-size: 12px;">${truncateAddress(txHash)} ↗</a>`;
}

export function explorerAddressLink(addr?: string | null): string {
  if (!addr) return `<span style="color: var(--text-faint)">None</span>`;
  const url = `https://sepolia.basescan.org/address/${addr}`;
  return `<a href="${url}" target="_blank" rel="noreferrer" style="color: var(--cyan-accent); font-family: var(--font-mono); text-decoration: none; font-size: 12px;">${truncateAddress(addr)} ↗</a>`;
}
