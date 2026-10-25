// The Worker's edge. It refuses any other origin before an object wakes, and routes only what
// its table lists, by path and method, to the one instance it names. Anything else is 404.
import {
  applyCorsPolicy,
  MissingInstanceNameError,
  routeDORequest,
  type CorsOptions,
} from './vendor/lumenize-routing/route-do-request';

interface Route {
  /** A path under the instance's root, as `/notes/inbox/note-42` under `/server/A`. */
  path: RegExp;
  /** The HTTP methods the route takes, or `websocket` for an upgrade. */
  methods: readonly string[] | 'websocket';
}

/** Every route the edge lets reach A. */
const SERVER_ROUTES: readonly Route[] = [
  { path: /^\/mcp$/, methods: ['POST'] },
  { path: /^\/(notes|lists)(\/.*)?$/, methods: ['GET', 'HEAD', 'PUT', 'DELETE'] },
];

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const cors: CorsOptions = { origin: [env.ORIGIN] };
  const refused = originGuard(request, cors);
  if (refused) return refused;

  try {
    const routed = await routeDORequest(request, env, {
      bindings: ['SERVER'],
      cors,
      onBeforeRequest: (req, { doInstanceNameOrId }) =>
        routeGuard(req, doInstanceNameOrId, env.SERVER_INSTANCE, false),
      onBeforeConnect: (req, { doInstanceNameOrId }) =>
        routeGuard(req, doInstanceNameOrId, env.SERVER_INSTANCE, true),
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
  const listed = SERVER_ROUTES.some(
    (route) =>
      route.path.test(path) &&
      (websocket ? route.methods === 'websocket' : route.methods !== 'websocket' && route.methods.includes(request.method)),
  );
  return listed ? undefined : notFound();
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}
