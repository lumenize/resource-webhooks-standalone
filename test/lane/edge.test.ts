import { listDurableObjectIds } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { callWorker, newLane } from './lane';

const EVIL = 'https://evil.example';

async function serverIds(): Promise<string[]> {
  return (await listDurableObjectIds(env.SERVER)).map((id) => id.toString());
}

it("refuses another origin with 403 on every route, a preflight included, and wakes no object", async () => {
  const lane = newLane();
  const before = await serverIds();
  const attempts: [string, string][] = [
    ['GET', '/notes/inbox/note-42'],
    ['PUT', '/notes/inbox/note-42'],
    ['DELETE', '/notes/inbox/note-42'],
    ['GET', '/notes/inbox'],
    ['OPTIONS', '/notes/inbox/note-42'],
  ];
  for (const [method, path] of attempts) {
    const init: RequestInit = { method, headers: { Origin: EVIL } };
    if (method === 'PUT') init.body = '{"title":"Buy milk"}';
    if (method === 'OPTIONS') init.headers = { Origin: EVIL, 'Access-Control-Request-Method': 'PUT' };
    const response = await lane.fetch(path, init);
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  for (const url of ['/server', '/server/X/notes/note-1', '/authorize', '/nowhere']) {
    const response = await callWorker(new Request(`${env.ORIGIN}${url}`, { method: 'OPTIONS', headers: { Origin: EVIL } }), lane.env);
    expect({ url, status: response.status }).toEqual({ url, status: 403 });
  }
  expect(await serverIds()).toEqual(before);

  // The same requests from the Worker's own origin do wake A, so the list above can change.
  const own = await lane.fetch('/notes/inbox', { headers: { Origin: env.ORIGIN } });
  expect(own.status).toBe(200);
  expect(own.headers.get('Access-Control-Allow-Origin')).toBe(env.ORIGIN);
  expect(await serverIds()).toHaveLength(before.length + 1);
});

it("answers its own origin's preflight with CORS headers", async () => {
  const lane = newLane();
  const response = await lane.fetch('/notes/inbox/note-42', {
    method: 'OPTIONS',
    headers: { Origin: env.ORIGIN, 'Access-Control-Request-Method': 'PUT' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ORIGIN);
});

it('routes only the instance it names, and only the paths and methods its table lists', async () => {
  const lane = newLane();
  await lane.fetch('/notes/inbox/note-1', { method: 'PUT', body: '{"title":"Here"}' });
  const before = await serverIds();
  const refused: [string, string, RequestInit?][] = [
    ['GET', `/server/X/notes/note-1`],
    ['GET', `/server/A/notes/note-1`],
    ['GET', `/server/${lane.name.toUpperCase()}/notes/note-1`],
    ['GET', '/server'],
    ['GET', `/server/${lane.name}`],
    ['GET', `/server/${lane.name}/`],
    ['GET', `/server//${lane.name}/notes/inbox/note-1`],
    ['GET', `/server/${lane.name}/elsewhere`],
    ['GET', `/server/${lane.name}/notesx`],
    ['GET', `/server/${lane.name}/notes/inbox/note-1`, { headers: { Upgrade: 'websocket' } }],
    ['GET', '/gateway/B/ws/b'],
    ['GET', '/nowhere'],
  ];
  for (const [method, path, init] of refused) {
    const response = await callWorker(new Request(`${env.ORIGIN}${path}`, { method, ...init }), lane.env);
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
  }
  expect(await serverIds()).toEqual(before);
  expect((await lane.fetch('/notes/inbox/note-1')).status).toBe(200);
});

it('answers a method the table does not list for a path it does with 405, naming the ones it does', async () => {
  const lane = newLane();
  const before = await serverIds();
  const refused: [string, string, string][] = [
    ['POST', '/notes/inbox/note-1', 'GET, HEAD, PUT, DELETE'],
    ['GET', '/mcp', 'POST'],
    ['DELETE', '/mcp', 'POST'],
  ];
  for (const [method, path, allow] of refused) {
    const response = await lane.fetch(path, { method, body: method === 'POST' ? '{}' : undefined });
    expect({ method, path, status: response.status, allow: response.headers.get('Allow') }).toEqual({ method, path, status: 405, allow });
  }
  expect(await serverIds()).toEqual(before);
});
