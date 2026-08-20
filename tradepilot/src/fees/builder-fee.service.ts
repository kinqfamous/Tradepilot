import { BuilderConfig, FeeEvent } from '@prisma/client';
import { feeRepository as defaultFeeRepository } from './fee.repository';
import { log } from '../logger/logger';
import { verifyBuilderExists as defaultVerifyBuilderExists } from '../exchange/phoenix/flight.client';

export interface FeePreview {
  builderFeeEnabled: boolean;
  builderConfigured: boolean;
  feeBps: number;
  notionalUsd: number;
  feeUsd: number;
}

export interface RevenueReport {
  periodLabel: string;
  tradeCount: number;
  volumeUsd: number;
  expectedFeeUsd: number;
  confirmedFeeUsd: number;
  failedFeeUsd: number;
  averageFeeUsd: number;
}

/** The subset of FeeRepository's methods BuilderFeeService actually calls - kept narrow so test fakes only need to implement what's used. */
export type FeeRepositoryLike = Pick<
  typeof defaultFeeRepository,
  | 'getConfig'
  | 'updateConfig'
  | 'findByIdempotencyKey'
  | 'findByOrderId'
  | 'createExpected'
  | 'markPending'
  | 'markConfirmed'
  | 'markFailed'
  | 'markReconciliationRequired'
  | 'listByStatus'
  | 'sumConfirmedRevenue'
  | 'sumExpectedNotYetConfirmed'
  | 'sumFailedFees'
  | 'countBySinceDate'
  | 'sumNotionalSince'
>;

export type BuilderExistsChecker = (builderAuthority: string) => Promise<{ registered: boolean }>;

const MIN_FEE_BPS = 0;
const ABSOLUTE_MAX_FEE_BPS = 500; // 5% - a hard ceiling no admin override can exceed

/**
 * Constructor-injected dependencies (defaulting to the real Prisma-backed
 * repository and the real Flight registration check) so this service is
 * fully unit-testable with plain in-memory fakes - no module mocking, no
 * database, no network calls required for tests. See
 * src/test-utils/fee-fixtures.ts for the fake repository used in tests.
 */
export class BuilderFeeService {
  constructor(
    private readonly repo: FeeRepositoryLike = defaultFeeRepository,
    private readonly checkBuilderExists: BuilderExistsChecker = defaultVerifyBuilderExists,
  ) {}

  /** Pure calculation: notional * bps / 10,000, using integer bps (no floating-point fee rates). */
  calculateFeeUsd(notionalUsd: number, feeBps: number): number {
    if (notionalUsd <= 0 || feeBps <= 0) return 0;
    return (notionalUsd * feeBps) / 10_000;
  }

  async getConfig(): Promise<BuilderConfig> {
    return this.repo.getConfig();
  }

  /**
   * Shows what a trade of this size would be charged right now, without
   * recording anything. Returns feeBps: 0 whenever fees are disabled OR no
   * builder authority is configured - both cases must show a real $0.00,
   * never an error, so trade preview screens always render.
   */
  async previewFee(notionalUsd: number): Promise<FeePreview> {
    const builderConfig = await this.repo.getConfig();
    const builderConfigured = Boolean(builderConfig.builderAuthority);
    const effectiveBps =
      builderConfig.builderFeeEnabled && builderConfigured ? builderConfig.builderFeeBps : 0;

    return {
      builderFeeEnabled: builderConfig.builderFeeEnabled,
      builderConfigured,
      feeBps: effectiveBps,
      notionalUsd,
      feeUsd: this.calculateFeeUsd(notionalUsd, effectiveBps),
    };
  }

  /**
   * Per acceptance criterion #17 (emergency stop / consistency): if
   * builder fees are required for the business model but cannot currently
   * be charged (disabled, or no builder configured), trading should stop
   * rather than silently trade fee-free. TradingService checks this before
   * every open() call - see trading.service.ts.
   */
  async canTradeWithFee(): Promise<{ allowed: boolean; reason?: string }> {
    const cfg = await this.repo.getConfig();

    if (!cfg.builderFeeEnabled) {
      // Explicitly disabled by an admin is a deliberate, allowed state -
      // trades proceed fee-free. This is case B from the spec: routing
      // without a fee only when an admin explicitly enabled that behavior
      // (disabling IS the explicit admin action).
      return { allowed: true };
    }

    if (!cfg.builderAuthority) {
      // Fees are enabled but there's nothing configured to route them to -
      // this is an inconsistent state, not a deliberate admin choice.
      // Case A from the spec: stop trading rather than charge nothing
      // unexpectedly, or route through an unconfigured builder.
      return {
        allowed: false,
        reason:
          'Builder fees are enabled but no builder authority is configured. Trading is paused until an admin fixes this via /admin builder or disables fees via /admin fees off.',
      };
    }

    if (cfg.registrationStatus !== 'REGISTERED') {
      return {
        allowed: false,
        reason:
          'The configured Flight builder has not been verified as registered. Trading is paused until an admin verifies it with /builder or disables builder fees with /fees off.',
      };
    }

    return { allowed: true };
  }

