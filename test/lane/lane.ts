// Each test's own A. Storage is shared within a test file, so a test gets an instance name no
// other test uses, given to the Worker through the binding that names the instance it routes.
// B is the file's one gateway, named by GATEWAY_INSTANCE, since A's object reads that name from
// its own env, which a test cannot vary. Each test's clients are its own registrations, so their
// sockets on B never meet another test's.
import { env } from 'cloudflare:workers';
import { createMcpClient, OAuthSession, type McpClient } from '../../src/client/mcp-client';
import worker from '../../src/index';
import { socketOf, type Tier } from '../client/parties';

// Every lane's env, by its A's instance name, so a fetch arriving after its test has ended, as a
// late retry does, still reaches that test's A and never the next one's.
const lanes = new Map<string, Env>();

/** The env of the lane whose A a request names, from its `/server/{name}`, or the file's for B. */
export function laneEnvFor(request: Request): Env {
  const [, binding, name] = new URL(request.url).pathname.split('/');
  if (binding === 'gateway' && name === env.GATEWAY_INSTANCE) return env;
  const laneEnv = binding === 'server' ? lanes.get(name) : undefined;
  if (!laneEnv) throw new Error(`No lane is listening at ${request.url}`);
  return laneEnv;
}

/**
 * Receivers the fetch spy answers with instead of the network, by origin, as
 * `https://fault.example`: a test's stand-in for a callback endpoint that misbehaves.
 */
export const fakeReceivers = new Map<string, (request: Request) => Promise<Response> | Response>();

/** Calls the Worker's real handler with a lane's env, as a request from outside would. */
export function callWorker(request: Request, laneEnv: Env): Promise<Response> {
  // A request made here carries no `cf`, which only Cloudflare's edge sets on an incoming one.
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, laneEnv);
}

/**
 * Opens an upgrade to `url` with `token` as the subprotocol entry, as a browser would send it, and
 * returns the answer, refused or not, since a WebSocket hides a refusal's status.
 */
export function upgrade(laneEnv: Env, url: string, token?: string, headers: Record<string, string> = {}): Promise<Response> {
  const protocols = token === undefined ? 'rw.1' : `rw.1, rw.token.${token}`;
  return callWorker(new Request(url, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols, ...headers } }), laneEnv);
}

/** The lane's tier: its Worker, called in this isolate with the env of the test's own A. */
export interface Lane extends Tier {
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
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `A-${suffix}`;
  const gateway = env.GATEWAY_INSTANCE;
  const laneEnv: Env = { ...env, SERVER_INSTANCE: name };
  lanes.set(name, laneEnv);
  const root = `${env.ORIGIN}/server/${name}`;
  const send = (input: RequestInfo | URL, init?: RequestInit) => callWorker(new Request(input, init), laneEnv);
  const endpoint = `${root}/mcp`;
  const session = new OAuthSession({ redirectUri: `${env.ORIGIN}/callback`, clientName: `lane ${name}`, fetch: send });
  const token = () => session.tokenFor(endpoint);
  return {
    origin: env.ORIGIN,
    name,
    gateway,
    root,
    heartbeatMs: Number(env.HEARTBEAT_MS),
    operatorToken: env.OPERATOR_TOKEN,
    send: (request) => callWorker(request, laneEnv),
    async connect(url, protocols) {
      const headers: Record<string, string> = { Upgrade: 'websocket' };
      if (protocols.length > 0) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
      const response = await callWorker(new Request(url, { headers }), laneEnv);
      if (response.status !== 101) throw new Error(`The upgrade to ${url} answered ${response.status}`);
      const socket = response.webSocket!;
      socket.accept();
      return socketOf(socket, () => response.headers.get('Sec-WebSocket-Protocol') ?? '');
    },
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
