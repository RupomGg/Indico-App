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
});
