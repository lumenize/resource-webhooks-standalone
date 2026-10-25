// The Worker's edge. It refuses any other origin before an object wakes, checks A's tokens, and
// routes only what its table lists, by path and method, to the one instance it names. A path it
// does not list is 404, and a method it does not list for a path it does is 405.
import { mcpEndpoint, authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl } from './auth/metadata';
import { verifyToken } from './auth/signing';
import { readCapped } from './read-capped';
import {
  addCorsHeaders,
  applyCorsPolicy,
  MissingInstanceNameError,
  routeDORequest,
  type CorsOptions,
} from './vendor/lumenize-routing/route-do-request';

/**
 * The header the edge sets to the claims of a token it verified, as
 * `{"sub":"…","epoch":0,"exp":1761400000}`, and strips from every request, so no caller can set it.
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
  // The page's back channel, outside both SEPs. Its reports are open, and its controls carry the
  // operator token in the message.
  { path: /^\/page$/, methods: 'websocket' },
];

/** Every route the edge lets reach B. A delivery's signature is B's to check, not the edge's. */
const GATEWAY_ROUTES: readonly Route[] = [
  { path: /^\/hooks\/[^/]+$/, methods: ['POST'] },
  { path: /^\/ws\/[^/]+$/, methods: 'websocket' },
  { path: /^\/page$/, methods: 'websocket' },
];

/** The subprotocol a client's socket on B speaks. Its token rides beside it, as `rw.token.<token>`. */
const SUBPROTOCOL = 'rw.1';
const TOKEN_SUBPROTOCOL = 'rw.token.';

/** The largest body the authorization server's routes take, far more than any of them needs. */
const AUTHORIZATION_BODY_CAP = 16 * 1024;

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
      bindings: ['SERVER', 'GATEWAY'],
      cors,
      onBeforeRequest: (req, { doInstanceNameOrId }) =>
        isGateway(req)
          ? routeGuard(req, doInstanceNameOrId, env.GATEWAY_INSTANCE, false, '/gateway', GATEWAY_ROUTES)
          : requestGuard(req, doInstanceNameOrId, env),
      onBeforeConnect: (req, { doInstanceNameOrId }) =>
        isGateway(req)
          ? socketGuard(req, doInstanceNameOrId, env)
          : routeGuard(req, doInstanceNameOrId, env.SERVER_INSTANCE, true, '/server', SERVER_ROUTES),
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
  // A parses these bodies, so a large one is refused before it wakes A.
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  let body: ArrayBuffer | undefined;
  if (method === 'POST') {
    const bytes = declared > AUTHORIZATION_BODY_CAP ? undefined : await readCapped(request.body, AUTHORIZATION_BODY_CAP);
    if (!bytes) return new Response('Content Too Large', { status: 413 });
    body = bytes.slice().buffer;
  }
  // A's authorization endpoint redirects, and its redirect is for the client to follow.
  return env.SERVER.getByName(env.SERVER_INSTANCE).fetch(new Request(request, { redirect: 'manual', body }));
}

function metadataGuard(request: Request): Response | undefined {
  return request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
}

function isGateway(request: Request): boolean {
  return new URL(request.url).pathname.startsWith('/gateway/');
}

// Routes by the table, then checks the token a route needs and passes its claims on to A.
async function requestGuard(request: Request, instance: string, env: Env): Promise<Response | Request | undefined> {
  const refused = routeGuard(request, instance, env.SERVER_INSTANCE, false, '/server', SERVER_ROUTES);
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
  return withClaims(request, verified.claims);
}

// A client's socket on B needs a token whose audience is that socket's own URL and whose subject
// is the client the path names. A browser cannot set Authorization on an upgrade, and a query
// string would reach logs, so the token rides as a subprotocol entry beside SUBPROTOCOL.
async function socketGuard(request: Request, instance: string, env: Env): Promise<Response | Request | undefined> {
  const refused = routeGuard(request, instance, env.GATEWAY_INSTANCE, true, '/gateway', GATEWAY_ROUTES);
  if (refused) return refused;
  const { pathname } = new URL(request.url);
  const client = /^\/gateway\/[^/]+\/ws\/([^/]+)$/.exec(pathname)?.[1];
  if (!client) return undefined;
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((entry) => entry.trim());
  const token = protocols.find((entry) => entry.startsWith(TOKEN_SUBPROTOCOL))?.slice(TOKEN_SUBPROTOCOL.length);
  if (!token || !protocols.includes(SUBPROTOCOL)) return new Response('Unauthorized: a token is required', { status: 401 });
  const audience = `${env.ORIGIN}${pathname}`;
  const verified = await verifyToken(env.TOKEN_SIGNING_KEY, token, audience, Math.floor(Date.now() / 1000));
  if ('error' in verified) return new Response(`Unauthorized: ${verified.error}`, { status: 401 });
  // A client id is URL-safe, so the path names it as it is, and an encoded one names no client.
  if (verified.claims.sub !== client) return new Response('Unauthorized: the token is for another client', { status: 401 });
  return withClaims(request, verified.claims);
}

function withClaims(request: Request, claims: { sub: string; epoch: number; exp: number }): Request {
  const headers = new Headers(request.headers);
  headers.set(CLAIMS_HEADER, JSON.stringify({ sub: claims.sub, epoch: claims.epoch, exp: claims.exp }));
  return new Request(request, { headers });
}

// Decides before any stub is made, so a refused request constructs no Durable Object.
function routeGuard(
  request: Request,
  instance: string,
  allowedInstance: string,
  websocket: boolean,
  base: '/server' | '/gateway',
  table: readonly Route[],
): Response | undefined {
  if (instance !== allowedInstance) return notFound();
  const root = `${base}/${instance}`;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${root}/`)) return notFound();
  const path = pathname.slice(root.length);
  const routes = table.filter((route) => route.path.test(path) && (route.methods === 'websocket') === websocket);
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
