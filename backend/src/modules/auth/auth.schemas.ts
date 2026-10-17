import { z } from "zod";

export const RegisterRequestSchema = z.object({
  email: z.string().email("Invalid email address").toLowerCase().trim(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must not exceed 128 characters"),
});

export const RegisterResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    message: z.string(),
    verificationToken: z.string().optional(), // Provided in development/test environments
  }),
});

export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(1, "Verification token is required").trim(),
});

export const LoginRequestSchema = z.object({
  email: z.string().email("Invalid email address").toLowerCase().trim(),
  password: z.string().min(1, "Password is required"),
});

export const LoginResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    token: z.string(),
    expiresAt: z.string(),
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isEmailVerified: z.boolean(),
      isApproved: z.boolean(),
    }),
  }),
});

export const ResetPasswordRequestSchema = z.object({
  email: z.string().email("Invalid email address").toLowerCase().trim(),
});

export const ResetPasswordConfirmSchema = z.object({
  token: z.string().min(1, "Reset token is required").trim(),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must not exceed 128 characters"),
});
