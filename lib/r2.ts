import { AwsClient } from "aws4fetch";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Env = Record<string, string | undefined>;

async function getR2Client() {
  const { env } = await getCloudflareContext({ async: true });
  const e = env as Env;
  const accountId = e.R2_ACCOUNT_ID;
  const accessKeyId = e.R2_ACCESS_KEY_ID;
  const secretAccessKey = e.R2_SECRET_ACCESS_KEY;
  const bucket = e.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 isn't configured yet - set R2_ACCOUNT_ID, R2_BUCKET_NAME (vars) and R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (secrets).",
    );
  }

  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  return { client, accountId, bucket };
}

function objectUrl(accountId: string, bucket: string, objectKey: string): URL {
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`);
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-150) || "file";
}

export function buildObjectKey(code: string, originalName: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${code}/${unique}-${sanitizeFilename(originalName)}`;
}

// Bucket stays fully private - nobody can list or fetch anything without one
// of these signed, time-limited URLs.
export async function createPresignedPut(objectKey: string, expiresInSeconds = 3600): Promise<string> {
  const { client, accountId, bucket } = await getR2Client();
  const url = objectUrl(accountId, bucket, objectKey);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client.sign(url, { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

export async function createPresignedGet(
  objectKey: string,
  downloadFilename: string,
  expiresInSeconds: number,
): Promise<string> {
  const { client, accountId, bucket } = await getR2Client();
  const url = objectUrl(accountId, bucket, objectKey);
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, expiresInSeconds)));
  // Forces a real download (not inline preview) with the ORIGINAL filename,
  // regardless of the random suffix baked into the object key.
  url.searchParams.set("response-content-disposition", `attachment; filename="${downloadFilename.replace(/"/g, "")}"`);
  const signed = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}
