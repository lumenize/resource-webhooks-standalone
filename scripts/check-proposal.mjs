#!/usr/bin/env node
// Checks a proposal drafted from sep-notes.md: every R-, N- and D-number it cites is a numbered
// entry of sep-notes.md outside § Withdrawn, every relative link names a file that exists, and
// every https link answers below 400. With --offline it skips the https links.
//
//   node scripts/check-proposal.mjs <proposal.md> [--notes sep-notes.md] [--offline]
//
// It exits 1 and lists each problem, or prints what it checked and exits 0.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const notesIndex = args.indexOf('--notes');
const notesPath = notesIndex === -1 ? join(import.meta.dirname, '..', 'sep-notes.md') : args[notesIndex + 1];
const proposalPath = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--notes');
if (!proposalPath) {
  console.error('usage: node scripts/check-proposal.mjs <proposal.md> [--notes sep-notes.md] [--offline]');
  process.exit(2);
}

const notes = readFileSync(notesPath, 'utf-8');
const withdrawnAt = notes.indexOf('\n## Withdrawn');
const live = withdrawnAt === -1 ? notes : notes.slice(0, withdrawnAt);
// An entry is a list item that opens with its number in bold, as `- **R12.**` or `- **N1. …`.
const defined = new Set([...live.matchAll(/^- \*\*([RND]\d+)\./gm)].map((match) => match[1]));

const proposal = readFileSync(proposalPath, 'utf-8');
const problems = [];
const cited = new Set([...proposal.matchAll(/\b([RND]\d+)\b/g)].map((match) => match[1]));
for (const number of [...cited].sort()) {
  if (!defined.has(number)) problems.push(`cites ${number}, which is no numbered entry outside sep-notes.md's § Withdrawn`);
}

const links = [...proposal.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
const external = links.filter((link) => /^https?:/.test(link));
for (const link of links.filter((each) => !/^(https?:|mailto:|#)/.test(each))) {
  const target = resolve(dirname(proposalPath), link.split('#')[0]);
  if (!existsSync(target)) problems.push(`links ${link}, which names no file`);
}
if (!offline) {
  for (const link of [...new Set(external)]) {
    let status;
    try {
      status = (await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })).status;
    } catch (error) {
      status = String(error);
    }
    if (!(typeof status === 'number' && status < 400)) problems.push(`links ${link}, which answered ${status}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`checked ${cited.size} numbers cited and ${links.length} links${offline ? ', the https ones skipped' : ''}`);
