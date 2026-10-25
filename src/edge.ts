// The Worker's edge. It refuses any other origin before an object wakes, checks A's tokens, and
// routes only what its table lists, by path and method, to the one instance it names. A path it
// does not list is 404, and a method it does not list for a path it does is 405.
import { mcpEndpoint, authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl } from './auth/metadata';
import { verifyToken } from './auth/signing';
import {
  addCorsHeaders,
  applyCorsPolicy,
  MissingInstanceNameError,
  routeDORequest,
  type CorsOptions,
} from './vendor/lumenize-routing/route-do-request';

/**
 * The header the edge sets to the claims of a token it verified, as `{"sub":"…","epoch":0}`, and
 * strips from every request, so no caller can set it.
 */
export const CLAIMS_HEADER = 'x-rw-principal';

interface Route {
  /** A path under the instance's root, as `/notes/inbox/note-42` under `/server/A`. */
  path: RegExp;
  /** The HTTP methods the route takes, or `websocket` for an upgrade. */
  methods: readonly string[] | 'websocket';
  /** The methods that need a token for A. */
  token?: readonly string[];
}

/** Every route the edge lets reach A. */
const SERVER_ROUTES: readonly Route[] = [
  { path: /^\/mcp$/, methods: ['POST'], token: ['POST'] },
  { path: /^\/(notes|lists)(\/.*)?$/, methods: ['GET', 'HEAD', 'PUT', 'DELETE'], token: ['PUT', 'DELETE'] },
];

/** The authorization server's routes, which the Worker hands to A by hand, and their methods. */
const AUTHORIZATION_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/register', 'POST'],
  ['/authorize', 'GET'],
  ['/token', 'POST'],
]);

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const cors: CorsOptions = { origin: [env.ORIGIN] };
  const refused = originGuard(request, cors);
  if (refused) return refused;
  request = withoutClaims(request);

  const byHand = await authorizationRoute(request, env);
  if (byHand) {
    const { allowedOrigin } = applyCorsPolicy(request, cors);
    return allowedOrigin ? addCorsHeaders(byHand, allowedOrigin) : byHand;
  }

  try {
    const routed = await routeDORequest(request, env, {
      bindings: ['SERVER'],
      cors,
      onBeforeRequest: (req, { doInstanceNameOrId }) => requestGuard(req, doInstanceNameOrId, env),
      onBeforeConnect: (req, { doInstanceNameOrId }) => routeGuard(req, doInstanceNameOrId, env.SERVER_INSTANCE, true),
    });
    return routed ?? notFound();
  } catch (error) {
    // A bare `/server`, naming no instance.
    if (error instanceof MissingInstanceNameError) return notFound();
    throw error;
  }
}

// MCP's Streamable HTTP transport requires servers to "validate the Origin header on all
// incoming connections" and answer 403 to one that fails. applyCorsPolicy refuses another
// origin's request with 403 but answers its preflight with 204 and no CORS headers, which a
// browser blocks and any other client reads as success, so that answer becomes 403 too.
function originGuard(request: Request, cors: CorsOptions): Response | undefined {
  const { earlyResponse } = applyCorsPolicy(request, cors);
  if (!earlyResponse) return undefined;
  if (earlyResponse.status === 204 && !earlyResponse.headers.has('Access-Control-Allow-Origin')) {
    return new Response('Forbidden: Origin not allowed', { status: 403 });
  }
  return earlyResponse;
}

// The metadata a client discovers the authorization server by, served without waking A, and
// the authorization server's own endpoints, which A answers.
async function authorizationRoute(request: Request, env: Env): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  const resourceMetadataPaths = ['/.well-known/oauth-protected-resource', new URL(resourceMetadataUrl(env.ORIGIN, env.SERVER_INSTANCE)).pathname];
  if (resourceMetadataPaths.includes(pathname)) {
    return metadataGuard(request) ?? Response.json(protectedResourceMetadata(env.ORIGIN, env.SERVER_INSTANCE));
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    return metadataGuard(request) ?? Response.json(authorizationServerMetadata(env.ORIGIN));
  }
  if (pathname.startsWith('/.well-known/')) return notFound();
  const method = AUTHORIZATION_ROUTES.get(pathname);
  if (!method) return undefined;
  if (request.method !== method) return new Response('Method Not Allowed', { status: 405, headers: { Allow: method } });
  // A's authorization endpoint redirects, and its redirect is for the client to follow.
  return env.SERVER.getByName(env.SERVER_INSTANCE).fetch(new Request(request, { redirect: 'manual' }));
}

function metadataGuard(request: Request): Response | undefined {
  return request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
}

// Routes by the table, then checks the token a route needs and passes its claims on to A.
async function requestGuard(request: Request, instance: string, env: Env): Promise<Response | Request | undefined> {
  const refused = routeGuard(request, instance, env.SERVER_INSTANCE, false);
  if (refused) return refused;
  const path = new URL(request.url).pathname.slice(`/server/${instance}`.length);
  const route = SERVER_ROUTES.find((candidate) => candidate.path.test(path) && candidate.methods !== 'websocket');
  if (!route?.token?.includes(request.method)) return undefined;

  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(env.ORIGIN, env.SERVER_INSTANCE)}"`;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) return unauthorized(challenge, 'A token is required');
  const audience = mcpEndpoint(env.ORIGIN, env.SERVER_INSTANCE);
  const verified = await verifyToken(env.TOKEN_SIGNING_KEY, match[1], audience, Math.floor(Date.now() / 1000));
  if ('error' in verified) return unauthorized(`${challenge}, error="invalid_token", error_description="${verified.error}"`, verified.error);
  const headers = new Headers(request.headers);
  headers.set(CLAIMS_HEADER, JSON.stringify({ sub: verified.claims.sub, epoch: verified.claims.epoch }));
  return new Request(request, { headers });
}

// Decides before any stub is made, so a refused request constructs no Durable Object.
function routeGuard(
  request: Request,
  instance: string,
  allowedInstance: string,
  websocket: boolean,
): Response | undefined {
  if (instance !== allowedInstance) return notFound();
  const root = `/server/${instance}`;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${root}/`)) return notFound();
  const path = pathname.slice(root.length);
  const routes = SERVER_ROUTES.filter((route) => route.path.test(path) && (route.methods === 'websocket') === websocket);
  if (routes.length === 0) return notFound();
  if (websocket) return undefined;
  const methods = routes.flatMap((route) => route.methods as readonly string[]);
  // A path the table lists, asked with a method it does not, as a GET of the MCP endpoint.
  if (!methods.includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: { Allow: methods.join(', ') } });
  return undefined;
}

function withoutClaims(request: Request): Request {
  if (!request.headers.has(CLAIMS_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(CLAIMS_HEADER);
  return new Request(request, { headers });
}

function unauthorized(challenge: string, description: string): Response {
  return Response.json({ error: 'invalid_token', error_description: description }, { status: 401, headers: { 'WWW-Authenticate': challenge } });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
