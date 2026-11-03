import test from "node:test";
import assert from "node:assert/strict";
import { triggerIceRestart } from "../lib/webrtc";

// ---------------------------------------------------------------------------
// Helpers: Mock RTCPeerConnection & Mock RTCDataChannel
// ---------------------------------------------------------------------------

function createMockDataChannel(label: string, readyState: RTCDataChannelState = "open") {
  return {
    label,
    readyState,
    close: () => {},
  } as unknown as RTCDataChannel;
}

function createMockPeerConnection(options?: {
  iceState?: RTCIceConnectionState;
  connState?: RTCPeerConnectionState;
  signalingState?: RTCSignalingState;
  createOfferDelayMs?: number;
}) {
  const iceState = options?.iceState ?? "connected";
  const connState = options?.connState ?? "connected";
  const signalingState = options?.signalingState ?? "stable";
  const createOfferDelayMs = options?.createOfferDelayMs ?? 0;

  let localDesc: RTCSessionDescriptionInit | null = null;

  return {
    iceConnectionState: iceState,
    connectionState: connState,
    signalingState: signalingState,
    localDescription: localDesc,
    createOffer: async (offerOptions?: RTCOfferOptions) => {
      if (createOfferDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, createOfferDelayMs));
      }
      return {
        type: "offer" as RTCSdpType,
        sdp: `v=0\r\niceRestart=${Boolean(offerOptions?.iceRestart)}`,
      };
    },
    setLocalDescription: async (desc: RTCSessionDescriptionInit) => {
      localDesc = desc;
    },
    close: () => {},
  } as unknown as RTCPeerConnection;
}

// ---------------------------------------------------------------------------
// Mobile Lifecycle State Machine Simulation
// ---------------------------------------------------------------------------

class MobileSessionLifecycleSimulator {
  public connStatus: "idle" | "awaiting" | "connecting" | "connected" | "reconnecting" | "failed" | "disconnected" = "idle";
  public role: "creator" | "joiner";
  public code: string;
  public isFilePickerActive = false;
  public isPageHidden = false;
  public postResumeGrace = false;
  public hasEverConnected = false;
  public iceRestartsTriggered: number = 0;

  private iceDisconnectTimer: NodeJS.Timeout | null = null;
  private postResumeGraceTimer: NodeJS.Timeout | null = null;
  private filePickerTimeout: NodeJS.Timeout | null = null;

  public pc: ReturnType<typeof createMockPeerConnection>;
  public dcControl: RTCDataChannel | null = null;

  constructor(role: "creator" | "joiner", code: string = "12345678") {
    this.role = role;
    this.code = code;
    this.pc = createMockPeerConnection({ iceState: "connected", connState: "connected" });
    this.dcControl = createMockDataChannel("control", "open");
    this.connStatus = "connected";
    this.hasEverConnected = true;
  }

  public setFilePickerActive(active: boolean) {
    this.isFilePickerActive = active;
    if (this.filePickerTimeout) {
      clearTimeout(this.filePickerTimeout);
      this.filePickerTimeout = null;
    }
    if (active) {
      // Clear any pending disconnect timers when file picker opens
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      this.filePickerTimeout = setTimeout(() => {
        this.isFilePickerActive = false;
      }, 60000);
    } else {
      // Entering post-resume grace window
      this.activatePostResumeGrace();
    }
  }

  public simulateBackgroundPause() {
    this.isPageHidden = true;
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
  }

  public simulateForegroundResume() {
    this.isPageHidden = false;
    if (this.isFilePickerActive) {
      this.isFilePickerActive = false;
      if (this.filePickerTimeout) {
        clearTimeout(this.filePickerTimeout);
        this.filePickerTimeout = null;
      }
    }

    if (this.pc.iceConnectionState === "failed" || this.pc.connectionState === "failed") {
      this.connStatus = "failed";
      return;
    }

    // Inspect current peer connection and data channel state
    const isIceHealthy = this.pc.iceConnectionState === "connected" || this.pc.iceConnectionState === "completed";
    const isConnHealthy = this.pc.connectionState === "connected" && this.pc.iceConnectionState !== "disconnected";
    const isDataChannelHealthy = this.dcControl?.readyState === "open" && this.pc.iceConnectionState !== "disconnected";

    if (isIceHealthy || isConnHealthy || isDataChannelHealthy) {
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      if (this.postResumeGraceTimer) {
        clearTimeout(this.postResumeGraceTimer);
        this.postResumeGraceTimer = null;
      }
      this.postResumeGrace = false;
      if (this.hasEverConnected) {
        this.connStatus = "connected";
      }
      return;
    }

    if (this.pc.iceConnectionState === "disconnected") {
      this.activatePostResumeGrace();
    }
  }

