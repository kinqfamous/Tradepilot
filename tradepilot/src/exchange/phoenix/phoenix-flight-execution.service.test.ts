import { describe, it, expect, vi } from 'vitest';
import { Keypair, Connection } from '@solana/web3.js';
import { PhoenixFlightExecutionService, FlightOrderExecutor } from './phoenix-flight-execution.service';
import { makeBuilderConfig, makeFeeEvent } from '../../test-utils/fee-fixtures';

vi.mock('../../logger/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const FAKE_CONNECTION = {} as Connection;

function makeFakeFeeService(overrides: Partial<ReturnType<typeof defaultFeeServiceFakes>> = {}) {
  return { ...defaultFeeServiceFakes(), ...overrides };
}

function defaultFeeServiceFakes() {
  const feeEvent = makeFeeEvent({ id: 1001, status: 'EXPECTED', expectedFeeUsd: 0.8 as any });
  return {
    canTradeWithFee: vi.fn(async () => ({ allowed: true })),
    recordExpectedFee: vi.fn(async () => feeEvent),
    markPending: vi.fn(async () => ({ ...feeEvent, status: 'PENDING' })),
    confirmFee: vi.fn(async () => ({ ...feeEvent, status: 'CONFIRMED' })),
    failFee: vi.fn(async () => ({ ...feeEvent, status: 'FAILED' })),
    getConfig: vi.fn(async () => makeBuilderConfig({ builderFeeEnabled: true, builderAuthority: 'ABC' })),
  };
}

function makeFakeExecutor(overrides: Partial<FlightOrderExecutor> = {}): FlightOrderExecutor {
  return {
    getFlightRoutedClient: vi.fn(async () => 'flight-client' as any),
    getPlainClient: vi.fn(async () => 'plain-client' as any),
    isIsolatedOnlyMarket: vi.fn(() => false),
    buildIsolatedMarketOrderIxs: vi.fn(async () => ['isolated-market-ix'] as any),
    buildFlightRoutedMarketOrderIx: vi.fn(async () => 'flight-market-ix' as any),
    buildFlightRoutedLimitOrderIx: vi.fn(async () => 'flight-limit-ix' as any),
    buildPlainMarketOrderIx: vi.fn(async () => 'plain-market-ix' as any),
    buildPlainLimitOrderIx: vi.fn(async () => 'plain-limit-ix' as any),
    assembleAndSubmit: vi.fn(async () => 'tx-signature-123'),
    ...overrides,
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    connection: FAKE_CONNECTION,
    traderKeypair: Keypair.generate(),
    userId: 1,
    symbol: 'SOL-PERP',
    side: 'buy' as const,
    baseUnits: '0.25',
    notionalUsd: 1000,
    idempotencyKey: 'order-abc',
    type: 'market' as const,
    ...overrides,
  };
}

describe('PhoenixFlightExecutionService - Flight routing', () => {
  it('uses Phoenix\'s isolated-order route for isolated-only markets such as WTIOIL', async () => {
    const executor = makeFakeExecutor({
      isIsolatedOnlyMarket: vi.fn(() => true),
    });
    const service = new PhoenixFlightExecutionService(makeFakeFeeService() as any, executor);

    await service.executeOrder(baseParams({ symbol: 'WTIOIL', collateralUsd: 50 }));

    expect(executor.buildIsolatedMarketOrderIxs).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'WTIOIL', collateralUsd: 50, reduceOnly: undefined }),
    );
    expect(executor.buildFlightRoutedMarketOrderIx).not.toHaveBeenCalled();
  });

  it('honours a user\'s isolated-margin setting for markets that also allow cross margin', async () => {
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(makeFakeFeeService() as any, executor);

    await service.executeOrder(baseParams({ marginMode: 'ISOLATED', collateralUsd: 50 }));

    expect(executor.buildIsolatedMarketOrderIxs).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SOL-PERP', collateralUsd: 50 }),
    );
    expect(executor.buildFlightRoutedMarketOrderIx).not.toHaveBeenCalled();
  });

  it('routes market orders through Flight when fees are enabled and a builder is configured', async () => {
    const feeService = makeFakeFeeService({
      getConfig: vi.fn(async () => makeBuilderConfig({ builderFeeEnabled: true, builderAuthority: 'ABC' })),
    });
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    await service.executeOrder(baseParams());

    expect(executor.getFlightRoutedClient).toHaveBeenCalledWith(
      expect.objectContaining({ feeBps: 8 }),
    );
    expect(executor.buildFlightRoutedMarketOrderIx).toHaveBeenCalled();
    expect(executor.buildPlainMarketOrderIx).not.toHaveBeenCalled();
  });

  it('routes limit orders through Flight when configured, using the given price', async () => {
    const feeService = makeFakeFeeService();
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    await service.executeOrder(baseParams({ type: 'limit', priceUsd: '135.87' }));

    expect(executor.buildFlightRoutedLimitOrderIx).toHaveBeenCalledWith(
      expect.objectContaining({ priceUsd: '135.87' }),
    );
  });

  it('routes plainly (no Flight, no fee) when the admin has disabled fees', async () => {
    const noFeeEvent = makeFeeEvent({ id: 1002, expectedFeeUsd: 0 as any, feeBps: 0, builderAuthority: 'ABC' });
    const feeService = makeFakeFeeService({
      recordExpectedFee: vi.fn(async () => noFeeEvent),
      getConfig: vi.fn(async () => makeBuilderConfig({ builderFeeEnabled: false, builderAuthority: 'ABC' })),
    });
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    await service.executeOrder(baseParams());

    expect(executor.buildPlainMarketOrderIx).toHaveBeenCalled();
    expect(executor.buildFlightRoutedMarketOrderIx).not.toHaveBeenCalled();
    expect(executor.getFlightRoutedClient).not.toHaveBeenCalled();
  });

  it('rejects a limit order that is missing a price, before touching the fee system at all', async () => {
    const feeService = makeFakeFeeService();
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams({ type: 'limit', priceUsd: undefined }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/priceUsd is required/);
    expect(feeService.canTradeWithFee).not.toHaveBeenCalled();
  });
});

