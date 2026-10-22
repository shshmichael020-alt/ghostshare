import { AwsClient } from "aws4fetch";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Env = Record<string, string | undefined>;

export interface StorageConfig {
  client: AwsClient;
  bucket: string;
  baseUrl: string;
  accountId?: string;
}

function extractRegion(endpoint: string): string {
  const match = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return match ? match[1] : "auto";
}

/**
 * Initializes S3-compatible client supporting Backblaze B2 (Free 10GB, No Card)
 * or Cloudflare R2 seamlessly.
 */
export async function getStorageClient(): Promise<StorageConfig> {
  const { env } = await getCloudflareContext({ async: true });
  const e = env as Env;

  // 1. Check Backblaze B2 / Generic S3 configuration
  const s3Endpoint = e.S3_ENDPOINT || e.B2_ENDPOINT;
  const accessKeyId = e.S3_ACCESS_KEY_ID || e.B2_APPLICATION_KEY_ID || e.R2_ACCESS_KEY_ID;
  const secretAccessKey = e.S3_SECRET_ACCESS_KEY || e.B2_APPLICATION_KEY || e.R2_SECRET_ACCESS_KEY;
  const bucket = e.S3_BUCKET_NAME || e.B2_BUCKET_NAME || e.R2_BUCKET_NAME || "ghostshare-files";
  const s3Region = e.S3_REGION || e.B2_REGION || (s3Endpoint ? extractRegion(s3Endpoint) : "auto");

  // 2. Check Cloudflare R2 fallback
  const accountId = e.R2_ACCOUNT_ID;

  if (s3Endpoint && accessKeyId && secretAccessKey) {
    const cleanEndpoint = s3Endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: s3Region || "auto",
    });
    return {
      client,
      bucket,
      baseUrl: `https://${cleanEndpoint}/${bucket}`,
    };
  }

  if (accountId && accessKeyId && secretAccessKey) {
    const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
    return {
      client,
      bucket,
      accountId,
      baseUrl: `https://${accountId}.r2.cloudflarestorage.com/${bucket}`,
    };
  }

  throw new Error(
    "Storage is not configured yet. Configure Backblaze B2 (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) or Cloudflare R2.",
  );
}

// Backwards compatibility alias
export async function getR2Client() {
  const cfg = await getStorageClient();
  return { client: cfg.client, accountId: cfg.accountId || "", bucket: cfg.bucket };
}

export function objectUrl(accountId: string, bucket: string, objectKey: string): URL {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  if (accountId) {
    return new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`);
  }
  return new URL(`https://s3.backblazeb2.com/${bucket}/${encodedKey}`);
}

export function buildStorageUrl(baseUrl: string, objectKey: string): URL {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return new URL(`${baseUrl}/${encodedKey}`);
}

/**
 * Sanitizes an untrusted filename to prevent path traversal, control character injection,
 * and HTTP response splitting.
 */
export function sanitizeFilename(name: string): string {
  // Strip null bytes, control characters, newlines, and path separators
  let stripped = name.replace(/[\x00-\x1F\x7F\r\n/\\]/g, "_").trim();
  // Neutralize path traversal sequences (..)
  stripped = stripped.replace(/\.\./g, "__");
  const cleaned = stripped.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-150) || "file";
}

/**
 * Formats an RFC 6266 / RFC 5987 compliant Content-Disposition value for safe UTF-8 download.
 */
export function buildContentDisposition(downloadFilename: string): string {
  // Strip control chars, CRLF, and double quotes to prevent header injection
  const safeName = downloadFilename.replace(/[\x00-\x1F\x7F\r\n"]/g, "").trim() || "file";
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const utf8Encoded = encodeURIComponent(safeName);

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Builds a collision-resistant internal storage object key using cryptographically secure random bytes.
 */
export function buildObjectKey(code: string, originalName: string): string {
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const safeSlug = sanitizeFilename(originalName);

  return `${code}/${Date.now()}-${randomHex}-${safeSlug}`;
}

/**
 * Generates a presigned PUT URL allowing direct browser-to-storage upload without Worker body proxying.
 */
export async function createPresignedPut(objectKey: string, expiresInSeconds = 3600): Promise<string> {
  const { client, baseUrl } = await getStorageClient();
  const url = buildStorageUrl(baseUrl, objectKey);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client.sign(url, { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

/**
 * Generates a presigned GET URL allowing direct browser download with enforced Content-Disposition.
 */
export async function createPresignedGet(
  objectKey: string,
  downloadFilename: string,
  expiresInSeconds: number,
): Promise<string> {
  const { client, baseUrl } = await getStorageClient();
  const url = buildStorageUrl(baseUrl, objectKey);
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, expiresInSeconds)));
  url.searchParams.set("response-content-disposition", buildContentDisposition(downloadFilename));
  const signed = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

/**
 * Verifies that an object was genuinely uploaded to storage and confirms its actual size via S3 HEAD.
 */
export async function verifyR2Object(objectKey: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const { client, baseUrl } = await getStorageClient();
    const url = buildStorageUrl(baseUrl, objectKey);
    const signed = await client.sign(url, { method: "HEAD" });
    const res = await client.fetch(signed);

    if (res.status === 200) {
      const lengthHeader = res.headers.get("content-length");
      const size = lengthHeader ? parseInt(lengthHeader, 10) : undefined;
      return { exists: true, size };
    }
    return { exists: false };
  } catch (err) {
    console.error("verifyStorageObject error:", err);
    return { exists: false };
  }
}
