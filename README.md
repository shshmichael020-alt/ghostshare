# GhostShare — Privacy-First WebRTC Peer-to-Peer File Transfer

GhostShare is an anonymous, browser-based, direct peer-to-peer file-transfer application.

Files travel directly browser-to-browser across encrypted WebRTC SCTP data channels. **Zero cloud file-storage accounts, zero credit cards, and zero billing credentials are required.**

One device opens GhostShare in Receive mode, generating a cryptographically secure 8-digit pairing code and QR code. Another device scans or enters the code in Send mode. Once paired, the sender stages files, the receiver provides explicit authorization, and the files stream directly peer-to-peer.

---

## 🌟 Key Features

- **Zero Cloud File Storage**: No Backblaze B2, Cloudflare R2, AWS S3, or third-party buckets. File contents never touch any central server or disk.
- **Direct WebRTC SCTP Data Channels**: Files stream as raw binary chunks (32 KB MTU) with end-to-end DTLS 1.3 encryption.
- **Memory Safety & Backpressure Control**: On-demand file slicing via `File.slice()` and `bufferedamountlow` throttling (256 KB high-water mark) prevents browser RAM saturation on large, unlimited transfers.
- **Explicit Receiver Approval**: Receiver must explicitly authorize the file transfer request before any file bytes begin transmitting.
- **8-Digit Ephemeral Pairing & QR Codes**: Generated via Web Crypto API CSPRNG rejection sampling with automated self-destruction after 15 minutes.
- **Multi-File Staging & Drag-and-Drop**: Supports folder drag-and-drop, native file selection, and clipboard paste (`Ctrl+V` / `⌘+V`) for screenshots and files.
- **NAT Traversal with Public STUN**: Uses Google and Cloudflare public STUN servers for direct UDP hole punching across standard residential and mobile networks.
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
               │         1. Ephemeral Signaling (SDP & ICE)          │
               ├───────────────────► Next.js API ◄───────────────────┤
               │                  (/api/signal/*)                    │
               │                                                     │
               │        2. Public STUN NAT Traversal (UDP)           │
               ├───────────────────► Google / CF ◄───────────────────┤
               │                                                     │
               │                                                     │
               │        3. Direct WebRTC P2P DataChannel             │
               │         (DTLS 1.3 Encrypted SCTP Chunks)            │
               ▼═════════════════════════════════════════════════════▼
                               Direct Byte Stream
                            (Zero Cloud Storage)
```

### 1. Signaling
The signaling server (`/api/signal/*`) coordinates connection establishment by exchanging:
- Session descriptions (SDP offers and answers).
- Interactive Connectivity Establishment (ICE) candidate IP/port pairs.
- Session leave/disconnect signals.

Signaling sessions self-destruct after 15 minutes. **File payloads never touch the signaling server.**

### 2. NAT Traversal & Connectivity
- **Public STUN**: Enables peers behind residential NATs to discover their reflexive public endpoints and establish direct UDP connections.
- **Symmetric NAT / Strict Firewalls**: In certain corporate or double-NAT environments where direct UDP hole-punching is blocked, WebRTC connection state will report diagnostics. An optional TURN relay can be configured via environment variables if desired.

### 3. Backpressure & Chunking
Sending large files over `RTCDataChannel` without backpressure crashes browser buffers (`OperationError`). GhostShare solves this:
- Files are sliced on-demand in **32 KB** slices using `File.slice(offset, end).arrayBuffer()`.
- If `channel.bufferedAmount > 256 KB`, transmission pauses until the `bufferedamountlow` event fires.

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
Verify pairing token generation, signaling store, WebRTC protocol serialization, rate limiting, and formatters:
```bash
npm run test
```

### 3. Run the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

To test peer-to-peer file transfer:
1. Open [http://localhost:3000](http://localhost:3000) in **Browser Window A** (Receive mode). Note the 8-digit code.
2. Open [http://localhost:3000](http://localhost:3000) in **Browser Window B** (or an Incognito window / another device on your network).
3. Switch to **Send** mode, enter the 8-digit code, and click **Connect Recipient**.
4. Stage files (drag-and-drop or disk select) and click **Begin Direct Transfer**.
5. Switch to **Browser Window A**, click **Accept & Stream Files**.
6. Watch real-time progress bars update as binary chunks stream across the WebRTC data channel!

---

## 🧪 Verification & Quality Checks

Run the complete suite of quality checks:

```bash
# Type check TypeScript code
npx tsc --noEmit

# Run unit and integration tests
npm run test

# Run ESLint
npm run lint

# Build production bundle
npm run build
```

---

## 🌐 Production Deployment

GhostShare can be hosted on any Node.js hosting platform, VPS, or serverless provider (Vercel, Cloudflare Workers via OpenNext, Netlify, Docker, etc.).

Because GhostShare uses WebRTC direct peer-to-peer transfers:
- **No cloud storage buckets** (R2, B2, S3) are needed.
- **No payment card or billing information** is required.
- **Zero file bandwidth costs** are incurred by the hosting provider during transfers.

To deploy on Cloudflare Workers (optional):
```bash
npm run deploy
```

---

## 🔒 Security Summary

- **DTLS 1.3 Encryption**: All peer-to-peer data channel packets are end-to-end encrypted with standard DTLS-SRTP.
- **Rejection Sampling**: Pairing PINs use uniform Web Crypto CSPRNG rejection sampling to avoid modulo bias.
- **Memory Protection**: ArrayBuffers are loaded in 32 KB slices and released once acknowledged.
- **Rate Limiting**: Ephemeral signaling endpoints enforce per-IP rate limits to prevent brute-force pairing discovery.
- **Explicit Receiver Consent**: No payload bytes are accepted without user interaction.
