/**
 * Origin Private File System (OPFS) Direct-to-Disk Streaming Helper
 *
 * Streams incoming WebRTC binary chunks straight onto local NVMe/SSD storage
 * via the browser's native FileSystem API. Bypasses browser tab memory (RAM)
 * limits, preventing memory exhaustion on large transfers.
 * Provides a bounded size-limited fallback to in-memory Blob assembly for environments
 * where OPFS is unavailable.
 */

export interface ByteInterval {
  start: number;
  end: number; // exclusive [start, end)
}

export interface ChunkValidationResult {
  isDuplicate: boolean;
  isOutOfBounds: boolean;
  isConflictingOverlap: boolean;
  isZeroLength: boolean;
  isInvalid: boolean;
}

/**
 * Tracks contiguous received byte ranges and detects missing, duplicate,
 * overlapping, or out-of-bounds chunks without artificial file padding.
 */
export class ByteRangeTracker {
  private ranges: ByteInterval[] = [];
  readonly expectedSize: number;

  constructor(expectedSize: number, initialOffset = 0) {
    this.expectedSize = expectedSize;
    if (initialOffset > 0 && initialOffset <= expectedSize) {
      this.ranges.push({ start: 0, end: initialOffset });
    }
  }

  /**
   * Validates a chunk against expected bounds, duplicates, and partial overlaps
   * WITHOUT committing it to the received range list.
   *
   * Deduplication Policy:
   * GhostShare uses byte-range deduplication for transport idempotency.
   * If an incoming chunk's byte range [offset, offset + length) is already fully contained
   * within an already-acknowledged and committed range on disk/memory, the transport layer
   * skips redundant write operations.
   *
   * Note: GhostShare relies on SCTP CRC32c data integrity and end-to-end size verification.
   * It does NOT read back and compare the raw bytes of duplicate chunks against previously
   * written bytes; instead, it safely ignores redundant transmissions of already-persisted ranges.
   */
  validateChunk(offset: number, length: number): ChunkValidationResult {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) {
      return { isDuplicate: false, isOutOfBounds: true, isConflictingOverlap: false, isZeroLength: false, isInvalid: true };
    }
    if (length === 0) {
      return { isDuplicate: false, isOutOfBounds: false, isConflictingOverlap: false, isZeroLength: true, isInvalid: false };
    }
    const start = offset;
    const end = offset + length;

    if (end > this.expectedSize) {
      return { isDuplicate: false, isOutOfBounds: true, isConflictingOverlap: false, isZeroLength: false, isInvalid: true };
    }

    for (const r of this.ranges) {
      const overlapStart = Math.max(start, r.start);
      const overlapEnd = Math.min(end, r.end);

      if (overlapStart < overlapEnd) {
        // Overlap exists with this range r
        if (start >= r.start && end <= r.end) {
          // Fully contained (exact duplicate or sub-range of already written bytes)
          return { isDuplicate: true, isOutOfBounds: false, isConflictingOverlap: false, isZeroLength: false, isInvalid: false };
        }
        // Extending or partial overlap
        return { isDuplicate: false, isOutOfBounds: false, isConflictingOverlap: true, isZeroLength: false, isInvalid: false };
      }
    }

    return { isDuplicate: false, isOutOfBounds: false, isConflictingOverlap: false, isZeroLength: false, isInvalid: false };
  }

  addRange(offset: number, length: number): { isDuplicate: boolean; isOutOfBounds: boolean } {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) {
      return { isDuplicate: false, isOutOfBounds: true };
    }
    if (length === 0) {
      return { isDuplicate: false, isOutOfBounds: false };
    }
    const start = offset;
    const end = offset + length;

    if (end > this.expectedSize) {
      return { isDuplicate: false, isOutOfBounds: true };
    }

    // Check if fully contained within an existing range (duplicate)
    for (const r of this.ranges) {
      if (start >= r.start && end <= r.end) {
        return { isDuplicate: true, isOutOfBounds: false };
      }
    }

    // Insert and merge overlapping or contiguous intervals
    const newRanges: ByteInterval[] = [];
    let curStart = start;
    let curEnd = end;

    for (const r of this.ranges) {
      if (r.end < curStart) {
        newRanges.push(r);
      } else if (r.start > curEnd) {
        newRanges.push(r);
      } else {
        curStart = Math.min(curStart, r.start);
        curEnd = Math.max(curEnd, r.end);
      }
    }

    newRanges.push({ start: curStart, end: curEnd });
    newRanges.sort((a, b) => a.start - b.start);
    this.ranges = newRanges;

    return { isDuplicate: false, isOutOfBounds: false };
  }

  isComplete(): boolean {
    if (this.expectedSize === 0) return true;
    return this.ranges.length === 1 && this.ranges[0].start === 0 && this.ranges[0].end === this.expectedSize;
  }

  getTotalBytesReceived(): number {
    return this.ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
  }

  getMissingRanges(): ByteInterval[] {
    if (this.expectedSize === 0) return [];
    const missing: ByteInterval[] = [];
    let cursor = 0;
    for (const r of this.ranges) {
      if (r.start > cursor) {
        missing.push({ start: cursor, end: r.start });
      }
      cursor = Math.max(cursor, r.end);
    }
    if (cursor < this.expectedSize) {
      missing.push({ start: cursor, end: this.expectedSize });
    }
    return missing;
  }

  getRanges(): ByteInterval[] {
    return [...this.ranges];
  }
}

