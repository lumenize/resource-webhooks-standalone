#!/usr/bin/env node
// Runs the MCP conformance suite against A, locally: it starts the conformance build under
// `wrangler dev` with CONFORMANCE set on the command line and fresh storage, runs the suite's
// 2026-07-28 requirement set with this repo's baseline, and exits with the suite's own code.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8788;
const URL_ = `http://localhost:${PORT}/server/A/mcp`;
const SUITE = '@modelcontextprotocol/conformance@0.2.0-alpha.12';
const passthrough = process.argv.slice(2);

async function listening() {
  try {
    await fetch(`http://localhost:${PORT}/`);
    return true;
  } catch {
    return false;
  }
}

// Something already on the port would be graded in A's place.
if (await listening()) {
  console.error(`Port ${PORT} is already in use, so the suite would not be testing this build`);
  process.exit(1);
}

const storage = mkdtempSync(join(tmpdir(), 'conformance-'));
// Its own process group, so stopping it stops workerd too.
const dev = spawn(
  'node_modules/.bin/wrangler',
  ['dev', '-c', 'wrangler.conformance.jsonc', '--port', String(PORT), '--var', 'CONFORMANCE:on', '--var', `TOKEN_SIGNING_KEY:${randomUUID()}${randomUUID()}`, '--persist-to', storage],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let devLog = '';
let devExited = false;
dev.stdout.on('data', (chunk) => (devLog += chunk));
dev.stderr.on('data', (chunk) => (devLog += chunk));
dev.on('exit', () => (devExited = true));

function stop() {
  if (!devExited) process.kill(-dev.pid, 'SIGTERM');
  rmSync(storage, { recursive: true, force: true });
}

try {
  const ready = Date.now() + 60_000;
  while (!(await listening())) {
    if (devExited || Date.now() > ready) throw new Error(`wrangler dev did not start:\n${devLog}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const args = ['--yes', SUITE, 'server', '--url', URL_, '--requirements', '2026-07-28', '--expected-failures', './conformance-baseline.yml', ...passthrough];
  const suite = spawn('npx', args, { stdio: 'inherit' });
  const code = await new Promise((resolve) => suite.on('exit', resolve));
  if (devExited) throw new Error(`wrangler dev exited during the run:\n${devLog}`);
  stop();
  process.exit(code ?? 1);
} catch (error) {
  stop();
  console.error(error);
  process.exit(1);
}
