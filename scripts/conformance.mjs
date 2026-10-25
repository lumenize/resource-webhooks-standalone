#!/usr/bin/env node
// Runs the MCP conformance suite against A, locally: it starts the conformance build under
// `wrangler dev` with CONFORMANCE set on the command line and fresh storage, runs the suite's
// 2026-07-28 requirement set with this repo's baseline, and exits with the suite's own code.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8788;
const URL_ = `http://localhost:${PORT}/server/A/mcp`;
const SUITE = '@modelcontextprotocol/conformance@0.2.0-alpha.12';
const passthrough = process.argv.slice(2);

const storage = mkdtempSync(join(tmpdir(), 'conformance-'));
const dev = spawn(
  'npx',
  ['wrangler', 'dev', '-c', 'wrangler.conformance.jsonc', '--port', String(PORT), '--var', 'CONFORMANCE:on', '--persist-to', storage],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let devLog = '';
dev.stdout.on('data', (chunk) => (devLog += chunk));
dev.stderr.on('data', (chunk) => (devLog += chunk));

function stop() {
  dev.kill('SIGTERM');
  rmSync(storage, { recursive: true, force: true });
}

try {
  const ready = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      break;
    } catch {
      if (Date.now() > ready) throw new Error(`wrangler dev did not start:\n${devLog}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const args = ['--yes', SUITE, 'server', '--url', URL_, '--requirements', '2026-07-28', '--expected-failures', './conformance-baseline.yml', ...passthrough];
  const suite = spawn('npx', args, { stdio: 'inherit' });
  const code = await new Promise((resolve) => suite.on('exit', resolve));
  stop();
  process.exit(code ?? 1);
} catch (error) {
  stop();
  console.error(error);
  process.exit(1);
}
