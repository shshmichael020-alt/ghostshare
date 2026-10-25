/**
 * Origin Private File System (OPFS) Direct-to-Disk Streaming Helper
 *
 * Streams incoming WebRTC binary chunks straight onto local NVMe/SSD storage
 * via the browser's native FileSystem API. Bypasses browser tab memory (RAM)
 * limits, preventing memory exhaustion on large transfers.
 * Provides a bounded size-limited fallback to in-memory Blob assembly for environments
 * where OPFS is unavailable.
 */

export interface OpfsFileStreamer {
  write: (chunk: ArrayBuffer, offset?: number) => Promise<void>;
  close: () => Promise<File>;
  getBytesWritten: () => number;
}

// Bounded RAM fallback limit when OPFS is unavailable in browser (100 MB max)
export const MAX_RAM_FALLBACK_BYTES = 100 * 1024 * 1024;

export function isOpfsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
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
 * Sanitizes a unique internal storage key to prevent directory traversal or collision.
 */
function sanitizeStorageKey(fileId: string): string {
  return encodeURIComponent(fileId).replace(/[^a-zA-Z0-9_-]/g, "_") + ".bin";
}

/**
 * Creates a high-speed disk writable stream for an incoming file.
 * Returns an OpfsFileStreamer that accepts binary chunks and resolves to a verified native File.
 */
export async function createIncomingFileSink(
  code: string,
  fileId: string,
  fileName: string,
  mimeType: string,
  expectedSize: number,
  startOffset: number = 0,
): Promise<OpfsFileStreamer> {
  const dir = await getSessionDir(code);
  const storageKey = sanitizeStorageKey(fileId);

  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(storageKey, { create: true });
      if (typeof fileHandle.createWritable === "function") {
        const writable = await fileHandle.createWritable({ keepExistingData: startOffset > 0 });
        if (startOffset === 0) {
          try {
            await writable.truncate(0);
          } catch {}
        } else if (startOffset > 0) {
          await writable.seek(startOffset);
        }

        let bytesWritten = startOffset;
        const writtenOffsets = new Set<number>();
        let writeChain: Promise<void> = Promise.resolve();

        return {
          write: async (chunk: ArrayBuffer, offset?: number) => {
            writeChain = writeChain.then(async () => {
              try {
                if (typeof offset === "number") {
                  if (writtenOffsets.has(offset)) {
                    // Deduplicate chunk if already written to prevent byte corruption
                    return;
                  }
                  writtenOffsets.add(offset);
                  await writable.seek(offset);
                }
                await writable.write(chunk);
                bytesWritten += chunk.byteLength;
              } catch (writeErr) {
                console.error("OPFS disk write failed (disk full or quota exceeded):", writeErr);
                throw new Error(`Disk write failed: ${(writeErr as Error).message || "Storage quota exceeded"}`);
              }
            });
            await writeChain;
          },
          close: async () => {
            await writeChain;
            try {
              await writable.truncate(expectedSize);
            } catch {}
            await writable.close();
            const rawFile = await fileHandle.getFile();

            // Strict length verification before marking file complete
            if (rawFile.size !== expectedSize) {
              throw new Error(
                `Transferred byte length mismatch: expected ${expectedSize} bytes, but wrote ${rawFile.size} bytes`,
              );
            }

            return new File([rawFile], fileName, { type: mimeType || "application/octet-stream" });
          },
          getBytesWritten: () => bytesWritten,
        };
      }
    } catch (e) {
      console.warn("Failed to open OPFS writable stream, evaluating bounded RAM buffer fallback:", e);
    }
  }

  // Fallback: Size-bounded in-memory buffer
  if (expectedSize > MAX_RAM_FALLBACK_BYTES) {
    throw new Error(
      `Direct-to-disk streaming (OPFS) is unavailable in this browser. In-memory transfer is capped at 100 MB to prevent browser crash (requested ${Math.round(expectedSize / (1024 * 1024))} MB).`,
    );
  }

  const chunksByOffset = new Map<number, ArrayBuffer>();
  const unpositionedChunks: ArrayBuffer[] = [];
  let bytesWritten = startOffset;

  return {
    write: async (chunk: ArrayBuffer, offset?: number) => {
      if (typeof offset === "number") {
        if (chunksByOffset.has(offset)) {
          // Deduplicate chunk
          return;
        }
        chunksByOffset.set(offset, chunk);
      } else {
        unpositionedChunks.push(chunk);
      }
      bytesWritten += chunk.byteLength;
    },
    close: async () => {
      let finalChunks: ArrayBuffer[];
      if (chunksByOffset.size > 0) {
        finalChunks = Array.from(chunksByOffset.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, buf]) => buf);
      } else {
        finalChunks = unpositionedChunks;
      }
      const blob = new Blob(finalChunks, { type: mimeType || "application/octet-stream" });
      if (blob.size !== expectedSize) {
        throw new Error(
          `Transferred byte length mismatch: expected ${expectedSize} bytes, but received ${blob.size} bytes`,
        );
      }
      return new File([blob], fileName, { type: mimeType || "application/octet-stream" });
    },
    getBytesWritten: () => bytesWritten,
  };
}

/**
 * Cleans up the session directory in OPFS when the session concludes or expires.
 */
export async function purgeSessionOpfs(code: string): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`ghostshare-${code}`, { recursive: true });
  } catch {
    // Session directory might already be deleted or not created
  }
}
