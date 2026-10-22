# GhostShare

Move a file (or several, up to 250 MB total) between two browsers with no
login. One device shows a QR code + 8-digit PIN, the other scans or types
it in, uploads, and the file shows up as a direct download on the first
device. Files are stored and served as raw bytes with zero transcoding, so
there's no quality loss for any file type. Codes and files self-expire on
whatever timer the sender picks (30 min - 24 hours).

Runs entirely on Cloudflare: **Workers** (via the Next.js OpenNext adapter)
+ **R2** (object storage, private bucket) + **Workers KV** (pairing codes).
No servers to manage, generous free tier, and it's genuinely multi-user —
anyone with the URL can use it; nothing is tied to a single account.

## How it works

- **Pairing**: Receive generates an unbiased cryptographically secure 8-digit
  code (Web Crypto API) and stores an empty session in **Workers KV** with a TTL.
  Send validates that code, then every file it uploads gets attached to that same
  session.
- **Uploads/downloads never touch your Worker's request body.** The Worker
  only *signs* short-lived R2 URLs (via `aws4fetch`, the S3-compatible
  signing library); the browser then PUTs the file bytes straight to R2,
  and later GETs them straight back from R2. This is why there's no
  practical file-size ceiling from Workers' own request limits, and why
  downloads are fast and lossless (direct CDN transfer, no proxy).
- **250 MB is a per-transfer cap**, not a whole-site cap. Every session
  tracks its own running total in KV; a sender can drop in file after file
  until that session hits 250 MB. A hundred different friends each doing
  their own transfer are a hundred completely independent sessions — they
  don't share or compete for that 250 MB.
- **Server-Side Verification**: Before any file is registered into a session,
  the server validates the object in R2 using an S3 `HEAD` request to confirm
  its actual byte size and existence, preventing forged metadata or limit bypasses.
- The bucket is **private** — nobody can browse or guess their way to a
  file without a signed URL, which only exists because it came from a
  valid session.

## One-time setup

You'll need a free Cloudflare account and `wrangler` (installed as a dev
dependency already — use `npx wrangler ...`).

1. **Log in**:
   ```bash
   npx wrangler login
   ```

2. **Create the R2 bucket**:
   ```bash
   npx wrangler r2 bucket create ghostshare-files
   ```

3. **Configure R2 CORS Policy** (critical for browser direct PUT/GET):
   Apply the provided `r2-cors.json` policy:
   ```bash
   npx wrangler r2 bucket cors set ghostshare-files --file r2-cors.json
   ```
   Or in Dashboard: Storage -> R2 -> `ghostshare-files` -> Settings -> **CORS Policy** -> paste `r2-cors.json`.

4. **Get R2 API credentials** (used by the Worker to *sign* upload/download URLs):
   Dashboard -> R2 -> **Manage R2 API Tokens** -> Create API Token, scoped
   to **Object Read & Write** on the `ghostshare-files` bucket only. Note
   the Access Key ID, Secret Access Key, and your Account ID.

5. **Create the KV namespace**:
   ```bash
   npx wrangler kv namespace create SESSIONS_KV
   ```
   Copy the `id` it prints into `wrangler.jsonc` (`kv_namespaces[0].id`).

6. **Fill in `wrangler.jsonc`**: set `R2_ACCOUNT_ID` (your Cloudflare
   account id) and confirm `R2_BUCKET_NAME` matches step 2.

7. **Set the R2 secrets** (never put these in wrangler.jsonc or git):
   ```bash
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

8. **(Recommended) Add an R2 lifecycle rule** as a safety net:
   Dashboard -> R2 -> `ghostshare-files` -> Settings -> **Object lifecycle rules** ->
   add a rule to delete objects after **1 day**. This cleans up any file whose
   session already expired in KV but whose bytes are still sitting in R2.

9. **Deploy**:
   ```bash
   npm install
   npm run deploy
   ```
   This runs `opennextjs-cloudflare build` (bundles the Next.js app into a
   Worker) then `opennextjs-cloudflare deploy` (pushes it via Wrangler).
   You'll get a `*.workers.dev` URL immediately; add a custom domain later
   from the Worker's dashboard page if you want one.

## Local development & Testing

```bash
npm install

# Run automated security and logic test suite
npm run test

# Run ESLint and TypeScript checks
npm run lint
npx tsc --noEmit

# Preview with Cloudflare Workers workerd runtime
npm run cf:preview
```

`next dev` also works for pure UI iteration, but route handlers that touch
KV/R2 need the Workers runtime (`initOpenNextCloudflareForDev` in
`next.config.ts` wires this up so local bindings work automatically).

## File expiry

The sender picks how long a transfer stays available — **30 min, 1h, 2h,
3h, 6h, 12h, or 24h** (defaults to 1h) — right before dropping in files.
That choice:

- Sets the KV session's TTL, so the pairing code itself stops working the
  moment it elapses (KV deletes the key automatically).
- Sets the expiry on that file's presigned R2 download URL, so the link
  stops resolving at the same time even if someone saved it.
- **Locks irrevocably after the first file upload begins**, so a multi-file batch can't
  end up with mismatched expiries or extended retention.

The Receive panel shows a live countdown computed from the session's
stored `expiresAt`, ticking down client-side and re-synced every poll.

## Using it

- On your **phone**: open the site -> **Send** -> scan the QR shown on
  your laptop (or type the 8-digit code) -> drag/drop files, or paste
  (Ctrl/Cmd+V) a screenshot straight in.
- On your **laptop**: open the site -> **Receive** tab (default) -> each file
  appears with a Download button as it finishes uploading, with a toast
  notification and an updated tab title so you notice even if you're not
  looking at the tab.

Works the same in reverse.

## Security & Architecture Highlights

- **Cryptographic Randomness**: Pairing codes generated with Web Crypto rejection sampling; R2 object keys salted with 16 hex bytes.
- **RFC 6266 / RFC 5987 Header Compliance**: Download links use standard UTF-8 encoded `filename*` and clean ASCII fallback, stripping CRLF and null characters to prevent header splitting.
- **In-Memory Rate Limiting**: Abuse controls protect `/api/session` and `/api/session/[code]` against automated PIN enumeration.
- **Zero Worker Body Proxying**: File bytes go straight from browser to private R2 storage over TLS 1.3 / AWS SigV4.
