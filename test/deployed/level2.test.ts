// Level 2's scenarios against the deployed Worker, through the same client the lane uses.
import { describe, it } from 'vitest';
import { level2 } from '../scenarios/level2';
import { deployedTier } from './tier';

describe('level 2 on the deployed Worker', () => {
  it('Scenarios 3 to 8: subscribes from nothing, hears changes, refreshes, coalesces, catches up and hears a deletion', () => level2(deployedTier()));
});
