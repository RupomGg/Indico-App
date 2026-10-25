/**
 * Indico Asset Ledger - Typed Backend API Client
 * Connects to Fastify API at http://localhost:3000/api/v1
 */

const API_BASE = "http://localhost:3000/api/v1";

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export class ApiClient {
  public static userToken: string | null = localStorage.getItem("indico_user_token");
  public static adminToken: string | null = localStorage.getItem("indico_admin_token");

  public static setUserToken(token: string | null) {
    this.userToken = token;
    if (token) localStorage.setItem("indico_user_token", token);
    else localStorage.removeItem("indico_user_token");
  }

  public static setAdminToken(token: string | null) {
    this.adminToken = token;
    if (token) localStorage.setItem("indico_admin_token", token);
    else localStorage.removeItem("indico_admin_token");
  }

  public static async request<T = any>(
    path: string,
    options: RequestInit = {},
    tokenDomain: "user" | "admin" = "user"
  ): Promise<T> {
    const token = tokenDomain === "admin" ? this.adminToken : this.userToken;

    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    };

    if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMsg = data?.error?.message || data?.message || `HTTP ${response.status} Error`;
      const code = data?.error?.code || "REQUEST_FAILED";
      const err = new Error(errorMsg);
      (err as any).code = code;
      (err as any).status = response.status;
      (err as any).details = data?.error?.details;
      throw err;
    }

    return data;
  }

  // --- HEALTH & STATUS ---
  static async checkHealth() {
    const res = await fetch("http://localhost:3000/health");
    return res.json();
  }

  // --- AUTH (U-01, U-02, U-03) ---
  static async register(email: string, password: string) {
    return this.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  static async login(email: string, password: string) {
    const res = await this.request<any>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const token = res?.token || res?.data?.token;
    if (token) {
      this.setUserToken(token);
    }
    return res;
  }

  static async verifyEmail(token: string) {
    return this.request("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }

  static async forgotPassword(email: string) {
    return this.request("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  static async resetPassword(token: string, newPassword: string) {
    return this.request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
  }

  static async logout() {
    try {
      await this.request("/auth/logout", { method: "POST" });
    } finally {
      this.setUserToken(null);
    }
  }

  // --- PROFILE & WALLET (U-04, U-05, U-09, U-10) ---
  static async getProfile() {
    return this.request("/profile", { method: "GET" });
  }

  static async updateProfile(currentPassword: string, newPassword: string) {
    return this.request("/profile", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  static async getWalletStatus() {
    return this.request("/profile/wallet", { method: "GET" });
  }

  static async bindWallet(payload: {
    walletAddress: string;
    accountRef: string;
    signature: string;
    message: string;
  }) {
    return this.request("/profile/wallet/bind", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // --- TERMS (U-06, U-07, U-08) ---
  static async getCurrentTerms() {
    return this.request("/terms/current", { method: "GET" });
  }

  static async getTermsStatus() {
    return this.request("/terms/status", { method: "GET" });
  }

  static async prepareSignTerms() {
    return this.request("/terms/prepare-sign", { method: "POST" });
  }

  // --- ASSETS (A-01 to A-09) ---
  static async createPresignedUpload(payload: {
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
  }) {
    return this.request<{
      uploadId: string;
      uploadUrl: string;
      expiresAt: string;
      maxSizeBytes: number;
    }>("/assets/presigned-upload", {
      method: "POST",
      body: JSON.stringify({
        fileName: payload.fileName,
        fileSizeBytes: payload.fileSizeBytes,
        mimeType: payload.mimeType,
      }),
    });
  }

  static async uploadFileChunk(uploadId: string, file: Blob, filename = "document.pdf") {
    const formData = new FormData();
    formData.append("file", file, filename);

    return this.request(`/assets/upload/${uploadId}`, {
      method: "POST",
      body: formData,
    });
  }

  static async submitAsset(payload: {
    uploadId: string;
    docHash: string;
    assetType: number;
    declaredValueUsdc: string;
    referenceNumber: string;
    issueDate: string;
    issuingParty: string;
    description: string;
  }) {
    return this.request<any>("/assets/submit", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  static async prepareRegisterAsset(assetId: string) {
    return this.request(`/assets/${assetId}/prepare-register`, {
      method: "POST",
    });
  }

  static async listAssets(page = 1, limit = 20) {
    return this.request(`/assets?page=${page}&limit=${limit}`, { method: "GET" });
  }

  static async getAssetDetail(assetId: string) {
    return this.request(`/assets/${assetId}`, { method: "GET" });
  }

  // --- LOANS (L-01 to L-11, R-01 to R-06) ---
  static async prepareBorrow(amount: string) {
    return this.request("/loans/prepare-borrow", {
      method: "POST",
      body: JSON.stringify({ amount }),
    });
  }

  static async prepareRepay(loanId: string) {
    return this.request("/loans/prepare-repay", {
      method: "POST",
      body: JSON.stringify({ loanId }),
    });
  }

  static async prepareExtend(loanId: string) {
    return this.request("/loans/prepare-extend", {
      method: "POST",
      body: JSON.stringify({ loanId }),
    });
  }

  // --- CREDIT & MERCHANTS (C-01 to C-08) ---
  static async listMerchants(q?: string) {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.request(`/merchants${query}`, { method: "GET" });
  }

  static async getMerchant(id: string) {
    return this.request(`/merchants/${id}`, { method: "GET" });
  }

  static async prepareSpend(merchantAddress: string, amount: string) {
    return this.request("/credit/prepare-spend", {
      method: "POST",
      body: JSON.stringify({ merchantAddress, amount }),
    });
  }

  // --- READ-MODEL HISTORY (Rule 9) ---
  static async getBalanceHistory() {
    return this.request("/history/balance", { method: "GET" });
  }

  static async getLoansHistory(status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/history/loans${query}`, { method: "GET" });
  }

  static async getUserTransactions() {
    return this.request("/history/transactions", { method: "GET" });
  }

  // --- ADMIN PORTAL (AD-01 to AD-22) ---
  static async adminLogin(email: string, password: string) {
    const res = await this.request<any>(
      "/admin/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      "admin"
    );
    const token = res?.token || res?.data?.token;
    if (token) {
      this.setAdminToken(token);
    }
    return res;
  }

  static async adminMe() {
    return this.request("/admin/auth/me", { method: "GET" }, "admin");
  }

  static async adminListUsers(params?: { status?: string; page?: number; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.status) qs.append("status", params.status);
    if (params?.page) qs.append("page", String(params.page));
    if (params?.limit) qs.append("limit", String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(`/admin/users${query}`, { method: "GET" }, "admin");
  }

  static async adminGetUserDetail(userId: string) {
    return this.request(`/admin/users/${userId}`, { method: "GET" }, "admin");
  }

  static async adminApproveUser(userId: string) {
    return this.request(`/admin/users/${userId}/approve`, { method: "POST" }, "admin");
  }

  static async adminRejectUser(userId: string) {
    return this.request(`/admin/users/${userId}/reject`, { method: "POST" }, "admin");
  }

  static async adminListMerchants() {
    return this.request("/admin/merchants", { method: "GET" }, "admin");
  }

  static async adminGetMerchantServices(merchantId: string) {
    return this.request(`/admin/merchants/${merchantId}/services`, { method: "GET" }, "admin");
  }

  static async adminCreateMerchant(payload: {
    name: string;
    contactEmail: string;
    walletAddress: string;
    agreementStatus?: "NOT_SENT" | "SENT" | "SIGNED";
    initialService?: {
      name: string;
      price: string;
      description?: string;
    };
  }) {
    return this.request("/admin/merchants", { method: "POST", body: JSON.stringify(payload) }, "admin");
  }

  static async adminSyncMerchantChain(merchantId: string) {
    return this.request(`/admin/merchants/${merchantId}/sync-chain`, { method: "POST" }, "admin");
  }

  static async adminAddMerchantService(
    merchantId: string,
    payload: { name: string; price: string; description: string } | { serviceName: string; priceUsdc: string; description?: string }
  ) {
    const body = {
      name: (payload as any).name ?? (payload as any).serviceName,
      price: (payload as any).price ?? (payload as any).priceUsdc,
      description: payload.description || `${(payload as any).name ?? (payload as any).serviceName} service`,
    };
    return this.request(
      `/admin/merchants/${merchantId}/services`,
      { method: "POST", body: JSON.stringify(body) },
      "admin"
    );
  }

  static async adminUpdateMerchantService(
    merchantId: string,
    serviceId: string,
    payload: { name?: string; price?: string; description?: string } | { serviceName?: string; priceUsdc?: string; description?: string }
  ) {
    const body: Record<string, any> = {};
    const name = (payload as any).name ?? (payload as any).serviceName;
    const price = (payload as any).price ?? (payload as any).priceUsdc;
    if (name !== undefined) body.name = name;
    if (price !== undefined) body.price = price;
    if (payload.description !== undefined) body.description = payload.description;

    return this.request(
      `/admin/merchants/${merchantId}/services/${serviceId}`,
      { method: "PATCH", body: JSON.stringify(body) },
      "admin"
    );
  }

  static async adminDeleteMerchantService(merchantId: string, serviceId: string) {
    return this.request(
      `/admin/merchants/${merchantId}/services/${serviceId}`,
      { method: "DELETE" },
      "admin"
    );
  }

  static async adminSendMerchantAgreement(merchantId: string) {
    return this.request(
      `/admin/merchants/${merchantId}/agreement/send`,
      { method: "POST" },
      "admin"
    );
  }

  static async adminSignMerchantAgreement(merchantId: string, storageKey = "signed-agreements/default.pdf") {
    return this.request(
      `/admin/merchants/${merchantId}/agreement/sign`,
      { method: "POST", body: JSON.stringify({ storageKey }) },
      "admin"
    );
  }

  static async adminGetPool() {
    return this.request("/admin/pool", { method: "GET" }, "admin");
  }

  static async adminGetLoans(page = 1, limit = 20) {
    return this.request(`/admin/loans?page=${page}&limit=${limit}`, { method: "GET" }, "admin");
  }

  static async adminGetSafeStatus() {
    return this.request("/admin/safe-status", { method: "GET" }, "admin");
  }

  static async adminGetAuditLogs(params?: {
    actionType?: string;
    entityType?: string;
    adminId?: string;
    page?: number;
    limit?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.actionType) qs.append("actionType", params.actionType);
    if (params?.entityType) qs.append("entityType", params.entityType);
    if (params?.adminId) qs.append("adminId", params.adminId);
    if (params?.page) qs.append("page", String(params.page));
    if (params?.limit) qs.append("limit", String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(`/admin/audit-logs${query}`, { method: "GET" }, "admin");
  }
}
