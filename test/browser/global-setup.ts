// The browser lane's Worker: `wrangler dev` over https, so the page is where production serves it,
// at the origin the Worker allows, and A's webhook POST to its own origin goes out over TLS. The
// certificate comes from mkcert's local CA, kept in the repo's gitignored .certs folder and never
// installed in the system's trust store. Workerd trusts it through NODE_EXTRA_CA_CERTS, and
// Chromium is told to accept it. The Worker serves a copy of the assets with the page's script
// compiled into it, since another lane's build of the page empties public/js before it compiles.
// A control server on another port restarts wrangler dev on the same port and storage, as a
// redeploy or a runtime reset would, so a test can watch the page reconnect.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    origin: string;
    operatorToken: string;
    heartbeatMs: number;
    /** A URL whose POST restarts the Worker and answers once it is ready again. */
    restartUrl: string;
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
let control: Server | undefined;
let scratch: string | undefined;

// Stops wrangler dev's process group, and answers once it has exited.
function stopDev(): Promise<void> {
  const running = dev;
  dev = undefined;
  if (!running?.pid || running.exitCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()));
  try {
    process.kill(-running.pid, 'SIGTERM');
  } catch {
    // The group has exited already.
  }
  return exited;
}

function stop(): void {
  void stopDev();
  control?.close();
  control = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
}

// Starts wrangler dev in a process group of its own, so stopping it stops workerd with it, and
// answers once it serves `origin`.
async function startDev(args: string[], origin: string): Promise<void> {
  const started = spawn(join(ROOT, 'node_modules/.bin/wrangler'), args, { cwd: ROOT, detached: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: join(CA, 'rootCA.pem') } });
  dev = started;
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
    started.stdout!.on('data', read);
    started.stderr!.on('data', read);
    started.once('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${log}`)));
  });
}

export default async function setup(project: TestProject): Promise<() => void> {
  if (!existsSync(chromium.executablePath())) throw new Error("The browser lane needs Playwright's Chromium: npx playwright install chromium");
  certificates();
  process.once('exit', stop);
  try {
    return await start(project);
  } catch (error) {
    stop();
    throw error;
  }
}

async function start(project: TestProject): Promise<() => void> {
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const operatorToken = randomUUID();
  scratch = mkdtempSync(join(tmpdir(), 'browser-lane-'));
  const storage = join(scratch, 'storage');
  const assets = join(scratch, 'assets');
  cpSync(join(ROOT, 'public'), assets, { recursive: true, filter: (source) => !source.startsWith(join(ROOT, 'public', 'js')) });
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.page.json', '--outDir', join(assets, 'js')], { cwd: ROOT, stdio: 'pipe' });
  const vars = {
    ORIGIN: origin,
    TOKEN_SIGNING_KEY: `${randomUUID()}${randomUUID()}`,
    SUBSCRIPTION_ID_KEY: `${randomUUID()}${randomUUID()}`,
    OPERATOR_TOKEN: operatorToken,
    HEARTBEAT_MS: String(HEARTBEAT_MS),
  };
  const args = ['dev', '--port', String(port), '--local-protocol', 'https', '--https-key-path', KEY, '--https-cert-path', CERT, '--persist-to', storage, '--assets', assets];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  await startDev(args, origin);

  const controlPort = await freePort();
  control = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/restart') return void response.writeHead(404).end();
    stopDev()
      .then(() => startDev(args, origin))
      .then(
        () => response.writeHead(204).end(),
        (error: unknown) => response.writeHead(500).end(String(error)),
      );
  });
  await new Promise<void>((resolve) => control!.listen(controlPort, '127.0.0.1', resolve));

  project.provide('origin', origin);
  project.provide('operatorToken', operatorToken);
  project.provide('heartbeatMs', HEARTBEAT_MS);
  project.provide('restartUrl', `http://127.0.0.1:${controlPort}/restart`);
  return stop;
}
