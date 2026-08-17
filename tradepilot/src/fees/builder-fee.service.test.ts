import { describe, it, expect, vi } from 'vitest';
import { BuilderFeeService } from './builder-fee.service';
import { createFakeFeeRepository, makeBuilderConfig, makeFeeEvent } from '../test-utils/fee-fixtures';

vi.mock('../logger/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeService(configOverrides: Parameters<typeof makeBuilderConfig>[0] = {}) {
  const repo = createFakeFeeRepository();
  repo.getConfig.mockResolvedValue(makeBuilderConfig(configOverrides));
  const checkBuilderExists = vi.fn(async () => ({ registered: true }));
  const service = new BuilderFeeService(repo as any, checkBuilderExists);
  return { service, repo, checkBuilderExists };
}

describe('BuilderFeeService.calculateFeeUsd', () => {
  it('5 BPS calculation: a $1,000 trade at 5 bps charges exactly $0.50', () => {
    const { service } = makeService();
    expect(service.calculateFeeUsd(1000, 5)).toBeCloseTo(0.5, 8);
  });

  it('calculates the actual configured 8 bps rate correctly: $1,000 -> $0.80', () => {
    const { service } = makeService();
    expect(service.calculateFeeUsd(1000, 8)).toBeCloseTo(0.8, 8);
  });

  it('zero fee: a zero bps rate charges nothing regardless of notional', () => {
    const { service } = makeService();
    expect(service.calculateFeeUsd(1_000_000, 0)).toBe(0);
  });

  it('zero fee: a zero notional charges nothing regardless of bps', () => {
    const { service } = makeService();
    expect(service.calculateFeeUsd(0, 8)).toBe(0);
  });

  it('never returns a negative fee for negative inputs', () => {
    const { service } = makeService();
    expect(service.calculateFeeUsd(-500, 8)).toBe(0);
    expect(service.calculateFeeUsd(500, -8)).toBe(0);
  });
});

describe('BuilderFeeService.previewFee (trade preview)', () => {
  it('trade preview: shows the real configured fee for an enabled, configured builder', async () => {
    const { service } = makeService({ builderFeeEnabled: true, builderAuthority: 'ABC', builderFeeBps: 8 });
    const preview = await service.previewFee(1000);
    expect(preview).toEqual({
      builderFeeEnabled: true,
      builderConfigured: true,
      feeBps: 8,
      notionalUsd: 1000,
      feeUsd: 0.8,
    });
  });

  it('fee disabled: preview shows $0.00 and feeBps 0, never an error', async () => {
    const { service } = makeService({ builderFeeEnabled: false, builderAuthority: 'ABC', builderFeeBps: 8 });
    const preview = await service.previewFee(1000);
    expect(preview.feeBps).toBe(0);
    expect(preview.feeUsd).toBe(0);
    expect(preview.builderFeeEnabled).toBe(false);
  });

  it('no builder configured: preview shows $0.00 even if enabled', async () => {
    const { service } = makeService({ builderFeeEnabled: true, builderAuthority: null });
    const preview = await service.previewFee(1000);
    expect(preview.feeBps).toBe(0);
    expect(preview.feeUsd).toBe(0);
    expect(preview.builderConfigured).toBe(false);
  });
});

describe('BuilderFeeService.setFeeBps (fee changes)', () => {
  it('fee changes: updates the fee and persists it via the repository', async () => {
    const { service, repo } = makeService({ builderFeeBps: 5, maxFeeBps: 50 });
    const updated = await service.setFeeBps(42, 8);
    expect(updated.builderFeeBps).toBe(8);
    expect(repo.updateConfig).toHaveBeenCalledWith({ builderFeeBps: 8, updatedBy: 42 });
  });

  it('maximum fee: rejects a fee above the configured max', async () => {
    const { service } = makeService({ maxFeeBps: 50 });
    await expect(service.setFeeBps(1, 51)).rejects.toThrow(/exceeds the configured max/);
  });

  it('maximum fee: allows a fee exactly at the configured max', async () => {
    const { service } = makeService({ maxFeeBps: 50 });
    const updated = await service.setFeeBps(1, 50);
    expect(updated.builderFeeBps).toBe(50);
  });

  it('rejects a negative fee', async () => {
    const { service } = makeService();
    await expect(service.setFeeBps(1, -1)).rejects.toThrow(/non-negative/);
  });

  it('rejects a non-integer fee', async () => {
    const { service } = makeService();
    await expect(service.setFeeBps(1, 8.5)).rejects.toThrow(/whole number/);
  });
});

