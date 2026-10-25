// HMAC-SHA256 signing under the Worker's one signing secret, kept apart by purpose: a label
// starts every other signed input, so a client id, a client secret and a code can never pass
// for one another or for a token. Tokens are JWTs with their `alg` pinned to HS256.

const encoder = new TextEncoder();

// One imported key per secret, kept for the isolate's life, since importing costs a little
// and the secret never changes while it runs.
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  if (!secret) throw new RangeError('The token signing secret is not set');
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, key);
  }
  return key;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** The MAC of `label` and `value` together, in base64url. */
export async function mac(secret: string, label: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(`${label}\n${value}`));
  return base64url(new Uint8Array(signature));
}

/** Whether `signature` is the MAC of `label` and `value`, compared in constant time. */
export async function verifyMac(secret: string, label: string, value: string, signature: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await keyFor(secret), bytes, encoder.encode(`${label}\n${value}`));
}

/** The SHA-256 of a string, in base64url. */
export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/** A random value of `bytes` bytes, in base64url. */
export function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** What A's tokens carry. `aud` is the one resource the token works at. */
export interface TokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  /** A's epoch when the token was issued, so a Wipe can refuse every earlier token. */
  epoch: number;
}

// A JWT's signing input holds no newline, so it can never equal a labelled MAC's input.
const JWT_HEADER = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(`${JWT_HEADER}.${payload}`));
  return `${JWT_HEADER}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The claims of a token signed with `secret` for `audience` and unexpired at `now` (seconds),
 * or why not. The header must be exactly A's own, so a token cannot choose its `alg`.
 */
export async function verifyToken(
  secret: string,
  token: string,
  audience: string,
  now: number,
): Promise<{ claims: TokenClaims } | { error: string }> {
  const [header, payload, signature, ...rest] = token.split('.');
  if (rest.length > 0 || !header || !payload || !signature) return { error: 'The token is not a JWT' };
  if (header !== JWT_HEADER) return { error: 'The token names an algorithm other than HS256' };
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64url(signature);
  } catch {
    return { error: 'The token signature is not base64url' };
  }
  const valid = await crypto.subtle.verify('HMAC', await keyFor(secret), signatureBytes, encoder.encode(`${header}.${payload}`));
  if (!valid) return { error: 'The token signature does not verify' };
  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as TokenClaims;
  if (claims.aud !== audience) return { error: 'The token is for another resource' };
  if (!(claims.exp > now)) return { error: 'The token has expired' };
  return { claims };
}
