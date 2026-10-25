// Whether the race the acknowledgement guards against happens on Cloudflare: `b` sends its secret
// on the socket and subscribes at once, without waiting for B to acknowledge it, and A's challenge
// may reach B first. This measures rather than gates, and `results/acknowledgement.json` keeps
// the outcomes for sep-notes.md. Eight runs, since B's host takes ten verifications a minute.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import { newSecret } from '../../src/standard-webhooks';
import { hookUrl, signedIn, socketUrl, subscribe } from '../client/parties';
import { deployedTier } from './tier';

describe("b's acknowledgement on the deployed Worker", () => {
  it('records how often a subscribe sent without waiting for it fails', async () => {
    const tier = deployedTier();
    const outcomes: string[] = [];
    for (let run = 0; run < 8; run++) {
      const b = await signedIn(tier, `b ${run}`);
      const url = socketUrl(tier, b.clientId);
      const socket = await tier.connect(url, ['rw.1', `rw.token.${await b.session.tokenForResource(tier.origin, url)}`]);
      const secret = newSecret();
      socket.send(JSON.stringify({ secret }));
      const outcome = await subscribe(b, `${tier.root}/notes/inbox/acknowledgement`, hookUrl(tier, b.clientId), secret).then(
        () => 'subscribed',
        (error: McpError) => `refused ${(error.data as { reason?: string } | undefined)?.reason ?? error.code}`,
      );
      outcomes.push(outcome);
      socket.close(1000, 'Done');
    }
    mkdirSync('results', { recursive: true });
    writeFileSync('results/acknowledgement.json', JSON.stringify(outcomes, null, 1));
    expect(outcomes).toHaveLength(8);
  });
});