describe('BuilderFeeService.setMaxFeeBps', () => {
  it('rejects a max fee above the absolute hard ceiling (500 bps / 5%)', async () => {
    const { service } = makeService();
    await expect(service.setMaxFeeBps(1, 501)).rejects.toThrow();
  });

  it('accepts a max fee within the hard ceiling', async () => {
    const { service } = makeService();
    const updated = await service.setMaxFeeBps(1, 100);
    expect(updated.maxFeeBps).toBe(100);
  });
});

describe('BuilderFeeService.canTradeWithFee (emergency stop / consistency gate)', () => {
  it('emergency stop: allows trading when fees are explicitly disabled by an admin', async () => {
    const { service } = makeService({ builderFeeEnabled: false, builderAuthority: null });
    const result = await service.canTradeWithFee();
    expect(result.allowed).toBe(true);
  });

  it('emergency stop: blocks trading when fees are enabled but no builder is configured (inconsistent state)', async () => {
    const { service } = makeService({ builderFeeEnabled: true, builderAuthority: null });
    const result = await service.canTradeWithFee();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no builder authority is configured/i);
  });

  it('allows trading when fees are enabled and a builder is properly configured', async () => {
    const { service } = makeService({ builderFeeEnabled: true, builderAuthority: 'ABC', registrationStatus: 'REGISTERED' });
    const result = await service.canTradeWithFee();
    expect(result.allowed).toBe(true);
  });

  it('blocks trading when the builder authority has not been verified as registered', async () => {
    const { service } = makeService({ builderFeeEnabled: true, builderAuthority: 'ABC', registrationStatus: 'PENDING' });
    const result = await service.canTradeWithFee();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not been verified/i);
  });
});

describe('BuilderFeeService.verifyBuilderRegistration (builder registration validation)', () => {
  it('marks UNREGISTERED when no builder authority is configured at all', async () => {
    const { service, repo } = makeService({ builderAuthority: null });
    await service.verifyBuilderRegistration();
    expect(repo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ registrationStatus: 'UNREGISTERED' }),
    );
  });

  it('marks REGISTERED when the configured builder authority checks out as registered', async () => {
    const { service, repo, checkBuilderExists } = makeService({ builderAuthority: 'ABC' });
    checkBuilderExists.mockResolvedValue({ registered: true });
    await service.verifyBuilderRegistration();
    expect(checkBuilderExists).toHaveBeenCalledWith('ABC');
    expect(repo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ registrationStatus: 'REGISTERED' }),
    );
  });

  it('marks FAILED when the configured builder authority does not check out as registered', async () => {
    const { service, repo, checkBuilderExists } = makeService({ builderAuthority: 'ABC' });
    checkBuilderExists.mockResolvedValue({ registered: false });
    await service.verifyBuilderRegistration();
    expect(repo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ registrationStatus: 'FAILED' }),
    );
  });
});

describe('BuilderFeeService builder configuration', () => {
  it('setBuilderAuthority updates the authority/PDA/subaccount and resets registration to PENDING', async () => {
    const { service, repo } = makeService();
    const updated = await service.setBuilderAuthority(7, 'NewAuthorityXYZ', 1, 2);
    expect(updated.registrationStatus).toBe('PENDING');
    expect(repo.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        builderAuthority: 'NewAuthorityXYZ',
        builderPdaIndex: 1,
        builderSubaccountIndex: 2,
        updatedBy: 7,
      }),
    );
  });
});

describe('BuilderFeeService.recordExpectedFee (duplicate fee events)', () => {
  it('creates a new EXPECTED fee event snapshotting the current builder config', async () => {
    const { service, repo } = makeService({ builderFeeBps: 8, builderAuthority: 'ABC', builderPdaIndex: 3, builderSubaccountIndex: 4 });
    const event = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-123',
    });

    expect(event.status).toBe('EXPECTED');
    expect(repo.createExpected).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        market: 'SOL-PERP',
        builderAuthority: 'ABC',
        builderPdaIndex: 3,
        builderSubaccountIndex: 4,
        feeBps: 8,
        expectedFeeUsd: 0.8,
        idempotencyKey: 'order-123',
      }),
    );
  });

  it('duplicate fee events: calling twice with the same idempotency key returns the SAME event, never creates a second', async () => {
    const { service, repo } = makeService();

    const first = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-999',
    });
    const second = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-999',
    });

    expect(second.id).toBe(first.id);
    expect(repo.createExpected).toHaveBeenCalledTimes(1);
  });

  it('records a $0 expected fee (feeBps 0) when fees are disabled at the time of the trade', async () => {
    const { service } = makeService({ builderFeeEnabled: false });
    const event = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-disabled',
    });
    expect(event.feeBps).toBe(0);
    expect(Number(event.expectedFeeUsd)).toBe(0);
  });
});

