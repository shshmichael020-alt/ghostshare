# GhostShare — Privacy-First WebRTC Peer-to-Peer File Transfer

GhostShare is an anonymous, browser-based, direct peer-to-peer file-transfer application.

Files travel directly browser-to-browser across encrypted WebRTC SCTP data channels. **Zero cloud file-storage accounts, zero credit cards, and zero billing credentials are required.**

One device opens GhostShare in Receive mode, generating a cryptographically secure 8-digit pairing code and QR code. Another device scans or enters the code in Send mode. Once paired, the sender stages files, the receiver provides explicit authorization, and the files stream directly peer-to-peer.

---

## 🌟 Key Features

- **Zero Cloud File Storage**: No Backblaze B2, Cloudflare R2, AWS S3, or third-party buckets. File contents never touch any central server or disk.
- **Direct WebRTC SCTP Data Channels**: Files stream as raw binary chunks (32 KB MTU) with end-to-end DTLS encryption negotiated directly between browser peers.
- **OPFS Direct-to-Disk Streaming**: Direct-to-disk streaming via the browser's native Origin Private File System (OPFS) enables large multi-gigabyte transfers without accumulating in browser memory (RAM).
- **Collision-Proof File Identity & Verification**: Every incoming transfer is written to a unique sandboxed key (`${fileId}.bin`) with byte-length verification before completion acknowledgement is issued.
- **Bounded In-Memory Fallback**: For older browsers without OPFS, non-disk transfers are strictly bounded to a 100 MB memory safety ceiling to avoid browser tab crashes.
- **Memory Safety & Backpressure Control**: On-demand file slicing via `File.slice()` and `bufferedamountlow` throttling (256 KB high-water mark) prevents browser RAM and SCTP buffer saturation.
- **Explicit Receiver Approval**: Receiver must explicitly authorize the file transfer manifest before any binary file bytes begin transmitting.
- **Strongly Consistent Ephemeral Signaling**: Authoritative per-session SQLite-backed Cloudflare Durable Objects guarantee immediate global consistency across all edge locations with zero replication latency.
- **8-Digit Ephemeral Pairing & QR Codes**: Generated via Web Crypto CSPRNG rejection sampling with automated self-destruction after 1 hour (default, configurable from 30 min to 24 hours).
- **Receiver Session Management Capability**: Sensitive operations (TTL extension, session termination) require an unexposed CSPRNG `receiverToken` capability issued exclusively to the receiver upon session creation.
- **Multi-File Staging & Drag-and-Drop**: Supports folder drag-and-drop, native file selection, and clipboard paste (`Ctrl+V` / `⌘+V`) for screenshots and files.
- **NAT Traversal with Public STUN**: Uses Google and Cloudflare public STUN servers for direct UDP hole punching across residential and mobile networks.
- **Custom Frontend Design System**: Dark futuristic aesthetic, JetBrains Mono telemetry typography, live status badges, dynamic countdown timers, and responsive layout.

---

