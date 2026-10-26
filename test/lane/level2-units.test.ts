// Three pieces of level 2 below the public API, since none shows through A's routes: the id's
// keyed hash, whose key a test cannot vary in A, the page size A refuses to start with, and b's
// copies, which live in the client.
import { describe, expect, it } from 'vitest';
import { Copies, type Held } from '../../src/client/copies';
import type { ResourceChange, ResourceWebhookSubscribeResult } from '../../src/resource-webhooks-types';
import { ResourceWebhooks, type ResourceWebhooksOptions } from '../../src/server-role/resource-webhooks';
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

describe('the page size', () => {
  it('must be a positive integer, so a missing setting stops A rather than answering every catch-up empty', () => {
    for (const pageSize of [Number(undefined), 0, 1.5]) {
      expect(() => new ResourceWebhooks({ pageSize } as ResourceWebhooksOptions)).toThrow(RangeError);
    }
    expect(() => new ResourceWebhooks({ pageSize: 1 } as ResourceWebhooksOptions)).not.toThrow();
  });
});

describe("b's copies", () => {
  const uri = 'https://a.example/server/A/notes/inbox/note-42';
  const subscribed = async () => {
    const copies = new Copies(async () => ({ resultType: 'complete', id: 'sub_1', refreshBefore: null, version: 'v1' }) as ResourceWebhookSubscribeResult);
    await copies.refresh({ uri });
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
    copies.deliver({ uri, form: 'notify', version: 'v2' }, { webhookId: 'msg_2' });
    copies.deliver({ uri, form: 'notify', version: 'v3' }, { webhookId: 'msg_3' });
    copies.deliver({ uri, form: 'notify', version: 'v2' }, { webhookId: 'msg_2' });
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

  // A scripted A: each call takes the next answer, which may deliver first, as B can.
  type Answer = (held: Held) => ResourceWebhookSubscribeResult | Error;
  const scripted = (answers: Answer[]) => {
    const calls: Held[] = [];
    let copies!: Copies;
    copies = new Copies(async (_target, held) => {
      calls.push(held);
      const answer = answers.shift()!(held);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { copies: () => copies, calls };
  };
  const result = (fields: Partial<ResourceWebhookSubscribeResult>, id = 'sub_1') => ({ resultType: 'complete', id, refreshBefore: null, ...fields }) as ResourceWebhookSubscribeResult;
  const change = (member: string, version: string): ResourceChange => ({ uri: `${uri}/${member}`, form: 'notify', version });

  it('refreshes again when a delivery beats the first result, which brings the id it came under', async () => {
    const script = scripted([
      () => {
        script.copies().deliver({ uri, form: 'notify', version: 'v2' }, { webhookId: 'msg_2', subscriptionId: 'sub_1' });
        return result({ version: 'v1' });
      },
      () => result({ version: 'v2' }),
    ]);
    await script.copies().refresh({ uri });
    expect(script.calls).toEqual([{ version: undefined }, { version: 'v2' }]);
    expect(script.copies().get(uri)?.version).toBe('v2');
  });

  it("refreshes a collection again from its cursor when a delivery crosses it, and ends at the delivery's version", async () => {
    const script = scripted([
      () => result({ changes: [], cursor: 'c1' }),
      () => {
        script.copies().deliver(change('note-1', 'v2'), { webhookId: 'msg_2', subscriptionId: 'sub_1' });
        return result({ changes: [change('note-1', 'v1')], cursor: 'c2' });
      },
      () => result({ changes: [change('note-1', 'v2')], cursor: 'c3' }),
    ]);
    await script.copies().refresh({ uri });
    await script.copies().refresh({ uri });
    expect(script.calls.map((held) => held.cursor)).toEqual([undefined, 'c1', 'c2']);
    expect(script.copies().get(`${uri}/note-1`)?.version).toBe('v2');
  });

  it('finishes a reset that a failed refresh left partway, dropping only what no page of it listed', async () => {
    const script = scripted([
      () => result({ changes: [change('note-1', 'v1'), change('note-2', 'v1'), change('note-3', 'v1')], cursor: 'c1' }),
      () => result({ changes: [change('note-1', 'v1')], cursor: 'r1', reset: true, hasMore: true }),
      () => new Error('the network dropped'),
      () => result({ changes: [change('note-2', 'v1')], cursor: 'c9', reset: true }),
    ]);
    await script.copies().refresh({ uri });
    await expect(script.copies().refresh({ uri })).rejects.toThrow('the network dropped');
    await script.copies().refresh({ uri });
    expect(script.calls.map((held) => held.cursor)).toEqual([undefined, 'c1', 'r1', 'r1']);
    expect(script.copies().held().sort()).toEqual([`${uri}/note-1`, `${uri}/note-2`]);
  });
});
