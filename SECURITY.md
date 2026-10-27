# GhostShare Security Architecture & Incident Response Playbook

## Security Controls Baseline (Controls 1–32)

GhostShare is an ephemeral, peer-to-peer file sharing and live chat progressive web application engineered for maximum privacy, zero data retention, and strict operational security. This document details the threat model, trust boundaries, authorization matrix, operational safeguards, and incident response procedures.

---

## 1. Threat Modeling and Trust Boundaries (Control 23)

### Trust Architecture
GhostShare bifurcates all communication into two isolated planes:
1. **Signaling Control Plane (Cloudflare Workers & Durable Objects):**
   - Transports only WebRTC SDP offers, answers, ICE candidates, and session control metadata.
   - **Zero file data** ever touches Cloudflare infrastructure or edge isolates.
   - All session state is held in an isolated Cloudflare Durable Object backed by an ephemeral SQLite instance.
2. **Peer-to-Peer Data Plane (WebRTC SCTP Channels):**
   - End-to-end encrypted (DTLS/SRTP) directly between peer browsers.
   - Dual dedicated data channels (`file` and `control`) isolate high-throughput binary streaming from control signaling and ephemeral chat.

### Threat Vectors and Mitigations
- **Anonymous Attackers / Guessing Attacks:** Mitigated by 8-digit CSPRNG session codes (`crypto.getRandomValues`) with 10^8 search space and aggressive IP rate limiting (120 req/min for checks, 60 req/min for joins, 40 req/min for creation) backed by SQLite cross-isolate rate limiting.
- **Role Spoofing & Session Hijacking:** Mitigated by cryptographically independent 192-bit hex capability tokens (`receiverToken` and `senderToken`) validated via constant-time string comparison (`timingSafeEqualStr`) before any state change or message retrieval.
- **Cross-Origin Attacks & CSRF:** Mitigated by strict Origin header validation (`isAllowedOrigin`) rejecting mutating requests from untrusted origins, accompanied by restrictive Content Security Policy (CSP) headers.
- **Resource Exhaustion & Denial of Service:** Enforced by explicit payload size limits (64 KB for signaling, 8 KB for session endpoints), bounded message history (150 messages max), and bounded client-side RAM fallback (100 MB).

---

## 2. API Authorization & Endpoint Audit (Control 30)

| Endpoint | Method | Required Capability / Auth | Body Size Limit | Rate Limit | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/signal/session` | `POST` | Public (Origin Checked) | 8 KB | 40 req/min per IP | Create new session and issue `receiverToken` |
| `/api/signal/session/[code]` | `GET` | Public | None | 120 req/min per IP | Query session existence and TTL status |
| `/api/signal/session/[code]` | `POST` | Public (Origin Checked) | 8 KB | 60 req/min per IP | Join session as sender and receive `senderToken` |
| `/api/signal/session/[code]` | `PATCH` | `receiverToken` | 8 KB | N/A (Session bound) | Update session TTL duration |
| `/api/signal/session/[code]` | `DELETE` | `receiverToken` | 8 KB | N/A (Session bound) | Explicitly terminate session and purge SQLite |
| `/api/signal/message` | `POST` | `receiverToken` or `senderToken` | 64 KB | 240 req/min per IP | Deliver SDP offer/answer or ICE candidate |
| `/api/signal/poll` | `GET` | `receiverToken` or `senderToken` | None | Polling loop | Retrieve unread messages for authenticated role |
| `/api/signal/ice-servers` | `GET` | Public (CORS restricted) | None | CDN / Route cache | Retrieve validated STUN / authenticated TURN |

---

## 3. Secure CI/CD and Supply-Chain Protection (Control 24)

- **Automated Verification:** GitHub Actions (`.github/workflows/ci.yml`) triggers on every push and pull request to `main`.
- **Least Privilege:** Job permissions strictly restricted to `contents: read`.
- **Pipeline Stages:** Clean installation (`npm ci`), linting (`npm run lint`), TypeScript strict checking (`npx tsc --noEmit`), automated test suite (`npm test`), and Cloudflare OpenNext production build (`npm run cf:build`).
- **Dependency Audit:** Regular automated scans via `npm audit` to identify and remediate known vulnerabilities.

---

## 4. WebRTC Privacy, Replay Resistance, and Protocol Security (Controls 26, 27)

- **Port 53 Filtering:** All ICE candidate URLs with port 53 are stripped to prevent DNS amplification and relay abuse.
- **Credential Protection:** ICE servers containing unauthenticated TURN are automatically discarded. Turn credentials are never logged or exposed to third parties.
- **Idempotency & Sequence Integrity:** All signaling messages receive strictly monotonic auto-incrementing sequences. Duplicate or out-of-order signaling messages are filtered out by cursors.
- **Transfer Correlation:** Multi-file and batch transfers utilize cryptographically random IDs (`generateTransferId()`) that strictly adhere to `/^[a-zA-Z0-9_-]{8,64}$/`.

---

## 5. Untrusted Metadata & Content Handling (Control 28)

- **Filename Sanitization:** Filenames are stripped of null bytes, directory traversal patterns (`..`, `/`, `\`), control characters, and truncated to safe 255-character limits while preserving file extensions (`sanitizeFileName`).
- **MIME Validation:** MIME types must match RFC compliant `type/subtype` patterns or default to `application/octet-stream` (`sanitizeMimeType`).
- **Zero Script Execution:** No user-supplied text or metadata is passed to `dangerouslySetInnerHTML` or executed in DOM contexts. Chat messages and filenames render exclusively via safe JSX text nodes.
- **Download Safety:** Incoming received files are downloaded using HTML5 `download` attributes with sanitized filenames.

---

## 6. Data Lifecycle & Expiry (Control 29)

- **Signaling Store TTL:** Sessions expire strictly within the configured duration (5 min to 24 hr). The Cloudflare Durable Object schedules an internal `alarm()` that executes `clearSession()` to purge all session records, messages, and rate limits.
- **Client-Side Teardown:** On session completion, failure, or manual leave, `disconnectSession()` closes all WebRTC data channels, resets peer connections, clears file handle references, and invokes `cleanupSessionStorage()` to remove sandboxed OPFS directories.
- **In-Memory Live Chat:** Ephemeral chat messages are kept exclusively in component memory and are completely wiped upon session termination.

---

## 7. Incident Response & Secret Rotation Playbook (Control 31)

### Reporting a Security Vulnerability
If you discover a security vulnerability in GhostShare, please report it confidentially to the maintainer rather than opening a public issue.

### Secret Revocation and Rotation Procedures
GhostShare relies on zero database credentials and zero server-side private keys. The only operational secrets are external TURN relay service credentials configured in Cloudflare Worker environment secrets:
1. `TURN_SERVERS_JSON`
2. `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN`
3. `METERED_API_KEY`

#### Credential Rotation Steps:
1. **Revoke Existing Credentials:** Log into the respective TURN provider console (Cloudflare Calls or Metered.ca) and delete or deactivate the compromised credential key.
2. **Generate New Credentials:** Create fresh authenticated API tokens / credential sets.
3. **Update Cloudflare Worker Secret:**
   ```bash
   npx wrangler secret put TURN_SERVERS_JSON
   ```
4. **Redeploy and Validate:** Run `npx wrangler deploy` and verify the `/api/signal/ice-servers` endpoint returns valid credentials with status 200.
5. **Session Expiry:** Because all signaling sessions are ephemeral (max 24 hours), any sessions utilizing old credentials will naturally terminate without residual risk.
