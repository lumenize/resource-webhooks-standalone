// The page's back channel to A and B, which the demo watches and the tests listen on. Reports
// are redacted at the source, and a control is obeyed only with the operator token, which is
// compared in constant time and never reported. A control itself is never reported either.
import { redact } from './redact';
import { constantTimeEqual } from './standard-webhooks';

export const PAGE_TAG = 'page';

/** Sends a redacted report to every page listening on this object's back channel. */
export function report(ctx: DurableObjectState, party: 'A' | 'B', body: Record<string, unknown>): void {
  const text = JSON.stringify(redact({ party, ...body }));
  for (const socket of ctx.getWebSockets(PAGE_TAG)) {
    try {
      socket.send(text);
    } catch {
      // A page that went away misses the report, which is only for watching.
    }
  }
}

/** Accepts a page's back-channel socket, which needs no token: reports are open to the page. */
export function acceptPage(ctx: DurableObjectState): Response {
  const [client, server] = Object.values(new WebSocketPair());
  ctx.acceptWebSocket(server, [PAGE_TAG]);
  return new Response(null, { status: 101, webSocket: client });
}

export interface Control {
  type: 'control';
  operatorToken?: unknown;
  action?: unknown;
  [key: string]: unknown;
}

/**
 * Whether a control carries the operator token. With no OPERATOR_TOKEN binding, every control
 * is refused, so no environment is open by default.
 */
export function authorized(control: Control, operatorToken: string | undefined): boolean {
  return Boolean(operatorToken) && typeof control.operatorToken === 'string' && constantTimeEqual(control.operatorToken, operatorToken!);
}
