// A browser's navigation to a route reaches the Worker, not a page from the static assets.
// The vitest-plugin lane serves no assets, so this runs the Worker under wrangler's test
// harness, which routes each request through asset handling first, as Cloudflare does.
import { request as httpRequest } from 'node:http';
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HARNESS_SECRETS, signIn } from './sign-in';

const server = createTestHarness({ workers: [{ configPath: './wrangler.jsonc', secrets: HARNESS_SECRETS }] });
const ORIGIN = 'https://resource-webhooks-standalone.transformation.workers.dev';
let base: URL;

beforeAll(async () => {
  base = new URL(String((await server.listen()).url));
});

afterAll(async () => {
  await server.close();
});

// The headers a browser sends on a navigation, over node:http: sent through the harness's own
// fetch, they reached the Worker even with a single-page-application fallback configured.
function navigate(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    httpRequest(new URL(path, base).href, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    })
      .on('error', reject)
      .end();
  });
}

it('serves the page at /', async () => {
  const page = await navigate('/');
  expect(page.status).toBe(200);
  expect(page.body).toContain('<title>Resource webhooks</title>');
});

it('sends a navigation to /authorize, and to a note, to the Worker', async () => {
  const put = await server.fetch(`${ORIGIN}/server/A/notes/inbox/note-42`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await signIn(server, ORIGIN)}` },
    body: '{"title":"Buy milk"}',
  });
  expect(put.status).toBe(201);

  // A's authorization endpoint answers, refusing a request that names no client.
  const authorize = await navigate('/authorize');
  expect(authorize.status).toBe(400);
  expect(JSON.parse(authorize.body)).toMatchObject({ error: 'invalid_client' });
  expect(await navigate('/server/A/notes/inbox/note-42')).toEqual({ status: 200, body: '{"title":"Buy milk"}' });
});
