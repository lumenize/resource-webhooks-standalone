// Two pieces of level 2 below the public API, since neither shows through A's routes: the id's
// keyed hash, whose key a test cannot vary in A, and b's copies, which live in the client.
import { describe, expect, it } from 'vitest';
import { Copies } from '../../src/client/copies';
import type { ResourceWebhookSubscribeResult } from '../../src/resource-webhooks-types';
import { subscriptionId } from '../../src/server-role/subscriptions';

describe("a subscription's id", () => {
  it('changes with the hash key alone, and is the same for the same key', async () => {
    const canonical = ['principal', 'https://receiver.example/hook', 'uri', 'https://a.example/server/A/notes/inbox/note-42'];
    const first = await subscriptionId('one key', canonical);
    expect(first).toMatch(/^sub_[0-9a-f]{16}$/);
    expect(await subscriptionId('one key', canonical)).toBe(first);
    expect(await subscriptionId('another key', canonical)).not.toBe(first);
  });
});

describe("b's copies", () => {
  it('ignores a delivery of the version it holds, keeping the contents a full delivery brought', () => {
    const copies = new Copies(async () => ({ resultType: 'complete' }) as ResourceWebhookSubscribeResult);
    const uri = 'https://a.example/server/A/notes/inbox/note-42';
    const contents = [{ uri, mimeType: 'application/json', text: '{"title":"Buy milk"}' }];
    copies.deliver({ uri, form: 'full', version: 'v2', contents });
    copies.deliver({ uri, form: 'notify', version: 'v2' });
    expect(copies.get(uri)).toEqual({ version: 'v2', deleted: false, contents });
    copies.deliver({ uri, form: 'notify', version: 'v3' });
    expect(copies.get(uri)).toEqual({ version: 'v3', deleted: false });
  });
});
