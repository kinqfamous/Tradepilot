import { prisma } from '../database/prisma';
import { BuilderConfig, FeeEvent, Prisma } from '@prisma/client';
import { config } from '../config/env';

interface FlightClient {
  getBuilderStatus(authority: string): Promise<{ registered: boolean }>;
}

export class FeeRepository {
  /**
   * Environment variables seed the row on first boot only. Every read
   * after that comes straight from the database - per spec, the database
   * is the runtime source of truth, not the environment.
   */
  async getConfig(): Promise<BuilderConfig> {
    const existing = await prisma.builderConfig.findFirst();
    if (existing) return existing;

    return prisma.builderConfig.create({
      data: {
        builderAuthority: config.flight.builderAuthority,
        builderTraderAccount: config.flight.builderTraderAccount,
        builderPdaIndex: config.flight.builderPdaIndex,
        builderSubaccountIndex: config.flight.builderSubaccountIndex,
        builderFeeBps: config.flight.builderFeeBps,
      },
    });
  }

  async updateConfig(data: Prisma.BuilderConfigUncheckedUpdateInput): Promise<BuilderConfig> {
    const current = await this.getConfig();
    return prisma.builderConfig.update({ where: { id: current.id }, data });
  }

  /**
   * Read-only check against Flight for whether the configured builder
   * authority is actually registered, and records the result. Never
   * performs registration itself - that's a manual, external step via
   * flight.phoenix.trade or scripts/register-phoenix-flight-builder.ts.
   */
  async verifyBuilderRegistration(flightClient: FlightClient): Promise<BuilderConfig> {
    const current = await this.getConfig();

    if (!current.builderAuthority) {
      return this.updateConfig({ registrationStatus: 'UNREGISTERED', registrationCheckedAt: new Date() });
    }

    const status = await flightClient.getBuilderStatus(current.builderAuthority);
    return this.updateConfig({
      registrationStatus: status.registered ? 'REGISTERED' : 'FAILED',
      registrationCheckedAt: new Date(),
    });
  }

  async findByIdempotencyKey(key: string): Promise<FeeEvent | null> {
    return prisma.feeEvent.findUnique({ where: { idempotencyKey: key } });
  }

  async createExpected(data: Prisma.FeeEventUncheckedCreateInput): Promise<FeeEvent> {
    return prisma.feeEvent.create({ data });
  }

  async markPending(id: number): Promise<FeeEvent> {
    return prisma.feeEvent.update({ where: { id }, data: { status: 'PENDING' } });
  }

  async markConfirmed(id: number, confirmedFeeUsd: number, builderTxSignature: string): Promise<FeeEvent> {
    return prisma.feeEvent.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedFeeUsd, builderTxSignature, confirmedAt: new Date() },
    });
  }

  async markFailed(id: number, failureReason: string): Promise<FeeEvent> {
    return prisma.feeEvent.update({ where: { id }, data: { status: 'FAILED', failureReason } });
  }

  async markReconciliationRequired(id: number, failureReason: string): Promise<FeeEvent> {
    return prisma.feeEvent.update({ where: { id }, data: { status: 'RECONCILIATION_REQUIRED', failureReason } });
  }

  async listByStatus(status: FeeEvent['status'], limit = 100): Promise<FeeEvent[]> {
    return prisma.feeEvent.findMany({ where: { status }, take: limit, orderBy: { createdAt: 'desc' } });
  }

  async listRecent(limit = 10): Promise<FeeEvent[]> {
    return prisma.feeEvent.findMany({ take: limit, orderBy: { createdAt: 'desc' } });
  }

  async sumConfirmedRevenue(sinceDate?: Date): Promise<number> {
    const result = await prisma.feeEvent.aggregate({
      where: { status: 'CONFIRMED', ...(sinceDate ? { confirmedAt: { gte: sinceDate } } : {}) },
      _sum: { confirmedFeeUsd: true },
    });
    return Number(result._sum.confirmedFeeUsd ?? 0);
  }

  async sumExpectedNotYetConfirmed(sinceDate?: Date): Promise<number> {
    const result = await prisma.feeEvent.aggregate({
      where: {
        status: { in: ['EXPECTED', 'PENDING'] },
        ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
      },
      _sum: { expectedFeeUsd: true },
    });
    return Number(result._sum.expectedFeeUsd ?? 0);
  }

  async sumFailedFees(sinceDate?: Date): Promise<number> {
    const result = await prisma.feeEvent.aggregate({
      where: { status: 'FAILED', ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}) },
      _sum: { expectedFeeUsd: true },
    });
    return Number(result._sum.expectedFeeUsd ?? 0);
  }

  async countBySinceDate(sinceDate?: Date): Promise<number> {
    return prisma.feeEvent.count({ where: sinceDate ? { createdAt: { gte: sinceDate } } : {} });
  }

  async sumNotionalSince(sinceDate?: Date): Promise<number> {
    const result = await prisma.feeEvent.aggregate({
      where: sinceDate ? { createdAt: { gte: sinceDate } } : {},
      _sum: { notionalUsd: true },
    });
    return Number(result._sum.notionalUsd ?? 0);
  }
}

export const feeRepository = new FeeRepository();
