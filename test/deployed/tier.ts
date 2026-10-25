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
    // The instance names in wrangler.jsonc's vars, which a deploy keeps.
    name: 'A',
    gateway: 'B',
    root: `${origin}/server/A`,
    heartbeatMs: 30_000,
    operatorToken: required('DEPLOYED_OPERATOR_TOKEN'),
    send: (request) => fetch(request),
    connect: (url, protocols) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace(/^http/, 'ws'), protocols);
        socket.addEventListener('open', () => resolve(socketOf(socket, socket.protocol ?? '')));
        socket.addEventListener('error', () => reject(new Error(`The upgrade to ${url} failed`)));
      }),
  };
}
