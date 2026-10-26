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
    expect(result.output).toContain("the bundle's index.js contains // src/conformance/");
  });

  it('never has CONFORMANCE set by a config file, the conformance build\'s own included', () => {
    for (const file of ['wrangler.jsonc', 'wrangler.conformance.jsonc']) {
      // JSONC: drop each line's comment before parsing.
      const config = JSON.parse(readFileSync(join(ROOT, file), 'utf-8').replace(/^\s*\/\/.*$/gm, '')) as { vars?: object };
      const names = Object.keys(config.vars ?? {});
      expect(names.length).toBeGreaterThan(0);
      expect({ file, conformance: names.includes('CONFORMANCE') }).toEqual({ file, conformance: false });
    }
    expect(readFileSync(join(ROOT, '.dev.vars.example'), 'utf-8')).not.toMatch(/^\s*CONFORMANCE\s*=/m);
  });
});

// A role module takes parsed messages and its host's `sql`, so a Lumenize node can compose it.
// It must not reach for the platform a Durable Object gives it.
const PLATFORM = [
  /\bRequest\b/,
  /\bResponse\b/,
  /\bWebSocket\b/,
  /\bDurableObjectState\b/,
  /cloudflare:workers/,
  /(?<![.\w])fetch\s*\(/,
  /\b(globalThis|self)\.fetch\b/,
];

// What a role module may import, so it cannot reach the platform through another module.
const ROLE_IMPORTS = [
  /^\.\/[\w-]+$/,
  /^\.\.\/(json-rpc|tool-types|resource-types|events-types|resource-webhooks-types|standard-webhooks)$/,
  /^\.\.\/[\w-]+\.schema\.json$/,
  /^\.\.\/vendor\/mcp-spec\//,
  /^@cfworker\/json-schema$/,
];
const ROLE_DIRECTORIES = ['src/server-role', 'src/gateway-role'];

function roleFiles(): string[] {
  return ROLE_DIRECTORIES.flatMap((directory) => readdirSync(join(ROOT, directory)).filter((file) => file.endsWith('.ts')).map((file) => `${directory}/${file}`));
}

function importsOf(file: string): string[] {
  return [...readFileSync(join(ROOT, file), 'utf-8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}

function platformUses(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf-8');
  return PLATFORM.filter((pattern) => pattern.test(text)).map(String);
}

describe("A's and B's role modules", () => {
  it("touch none of the platform's request, socket or object types", () => {
    const files = roleFiles();
    expect(files).toEqual(expect.arrayContaining(['src/server-role/server-role.ts', 'src/gateway-role/gateway-role.ts']));
    expect(Object.fromEntries(files.map((file) => [file, platformUses(file)]))).toEqual(Object.fromEntries(files.map((file) => [file, []])));
  });

  it('import only other role modules, the JSON-RPC core, Standard Webhooks, the types and their schemas', () => {
    const stray = roleFiles().flatMap((file) => importsOf(file).filter((spec) => !ROLE_IMPORTS.some((allowed) => allowed.test(spec))).map((spec) => `${file}: ${spec}`));
    expect(stray).toEqual([]);
    // The same rule finds the transport's own imports, which reach the platform.
    expect(importsOf('src/server.ts').filter((spec) => !ROLE_IMPORTS.some((allowed) => allowed.test(spec)))).toContain('cloudflare:workers');
  });

  it('is checked by patterns that do find the platform in the transport around it', () => {
    expect(platformUses('src/server.ts')).toEqual(expect.arrayContaining([String(/\bRequest\b/), String(/cloudflare:workers/)]));
    expect(platformUses('src/mcp-http.ts')).toEqual(expect.arrayContaining([String(/\bResponse\b/)]));
  });
});

describe('the client modules', () => {
  // scripts/conformance-client.mjs runs them in Node with their types stripped, which refuses
  // what only TypeScript compiles, such as a parameter property.
  it.each(['src/client/mcp-client.ts', 'src/client/copies.ts', 'src/standard-webhooks.ts'])('%s loads in Node with its types stripped', (file) => {
    const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(process.cwd(), file))}); console.log('loaded')`], { encoding: 'utf8' });
    expect(loaded.trim()).toBe('loaded');
  });
});
