/**
 * Origin Private File System (OPFS) Direct-to-Disk Streaming Helper
 *
 * Streams incoming WebRTC binary chunks straight onto local NVMe/SSD storage
 * via the browser's native FileSystem API. Bypasses browser tab memory (RAM)
 * limits, keeping RAM usage < 30 MB regardless of transfer volume.
 * Provides automatic fallback to in-memory Blob assembly for older browsers.
 */

export interface OpfsFileStreamer {
  write: (chunk: ArrayBuffer) => Promise<void>;
  close: () => Promise<File>;
  getBytesWritten: () => number;
}

export function isOpfsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

/**
 * Gets or creates the sandboxed directory for this pairing session
 */
async function getSessionDir(code: string): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsSupported()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(`ghostshare-${code}`, { create: true });
  } catch (err) {
    console.warn("OPFS directory access unavailable, falling back to RAM cache:", err);
    return null;
  }
}

/**
 * Creates a high-speed disk writable stream for an incoming file.
 * Returns an OpfsFileStreamer that accepts binary chunks and resolves to a native File.
 */
export async function createIncomingFileSink(
  code: string,
  fileName: string,
  mimeType: string,
  startOffset: number = 0,
): Promise<OpfsFileStreamer> {
  const dir = await getSessionDir(code);

  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      // Use createWritable if supported
      if ("createWritable" in fileHandle) {
        const writable = await fileHandle.createWritable({ keepExistingData: startOffset > 0 });
        if (startOffset > 0) {
          await writable.seek(startOffset);
        }

        let bytesWritten = startOffset;

        return {
          write: async (chunk: ArrayBuffer) => {
            await writable.write(chunk);
            bytesWritten += chunk.byteLength;
          },
          close: async () => {
            await writable.close();
            return await fileHandle.getFile();
          },
          getBytesWritten: () => bytesWritten,
        };
      }
    } catch (e) {
      console.warn("Failed to open OPFS writable stream, using RAM buffer:", e);
    }
  }

  // Fallback: In-memory chunk array buffer
  const chunks: ArrayBuffer[] = [];
  let bytesWritten = startOffset;

  return {
    write: async (chunk: ArrayBuffer) => {
      chunks.push(chunk);
      bytesWritten += chunk.byteLength;
    },
    close: async () => {
      const blob = new Blob(chunks, { type: mimeType || "application/octet-stream" });
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
