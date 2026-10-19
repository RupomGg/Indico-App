import * as fc from "fast-check";

export interface DiscoveredRoute {
  method: string;
  url: string;
  params: string[];
}

/**
 * Extracts URL parameter names from a Fastify route URL.
 * e.g. "/api/v1/admin/merchants/:id/services/:serviceId" -> ["id", "serviceId"]
 */
export function extractRouteParams(url: string): string[] {
  const matches = [...url.matchAll(/:([a-zA-Z0-9_]+)/g)];
  return matches.map((m) => m[1] as string);
}

/**
 * Substitutes route parameters with specific or adversarial values.
 */
export function resolveRouteUrl(
  url: string,
  params: Record<string, string | number>
): string {
  let resolved = url;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  return resolved;
}

/**
 * Validates that an HTTP response conforms strictly to Indico error isolation standards:
 * 1. Status code is strictly < 500 (never 500 Internal Server Error).
 * 2. Response body is valid JSON.
 * 3. Zero database, Prisma, or SQL traces leaked.
 * 4. Zero stack traces or file system paths leaked.
 * 5. Structured 4xx responses follow { success: false, error: { code, message } }.
 */
export function assertNo500AndNoLeaks(
  response: { statusCode: number; body: string; headers: Record<string, any> },
  context: { method: string; url: string; payloadSummary?: string }
) {
  // 1. Strict status check: NEVER 500
  if (response.statusCode >= 500) {
    throw new Error(
      `CRITICAL VIOLATION: Route [${context.method}] ${context.url} returned status ${response.statusCode} (500 Internal Server Error).\n` +
      `Payload Context: ${context.payloadSummary ?? "N/A"}\n` +
      `Response Body: ${response.body}`
    );
  }

  // 2. Body inspection for leaked internals
  const rawBody = response.body;

  const forbiddenLeakedPatterns = [
    /PrismaClient/i,
    /prisma:/i,
    /Invalid `prisma\./i,
    /database server/i,
    /at\s+[\w\d_.]+\s+\(.*:[0-9]+:[0-9]+\)/, // Stack trace line format: "at Object.fn (/path/file.ts:1:1)"
    /file:\/\/\//i,
    /SELECT\s+.*\s+FROM/i,
    /INSERT\s+INTO\s+/i,
    /UPDATE\s+.*\s+SET/i,
    /DELETE\s+FROM\s+/i,
    /execution reverted:/i,
  ];

  for (const pattern of forbiddenLeakedPatterns) {
    if (pattern.test(rawBody)) {
      throw new Error(
        `SECURITY VIOLATION: Route [${context.method}] ${context.url} leaked internal diagnostics.\n` +
        `Matched forbidden pattern: ${pattern}\n` +
        `Response Body: ${rawBody}`
      );
    }
  }

  // 3. Response format validation for JSON responses
  if (rawBody.trim().length > 0) {
    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // Non-JSON responses are only permissible for documentation assets (e.g. /docs)
      if (!context.url.startsWith("/docs")) {
        throw new Error(
          `FORMAT VIOLATION: Route [${context.method}] ${context.url} returned non-JSON body.\n` +
          `Response Body: ${rawBody}`
        );
      }
      return;
    }

    // Structured error envelope validation for 4xx responses
    if (response.statusCode >= 400) {
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(
          `ENVELOPE VIOLATION: Route [${context.method}] ${context.url} returned non-object error envelope.`
        );
      }
      if (parsed.success !== false) {
        throw new Error(
          `ENVELOPE VIOLATION: Route [${context.method}] ${context.url} returned ${response.statusCode} without success: false. Body: ${rawBody}`
        );
      }
      if (!parsed.error || typeof parsed.error !== "object") {
        throw new Error(
          `ENVELOPE VIOLATION: Route [${context.method}] ${context.url} returned error response missing error object.`
        );
      }
      if (typeof parsed.error.code !== "string" || !parsed.error.code) {
        throw new Error(
          `ENVELOPE VIOLATION: Route [${context.method}] ${context.url} error.code must be a non-empty string.`
        );
      }
      if (typeof parsed.error.message !== "string" || !parsed.error.message) {
        throw new Error(
          `ENVELOPE VIOLATION: Route [${context.method}] ${context.url} error.message must be a non-empty string.`
        );
      }
    }
  }
}

/**
 * Arbitrary generator for structurally random, adversarial payloads.
 * Generates primitives, invalid types, boundary strings, injection strings, malformed numbers, and arbitrary objects.
 */
export const adversarialArbitrary = fc.oneof(
  // 1. Primitives
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.float({ noNaN: false, noDefaultInfinity: false }),
  fc.boolean(),
  fc.string(),
  fc.constant(""),
  fc.constant("   "),
  
  // 2. High-risk string attack vectors
  fc.constant("'' OR '1'='1' --"),
  fc.constant("admin' --"),
  fc.constant("UNION SELECT null, null, null; --"),
  fc.constant("<script>alert(1)</script>"),
  fc.constant("<img src=x onerror=alert(1)>"),
  fc.constant("../../../../../etc/passwd"),
  fc.constant("..\\..\\..\\windows\\win.ini"),
  fc.constant("\x00\x01\x02\x03\x04\x05"),
  fc.constant("🎉🔥💰🚀👾" + "⚡".repeat(50)),
  fc.constant("A".repeat(25_000)), // Large string payload
  fc.constant("NaN"),
  fc.constant("Infinity"),
  fc.constant("-Infinity"),
  fc.constant("-1"),
  fc.constant("0x0000000000000000000000000000000000000000"),
  fc.constant("0x" + "a".repeat(64)),

  // 3. Arrays
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), { maxLength: 8 }),
  fc.constant([]),

  // 4. Arbitrary Objects
  fc.constant({}),
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 25 }),
    fc.oneof(
      fc.string(),
      fc.integer(),
      fc.float(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.string(), { maxLength: 3 }),
      fc.dictionary(fc.string({ maxLength: 10 }), fc.string({ maxLength: 10 }), { maxKeys: 2 })
    ),
    { maxKeys: 8 }
  ),

  // 5. Partially conforming corrupted records
  fc.record(
    {
      email: fc.oneof(fc.emailAddress(), fc.string(), fc.integer(), fc.constant(null)),
      password: fc.oneof(fc.string(), fc.integer(), fc.constant(""), fc.constant(null)),
      token: fc.oneof(fc.uuid(), fc.string(), fc.constant("")),
      amount: fc.oneof(fc.string(), fc.integer(), fc.float(), fc.constant("-100"), fc.constant("10.1234567")),
      walletAddress: fc.oneof(fc.string(), fc.constant("0xinvalid"), fc.constant(null)),
      loanId: fc.oneof(fc.string(), fc.integer(), fc.constant("-1")),
      accountRef: fc.oneof(fc.string(), fc.constant("0xshort")),
      signature: fc.oneof(fc.string(), fc.constant("0xinvalid")),
      serviceName: fc.oneof(fc.string(), fc.constant("")),
      priceUsdc: fc.oneof(fc.string(), fc.integer(), fc.constant("0")),
      status: fc.oneof(fc.string(), fc.constant("INVALID_STATUS")),
    },
    { withDeletedKeys: true }
  )
);
