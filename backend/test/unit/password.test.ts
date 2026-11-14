import { describe, it, expect } from "vitest";
import { RegisterRequestSchema, ResetPasswordConfirmSchema, LoginRequestSchema } from "../../src/modules/auth/auth.schemas.js";
import { UpdateProfileRequestSchema } from "../../src/modules/profile/profile.schemas.js";
import { PASSWORD_RULE } from "../../src/lib/password.js";

/**
 * New-password rule: 8 to 128 characters, at least one uppercase letter (A-Z), one digit (0-9)
 * and one symbol (any character that is not a letter, a digit or whitespace).
 *
 * | Class                         | Value                  | Valid | Missing reported        |
 * |-------------------------------|------------------------|-------|-------------------------|
 * | exactly 8, all four kinds     | "Abcdef1!"             | yes   |                         |
 * | 7 chars, all kinds            | "Abcde1!"              | no    | length                  |
 * | exactly 128                   | "A1!" + "a" * 125      | yes   |                         |
 * | 129                           | "A1!" + "a" * 126      | no    | length                  |
 * | no uppercase                  | "abcdef1!"             | no    | uppercase               |
 * | no digit                      | "Abcdefg!"             | no    | number                  |
 * | no symbol                     | "Abcdefg1"             | no    | symbol                  |
 * | space is not a symbol         | "Abcdef1 "             | no    | symbol                  |
 * | accented letter not a symbol  | "Abcdéf1x"             | no    | symbol                  |
 * | non-ASCII digit not a number  | "Abcdef١!" (Arabic 1)  | no    | number                  |
 * | lowercase not required        | "ABCDEF1!"             | yes   |                         |
 * | only digits                   | "12345678"             | no    | uppercase, symbol       |
 * | empty                         | ""                     | no    | every rule              |
 * | each symbol class             | "Abcdef1" + s          | yes   | for s in !@#$%^&*()-_=+[]{};:'",.<>/?\|`~ |
 * | wrong type                    | 12345678, null, absent | no    |                         |
 */
const cases: [string, unknown, boolean, string[]][] = [
  ["exactly 8 with all four kinds", "Abcdef1!", true, []],
  ["7 characters", "Abcde1!", false, ["at least 8 characters"]],
  ["exactly 128", "A1!" + "a".repeat(125), true, []],
  ["129 characters", "A1!" + "a".repeat(126), false, ["at most 128 characters"]],
  ["no uppercase", "abcdef1!", false, ["one uppercase letter"]],
  ["no digit", "Abcdefg!", false, ["one number"]],
  ["no symbol", "Abcdefg1", false, ["one symbol"]],
  ["space is not a symbol", "Abcdef1 ", false, ["one symbol"]],
  ["accented letter is not a symbol", "Abcdéf1x", false, ["one symbol"]],
  ["non-ASCII digit is not a number", "Abcdef١!", false, ["one number"]],
  ["lowercase is not required", "ABCDEF1!", true, []],
  ["only digits", "12345678", false, ["one uppercase letter", "one symbol"]],
  ["empty", "", false, ["at least 8 characters", "one uppercase letter", "one number", "one symbol"]],
  ["wrong type: number", 12345678, false, []],
  ["wrong type: null", null, false, []],
  ["absent", undefined, false, []],
];

const schemas = [
  ["register", (p: unknown) => RegisterRequestSchema.safeParse({ email: "a@example.com", password: p })],
  ["reset", (p: unknown) => ResetPasswordConfirmSchema.safeParse({ token: "t", newPassword: p })],
  ["change", (p: unknown) => UpdateProfileRequestSchema.safeParse({ currentPassword: "old", newPassword: p })],
] as const;

describe("New-password rule (register, reset, change)", () => {
  for (const [name, parse] of schemas) {
    describe(name, () => {
      it.each(cases)("%s -> valid: %s", (_desc, password, valid, missing) => {
        const result = parse(password);
        expect(result.success).toBe(valid);
        if (!result.success && missing.length > 0) {
          const messages = result.error.issues.map((i) => i.message).join(" | ");
          for (const part of missing) expect(messages).toContain(part);
          // Only the rules actually broken are reported.
          const all = ["at least 8 characters", "at most 128 characters", "one uppercase letter", "one number", "one symbol"];
          for (const part of all.filter((p) => !missing.includes(p))) expect(messages).not.toContain(part);
        }
      });

      it.each([..."!@#$%^&*()-_=+[]{};:'\",.<>/?\\|`~"])("symbol %s counts", (symbol) => {
        expect(parse("Abcdef1" + symbol).success).toBe(true);
      });
    });
  }

  it("states the rule in one sentence for the apps to show", () => {
    expect(PASSWORD_RULE).toBe(
      "At least 8 characters, with at least one uppercase letter, one number and one symbol."
    );
  });

  it("login accepts any non-empty password, so it never refuses an existing account by rule", () => {
    expect(LoginRequestSchema.safeParse({ email: "a@example.com", password: "aaaaaaaa" }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
  });
});
