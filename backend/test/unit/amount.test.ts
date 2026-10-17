import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseAmountToUnits, formatUnitsToAmount, InvalidAmountError } from "../../src/lib/amount.js";

describe("Amount Parsing and Formatting (PRD §6.4 & Input Testing §6.4)", () => {
  describe("Valid amounts", () => {
    const validCases: [string, bigint][] = [
      ["1", 1_000_000n],
      ["1.0", 1_000_000n],
      ["1.00", 1_000_000n],
      ["1.000000", 1_000_000n],
      ["0.000001", 1n],
      ["0", 0n],
      ["0.0", 0n],
      ["0.1", 100_000n],
      ["123.456789", 123_456_789n],
      ["1000000", 1_000_000_000_000n],
    ];

    it.each(validCases)("parses valid amount %s to %s units", (input, expected) => {
      expect(parseAmountToUnits(input)).toBe(expected);
    });
  });

  describe("Invalid amounts (must reject without unhandled exceptions)", () => {
    const invalidCases: string[] = [
      "1.0000001", // 7 decimals
      "1.1234567", // 7 decimals
      "-1",        // negative
      "-0.5",      // negative decimal
      "+1",        // positive sign
      "1e6",       // scientific notation
      "1E6",
      "0x1",       // hex
      "１",        // full-width unicode digit
      " 1 ",       // whitespace padded
      " 1",
      "1 ",
      "1,000",     // commas
      "Infinity",
      "-Infinity",
      "NaN",
      "1.2.3",     // multiple dots
      "",          // empty string
      ".",
      ".5",        // missing leading zero
      "5.",        // trailing dot
      "abc",
      "null",
      "undefined",
      "01",        // leading zero on integer
    ];

    it.each(invalidCases)("rejects invalid amount: %s", (input) => {
      expect(() => parseAmountToUnits(input)).toThrow(InvalidAmountError);
    });

    it("handles huge 1000-digit number without float overflow", () => {
      const hugeNumber = "9".repeat(1000);
      const units = parseAmountToUnits(hugeNumber);
      expect(units).toBe(BigInt(hugeNumber) * 1_000_000n);
    });
  });

  describe("Formatting", () => {
    it("formats integer units to canonical 6-decimal string", () => {
      expect(formatUnitsToAmount(0n)).toBe("0.000000");
      expect(formatUnitsToAmount(1n)).toBe("0.000001");
      expect(formatUnitsToAmount(1_000_000n)).toBe("1.000000");
      expect(formatUnitsToAmount(123_456_789n)).toBe("123.456789");
    });

    it("rejects negative units", () => {
      expect(() => formatUnitsToAmount(-1n)).toThrow(InvalidAmountError);
    });
  });

  describe("Property-based testing (10,000 runs)", () => {
    it("satisfies parse(format(units)) === units for all non-negative integer units", () => {
      fc.assert(
        fc.property(fc.bigUintN(128), (units) => {
          const formatted = formatUnitsToAmount(units);
          const parsed = parseAmountToUnits(formatted);
          expect(parsed).toBe(units);
        }),
        { numRuns: 10_000 }
      );
    });
  });
});
