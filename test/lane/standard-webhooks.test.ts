// A's signer and B's verifier checked against the `standardwebhooks` package, so the two cannot
// agree on a scheme that no off-the-shelf verifier would accept. Unit tests, below the public
// API, since this is the one place an outside implementation can judge them byte for byte.
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { deliveryHeaders, newSecret, secretBytes, sign, verify } from '../../src/standard-webhooks';

const BODY = '{"eventId":"evt_e0.1","name":"mcp.resource.updated","timestamp":"2026-10-21T14:05:00Z","data":{"uri":"https://x/notes/inbox/note-42"},"cursor":null}';

describe('Standard Webhooks', () => {
  it("signs so that the package's verifier accepts it", async () => {
    const secret = newSecret();
    const now = Math.floor(Date.now() / 1000);
    const headers = await deliveryHeaders(secret, 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W', 'sub_a3f1c8e2b0d49f7e', BODY, now);
    expect(new Webhook(secret).verify(BODY, headers)).toEqual(JSON.parse(BODY));
  });

  it("verifies what the package signs, and refuses a changed body or another secret", async () => {
    const secret = newSecret();
    const now = Math.floor(Date.now() / 1000);
    const signature = new Webhook(secret).sign('msg_1', new Date(now * 1000), BODY);
    const headers = new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(now), 'webhook-signature': signature });
    const bytes = new TextEncoder().encode(BODY);
    expect(await verify([secret], headers, bytes, now)).toBe('verified');
    expect(await verify([secret], headers, new TextEncoder().encode(BODY.replace('42', '43')), now)).toBe('failed');
    expect(await verify([newSecret()], headers, bytes, now)).toBe('failed');
    expect(await verify([secret], headers, bytes, now + 6 * 60)).toBe('stale');
  });

  it('accepts any one of several space-delimited signatures, as during a rotation', async () => {
    const [oldSecret, newer] = [newSecret(), newSecret()];
    const now = Math.floor(Date.now() / 1000);
    const both = `${await sign(oldSecret, 'msg_1', now, BODY)} ${await sign(newer, 'msg_1', now, BODY)}`;
    const headers = new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(now), 'webhook-signature': both });
    expect(await verify([newer], headers, new TextEncoder().encode(BODY), now)).toBe('verified');
  });

  it('takes a secret only as whsec_ and the base64 of 24 to 64 bytes', () => {
    const of = (bytes: number) => `whsec_${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`;
    expect([23, 24, 64, 65].map((bytes) => Boolean(secretBytes(of(bytes))))).toEqual([false, true, true, false]);
    expect(secretBytes(of(32).replace('whsec_', 'wh_'))).toBeUndefined();
    expect(secretBytes('whsec_not base64!')).toBeUndefined();
  });
});
