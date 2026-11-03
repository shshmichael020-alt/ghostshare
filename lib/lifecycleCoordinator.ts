/**
 * GhostShare Lifecycle Coordinator
 *
 * Implements a shared, testable state machine for mobile browser backgrounding,
 * native file-picker suspension, and peer-to-peer pause/resume coordination.
 */

export type ConnStatus =
  | "idle"
  | "awaiting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "disconnected";

export interface LifecycleDiagnosticsEvent {
  timestamp: number;
  event: string;
  role: "creator" | "joiner" | null;
  code: string | null;
  connStatus: ConnStatus;
  pageHidden: boolean;
  localSuspended: boolean;
  localPauseId: string | null;
  remoteSuspended: boolean;
  remotePauseId: string | null;
  iceState?: string;
  connState?: string;
  details?: Record<string, unknown>;
}

export interface LifecycleCoordinatorCallbacks {
  onStatusChange: (status: ConnStatus) => void;
  onTriggerIceRestart: () => Promise<boolean>;
  onSendPeerSuspended: (pauseId: string) => void;
  onSendPeerResumed: (pauseId: string) => void;
  onDiagnostic?: (event: LifecycleDiagnosticsEvent) => void;
  getPeerConnection: () => RTCPeerConnection | null;
  isDataChannelOpen: () => boolean;
}

export class LifecycleCoordinator {
  public role: "creator" | "joiner" | null = null;
  public code: string | null = null;
  public connStatus: ConnStatus = "idle";
  public hasEverConnected: boolean = false;

  public localSuspended: boolean = false;
  public localPauseId: string | null = null;

  public remoteSuspended: boolean = false;
  public remotePauseId: string | null = null;
  public remoteSuspendedAt: number | null = null;

  public pageHidden: boolean = false;
  public postResumeGrace: boolean = false;
  public isIceRestarting: boolean = false;

  public iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  public postResumeGraceTimer: ReturnType<typeof setTimeout> | null = null;

  private diagnosticsBuffer: LifecycleDiagnosticsEvent[] = [];
  private callbacks: LifecycleCoordinatorCallbacks;

  constructor(callbacks: LifecycleCoordinatorCallbacks) {
    this.callbacks = callbacks;
  }

  public setSessionInfo(role: "creator" | "joiner" | null, code: string | null, connStatus?: ConnStatus): void {
    this.role = role;
    this.code = code;
    if (connStatus) {
      this.connStatus = connStatus;
    }
    this.logDiagnostic("session_info_updated", { role, code, connStatus });
  }

  public setStatus(newStatus: ConnStatus): void {
    if (this.connStatus !== newStatus) {
      const prev = this.connStatus;
      this.connStatus = newStatus;
      this.logDiagnostic("status_changed", { prev, next: newStatus });
      this.callbacks.onStatusChange(newStatus);
    }
  }

