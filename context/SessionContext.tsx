"use client";

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import {
  createPeerConnection,
  fetchIceServers,
  waitForIceGathering,
  streamFileOverDataChannel,
  decodeBinaryFrame,
  WebRTCMessage,
  TransferManifestFile,
  DATA_CHANNEL_LABELS,
  triggerIceRestart,
  sendSignalMessage,
  fetchSignalMessages,
  isValidIceCandidateInit,
  sanitizeFileName,
  sanitizeMimeType,
  sanitizeFileId,
  sanitizeChatText,
  generateTransferId,
  isValidProtocolId,
} from "@/lib/webrtc";
import { createIncomingFileSink, OpfsFileStreamer } from "@/lib/opfs";
import { DEFAULT_TTL_SECONDS } from "@/lib/constants";
import ToastStack from "@/components/ToastStack";
import { useToasts } from "@/lib/useToasts";

export type SessionMode = "receive" | "send" | "dual";

export interface StagedItem {
  id: string;
  file: File;
  name: string;
  size: number;
  progress: number;
  status: "idle" | "requesting" | "accepted" | "uploading" | "awaiting-verification" | "done" | "error";
  error?: string;
  batchId?: string;
}

export interface ReceivedFileItem {
  id: string;
  name: string;
  size: number;
  downloadUrl: string;
  blob: File | Blob;
  receivedAt: number;
}

export interface ChatMessage {
  id: string;
  sender: "me" | "peer";
  senderName: string;
  text: string;
  timestamp: number;
}

export interface PendingInboundApproval {
  batchId: string;
  files: TransferManifestFile[];
}

export interface ActiveReceivingItem {
  id: string;
  name: string;
  size: number;
  receivedBytes: number;
  batchId?: string;
}

export interface SessionContextType {
  // Mode & navigation
  mode: SessionMode;
  setMode: (mode: SessionMode) => void;

  // Session metadata & connection
  role: "creator" | "joiner" | null;
  code: string | null;
  sessionToken: string | null;
  connStatus: "idle" | "awaiting" | "connecting" | "connected" | "reconnecting" | "failed" | "disconnected";
  error: string | null;
  natWarning: string | null;
  remainingTtl: number | null;
  initialTtl: number;
  copiedLink: boolean;

  // Connection management
  startHostSession: (ttlSeconds?: number) => Promise<string | null>;
  joinGuestSession: (codeToJoin: string) => Promise<boolean>;
  disconnectSession: () => void;
  updateExpiryWindow: (newTtlSeconds: number) => Promise<void>;
  copyLink: () => void;
  shareLink: () => Promise<void>;

  // Outbound transfer (Send)
  stagedFiles: StagedItem[];
  outboundPhase: "idle" | "awaiting-approval" | "transferring" | "done";
  handleFiles: (files: FileList | File[]) => void;
  removeStagedItem: (id: string) => void;
  clearAllStaged: () => void;
  triggerTransferRequest: () => Promise<void>;
  retryFailedFile: (id: string) => void;

  // Inbound transfer (Receive)
  pendingApproval: PendingInboundApproval | null;
  handleAcceptTransfer: () => void;
  handleDeclineTransfer: () => void;
  activeReceiving: ActiveReceivingItem | null;
  receivedFiles: ReceivedFileItem[];
  downloadAllFiles: () => Promise<void>;
  downloadSingleFile: (file: ReceivedFileItem) => void;

  // Ephemeral Live Chat
  messages: ChatMessage[];
  unreadCount: number;
  isChatOpen: boolean;
  toggleChat: () => void;
  setIsChatOpen: (open: boolean) => void;
  sendMessage: (text: string) => boolean;
  markChatRead: () => void;

  // UI Toast helpers
  pushToast: (msg: string, type?: "default" | "success" | "error") => void;
}

const SessionContext = createContext<SessionContextType | null>(null);

export function useGhostSession(): SessionContextType {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useGhostSession must be used within a SessionProvider");
  }
  return ctx;
}