  async setFeeBps(adminId: number, bps: number): Promise<BuilderConfig> {
    const current = await this.repo.getConfig();

    if (!Number.isInteger(bps) || bps < MIN_FEE_BPS) {
      throw new Error('Fee must be a non-negative whole number of basis points.');
    }
    if (bps > current.maxFeeBps) {
      throw new Error(
        `Fee of ${bps} bps exceeds the configured max of ${current.maxFeeBps} bps. Raise the max first if this is intentional.`,
      );
    }

    const updated = await this.repo.updateConfig({ builderFeeBps: bps, updatedBy: adminId });
    await log.info('ADMIN', 'Builder fee changed', {
      adminId,
      previousBps: current.builderFeeBps,
      newBps: bps,
    });
    return updated;
  }

  async setMaxFeeBps(adminId: number, bps: number): Promise<BuilderConfig> {
    if (!Number.isInteger(bps) || bps < MIN_FEE_BPS || bps > ABSOLUTE_MAX_FEE_BPS) {
      throw new Error(`Max fee must be between ${MIN_FEE_BPS} and ${ABSOLUTE_MAX_FEE_BPS} basis points.`);
    }
    const current = await this.repo.getConfig();
    if (bps < current.builderFeeBps) {
      throw new Error(`Max fee cannot be lower than the active fee of ${current.builderFeeBps} bps.`);
    }
    const updated = await this.repo.updateConfig({ maxFeeBps: bps, updatedBy: adminId });
    await log.info('ADMIN', 'Builder max fee changed', { adminId, newMaxBps: bps });
    return updated;
  }

  async setFeeEnabled(adminId: number, enabled: boolean): Promise<BuilderConfig> {
    const updated = await this.repo.updateConfig({ builderFeeEnabled: enabled, updatedBy: adminId });
    await log.info('ADMIN', `Builder fee ${enabled ? 'enabled' : 'disabled'}`, { adminId });
    return updated;
  }

  async setBuilderAuthority(
    adminId: number,
    builderAuthority: string,
    builderPdaIndex = 0,
    builderSubaccountIndex = 0,
    builderTraderAccount?: string,
  ): Promise<BuilderConfig> {
    const updated = await this.repo.updateConfig({
      builderAuthority,
      builderPdaIndex,
      builderSubaccountIndex,
      ...(builderTraderAccount ? { builderTraderAccount } : {}),
      registrationStatus: 'PENDING',
      updatedBy: adminId,
    });
    await log.info('ADMIN', 'Builder authority changed', { adminId, builderAuthority, builderTraderAccount });
    return updated;
  }

  /**
   * Read-only check (see flight.client.ts header for what this can and
   * cannot confirm). Never performs registration itself.
   */
  async verifyBuilderRegistration(): Promise<BuilderConfig> {
    const cfg = await this.repo.getConfig();
    if (!cfg.builderAuthority) {
      return this.repo.updateConfig({ registrationStatus: 'UNREGISTERED', registrationCheckedAt: new Date() });
    }

    const status = await this.checkBuilderExists(cfg.builderAuthority);
    return this.repo.updateConfig({
      registrationStatus: status.registered ? 'REGISTERED' : 'FAILED',
      registrationCheckedAt: new Date(),
    });
  }

  /**
   * Records an EXPECTED fee before a trade is submitted, snapshotting the
   * builder identity + fee bps AT THIS MOMENT (see FeeEvent schema comment
   * - later admin changes never rewrite this history). Idempotent on
   * `idempotencyKey` (reuses the underlying Order's key) - calling this
   * twice for the same trade returns the existing row instead of creating
   * a duplicate.
   */
  async recordExpectedFee(params: {
    userId: number;
    orderId?: number;
    market: string;
    notionalUsd: number;
    idempotencyKey: string;
  }): Promise<FeeEvent> {
    const existing = await this.repo.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      await log.warn('SYSTEM', 'Duplicate fee event suppressed', { idempotencyKey: params.idempotencyKey });
      return existing;
    }

    const cfg = await this.repo.getConfig();
    const effectiveBps = cfg.builderFeeEnabled && cfg.builderAuthority ? cfg.builderFeeBps : 0;

