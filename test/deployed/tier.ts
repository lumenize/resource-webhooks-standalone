// The deployed tier: a Worker on Cloudflare, reached over the network with Node's own fetch and
// WebSocket. `scripts/deployed.mjs` deploys it and sets what this reads.
import { socketOf, type Tier } from '../client/parties';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the deployed tier through scripts/deployed.mjs`);
  return value;
}

export function deployedTier(): Tier {
  const origin = required('DEPLOYED_ORIGIN');
  return {
    origin,
    name: required('DEPLOYED_SERVER_INSTANCE'),
    gateway: required('DEPLOYED_GATEWAY_INSTANCE'),
    root: `${origin}/server/${required('DEPLOYED_SERVER_INSTANCE')}`,
    heartbeatMs: Number(required('DEPLOYED_HEARTBEAT_MS')),
    operatorToken: required('DEPLOYED_OPERATOR_TOKEN'),
    // Whatever the request asked, a redirect comes back to the caller, as the lane's does.
    send: (request) => fetch(new Request(request, { redirect: 'manual' })),
    connect: (url, protocols) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace(/^http/, 'ws'), protocols);
        const wrapped = socketOf(socket, () => socket.protocol ?? '');
        socket.addEventListener('open', () => resolve(wrapped));
        socket.addEventListener('error', () => reject(new Error(`The upgrade to ${url} failed`)));
      }),
  };
}
