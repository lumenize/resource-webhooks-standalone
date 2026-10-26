import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../scripts/generate-schemas.mjs');
let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// Runs `generate-schemas.mjs --check` on a copy of src/ whose types may have been edited.
function check(edit: (types: string) => string): { exitCode: number; output: string } {
  scratch = mkdtempSync(join(tmpdir(), 'schema-check-'));
  const files = ['resource-types', 'tool-types', 'events-types', 'resource-webhooks-types'].flatMap((name) => [`${name}.ts`, `${name}.schema.json`]);
  // events-types.ts and resource-webhooks-types.ts take their base types from the spec's schema.ts.
  for (const file of [...files, 'vendor/mcp-spec/2026-07-28/schema.ts']) {
    cpSync(join(import.meta.dirname, '../../src', file), join(scratch, 'src', file));
  }
  const types = join(scratch, 'src/resource-types.ts');
  writeFileSync(types, edit(readFileSync(types, 'utf-8')));
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: scratch, encoding: 'utf-8', stdio: 'pipe' });
    return { exitCode: 0, output };
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: string };
    return { exitCode: status, output: stderr };
  }
}

it('passes on the committed types and schema', () => {
  expect(check((types) => types)).toMatchObject({ exitCode: 0 });
});

it('fails when Note gains a member the committed schema does not have', () => {
  const result = check((types) => types.replace('  due?: string;\n', '  due?: string;\n  priority?: number;\n'));
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('is out of date');
});
