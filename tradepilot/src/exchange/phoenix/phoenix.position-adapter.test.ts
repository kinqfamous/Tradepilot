import { describe, expect, it, vi } from 'vitest';
import { PhoenixPositionAdapter } from './phoenix.position-adapter';

describe('PhoenixPositionAdapter', () => {
  it('converts raw base-position lots to base units before a close is sized', async () => {
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          snapshot: {
            subaccounts: [{
              collateral: '3952819',
              positions: [{
                positionSequenceNumber: '1',
                symbol: 'SOL-PERP',
                basePositionLots: '2600',
                entryPriceUsd: '147.97',
                accumulatedFundingQuoteLots: '0',
              }],
            }],
          },
        })
        .mockResolvedValueOnce([{ symbol: 'SOL-PERP', baseLotsDecimals: 3 }])
        .mockResolvedValueOnce({ markets: [{ symbol: 'SOL-PERP', mark_price: 150 }] }),
    };
    const adapter = new PhoenixPositionAdapter(client as any);

    const positions = await adapter.getOpenPositions({ walletAddress: 'wallet' });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      market: 'SOL-PERP',
      size: 2.6,
      side: 'LONG',
      margin: 3.952819,
      markPrice: 150,
    });
    expect(positions[0].unrealizedPnl).toBeCloseTo(5.278, 6);
  });

  it('uses basePositionUnits directly when the API supplies it', async () => {
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          snapshot: {
            subaccounts: [{
              collateral: '4',
              positions: [{
                positionSequenceNumber: '1',
                symbol: 'SOL-PERP',
                basePositionUnits: '-0.026',
                basePositionLots: '-26000',
                accumulatedFundingQuoteLots: '0',
              }],
            }],
          },
        })
        .mockResolvedValueOnce([{ symbol: 'SOL-PERP', baseLotsDecimals: 6 }])
        .mockResolvedValueOnce({ markets: [{ symbol: 'SOL-PERP', mark_price: 150 }] }),
    };
    const adapter = new PhoenixPositionAdapter(client as any);

    const positions = await adapter.getOpenPositions({ walletAddress: 'wallet' });

    expect(positions[0]).toMatchObject({ size: 0.026, side: 'SHORT' });
  });
});