  /**
   * Cancels both the transient ICE disconnection timer and the post-resume grace timer.
   */
  public cancelRecoveryTimers(reason: string = "unspecified"): void {
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
      this.logDiagnostic("timer_cancelled", { timer: "iceDisconnect", reason });
    }
    if (this.postResumeGraceTimer) {
      clearTimeout(this.postResumeGraceTimer);
      this.postResumeGraceTimer = null;
      this.logDiagnostic("timer_cancelled", { timer: "postResumeGrace", reason });
    }
    this.postResumeGrace = false;
  }

  /**
   * Starts local suspension (e.g. before opening the native file picker).
   * Generates a unique pauseId, clears recovery timers, notifies the peer, and returns the pauseId.
   */
  public startLocalSuspension(reason: string = "file-picker"): string {
    const pauseId = `pause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.localSuspended = true;
    this.localPauseId = pauseId;
    this.cancelRecoveryTimers(`startLocalSuspension:${reason}`);

    this.logDiagnostic("local_suspension_started", { pauseId, reason });
    this.callbacks.onSendPeerSuspended(pauseId);
    return pauseId;
  }

  /**
   * Ends local suspension (e.g. file chosen or picker cancelled).
   * Notifies the peer with peer-resumed and initiates post-resume grace if foregrounded.
   */
  public endLocalSuspension(pauseId?: string): string | null {
    if (!this.localSuspended) {
      return null;
    }
    if (pauseId && this.localPauseId && pauseId !== this.localPauseId) {
      this.logDiagnostic("local_suspension_end_mismatch", { provided: pauseId, active: this.localPauseId });
      return null;
    }

    const currentPauseId = this.localPauseId || `pause-fallback`;
    this.localSuspended = false;
    this.localPauseId = null;

    this.logDiagnostic("local_suspension_ended", { pauseId: currentPauseId });
    this.callbacks.onSendPeerResumed(currentPauseId);

    // If already foregrounded, start post-resume recovery grace window
    if (!this.pageHidden) {
      this.startPostResumeGrace("endLocalSuspension");
    }
    return currentPauseId;
  }

  /**
   * Handles peer-suspended message received from remote peer.
   * Suppresses disconnection timers and prevents premature reconnecting/failed states.
   */
  public handleRemoteSuspended(pauseId: string, timestamp: number = Date.now()): boolean {
    if (!pauseId || typeof pauseId !== "string") {
      return false;
    }

    this.remoteSuspended = true;
    this.remotePauseId = pauseId;
    this.remoteSuspendedAt = timestamp;

    this.cancelRecoveryTimers("remote_peer_suspended");

    // If status had flipped to reconnecting, restore to connected while remote is selecting files
    if (this.connStatus === "reconnecting" && this.hasEverConnected) {
      this.setStatus("connected");
    }

    this.logDiagnostic("remote_peer_suspended", { pauseId, timestamp });
    return true;
  }

  /**
   * Handles peer-resumed message received from remote peer.
   * Validates pauseId to ignore stale resumes, clears suspension, and initiates recovery grace window.
   */
  public handleRemoteResumed(pauseId: string): boolean {
    if (!pauseId || typeof pauseId !== "string") {
      return false;
    }

    // Ignore stale resume message if remotePauseId doesn't match
    if (this.remotePauseId && pauseId !== this.remotePauseId) {
      this.logDiagnostic("stale_resume_ignored", { received: pauseId, expected: this.remotePauseId });
      return false;
    }

    this.remoteSuspended = false;
    this.remotePauseId = null;
    this.remoteSuspendedAt = null;

    this.logDiagnostic("remote_peer_resumed", { pauseId });

    if (!this.pageHidden) {
      this.startPostResumeGrace("remote_peer_resumed");
    }
    return true;
  }

  /**
   * Handles page visibility changes (hidden vs visible).
   */
  public handlePageVisibility(hidden: boolean): void {
    this.pageHidden = hidden;
    this.logDiagnostic("visibility_changed", { hidden });

    if (hidden) {
      this.cancelRecoveryTimers("page_hidden");
    } else {
      // Returned to visible
      if (!this.localSuspended) {
        this.handleForegroundResume();
      }
    }
  }

  /**
   * Evaluates connection health when returning to foreground.
   */
  public handleForegroundResume(): void {
    if (this.pageHidden) {
      return;
    }
    this.logDiagnostic("foreground_resume", {});

    const pc = this.callbacks.getPeerConnection();
    if (!pc || pc.connectionState === "closed" || pc.signalingState === "closed") {
      return;
    }

    const isIceHealthy = pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
    const isConnHealthy = pc.connectionState === "connected" && pc.iceConnectionState !== "disconnected" && pc.iceConnectionState !== "failed";
    const isDataChannelHealthy =
      this.callbacks.isDataChannelOpen() &&
      pc.iceConnectionState !== "disconnected" &&
      pc.iceConnectionState !== "failed" &&
      pc.connectionState !== "failed";

    if (isIceHealthy || isConnHealthy || isDataChannelHealthy) {
      this.cancelRecoveryTimers("foreground_healthy");
      if (this.hasEverConnected && this.connStatus !== "connected") {
        this.setStatus("connected");
      }
      return;
    }

    // Connection appears transiently disconnected or failed during backgrounding; allow grace period to recover
    if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed" || pc.connectionState === "failed") {
      this.startPostResumeGrace("foreground_unhealthy");
    }
  }

  /**
   * Initiates a 5-second post-resume grace window allowing WebRTC STUN consent keepalives to recover.
   */
  public startPostResumeGrace(triggerReason: string): void {
    if (this.localSuspended || this.remoteSuspended || this.pageHidden) {
      this.cancelRecoveryTimers("suspended_or_hidden_suppressed");
      return;
    }

    this.cancelRecoveryTimers("restart_post_resume_grace");
    this.postResumeGrace = true;
    this.logDiagnostic("post_resume_grace_started", { triggerReason });

    this.postResumeGraceTimer = setTimeout(() => {
      this.postResumeGraceTimer = null;
      this.postResumeGrace = false;

      // Ensure conditions still hold
      if (this.pageHidden || this.localSuspended || this.remoteSuspended) {
        this.logDiagnostic("grace_timer_expired_suppressed", {
          pageHidden: this.pageHidden,
          localSuspended: this.localSuspended,
          remoteSuspended: this.remoteSuspended,
        });
        return;
      }

      const pc = this.callbacks.getPeerConnection();
      if (!pc || pc.connectionState === "closed" || pc.signalingState === "closed") {
        return;
      }

      const isDisconnected = pc.iceConnectionState === "disconnected";
      const isFailed = pc.iceConnectionState === "failed" || pc.connectionState === "failed";

      if ((isDisconnected || isFailed) && this.hasEverConnected) {
        this.logDiagnostic("grace_timer_expired_recovery_needed", {
          iceState: pc.iceConnectionState,
          connState: pc.connectionState,
        });
        this.setStatus("reconnecting");
        if (this.role === "joiner" && !this.isIceRestarting) {
          this.isIceRestarting = true;
          this.callbacks
            .onTriggerIceRestart()
            .catch(() => false)
            .finally(() => {
              this.isIceRestarting = false;
            });
        }
      } else {
        this.logDiagnostic("grace_timer_expired_healthy", {
          iceState: pc.iceConnectionState,
          connState: pc.connectionState,
        });
        if (this.hasEverConnected && this.connStatus !== "connected") {
          this.setStatus("connected");
        }
      }
    }, 5000);
  }

  /**
   * Handles WebRTC ICE and connection state changes.
   */
  public handleIceConnectionStateChange(
    iceState: RTCIceConnectionState,
    connState: RTCPeerConnectionState,
  ): void {
    this.logDiagnostic("ice_state_change", { iceState, connState });

    const isIceHealthy = iceState === "connected" || iceState === "completed";
    const isConnHealthy = connState === "connected" && iceState !== "disconnected" && iceState !== "failed";

    if (isIceHealthy || isConnHealthy) {
      this.hasEverConnected = true;
      this.cancelRecoveryTimers("ice_connected");
      this.setStatus("connected");
      return;
    }

    // Suppress disconnection recovery while suspended or hidden
    if (this.localSuspended || this.remoteSuspended || this.pageHidden || this.postResumeGrace) {
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = null;
      }
      this.logDiagnostic("ice_disconnected_suppressed", {
        localSuspended: this.localSuspended,
        remoteSuspended: this.remoteSuspended,
        pageHidden: this.pageHidden,
        postResumeGrace: this.postResumeGrace,
      });
      return;
    }

    if (iceState === "failed" || connState === "failed") {
      if (this.hasEverConnected) {
        // Mobile carrier switch or transient timeout; give post-resume grace window
        this.startPostResumeGrace("ice_failed");
      } else {
        this.cancelRecoveryTimers("hard_failed_initial");
        this.setStatus("failed");
      }
      return;
    }

    if (iceState === "disconnected" && this.hasEverConnected) {
      if (!this.iceDisconnectTimer) {
        this.logDiagnostic("ice_disconnect_timer_scheduled", {});
        this.iceDisconnectTimer = setTimeout(() => {
          this.iceDisconnectTimer = null;

          if (this.pageHidden || this.localSuspended || this.remoteSuspended || this.postResumeGrace) {
            this.logDiagnostic("ice_disconnect_timer_suppressed", {});
            return;
          }

          const pc = this.callbacks.getPeerConnection();
          if (pc && pc.iceConnectionState === "disconnected" && this.hasEverConnected) {
            this.logDiagnostic("ice_disconnect_timer_fired_reconnecting", {});
            this.setStatus("reconnecting");
            if (this.role === "joiner" && !this.isIceRestarting) {
              this.isIceRestarting = true;
              this.callbacks
                .onTriggerIceRestart()
                .catch(() => false)
                .finally(() => {
                  this.isIceRestarting = false;
                });
            }
          }
        }, 5000);
      }
    }
  }

  /**
   * Cleans up all timers and resets state on session disconnect.
   */
  public reset(): void {
    this.cancelRecoveryTimers("session_reset");
    this.localSuspended = false;
    this.localPauseId = null;
    this.remoteSuspended = false;
    this.remotePauseId = null;
    this.remoteSuspendedAt = null;
    this.hasEverConnected = false;
    this.isIceRestarting = false;
    this.connStatus = "disconnected";
    this.role = null;
    this.code = null;
    this.logDiagnostic("session_reset", {});
  }

  public getDiagnostics(): LifecycleDiagnosticsEvent[] {
    return [...this.diagnosticsBuffer];
  }

  private logDiagnostic(event: string, details?: Record<string, unknown>): void {
    const pc = this.callbacks.getPeerConnection();
    const entry: LifecycleDiagnosticsEvent = {
      timestamp: Date.now(),
      event,
      role: this.role,
      code: this.code,
      connStatus: this.connStatus,
      pageHidden: this.pageHidden,
      localSuspended: this.localSuspended,
      localPauseId: this.localPauseId,
      remoteSuspended: this.remoteSuspended,
      remotePauseId: this.remotePauseId,
      iceState: pc?.iceConnectionState,
      connState: pc?.connectionState,
      details,
    };

    this.diagnosticsBuffer.push(entry);
    if (this.diagnosticsBuffer.length > 100) {
      this.diagnosticsBuffer.shift();
    }

    this.callbacks.onDiagnostic?.(entry);

    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
      // Safe development telemetry
      // console.debug("[GhostShare:Lifecycle]", event, details);
    }
  }
}
