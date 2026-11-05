/**
 * Independent Per-Transfer Telemetry & Instrumentation Module for GhostShare.
 *
 * Provides accurate, independent tracking for both sender and receiver pipelines
 * using high-resolution performance.now() timers.
 */

export type ConnectionPathType = "host-to-host" | "srflx-direct" | "prflx-direct" | "turn-relay" | "unknown";

export interface SenderMetrics {
  bytesRead: number;
  bytesSubmitted: number;
  currentBufferedAmount: number;
  maxBufferedAmount: number;
  backpressureWaitTimeMs: number;
  flowControlWaitTimeMs: number;
  encodingTimeMs: number;
  startTime: number;
  endTime?: number;
  instantaneousSpeedMbs: number;
  averageSpeedMbs: number;
}

export interface ReceiverMetrics {
  bytesReceived: number;
  bytesWaitingToWrite: number;
  bytesPersisted: number;
  avgWriteLatencyMs: number;
  maxWriteLatencyMs: number;
  totalWrites: number;
  decodingTimeMs: number;
  storageBackend: "opfs" | "fsa" | "ram";
  startTime: number;
  endTime?: number;
  instantaneousSpeedMbs: number;
  averageSpeedMbs: number;
}

export interface CompletedTransferSummary {
  fileId: string;
  fileName: string;
  fileSizeBytes: number;
  durationMs: number;
  effectiveThroughputMbs: number;
  effectiveThroughputMbps: number;
  pathType: ConnectionPathType;
  pathLabel: string;
  rttMs?: number;
  storageBackend?: "opfs" | "fsa" | "ram";
  senderMetrics?: SenderMetrics;
  receiverMetrics?: ReceiverMetrics;
}

export class SenderMetricsTracker {
  private fileId: string;
  private totalSize: number;
  private bytesRead = 0;
  private bytesSubmitted = 0;
  private currentBufferedAmount = 0;
  private maxBufferedAmount = 0;
  private backpressureWaitTimeMs = 0;
  private flowControlWaitTimeMs = 0;
  private encodingTimeMs = 0;
  private startTime = 0;
  private endTime?: number;
  private lastSampleTime = 0;
  private lastSampleBytes = 0;
  private instantaneousSpeedMbs = 0;

  constructor(fileId: string, totalSize: number) {
    this.fileId = fileId;
    this.totalSize = totalSize;
    this.startTime = performance.now();
    this.lastSampleTime = this.startTime;
  }

  recordBytesRead(bytes: number): void {
    this.bytesRead += bytes;
  }

  recordBytesSubmitted(bytes: number, currentBuffered: number): void {
    this.bytesSubmitted += bytes;
    this.currentBufferedAmount = currentBuffered;
    if (currentBuffered > this.maxBufferedAmount) {
      this.maxBufferedAmount = currentBuffered;
    }

    const now = performance.now();
    const elapsedSec = (now - this.lastSampleTime) / 1000;
    if (elapsedSec >= 0.15) {
      const deltaBytes = this.bytesSubmitted - this.lastSampleBytes;
      this.instantaneousSpeedMbs = deltaBytes / (1024 * 1024 * elapsedSec);
      this.lastSampleBytes = this.bytesSubmitted;
      this.lastSampleTime = now;
    }
  }

  recordBackpressureWait(waitMs: number): void {
    this.backpressureWaitTimeMs += waitMs;
  }

  recordFlowControlWait(waitMs: number): void {
    this.flowControlWaitTimeMs += waitMs;
  }

  recordEncodingTime(encodeMs: number): void {
    this.encodingTimeMs += encodeMs;
  }

  finish(): void {
    this.endTime = performance.now();
  }

  getSnapshot(): SenderMetrics {
    const now = this.endTime || performance.now();
    const durationSec = Math.max(0.001, (now - this.startTime) / 1000);
    const averageSpeedMbs = this.bytesSubmitted / (1024 * 1024 * durationSec);

    return {
      bytesRead: this.bytesRead,
      bytesSubmitted: this.bytesSubmitted,
      currentBufferedAmount: this.currentBufferedAmount,
      maxBufferedAmount: this.maxBufferedAmount,
      backpressureWaitTimeMs: this.backpressureWaitTimeMs,
      flowControlWaitTimeMs: this.flowControlWaitTimeMs,
      encodingTimeMs: this.encodingTimeMs,
      startTime: this.startTime,
      endTime: this.endTime,
      instantaneousSpeedMbs: this.instantaneousSpeedMbs,
      averageSpeedMbs,
    };
  }
}

export class ReceiverMetricsTracker {
  private fileId: string;
  private totalSize: number;
  private storageBackend: "opfs" | "fsa" | "ram";
  private bytesReceived = 0;
  private bytesPersisted = 0;
  private totalWriteLatencyMs = 0;
  private maxWriteLatencyMs = 0;
  private totalWrites = 0;
  private decodingTimeMs = 0;
  private startTime = 0;
  private endTime?: number;
  private lastSampleTime = 0;
  private lastSampleBytes = 0;
  private instantaneousSpeedMbs = 0;

  constructor(fileId: string, totalSize: number, backend: "opfs" | "fsa" | "ram") {
    this.fileId = fileId;
    this.totalSize = totalSize;
    this.storageBackend = backend;
    this.startTime = performance.now();
    this.lastSampleTime = this.startTime;
  }

  recordBytesReceived(bytes: number): void {
    this.bytesReceived += bytes;
  }

  recordDecodingTime(decodeMs: number): void {
    this.decodingTimeMs += decodeMs;
  }

  recordDiskWrite(persistedBytes: number, latencyMs: number): void {
    this.bytesPersisted = persistedBytes;
    this.totalWriteLatencyMs += latencyMs;
    this.totalWrites++;
    if (latencyMs > this.maxWriteLatencyMs) {
      this.maxWriteLatencyMs = latencyMs;
    }

    const now = performance.now();
    const elapsedSec = (now - this.lastSampleTime) / 1000;
    if (elapsedSec >= 0.15) {
      const deltaBytes = this.bytesPersisted - this.lastSampleBytes;
      this.instantaneousSpeedMbs = deltaBytes / (1024 * 1024 * elapsedSec);
      this.lastSampleBytes = this.bytesPersisted;
      this.lastSampleTime = now;
    }
  }

  finish(): void {
    this.endTime = performance.now();
  }

  getSnapshot(): ReceiverMetrics {
    const now = this.endTime || performance.now();
    const durationSec = Math.max(0.001, (now - this.startTime) / 1000);
    const averageSpeedMbs = this.bytesPersisted / (1024 * 1024 * durationSec);
    const avgWriteLatencyMs = this.totalWrites > 0 ? this.totalWriteLatencyMs / this.totalWrites : 0;
    const bytesWaitingToWrite = Math.max(0, this.bytesReceived - this.bytesPersisted);

    return {
      bytesReceived: this.bytesReceived,
      bytesWaitingToWrite,
      bytesPersisted: this.bytesPersisted,
      avgWriteLatencyMs,
      maxWriteLatencyMs: this.maxWriteLatencyMs,
      totalWrites: this.totalWrites,
      decodingTimeMs: this.decodingTimeMs,
      storageBackend: this.storageBackend,
      startTime: this.startTime,
      endTime: this.endTime,
      instantaneousSpeedMbs: this.instantaneousSpeedMbs,
      averageSpeedMbs,
    };
  }
}
