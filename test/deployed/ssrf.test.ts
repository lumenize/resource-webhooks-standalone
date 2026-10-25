// The SSRF measurement rerun through A's own delivery path: each handshake a subscribe makes is
// A's https POST from a Durable Object, to a name that sslip.io, nip.io or 1u.ms resolves. A
// reports how each challenge was answered on its back channel, Cloudflare's refusal code among
// it, and `results/ssrf-outcomes.json` keeps the run's outcomes for sep-notes.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribe, watch, type Page, type Party, type Tier } from '../client/parties';
import { deployedTier } from './tier';

interface Outcome {
  url: string;
  reason?: string;
  status?: number;
  refusal?: number;
  failure?: string;
}

async function handshake(tier: Tier, b: Party, page: Page, url: string): Promise<Outcome> {
  const before = page.reports().length;
  const error = await subscribe(b, `${tier.root}/notes/inbox/ssrf`, url, newSecret()).then(
    () => undefined,
    (caught: unknown) => caught as McpError,
  );
  let report: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    report = page.reports().slice(before).find((each) => each.kind === 'verification' && each.url === url);
    expect(report).toBeDefined();
  });
  const { status, refusal, failure } = report as unknown as Outcome;
  return { url, reason: (error?.data as { reason?: string } | undefined)?.reason, status, refusal, failure };
}

// Each name and the code Cloudflare answers A's POST to it with, as sep-notes.md records.
const REFUSED: [string, number][] = [
  ...['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '255.255.255.255', '0--1', 'fc00--1', 'fe80--1'].map(
    (address): [string, number] => [`${address}.sslip.io`, 1016],
  ),
  ['10.0.0.1.nip.io', 1016],
  ['127.0.0.1.nip.io', 1016],
  ...['100.64.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '2001-db8--1', '64-ff9b--a00-1', '0--ffff-7f00-1'].map(
    (address): [string, number] => [`${address}.sslip.io`, 1002],
  ),
  ['10.0.0.1', 1003],
  ['127.0.0.1', 1003],
  ['localhost', 1003],
];
// Reached: Cloudflare connected, and refused the certificate, which is Google's or its own, not
// the name's, with 526.
const REACHED = ['142.251.156.119.sslip.io', '142.251.156.119.nip.io', '1.1.1.1.sslip.io'];
const TIMED_OUT = ['192.0.0.1.sslip.io', '192.0.0.8.sslip.io', '192.0.2.1.sslip.io'];

describe("SSRF through A's handshake", () => {
  it('refuses each special-purpose address with its code, reaches Google, and never reaches a rebinding name\'s private answer', async () => {
    const tier = deployedTier();
    const page = await watch(tier, 'A');
    const b = await signedIn(tier, 'b');
    const outcome = (name: string) => handshake(tier, b, page, `https://${name}/hook`);
    const outcomes: Outcome[] = [];
    const record = async (name: string) => {
      const each = await outcome(name);
      outcomes.push(each);
      return each;
    };

    for (const [name, code] of REFUSED) {
      expect({ name, ...(await record(name)) }).toMatchObject({ name, reason: 'challenge_failed', refusal: code });
    }
    for (const name of REACHED) expect({ name, ...(await record(name)) }).toMatchObject({ name, reason: 'challenge_failed', status: 526 });
    for (const name of TIMED_OUT) expect({ name, ...(await record(name)) }).toMatchObject({ name, reason: 'timeout', failure: 'timeout' });

    // Each name is new, so Cloudflare resolves it afresh. 1u.ms answers Google's address once and
    // 10.0.0.1 after it, so a fetch that looks the name up again sees the private answer.
    const rebinding: Outcome[] = [];
    for (let n = 0; n < 12; n++) {
      rebinding.push(await record(`${crypto.randomUUID().slice(0, 8)}-make-142.251.156.119-rebindfor60safter1times-10.0.0.1-rr.1u.ms`));
    }
    mkdirSync('results', { recursive: true });
    writeFileSync('results/ssrf-outcomes.json', JSON.stringify(outcomes, null, 1));
    const kinds = rebinding.map(({ status, refusal }) => (status === 526 ? 'reached Google' : refusal ? `refused ${refusal}` : `other ${status}`));
    expect(kinds.every((kind) => kind === 'reached Google' || kind.startsWith('refused'))).toBe(true);
    // Without one refusal, no fetch saw the private answer, and the probe showed nothing.
    expect(kinds.some((kind) => kind.startsWith('refused'))).toBe(true);
  });
});
