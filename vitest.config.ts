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
            miniflare: {
              bindings: {
                // A minute, so a test reaches the cut-off by moving the clock past it.
                CUTOFF_WINDOW_MS: '60000',
                // Small, so a test reaches the cap.
                REGISTRATION_CAP: '5',
                TOKEN_SIGNING_KEY: 'test-signing-key-for-the-vitest-plugin-lane-only',
              },
            },
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
