// A's outbound webhooks, as SEP-3415 defines them: the verification handshake before a first
// delivery to a (principal, url), a token bucket per host for those handshakes, and a retry
// queue in memory, one slot per caller-chosen key, where a newer message replaces an older one.
// Each message keeps its webhook-id across retries, and each attempt is signed afresh. The host
// passes in how to send and how to keep a promise alive past its request.
import { JsonRpcError } from '../json-rpc';
import { CALLBACK_ENDPOINT_ERROR, RESOURCE_EXHAUSTED } from '../events-types';
import { constantTimeEqual, deliveryHeaders } from '../standard-webhooks';

/**
 * A POST to a callback URL, sent without following redirects and given up after the host's
 * timeout. With `readAnswer`, it reads at most MAX_ANSWER_BYTES of the answer, and a longer one
 * comes back empty. Without it, it reads none, since a delivery's answer is only its status.
 */
export type Send = (url: string, headers: Record<string, string>, body: string, readAnswer: boolean) => Promise<SendResult>;

export type SendResult =
  | {
      status: number;
      body?: string;
      /** The error code the answer's body names, as Cloudflare's own pages do: 1016, 526. */
      errorCode?: number;
    }
  | { failure: 'timeout' | 'connection_refused' };

/** The most of a challenge's answer A reads, since anyone can name the URL that answers it. */
export const MAX_ANSWER_BYTES = 4096;

/** What the host reports to the page, which never sees a secret or a signature. */
export type DeliveryReport =
  | {
      kind: 'verification';
      url: string;
      outcome: 'verified' | 'failed' | 'cached';
      /**
       * Why a challenge failed, for the page: the error code of a page the host's network answered
       * with, or the failure. Never the endpoint's own status, since the page is open, and an
       * origin that admits only the host's network answers A and not whoever watches the page.
       */
      errorCode?: number;
      failure?: string;
    }
  | { kind: 'attempt'; url: string; webhookId: string; attempt: number; outcome: string };

export interface DeliveriesOptions {
  send: Send;
  /** Keeps a promise alive past the request that started it, as `ctx.waitUntil` does. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The delays between attempts, in milliseconds, already clamped to SEP-3415's bounds. */
  schedule: () => readonly number[];
  /** How many verification POSTs one host may receive in a burst, refilled one a minute. */
  verificationBurst: number;
  /** How long a handshake covers its `(principal, url)` since it last did, as a grant lasts. */
  verificationTtlMs: number;
  report?: (report: DeliveryReport) => void;
}

/** One message to deliver. */
export interface Message {
  url: string;
  secret: string;
  subscriptionId: string;
  webhookId: string;
  body: string;
  /** When the subscription's grant ends, as an ISO string, after which no attempt is made. */
  until?: string;
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

// One slot's delivery. Its message is in flight while a POST is outstanding, and waiting between
// attempts otherwise. A newer message for the slot waits as `pending`, and replaces the one being
// delivered as soon as its POST is answered or at once if it is waiting.
interface Slot {
  subscriptionId: string;
  pending?: Message;
  cancelled: boolean;
  /** A POST is out, which an unsubscribe lets finish before the slot takes another message. */
  posting: boolean;
  /** Ends the wait between attempts early. */
  wake?: () => void;
}

export class Deliveries {
  readonly #options: DeliveriesOptions;
  // Soft state, as SEP-3415 allows: lost on eviction, rebuilt by the next subscribe.
  readonly #verified = new Map<string, number>();
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
    const now = Date.now();
    this.#sweep(now);
    if (this.#verified.has(key)) {
      this.#verified.set(key, now + this.#options.verificationTtlMs);
      this.#options.report?.({ kind: 'verification', url, outcome: 'cached' });
      return;
    }
    this.#takeVerificationToken(new URL(url).host, now);
    const challenge = randomId(24);
    const body = JSON.stringify({ type: 'verification', challenge });
    const headers = await deliveryHeaders(secret, `msg_verification_${randomId(16)}`, subscriptionId, body, nowSeconds());
    const generation = this.#generation;
    const result = await this.#options.send(url, headers, body, true);
    if ('failure' in result) {
      this.#options.report?.({ kind: 'verification', url, outcome: 'failed', failure: result.failure });
      throw new JsonRpcError(CALLBACK_ENDPOINT_ERROR, 'The callback endpoint could not be reached', { reason: result.failure });
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(result.body ?? '') as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    const ok = result.status >= 200 && result.status < 300 && typeof echoed === 'string' && constantTimeEqual(echoed, challenge);
    this.#options.report?.({ kind: 'verification', url, outcome: ok ? 'verified' : 'failed', errorCode: result.errorCode });
    if (!ok) throw new JsonRpcError(CALLBACK_ENDPOINT_ERROR, 'The callback endpoint did not echo the challenge', { reason: 'challenge_failed' });
    // A Wipe while the challenge was out forgets everything, this handshake included.
    if (generation === this.#generation) this.#verified.set(key, Date.now() + this.#options.verificationTtlMs);
  }

  /** Delivers `message` in `slot`, retrying on A's schedule, unless a newer one replaces it. */
  enqueue(slot: string, message: Message): void {
    const existing = this.#slots.get(slot);
    if (existing) {
      existing.pending = message;
      existing.wake?.();
      return;
    }
    this.#start(slot, message);
  }

  /**
   * Stops every delivery for a subscription, as unsubscribing does. A POST already out keeps its
   * slot until it is answered, so the next delivery for that URI, if the same key subscribes
   * again, cannot overtake it.
   */
  cancel(subscriptionId: string): void {
    for (const [slot, state] of this.#slots) {
      if (state.subscriptionId !== subscriptionId) continue;
      state.cancelled = true;
      state.pending = undefined;
      state.wake?.();
      if (!state.posting) this.#slots.delete(slot);
    }
  }

  /** Forgets every verification and abandons every delivery, as a Wipe does. */
  clear(): void {
    this.#generation++;
    for (const state of this.#slots.values()) {
      state.cancelled = true;
      state.wake?.();
    }
    this.#slots.clear();
    this.#verified.clear();
    this.#buckets.clear();
  }

  // Each message runs under its own waitUntil, which holds the object up to 15 minutes from the
  // promise's start, so the schedule's window is measured from the message's first attempt.
  #start(slot: string, message: Message): void {
    const state: Slot = { subscriptionId: message.subscriptionId, cancelled: false, posting: false };
    this.#slots.set(slot, state);
    this.#options.waitUntil(this.#deliver(slot, state, message));
  }

