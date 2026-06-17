import { readFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object-storage upload for hosted audit runs — Amazon S3.
 *
 * Configured via env vars:
 *   S3_BUCKET              (required)  bucket name
 *   S3_REGION              AWS region, e.g. "us-west-2" (default "us-east-1")
 *   S3_ACCESS_KEY_ID       credentials (IAM user with PutObject/GetObject on the bucket)
 *   S3_SECRET_ACCESS_KEY   credentials
 *   S3_PUBLIC_BASE_URL     optional; if set, returned URLs are `${base}/${key}`
 *                          (public bucket / CloudFront). Otherwise a presigned GET URL is returned.
 *   S3_URL_TTL_SECONDS     presigned URL lifetime (default 604800 = 7 days)
 *   S3_ENDPOINT            optional; only for S3-compatible providers (MinIO, R2).
 *                          Leave unset for Amazon S3.
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
    region: process.env.S3_REGION || "us-east-1",
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
