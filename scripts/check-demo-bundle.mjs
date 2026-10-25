#!/usr/bin/env node
// Fails when the conformance build's machinery reaches the demo's Worker: CONFORMANCE in its
// config, or the conformance module's bypass or fixtures in the bundle wrangler would deploy,
// found by their strings and by the path comment esbuild writes above each module it bundles.
// With --config it checks another config, which is how its own test shows it can fail.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configIndex = process.argv.indexOf('--config');
const config = configIndex === -1 ? 'wrangler.jsonc' : process.argv[configIndex + 1];
const FORBIDDEN = ['CONFORMANCE', 'test_simple_text', '// src/conformance/'];
const found = [];

const configText = readFileSync(config, 'utf-8');
for (const marker of FORBIDDEN) if (configText.includes(marker)) found.push(`${config} contains ${marker}`);

const out = mkdtempSync(join(tmpdir(), 'demo-bundle-'));
try {
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '-c', config, '--outdir', out], { stdio: 'pipe' });
  const files = readdirSync(out, { recursive: true }).filter((file) => String(file).endsWith('.js'));
  if (files.length === 0) throw new Error(`wrangler wrote no bundle to ${out}`);
  for (const file of files) {
    const text = readFileSync(join(out, String(file)), 'utf-8');
    for (const marker of FORBIDDEN) if (text.includes(marker)) found.push(`the bundle's ${file} contains ${marker}`);
  }
  console.log(`checked ${config} and ${files.length} bundle file(s) for ${FORBIDDEN.join(', ')}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (found.length > 0) {
  console.error(found.join('\n'));
  process.exit(1);
}
