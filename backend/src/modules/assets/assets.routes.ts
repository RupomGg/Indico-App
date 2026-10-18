import { FastifyInstance } from "fastify";
import { AssetsService } from "./assets.service.js";
import {
  PresignedUploadInputSchema,
  PresignedUploadResponseSchema,
  SubmitAssetInputSchema,
  SubmitAssetResponseSchema,
  PrepareRegisterAssetResponseSchema,
  AssetListQuerySchema,
  AssetListResponseSchema,
  AssetDetailSchema,
} from "./assets.schemas.js";
import { authenticate, requireApproved } from "../../middleware/auth.js";
import { BadRequestError } from "../../lib/errors.js";

export async function assetsRoutes(fastify: FastifyInstance) {
  // Allocate presigned upload session (PRD §4.2 A-02)
  fastify.post(
    "/presigned-upload",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description: "Allocate presigned upload session (A-02)",
        tags: ["Assets"],
        body: PresignedUploadInputSchema,
        response: {
          200: PresignedUploadResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const res = await AssetsService.createPresignedUpload(userId, request.body as any);
      return reply.send(res);
    }
  );

  // Upload file bytes to allocated session
  fastify.post(
    "/upload/:uploadId",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description: "Upload file binary bytes to active upload session (A-01, A-03)",
        tags: ["Assets"],
        params: {
          type: "object",
          properties: {
            uploadId: { type: "string" },
          },
          required: ["uploadId"],
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { uploadId } = request.params as { uploadId: string };

      // Handle multipart form upload or raw binary stream
      if (request.isMultipart()) {
        const part = await request.file();
        if (!part) {
          throw new BadRequestError("No file uploaded in multipart form");
        }
        const buffer = await part.toBuffer();
        const result = await AssetsService.uploadFileChunk(
          userId,
          uploadId,
          buffer,
          part.filename,
          part.mimetype
        );
        return reply.send({ success: true, ...result });
      } else {
        const buffer = await request.body;
        if (!Buffer.isBuffer(buffer)) {
          throw new BadRequestError("Expected multipart/form-data or binary buffer");
        }
        const result = await AssetsService.uploadFileChunk(
          userId,
          uploadId,
          buffer,
          "uploaded-file",
          request.headers["content-type"] || "application/octet-stream"
        );
        return reply.send({ success: true, ...result });
      }
    }
  );

  // Submit asset metadata with server-side hash verification (PRD §4.2 A-04, A-06, A-08)
  fastify.post(
    "/submit",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description: "Submit asset metadata, verify SHA-256 byte integrity, encrypt at rest, and store record (A-04, A-06, A-08)",
        tags: ["Assets"],
        body: SubmitAssetInputSchema,
        response: {
          201: SubmitAssetResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await AssetsService.submitAsset(userId, request.body as any);
      return reply.status(201).send(result);
    }
  );

  // Prepare calldata and pre-flight simulation for registerAsset (PRD §4.2 A-07)
  fastify.post(
    "/:id/prepare-register",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description: "Prepare transaction calldata and gas shortfall analysis for registerAsset (A-07)",
        tags: ["Assets"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        response: {
          200: PrepareRegisterAssetResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { id } = request.params as { id: string };
      const prepared = await AssetsService.prepareRegisterCalldata(userId, id);
      return reply.send(prepared);
    }
  );

  // List user assets (PRD §4.2 A-09)
  fastify.get(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        description: "List assets belonging to the authenticated user with status and explorer links (A-09)",
        tags: ["Assets"],
        querystring: AssetListQuerySchema,
        response: {
          200: AssetListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const query = request.query as any;
      const assets = await AssetsService.listUserAssets(userId, query);
      return reply.send(assets);
    }
  );

  // Get asset detail (PRD §4.2 A-09)
  fastify.get(
    "/:id",
    {
      preHandler: [authenticate],
      schema: {
        description: "Get detailed information for a specific asset (A-09)",
        tags: ["Assets"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        response: {
          200: AssetDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { id } = request.params as { id: string };
      const asset = await AssetsService.getAssetDetail(userId, id);
      return reply.send(asset);
    }
  );

  // Download decrypted document
  fastify.get(
    "/:id/document",
    {
      preHandler: [authenticate],
      schema: {
        description: "Download decrypted original document file for authorized owner",
        tags: ["Assets"],
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { id } = request.params as { id: string };
      const doc = await AssetsService.getDecryptedDocument(userId, id);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${doc.docHash}.pdf"`);
      return reply.send(doc.buffer);
    }
  );
}
