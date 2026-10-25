// The Worker the conformance suite runs against, and only locally: the demo's Worker with the
// suite's fixtures added to A. The demo's `main` never imports this module, and it serves
// nothing unless the run sets CONFORMANCE, which no config file does.
import { mcpEndpoint } from '../auth/metadata';
import { signToken } from '../auth/signing';
import { handleRequest } from '../edge';
import { Server as DemoServer } from '../server';
import { FIXTURES } from './fixtures';

type ConformanceEnv = Env & { CONFORMANCE?: string };

// The suite sends no token, so this build gives it one for every method but the two that
// subscribe a webhook, which it must never reach without a principal of its own.
const NEVER_OPENED = new Set(['resources/webhooks/subscribe', 'resources/webhooks/unsubscribe']);

export { Gateway } from '../gateway';

export class Server extends DemoServer {
  static extras = FIXTURES;
}

export default {
  async fetch(request: Request, env: ConformanceEnv): Promise<Response> {
    // Deployed by mistake, it still serves nothing: no deployed host is localhost.
    if (env.CONFORMANCE !== 'on' || new URL(request.url).hostname !== 'localhost') {
      // 403, as the suite's DNS-rebinding check expects of a request naming another host.
      return new Response('This Worker serves only a local conformance run', { status: 403 });
    }
    return handleRequest(await withSuiteToken(request, env), env);
  },
};

async function withSuiteToken(request: Request, env: ConformanceEnv): Promise<Request> {
  const endpoint = mcpEndpoint(env.ORIGIN, env.SERVER_INSTANCE);
  if (request.method !== 'POST' || request.url !== endpoint || request.headers.has('Authorization')) return request;
  let method: unknown;
  try {
    method = (JSON.parse(await request.clone().text()) as { method?: unknown }).method;
  } catch {
    method = undefined;
  }
  if (typeof method === 'string' && NEVER_OPENED.has(method)) return request;
  const now = Math.floor(Date.now() / 1000);
  // Each run starts on fresh storage, so A's epoch is 0.
  const token = await signToken(env.TOKEN_SIGNING_KEY, { iss: env.ORIGIN, sub: 'conformance-suite', aud: endpoint, iat: now, exp: now + 300, epoch: 0 });
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}
