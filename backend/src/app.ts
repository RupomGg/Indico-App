import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import { globalErrorHandler } from "./lib/errors.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { profileRoutes } from "./modules/profile/profile.routes.js";

export function buildApp(): FastifyInstance {
  const app = fastify({
    logger: process.env["NODE_ENV"] === "development",
    // 20MB body limit for document uploads (PRD §4.2 A-01)
    bodyLimit: 20 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Register schema compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register plugins
  app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.register(sensible);

  // OpenAPI / Swagger Documentation Generator
  app.register(swagger, {
    openapi: {
      info: {
        title: "Indico Asset Ledger API",
        description: "REST API for Indico Asset Ledger (Flutter Mobile Client & Admin Dashboard)",
        version: "1.0.0",
      },
      servers: [
        {
          url: "http://localhost:3000",
          description: "Local Development Server",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });

  // Health check endpoint
  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // API Routes
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(profileRoutes, { prefix: "/api/v1/profile" });

  // Global Error Handler (PRD §Input Testing requirement)
  app.setErrorHandler(globalErrorHandler);

  return app as unknown as FastifyInstance;
}
