// A's outbound webhooks, as SEP-3415 defines them: the verification handshake before a first
// delivery to a (principal, url), a token bucket per host for those handshakes, and a retry
// queue in memory. Each message keeps its webhook-id across retries, and each attempt is signed
// afresh. The host passes in how to send and how to keep a promise alive past its request.
import { JsonRpcError } from '../json-rpc';
import { CALLBACK_ENDPOINT_ERROR, RESOURCE_EXHAUSTED } from '../events-types';
import { constantTimeEqual, deliveryHeaders } from '../standard-webhooks';

/** A POST to a callback URL, sent without following redirects and given up after the host's timeout. */
export type Send = (url: string, headers: Record<string, string>, body: string) => Promise<SendResult>;

export type SendResult = { status: number; body: string } | { failure: 'timeout' | 'connection_refused' | 'tls_error' };

/** What the host reports to the page, which never sees a secret or a signature. */
export type DeliveryReport =
  | { kind: 'verification'; url: string; outcome: 'verified' | 'failed' | 'cached' }
  | { kind: 'attempt'; url: string; webhookId: string; attempt: number; outcome: string };

export interface DeliveriesOptions {
  send: Send;
  /** Keeps a promise alive past the request that started it, as `ctx.waitUntil` does. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The delays between attempts, in milliseconds, already clamped to SEP-3415's bounds. */
  schedule: () => readonly number[];
  /** How many verification POSTs one host may receive in a burst, refilled one a minute. */
  verificationBurst: number;
  report?: (report: DeliveryReport) => void;
}

/** One message to deliver. */
export interface Message {
  url: string;
  secret: string;
  subscriptionId: string;
  webhookId: string;
  body: string;
}

// SEP-3415 asks for 3 to 5 attempts over no more than 10 to 15 minutes. The window stops short of
// 15, since ctx.waitUntil holds an object up to 15 minutes from the promise's start.
export const MIN_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 5;
export const MAX_WINDOW_MS = 14 * 60 * 1000;
export const DEFAULT_SCHEDULE_MS: readonly number[] = [30_000, 120_000, 300_000];

/** A schedule of delays between attempts, held to SEP-3415's bounds. */
export function clampSchedule(delays: readonly number[]): number[] {
  const usable = delays.filter((delay) => Number.isFinite(delay) && delay >= 0);
  const clamped = usable.slice(0, MAX_ATTEMPTS - 1);
  while (clamped.length < MIN_ATTEMPTS - 1) clamped.push(clamped.at(-1) ?? DEFAULT_SCHEDULE_MS[0]);
  let total = 0;
  return clamped.map((delay) => {
    const allowed = Math.max(0, Math.min(delay, MAX_WINDOW_MS - total));
    total += allowed;
    return allowed;
  });
}

interface Slot {
  pending?: Message;
}

export class Deliveries {
  readonly #options: DeliveriesOptions;
  // Soft state, as SEP-3415 allows: lost on eviction, rebuilt by the next subscribe.
  readonly #verified = new Set<string>();
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #slots = new Map<string, Slot>();
  #generation = 0;

  constructor(options: DeliveriesOptions) {
    this.#options = options;
  }

  /**
   * Proves the endpoint wants deliveries for this principal, by the handshake unless a
   * handshake already proved it. Throws `CallbackEndpointError` or `ResourceExhausted`.
   */
  async requireVerified(principal: string, url: string, secret: string, subscriptionId: string): Promise<void> {
    const key = `${principal}\n${url}`;
    if (this.#verified.has(key)) {
      this.#options.report?.({ kind: 'verification', url, outcome: 'cached' });
      return;
    }
    this.#takeVerificationToken(new URL(url).host);
    const challenge = randomId(24);
    const body = JSON.stringify({ type: 'verification', challenge });
    const headers = await deliveryHeaders(secret, `msg_verification_${randomId(16)}`, subscriptionId, body, nowSeconds());
    const result = await this.#options.send(url, headers, body);
    if ('failure' in result) {
      this.#options.report?.({ kind: 'verification', url, outcome: 'failed' });
      throw new JsonRpcError(CALLBACK_ENDPOINT_ERROR, 'The callback endpoint could not be reached', { reason: result.failure });
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(result.body) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    const ok = result.status >= 200 && result.status < 300 && typeof echoed === 'string' && constantTimeEqual(echoed, challenge);
    this.#options.report?.({ kind: 'verification', url, outcome: ok ? 'verified' : 'failed' });
    if (!ok) throw new JsonRpcError(CALLBACK_ENDPOINT_ERROR, 'The callback endpoint did not echo the challenge', { reason: 'challenge_failed' });
    this.#verified.add(key);
  }

  /**
   * Delivers `message` in `slot`, retrying on A's schedule. A message for a slot already in
   * flight waits as its slot's one pending message, replacing any pending before it.
   */
  enqueue(slot: string, message: Message): void {
    const existing = this.#slots.get(slot);
    if (existing) {
      existing.pending = message;
      return;
    }
    const state: Slot = { pending: message };
    this.#slots.set(slot, state);
    this.#options.waitUntil(this.#drain(slot, state, this.#generation));
  }

  /** Forgets every verification and abandons every pending delivery, as a Wipe does. */
  clear(): void {
    this.#generation++;
    this.#verified.clear();
    this.#buckets.clear();
    this.#slots.clear();
  }

  async #drain(slot: string, state: Slot, generation: number): Promise<void> {
    while (state.pending && generation === this.#generation) {
      const message = state.pending;
      state.pending = undefined;
      await this.#deliver(message, generation);
    }
    if (this.#slots.get(slot) === state) this.#slots.delete(slot);
  }

  async #deliver(message: Message, generation: number): Promise<void> {
    const delays = this.#options.schedule();
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      if (generation !== this.#generation) return;
      const headers = await deliveryHeaders(message.secret, message.webhookId, message.subscriptionId, message.body, nowSeconds());
      const result = await this.#options.send(message.url, headers, message.body);
      const outcome = 'failure' in result ? result.failure : String(result.status);
      this.#options.report?.({ kind: 'attempt', url: message.url, webhookId: message.webhookId, attempt, outcome });
      if (!('failure' in result)) {
        if (result.status >= 200 && result.status < 300) return;
        // 410 and 413 refuse this message for good, without ending the subscription.
        if (result.status === 410 || result.status === 413) return;
      }
      if (attempt <= delays.length) await sleep(delays[attempt - 1]);
    }
  }

  #takeVerificationToken(host: string): void {
    const now = Date.now();
    const bucket = this.#buckets.get(host) ?? { tokens: this.#options.verificationBurst, at: now };
    bucket.tokens = Math.min(this.#options.verificationBurst, bucket.tokens + (now - bucket.at) / 60_000);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.#buckets.set(host, bucket);
      throw new JsonRpcError(RESOURCE_EXHAUSTED, 'Too many verification requests to this host', { limit: 'verifications' });
    }
    bucket.tokens -= 1;
    this.#buckets.set(host, bucket);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A random identifier of ASCII letters and digits, as webhook-id and challenges use. */
export function randomId(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join('');
}
