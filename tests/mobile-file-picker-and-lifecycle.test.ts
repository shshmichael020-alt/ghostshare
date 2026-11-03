import test from "node:test";
import assert from "node:assert/strict";
import { LifecycleCoordinator, ConnStatus } from "../lib/lifecycleCoordinator";
import { triggerIceRestart } from "../lib/webrtc";

// ---------------------------------------------------------------------------
// Helpers: Mock RTCPeerConnection & DataChannel
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
}) {
  let iceState: RTCIceConnectionState = options?.iceState ?? "connected";
  let connState: RTCPeerConnectionState = options?.connState ?? "connected";
  let signalingState: RTCSignalingState = options?.signalingState ?? "stable";

  const listeners: Record<string, ((event: any) => void)[]> = {};

  return {
    get iceConnectionState() {
      return iceState;
    },
    set iceConnectionState(val: RTCIceConnectionState) {
      iceState = val;
    },
    get connectionState() {
      return connState;
    },
    set connectionState(val: RTCPeerConnectionState) {
      connState = val;
    },
    get signalingState() {
      return signalingState;
    },
    set signalingState(val: RTCSignalingState) {
      signalingState = val;
      const fns = listeners["signalingstatechange"] || [];
      fns.forEach((fn) => fn({ type: "signalingstatechange" }));
    },
    localDescription: { type: "offer" as RTCSdpType, sdp: "v=0" },
    remoteDescription: { type: "answer" as RTCSdpType, sdp: "v=0" },
    createOffer: async (offerOptions?: RTCOfferOptions) => ({
      type: "offer" as RTCSdpType,
      sdp: `v=0\r\niceRestart=${Boolean(offerOptions?.iceRestart)}`,
    }),
    setLocalDescription: async (_desc: RTCSessionDescriptionInit) => {},
    addEventListener: (type: string, fn: (event: any) => void) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: (event: any) => void) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((cb) => cb !== fn);
      }
    },
    close: () => {
      connState = "closed";
      signalingState = "closed";
    },
  } as unknown as RTCPeerConnection;
}

interface PeerFixture {
  role: "creator" | "joiner";
  pc: RTCPeerConnection;
  coordinator: LifecycleCoordinator;
  statuses: ConnStatus[];
  iceRestartsTriggered: number;
  sentSuspended: string[];
  sentResumed: string[];
}

