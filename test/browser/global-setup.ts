// The browser lane's Worker: `wrangler dev` over https, so the page is where production serves it,
// at the origin the Worker allows, and A's webhook POST to its own origin goes out over TLS. The
// certificate comes from mkcert's local CA, kept in the repo's gitignored .certs folder and never
// installed in the system's trust store. Workerd trusts it through NODE_EXTRA_CA_CERTS, and
// Chromium is told to accept it.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    origin: string;
    operatorToken: string;
    heartbeatMs: number;
  }
}

const ROOT = join(import.meta.dirname, '../..');
const CERTS = join(ROOT, '.certs');
const CA = join(CERTS, 'ca');
const CERT = join(CERTS, 'localhost.pem');
const KEY = join(CERTS, 'localhost-key.pem');
// Short, so a test sees b's socket go quiet within a second.
const HEARTBEAT_MS = 500;

function certificates(): void {
  if (existsSync(CERT) && existsSync(KEY) && existsSync(join(CA, 'rootCA.pem'))) return;
  mkdirSync(CA, { recursive: true });
  try {
    execFileSync('mkcert', ['-cert-file', CERT, '-key-file', KEY, 'localhost', '127.0.0.1'], { env: { ...process.env, CAROOT: CA }, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`The browser lane needs mkcert for its certificate (brew install mkcert): ${String(error)}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

let dev: ChildProcess | undefined;
let storage: string | undefined;

export default async function setup(project: TestProject): Promise<() => void> {
  certificates();
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const operatorToken = randomUUID();
  storage = mkdtempSync(join(tmpdir(), 'browser-lane-'));
  const vars = {
    ORIGIN: origin,
    TOKEN_SIGNING_KEY: `${randomUUID()}${randomUUID()}`,
    SUBSCRIPTION_ID_KEY: `${randomUUID()}${randomUUID()}`,
    OPERATOR_TOKEN: operatorToken,
    HEARTBEAT_MS: String(HEARTBEAT_MS),
  };
  const args = ['dev', '--port', String(port), '--local-protocol', 'https', '--https-key-path', KEY, '--https-cert-path', CERT, '--persist-to', storage];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  // Its own process group, so the teardown stops workerd with it.
  dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'), args, { cwd: ROOT, detached: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(CA, 'rootCA.pem') } });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${log}`)), 60_000);
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes(`Ready on ${origin}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    dev!.stdout!.on('data', read);
    dev!.stderr!.on('data', read);
    dev!.on('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${log}`)));
  });
  project.provide('origin', origin);
  project.provide('operatorToken', operatorToken);
  project.provide('heartbeatMs', HEARTBEAT_MS);
  return () => {
    if (dev?.pid) process.kill(-dev.pid, 'SIGTERM');
    if (storage) rmSync(storage, { recursive: true, force: true });
  };
}
