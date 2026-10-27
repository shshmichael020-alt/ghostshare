# GhostShare Security Architecture & Incident Response Playbook

## Security Controls Baseline (Controls 1–32)

GhostShare is an ephemeral, direct file-sharing and live-chat progressive web application engineered for user privacy, zero persistent file retention, and strict operational security. This document details the threat model, trust boundaries, authorization matrix, operational safeguards, and incident response procedures.

---

## 1. Threat Modeling and Trust Boundaries (Control 23)

### Trust Architecture
GhostShare isolates all communication into two distinct operational planes:
1. **Signaling Control Plane (Cloudflare Workers & Durable Objects):**
   - Transports session negotiation metadata: WebRTC SDP offers/answers, ICE candidate coordinates, and session control messages.
   - **Zero file data** ever touches Cloudflare Workers or Durable Object isolates.
   - Session state is held in an isolated Cloudflare Durable Object backed by an ephemeral SQLite instance, bounded by an authoritative TTL.
2. **Data Plane (WebRTC Data Channels):**
   - Direct peer-to-peer communication when NAT/firewall network topologies permit.
   - When direct peer-to-peer traversal fails (such as between symmetric NAT mobile devices), traffic is relayed via authenticated TURN servers. In all cases, data channels are end-to-end encrypted using **SCTP over DTLS** (`RFC 8261` / `RFC 8831`). GhostShare application servers never store, buffer, or inspect file payloads.
   - Dual dedicated data channels (`file` and `control`) isolate high-throughput binary chunk streaming from control signaling and ephemeral chat.

### Threat Vectors and Mitigations
- **Anonymous Guessing & Enumeration:** Mitigated by 8-digit CSPRNG session codes (`crypto.getRandomValues`) with a $10^8$ search space, coupled with multi-tier rate limiting (120 req/min for checks, 60 req/min for joins, 40 req/min for creation) backed by SQLite cross-isolate rate limiting.
- **Role Spoofing & Session Hijacking:** Mitigated by cryptographically independent 192-bit hex capability tokens (`receiverToken` and `senderToken`) validated via constant-time string comparison (`timingSafeEqualStr`) before any state change or message retrieval.
- **Cross-Origin Attacks & CSRF:** Mitigated by strict Origin header validation (`isAllowedOrigin`) rejecting mutating HTTP verbs (`POST`, `PATCH`, `DELETE`) from untrusted origins, accompanied by restrictive Content Security Policy (CSP) headers.
- **Denial of Service & Memory Exhaustion:** Enforced by early request-body byte limits (64 KB for signaling, 8 KB for session endpoints) read incrementally via streaming readers before allocating complete bodies, bounded message history (150 messages max), and bounded client-side RAM fallback (100 MB).

---

## 2. API Authorization & Endpoint Audit (Control 30)

