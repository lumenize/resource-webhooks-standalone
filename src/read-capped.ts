/** A body's cap, well under DO SQLite's 2 MB row limit. */
export const MAX_BODY_BYTES = 1024 * 1024;

// Reads the body and stops at the cap, whatever its Content-Length says, and whether or not it
// declares one, as a streamed body does not.
export async function readCapped(stream: ReadableStream<Uint8Array> | null, cap = MAX_BODY_BYTES): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > cap) return undefined;
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