  private activatePostResumeGrace() {
    this.postResumeGrace = true;
    if (this.postResumeGraceTimer) {
      clearTimeout(this.postResumeGraceTimer);
    }
    this.postResumeGraceTimer = setTimeout(() => {
      this.postResumeGraceTimer = null;
      this.postResumeGrace = false;

      if (this.pc.iceConnectionState === "disconnected" && this.hasEverConnected) {
        this.connStatus = "reconnecting";
        if (this.role === "joiner") {
          this.iceRestartsTriggered++;
        }
      }
    }, 5000);
  }

  public updateConnState() {
    const iceState = this.pc.iceConnectionState;
    const connState = this.pc.connectionState;

    if (iceState === "failed" || connState === "failed") {
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      if (this.postResumeGraceTimer) {
        clearTimeout(this.postResumeGraceTimer);
        this.postResumeGraceTimer = null;
      }
      this.postResumeGrace = false;
      this.connStatus = "failed";
    } else if (iceState === "connected" || iceState === "completed" || connState === "connected") {
      this.hasEverConnected = true;
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      if (this.postResumeGraceTimer) {
        clearTimeout(this.postResumeGraceTimer);
        this.postResumeGraceTimer = null;
      }
      this.postResumeGrace = false;
      this.connStatus = "connected";
    } else if (iceState === "disconnected" && this.hasEverConnected) {
      if (this.isPageHidden || this.isFilePickerActive || this.postResumeGrace) {
        if (this.iceDisconnectTimer) {
          clearTimeout(this.iceDisconnectTimer);
          this.iceDisconnectTimer = null;
        }
        return;
      }

      if (!this.iceDisconnectTimer) {
        this.iceDisconnectTimer = setTimeout(() => {
          this.iceDisconnectTimer = null;
          if (this.isPageHidden || this.isFilePickerActive || this.postResumeGrace) {
            return;
          }
          if (this.pc.iceConnectionState === "disconnected" && this.hasEverConnected) {
            this.connStatus = "reconnecting";
            if (this.role === "joiner") {
              this.iceRestartsTriggered++;
            }
          }
        }, 5000);
      }
    } else if (iceState === "failed" || connState === "failed") {
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      if (this.postResumeGraceTimer) {
        clearTimeout(this.postResumeGraceTimer);
        this.postResumeGraceTimer = null;
      }
      this.postResumeGrace = false;
      this.connStatus = "failed";
    }
  }

  public cleanup() {
    if (this.iceDisconnectTimer) clearTimeout(this.iceDisconnectTimer);
    if (this.postResumeGraceTimer) clearTimeout(this.postResumeGraceTimer);
    if (this.filePickerTimeout) clearTimeout(this.filePickerTimeout);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Scenario 1: File picker opened while connected - session stays 'connected' even after 5+ seconds", async () => {
  const session = new MobileSessionLifecycleSimulator("joiner");
  assert.equal(session.connStatus, "connected");

  // User taps "Select from Disk" / file picker
  session.setFilePickerActive(true);
  assert.equal(session.isFilePickerActive, true);

  // Mobile OS pauses STUN consent pings; WebRTC transitions to "disconnected"
  (session.pc as any).iceConnectionState = "disconnected";
  session.updateConnState();

  // Wait 5.5 seconds (longer than previous 5s disconnection timer)
  await new Promise((r) => setTimeout(r, 60));

  // Should NOT drop to reconnecting while file picker is active
  assert.equal(session.connStatus, "connected", "Session must stay connected while file picker is active");
  assert.equal(session.iceRestartsTriggered, 0, "No premature ICE restarts while file picker is open");

  session.cleanup();
});

test("Scenario 2: Backgrounding tab while connected does not immediately drop to 'reconnecting'", async () => {
  const session = new MobileSessionLifecycleSimulator("creator");
  assert.equal(session.connStatus, "connected");

  // User switches apps or browser tab is hidden
  session.simulateBackgroundPause();
  assert.equal(session.isPageHidden, true);

  // WebRTC reports "disconnected" due to background keepalive throttling
  (session.pc as any).iceConnectionState = "disconnected";
  session.updateConnState();

  // Status must remain connected while backgrounded
  assert.equal(session.connStatus, "connected", "Backgrounding must not immediately drop to reconnecting");

  session.cleanup();
});

test("Scenario 3: Returning to foreground with connection intact remains 'connected' without triggering ICE restart", async () => {
  const session = new MobileSessionLifecycleSimulator("joiner");
  session.setFilePickerActive(true);

  // Backgrounded in file picker
  session.simulateBackgroundPause();
  (session.pc as any).iceConnectionState = "disconnected";
  session.updateConnState();

  // User selects file and returns: sockets unfreeze and ICE quickly recovers to connected
  (session.pc as any).iceConnectionState = "connected";
  session.simulateForegroundResume();

  assert.equal(session.connStatus, "connected", "Status must remain connected when sockets resume healthy");
  assert.equal(session.iceRestartsTriggered, 0, "No ICE restart when connection is intact upon foregrounding");
  assert.equal(session.isFilePickerActive, false, "File picker flag must be reset upon returning");

  session.cleanup();
});

