import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/config/env.js";

/**
 * Indexer and keeper timing settings:
 * | Variable          | Absent  | Valid examples     | Refused                          |
 * |-------------------|---------|--------------------|----------------------------------|
 * | POLL_INTERVAL_MS  | 15000   | 1000, 3000, 60000  | 0, 999, -1, "abc", 1.5           |
 * | SWEEP_INTERVAL_MS | 60000   | 5000, 300000       | 0, 4999, "abc"                   |
 * | LOG_BLOCK_RANGE   | 200     | 1, 10, 2000, 10000 | 0, 10001, -5, "x"                |
 *
 * Base makes a block every 0.2 s (measured on Sepolia and mainnet, 2026-11-16), so one log query must
 * cover at least a whole poll interval, or the indexer falls further behind every round.
 */
const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) };

describe("Indexer timing settings", () => {
  it("defaults to values that fit Base's public RPC", () => {
    const env = parseEnv(base);
    expect(env.POLL_INTERVAL_MS).toBe(15000);
    expect(env.SWEEP_INTERVAL_MS).toBe(60000);
    expect(env.LOG_BLOCK_RANGE).toBe(200);
  });

  it("by default one log query covers more than a whole poll interval of 0.2 s blocks", () => {
    const env = parseEnv(base);
    expect(env.LOG_BLOCK_RANGE * 200).toBeGreaterThan(env.POLL_INTERVAL_MS);
  });

  it.each([
    ["POLL_INTERVAL_MS", "1000", 1000],
    ["POLL_INTERVAL_MS", "60000", 60000],
    ["SWEEP_INTERVAL_MS", "5000", 5000],
    ["LOG_BLOCK_RANGE", "1", 1],
    ["LOG_BLOCK_RANGE", "10000", 10000],
  ])("%s=%s is accepted", (key, value, expected) => {
    expect((parseEnv({ ...base, [key]: value }) as any)[key]).toBe(expected);
  });

  it.each([
    ["POLL_INTERVAL_MS", "0"],
    ["POLL_INTERVAL_MS", "999"],
    ["POLL_INTERVAL_MS", "-1"],
    ["POLL_INTERVAL_MS", "abc"],
    ["POLL_INTERVAL_MS", "1.5"],
    ["SWEEP_INTERVAL_MS", "4999"],
    ["SWEEP_INTERVAL_MS", "abc"],
    ["LOG_BLOCK_RANGE", "0"],
    ["LOG_BLOCK_RANGE", "10001"],
    ["LOG_BLOCK_RANGE", "-5"],
    ["LOG_BLOCK_RANGE", "x"],
  ])("%s=%s is refused at startup", (key, value) => {
    expect(() => parseEnv({ ...base, [key]: value })).toThrow(key);
  });
});
