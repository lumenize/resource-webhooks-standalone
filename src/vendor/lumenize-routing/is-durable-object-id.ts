// Copied from @lumenize/routing 0.26.0, packages/routing/src/is-durable-object-id.ts in lumenize/lumenize
// at commit c1bb1b12, Copyright (c) 2025 Larry Maccherone, and relicensed here under
// Apache-2.0 by its author. Changes: none. Listed in ATTRIBUTIONS.md.

/**
 * Check if a string is a Cloudflare Durable Object ID.
 * 
 * DO IDs are exactly 64 lowercase hexadecimal characters.
 * 
 * @param value - The string to check
 * @returns true if the value is a valid DO ID format
 * 
 * @example
 * ```typescript
 * isDurableObjectId('8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99'); // true
 * isDurableObjectId('my-instance-name'); // false
 * isDurableObjectId('invalid-hex-GGGG'); // false
 * ```
 */
export function isDurableObjectId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