## 🏗️ Architecture & Protocols

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Sender Browser (Send)       │                 │   Receiver Browser (Receive)    │
│                                 │                 │                                 │
│  - Selects / Pastes Files       │                 │  - Displays 8-digit code & QR   │
│  - Sends SDP Offer              │                 │  - Awaits Peer Connection       │
│  - Slices file into 32KB chunks │                 │  - Inspects Transfer Manifest   │
│  - Backpressure flow control    │                 │  - Explicit Accept / Decline    │
└──────────────┬──────────────────┘                 └────────────────┬────────────────┘
               │                                                     │
               │         1. Strongly Consistent Ephemeral Signaling  │
               ├───────────────────► Next.js API ◄───────────────────┤
               │                  (/api/signal/*)                    │
               │                         │                           │
               │                         ▼                           │
               │               Cloudflare Durable Object             │
               │               (SQLite In-Memory State)              │
               │                                                     │
               │        2. Public STUN NAT Traversal (UDP)           │
               ├───────────────────► Google / CF ◄───────────────────┤
               │                                                     │
               │        3. Direct WebRTC P2P DataChannel             │
               │         (DTLS Encrypted SCTP Chunks)                │
               ▼═════════════════════════════════════════════════════▼
                                Direct Byte Stream
                               (Zero Cloud Storage)
```

### 1. Authoritative Signaling & Consistency
The signaling service (`/api/signal/*`) routes each 8-digit pairing code to a dedicated **Cloudflare Durable Object**.
- **Global Strong Consistency**: Because every request for a given pairing code connects to the exact same Durable Object instance, devices on different networks or PoPs immediately see created sessions and signaling handshakes without cross-datacenter replication delay.
- **Atomic Queue**: Session descriptions (SDP offers/answers) and batched ICE candidates are persisted atomically without race conditions or key write throttling.
- **Fail-Closed Operations**: All session creation and signaling submission requests fail closed with explicit HTTP errors if storage persistence cannot be confirmed.
- **Capability-Based Expiry Control**: Only the original session creator possessing the `receiverToken` can extend the session TTL or delete the session.

### 2. NAT Traversal & Connectivity
- **Public STUN**: Enables peers behind residential or cellular NATs to discover reflexive public transport addresses and establish direct UDP connections.
- **Pre-Gathered ICE**: WebRTC offers and answers wait up to 2.2 seconds for initial STUN gathering to embed reflexive addresses directly in the initial SDP payload.
- **Diagnostics**: If strict corporate firewalls or symmetric NATs block UDP hole punching, the connection lifecycle reports explicit diagnostics.

### 3. Transfer Capacity & Quota Constraints
- **Zero Cloud Storage Limit**: Files never touch server storage or cloud buckets (`MAX_TRANSFER_BYTES = Infinity`).
- **Disk & Storage Quotas**: Maximum file size is governed solely by the receiving browser's disk space and browser-allocated OPFS storage quota (typically up to 60-80% of free local disk space on modern desktop and mobile browsers).
- **RAM Bounded Fallback**: Browsers without OPFS support fall back to an in-memory buffer strictly capped at 100 MB to prevent tab memory exhaustion.

### 4. Backpressure & Chunking
- Files are sliced on-demand in **32 KB** binary slices via `File.slice()`.
- If `channel.bufferedAmount > 256 KB`, transmission pauses until the `bufferedamountlow` event fires.
- The sender requires explicit `file-ready` confirmation before transmitting chunks and explicit `file-ack` verification from the receiver before marking any transfer complete.

---

## 🚀 Quickstart & Local Development

### Prerequisites
- Node.js 18+ (tested with Node 20 / 22 / 24)
- npm

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Test Suite
```bash
npm run test
```

### 3. Run the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🧪 Verification & Quality Checks

```bash
# Type check TypeScript code
npx tsc --noEmit

# Run unit and integration tests
npm run test

# Run ESLint
npm run lint

# Build production Next.js bundle
npm run build

# Build OpenNext Cloudflare bundle
npm run cf:build
```

---

## 🌐 Production Deployment

- **Live Application**: [https://ghostshare.shshmichael020.workers.dev](https://ghostshare.shshmichael020.workers.dev)
- **GitHub Repository**: [https://github.com/shshmichael020-alt/ghostshare](https://github.com/shshmichael020-alt/ghostshare)

GhostShare is deployed on **Cloudflare Workers (100% Free Plan)** using OpenNext:
- **Zero cloud storage buckets** (no R2, B2, or S3 needed).
- **Zero payment cards** or billing accounts required.
- **Zero file bandwidth costs** incurred by the server during peer transfers.
- **SQLite Durable Objects** provide strongly consistent global session coordination.

To deploy updates to Cloudflare Workers:
```bash
npm run deploy
```

---

## 🔒 Security Summary

- **DTLS Encryption**: Peer-to-peer data channel packets are end-to-end encrypted with standard WebRTC DTLS.
- **Rejection Sampling**: Pairing PINs use uniform Web Crypto CSPRNG rejection sampling to eliminate modulo bias.
- **Capability Tokens**: Receiver session control operations require an unguessable 192-bit CSPRNG capability token.
- **Payload & Rate Throttling**: Ephemeral signaling endpoints enforce per-IP rate limits and a 64 KB JSON payload ceiling.
- **Explicit Receiver Consent**: No payload bytes are transmitted without interactive receiver approval.
