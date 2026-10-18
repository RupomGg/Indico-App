import fs from "fs";
import path from "path";
import { env } from "../config/env.js";
import { encryptAes256Gcm, decryptAes256Gcm, generateSecureToken } from "./crypto.js";
import { BadRequestError, NotFoundError, PayloadTooLargeError } from "./errors.js";

export interface UploadSession {
  uploadId: string;
  userId: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  createdAt: number;
  expiresAt: number;
  uploadedFile?: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    uploadedAt: number;
  };
}

// In-memory registry for presigned upload sessions (TTL: 15 minutes)
const uploadSessions = new Map<string, UploadSession>();
const UPLOAD_TTL_MS = 15 * 60 * 1000;
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB (PRD §4.2 A-01)

export class StorageService {
  private static basePath = path.resolve(process.cwd(), env.STORAGE_LOCAL_PATH);

  /**
   * Initializes base storage directory structure.
   */
  static init(): void {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  /**
   * Allocates a presigned upload session (PRD §4.2 A-02).
   */
  static createUploadSession(
    userId: string,
    params: { fileName: string; fileSizeBytes: number; mimeType: string }
  ): { uploadId: string; uploadUrl: string; expiresAt: string; maxSizeBytes: number } {
    if (params.fileSizeBytes <= 0) {
      throw new BadRequestError("File size must be greater than zero bytes");
    }

    if (params.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new PayloadTooLargeError("File exceeds maximum allowed size of 20 MB");
    }

    const uploadId = generateSecureToken(24);
    const now = Date.now();
    const expiresAt = now + UPLOAD_TTL_MS;

    uploadSessions.set(uploadId, {
      uploadId,
      userId,
      fileName: params.fileName,
      fileSizeBytes: params.fileSizeBytes,
      mimeType: params.mimeType,
      createdAt: now,
      expiresAt,
    });

    return {
      uploadId,
      uploadUrl: `/api/v1/assets/upload/${uploadId}`,
      expiresAt: new Date(expiresAt).toISOString(),
      maxSizeBytes: MAX_FILE_SIZE_BYTES,
    };
  }

  /**
   * Stores raw uploaded file buffer temporarily against an active upload session.
   */
  static storeUploadedBuffer(
    uploadId: string,
    userId: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string
  ): void {
    const session = uploadSessions.get(uploadId);
    if (!session) {
      throw new NotFoundError("Upload session not found or expired");
    }

    if (session.userId !== userId) {
      throw new BadRequestError("Upload session belongs to a different user");
    }

    if (Date.now() > session.expiresAt) {
      uploadSessions.delete(uploadId);
      throw new BadRequestError("Upload session has expired");
    }

    if (buffer.length === 0) {
      throw new BadRequestError("Empty file uploaded");
    }

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new PayloadTooLargeError("File exceeds maximum allowed size of 20 MB");
    }

    session.uploadedFile = {
      buffer,
      fileName,
      mimeType,
      uploadedAt: Date.now(),
    };
  }

  /**
   * Retrieves uploaded file buffer from session and removes the session.
   */
  static getUploadedFile(uploadId: string): { buffer: Buffer; fileName: string; mimeType: string } {
    const session = uploadSessions.get(uploadId);
    if (!session || !session.uploadedFile) {
      throw new NotFoundError(
        "No uploaded file found for this session ID. Please upload file bytes first."
      );
    }

    if (Date.now() > session.expiresAt) {
      uploadSessions.delete(uploadId);
      throw new BadRequestError("Upload session has expired");
    }

    const file = session.uploadedFile;
    uploadSessions.delete(uploadId);
    return file;
  }

  /**
   * Encrypts and writes file buffer to permanent storage at rest using AES-256-GCM.
   */
  static async saveEncryptedFile(
    userId: string,
    docHash: string,
    rawBytes: Buffer
  ): Promise<{ storageKey: string; encryptedBytes: Buffer }> {
    this.init();

    const sanitizedHash = docHash.toLowerCase().replace(/^0x/, "");
    const userDir = path.join(this.basePath, "assets", userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const relativeKey = `assets/${userId}/${sanitizedHash}.enc`;
    const fullPath = path.join(this.basePath, "assets", userId, `${sanitizedHash}.enc`);

    const encryptedBytes = encryptAes256Gcm(rawBytes, env.DOCUMENT_ENCRYPTION_KEY);
    await fs.promises.writeFile(fullPath, encryptedBytes);

    return {
      storageKey: relativeKey,
      encryptedBytes,
    };
  }

  /**
   * Reads raw ciphertext from storage.
   */
  static async readRawCiphertext(storageKey: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, storageKey);
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundError("Document storage file not found");
    }
    return fs.promises.readFile(fullPath);
  }

  /**
   * Reads encrypted file from disk and decrypts it into plaintext buffer.
   */
  static async readDecryptedFile(storageKey: string): Promise<Buffer> {
    const ciphertext = await this.readRawCiphertext(storageKey);
    return decryptAes256Gcm(ciphertext, env.DOCUMENT_ENCRYPTION_KEY);
  }
}
