// The check a proposal drafted from sep-notes.md runs before it is posted, shown able to fail on a
// withdrawn number, a number never defined, and a relative link that names no file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

function check(proposal: string): { exitCode: number; output: string } {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-'));
  writeFileSync(join(folder, 'present.md'), '# Present\n');
  const file = join(folder, 'proposal.md');
  writeFileSync(file, proposal);
  try {
    return { exitCode: 0, output: execFileSync(process.execPath, [join(ROOT, 'scripts/check-proposal.mjs'), file, '--offline'], { encoding: 'utf-8', stdio: 'pipe' }) };
  } catch (error) {
    const failed = error as { status: number; stderr: string };
    return { exitCode: failed.status, output: failed.stderr };
  }
}

describe("a proposal's citations and links", () => {
  it('pass when each number is a live entry of sep-notes.md and each relative link names a file', () => {
    expect(check('R12 and N1 and D1 hold, as [this](present.md) says.\n')).toEqual({ exitCode: 0, output: 'checked 3 numbers cited and 1 links, the https ones skipped\n' });
  });

  it('fail on a withdrawn number, one never defined, and a link to no file', () => {
    const { exitCode, output } = check('R12 holds, R9 was withdrawn, R999 never was, and [this](absent.md) is gone.\n');
    expect(exitCode).toBe(1);
    expect(output.trim().split('\n')).toEqual([
      "cites R9, which is no numbered entry outside sep-notes.md's § Withdrawn",
      "cites R999, which is no numbered entry outside sep-notes.md's § Withdrawn",
      'links absent.md, which names no file',
    ]);
  });
});
