// Level 1's scenario against the deployed Worker, through the same client the lane uses, since
// some claims, such as what a Worker's fetch can reach, hold only on Cloudflare.
import { describe, it } from 'vitest';
import { scenario2 } from '../scenarios/level1';
import { deployedTier } from './tier';

describe('level 1 on the deployed Worker', () => {
  it('Scenario 2: lists the type, subscribes after the handshake, delivers an occurrence for a write, and reports it all redacted', () => scenario2(deployedTier()));
});
