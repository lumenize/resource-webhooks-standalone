import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // The vitest-plugin lane: the tests, the Worker and its Durable Objects in one isolate.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // A minute, so a test reaches the cut-off by moving the clock past it.
            miniflare: { bindings: { CUTOFF_WINDOW_MS: '60000' } },
          }),
        ],
        test: {
          name: 'lane',
          include: ['test/lane/**/*.test.ts'],
          setupFiles: ['./test/lane/setup.ts'],
        },
      },
      // Node tests: the Worker under wrangler's test harness, with its static assets, and the
      // repo's own scripts.
      {
        test: {
          name: 'harness',
          environment: 'node',
          include: ['test/harness/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
