// Keeps every fetch inside the lane. A request for the Worker's own origin, as A's webhook POST
// to B will be, goes to the Worker's real handler, and anything else fails the test, so nothing
// reaches the network.
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { callWorker, laneEnvFor } from './lane';

export const fetchSpy = vi
  .spyOn(globalThis, 'fetch')
  .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== env.ORIGIN) {
      throw new Error(`A fetch tried to leave the lane: ${request.method} ${request.url}`);
    }
    return callWorker(request, laneEnvFor(request));
  });