export function SessionProvider({
  children,
  initialMode = "receive",
}: {
  children: ReactNode;
  initialMode?: SessionMode;
}) {
  const [mode, setMode] = useState<SessionMode>(initialMode);
  const [role, setRole] = useState<"creator" | "joiner" | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<
    "idle" | "awaiting" | "connecting" | "connected" | "reconnecting" | "failed" | "disconnected"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [natWarning, setNatWarning] = useState<string | null>(null);
  const [remainingTtl, setRemainingTtl] = useState<number | null>(null);
  const [initialTtl, setInitialTtl] = useState<number>(DEFAULT_TTL_SECONDS);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Outbound state
  const [stagedFiles, setStagedFiles] = useState<StagedItem[]>([]);
  const stagedFilesRef = useRef<StagedItem[]>([]);
  useEffect(() => {
    stagedFilesRef.current = stagedFiles;
  }, [stagedFiles]);

  const [outboundPhase, setOutboundPhase] = useState<"idle" | "awaiting-approval" | "transferring" | "done">("idle");
  const currentOutboundBatchIdRef = useRef<string | null>(null);
  const cancelTransferRef = useRef<boolean>(false);

  // Inbound state
  const [pendingApproval, setPendingApproval] = useState<PendingInboundApproval | null>(null);
  const [activeReceiving, setActiveReceiving] = useState<ActiveReceivingItem | null>(null);
  const activeReceivingRef = useRef<ActiveReceivingItem | null>(null);
  useEffect(() => {
    activeReceivingRef.current = activeReceiving;
  }, [activeReceiving]);

  const [receivedFiles, setReceivedFiles] = useState<ReceivedFileItem[]>([]);

  // In-memory active sinks for incoming files
  const activeSinksRef = useRef<
    Map<
      string,
      {
        streamer: OpfsFileStreamer;
        meta: { id: string; name: string; size: number; mimeType: string };
        batchId?: string;
        fileEndReceived?: boolean;
        finalizing?: boolean;
        expectedSize: number;
        receivedBytes: number;
        onChunkWritten?: () => void;
      }
    >
  >(new Map());
  const pendingChunksRef = useRef<Map<string, { payload: ArrayBuffer; offset?: number }[]>>(new Map());

  // Ephemeral Live Chat (In-memory ONLY)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const lastChatSendTimeRef = useRef<number[]>([]);

  // WebRTC references
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcControlRef = useRef<RTCDataChannel | null>(null);
  const dcFileOutRef = useRef<RTCDataChannel | null>(null);
  const dcFileInRef = useRef<RTCDataChannel | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSignalSeqRef = useRef<number>(0);
  const isConnectingRef = useRef<boolean>(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const hasAnsweredRef = useRef<boolean>(false);
  const savedSenderTokensRef = useRef<Record<string, string>>({});
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const currentCodeRef = useRef<string | null>(null);
  const currentTokenRef = useRef<string | null>(null);
  const currentRoleRef = useRef<"creator" | "joiner" | null>(null);

  useEffect(() => {
    currentCodeRef.current = code;
  }, [code]);
  useEffect(() => {
    currentTokenRef.current = sessionToken;
  }, [sessionToken]);
  useEffect(() => {
    currentRoleRef.current = role;
  }, [role]);

  const { toasts, push, dismiss } = useToasts();

  const pushToast = useCallback(
    (msg: string, type: "default" | "success" | "error" = "default") => {
      push(msg, type);
    },
    [push],
  );

  // -------------------------------------------------------------
  // Data Channel Handlers
  // -------------------------------------------------------------
  const handleControlMessage = useCallback(
    async (rawData: string) => {
      try {
        const msg = JSON.parse(rawData) as WebRTCMessage;

        if (msg.type === "chat") {
          const cleanText = sanitizeChatText(msg.text);
          if (!cleanText) return;
          const chatMsg: ChatMessage = {
            id: typeof msg.id === "string" ? msg.id : `msg_${Date.now()}`,
            sender: "peer",
            senderName: sanitizeChatText(msg.senderName || "Peer", 40),
            text: cleanText,
            timestamp: typeof msg.sentAt === "number" && Number.isFinite(msg.sentAt) ? msg.sentAt : Date.now(),
          };
          setMessages((prev) => [...prev, chatMsg]);
          setIsChatOpen((open) => {
            if (!open) {
              setUnreadCount((c) => c + 1);
            }
            return open;
          });
        } else if (msg.type === "transfer-request") {
          const rawFiles = Array.isArray(msg.files) ? msg.files : [];
          const batchId = isValidProtocolId(msg.batchId) ? msg.batchId : `b_${generateTransferId()}`;
          const sanitizedFiles: TransferManifestFile[] = [];

          for (const f of rawFiles) {
            if (!f || !isValidProtocolId(f.id)) {
              console.warn("Rejecting transfer request with invalid protocol file ID:", f?.id);
              const ctrl = dcControlRef.current;
              if (ctrl && ctrl.readyState === "open") {
                ctrl.send(
                  JSON.stringify({
                    type: "transfer-decline",
                    batchId,
                    reason: "Invalid protocol file ID format",
                    senderRole: role || undefined,
                  }),
                );
              }
              return;
            }
            sanitizedFiles.push({
              id: f.id,
              name: sanitizeFileName(f.name),
              size: typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : 0,
              type: sanitizeMimeType(f.type),
            });
          }

          setPendingApproval({
            batchId,
            files: sanitizedFiles,
          });
          pushToast(`Peer requested to transfer ${sanitizedFiles.length} file(s)`, "default");
        } else if (msg.type === "transfer-accept") {
          if (msg.batchId && currentOutboundBatchIdRef.current && msg.batchId !== currentOutboundBatchIdRef.current) {
            console.warn(`Ignoring transfer-accept for mismatched batch ${msg.batchId}`);
            return;
          }
          pushToast("Peer approved transfer! Commencing P2P stream...", "success");
          setStagedFiles((prev) =>
            prev.map((f) => (f.status === "requesting" ? { ...f, status: "accepted" } : f)),
          );
          setOutboundPhase("transferring");
        } else if (msg.type === "transfer-decline") {
          if (msg.batchId && currentOutboundBatchIdRef.current && msg.batchId !== currentOutboundBatchIdRef.current) {
            console.warn(`Ignoring transfer-decline for mismatched batch ${msg.batchId}`);
            return;
          }
          pushToast(msg.reason ? `Transfer declined: ${msg.reason}` : "Peer declined the transfer request", "error");
          setOutboundPhase("idle");
          setStagedFiles((prev) =>
            prev.map((f) => (f.status === "requesting" || f.status === "accepted" ? { ...f, status: "idle" } : f)),
          );
          currentOutboundBatchIdRef.current = null;
        } else if (msg.type === "file-start") {
          const fileId = msg.id;
          if (!isValidProtocolId(fileId)) {
            console.error("Invalid protocol file ID in file-start:", fileId);
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-error",
                  id: typeof fileId === "string" ? fileId : "unknown",
                  error: "Malformed protocol file ID",
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            return;
          }

          // Check if this file was already verified & completed in receivedFiles
          const alreadyCompleted = receivedFiles.find((f) => f.id === fileId);
          if (alreadyCompleted) {
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-ready",
                  id: fileId,
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            return;
          }

          // Discard any existing active sink or pending chunks for this file ID (e.g. fresh retry attempt)
          const existingSink = activeSinksRef.current.get(fileId);
          if (existingSink) {
            activeSinksRef.current.delete(fileId);
          }

          const safeName = sanitizeFileName(msg.name);
          const safeMime = sanitizeMimeType(msg.mimeType);
          const safeSize = typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size >= 0 ? msg.size : 0;
          const startOffset = typeof msg.offset === "number" && Number.isFinite(msg.offset) && msg.offset >= 0 ? msg.offset : 0;

          if (startOffset === 0) {
            pendingChunksRef.current.delete(fileId);
          }

          try {
            const streamer = await createIncomingFileSink(
              code || "default",
              fileId,
              safeName,
              safeMime,
              safeSize,
              startOffset,
            );

            const sinkEntry = {
              streamer,
              meta: { id: fileId, name: safeName, size: safeSize, mimeType: safeMime },
              batchId: msg.batchId,
              fileEndReceived: false,
              finalizing: false,
              expectedSize: safeSize,
              receivedBytes: streamer.getBytesWritten(),
              onChunkWritten: undefined as (() => void) | undefined,
            };
            activeSinksRef.current.set(fileId, sinkEntry);

            // Drain any chunks that arrived early
            const early = pendingChunksRef.current.get(fileId);
            if (early && early.length > 0) {
              for (const c of early) {
                await streamer.write(c.payload, c.offset);
              }
              pendingChunksRef.current.delete(fileId);
              sinkEntry.receivedBytes = streamer.getBytesWritten();
            }

            setActiveReceiving({
              id: fileId,
              name: safeName,
              size: safeSize,
              receivedBytes: streamer.getBytesWritten(),
              batchId: msg.batchId,
            });

            // Signal peer on control channel that sink is ready
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-ready",
                  id: fileId,
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
          } catch (sinkErr) {
            console.error("Sink allocation error:", sinkErr);
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-error",
                  id: fileId,
                  error: (sinkErr as Error).message || "Storage allocation failed",
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            pushToast(`Storage error for ${safeName}: ${(sinkErr as Error).message}`, "error");
          }
        } else if (msg.type === "file-end") {
          const fileId = msg.id;

          // If already verified & completed (e.g. duplicate ack or re-ack), immediately send file-ack
          const alreadyCompleted = receivedFiles.find((f) => f.id === fileId);
          if (alreadyCompleted) {
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-ack",
                  id: fileId,
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            return;
          }

          const active = activeSinksRef.current.get(fileId);
          if (!active) {
            console.warn(`file-end received for unknown or already completed sink: ${fileId}`);
            return;
          }

          if (active.finalizing) {
            return;
          }
          active.finalizing = true;
          active.fileEndReceived = true;

          const expectedSize = active.meta.size;
          const startTime = Date.now();
          const maxWaitMs = 12000;

          // Bounded wait for in-flight binary chunks to arrive and finish disk writes.
          // CRITICAL: active sink remains in activeSinksRef throughout this loop so chunks can be written!
          while (active.streamer.getBytesWritten() < expectedSize && Date.now() - startTime < maxWaitMs) {
            await new Promise<void>((resolve) => {
              let resolved = false;
              const onDone = () => {
                if (!resolved) {
                  resolved = true;
                  active.onChunkWritten = undefined;
                  resolve();
                }
              };
              active.onChunkWritten = onDone;
              setTimeout(onDone, 80);
            });
          }

          if (active.streamer.getBytesWritten() < expectedSize) {
            const errDesc = `Incomplete transfer: expected ${expectedSize} bytes, got ${active.streamer.getBytesWritten()} bytes`;
            activeSinksRef.current.delete(fileId);
            setActiveReceiving((prev) => (prev?.id === fileId ? null : prev));
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-error",
                  id: fileId,
                  error: errDesc,
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            pushToast(`Transfer failed for ${active.meta.name}: incomplete data received`, "error");
            return;
          }

          try {
            const file = await active.streamer.close();
            if (file.size !== expectedSize) {
              throw new Error(`Size mismatch: expected ${expectedSize} bytes, but wrote ${file.size} bytes`);
            }

            const downloadUrl = URL.createObjectURL(file);
            const completedItem: ReceivedFileItem = {
              id: active.meta.id,
              name: active.meta.name,
              size: file.size,
              downloadUrl,
              blob: file,
              receivedAt: Date.now(),
            };

            setReceivedFiles((prev) => {
              const existing = prev.filter((f) => f.id !== active.meta.id);
              return [...existing, completedItem];
            });

            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-ack",
                  id: fileId,
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            pushToast(`Received: ${active.meta.name} (Verified & Persisted)`, "success");
          } catch (closeErr) {
            console.error("File finalization error:", closeErr);
            const ctrl = dcControlRef.current;
            if (ctrl && ctrl.readyState === "open") {
              ctrl.send(
                JSON.stringify({
                  type: "file-error",
                  id: fileId,
                  error: (closeErr as Error).message || "Verification failed",
                  batchId: msg.batchId,
                  senderRole: role || undefined,
                }),
              );
            }
            pushToast(`Verification failed for ${active.meta.name}: ${(closeErr as Error).message}`, "error");
          } finally {
            activeSinksRef.current.delete(fileId);
            setActiveReceiving((prev) => (prev?.id === fileId ? null : prev));
          }
        } else if (msg.type === "transfer-complete") {
          setActiveReceiving(null);
          setPendingApproval(null);
          pushToast("All incoming files transferred successfully!", "success");
        }
      } catch (err) {
        console.error("Error processing control message:", err);
      }
    },
    [code, role, receivedFiles, pushToast],
  );

  const handleBinaryChunk = useCallback(async (data: ArrayBuffer | Blob) => {
    let rawBuffer: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      rawBuffer = data;
    } else {
      rawBuffer = await (data as Blob).arrayBuffer();
    }

    const frame = decodeBinaryFrame(rawBuffer);
    let targetFileId: string | null = null;
    let payload: ArrayBuffer = rawBuffer;
    let chunkOffset: number | undefined = undefined;

    if (frame) {
      targetFileId = frame.fileId;
      payload = frame.payload;
      chunkOffset = frame.offset;
    } else {
      // Fallback: if unframed raw binary, route to currently active sink
      if (activeReceivingRef.current) {
        targetFileId = activeReceivingRef.current.id;
      }
    }

    if (targetFileId) {
      const active = activeSinksRef.current.get(targetFileId);
      if (active) {
        await active.streamer.write(payload, chunkOffset);
        const written = active.streamer.getBytesWritten();
        active.receivedBytes = written;
        setActiveReceiving((prev) =>
          prev && prev.id === targetFileId ? { ...prev, receivedBytes: written } : prev,
        );
        if (active.onChunkWritten) {
          active.onChunkWritten();
        }
      } else {
        const buffered = pendingChunksRef.current.get(targetFileId) || [];
        buffered.push({ payload, offset: chunkOffset });
        pendingChunksRef.current.set(targetFileId, buffered);
      }
    }
  }, []);

  const attachDataChannelListeners = useCallback(
    (channel: RTCDataChannel, label: string) => {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 64 * 1024;

      channel.onopen = () => {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        setConnStatus("connected");
        setNatWarning(null);
        setError(null);
        pushToast("Direct P2P bridge established with Peer", "success");
      };

      channel.onclose = () => {
        if (label === DATA_CHANNEL_LABELS.CONTROL || label === DATA_CHANNEL_LABELS.LEGACY_FILE_TRANSFER) {
          setConnStatus((prev) => (prev === "connected" ? "awaiting" : prev));
          pushToast("Peer connection detached (Files remain accessible)", "default");
        }
      };

      channel.onerror = (err) => {
        console.error(`DataChannel [${label}] error:`, err);
      };

      channel.onmessage = (event) => {
        if (typeof event.data === "string") {
          handleControlMessage(event.data);
        } else {
          handleBinaryChunk(event.data);
        }
      };
    },
    [handleControlMessage, handleBinaryChunk, pushToast],
  );

  // -------------------------------------------------------------
  // Clean Disconnect & Teardown
  // -------------------------------------------------------------
  const disconnectSession = useCallback(() => {
    if (currentRoleRef.current === "joiner" && currentCodeRef.current && currentTokenRef.current) {
      sendSignalMessage(currentCodeRef.current, "sender", "receiver", "leave", {}, currentTokenRef.current);
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.removeItem(`gs_sender_${currentCodeRef.current}`);
        } catch {}
      }
    }

    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }

    if (dcControlRef.current) {
      dcControlRef.current.close();
      dcControlRef.current = null;
    }
    if (dcFileOutRef.current) {
      dcFileOutRef.current.close();
      dcFileOutRef.current = null;
    }
    if (dcFileInRef.current) {
      dcFileInRef.current.close();
      dcFileInRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    activeSinksRef.current.clear();
    pendingChunksRef.current.clear();
    pendingCandidatesRef.current = [];
    cancelTransferRef.current = false;
    currentOutboundBatchIdRef.current = null;
    isConnectingRef.current = false;
    hasAnsweredRef.current = false;

    // Ephemeral chat wiped strictly from memory on disconnect
    setMessages([]);
    setUnreadCount(0);
    setIsChatOpen(false);

    setConnStatus("disconnected");
    setRole(null);
    setCode(null);
    setSessionToken(null);
    setOutboundPhase("idle");
    setStagedFiles([]);
    setPendingApproval(null);
    setActiveReceiving(null);
  }, []);

  // -------------------------------------------------------------
  // Session Creation (Creator / Host Flow)
  // -------------------------------------------------------------
  const startHostSession = useCallback(
    async (selectedTtl = DEFAULT_TTL_SECONDS): Promise<string | null> => {
      disconnectSession();
      setError(null);
      setNatWarning(null);
      setConnStatus("idle");
      lastSignalSeqRef.current = 0;

      try {
        const res = await fetch("/api/signal/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ttlSeconds: selectedTtl }),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errData.error || "Could not start receiving session");
        }

        const data = (await res.json()) as { code: string; expiresAt: number; receiverToken?: string };
        const currentCode = data.code;
        const currentToken = data.receiverToken || null;

        setCode(currentCode);
        setSessionToken(currentToken);
        setRole("creator");
        const rem = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
        setRemainingTtl(rem);
        setInitialTtl(rem || selectedTtl);
        setConnStatus("awaiting");

        const iceServers = await fetchIceServers();
        const pc = createPeerConnection(iceServers);
        pcRef.current = pc;

        // Debounced candidate dispatch
        let candDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        const outgoingCandidates: RTCIceCandidateInit[] = [];

        const safeAddCandidate = async (targetPc: RTCPeerConnection, cand: RTCIceCandidateInit) => {
          if (!isValidIceCandidateInit(cand)) return;
          try {
            await targetPc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {
            const rawCand = typeof cand.candidate === "string" ? cand.candidate : "";
            const typMatch = rawCand.match(/typ\s+(\w+)/);
            const candType = typMatch ? typMatch[1] : "unknown";
            const protoMatch = rawCand.match(/\b(udp|tcp)\b/i);
            const candProto = protoMatch ? protoMatch[1].toLowerCase() : "unknown";
            console.warn(
              `[WebRTC ICE Diagnostic] Candidate (${candProto}/${candType}) rejected:`,
              (err as Error).name,
              (err as Error).message,
            );
          }
        };

        const flushCandidates = () => {
          if (outgoingCandidates.length > 0) {
            const batch = [...outgoingCandidates];
            outgoingCandidates.length = 0;
            sendSignalMessage(currentCode, "receiver", "sender", "candidate-batch", batch, currentToken || undefined);
          }
        };

        pc.onicecandidate = (event) => {
          if (isValidIceCandidateInit(event.candidate)) {
            outgoingCandidates.push(event.candidate.toJSON());
            if (candDebounceTimer) clearTimeout(candDebounceTimer);
            candDebounceTimer = setTimeout(flushCandidates, 150);
          } else if (!event.candidate) {
            if (candDebounceTimer) clearTimeout(candDebounceTimer);
            flushCandidates();
          }
        };

        let hasEverConnected = false;
        let iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
        const updateConnState = () => {
          const iceState = pc.iceConnectionState;
          const connState = pc.connectionState;

          if (iceState === "connected" || iceState === "completed" || connState === "connected") {
            hasEverConnected = true;
            if (iceDisconnectTimer) {
              clearTimeout(iceDisconnectTimer);
              iceDisconnectTimer = null;
            }
            setConnStatus("connected");
            setNatWarning(null);
            setError(null);
          } else if (iceState === "disconnected" && hasEverConnected) {
            // Grace period: transient mobile carrier latency (only after initial connection was established)
            if (!iceDisconnectTimer) {
              iceDisconnectTimer = setTimeout(() => {
                if (pc.iceConnectionState === "disconnected" && pcRef.current === pc && hasEverConnected) {
                  setConnStatus("reconnecting");
                }
              }, 5000);
            }
          } else if (iceState === "failed" || connState === "failed") {
            if (iceDisconnectTimer) {
              clearTimeout(iceDisconnectTimer);
              iceDisconnectTimer = null;
            }
            setConnStatus("failed");
            setNatWarning(
              "Direct P2P UDP tunnel could not be established. Check if either device is on a restricted network or firewall blocking WebRTC.",
            );
          }
        };

        pc.oniceconnectionstatechange = updateConnState;
        pc.onconnectionstatechange = updateConnState;

        // Incoming data channels created by joining peer
        pc.ondatachannel = (event) => {
          const ch = event.channel;
          if (ch.label === DATA_CHANNEL_LABELS.CONTROL) {
            dcControlRef.current = ch;
            attachDataChannelListeners(ch, DATA_CHANNEL_LABELS.CONTROL);
          } else if (ch.label === DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR) {
            dcFileInRef.current = ch;
            attachDataChannelListeners(ch, DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR);
          } else if (ch.label === DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER) {
            dcFileOutRef.current = ch;
            attachDataChannelListeners(ch, DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER);
          } else {
            // Unified / fallback channel
            dcControlRef.current = ch;
            dcFileOutRef.current = ch;
            dcFileInRef.current = ch;
            attachDataChannelListeners(ch, ch.label);
          }
        };

        // Start countdown ticker
        tickIntervalRef.current = setInterval(() => {
          setRemainingTtl((prev) => {
            if (prev === null || prev <= 1) {
              disconnectSession();
              return 0;
            }
            return prev - 1;
          });
        }, 1000);

        // Start polling signaling server for offers and candidates
        let isPolling = false;
        pollIntervalRef.current = setInterval(async () => {
          if (isPolling) return;
          isPolling = true;
          try {
            const pollRes = await fetchSignalMessages(
              currentCode,
              "receiver",
              lastSignalSeqRef.current,
              currentToken || undefined,
            );

            if (pollRes.cursor > lastSignalSeqRef.current) {
              lastSignalSeqRef.current = pollRes.cursor;
            }

            for (const item of pollRes.messages) {
              if (item.type === "offer") {
                if (pc.signalingState !== "stable") {
                  console.warn("Skipping offer due to signalingState:", pc.signalingState);
                  continue;
                }
                hasAnsweredRef.current = true;
                setConnStatus("connecting");
                const offer = item.data as RTCSessionDescriptionInit;
                await pc.setRemoteDescription(new RTCSessionDescription(offer));

                // Drain candidates received before remoteDescription was established
                for (const cand of pendingCandidatesRef.current) {
                  await safeAddCandidate(pc, cand);
                }
                pendingCandidatesRef.current = [];

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await waitForIceGathering(pc, 600);

                const finalAnswer = pc.localDescription
                  ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
                  : { type: answer.type, sdp: answer.sdp };

                await sendSignalMessage(
                  currentCode,
                  "receiver",
                  "sender",
                  "answer",
                  finalAnswer,
                  currentToken || undefined,
                );
              } else if (item.type === "candidate-batch") {
                const batch = item.data as RTCIceCandidateInit[];
                for (const cand of batch) {
                  if (pc.remoteDescription) {
                    await safeAddCandidate(pc, cand);
                  } else if (isValidIceCandidateInit(cand)) {
                    pendingCandidatesRef.current.push(cand);
                  }
                }
              } else if (item.type === "leave") {
                setConnStatus("awaiting");
                pushToast("Peer detached from session", "default");
              }
            }
          } catch (pollErr) {
            console.warn("Receiver signaling poll warning:", pollErr);
          } finally {
            isPolling = false;
          }
        }, 600);

        return currentCode;
      } catch (err) {
        const msg = (err as Error).message || "Could not start hosting session";
        setError(msg);
        setConnStatus("failed");
        pushToast(msg, "error");
        return null;
      }
    },
    [disconnectSession, attachDataChannelListeners, pushToast],
  );

  // -------------------------------------------------------------
  // Session Join (Guest / Joiner Flow)
  // -------------------------------------------------------------
  const joinGuestSession = useCallback(
    async (codeToJoin: string): Promise<boolean> => {
      if (isConnectingRef.current) return false;
      isConnectingRef.current = true;
      disconnectSession();
      setError(null);
      setNatWarning(null);
      isConnectingRef.current = true;

      try {
        // 1. Verify session exists
        let sessionFound = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const checkRes = await fetch(`/api/signal/session/${codeToJoin}`, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" },
          });
          if (checkRes.ok) {
            sessionFound = true;
            break;
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
        }

        if (!sessionFound) {
          setError("That 8-digit code is invalid, non-existent, or expired.");
          isConnectingRef.current = false;
          return false;
        }

        // 2. Join session and obtain authorized sender token
        const savedSessionKey = `gs_sender_${codeToJoin}`;
        const storedToken =
          typeof window !== "undefined" ? window.sessionStorage.getItem(savedSessionKey) : null;
        const existingToken = savedSenderTokensRef.current[codeToJoin] || storedToken || undefined;
        const joinRes = await fetch(`/api/signal/session/${codeToJoin}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(existingToken ? { senderToken: existingToken } : {}),
        });

        if (!joinRes.ok) {
          const joinErr = (await joinRes.json().catch(() => ({}))) as { error?: string };
          setError(joinErr.error || "Could not join pairing session. Please try again.");
          isConnectingRef.current = false;
          return false;
        }

        const joinData = (await joinRes.json()) as { ok: boolean; senderToken?: string };
        const currentToken = joinData.senderToken || existingToken || null;
        if (currentToken) {
          savedSenderTokensRef.current[codeToJoin] = currentToken;
          if (typeof window !== "undefined") {
            try {
              window.sessionStorage.setItem(savedSessionKey, currentToken);
            } catch {}
          }
        }

        setCode(codeToJoin);
        setSessionToken(currentToken);
        setRole("joiner");
        setConnStatus("connecting");
        lastSignalSeqRef.current = 0;

        // 3. Create PeerConnection & Separate Data Channels
        const iceServers = await fetchIceServers();
        const pc = createPeerConnection(iceServers);
        pcRef.current = pc;

        const safeAddCandidate = async (targetPc: RTCPeerConnection, cand: RTCIceCandidateInit) => {
          if (!isValidIceCandidateInit(cand)) return;
          try {
            await targetPc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {
            const rawCand = typeof cand.candidate === "string" ? cand.candidate : "";
            const typMatch = rawCand.match(/typ\s+(\w+)/);
            const candType = typMatch ? typMatch[1] : "unknown";
            const protoMatch = rawCand.match(/\b(udp|tcp)\b/i);
            const candProto = protoMatch ? protoMatch[1].toLowerCase() : "unknown";
            console.warn(
              `[WebRTC ICE Diagnostic] Candidate (${candProto}/${candType}) rejected:`,
              (err as Error).name,
              (err as Error).message,
            );
          }
        };

        // A. Control channel (ordered, reliable: JSON signals & live chat)
        const ctrl = pc.createDataChannel(DATA_CHANNEL_LABELS.CONTROL, { ordered: true });
        dcControlRef.current = ctrl;
        attachDataChannelListeners(ctrl, DATA_CHANNEL_LABELS.CONTROL);

        // B. Outbound file channel (Joiner -> Creator)
        const fileOut = pc.createDataChannel(DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR, { ordered: true });
        dcFileOutRef.current = fileOut;
        attachDataChannelListeners(fileOut, DATA_CHANNEL_LABELS.FILES_JOINER_TO_CREATOR);

        // C. Inbound file channel (Creator -> Joiner)
        const fileIn = pc.createDataChannel(DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER, { ordered: true });
        dcFileInRef.current = fileIn;
        attachDataChannelListeners(fileIn, DATA_CHANNEL_LABELS.FILES_CREATOR_TO_JOINER);

        // Debounced candidate dispatch
        let candDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        const outgoingCandidates: RTCIceCandidateInit[] = [];

        const flushCandidates = () => {
          if (outgoingCandidates.length > 0) {
            const batch = [...outgoingCandidates];
            outgoingCandidates.length = 0;
            sendSignalMessage(codeToJoin, "sender", "receiver", "candidate-batch", batch, currentToken || undefined);
          }
        };

        pc.onicecandidate = (event) => {
          if (isValidIceCandidateInit(event.candidate)) {
            outgoingCandidates.push(event.candidate.toJSON());
            if (candDebounceTimer) clearTimeout(candDebounceTimer);
            candDebounceTimer = setTimeout(flushCandidates, 150);
          } else if (!event.candidate) {
            if (candDebounceTimer) clearTimeout(candDebounceTimer);
            flushCandidates();
          }
        };

        let hasEverConnected = false;
        let iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
        const updateConnState = () => {
          const iceState = pc.iceConnectionState;
          const connState = pc.connectionState;

          if (iceState === "connected" || iceState === "completed" || connState === "connected") {
            hasEverConnected = true;
            if (iceDisconnectTimer) {
              clearTimeout(iceDisconnectTimer);
              iceDisconnectTimer = null;
            }
            setConnStatus("connected");
            setNatWarning(null);
            setError(null);
          } else if (iceState === "disconnected" && hasEverConnected) {
            // Grace period: transient mobile carrier latency (only after initial connection was established)
            if (!iceDisconnectTimer) {
              iceDisconnectTimer = setTimeout(() => {
                if (pc.iceConnectionState === "disconnected" && pcRef.current === pc && hasEverConnected) {
                  setConnStatus("reconnecting");
                  triggerIceRestart(pc, codeToJoin, "sender", "receiver", currentToken || undefined);
                }
              }, 5000);
            }
          } else if (iceState === "failed" || connState === "failed") {
            if (iceDisconnectTimer) {
              clearTimeout(iceDisconnectTimer);
              iceDisconnectTimer = null;
            }
            setConnStatus("failed");
            setNatWarning(
              "Direct P2P UDP tunnel could not be established. Check if either device is on a restricted network or firewall blocking WebRTC.",
            );
          }
        };

        pc.oniceconnectionstatechange = updateConnState;
        pc.onconnectionstatechange = updateConnState;

        // 4. Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc, 600);

        const finalOffer = pc.localDescription
          ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
          : { type: offer.type, sdp: offer.sdp };

        const sent = await sendSignalMessage(
          codeToJoin,
          "sender",
          "receiver",
          "offer",
          finalOffer,
          currentToken || undefined,
        );
        if (!sent) {
          throw new Error("Could not deliver WebRTC offer. Please confirm receiver code is active.");
        }

        // Safety timeout
        connectTimeoutRef.current = setTimeout(() => {
          if (dcControlRef.current?.readyState !== "open") {
            setError("Connection timed out. Please ensure the other device is open on the 'Receive Files' or 'Dual Mode' screen.");
            disconnectSession();
          }
        }, 35000);

        // Polling loop
        let isPolling = false;
        pollIntervalRef.current = setInterval(async () => {
          if (isPolling) return;
          isPolling = true;
          try {
            const pollRes = await fetchSignalMessages(
              codeToJoin,
              "sender",
              lastSignalSeqRef.current,
              currentToken || undefined,
            );

            if (pollRes.cursor > lastSignalSeqRef.current) {
              lastSignalSeqRef.current = pollRes.cursor;
            }

            for (const item of pollRes.messages) {
              if (item.type === "answer") {
                const answer = item.data as RTCSessionDescriptionInit;
                if (pc.signalingState === "have-local-offer") {
                  await pc.setRemoteDescription(new RTCSessionDescription(answer));
                  for (const cand of pendingCandidatesRef.current) {
                    await safeAddCandidate(pc, cand);
                  }
                  pendingCandidatesRef.current = [];
                }
              } else if (item.type === "candidate-batch") {
                const batch = item.data as RTCIceCandidateInit[];
                for (const cand of batch) {
                  if (pc.remoteDescription) {
                    await safeAddCandidate(pc, cand);
                  } else if (isValidIceCandidateInit(cand)) {
                    pendingCandidatesRef.current.push(cand);
                  }
                }
              }
            }
          } catch (pollErr) {
            console.warn("Sender signaling poll error:", pollErr);
          } finally {
            isPolling = false;
          }
        }, 600);

        isConnectingRef.current = false;
        return true;
      } catch (err) {
        const msg = (err as Error).message || "Could not join session";
        setError(msg);
        setConnStatus("failed");
        isConnectingRef.current = false;
        pushToast(msg, "error");
        return false;
      }
    },
    [disconnectSession, attachDataChannelListeners, pushToast],
  );

  // -------------------------------------------------------------
  // Outbound Transfer Actions (Sending)
  // -------------------------------------------------------------
  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      const newItems: StagedItem[] = [];

      for (const file of incoming) {
        // Generate an opaque cryptographically secure unique ID independent of filename
        const id = generateTransferId();
        newItems.push({
          id,
          file,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "idle",
        });
      }

      if (newItems.length > 0) {
        setStagedFiles((prev) => [...prev, ...newItems]);
        setOutboundPhase((prev) => (prev === "done" ? "idle" : prev));
        pushToast(`Staged ${newItems.length} file${newItems.length > 1 ? "s" : ""}`, "default");
      }
    },
    [pushToast],
  );

  const removeStagedItem = useCallback((id: string) => {
    setStagedFiles((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearAllStaged = useCallback(() => {
    setStagedFiles([]);
  }, []);

  const retryFailedFile = useCallback((id: string) => {
    setStagedFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status: "idle", error: undefined, progress: 0 } : f)),
    );
    setOutboundPhase((prev) => (prev === "done" ? "idle" : prev));
  }, []);

  const triggerTransferRequest = useCallback(async () => {
    const ctrl = dcControlRef.current;
    if (!ctrl || ctrl.readyState !== "open") {
      pushToast("Direct P2P tunnel is not open", "error");
      return;
    }

    const pendingItems = stagedFilesRef.current.filter((f) => f.status === "idle");
    if (pendingItems.length === 0) {
      pushToast("No new files staged for transfer", "default");
      return;
    }

    const batchId = `b_${generateTransferId()}`;
    currentOutboundBatchIdRef.current = batchId;

    const pendingIds = new Set(pendingItems.map((f) => f.id));
    setOutboundPhase("awaiting-approval");
    setStagedFiles((prev) =>
      prev.map((f) => (pendingIds.has(f.id) ? { ...f, status: "requesting", batchId } : f)),
    );

    const manifestFiles = pendingItems.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      type: f.file.type || "application/octet-stream",
    }));

    const reqMsg: WebRTCMessage = {
      type: "transfer-request",
      batchId,
      files: manifestFiles,
      senderRole: role || undefined,
    };

    ctrl.send(JSON.stringify(reqMsg));
    pushToast(`Transfer authorization request sent for ${manifestFiles.length} file(s)...`, "default");
  }, [role, pushToast]);

  // Outbound file streaming effect
  useEffect(() => {
    if (outboundPhase !== "transferring") return;

    let isSubscribed = true;

    async function streamAllFiles() {
      const ctrl = dcControlRef.current;
      const fileOut = dcFileOutRef.current || ctrl;
      if (!ctrl || ctrl.readyState !== "open" || !fileOut || fileOut.readyState !== "open") return;

      cancelTransferRef.current = false;
      const activeBatchId = currentOutboundBatchIdRef.current;
      const pending = stagedFilesRef.current.filter((f) => f.status === "requesting" || f.status === "accepted");
      let hasErrors = false;

      for (const item of pending) {
        if (!isSubscribed || cancelTransferRef.current) break;

        setStagedFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, status: "uploading", progress: 0 } : f)),
        );

        try {
          await streamFileOverDataChannel(
            fileOut,
            item.file,
            item.id,
            0,
            (sent, total) => {
              if (!isSubscribed) return;
              const pct = Math.min(99, Math.round((sent / total) * 100));
              setStagedFiles((prev) =>
                prev.map((f) => (f.id === item.id ? { ...f, progress: pct } : f)),
              );
            },
            () => cancelTransferRef.current,
            ctrl,
            activeBatchId ?? undefined,
            () => {
              if (!isSubscribed) return;
              setStagedFiles((prev) =>
                prev.map((f) => (f.id === item.id ? { ...f, status: "awaiting-verification", progress: 100 } : f)),
              );
            },
          );

          if (!isSubscribed) return;
          setStagedFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, status: "done", progress: 100, error: undefined } : f)),
          );
          pushToast(`${item.name} transferred directly!`, "success");
        } catch (err) {
          hasErrors = true;
          if (!isSubscribed) return;
          const msg = (err as Error).message || "Streaming interrupted";
          setStagedFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, status: "error", error: msg } : f)),
          );
          pushToast(`Failed to stream ${item.name}: ${msg}`, "error");
        }
      }

      if (isSubscribed && !cancelTransferRef.current) {
        if (!hasErrors) {
          ctrl.send(JSON.stringify({ type: "transfer-complete", batchId: activeBatchId ?? undefined }));
          const hasRemainingIdle = stagedFilesRef.current.some((f) => f.status === "idle");
          setOutboundPhase(hasRemainingIdle ? "idle" : "done");
          currentOutboundBatchIdRef.current = null;
          pushToast("Batch transferred to peer successfully!", "success");
        } else {
          setOutboundPhase("idle");
          currentOutboundBatchIdRef.current = null;
        }
      }
    }

    streamAllFiles();

    return () => {
      isSubscribed = false;
    };
  }, [outboundPhase, pushToast]);

  // -------------------------------------------------------------
  // Inbound Transfer Actions (Receiving)
  // -------------------------------------------------------------
  const handleAcceptTransfer = useCallback(() => {
    const ctrl = dcControlRef.current;
    if (!ctrl || ctrl.readyState !== "open") {
      pushToast("Connection not ready", "error");
      return;
    }
    const acceptMsg: WebRTCMessage = {
      type: "transfer-accept",
      batchId: pendingApproval?.batchId,
    };
    ctrl.send(JSON.stringify(acceptMsg));
    pushToast("Transfer accepted. Streaming directly to local storage...", "success");
    setPendingApproval(null);
  }, [pendingApproval, pushToast]);

  const handleDeclineTransfer = useCallback(() => {
    const ctrl = dcControlRef.current;
    if (ctrl && ctrl.readyState === "open") {
      const declineMsg: WebRTCMessage = {
        type: "transfer-decline",
        batchId: pendingApproval?.batchId,
        reason: "Declined by recipient",
      };
      ctrl.send(JSON.stringify(declineMsg));
    }
    pushToast("Transfer declined", "default");
    setPendingApproval(null);
  }, [pendingApproval, pushToast]);

  const downloadSingleFile = useCallback((file: ReceivedFileItem) => {
    const link = document.createElement("a");
    link.href = file.downloadUrl;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const downloadAllFiles = useCallback(async () => {
    if (receivedFiles.length === 0) return;
    pushToast(`Downloading ${receivedFiles.length} file${receivedFiles.length > 1 ? "s" : ""}...`, "default");

    for (let i = 0; i < receivedFiles.length; i++) {
      downloadSingleFile(receivedFiles[i]);
      if (i < receivedFiles.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }, [receivedFiles, downloadSingleFile, pushToast]);

  // -------------------------------------------------------------
  // Ephemeral Live Chat Actions
  // -------------------------------------------------------------
  const sendMessage = useCallback(
    (rawText: string): boolean => {
      const ctrl = dcControlRef.current;
      if (!ctrl || ctrl.readyState !== "open") {
        pushToast("Cannot send message: P2P tunnel not open", "error");
        return false;
      }

      const text = rawText.trim();
      if (!text || text.length > 2000) return false;

      // Rate limit: max 5 messages per second
      const now = Date.now();
      lastChatSendTimeRef.current = lastChatSendTimeRef.current.filter((t) => now - t < 1000);
      if (lastChatSendTimeRef.current.length >= 5) {
        pushToast("Chat rate limit exceeded. Please wait a moment.", "error");
        return false;
      }
      lastChatSendTimeRef.current.push(now);

      const msgId = `msg_${now}_${Math.random().toString(36).slice(2, 7)}`;
      const localMsg: ChatMessage = {
        id: msgId,
        sender: "me",
        senderName: "You",
        text,
        timestamp: now,
      };

      // In-memory ONLY
      setMessages((prev) => [...prev, localMsg]);

      const wireMsg: WebRTCMessage = {
        type: "chat",
        id: msgId,
        text,
        sentAt: now,
        senderRole: role || undefined,
        senderName: "Peer",
      };

      ctrl.send(JSON.stringify(wireMsg));
      return true;
    },
    [role, pushToast],
  );

  const toggleChat = useCallback(() => {
    setIsChatOpen((prev) => {
      const next = !prev;
      if (next) setUnreadCount(0);
      return next;
    });
  }, []);

  const markChatRead = useCallback(() => {
    setUnreadCount(0);
  }, []);

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------
  const copyLink = useCallback(() => {
    if (!code) return;
    const url = `${window.location.origin}/?mode=send&code=${code}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    pushToast("Direct pairing link copied to clipboard", "default");
    setTimeout(() => setCopiedLink(false), 2000);
  }, [code, pushToast]);

  const shareLink = useCallback(async () => {
    if (!code) return;
    const url = `${window.location.origin}/?mode=send&code=${code}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "GhostShare File Transfer",
          text: `Connect to GhostShare WebRTC session with code ${code}`,
          url,
        });
      } catch {}
    } else {
      copyLink();
    }
  }, [code, copyLink]);

  const updateExpiryWindow = useCallback(
    async (newTtlSeconds: number) => {
      if (!code || !sessionToken) return;
      try {
        const res = await fetch(`/api/signal/session/${code}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ ttlSeconds: newTtlSeconds }),
        });
        if (res.ok) {
          const data = (await res.json()) as { expiresAt: number };
          const rem = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
          setRemainingTtl(rem);
          setInitialTtl(rem || newTtlSeconds);
          pushToast(`Session window adjusted to ${Math.round(newTtlSeconds / 60)} minutes`, "default");
        }
      } catch (err) {
        console.error("Failed to update expiry window:", err);
      }
    },
    [code, sessionToken, pushToast],
  );

  // Mobile Screen WakeLock: prevents mobile sleep during active peer connections
  useEffect(() => {
    const acquireLock = async () => {
      if (
        typeof navigator !== "undefined" &&
        "wakeLock" in navigator &&
        connStatus === "connected" &&
        !wakeLockRef.current
      ) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch {
          // Denied or battery saver
        }
      }
    };

    const releaseLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch {}
        wakeLockRef.current = null;
      }
    };

    if (connStatus === "connected") {
      acquireLock();
    } else {
      releaseLock();
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && connStatus === "connected") {
        acquireLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      releaseLock();
    };
  }, [connStatus]);

  return (
    <SessionContext.Provider
      value={{
        mode,
        setMode,
        role,
        code,
        sessionToken,
        connStatus,
        error,
        natWarning,
        remainingTtl,
        initialTtl,
        copiedLink,
        startHostSession,
        joinGuestSession,
        disconnectSession,
        updateExpiryWindow,
        copyLink,
        shareLink,
        stagedFiles,
        outboundPhase,
        handleFiles,
        removeStagedItem,
        clearAllStaged,
        triggerTransferRequest,
        retryFailedFile,
        pendingApproval,
        handleAcceptTransfer,
        handleDeclineTransfer,
        activeReceiving,
        receivedFiles,
        downloadAllFiles,
        downloadSingleFile,
        messages,
        unreadCount,
        isChatOpen,
        toggleChat,
        setIsChatOpen,
        sendMessage,
        markChatRead,
        pushToast,
      }}
    >
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {children}
    </SessionContext.Provider>
  );
}
