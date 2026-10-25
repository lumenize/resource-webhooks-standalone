// Each test's own A. Storage is shared within a test file, so a test gets an instance name no
// other test uses, given to the Worker through the binding that names the instance it routes.
import { env } from 'cloudflare:workers';
import { createMcpClient, OAuthSession, type McpClient } from '../../src/client/mcp-client';
import worker from '../../src/index';

// Every lane's env, by A's instance name, so a fetch arriving after its test has ended still
// reaches that test's A and never the next one's.
const lanes = new Map<string, Env>();

/** The env of the lane whose A a request names, from its `/server/{name}` segment. */
export function laneEnvFor(request: Request): Env {
  const [, binding, name] = new URL(request.url).pathname.split('/');
  const laneEnv = binding === 'server' ? lanes.get(name) : undefined;
  if (!laneEnv) throw new Error(`No lane is listening at ${request.url}`);
  return laneEnv;
}

/** Calls the Worker's real handler with a lane's env, as a request from outside would. */
export function callWorker(request: Request, laneEnv: Env): Promise<Response> {
  // A request made here carries no `cf`, which only Cloudflare's edge sets on an incoming one.
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, laneEnv);
}

export interface Lane {
  /** A's instance name in this test, as `A-1f2e3d4c`. */
  name: string;
  /** A's own URI, as `https://….workers.dev/server/A-1f2e3d4c`. */
  root: string;
  env: Env;
  stub: DurableObjectStub<import('../../src/index').Server>;
  /**
   * Requests `path` under A's root, as `/notes/inbox/note-42`, with the lane's token when the
   * method needs one and the request carries no Authorization of its own.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** An MCP client of A's endpoint, `{root}/mcp`, signed in as this lane's own client. */
  client: McpClient;
  /** The lane's OAuth session, registered with A's authorization server as its own client. */
  session: OAuthSession;
  /** A token for A's MCP endpoint, got through the real flow on first use. */
  token(): Promise<string>;
}

export function newLane(): Lane {
  const name = `A-${crypto.randomUUID().slice(0, 8)}`;
  const laneEnv: Env = { ...env, SERVER_INSTANCE: name };
  lanes.set(name, laneEnv);
  const root = `${env.ORIGIN}/server/${name}`;
  const send = (input: RequestInfo | URL, init?: RequestInit) => callWorker(new Request(input, init), laneEnv);
  const endpoint = `${root}/mcp`;
  const session = new OAuthSession({ redirectUri: `${env.ORIGIN}/callback`, clientName: `lane ${name}`, fetch: send });
  const token = () => session.tokenFor(endpoint);
  return {
    name,
    root,
    env: laneEnv,
    stub: env.SERVER.getByName(name),
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if ((init.method === 'PUT' || init.method === 'DELETE') && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${await token()}`);
      return send(`${root}${path}`, { ...init, headers });
    },
    client: createMcpClient({ endpoint, clientInfo: { name: 'lane', version: '0.0.0' }, oauth: session, fetch: send }),
    session,
    token,
  };
}