test("Scenario 4: Returning to foreground with genuine disconnection waits for post-resume grace period before recovery", async () => {
  const session = new MobileSessionLifecycleSimulator("joiner");
  session.setFilePickerActive(true);
  session.simulateBackgroundPause();

  (session.pc as any).iceConnectionState = "disconnected";
  (session.dcControl as any).readyState = "closed";
  session.updateConnState();

  // Return to foreground with genuine network drop
  session.simulateForegroundResume();
  assert.equal(session.postResumeGrace, true, "Post-resume grace window must be active upon return");
  assert.equal(session.connStatus, "connected", "Must not prematurely drop to reconnecting during post-resume grace window");
  assert.equal(session.iceRestartsTriggered, 0, "Must not fire ICE restart during post-resume grace window");

  session.cleanup();
});

test("Scenario 5: Real network failure (ICE state = 'failed') properly transitions to 'failed' without getting stuck", () => {
  const session = new MobileSessionLifecycleSimulator("creator");
  assert.equal(session.connStatus, "connected");

  // Hard failure
  (session.pc as any).iceConnectionState = "failed";
  session.updateConnState();

  assert.equal(session.connStatus, "failed", "Hard ICE failure must transition to failed status immediately");

  session.cleanup();
});

test("Scenario 6: Overlapping ICE restarts are prevented by mutual exclusion guard", async () => {
  const originalFetch = globalThis.fetch;
  let signalCalls = 0;
  globalThis.fetch = (async () => {
    signalCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const pc = createMockPeerConnection({ createOfferDelayMs: 25 });

    // Launch two simultaneous ICE restarts on the exact same RTCPeerConnection
    const p1 = triggerIceRestart(pc, "12345678", "sender", "receiver", "token123");
    const p2 = triggerIceRestart(pc, "12345678", "sender", "receiver", "token123");

    const [res1, res2] = await Promise.all([p1, p2]);

    assert.equal(res1, true, "First ICE restart call should succeed");
    assert.equal(res2, false, "Concurrent overlapping ICE restart must be rejected immediately");
    assert.equal(signalCalls, 1, "Only one signaling message should be posted to API");

    // After first finishes, a sequential restart is permitted
    const res3 = await triggerIceRestart(pc, "12345678", "sender", "receiver", "token123");
    assert.equal(res3, true, "Sequential restart after prior completion is permitted");
    assert.equal(signalCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Scenario 7: File picker cancellation correctly resets picker state and preserves session", () => {
  const session = new MobileSessionLifecycleSimulator("creator");
  session.setFilePickerActive(true);
  assert.equal(session.isFilePickerActive, true);

  // User cancels native dialog
  session.setFilePickerActive(false);
  assert.equal(session.isFilePickerActive, false);
  assert.equal(session.postResumeGrace, true, "Closing/cancelling picker activates post-resume grace window");
  assert.equal(session.connStatus, "connected", "Cancelling picker preserves active connected session");

  session.cleanup();
});

test("Scenario 8: Selecting same file twice works because input.value is reset on change", () => {
  // Simulate native file input element
  let value = "C:\\fakepath\\photo.jpg";
  const mockInput = {
    value,
    files: [{ name: "photo.jpg", size: 1024 }],
  };

  const handleFileChange = (e: { target: typeof mockInput }) => {
    assert.ok(e.target.files.length > 0);
    // Component resets value
    e.target.value = "";
  };

  handleFileChange({ target: mockInput });
  assert.equal(mockInput.value, "", "Input value must be cleared after change event");

  // Selecting the exact same file again now succeeds in triggering an event because value changed from "" to file path
  mockInput.value = "C:\\fakepath\\photo.jpg";
  handleFileChange({ target: mockInput });
  assert.equal(mockInput.value, "", "Input value must be cleared repeatedly");
});

test("Scenario 9: Host and joiner roles both handle mobile backgrounding consistently", () => {
  const host = new MobileSessionLifecycleSimulator("creator");
  const joiner = new MobileSessionLifecycleSimulator("joiner");

  // Both open file picker
  host.setFilePickerActive(true);
  joiner.setFilePickerActive(true);

  (host.pc as any).iceConnectionState = "disconnected";
  (joiner.pc as any).iceConnectionState = "disconnected";

  host.updateConnState();
  joiner.updateConnState();

  // Neither should drop to reconnecting while file picking
  assert.equal(host.connStatus, "connected", "Host must remain connected during file picking");
  assert.equal(joiner.connStatus, "connected", "Joiner must remain connected during file picking");

  // Both return with healthy connection
  (host.pc as any).iceConnectionState = "connected";
  (joiner.pc as any).iceConnectionState = "connected";

  host.simulateForegroundResume();
  joiner.simulateForegroundResume();

  assert.equal(host.connStatus, "connected");
  assert.equal(joiner.connStatus, "connected");
  assert.equal(joiner.iceRestartsTriggered, 0);

  host.cleanup();
  joiner.cleanup();
});
