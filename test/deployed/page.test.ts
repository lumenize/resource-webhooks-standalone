// The demo page as the deployed Worker serves it: the page with its policy, its compiled script,
// and the page the sign-in frame returns to.
import { describe, expect, it } from 'vitest';
import { deployedTier } from './tier';

describe('the page on the deployed Worker', () => {
  it('serves the page with its policy, its script and /callback', async () => {
    const { origin } = deployedTier();
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('/js/page/page.js');
    const script = await fetch(`${origin}/js/page/page.js`);
    expect({ status: script.status, type: script.headers.get('Content-Type') }).toEqual({ status: 200, type: expect.stringContaining('javascript') });
    expect((await fetch(`${origin}/callback`)).status).toBe(200);
  });
});
