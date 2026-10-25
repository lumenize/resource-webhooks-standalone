// A Worker with no OPERATOR_TOKEN binding, as one deployed without the secret: no environment is
// open to the page's controls by default. Wrangler loads a `.dev.vars` into this lane's env too,
// so one that sets OPERATOR_TOKEN fails the first assertion rather than passing this test open.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { watch } from '../client/parties';
import { newLane } from '../lane/lane';

it('refuses every control on A and on B when the operator-token binding is absent', async () => {
  expect(env.OPERATOR_TOKEN).toBeUndefined();
  const lane = newLane();
  for (const party of ['A', 'B'] as const) {
    const page = await watch(lane, party);
    for (const operatorToken of [null, '', 'test-operator-token-for-the-lane-only']) {
      expect({ party, operatorToken, answer: await page.control('wipe', {}, operatorToken) }).toEqual({ party, operatorToken, answer: { type: 'refused', action: 'wipe' } });
    }
  }
});
