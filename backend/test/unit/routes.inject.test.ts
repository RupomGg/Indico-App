import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { FastifyInstance } from "fastify";

describe("HTTP Route Adversarial & Corner-Case Injection (PRD §Input Testing §6.1, §6.3)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Health Check", () => {
    it("GET /health returns 200 OK with timestamp", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("Protected Routes without Authentication (Reject with 401)", () => {
    it("GET /api/v1/profile without auth header returns 401", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/profile",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/profile/wallet without auth header returns 401", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/profile/wallet",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("PATCH /api/v1/profile with valid payload but without auth header returns 401", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/profile",
        payload: {
          currentPassword: "CurrentPassword123!",
          newPassword: "NewSecretPassword123!",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/profile/wallet/bind with valid payload but without auth header returns 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/profile/wallet/bind",
        payload: {
          walletAddress: "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1",
          accountRef: "0x0408fa7451b13cb6c98a988fa2a2a839241912dcc685d3dfd53edb27fad2d45d",
          signature: "0x" + "a".repeat(130),
          message: "bind wallet",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Adversarial Payloads on POST /api/v1/auth/register (PRD §Input Testing)", () => {
    const adversarialPayloads: [string, any][] = [
      ["Empty payload object", {}],
      ["Missing password", { email: "user@example.com" }],
      ["Missing email", { password: "ValidPassword123!" }],
      ["Null fields", { email: null, password: null }],
      ["Wrong field types (numbers)", { email: 99999, password: 12345 }],
      ["Wrong field types (booleans)", { email: true, password: false }],
      ["Wrong field types (arrays)", { email: ["user@example.com"], password: ["pass"] }],
      ["Wrong field types (nested objects)", { email: { address: "user@example.com" }, password: {} }],
      ["SQL injection fragment in email", { email: "admin' OR 1=1; --", password: "Password123!" }],
      ["SQL injection fragment in password", { email: "valid@example.com", password: "' OR '1'='1" }],
      ["Script tag (XSS) payload", { email: "<script>alert(1)</script>@test.com", password: "<script>" }],
      ["Password below minimum length (7 chars)", { email: "valid@example.com", password: "1234567" }],
      ["Password exceeding maximum length (129 chars)", { email: "valid@example.com", password: "a".repeat(129) }],
      ["Email with zero-byte character", { email: "test\0@example.com", password: "ValidPassword123!" }],
      ["Huge string payload (50KB)", { email: "a".repeat(50000) + "@example.com", password: "ValidPassword123!" }],
    ];

    it.each(adversarialPayloads)("Adversarial case '%s' returns 400 Bad Request and NEVER 500", async (_desc, payload) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload,
      });

      // Must be 400 Bad Request, never 500 Internal Server Error
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
    });
  });

  describe("Malformed HTTP Requests & Syntax Corner Cases", () => {
    it("Corrupted JSON body returns 400 Bad Request and never crashes server", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        headers: { "content-type": "application/json" },
        payload: '{"email": "broken-json,',
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("Non-existent endpoint returns 404 Not Found structured error", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/non-existent-route-xyz",
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.message).toBeDefined();
    });

    it("Wrong HTTP method on known route returns 404 or 405, never 500", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/login",
      });
      expect([404, 405]).toContain(response.statusCode);
    });
  });

  describe("Terms & Assets Route Injection & Security (PRD §4.1, §4.2)", () => {
    it("GET /api/v1/terms/current returns 200 OK with terms text and termsHash (Public)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/terms/current",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.version).toBe("1.0.0");
      expect(body.termsHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(body.content).toContain("Indico");
    });

    it("GET /api/v1/terms/status without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/terms/status",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/terms/prepare-sign without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/terms/prepare-sign",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/assets/presigned-upload without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/assets/presigned-upload",
        payload: {
          fileName: "doc.pdf",
          fileSizeBytes: 1000,
          mimeType: "application/pdf",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/assets/submit without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/assets/submit",
        payload: {
          uploadId: "mock-upload",
          docHash: "0x" + "a".repeat(64),
          assetType: 1,
          declaredValueUsdc: "1000.000000",
          referenceNumber: "REF-1",
          issueDate: "2026-10-18",
          issuingParty: "Party",
          description: "Desc",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/assets without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/assets",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("Loans & Credit Route Injection & Security (PRD §4.3, §4.4, §4.5)", () => {
    it("POST /api/v1/loans/prepare-borrow without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/loans/prepare-borrow",
        payload: { amount: "100.000000" },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/loans/prepare-repay without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/loans/prepare-repay",
        payload: { loanId: "1" },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/loans/prepare-extend without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/loans/prepare-extend",
        payload: { loanId: "1" },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/credit/prepare-spend without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/credit/prepare-spend",
        payload: {
          merchantAddress: "0x3333333333333333333333333333333333333333",
          amount: "50.000000",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("Malformed body payloads on /prepare-borrow return 400 Bad Request, never 500", async () => {
      const malformedPayloads = [
        {},
        { amount: "" },
        { amount: "abc" },
        { amount: "-100" },
        { amount: "100.1234567" },
        { extra: "junk" },
      ];

      for (const payload of malformedPayloads) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/loans/prepare-borrow",
          headers: { authorization: "Bearer invalid-token" },
          payload,
        });
        // 400 validation error or 401 unauthorized, never 500
        expect([400, 401]).toContain(response.statusCode);
      }
    });

    it("Malformed body payloads on /prepare-spend return 400 Bad Request, never 500", async () => {
      const malformedPayloads = [
        {},
        { merchantAddress: "not-an-address", amount: "50.000000" },
        { merchantAddress: "0x123", amount: "50.000000" },
        { merchantAddress: "0x3333333333333333333333333333333333333333", amount: "not-a-number" },
      ];

      for (const payload of malformedPayloads) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/credit/prepare-spend",
          headers: { authorization: "Bearer invalid-token" },
          payload,
        });
        expect([400, 401]).toContain(response.statusCode);
      }
    });
  });

  describe("Merchants & History Route Injection & Security (PRD §4.3, §4.4)", () => {
    it("GET /api/v1/merchants without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/merchants",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/merchants/:id without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/merchants/m-123",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/history/balance without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/history/balance",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/history/loans without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/history/loans",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/history/loans/:loanId without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/history/loans/1",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Admin Route Injection & Strict RBAC (PRD §4.7 AD-01; Gate G10)", () => {
    it("POST /api/v1/admin/auth/login with malformed body returns 400 Bad Request", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/auth/login",
        payload: { email: "not-an-email" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
    });

    it("GET /api/v1/admin/users without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/admin/users with non-admin / user token returns 403 Forbidden (RBAC Guard)", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const { env } = await import("../../src/config/env.js");
      const userToken = jwt.sign(
        { id: "user-123", email: "user@indico.com", role: "USER", domain: "user" },
        env.JWT_SECRET
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("GET /api/v1/admin/pool without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/pool",
      });
      expect(response.statusCode).toBe(401);
    });

    it("GET /api/v1/admin/loans without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/loans",
      });
      expect(response.statusCode).toBe(401);
    });

    it("GET /api/v1/admin/safe-status without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/safe-status",
      });
      expect(response.statusCode).toBe(401);
    });

    it("GET /api/v1/admin/audit-logs without auth header returns 401 Unauthorized", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-logs",
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

