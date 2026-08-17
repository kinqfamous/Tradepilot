import { describe, expect, it } from 'vitest';
import { PhoenixWalletAdapter } from './phoenix.wallet-adapter';

describe('PhoenixWalletAdapter balances', () => {
  it('converts Phoenix micro-PhUSD collateral into display units', async () => {
    const client = {
      get: async () => ({
        snapshot: {
          subaccounts: [{ collateral: '4000000' }, { collateral: '250000' }],
        },
      }),
    };
    const adapter = new PhoenixWalletAdapter(client as any);

    await expect(adapter.getBalances({ walletAddress: 'wallet', sessionSecret: 'secret' })).resolves.toEqual([
      { asset: 'PhUSD', total: 4.25, available: 4.25, usedMargin: 0 },
    ]);
  });
});
