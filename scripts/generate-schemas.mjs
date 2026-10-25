#!/usr/bin/env node
// Generates JSON Schema for the types in src/resource-types.ts, the way the MCP spec generates
// schema.json from schema.ts: typescript-json-schema with the spec's flags, then the spec's
// rewrite to JSON Schema 2020-12. With --check it compares instead of writing, and exits 1 when
// the committed schema is stale, as the spec's `generate-schemas.ts --check` does.
// Adapted from that script at the spec's commit dae694f6, as ATTRIBUTIONS.md lists.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Paths are relative to the working directory, and the generator is this repo's own.
const SOURCE = 'src/resource-types.ts';
const TARGET = 'src/resource-types.schema.json';
const GENERATOR = fileURLToPath(new URL('../node_modules/typescript-json-schema/bin/typescript-json-schema', import.meta.url));

const generated = execFileSync(
  process.execPath,
  [GENERATOR, '--defaultNumberType', 'integer', '--required', '--skipLibCheck', SOURCE, '*'],
  { encoding: 'utf-8' },
)
  .replace(/http:\/\/json-schema\.org\/draft-07\/schema#/g, 'https://json-schema.org/draft/2020-12/schema')
  .replace(/"definitions":/g, '"$defs":')
  .replace(/#\/definitions\//g, '#/$defs/');

if (process.argv.includes('--check')) {
  if (readFileSync(TARGET, 'utf-8').trim() !== generated.trim()) {
    console.error(`${TARGET} is out of date with ${SOURCE}. Run: npm run generate:schema`);
    process.exit(1);
  }
  console.log(`${TARGET} matches ${SOURCE}`);
} else {
  writeFileSync(TARGET, generated);
  console.log(`wrote ${TARGET}`);
}
