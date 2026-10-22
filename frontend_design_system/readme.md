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

- **Pairing**: Receive generates a random 8-digit code and stores an empty
  session in **Workers KV** with a TTL. Send validates that code, then
  every file it uploads gets attached to that same session.
- **Uploads/downloads never touch your Worker's request body.** The Worker
  only *signs* short-lived R2 URLs (via `aws4fetch`, the S3-compatible
  signing library); the browser then PUTs the file bytes straight to R2,
  and later GETs them straight back from R2. This is why there's no
  practical file-size ceiling from Workers' own request limits, and why
  downloads are fast and lossless (direct CDN transfer, no proxy).
- **250 MB is a per-transfer cap**, not a whole-site cap. Every session
  tracks its own running total in KV; a sender can drop in file after file
  until that session hits 250 MB. A hundred different friends each doing
  their own transfer are a hundred completely independent sessions - they
  don't share or compete for that 250 MB.
- The bucket is **private** - nobody can browse or guess their way to a
  file without a signed URL, which only exists because it came from a
  valid session.

## One-time setup

You'll need a free Cloudflare account and `wrangler` (installed as a dev
dependency already - use `npx wrangler ...`).

1. **Log in**: `npx wrangler login`

2. **Create the R2 bucket**:
   ```bash
   npx wrangler r2 bucket create ghostshare-files
   ```

3. **Get R2 API credentials** (separate from your normal Cloudflare login -
   these are used to *sign* upload/download URLs):
   Dashboard -> R2 -> **Manage R2 API Tokens** -> Create API Token, scoped
   to **Object Read & Write** on the `ghostshare-files` bucket only. Note
   the Access Key ID, Secret Access Key, and your Account ID.

4. **Create the KV namespace**:
   ```bash
   npx wrangler kv namespace create SESSIONS_KV
   ```
   Copy the `id` it prints into `wrangler.jsonc` (`kv_namespaces[0].id`).

5. **Fill in `wrangler.jsonc`**: set `R2_ACCOUNT_ID` (your Cloudflare
   account id) and confirm `R2_BUCKET_NAME` matches step 2.

6. **Set the R2 secrets** (never put these in wrangler.jsonc/git):
   ```bash
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

7. **(Recommended) Add an R2 lifecycle rule** as a safety net: Dashboard ->
   R2 -> `ghostshare-files` -> Settings -> Object lifecycle rules -> add a
   rule to delete objects after **1 day**. This cleans up any file whose
   session already expired in KV but whose bytes are still sitting in R2 -
   without it, files just accumulate in storage indefinitely.

8. **Deploy**:
   ```bash
   npm install
   npm run deploy
   ```
   This runs `opennextjs-cloudflare build` (bundles the Next.js app into a
   Worker) then `opennextjs-cloudflare deploy` (pushes it via Wrangler).
   You'll get a `*.workers.dev` URL immediately; add a custom domain later
   from the Worker's dashboard page if you want one.

That's the whole setup - no other accounts, no database to provision
separately, nothing else to configure.

## Local development

```bash
npm install
npm run cf:preview   # builds + runs the app locally in the real Workers runtime (workerd)
```

`next dev` also works for pure UI iteration, but route handlers that touch
KV/R2 need the Workers runtime (`initOpenNextCloudflareForDev` in
`next.config.ts` wires this up so local bindings work automatically).

## File expiry

The sender picks how long a transfer stays available - **30 min, 1h, 2h,
3h, 6h, 12h, or 24h** (defaults to 1h) - right before dropping in files.
That choice:

- Sets the KV session's TTL, so the pairing code itself stops working the
  moment it elapses (KV deletes the key automatically).
- Sets the expiry on that file's presigned R2 download URL, so the link
  stops resolving at the same time even if someone saved it.
- Locks after the first file starts uploading, so a multi-file batch can't
  end up with mismatched expiries.

The Receive panel shows a live countdown computed from the session's
stored `expiresAt`, ticking down client-side and re-synced every poll.

## Using it

- On your **phone**: open the site -> **Send** -> scan the QR shown on
  your laptop (or type the 8-digit code) -> drag/drop files, or paste
  (Ctrl/Cmd+V) a screenshot straight in.
- On your **laptop** (e.g. a locked-down browser that blocks normal
  downloads): open the site -> **Receive** tab (default) -> each file
  appears with a Download button as it finishes uploading, with a toast
  notification and an updated tab title so you notice even if you're not
  looking at the tab.

Works the same in reverse.

## Scaling this to friends using it regularly

Nothing here is tied to you specifically - every pairing code is an
isolated session, so this already works for any number of people using it
independently. The things actually worth watching as usage grows:

- **R2 storage/egress** - billed on Cloudflare's usage-based pricing, but
  R2 has zero egress fees (unlike most object storage), so bandwidth isn't
  the risk - storage accumulating is, which the lifecycle rule (step 7)
  handles.
- **Workers KV free tier** - 100k reads and 1k writes per day. Each
  receive-side session polls every 2 seconds while the tab is open; that's
  the main KV cost driver at real scale, not file transfers themselves.
- **Set a Cloudflare spend/usage alert** on the account so a traffic spike
  is a notification, not a surprise.

None of this requires touching the architecture - the two changes worth
making if it gets genuinely popular are relaxing the poll interval (e.g. 2s
-> 4-5s in `components/ReceivePanel.tsx`) and adding basic per-IP rate
limiting on `/api/session` (Cloudflare has a built-in Rate Limiting rule
you can attach to that route from the dashboard, no code needed).

## Limits / things to know

- 250 MB per transfer total (`MAX_TRANSFER_BYTES` in `lib/constants.ts`) -
  raise it freely, R2 itself has no meaningful size ceiling for this use
  case.
- Anyone with the 8-digit code can access that session's files until it
  expires - it's a pairing code, not a password, so don't post it
  publicly.
- Presigned upload URLs are valid for 1 hour regardless of the chosen
  expiry (that's just how long you have to *finish* uploading a given
  file); the *download* link's lifetime is what actually follows your
  expiry choice.
