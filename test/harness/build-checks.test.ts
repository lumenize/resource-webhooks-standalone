// Checks on the source and the bundle that no test inside the Worker can make.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

function run(script: string, ...args: string[]): { exitCode: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    return { exitCode: 0, output };
  } catch (error) {
    const { status, stdout, stderr } = error as { status: number; stdout: string; stderr: string };
    return { exitCode: status, output: `${stdout}${stderr}` };
  }
}

describe("the demo's Worker", () => {
  it('carries no conformance machinery in its config or its bundle', () => {
    const result = run('scripts/check-demo-bundle.mjs');
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain('checked wrangler.jsonc and 1 bundle file(s)');
  });

  it('is told apart from the conformance build, which the same check fails', () => {
    const result = run('scripts/check-demo-bundle.mjs', '--config', 'wrangler.conformance.jsonc');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("the bundle's index.js contains test_simple_text");
  });
});

// A role module takes parsed messages and its host's `sql`, so a Lumenize node can compose it.
// It must not reach for the platform a Durable Object gives it.
const PLATFORM = [/\bRequest\b/, /\bResponse\b/, /\bWebSocket\b/, /\bDurableObjectState\b/, /cloudflare:workers/, /(?<![.\w])fetch\s*\(/];

function platformUses(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf-8');
  return PLATFORM.filter((pattern) => pattern.test(text)).map(String);
}

describe("A's role module", () => {
  it("touches none of the platform's request, socket or object types", () => {
    const files = readdirSync(join(ROOT, 'src/server-role')).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    expect(Object.fromEntries(files.map((file) => [file, platformUses(`src/server-role/${file}`)]))).toEqual(
      Object.fromEntries(files.map((file) => [file, []])),
    );
  });

  it('is checked by patterns that do find the platform in the transport around it', () => {
    expect(platformUses('src/server.ts')).toEqual(expect.arrayContaining([String(/\bRequest\b/), String(/cloudflare:workers/)]));
    expect(platformUses('src/mcp-http.ts')).toEqual(expect.arrayContaining([String(/\bResponse\b/)]));
  });
});
