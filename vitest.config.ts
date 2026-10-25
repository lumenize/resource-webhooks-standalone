import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// What the vitest-plugin lanes bind beyond wrangler.jsonc's vars.
const BINDINGS = {
  // A minute, so a test reaches the cut-off by moving the clock past it.
  CUTOFF_WINDOW_MS: '60000',
  // Small, so a test reaches the cap.
  REGISTRATION_CAP: '5',
  TOKEN_SIGNING_KEY: 'test-signing-key-for-the-vitest-plugin-lane-only',
  SUBSCRIPTION_ID_KEY: 'test-subscription-id-key-for-the-lane-only',
  // Milliseconds, so a test watches every retry with real timers.
  RETRY_SCHEDULE_MS: '100,200,400',
  ATTEMPT_TIMEOUT_MS: '300',
  SUBSCRIPTION_CAP: '5',
  VERIFICATION_BURST: '5',
  // Half a second, so a test sees a socket go quiet with real timers.
  HEARTBEAT_MS: '500',
};

function lane(name: string, include: string[], bindings: Record<string, string>) {
  return {
    plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings } })],
    // Level 1's tests watch real retries and heartbeats for a few seconds each.
    test: { name, include, setupFiles: ['./test/lane/setup.ts'], testTimeout: 15_000 },
  };
}

export default defineConfig({
  test: {
    projects: [
      // The vitest-plugin lane: the tests, the Worker and its Durable Objects in one isolate.
      lane('lane', ['test/lane/**/*.test.ts'], { ...BINDINGS, OPERATOR_TOKEN: 'test-operator-token-for-the-lane-only' }),
      // The same, with no operator-token binding at all, as a Worker deployed without the secret.
      lane('lane-closed', ['test/lane-closed/**/*.test.ts'], BINDINGS),
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