  async #deliver(slot: string, state: Slot, message: Message): Promise<void> {
    const delays = this.#options.schedule();
    for (let attempt = 1; ; attempt++) {
      // A subscription whose grant lapsed gets no more attempts.
      if (message.until !== undefined && message.until < new Date().toISOString()) break;
      const headers = await deliveryHeaders(message.secret, message.webhookId, message.subscriptionId, message.body, nowSeconds());
      if (state.cancelled) break;
      state.posting = true;
      const result = await this.#options.send(message.url, headers, message.body, false);
      state.posting = false;
      const outcome = 'failure' in result ? result.failure : String(result.status);
      this.#options.report?.({ kind: 'attempt', url: message.url, webhookId: message.webhookId, attempt, outcome });
      // 410 and 413 refuse this message for good, without ending the subscription.
      const settled = !('failure' in result) && ((result.status >= 200 && result.status < 300) || result.status === 410 || result.status === 413);
      if (state.cancelled || settled || state.pending || attempt > delays.length) break;
      await this.#wait(state, delays[attempt - 1]);
      if (state.cancelled || state.pending) break;
    }
    // A Wipe has forgotten the slot, or an unsubscribe with no POST out has.
    if (this.#slots.get(slot) !== state) return;
    const next = state.pending;
    this.#slots.delete(slot);
    if (next) this.#start(slot, next);
  }

  #wait(state: Slot, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        state.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      state.wake = done;
    });
  }

  #takeVerificationToken(host: string, now: number): void {
    const bucket = this.#buckets.get(host) ?? { tokens: this.#options.verificationBurst, at: now };
    bucket.tokens = Math.min(this.#options.verificationBurst, bucket.tokens + (now - bucket.at) / 60_000);
    bucket.at = now;
    this.#buckets.set(host, bucket);
    if (bucket.tokens < 1) throw new JsonRpcError(RESOURCE_EXHAUSTED, 'Too many verification requests to this host', { limit: 'verifications' });
    bucket.tokens -= 1;
  }

  // Drops expired verifications, and buckets that have refilled, which a new one would equal, so
  // neither map grows past what the last few minutes put in it.
  #sweep(now: number): void {
    for (const [key, until] of this.#verified) if (until <= now) this.#verified.delete(key);
    const refill = this.#options.verificationBurst * 60_000;
    for (const [host, bucket] of this.#buckets) if (now - bucket.at >= refill) this.#buckets.delete(host);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A random identifier of ASCII letters and digits, as webhook-id and challenges use. */
export function randomId(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join('');
}
