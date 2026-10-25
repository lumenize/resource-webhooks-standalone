#!/usr/bin/env node
// Deploys the test-* Worker, with real tokens and no conformance bypass, waits until A and B run
// the deployed version, and runs the deployed tier's tests against it through the same client the
// lane uses. Its secrets live in `.deployed.vars`, gitignored, made on the first deploy.
//
//   --no-deploy               test what is deployed, once A and B run its current version
//   --without-strict-public   deploy a variant without global_fetch_strictly_public, beside it
//   --name <worker>           deploy under another test-* name
//   --poll-ms <ms>            how often to ask A and B their version, 30000 by default
//   -- <vitest arguments>     which deployed tests to run, all of them by default
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
};
const passthrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
const deploying = !args.includes('--no-deploy');
const strictPublic = !args.includes('--without-strict-public');
const name = option('--name', strictPublic ? 'test-resource-webhooks-standalone' : 'test-resource-webhooks-noflag');
// Thirty seconds apart, since an object that kept getting requests five seconds apart answered on
// the previous version for five minutes, where one asked every 30 s switched by 31 s.
const POLL_MS = Number(option('--poll-ms', '30000'));
const SECRETS = '.deployed.vars';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!name.startsWith('test-')) fail(`${name} is not a test-* Worker`);

// wrangler.jsonc without its comments, read only for its vars.
function jsonc(text) {
  let out = '';
  for (let i = 0, inString = false; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const configText = readFileSync('wrangler.jsonc', 'utf8');
const { vars } = jsonc(configText);
// The account's workers.dev subdomain, from the demo's own origin, as `transformation.workers.dev`.
const subdomain = new URL(vars.ORIGIN).host.split('.').slice(1).join('.');
const origin = `https://${name}.${subdomain}`;

if (!existsSync(SECRETS)) {
  if (!deploying) fail(`${SECRETS} is missing, so the deployed Worker's operator token is unknown: deploy first`);
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

function captured(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) fail(`${command} ${commandArgs[0]} failed`);
  return result.stdout ?? '';
}

// The version id a page socket's greeting names, or undefined if none comes within ten seconds.
function greeting(url) {
  return new Promise((done) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      done(undefined);
    }, 10_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.kind !== 'hello') return;
      clearTimeout(timer);
      socket.close();
      done(message.version);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
  });
}

// Cloudflare releases a deploy to Durable Objects eventually, so an object can run the previous
// version for minutes after it, and a run before then would test the wrong code.
async function untilRunning(version) {
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  const pages = [`/server/${vars.SERVER_INSTANCE}/page`, `/gateway/${vars.GATEWAY_INSTANCE}/page`];
  for (const path of pages) {
    const url = `${origin.replace(/^http/, 'ws')}${path}`;
    for (let seen = await greeting(url); seen !== version; seen = await greeting(url)) {
      if (Date.now() > deadline) fail(`${path} still runs ${seen} rather than ${version}`);
      await new Promise((wait) => setTimeout(wait, POLL_MS));
    }
    console.log(`${path} runs ${version}, ${Math.round((Date.now() - started) / 1000)} s after the wait began`);
  }
}

let version;
if (deploying) {
  let config = 'wrangler.jsonc';
  let scratch;
  if (!strictPublic) {
    // The same Worker without the flag, from a config of its own whose paths point back here.
    scratch = mkdtempSync(join(tmpdir(), 'deployed-'));
    config = join(scratch, 'wrangler.jsonc');
    const variant = configText
      .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(resolve('src/index.ts'))}`)
      .replace('"directory": "./public"', `"directory": ${JSON.stringify(resolve('public'))}`)
      .replace('"$schema": "./node_modules/wrangler/config-schema.json",', '')
      .replace('"compatibility_flags": ["global_fetch_strictly_public"]', '"compatibility_flags": []');
    if (variant.includes('global_fetch_strictly_public"]')) fail('The variant config still sets the flag');
    writeFileSync(config, variant);
  }
  try {
    // The demo's bundle, never the conformance build's.
    run('node', ['scripts/check-demo-bundle.mjs', '--config', config]);
    const deployed = captured('node_modules/.bin/wrangler', ['deploy', '-c', config, '--name', name, '--var', `ORIGIN:${origin}`, '--secrets-file', SECRETS]);
    version = /Current Version ID: ([0-9a-f-]+)/.exec(deployed)?.[1];
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  if (!version) fail('The deploy named no version');
} else {
  const status = captured('node_modules/.bin/wrangler', ['deployments', 'status', '--name', name]);
  version = /\(100%\) ([0-9a-f-]+)/.exec(status)?.[1];
  if (!version) fail(`${name} has no version deployed to all its traffic`);
}
await untilRunning(version);

run('node_modules/.bin/vitest', ['run', '--project', 'deployed', ...passthrough], {
  ...process.env,
  DEPLOYED_ORIGIN: origin,
  DEPLOYED_SERVER_INSTANCE: vars.SERVER_INSTANCE,
  DEPLOYED_GATEWAY_INSTANCE: vars.GATEWAY_INSTANCE,
  DEPLOYED_HEARTBEAT_MS: vars.HEARTBEAT_MS,
  DEPLOYED_OPERATOR_TOKEN: secrets.OPERATOR_TOKEN,
});
