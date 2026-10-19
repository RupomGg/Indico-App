import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
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
import { termsRoutes } from "./modules/terms/terms.routes.js";
import { assetsRoutes } from "./modules/assets/assets.routes.js";
import { loansRoutes } from "./modules/loans/loans.routes.js";
import { creditRoutes } from "./modules/credit/credit.routes.js";
import { merchantsRoutes } from "./modules/merchants/merchants.routes.js";
import { historyRoutes } from "./modules/history/history.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";

export interface BuildAppOptions {
  onRoute?: (routeOptions: any) => void;
}

export function buildApp(options?: BuildAppOptions): FastifyInstance {
  const app = fastify({
    logger: process.env["NODE_ENV"] === "development",
    // 20MB body limit for document uploads (PRD §4.2 A-01)
    bodyLimit: 20 * 1024 * 1024,
    // Support long IDs and parameterized injection tests (Fastify v5 style)
    routerOptions: {
      maxParamLength: 1000,
    },
  }).withTypeProvider<ZodTypeProvider>();

  if (options?.onRoute) {
    app.addHook("onRoute", options.onRoute);
  }

  // Register schema compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register plugins
  app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.register(sensible);

  // Multipart support for file uploads (max 20 MB, PRD §4.2 A-01)
  app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
    },
  });

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
  app.register(termsRoutes, { prefix: "/api/v1/terms" });
  app.register(assetsRoutes, { prefix: "/api/v1/assets" });
  app.register(loansRoutes, { prefix: "/api/v1/loans" });
  app.register(creditRoutes, { prefix: "/api/v1/credit" });
  app.register(merchantsRoutes, { prefix: "/api/v1/merchants" });
  app.register(historyRoutes, { prefix: "/api/v1/history" });
  app.register(adminRoutes, { prefix: "/api/v1/admin" });

  // Global Error Handler (PRD §Input Testing requirement)
  app.setErrorHandler(globalErrorHandler);

  // Global Not Found Handler (Strict Indico error envelope for 404s)
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  return app as unknown as FastifyInstance;
}
