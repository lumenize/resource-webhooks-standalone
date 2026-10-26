// Level 2's collection scenarios against the deployed Worker, through the same client the lane uses.
import { describe, it } from 'vitest';
import { scenarios9and10 } from '../scenarios/collections';
import { deployedTier } from './tier';

describe('collections on the deployed Worker', () => {
  it('Scenarios 9 and 10: subscribes to an empty inbox, hears a new member, and catches up by its cursor after an absence', () => scenarios9and10(deployedTier()));
});
