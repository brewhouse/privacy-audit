import { readFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object-storage upload for hosted audit runs (S3 or Cloudflare R2).
 *
 * Configured entirely via env vars so the same code targets AWS S3 or R2:
 *   S3_BUCKET              (required)  bucket name
 *   S3_REGION              region; use "auto" for R2 (default "auto")
 *   S3_ENDPOINT            custom endpoint; required for R2, omit for AWS S3
 *   S3_ACCESS_KEY_ID       credentials
 *   S3_SECRET_ACCESS_KEY   credentials
 *   S3_PUBLIC_BASE_URL     optional; if set, returned URLs are `${base}/${key}`
 *                          (public bucket / CDN). Otherwise a presigned GET URL is returned.
 *   S3_URL_TTL_SECONDS     presigned URL lifetime (default 604800 = 7 days)
 */

export interface StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  urlTtlSeconds: number;
}

export function loadStorageConfig(): StorageConfig | null {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || undefined,
    urlTtlSeconds: Number(process.env.S3_URL_TTL_SECONDS) || 604800,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".har": "application/json",
  ".png": "image/png",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export class ObjectStorage {
  private client: S3Client;
  constructor(private cfg: StorageConfig) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: Boolean(cfg.endpoint), // R2 / MinIO need path-style addressing
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  /** Upload a file from disk and return a retrievable URL (public or presigned). */
  async uploadFile(localPath: string, key: string): Promise<string> {
    const body = await readFile(localPath);
    const contentType = CONTENT_TYPES[path.extname(localPath).toLowerCase()] || "application/octet-stream";
    await this.client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return this.urlFor(key);
  }

  private async urlFor(key: string): Promise<string> {
    if (this.cfg.publicBaseUrl) {
      return `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`;
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: this.cfg.urlTtlSeconds,
    });
  }
}
