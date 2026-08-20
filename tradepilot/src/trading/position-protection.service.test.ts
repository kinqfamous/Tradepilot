import { describe, expect, it } from 'vitest';
import { calculateProtectionPrice } from './position-protection.service';

describe('calculateProtectionPrice', () => {
  it('converts long-position ROE targets into leverage-adjusted prices', () => {
    expect(calculateProtectionPrice({ entryPrice: 100, leverage: 10, percentage: 20, side: 'LONG', type: 'TAKE_PROFIT' })).toBeCloseTo(102);
    expect(calculateProtectionPrice({ entryPrice: 100, leverage: 10, percentage: 20, side: 'LONG', type: 'STOP_LOSS' })).toBeCloseTo(98);
  });

  it('reverses the target direction for a short position', () => {
    expect(calculateProtectionPrice({ entryPrice: 100, leverage: 5, percentage: 10, side: 'SHORT', type: 'TAKE_PROFIT' })).toBeCloseTo(98);
    expect(calculateProtectionPrice({ entryPrice: 100, leverage: 5, percentage: 10, side: 'SHORT', type: 'STOP_LOSS' })).toBeCloseTo(102);
  });
});