describe('PhoenixFlightExecutionService - emergency stop', () => {
  it('blocks execution entirely when the fee consistency gate disallows trading', async () => {
    const feeService = makeFakeFeeService({
      canTradeWithFee: vi.fn(async () => ({ allowed: false, reason: 'Builder fees are enabled but no builder authority is configured.' })),
    });
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/no builder authority is configured/);
    expect(feeService.recordExpectedFee).not.toHaveBeenCalled();
    expect(executor.assembleAndSubmit).not.toHaveBeenCalled();
  });
});

describe('PhoenixFlightExecutionService - transaction confirmation', () => {
  it('never marks a trade successful without an actual confirmed signature from assembleAndSubmit', async () => {
    const feeService = makeFakeFeeService();
    const executor = makeFakeExecutor({ assembleAndSubmit: vi.fn(async () => 'real-confirmed-sig') });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.success).toBe(true);
    expect(result.signature).toBe('real-confirmed-sig');
    expect(feeService.markPending).toHaveBeenCalled();
    expect(feeService.confirmFee).toHaveBeenCalled();
  });

  it('fee confirmation: confirms the expected fee amount when routed through Flight', async () => {
    const feeEvent = makeFeeEvent({ id: 55, expectedFeeUsd: 0.8 as any });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    await service.executeOrder(baseParams());

    expect(feeService.confirmFee).toHaveBeenCalledWith(55, 0.8, 'tx-signature-123');
  });

  it('confirms at $0 (not the trade notional) when the trade executed without Flight routing', async () => {
    const feeEvent = makeFeeEvent({ id: 56, expectedFeeUsd: 0 as any });
    const feeService = makeFakeFeeService({
      recordExpectedFee: vi.fn(async () => feeEvent),
      getConfig: vi.fn(async () => makeBuilderConfig({ builderFeeEnabled: false })),
    });
    const executor = makeFakeExecutor();
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    await service.executeOrder(baseParams());

    expect(feeService.confirmFee).toHaveBeenCalledWith(56, 0, 'tx-signature-123');
  });
});

