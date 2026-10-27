import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fc from "fast-check";
import jwt from "jsonwebtoken";
import { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { prisma } from "../../src/lib/prisma.js";
import { publicClient } from "../../src/lib/viem.js";
import {
  DiscoveredRoute,
  extractRouteParams,
  resolveRouteUrl,
  assertNo500AndNoLeaks,
  adversarialArbitrary,
} from "../../src/lib/routeCrawler.js";

/**
 * ============================================================================
 * PARAMETER PARTITION TABLE: Generic Route Crawler & Adversarial Sweep (P4.7)
 * ============================================================================
 * Route Table Dimensions:
 * - Method: GET | POST | PUT | PATCH | DELETE
 * - Route Params: Static paths, paths with :id, :loanId, :serviceId
 * - Auth Context: Unauthenticated | Invalid Bearer | Valid User | Valid Admin
 *
 * Fast-Check Payload Partition Table (1,000 runs per route):
 * ----------------------------------------------------------------------------
 * Partition         | Sample Input                         | Expected Outcome
 * ------------------+--------------------------------------+------------------
 * Non-object bodies | null, undefined, 42, true, "string"   | 400 / 415 / 4xx
 * Array bodies      | [], [1, 2], ["payload"], [{}]        | 400 Bad Request
 * Empty object      | {}                                   | 400 / 4xx (or 200 if valid empty)
 * Unknown keys      | { unknown_foo: "bar", __proto__: {} }| 400 / 4xx
 * String boundaries | "", " ", 25KB string, unicode, emojis| 400 / 4xx
 * Injection vectors | SQL injection, XSS, Path traversal   | 400 / 4xx, sanitized
 * Malformed numbers | NaN, Infinity, -1, 1e20, float 0.123 | 400 / 4xx
 * Corrupted headers | Invalid Bearer, non-hex, null bytes  | 401 / 403 / 400
 * Random query-strs | ?foo=bar&array[]=1&special=%00       | 400 / 4xx (or 200)
 * Random path-params| /:id -> UUID, non-UUID, 0, -1, sql   | 400 / 404 / 4xx
 * ----------------------------------------------------------------------------
 * Invariant Asserts (Enforced on 100% of Injections):
 * 1. statusCode !== 500 (Strictly < 500 across all routes)
 * 2. Zero database, Prisma, or SQL traces leaked into response body
 * 3. Zero stack traces or file system path disclosures
 * 4. Error response adheres strictly to Indico Standard Error Envelope:
 *    { success: false, error: { code: string, message: string } }
 * ============================================================================
 */

describe("Generic No-500 Adversarial Route Sweep & Integration (P4.7 / PRD §Input Testing)", () => {
  let app: FastifyInstance;
  const discoveredRoutes: DiscoveredRoute[] = [];

  // Generate test tokens for auth fuzzing
  const validUserToken = jwt.sign(
    {
      userId: "test-user-uuid-1234",
      email: "testuser@example.com",
      role: "USER",
      domain: "user",
    },
    env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const validAdminToken = jwt.sign(
    {
      id: "test-admin-uuid-1234",
      adminId: "test-admin-uuid-1234",
      email: env.ADMIN_EMAIL,
      role: "ADMIN",
      domain: "admin",
    },
    env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  beforeAll(async () => {
    // Mock all Prisma models to prevent TCP network socket connection delays
    const models = [
      "user",
      "session",
      "walletBinding",
      "asset",
      "merchant",
      "merchantService",
      "merchantAgreement",
      "adminUser",
      "auditLog",
      "creditBalance",
      "loan",
      "poolDeposit",
      "chainEvent",
      "indexerState",
    ] as const;

    for (const m of models) {
      const model = (prisma as any)[m];
      if (model) {
        if (model.findUnique) vi.spyOn(model, "findUnique").mockResolvedValue(null);
        if (model.findFirst) vi.spyOn(model, "findFirst").mockResolvedValue(null);
        if (model.findMany) vi.spyOn(model, "findMany").mockResolvedValue([]);
        if (model.count) vi.spyOn(model, "count").mockResolvedValue(0);
        if (model.create) vi.spyOn(model, "create").mockResolvedValue({} as any);
        if (model.update) vi.spyOn(model, "update").mockResolvedValue({} as any);
        if (model.updateMany) vi.spyOn(model, "updateMany").mockResolvedValue({ count: 0 });
        if (model.delete) vi.spyOn(model, "delete").mockResolvedValue({} as any);
        if (model.deleteMany) vi.spyOn(model, "deleteMany").mockResolvedValue({ count: 0 });
      }
    }

    // Specific session mock for valid user sessions
    vi.spyOn(prisma.session, "findUnique").mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash) {
        return {
          id: "test-session-id-1234",
          userId: "test-user-uuid-1234",
          tokenHash: args.where.tokenHash,
          expiresAt: new Date(Date.now() + 3600000),
          revokedAt: null,
          createdAt: new Date(),
          user: {
            id: "test-user-uuid-1234",
            email: "testuser@example.com",
            isEmailVerified: true,
            isApproved: true,
          },
        } as any;
      }
      return null;
    });

    // Mock adminUser for valid admin checks
    vi.spyOn(prisma.adminUser, "findUnique").mockImplementation(async () => {
      return {
        id: "test-admin-uuid-1234",
        email: env.ADMIN_EMAIL,
        passwordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz",
        role: "ADMIN",
        createdAt: new Date(),
      } as any;
    });

    // Mock Viem publicClient
    vi.spyOn(publicClient, "getBalance").mockResolvedValue(1000000000000000000n);
    vi.spyOn(publicClient, "readContract").mockResolvedValue(1000000000n as any);
    vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
    vi.spyOn(publicClient, "estimateGas").mockResolvedValue(50000n);
    vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(100000000n);

    app = buildApp({
      onRoute: (routeOptions) => {
        // Collect all public and API routes; skip internal swagger asset endpoints
        const url = routeOptions.url;
        if (url.startsWith("/docs") || url.startsWith("/health")) {
          return;
        }
        const methods = Array.isArray(routeOptions.method)
          ? routeOptions.method
          : [routeOptions.method];

        for (const m of methods) {
          if (m !== "HEAD" && m !== "OPTIONS") {
            discoveredRoutes.push({
              method: m,
              url,
              params: extractRouteParams(url),
            });
          }
        }
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("successfully discovers all registered API routes", () => {
    expect(discoveredRoutes.length).toBeGreaterThanOrEqual(25);
    // Verify core prefixes exist
    const prefixes = discoveredRoutes.map((r) => r.url);
    expect(prefixes.some((u) => u.startsWith("/api/v1/auth"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/profile"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/terms"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/assets"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/loans"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/credit"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/merchants"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/history"))).toBe(true);
    expect(prefixes.some((u) => u.startsWith("/api/v1/admin"))).toBe(true);
  });

  describe("Automated Dynamic Route Crawler (1,000 Adversarial Injections per Route)", () => {
    // Generate sample adversarial payloads in advance for high-speed in-memory injection
    const samplePayloads = fc.sample(adversarialArbitrary, 1000);

    // Auth header generator arbitrary
    const authHeaders = [
      {}, // No auth
      { authorization: "Bearer " }, // Empty bearer
      { authorization: "Bearer invalid.token.garbage" }, // Corrupted token
      { authorization: "Bearer " + "a".repeat(1024) }, // Oversized token
      { authorization: "Basic dXNlcjpwYXNz" }, // Wrong scheme
      { authorization: `Bearer ${validUserToken}` }, // Valid user token
      { authorization: `Bearer ${validAdminToken}` }, // Valid admin token
    ];

    it("executes 1,000 adversarial payloads per discovered route with zero 500s and zero leaks", async () => {
      // Iterate through every discovered route
      for (const route of discoveredRoutes) {
        // Resolve URL params with synthetic and adversarial values
        const paramValues: Record<string, any> = {};
        for (const p of route.params) {
          paramValues[p] = "test-" + p + "-value-12345";
        }
        const targetUrl = resolveRouteUrl(route.url, paramValues);

        // Run 1,000 structurally random adversarial injections against this route
        for (let i = 0; i < samplePayloads.length; i++) {
          const payload = samplePayloads[i];
          const header = authHeaders[i % authHeaders.length];

          const injectOptions: any = {
            method: route.method,
            url: targetUrl,
            headers: {
              ...header,
            },
          };

          // Attach payload if method is POST, PUT, or PATCH
          if (["POST", "PUT", "PATCH"].includes(route.method)) {
            injectOptions.payload = payload;
          } else {
            // For GET/DELETE, inject query parameters
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
              injectOptions.query = payload;
            }
          }

          const response = await app.inject(injectOptions);

          // Assert zero 500s, valid JSON, zero leaks, and strict Indico envelope
          assertNo500AndNoLeaks(response, {
            method: route.method,
            url: targetUrl,
            payloadSummary: typeof payload === "object" ? JSON.stringify(payload).slice(0, 100) : String(payload),
          });
        }
      }
    }, 120000); // 120s timeout for comprehensive 30,000+ payload sweep
  });

  describe("Route Parameter Injection Sweep (:id, :loanId, :serviceId)", () => {
    const adversarialParams = [
      "'' OR 1=1 --",
      "<script>alert(1)</script>",
      "../../../../etc/passwd",
      "-1",
      "0",
      "9999999999999999999999999999999999999999",
      "non-existent-uuid",
      "0x0000000000000000000000000000000000000000",
      "🎉🚀👾",
      "%00%00%00",
      "A".repeat(500),
    ];

    it("rejects adversarial URL parameter fragments with 4xx and never 500", async () => {
      const parameterizedRoutes = discoveredRoutes.filter((r) => r.params.length > 0);

      for (const route of parameterizedRoutes) {
        for (const badParam of adversarialParams) {
          const paramsMap: Record<string, string> = {};
          for (const p of route.params) {
            paramsMap[p] = badParam;
          }
          const testUrl = resolveRouteUrl(route.url, paramsMap);

          const response = await app.inject({
            method: route.method,
            url: testUrl,
            headers: {
              authorization: `Bearer ${validAdminToken}`, // supply admin token to isolate param handling
            },
          });

          assertNo500AndNoLeaks(response, {
            method: route.method,
            url: testUrl,
            payloadSummary: `Param injection: ${badParam}`,
          });
        }
      }
    });
  });

  describe("Content-Type & Body Boundary Adversarial Tests", () => {
    it("handles non-JSON Content-Type payloads without crashing with 500", async () => {
      const postRoutes = discoveredRoutes.filter((r) => r.method === "POST");

      for (const route of postRoutes) {
        const testUrl = resolveRouteUrl(route.url, { id: "123", loanId: "1", serviceId: "1" });
        const token =
          route.url.includes("/admin") && !route.url.includes("/admin/auth/login")
            ? validAdminToken
            : validUserToken;

        const response = await app.inject({
          method: "POST",
          url: testUrl,
          headers: {
            "content-type": "text/plain",
            authorization: `Bearer ${token}`,
          },
          payload: "plain text unparseable body",
        });

        assertNo500AndNoLeaks(response, {
          method: "POST",
          url: testUrl,
          payloadSummary: "text/plain payload",
        });
      }
    });

    it("handles malformed JSON syntax gracefully (400 Bad Request, never 500)", async () => {
      const postRoutes = discoveredRoutes.filter((r) => r.method === "POST");

      for (const route of postRoutes) {
        const testUrl = resolveRouteUrl(route.url, { id: "123", loanId: "1", serviceId: "1" });
        const token =
          route.url.includes("/admin") && !route.url.includes("/admin/auth/login")
            ? validAdminToken
            : validUserToken;

        const response = await app.inject({
          method: "POST",
          url: testUrl,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          payload: "{ unquoted_key: invalid_json, ",
        });

        assertNo500AndNoLeaks(response, {
          method: "POST",
          url: testUrl,
          payloadSummary: "Malformed JSON syntax",
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });
});
