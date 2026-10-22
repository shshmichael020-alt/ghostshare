import { AwsClient } from "aws4fetch";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Env = Record<string, string | undefined>;

export async function getR2Client() {
  const { env } = await getCloudflareContext({ async: true });
  const e = env as Env;
  const accountId = e.R2_ACCOUNT_ID;
  const accessKeyId = e.R2_ACCESS_KEY_ID;
  const secretAccessKey = e.R2_SECRET_ACCESS_KEY;
  const bucket = e.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 is not configured yet — set R2_ACCOUNT_ID, R2_BUCKET_NAME (vars) and R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (secrets).",
    );
  }

  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  return { client, accountId, bucket };
}

export function objectUrl(accountId: string, bucket: string, objectKey: string): URL {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`);
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
 * Builds a collision-resistant internal R2 object key using cryptographically secure random bytes.
 */
export function buildObjectKey(code: string, originalName: string): string {
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const safeSlug = sanitizeFilename(originalName);

  return `${code}/${Date.now()}-${randomHex}-${safeSlug}`;
}

/**
 * Generates a presigned PUT URL allowing direct browser-to-R2 upload without Worker body proxying.
 */
export async function createPresignedPut(objectKey: string, expiresInSeconds = 3600): Promise<string> {
  const { client, accountId, bucket } = await getR2Client();
  const url = objectUrl(accountId, bucket, objectKey);
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
  const { client, accountId, bucket } = await getR2Client();
  const url = objectUrl(accountId, bucket, objectKey);
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, expiresInSeconds)));
  url.searchParams.set("response-content-disposition", buildContentDisposition(downloadFilename));
  const signed = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

/**
 * Verifies that an object was genuinely uploaded to R2 and confirms its actual size via S3 HEAD.
 */
export async function verifyR2Object(objectKey: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const { client, accountId, bucket } = await getR2Client();
    const url = objectUrl(accountId, bucket, objectKey);
    const signed = await client.sign(url, { method: "HEAD" });
    const res = await client.fetch(signed);

    if (res.status === 200) {
      const lengthHeader = res.headers.get("content-length");
      const size = lengthHeader ? parseInt(lengthHeader, 10) : undefined;
      return { exists: true, size };
    }
    return { exists: false };
  } catch (err) {
    console.error("verifyR2Object error:", err);
    // If credentials or bindings are not configured (e.g. local dev mock), return false
    return { exists: false };
  }
}
