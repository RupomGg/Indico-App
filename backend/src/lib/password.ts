import { z } from "zod";

/** The new-password rule, worded for the apps to show next to the field. */
export const PASSWORD_RULE =
  "At least 8 characters, with at least one uppercase letter, one number and one symbol.";

/**
 * A new password (register, reset, change): 8 to 128 characters with an uppercase letter A-Z, a
 * digit 0-9 and a symbol (anything that is not a letter, a digit or whitespace). Each broken part is
 * reported, so the message lists everything missing at once. Login does not use this: an account
 * must still sign in with a password set under an earlier rule.
 */
export const newPasswordSchema = (label = "Password") =>
  z
    .string()
    .min(8, `${label} must be at least 8 characters`)
    .max(128, `${label} must be at most 128 characters`)
    .regex(/[A-Z]/, `${label} must contain at least one uppercase letter`)
    .regex(/[0-9]/, `${label} must contain at least one number`)
    .regex(/[^\p{L}\p{N}\s]/u, `${label} must contain at least one symbol`);
