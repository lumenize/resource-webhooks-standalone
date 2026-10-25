// Standard Webhooks, as SEP-3415 profiles it: a `whsec_` secret of 24 to 64 bytes, and a
// `v1,` HMAC-SHA256 signature over `webhook-id.webhook-timestamp.body`, where the body is the
// raw bytes as sent. A signs with it and B verifies with it. Web Crypto only.

const encoder = new TextEncoder();

/** How old a delivery's `webhook-timestamp` may be before a receiver refuses it, in seconds. */
export const FRESHNESS_SECONDS = 5 * 60;

/** The secret's key bytes, or undefined unless it is `whsec_` and the base64 of 24 to 64 bytes. */
export function secretBytes(secret: string): Uint8Array | undefined {
  if (!secret.startsWith('whsec_')) return undefined;
  const encoded = secret.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : undefined;
}

/** A new secret of 32 random bytes, as a client generates one. */
export function newSecret(): string {
  return `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
}

function importKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** The `webhook-signature` value for one message, as `v1,<base64>`. */
export async function sign(secret: string, webhookId: string, timestamp: number, body: Uint8Array | string): Promise<string> {
  const key = secretBytes(secret);
  if (!key) throw new RangeError('Not a Standard Webhooks secret');
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const prefix = encoder.encode(`${webhookId}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await importKey(key), signed));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

/** The headers of one delivery attempt. Each attempt gets a fresh timestamp and signature. */
export async function deliveryHeaders(
  secret: string,
  webhookId: string,
  subscriptionId: string,
  body: string,
  nowSeconds: number,
): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': String(nowSeconds),
    'webhook-signature': await sign(secret, webhookId, nowSeconds, body),
    'X-MCP-Subscription-Id': subscriptionId,
  };
}

export type Verdict = 'verified' | 'failed' | 'stale';

/**
 * Whether a delivery's signature verifies under any of `secrets` and its timestamp is within
 * the freshness window, judged over the raw body bytes as received.
 */
export async function verify(
  secrets: readonly string[],
  headers: Headers,
  rawBody: Uint8Array,
  nowSeconds: number,
): Promise<Verdict> {
  const webhookId = headers.get('webhook-id');
  const timestamp = Number(headers.get('webhook-timestamp'));
  const signatures = (headers.get('webhook-signature') ?? '').split(' ').filter((part) => part.startsWith('v1,'));
  if (!webhookId || !Number.isInteger(timestamp) || signatures.length === 0) return 'failed';
  let verified = false;
  for (const secret of secrets) {
    const expected = await sign(secret, webhookId, timestamp, rawBody);
    for (const signature of signatures) if (constantTimeEqual(signature, expected)) verified = true;
  }
  if (!verified) return 'failed';
  return Math.abs(nowSeconds - timestamp) > FRESHNESS_SECONDS ? 'stale' : 'verified';
}

/** Whether two strings are equal, in time that depends only on their lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}
