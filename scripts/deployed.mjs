#!/usr/bin/env node
// Deploys the test-* Worker, with real tokens and no conformance bypass, waits until A and B run
// the new version, and runs the deployed tier's tests against it through the same client the lane
// uses. Its secrets live in
// `.deployed.vars`, gitignored, made on first use. `--no-deploy` runs the tests against what is
// deployed, `--name` and `--config` deploy a variant beside it, and anything after `--` goes to
// vitest.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
};
const passthrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
const name = option('--name', 'test-resource-webhooks-standalone');
const config = option('--config', 'wrangler.jsonc');
const origin = `https://${name}.transformation.workers.dev`;
const SECRETS = '.deployed.vars';
// Thirty seconds apart, since an object that keeps getting requests a few seconds apart kept
// answering on the previous version for five minutes, where one asked every 30 s switched by 31 s.
const POLL_MS = Number(option('--poll-ms', '30000'));

if (!existsSync(SECRETS)) {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(SECRETS, `TOKEN_SIGNING_KEY=${secret()}\nSUBSCRIPTION_ID_KEY=${secret()}\nOPERATOR_TOKEN=${secret()}\n`, { mode: 0o600 });
}
const secrets = Object.fromEntries(
  readFileSync(SECRETS, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The version id a page socket's greeting names, or undefined if none comes within ten seconds.
function greeting(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve(undefined);
    }, 10_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.kind !== 'hello') return;
      clearTimeout(timer);
      socket.close();
      resolve(message.version);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

// Cloudflare releases a deploy to Durable Objects eventually, so an object can run the previous
// version for minutes after it, and a run before then would test the wrong code.
async function untilRunning(version) {
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  for (const path of ['/server/A/page', '/gateway/B/page']) {
    for (let seen = await greeting(`${origin.replace(/^http/, 'ws')}${path}`); seen !== version; seen = await greeting(`${origin.replace(/^http/, 'ws')}${path}`)) {
      if (Date.now() > deadline) {
        console.error(`${path} still runs ${seen} rather than ${version}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    console.log(`${path} runs ${version} after ${Math.round((Date.now() - started) / 1000)} s`);
  }
}

if (!args.includes('--no-deploy')) {
  const deployed = spawnSync('node_modules/.bin/wrangler', ['deploy', '-c', config, '--name', name, '--var', `ORIGIN:${origin}`, '--secrets-file', SECRETS], { encoding: 'utf8' });
  process.stdout.write(deployed.stdout);
  process.stderr.write(deployed.stderr);
  if (deployed.status !== 0) process.exit(deployed.status ?? 1);
  const version = /Current Version ID: ([0-9a-f-]+)/.exec(deployed.stdout)?.[1];
  if (!version) {
    console.error('The deploy named no version');
    process.exit(1);
  }
  await untilRunning(version);
  console.log(`A and B run ${version}`);
}
run('node_modules/.bin/vitest', ['run', '--project', 'deployed', ...passthrough], { ...process.env, DEPLOYED_ORIGIN: origin, DEPLOYED_OPERATOR_TOKEN: secrets.OPERATOR_TOKEN });
