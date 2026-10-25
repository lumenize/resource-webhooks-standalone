// A fake callback endpoint, for the receivers B never is: one that redirects, hangs, or answers
// 410. It answers A's verification challenge correctly unless a test says otherwise, so a
// subscription to it succeeds, and records every POST it gets.
import { fakeReceivers } from './lane';

export interface Received {
  headers: Headers;
  body: string;
  /** The parsed body's `type`, `verification` for a challenge. */
  type?: string;
}

export interface Receiver {
  /** A URL at this receiver, as `https://fault-1f2e3d4c.example/hook`. */
  url(path?: string): string;
  origin: string;
  received: Received[];
  /** The POSTs that were deliveries rather than challenges. */
  deliveries(): Received[];
  challenges(): Received[];
}

type Answer = (received: Received, index: number) => Promise<Response> | Response;

/** Echoes the challenge, as a receiver that wants the deliveries does. */
export const echo: Answer = (received) => Response.json({ challenge: (JSON.parse(received.body) as { challenge: string }).challenge });

export function receiver({ deliveries, challenges = echo }: { deliveries: Answer; challenges?: Answer }): Receiver {
  const origin = `https://fault-${crypto.randomUUID().slice(0, 8)}.example`;
  const received: Received[] = [];
  fakeReceivers.set(origin, async (request) => {
    const body = await request.text();
    const type = body ? (JSON.parse(body) as { type?: string }).type : undefined;
    const entry = { headers: request.headers, body, type };
    received.push(entry);
    return type === 'verification'
      ? challenges(entry, received.filter((each) => each.type === 'verification').length - 1)
      : deliveries(entry, received.filter((each) => each.type !== 'verification').length - 1);
  });
  return {
    url: (path = '/hook') => `${origin}${path}`,
    origin,
    received,
    deliveries: () => received.filter((each) => each.type !== 'verification'),
    challenges: () => received.filter((each) => each.type === 'verification'),
  };
}
