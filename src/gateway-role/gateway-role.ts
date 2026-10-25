// B's role as a gateway: it takes a webhook delivery's headers and raw bytes, answers it with a
// status, and passes each event down its client's channel. It answers a verification challenge
// itself, from the secret its client registered, and stores nothing. Its host passes in where
// the secrets are and how to forward.
import { verify } from '../standard-webhooks';

/** What B passes down its client's channel: enough to drop a repeat and route by subscription. */
export interface Forwarded {
  subscriptionId: string;
  webhookId: string;
  body: string;
}

export type GatewayReport = {
  kind: 'delivery';
  /**
   * The client the path names and the delivery's webhook-id, only once its signature verifies,
   * since anyone can POST to B and the page shows what B reports.
   */
  client?: string;
  webhookId?: string;
  signature: 'verified' | 'failed' | 'stale' | 'unchecked';
  status: number;
};

export interface GatewayRoleOptions {
  /** The secret the client's channel registered, if the channel is live and registered one. */
  secretFor(client: string): string | undefined;
  /** Sends the message down the client's live channel, and says whether one was there. */
  forward(client: string, message: Forwarded): boolean;
  report?(report: GatewayReport): void;
}

export interface Answer {
  status: number;
  body?: string;
}

export class GatewayRole {
  readonly #options: GatewayRoleOptions;

  constructor(options: GatewayRoleOptions) {
    this.#options = options;
  }

  /**
   * Answers one delivery for `client` at once. With no live channel B is not ready, a retryable
   * `503`. A signature that fails, or a timestamp past the freshness window, is `401`.
   */
  async receive(client: string, headers: Headers, rawBody: Uint8Array): Promise<Answer> {
    const webhookId = headers.get('webhook-id') ?? '';
    const secret = this.#options.secretFor(client);
    if (!secret) return this.#answer(client, webhookId, 'unchecked', { status: 503, body: 'The client is not connected' });
    const verdict = await verify([secret], headers, rawBody, Math.floor(Date.now() / 1000));
    if (verdict !== 'verified') return this.#answer(client, webhookId, verdict, { status: 401, body: 'The signature does not verify' });

    const text = new TextDecoder().decode(rawBody);
    let parsed: { type?: unknown; challenge?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return this.#answer(client, webhookId, verdict, { status: 400, body: 'The body is not JSON' });
    }
    // A challenge is the gateway's own business, and never reaches the client.
    if (parsed.type === 'verification') {
      return this.#answer(client, webhookId, verdict, { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) });
    }
    // The channel can close while the signature is checked, and then the sender must retry.
    const forwarded = this.#options.forward(client, { subscriptionId: headers.get('X-MCP-Subscription-Id') ?? '', webhookId, body: text });
    if (!forwarded) return this.#answer(client, webhookId, verdict, { status: 503, body: 'The client is not connected' });
    return this.#answer(client, webhookId, verdict, { status: 200 });
  }

  #answer(client: string, webhookId: string, signature: GatewayReport['signature'], answer: Answer): Answer {
    this.#options.report?.({ kind: 'delivery', ...(signature === 'verified' ? { client, webhookId } : {}), signature, status: answer.status });
    return answer;
  }
}