describe('BuilderFeeService.confirmFee (fee confirmation)', () => {
  it('fee confirmation: marks the event CONFIRMED with the given amount and tx signature', async () => {
    const { service, repo } = makeService();
    const event = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-confirm',
    });

    const confirmed = await service.confirmFee(event.id, 0.8, 'sig123');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(Number(confirmed.confirmedFeeUsd)).toBe(0.8);
    expect(confirmed.builderTxSignature).toBe('sig123');
    expect(repo.markConfirmed).toHaveBeenCalledWith(event.id, 0.8, 'sig123');
  });
});

describe('BuilderFeeService.failFee (failed fee)', () => {
  it('failed fee: marks the event FAILED with a reason, and it is never counted as revenue', async () => {
    const { service, repo } = makeService();
    const event = await service.recordExpectedFee({
      userId: 1,
      market: 'SOL-PERP',
      notionalUsd: 1000,
      idempotencyKey: 'order-fail',
    });

    const failed = await service.failFee(event.id, 'Insufficient collateral');
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toBe('Insufficient collateral');
    expect(repo.markFailed).toHaveBeenCalledWith(event.id, 'Insufficient collateral');

    const revenue = await service.getRevenue();
    expect(revenue.confirmedUsd).toBe(0);
    expect(revenue.failedUsd).toBeGreaterThan(0);
  });
});

describe('BuilderFeeService.reconcile (fee reconciliation)', () => {
  it('flags EXPECTED events older than the stale window as RECONCILIATION_REQUIRED', async () => {
    const { service, repo } = makeService();
    const staleEvent = makeFeeEvent({
      status: 'EXPECTED',
      createdAt: new Date(Date.now() - 60 * 60_000), // 60 minutes ago
    });
    repo.listByStatus.mockImplementation(async (status: string) =>
      status === 'EXPECTED' ? [staleEvent] : [],
    );

    const result = await service.reconcile(30);
    expect(result.flaggedCount).toBe(1);
    expect(repo.markReconciliationRequired).toHaveBeenCalledWith(staleEvent.id, expect.any(String));
  });

  it('does not flag recent EXPECTED events within the stale window', async () => {
    const { service, repo } = makeService();
    const freshEvent = makeFeeEvent({ status: 'EXPECTED', createdAt: new Date() });
    repo.listByStatus.mockImplementation(async (status: string) =>
      status === 'EXPECTED' ? [freshEvent] : [],
    );

    const result = await service.reconcile(30);
    expect(result.flaggedCount).toBe(0);
    expect(repo.markReconciliationRequired).not.toHaveBeenCalled();
  });
});

describe('BuilderFeeService revenue reporting', () => {
  it('only CONFIRMED fees count toward confirmed revenue - EXPECTED, PENDING, FAILED never do', async () => {
    const { service } = makeService();

    const confirmed1 = await service.recordExpectedFee({ userId: 1, market: 'SOL-PERP', notionalUsd: 1000, idempotencyKey: 'a' });
    await service.confirmFee(confirmed1.id, 0.8, 'sig-a');

    const pending = await service.recordExpectedFee({ userId: 1, market: 'SOL-PERP', notionalUsd: 1000, idempotencyKey: 'b' });
    await service.markPending(pending.id);

    const failed = await service.recordExpectedFee({ userId: 1, market: 'SOL-PERP', notionalUsd: 1000, idempotencyKey: 'c' });
    await service.failFee(failed.id, 'oops');

    const revenue = await service.getRevenue();
    expect(revenue.confirmedUsd).toBeCloseTo(0.8, 8);
    expect(revenue.pendingUsd).toBeGreaterThan(0); // the still-pending one
    expect(revenue.failedUsd).toBeGreaterThan(0);
  });

  it('revenue report computes trade count, volume, and average fee correctly', async () => {
    const { service, repo } = makeService();
    repo.countBySinceDate.mockResolvedValue(4);
    repo.sumNotionalSince.mockResolvedValue(4000);
    repo.sumConfirmedRevenue.mockResolvedValue(3.2);
    repo.sumExpectedNotYetConfirmed.mockResolvedValue(0);
    repo.sumFailedFees.mockResolvedValue(0);

    const report = await service.getRevenueReport('All Time');
    expect(report.tradeCount).toBe(4);
    expect(report.volumeUsd).toBe(4000);
    expect(report.confirmedFeeUsd).toBe(3.2);
    expect(report.averageFeeUsd).toBeCloseTo(0.8, 8);
  });

  it('revenue report shows a zero average when there are no trades in the period yet', async () => {
    const { service, repo } = makeService();
    repo.countBySinceDate.mockResolvedValue(0);
    repo.sumNotionalSince.mockResolvedValue(0);

    const report = await service.getRevenueReport('Today');
    expect(report.averageFeeUsd).toBe(0);
  });
});
