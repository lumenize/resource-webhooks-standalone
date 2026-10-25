import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { newLane } from './lane';

// The probe every later phase leans on: a fetch A makes reaches the spy in setup.ts, so A's
// POST to B can stay inside the lane. Nothing A does yet fetches anything, so the probe makes
// the fetch from inside A's own context with runInDurableObject, below the public API.
it('sees a fetch made inside A, and sends it to the Worker', async () => {
  const lane = newLane();
  const put = await lane.fetch('/notes/inbox/note-1', { method: 'PUT', body: '{"title":"Probe"}' });
  expect(put.status).toBe(201);
  const spy = vi.mocked(globalThis.fetch);
  spy.mockClear();

  const read = await runInDurableObject(lane.stub, async () => {
    const response = await fetch(`${lane.root}/notes/inbox/note-1`);
    return { status: response.status, body: await response.text() };
  });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(read).toEqual({ status: 200, body: '{"title":"Probe"}' });
});

it('lets no fetch out to another origin', async () => {
  await expect(fetch('https://example.com/')).rejects.toThrow('A fetch tried to leave the lane');
});