export interface OpfsFileStreamer {
  write: (chunk: ArrayBuffer, offset?: number) => Promise<void>;
  close: () => Promise<File>;
  abort: () => Promise<void>;
  getBytesWritten: () => number;
  isComplete: () => boolean;
  getMissingRanges: () => ByteInterval[];
}

export interface SinkOptions {
  userFileHandle?: FileSystemFileHandle;
}

export interface StorageCapability {
  isOpfsSupported: boolean;
  isFileSystemAccessSupported: boolean;
  quota?: number;
  usage?: number;
  available?: number;
  backend: "opfs" | "fsa" | "ram";
}

export function isOpfsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
  );
}

/**
 * Prompts user to select a destination file using the File System Access API.
 * Returns the selected FileSystemFileHandle, or null if cancelled / unsupported.
 */
export async function promptUserSaveFileHandle(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const ext = suggestedName.includes(".") ? suggestedName.slice(suggestedName.lastIndexOf(".")) : "";
    const options: Record<string, unknown> = {
      suggestedName,
    };
    if (ext) {
      options.types = [
        {
          description: "Incoming File",
          accept: { "application/octet-stream": [ext] },
        },
      ];
    }
    const showSave = (window as unknown as { showSaveFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker;
    return await showSave(options);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // User cancelled picker - safe
      return null;
    }
    console.warn("User file destination selection error:", err);
    throw err;
  }
}

/**
 * Checks browser storage capabilities and available device quota.
 */
export async function checkStorageCapability(): Promise<StorageCapability> {
  const opfs = isOpfsSupported();
  const fsa = isFileSystemAccessSupported();
  let quota: number | undefined;
  let usage: number | undefined;
  let available: number | undefined;

  if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
    try {
      const est = await navigator.storage.estimate();
      quota = est.quota;
      usage = est.usage;
      if (quota !== undefined && usage !== undefined) {
        available = Math.max(0, quota - usage);
      }
    } catch {}
  }

  let backend: "opfs" | "fsa" | "ram" = "ram";
  if (opfs) backend = "opfs";
  else if (fsa) backend = "fsa";

  return {
    isOpfsSupported: opfs,
    isFileSystemAccessSupported: fsa,
    quota,
    usage,
    available,
    backend,
  };
}

/**
 * Gets or creates the sandboxed directory for this pairing session.
 */
async function getSessionDir(code: string): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsSupported()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(`ghostshare-${code}`, { create: true });
  } catch (err) {
    console.warn("OPFS directory access unavailable, falling back to bounded RAM buffer:", err);
    return null;
  }
}

/**
 * Strict filename sanitization: prevents path traversal, control characters,
 * and NTFS/FAT reserved characters while preserving safe Unicode.
 */
