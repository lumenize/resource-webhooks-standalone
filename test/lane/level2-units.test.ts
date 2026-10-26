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
  const uri = 'https://a.example/server/A/notes/inbox/note-42';
  const subscribed = async () => {
    const copies = new Copies(async () => ({ resultType: 'complete', id: 'sub_1', refreshBefore: null, version: 'v1' }) as ResourceWebhookSubscribeResult);
    await copies.refresh(uri);
    return copies;
  };

  it('ignores a delivery of the version it holds, keeping the contents a full delivery brought', async () => {
    const copies = await subscribed();
    const contents = [{ uri, mimeType: 'application/json', text: '{"title":"Buy milk"}' }];
    copies.deliver({ uri, form: 'full', version: 'v2', contents });
    copies.deliver({ uri, form: 'notify', version: 'v2' });
    expect(copies.get(uri)).toEqual({ version: 'v2', deleted: false, contents });
    copies.deliver({ uri, form: 'notify', version: 'v3' });
    expect(copies.get(uri)).toEqual({ version: 'v3', deleted: false });
  });

  it('drops a delivery whose webhook-id it has seen, as a late retry of an older version', async () => {
    const copies = await subscribed();
    copies.deliver({ uri, form: 'notify', version: 'v2' }, 'msg_2');
    copies.deliver({ uri, form: 'notify', version: 'v3' }, 'msg_3');
    copies.deliver({ uri, form: 'notify', version: 'v2' }, 'msg_2');
    expect(copies.get(uri)?.version).toBe('v3');
  });

  it('drops a delivery for a resource none of its subscriptions covers', async () => {
    const copies = await subscribed();
    const elsewhere = 'https://a.example/server/A/notes/inbox2/note-1';
    copies.deliver({ uri: elsewhere, form: 'notify', version: 'v1' });
    expect(copies.get(elsewhere)).toBeUndefined();
    copies.deliver({ uri: `${uri}/part`, form: 'notify', version: 'v1' });
    expect(copies.get(`${uri}/part`)).toEqual({ version: 'v1', deleted: false });
  });
});
