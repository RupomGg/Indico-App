import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/config/env.js";

/**
 * Indexer and keeper timing settings:
 * | Variable          | Absent  | Valid examples     | Refused                          |
 * |-------------------|---------|--------------------|----------------------------------|
 * | POLL_INTERVAL_MS  | 15000   | 1000, 3000, 60000  | 0, 999, -1, "abc", 1.5           |
 * | SWEEP_INTERVAL_MS | 60000   | 5000, 300000       | 0, 4999, "abc"                   |
 * | LOG_BLOCK_RANGE   | 10      | 1, 10, 2000, 10000 | 0, 10001, -5, "x"                |
 */
const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) };

describe("Indexer timing settings", () => {
  it("defaults to the free-plan friendly values", () => {
    const env = parseEnv(base);
    expect(env.POLL_INTERVAL_MS).toBe(15000);
    expect(env.SWEEP_INTERVAL_MS).toBe(60000);
    expect(env.LOG_BLOCK_RANGE).toBe(10);
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