export function sanitizeStorageKey(fileName: string): string {
  let clean = fileName.replace(/[/\\?%*:|"<>]/g, "_");
  clean = clean.replace(/[\x00-\x1f\x80-\x9f]/g, "");
  clean = clean.replace(/^\.+/, "");
  if (!clean || clean.trim().length === 0) {
    clean = "unnamed_file";
  }
  return clean.slice(0, 255);
}

// Bounded RAM fallback size limit: 100 MB strictly enforced to prevent browser tab OOM crashes
export const MAX_RAM_FALLBACK_BYTES = 100 * 1024 * 1024;

/**
 * Creates an incoming file sink adhering to browser capability priority:
 * 1. User-Selected File Destination (when explicit handle provided)
 * 2. OPFS Direct-to-Disk (when supported and no handle specified)
 * 3. Bounded RAM Buffer (capped at 100 MB when neither disk method is available)
 */
export async function createIncomingFileSink(
  code: string,
  fileId: string,
  safeFileName: string,
  safeMime: string,
  expectedSize: number,
  startOffset = 0,
  options?: SinkOptions,
): Promise<OpfsFileStreamer> {
  // Preflight device storage estimation
  if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota !== undefined && est.usage !== undefined) {
        const free = Math.max(0, est.quota - est.usage);
        if (expectedSize > free) {
          throw new Error(
            `Insufficient storage space: incoming file requires ${Math.round(expectedSize / (1024 * 1024))} MB, but device has only ${Math.round(free / (1024 * 1024))} MB available.`,
          );
        }
      }
    } catch (quotaCheckErr) {
      if (String(quotaCheckErr).includes("Insufficient storage space")) {
        throw quotaCheckErr;
      }
    }
  }

  const storageKey = sanitizeStorageKey(fileId);
  const userHandle = options?.userFileHandle;

  // Branch A1: Explicit User-Selected File Destination (File System Access API)
  if (userHandle) {
    if (!userHandle || typeof userHandle.createWritable !== "function") {
      throw new Error("Invalid destination file handle provided");
    }
    let writable: FileSystemWritableFileStream;
    try {
      writable = await userHandle.createWritable({ keepExistingData: startOffset > 0 });
    } catch (createErr) {
      throw new Error(`Failed to open destination file for writing: ${(createErr as Error).message}`);
    }

    if (startOffset === 0) {
      try {
        await writable.truncate(0);
      } catch {}
    } else if (startOffset > 0) {
      await writable.seek(startOffset);
    }

    let bytesWritten = startOffset;
    const rangeTracker = new ByteRangeTracker(expectedSize, startOffset);
    let writeChain: Promise<void> = Promise.resolve();
    let closePromise: Promise<File> | null = null;
    let isAborted = false;
    let terminalWriteError: Error | null = null;

    return {
      write: async (chunk: ArrayBuffer, offset?: number) => {
        if (isAborted) throw new Error("Stream has been aborted");
        if (terminalWriteError) throw terminalWriteError;

        const chunkOffset = typeof offset === "number" ? offset : bytesWritten;
        const validation = rangeTracker.validateChunk(chunkOffset, chunk.byteLength);

        if (validation.isZeroLength) return;
        if (validation.isOutOfBounds) {
          throw new Error(
            `Chunk range [${chunkOffset}..${chunkOffset + chunk.byteLength}) exceeds expected size ${expectedSize}`,
          );
        }
        if (validation.isConflictingOverlap) {
          throw new Error(
            `Conflicting partial overlapping chunk detected at offset ${chunkOffset} with length ${chunk.byteLength}`,
          );
        }
        if (validation.isDuplicate) return;

        writeChain = writeChain.then(async () => {
          if (isAborted) throw new Error("Stream has been aborted");
          if (terminalWriteError) throw terminalWriteError;

          try {
            if (typeof offset === "number") {
              await writable.seek(offset);
            }
            await writable.write(chunk);
            bytesWritten += chunk.byteLength;
            rangeTracker.addRange(chunkOffset, chunk.byteLength);
          } catch (writeErr) {
            const message = (writeErr as Error).message || "Storage quota exceeded";
            terminalWriteError = new Error(`Disk write failed: ${message}`);
            console.error("Destination disk write failed:", writeErr);
            try {
              if (typeof writable.abort === "function") {
                await writable.abort();
              } else {
                await writable.close();
              }
            } catch {}
            throw terminalWriteError;
          }
        });
        await writeChain;
      },
      close: async () => {
        if (isAborted) throw new Error("Stream has been aborted");
        if (terminalWriteError) throw terminalWriteError;
        if (closePromise) return closePromise;
        closePromise = (async () => {
          await writeChain;
          if (terminalWriteError) throw terminalWriteError;

          if (!rangeTracker.isComplete()) {
            const missing = rangeTracker.getMissingRanges();
            const missingStr = missing.map((m) => `[${m.start}..${m.end})`).join(", ");
            throw new Error(
              `Transferred byte length mismatch: missing byte ranges: ${missingStr}. Expected ${expectedSize} bytes, received ${rangeTracker.getTotalBytesReceived()} bytes.`,
            );
          }

          try {
            await writable.close();
          } catch (closeErr) {
            terminalWriteError = new Error(`Disk write failed: ${(closeErr as Error).message}`);
            throw terminalWriteError;
          }

          const file = await userHandle.getFile();
          if (file.size !== expectedSize) {
            throw new Error(`Size mismatch: expected ${expectedSize} bytes, but wrote ${file.size} bytes`);
          }
          return file;
        })();
        return closePromise;
      },
      abort: async () => {
        isAborted = true;
        try {
          if (typeof writable.abort === "function") {
            await writable.abort();
          } else {
            await writable.close();
          }
        } catch {}
      },
      getBytesWritten: () => bytesWritten,
      isComplete: () => rangeTracker.isComplete(),
      getMissingRanges: () => rangeTracker.getMissingRanges(),
    };
  }

  // Branch A2: OPFS Direct-to-Disk (when userHandle is not specified and OPFS is supported)
  if (isOpfsSupported()) {
    try {
      const dir = await getSessionDir(code);
      if (dir) {
        const fileHandle = await dir.getFileHandle(storageKey, { create: true });
        if (fileHandle && typeof fileHandle.createWritable === "function") {
          const writable = await fileHandle.createWritable({ keepExistingData: startOffset > 0 });
          if (startOffset === 0) {
            try {
              await writable.truncate(0);
            } catch {}
          } else if (startOffset > 0) {
            await writable.seek(startOffset);
          }

          let bytesWritten = startOffset;
          const rangeTracker = new ByteRangeTracker(expectedSize, startOffset);
          let writeChain: Promise<void> = Promise.resolve();
          let closePromise: Promise<File> | null = null;
          let isAborted = false;
          let terminalWriteError: Error | null = null;

          return {
            write: async (chunk: ArrayBuffer, offset?: number) => {
              if (isAborted) throw new Error("Stream has been aborted");
              if (terminalWriteError) throw terminalWriteError;

              const chunkOffset = typeof offset === "number" ? offset : bytesWritten;
              const validation = rangeTracker.validateChunk(chunkOffset, chunk.byteLength);

              if (validation.isZeroLength) return;
              if (validation.isOutOfBounds) {
                throw new Error(
                  `Chunk range [${chunkOffset}..${chunkOffset + chunk.byteLength}) exceeds expected size ${expectedSize}`,
                );
              }
              if (validation.isConflictingOverlap) {
                throw new Error(
                  `Conflicting partial overlapping chunk detected at offset ${chunkOffset} with length ${chunk.byteLength}`,
                );
              }
              if (validation.isDuplicate) return;

              writeChain = writeChain.then(async () => {
                if (isAborted) throw new Error("Stream has been aborted");
                if (terminalWriteError) throw terminalWriteError;

                try {
                  if (typeof offset === "number") {
                    await writable.seek(offset);
                  }
                  await writable.write(chunk);
                  bytesWritten += chunk.byteLength;
                  rangeTracker.addRange(chunkOffset, chunk.byteLength);
                } catch (writeErr) {
                  const message = (writeErr as Error).message || "Storage quota exceeded";
                  terminalWriteError = new Error(`Disk write failed: ${message}`);
                  console.error("OPFS disk write failed (disk full or quota exceeded):", writeErr);
                  try {
                    if (typeof writable.abort === "function") {
                      await writable.abort();
                    } else {
                      await writable.close();
                    }
                  } catch {}
                  throw terminalWriteError;
                }
              });
              await writeChain;
            },
            close: async () => {
              if (isAborted) throw new Error("Stream has been aborted");
              if (terminalWriteError) throw terminalWriteError;
              if (closePromise) return closePromise;
              closePromise = (async () => {
                await writeChain;
                if (terminalWriteError) throw terminalWriteError;

                if (!rangeTracker.isComplete()) {
                  const missing = rangeTracker.getMissingRanges();
                  const missingStr = missing.map((m) => `[${m.start}..${m.end})`).join(", ");
                  throw new Error(
                    `Transferred byte length mismatch: missing byte ranges: ${missingStr}. Expected ${expectedSize} bytes, received ${rangeTracker.getTotalBytesReceived()} bytes.`,
                  );
                }

                try {
                  await writable.close();
                } catch (closeErr) {
                  terminalWriteError = new Error(`Disk write failed: ${(closeErr as Error).message}`);
                  throw terminalWriteError;
                }

                const file = await fileHandle.getFile();
                if (file.size !== expectedSize) {
                  throw new Error(`Size mismatch: expected ${expectedSize} bytes, but wrote ${file.size} bytes`);
                }
                return new File([file], safeFileName, { type: safeMime });
              })();
              return closePromise;
            },
            abort: async () => {
              isAborted = true;
              try {
                if (typeof writable.abort === "function") {
                  await writable.abort();
                } else {
                  await writable.close();
                }
              } catch {}
              if (dir) {
                try {
                  await dir.removeEntry(storageKey);
                } catch {}
              }
            },
            getBytesWritten: () => bytesWritten,
            isComplete: () => rangeTracker.isComplete(),
            getMissingRanges: () => rangeTracker.getMissingRanges(),
          };
        }
      }
    } catch (e) {
      if (String(e).includes("Insufficient storage space")) {
        throw e;
      }
      console.warn("Failed to open OPFS writable stream, evaluating bounded RAM buffer fallback:", e);
    }
  }

  // Branch B: Bounded In-Memory RAM Fallback
  if (expectedSize > MAX_RAM_FALLBACK_BYTES) {
    throw new Error(
      `Direct-to-disk streaming (OPFS) is unavailable in this browser. In-memory transfer is capped at 100 MB to prevent browser crash (requested ${Math.round(expectedSize / (1024 * 1024))} MB).`,
    );
  }

  const rangeTracker = new ByteRangeTracker(expectedSize, startOffset);
  let memoryBuffer: Uint8Array | null = new Uint8Array(expectedSize);
  let bytesWritten = startOffset;
  let fallbackWriteChain: Promise<void> = Promise.resolve();
  let isAborted = false;
  let terminalRamError: Error | null = null;

  return {
    write: async (chunk: ArrayBuffer, offset?: number) => {
      if (isAborted || !memoryBuffer) throw new Error("Stream has been aborted");
      if (terminalRamError) throw terminalRamError;

      const chunkOffset = typeof offset === "number" ? offset : bytesWritten;
      const validation = rangeTracker.validateChunk(chunkOffset, chunk.byteLength);

      if (validation.isZeroLength) return;
      if (validation.isOutOfBounds) {
        throw new Error(
          `Chunk range [${chunkOffset}..${chunkOffset + chunk.byteLength}) exceeds expected size ${expectedSize}`,
        );
      }
      if (validation.isConflictingOverlap) {
        throw new Error(
          `Conflicting partial overlapping chunk detected at offset ${chunkOffset} with length ${chunk.byteLength}`,
        );
      }
      if (validation.isDuplicate) return;

      fallbackWriteChain = fallbackWriteChain.then(async () => {
        if (isAborted || !memoryBuffer) throw new Error("Stream has been aborted");
        if (terminalRamError) throw terminalRamError;
        try {
          memoryBuffer.set(new Uint8Array(chunk), chunkOffset);
          bytesWritten += chunk.byteLength;
          rangeTracker.addRange(chunkOffset, chunk.byteLength);
        } catch (err) {
          terminalRamError = err instanceof Error ? err : new Error(String(err));
          throw terminalRamError;
        }
      });
      await fallbackWriteChain;
    },
    close: async () => {
      if (isAborted || !memoryBuffer) throw new Error("Stream has been aborted");
      if (terminalRamError) throw terminalRamError;
      await fallbackWriteChain;
      if (terminalRamError) throw terminalRamError;

      if (!rangeTracker.isComplete()) {
        const missing = rangeTracker.getMissingRanges();
        const missingStr = missing.map((m) => `[${m.start}..${m.end})`).join(", ");
        throw new Error(
          `Transferred byte length mismatch: missing byte ranges: ${missingStr}. Expected ${expectedSize} bytes, received ${rangeTracker.getTotalBytesReceived()} bytes.`,
        );
      }

      const blob = new Blob([memoryBuffer.buffer as ArrayBuffer], { type: safeMime });
      if (blob.size !== expectedSize) {
        throw new Error(
          `Transferred byte length mismatch: expected ${expectedSize} bytes, but received ${blob.size} bytes`,
        );
      }
      return new File([blob], safeFileName, { type: safeMime });
    },
    abort: async () => {
      isAborted = true;
      memoryBuffer = null;
    },
    getBytesWritten: () => bytesWritten,
    isComplete: () => rangeTracker.isComplete(),
    getMissingRanges: () => rangeTracker.getMissingRanges(),
  };
}

/**
 * Cleanup helper for an entire session's OPFS sandboxed directory.
 */
export async function cleanupSessionStorage(code: string): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`ghostshare-${code}`, { recursive: true });
  } catch (err) {
    if ((err as Error).name !== "NotFoundError") {
      console.warn("OPFS session directory cleanup error:", err);
    }
  }
}
