import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { InvalidAmountError } from "./amount.js";

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Array<{
      field?: string;
      message: string;
    }>;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Array<{ field?: string; message: string }> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Array<{ field?: string; message: string }> | undefined
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: Array<{ field?: string; message: string }>) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string, details?: Array<{ field?: string; message: string }>) {
    super(422, "UNPROCESSABLE_ENTITY", message, details);
  }
}

export class RateLimitExceededError extends AppError {
  constructor(message = "Too many requests. Please try again later.") {
    super(429, "RATE_LIMIT_EXCEEDED", message);
  }
}

/**
 * Global Fastify error handler ensuring no stack trace or raw database error
 * reaches clients (PRD §Input Testing requirement).
 */
export function globalErrorHandler(
  error: FastifyError | Error,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  // 1. Zod Validation Error
  if (error instanceof ZodError) {
    const details = error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return reply.status(400).send({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request payload",
        details,
      },
    });
  }

  // 2. Custom Application Error
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  // 3. Amount parsing error
  if (error instanceof InvalidAmountError) {
    return reply.status(400).send({
      success: false,
      error: {
        code: "INVALID_AMOUNT",
        message: error.message,
      },
    });
  }

  // 4. Prisma database errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      // Unique constraint violation
      return reply.status(409).send({
        success: false,
        error: {
          code: "CONFLICT",
          message: "A resource with these details already exists",
        },
      });
    }
    if (error.code === "P2025") {
      // Record not found
      return reply.status(404).send({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Requested record not found",
        },
      });
    }
    // Generic database error (never leak raw query or table names)
    return reply.status(400).send({
      success: false,
      error: {
        code: "DATABASE_OPERATION_FAILED",
        message: "The requested operation could not be completed with the provided data",
      },
    });
  }

  // 5. Fastify internal/schema validation errors (e.g. malformed JSON)
  const statusCode = (error as FastifyError).statusCode || 400;
  if (statusCode < 500) {
    return reply.status(statusCode).send({
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: error.message || "Invalid request",
      },
    });
  }

  // 6. Unknown server errors (Never leak stack trace or internal messages)
  return reply.status(400).send({
    success: false,
    error: {
      code: "REQUEST_FAILED",
      message: "The server could not process the request.",
    },
  });
}