function createPeerFixture(role: "creator" | "joiner", code: string = "12345678"): PeerFixture {
  const pc = createMockPeerConnection({ iceState: "connected", connState: "connected" });
  const statuses: ConnStatus[] = ["connected"];
  const sentSuspended: string[] = [];
  const sentResumed: string[] = [];
  let iceRestartsTriggered = 0;

  const coordinator = new LifecycleCoordinator({
    onStatusChange: (s) => statuses.push(s),
    onTriggerIceRestart: async () => {
      iceRestartsTriggered++;
      return true;
    },
    onSendPeerSuspended: (id) => sentSuspended.push(id),
    onSendPeerResumed: (id) => sentResumed.push(id),
    getPeerConnection: () => pc,
    isDataChannelOpen: () => true,
  });

  coordinator.setSessionInfo(role, code, "connected");
  coordinator.hasEverConnected = true;

  return {
    role,
    pc,
    coordinator,
    statuses,
    get iceRestartsTriggered() {
      return iceRestartsTriggered;
    },
    set iceRestartsTriggered(val: number) {
      iceRestartsTriggered = val;
    },
    sentSuspended,
    sentResumed,
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE: Mobile File Picker and Lifecycle Coordinator
// ---------------------------------------------------------------------------

test.describe("GhostShare Production Mobile Lifecycle and Peer Suspension", () => {
  test("1. Mobile device opens picker for 30 seconds -> neither peer reconnects", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");
      const pcPeer = createPeerFixture("creator");

      // Mobile user opens picker: synchronous local suspension
      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      assert.ok(pauseId.startsWith("pause-"));
      assert.equal(mobile.sentSuspended.length, 1);
      assert.equal(mobile.coordinator.localSuspended, true);

      // Remote PC peer receives peer-suspended message
      pcPeer.coordinator.handleRemoteSuspended(pauseId);
      assert.equal(pcPeer.coordinator.remoteSuspended, true);

      // Mobile OS backgrounds mobile browser -> ICE drops to disconnected
      mobile.coordinator.handlePageVisibility(true);
      (mobile.pc as any).iceConnectionState = "disconnected";
      mobile.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      // Remote PC detects STUN drop after 3-5 seconds -> ICE drops to disconnected
      (pcPeer.pc as any).iceConnectionState = "disconnected";
      pcPeer.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      // 30 seconds pass while user is browsing files in native picker
      t.mock.timers.tick(30000);

      // Neither peer should transition to reconnecting or trigger ICE restart
      assert.equal(mobile.coordinator.connStatus, "connected");
      assert.equal(pcPeer.coordinator.connStatus, "connected");
      assert.equal(mobile.iceRestartsTriggered, 0);
      assert.equal(pcPeer.iceRestartsTriggered, 0);
      assert.equal(mobile.coordinator.iceDisconnectTimer, null);
      assert.equal(pcPeer.coordinator.iceDisconnectTimer, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("2. Mobile device opens picker for 2 minutes -> existing session preserved", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");
      const pcPeer = createPeerFixture("creator");

      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      pcPeer.coordinator.handleRemoteSuspended(pauseId);

      mobile.coordinator.handlePageVisibility(true);
      (mobile.pc as any).iceConnectionState = "disconnected";
      mobile.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      (pcPeer.pc as any).iceConnectionState = "disconnected";
      pcPeer.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      // 2 full minutes elapse
      t.mock.timers.tick(120000);

      assert.equal(mobile.coordinator.connStatus, "connected");
      assert.equal(pcPeer.coordinator.connStatus, "connected");
      assert.notEqual(mobile.pc.connectionState, "closed");
      assert.notEqual(pcPeer.pc.connectionState, "closed");
      assert.equal(mobile.iceRestartsTriggered, 0);
      assert.equal(pcPeer.iceRestartsTriggered, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("3. Remote peer receives suspension message -> remote disconnection timer cancelled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const pcPeer = createPeerFixture("creator");

      // Peer connection drops before suspension arrives
      (pcPeer.pc as any).iceConnectionState = "disconnected";
      pcPeer.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      // Disconnect recovery timer is armed (5-second window)
      assert.ok(pcPeer.coordinator.iceDisconnectTimer !== null);

      // Advance 2 seconds into the 5-second window
      t.mock.timers.tick(2000);

      // Signaling arrives with peer-suspended message
      pcPeer.coordinator.handleRemoteSuspended("pause-remote-123");

      // Timer must be cancelled immediately
      assert.equal(pcPeer.coordinator.iceDisconnectTimer, null);

      // Advance past the original 5-second deadline
      t.mock.timers.tick(5000);

      assert.equal(pcPeer.coordinator.connStatus, "connected");
      assert.equal(pcPeer.iceRestartsTriggered, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("4. File picker opened again during grace period -> previous timer cancelled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");

      // First picker session finishes
      mobile.coordinator.startLocalSuspension("file-picker");
      mobile.coordinator.endLocalSuspension();

      // Grace period timer is now active
      assert.ok(mobile.coordinator.postResumeGraceTimer !== null);
      assert.equal(mobile.coordinator.postResumeGrace, true);

      // 2 seconds in, user immediately opens picker again
      t.mock.timers.tick(2000);
      mobile.coordinator.startLocalSuspension("file-picker-second");

      // Grace timer must be cleanly cancelled
      assert.equal(mobile.coordinator.postResumeGraceTimer, null);
      assert.equal(mobile.coordinator.postResumeGrace, false);
      assert.equal(mobile.coordinator.localSuspended, true);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("5. Page becomes hidden during grace period -> recovery timer cancelled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");

      mobile.coordinator.startPostResumeGrace("test");
      assert.ok(mobile.coordinator.postResumeGraceTimer !== null);

      // User switches tab / locks phone
      mobile.coordinator.handlePageVisibility(true);

      assert.equal(mobile.coordinator.postResumeGraceTimer, null);
      assert.equal(mobile.coordinator.postResumeGrace, false);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("6. Mobile returns and ICE recovers -> no ICE restart initiated", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");

      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      mobile.coordinator.handlePageVisibility(true);
      (mobile.pc as any).iceConnectionState = "disconnected";

      // User finishes picker and returns to tab
      mobile.coordinator.handlePageVisibility(false);
      mobile.coordinator.endLocalSuspension(pauseId);

      // STUN consent keepalives restore connection 1 second later
      t.mock.timers.tick(1000);
      (mobile.pc as any).iceConnectionState = "connected";
      mobile.coordinator.handleIceConnectionStateChange("connected", "connected");

      // Grace period elapses
      t.mock.timers.tick(6000);

      assert.equal(mobile.coordinator.connStatus, "connected");
      assert.equal(mobile.iceRestartsTriggered, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("7. Mobile returns and ICE remains disconnected -> recovery starts after grace period", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");

      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      mobile.coordinator.handlePageVisibility(true);
      (mobile.pc as any).iceConnectionState = "disconnected";

      // User finishes picker and returns to tab
      mobile.coordinator.handlePageVisibility(false);
      mobile.coordinator.endLocalSuspension(pauseId);

      // Connection stays disconnected throughout 5-second grace period
      assert.equal(mobile.coordinator.postResumeGrace, true);
      assert.equal(mobile.iceRestartsTriggered, 0);

      t.mock.timers.tick(5000);

      assert.equal(mobile.coordinator.connStatus, "reconnecting");
      assert.equal(mobile.iceRestartsTriggered, 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("8. Peer resumes with failed ICE state -> exactly one recovery starts", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");

      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      (mobile.pc as any).iceConnectionState = "failed";
      (mobile.pc as any).connectionState = "failed";

      mobile.coordinator.endLocalSuspension(pauseId);
      mobile.coordinator.handleForegroundResume();

      // Rapid repeated focus events should not create duplicate timers
      mobile.coordinator.handleForegroundResume();
      mobile.coordinator.handleForegroundResume();

      t.mock.timers.tick(5000);

      assert.equal(mobile.coordinator.connStatus, "reconnecting");
      assert.equal(mobile.iceRestartsTriggered, 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("9. File picker cancellation -> both peers return to normal", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const mobile = createPeerFixture("joiner");
      const pcPeer = createPeerFixture("creator");

      const pauseId = mobile.coordinator.startLocalSuspension("file-picker");
      pcPeer.coordinator.handleRemoteSuspended(pauseId);

      // User cancels file picker dialog without picking files
      const returnedPauseId = mobile.coordinator.endLocalSuspension();
      assert.equal(returnedPauseId, pauseId);
      assert.equal(mobile.coordinator.localSuspended, false);
      assert.equal(mobile.sentResumed.length, 1);

      // Remote receives peer-resumed
      pcPeer.coordinator.handleRemoteResumed(pauseId);
      assert.equal(pcPeer.coordinator.remoteSuspended, false);

      assert.equal(mobile.coordinator.connStatus, "connected");
      assert.equal(pcPeer.coordinator.connStatus, "connected");
    } finally {
      t.mock.timers.reset();
    }
  });

  test("10. Same file selected twice -> both selections accepted, input reset", async () => {
    const selectedFiles: string[] = [];
    const handleFiles = (files: FileList | File[]) => {
      Array.from(files).forEach((f) => selectedFiles.push(f.name));
    };

    const mockFileInput = {
      value: "C:\\fakepath\\document.pdf",
    };

    const handleFileChange = (e: { target: { files: File[]; value: string } }) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files);
      }
      e.target.value = "";
    };

    const dummyFile = new File(["dummy content"], "photo.png", { type: "image/png" });

    // First selection
    handleFileChange({
      target: {
        files: [dummyFile],
        value: mockFileInput.value,
      },
    });
    assert.equal(selectedFiles.length, 1);
    assert.equal(selectedFiles[0], "photo.png");

    // Second selection of the EXACT same file
    handleFileChange({
      target: {
        files: [dummyFile],
        value: mockFileInput.value,
      },
    });
    assert.equal(selectedFiles.length, 2);
    assert.equal(selectedFiles[1], "photo.png");
  });

  test("11. Host opens picker -> joining peer protected", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const host = createPeerFixture("creator");
      const joiner = createPeerFixture("joiner");

      const pauseId = host.coordinator.startLocalSuspension("file-picker");
      joiner.coordinator.handleRemoteSuspended(pauseId);

      // Host backgrounding causes ICE disconnect
      (joiner.pc as any).iceConnectionState = "disconnected";
      joiner.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      t.mock.timers.tick(30000);

      assert.equal(joiner.coordinator.connStatus, "connected");
      assert.equal(joiner.iceRestartsTriggered, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("12. Joining peer opens picker -> host protected", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const host = createPeerFixture("creator");
      const joiner = createPeerFixture("joiner");

      const pauseId = joiner.coordinator.startLocalSuspension("file-picker");
      host.coordinator.handleRemoteSuspended(pauseId);

      (host.pc as any).iceConnectionState = "disconnected";
      host.coordinator.handleIceConnectionStateChange("disconnected", "connected");

      t.mock.timers.tick(30000);

      assert.equal(host.coordinator.connStatus, "connected");
      assert.equal(host.coordinator.iceDisconnectTimer, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("13. Stale resume message arrives -> newer suspension remains active", async () => {
    const pcPeer = createPeerFixture("creator");

    // Remote peer has suspension #2 active
    pcPeer.coordinator.handleRemoteSuspended("pause-session-2");
    assert.equal(pcPeer.coordinator.remotePauseId, "pause-session-2");

    // Stale resume for pause-session-1 arrives out of order
    const handled = pcPeer.coordinator.handleRemoteResumed("pause-session-1");
    assert.equal(handled, false);
    assert.equal(pcPeer.coordinator.remoteSuspended, true);
    assert.equal(pcPeer.coordinator.remotePauseId, "pause-session-2");

    // Proper resume arrives
    const validHandled = pcPeer.coordinator.handleRemoteResumed("pause-session-2");
    assert.equal(validHandled, true);
    assert.equal(pcPeer.coordinator.remoteSuspended, false);
  });

  test("14. Session intentionally disconnected -> all pause state and timers cleared", async () => {
    const peer = createPeerFixture("joiner");

    peer.coordinator.startLocalSuspension("file-picker");
    peer.coordinator.handleRemoteSuspended("remote-pause-abc");
    peer.coordinator.startPostResumeGrace("test");

    peer.coordinator.reset();

    assert.equal(peer.coordinator.localSuspended, false);
    assert.equal(peer.coordinator.localPauseId, null);
    assert.equal(peer.coordinator.remoteSuspended, false);
    assert.equal(peer.coordinator.remotePauseId, null);
    assert.equal(peer.coordinator.postResumeGraceTimer, null);
    assert.equal(peer.coordinator.iceDisconnectTimer, null);
    assert.equal(peer.coordinator.connStatus, "disconnected");
  });

  test("15. Session expires -> normal expiration and cleanup still work", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const peer = createPeerFixture("creator");
      peer.coordinator.startLocalSuspension("file-picker");

      let isExpired = false;
      let remainingTtl = 5;

      const timer = setInterval(() => {
        remainingTtl--;
        if (remainingTtl <= 0) {
          isExpired = true;
          peer.coordinator.reset();
          clearInterval(timer);
        }
      }, 1000);

      t.mock.timers.tick(6000);

      assert.equal(isExpired, true);
      assert.equal(peer.coordinator.connStatus, "disconnected");
      assert.equal(peer.coordinator.localSuspended, false);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("16. ICE restart mutual exclusion -> triggerIceRestart while in-flight or non-stable signalingState returns false", async () => {
    const mockPc = createMockPeerConnection({
      iceState: "disconnected",
      connState: "connected",
      signalingState: "have-local-offer", // Already negotiating
    });

    // Mock global fetch for signaling message endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    try {
      const restartResult = await triggerIceRestart(
        mockPc,
        "12345678",
        "sender",
        "receiver",
        "token123",
      );

      // Must be rejected because signalingState is not stable
      assert.equal(restartResult, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
