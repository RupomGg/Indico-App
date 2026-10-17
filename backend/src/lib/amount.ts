/**
 * Precision 6-decimal monetary amount parsing and formatting.
 * PRD §6.4: Never uses floating-point arithmetic.
 * Converts string representations to/from integer units (1 USDC = 1,000,000 units).
 */

export const DECIMALS = 6;
export const MULTIPLIER = 1_000_000n;

// Strict regex matching unsigned decimal strings: e.g. "1", "0.5", "100.000000"
// Rejects: signs (+/-), hex (0x), scientific notation (1e6), commas, spaces, unicode digits.
const STRICT_AMOUNT_REGEX = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Parses an amount string into exact integer units (6 decimals).
 * Never uses floating-point numbers.
 *
 * @param amount - string representation of amount (e.g. "12.345678")
 * @returns bigint integer units (e.g. 12345678n)
 */
export function parseAmountToUnits(amount: string): bigint {
  if (typeof amount !== "string") {
    throw new InvalidAmountError("Amount must be a string");
  }

  // Reject empty string or string containing leading/trailing whitespace
  if (amount.trim() !== amount || amount.length === 0) {
    throw new InvalidAmountError("Amount contains invalid whitespace or is empty");
  }

  // Validate exact format with strict regex
  if (!STRICT_AMOUNT_REGEX.test(amount)) {
    throw new InvalidAmountError(`Invalid amount format: "${amount}"`);
  }

  const parts = amount.split(".");
  const intPartStr = parts[0]!;
  const fracPartStr = parts[1] || "";

  // Pad or slice fraction part to exactly 6 decimals
  const paddedFracStr = fracPartStr.padEnd(DECIMALS, "0");

  const intUnits = BigInt(intPartStr) * MULTIPLIER;
  const fracUnits = BigInt(paddedFracStr);

  return intUnits + fracUnits;
}

/**
 * Formats integer units (6 decimals) into a canonical decimal string.
 * e.g. 12345678n -> "12.345678", 1000000n -> "1.000000"
 *
 * @param units - bigint integer units
 * @returns canonical decimal string with 6 decimal places
 */
export function formatUnitsToAmount(units: bigint): string {
  if (units < 0n) {
    throw new InvalidAmountError("Negative units cannot be formatted");
  }

  const intPart = units / MULTIPLIER;
  const fracPart = units % MULTIPLIER;

  const fracStr = fracPart.toString().padStart(DECIMALS, "0");
  return `${intPart.toString()}.${fracStr}`;
}