    return this.repo.createExpected({
      userId: params.userId,
      orderId: params.orderId,
      market: params.market,
      builderAuthority: cfg.builderAuthority,
      builderPdaIndex: cfg.builderPdaIndex,
      builderSubaccountIndex: cfg.builderSubaccountIndex,
      notionalUsd: params.notionalUsd,
      feeBps: effectiveBps,
      expectedFeeUsd: this.calculateFeeUsd(params.notionalUsd, effectiveBps),
      status: 'EXPECTED',
      idempotencyKey: params.idempotencyKey,
    });
  }

  /** Called once the routed order transaction has been submitted, before confirmation is known. */
  async markPending(feeEventId: number): Promise<FeeEvent> {
    return this.repo.markPending(feeEventId);
  }

  /** Called once the routed trade transaction is confirmed on-chain. */
  async confirmFee(feeEventId: number, confirmedFeeUsd: number, builderTxSignature: string): Promise<FeeEvent> {
    const confirmed = await this.repo.markConfirmed(feeEventId, confirmedFeeUsd, builderTxSignature);
    await log.info('TRADE', 'Fee confirmed', { feeEventId, confirmedFeeUsd, builderTxSignature });
    return confirmed;
  }

  /** Resolves the deferred fee once a resting limit order is observed filled. */
  async confirmFeeForOrder(orderId: number, builderTxSignature: string): Promise<FeeEvent | null> {
    const event = await this.repo.findByOrderId(orderId);
    if (!event || event.status === 'CONFIRMED') return event;
    return this.confirmFee(event.id, Number(event.expectedFeeUsd), builderTxSignature);
  }

  /** Called when the underlying trade fails - the fee never happened either. */
  async failFee(feeEventId: number, failureReason: string): Promise<FeeEvent> {
    const failed = await this.repo.markFailed(feeEventId, failureReason);
    await log.warn('TRADE', 'Fee marked failed', { feeEventId, failureReason });
    return failed;
  }

  /**
   * Flags fee events that never resolved (confirmed or failed) within a
   * reasonable window as RECONCILIATION_REQUIRED - these indicate a trade
   * whose outcome was never recorded, which should never silently count
   * as revenue either way.
   */
  async reconcile(staleAfterMinutes = 30): Promise<{ flaggedCount: number; flaggedEvents: FeeEvent[] }> {
    const [expected, pending] = await Promise.all([
      this.repo.listByStatus('EXPECTED', 500),
      this.repo.listByStatus('PENDING', 500),
    ]);
    const cutoff = Date.now() - staleAfterMinutes * 60_000;
    const stale = [...expected, ...pending].filter((e) => e.createdAt.getTime() < cutoff);

    for (const event of stale) {
      await this.repo.markReconciliationRequired(
        event.id,
        `No confirmation or failure recorded within ${staleAfterMinutes} minutes of the trade.`,
      );
    }

    if (stale.length > 0) {
      await log.warn('SYSTEM', 'Fee reconciliation flagged stale events', { flaggedCount: stale.length });
    }

    return { flaggedCount: stale.length, flaggedEvents: stale };
  }

  /** Only CONFIRMED fees ever count as revenue - EXPECTED, PENDING, and FAILED never do. */
  async getRevenue(sinceDate?: Date): Promise<{ confirmedUsd: number; pendingUsd: number; failedUsd: number }> {
    const [confirmedUsd, pendingUsd, failedUsd] = await Promise.all([
      this.repo.sumConfirmedRevenue(sinceDate),
      this.repo.sumExpectedNotYetConfirmed(sinceDate),
      this.repo.sumFailedFees(sinceDate),
    ]);
    return { confirmedUsd, pendingUsd, failedUsd };
  }

  /** Builds the /admin revenue breakdown: today, 7 days, 30 days, all-time. */
  async getRevenueReport(periodLabel: string, sinceDate?: Date): Promise<RevenueReport> {
    const [tradeCount, volumeUsd, revenue] = await Promise.all([
      this.repo.countBySinceDate(sinceDate),
      this.repo.sumNotionalSince(sinceDate),
      this.getRevenue(sinceDate),
    ]);

    return {
      periodLabel,
      tradeCount,
      volumeUsd,
      expectedFeeUsd: revenue.pendingUsd,
      confirmedFeeUsd: revenue.confirmedUsd,
      failedFeeUsd: revenue.failedUsd,
      averageFeeUsd: tradeCount > 0 ? revenue.confirmedUsd / tradeCount : 0,
    };
  }
}

export const builderFeeService = new BuilderFeeService();
