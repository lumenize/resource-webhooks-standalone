// What A and B report to the page, redacted at the source: a secret becomes `whsec_…(32 bytes)`
// and a token becomes its subject and audience, wherever either appears in a report.
import { secretBytes } from './standard-webhooks';

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SECRET = /whsec_[A-Za-z0-9+/]+={0,2}/g;

/** A copy of `value` with every secret and token in it redacted. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  }
  return value;
}

function redactString(text: string): string {
  return text
    .replace(JWT, (token) => describeToken(token))
    .replace(SECRET, (secret) => `whsec_…(${secretBytes(secret)?.length ?? '?'} bytes)`);
}

function describeToken(token: string): string {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { sub, aud } = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))) as { sub?: string; aud?: string };
    return `token(sub=${sub}, aud=${aud})`;
  } catch {
    return 'token(…)';
  }
}