| Endpoint | Method | Required Capability / Auth | Body Size Limit | Rate Limit | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/signal/session` | `POST` | Public (Origin Checked) | 8 KB (8,192 B) | 40 req/min per IP | Create new session and issue `receiverToken` |
| `/api/signal/session/[code]` | `GET` | Public | None | 120 req/min per IP | Query session existence and TTL status |
| `/api/signal/session/[code]` | `POST` | Public (Origin Checked) | 8 KB (8,192 B) | 60 req/min per IP | Join session as sender and receive `senderToken` |
| `/api/signal/session/[code]` | `PATCH` | `receiverToken` | 8 KB (8,192 B) | N/A (Session bound) | Update session TTL duration |
| `/api/signal/session/[code]` | `DELETE` | `receiverToken` | 8 KB (8,192 B) | N/A (Session bound) | Explicitly terminate session and purge SQLite |
| `/api/signal/message` | `POST` | `receiverToken` or `senderToken` | 64 KB (65,536 B) | 240 req/min per IP | Deliver SDP offer/answer or ICE candidate |
| `/api/signal/poll` | `GET` | `receiverToken` or `senderToken` | None | Polling loop | Retrieve unread messages for authenticated role |
| `/api/signal/ice-servers` | `GET` | Public (CORS restricted) | None | CDN / Route cache | Retrieve validated STUN / authenticated TURN |

---

## 3. Secure CI/CD and Supply-Chain Protection (Control 24)

- **Automated Verification:** GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request to `main`.
- **Least Privilege:** Workflow permissions are strictly scoped to `contents: read`.
- **Pipeline Stages:** Clean reproducible install (`npm ci`), dependency vulnerability audit (`npm audit --audit-level=high`), automated secret scanning guard (`git grep`), ESLint check (`npm run lint`), strict TypeScript compilation (`npx tsc --noEmit`), automated test suite (`npm test`), and Cloudflare OpenNext production build (`npm run cf:build`).
- **Secret Scanning Guard:** Verifies tracked repository files are free of hardcoded private keys or unmasked credentials.

---

## 4. WebRTC Privacy, Replay Resistance, and Protocol Security (Controls 26, 27)

- **Port 53 Filtering:** All ICE candidate URLs using port 53 are stripped to prevent DNS amplification and relay abuse.
- **Credential Protection:** ICE servers containing unauthenticated TURN are automatically discarded. TURN credentials are encrypted in Cloudflare Worker secrets and served with `Cache-Control: no-store, no-cache, must-revalidate`.
- **Replay Resistance & Protocol Idempotency:**
  - *Signaling Sequence Monotonicity:* Durable Object assigns monotonically increasing sequence numbers (`seq`). Polling clients maintain an advancing cursor (`WHERE seq > cursor`), preventing duplicate delivery of signaling events within an active session.
  - *Transfer Protocol Idempotency:* Chunks carry an opaque cryptographic transfer ID (`generateTransferId()`) and a 0-indexed sequence. `ByteRangeTracker` rejects duplicates and overlapping conflicting chunks. Stale completion or readiness messages from previous transfers or mismatched file IDs are strictly discarded.
  - *Limitation & Scope:* Replay resistance operates per-session. Possession of a valid capability token permits posting valid messages to the active session DO until that session is closed or expires via its authoritative TTL.
- **Diagnostic Privacy:** Connection statistics (`inspectActiveCandidatePair`) sanitize candidate reports to classify connection types (direct P2P vs TURN relay) without leaking raw IP addresses in application logs or UI toasts.

---

## 5. Untrusted Metadata & Content Handling (Control 28)

- **Filename Sanitization:** Filenames are stripped of null bytes, directory traversal patterns (`..`, `/`, `\`), control characters, and truncated to safe 255-character limits while preserving file extensions (`sanitizeFileName`).
- **MIME Validation:** MIME types must match RFC compliant `type/subtype` patterns or default to `application/octet-stream` (`sanitizeMimeType`).
- **Zero Script Execution:** No user-supplied text or metadata is passed to `dangerouslySetInnerHTML` or executed in DOM contexts. Chat messages and filenames render exclusively via safe JSX text nodes.
- **Download Safety:** Incoming received files are downloaded using HTML5 `download` attributes with sanitized filenames.

---

## 6. Data Lifecycle & Expiry (Control 29)

- **Signaling Store TTL:** Sessions expire strictly within the configured duration (30 min to 24 hr). The Cloudflare Durable Object schedules an internal `alarm()` that executes `clearSession()` to purge all session records, messages, and rate limits from SQLite storage.
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

---

## 8. Verification Methodology (Control 32)

Security guarantees are verified through three distinct methodologies:
1. **Automated Unit & Integration Tests:** Deterministic tests in `tests/*.test.ts` covering token validation, rate limits, bounded request readers, DoS payload rejection, candidate sanitization, framing, storage boundaries, and protocol states.
2. **Edge Smoke Tests:** Live HTTP checks against production Cloudflare Worker validating security headers, origin enforcement, 413 oversized body handling, and authenticated TURN discovery.
3. **P2P Transfer Testing:** Browser-to-browser WebRTC testing across desktop and mobile devices evaluating direct SCTP data channel throughput and TURN relay fallback.