describe('PhoenixFlightExecutionService - failed trade / failed fee', () => {
  it('retries a Flight-rejected reduce-only close directly on Phoenix', async () => {
    const feeEvent = makeFeeEvent({ id: 76, expectedFeeUsd: 0.8 as any });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Transaction simulation failed: invalid instruction data'))
      .mockResolvedValueOnce('plain-close-signature');
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({ assembleAndSubmit: submit });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams({ reduceOnly: true }));

    expect(result).toMatchObject({ success: true, signature: 'plain-close-signature' });
    expect(executor.buildPlainMarketOrderIx).toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(feeService.confirmFee).toHaveBeenCalledWith(76, 0, 'plain-close-signature');
  });

  it('failed trade: marks the fee event FAILED and returns success:false when order building throws', async () => {
    const feeEvent = makeFeeEvent({ id: 77 });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({
      buildFlightRoutedMarketOrderIx: vi.fn(async () => {
        throw new Error('Phoenix rejected the order: insufficient margin');
      }),
    });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/insufficient margin/);
    expect(feeService.failFee).toHaveBeenCalledWith(77, expect.stringMatching(/insufficient margin/));
    expect(feeService.confirmFee).not.toHaveBeenCalled();
  });

  it('failed trade: marks the fee event FAILED when submission/confirmation throws', async () => {
    const feeEvent = makeFeeEvent({ id: 78 });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({
      assembleAndSubmit: vi.fn(async () => {
        throw new Error('Blockhash expired');
      }),
    });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.success).toBe(false);
    expect(feeService.failFee).toHaveBeenCalledWith(78, expect.stringMatching(/Blockhash expired/));
  });

  it('returns an actionable message when Phoenix cannot fully fill an IOC order', async () => {
    const feeEvent = makeFeeEvent({ id: 79 });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({
      assembleAndSubmit: vi.fn(async () => {
        throw new Error('IOC order does not meet minimum requirements. Min base: 2600, Min quote: 1, Filled base: 26, Filled quote: 19784273');
      }),
    });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result).toMatchObject({ success: false, errorMessage: expect.stringMatching(/Insufficient market liquidity.*1\.0%/i) });
    expect(feeService.failFee).toHaveBeenCalledWith(79, expect.stringMatching(/Insufficient market liquidity/i));
  });

  it('explains when Phoenix needs SOL rent for a new isolated subaccount', async () => {
    const feeEvent = makeFeeEvent({ id: 80 });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({
      assembleAndSubmit: vi.fn(async () => {
        throw new Error('Transfer: insufficient lamports 1669240, need 2839680');
      }),
    });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.errorMessage).toMatch(/has 0\.001669 SOL but needs 0\.002840 SOL.*fund it to about 0\.004 SOL/i);
  });

  it('explains when Phoenix reports insufficient available collateral', async () => {
    const feeEvent = makeFeeEvent({ id: 81 });
    const feeService = makeFakeFeeService({ recordExpectedFee: vi.fn(async () => feeEvent) });
    const executor = makeFakeExecutor({
      assembleAndSubmit: vi.fn(async () => {
        throw new Error('Program Etrn failed: insufficient funds for instruction');
      }),
    });
    const service = new PhoenixFlightExecutionService(feeService as any, executor);

    const result = await service.executeOrder(baseParams());

    expect(result.errorMessage).toMatch(/Insufficient available Phoenix collateral.*selected collateral amount plus trading fees/i);
  });
});
