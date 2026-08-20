import { vi } from 'vitest';
import type { BuilderConfig, FeeEvent, FeeEventStatus } from '@prisma/client';

/**
 * A minimal, deterministic BuilderConfig fixture. Every field a test needs
 * to override, it overrides explicitly - nothing here should be treated as
 * a "sensible default" tests silently rely on beyond what's stated.
 */
export function makeBuilderConfig(overrides: Partial<BuilderConfig> = {}): BuilderConfig {
  return {
    id: 1,
    builderAuthority: 'BuiLdErAuthPubKey11111111111111111111111',
    builderTraderAccount: 'BuiLdErTraderAccountPubKey1111111111111111',
    builderPdaIndex: 0,
    builderSubaccountIndex: 0,
    registrationStatus: 'REGISTERED',
    registrationCheckedAt: new Date('2026-01-01T00:00:00Z'),
    builderFeeBps: 8,
    maxFeeBps: 50,
    builderFeeEnabled: true,
    updatedBy: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

let feeEventIdCounter = 1;

export function makeFeeEvent(overrides: Partial<FeeEvent> = {}): FeeEvent {
  return {
    id: feeEventIdCounter++,
    userId: 1,
    orderId: null,
    tradeId: null,
    market: 'SOL-PERP',
    builderAuthority: 'BuiLdErAuthPubKey11111111111111111111111',
    builderPdaIndex: 0,
    builderSubaccountIndex: 0,
    notionalUsd: 1000 as unknown as FeeEvent['notionalUsd'],
    feeBps: 8,
    currency: 'USDC',
    expectedFeeUsd: 0.8 as unknown as FeeEvent['expectedFeeUsd'],
    confirmedFeeUsd: null,
    status: 'EXPECTED' as FeeEventStatus,
    builderTxSignature: null,
    failureReason: null,
    idempotencyKey: `idem-${feeEventIdCounter}`,
    createdAt: new Date(),
    confirmedAt: null,
    ...overrides,
  };
}

/**
 * An in-memory fake of FeeRepository's public surface. Real unit tests for
 * BuilderFeeService import this instead of the Prisma-backed repository -
 * see fee.repository mock wiring at the top of builder-fee.service.test.ts.
 */
export function createFakeFeeRepository() {
  let config = makeBuilderConfig();
  const events = new Map<number, FeeEvent>();
  const eventsByIdempotencyKey = new Map<string, number>();

  return {
    __state: { get config() { return config; }, events },

    getConfig: vi.fn(async () => config),

    updateConfig: vi.fn(async (data: Partial<BuilderConfig>) => {
      config = { ...config, ...data, updatedAt: new Date() };
      return config;
    }),

    verifyBuilderRegistration: vi.fn(),

    findByIdempotencyKey: vi.fn(async (key: string) => {
      const id = eventsByIdempotencyKey.get(key);
      return id ? events.get(id) ?? null : null;
    }),

    findByOrderId: vi.fn(async (orderId: number) =>
      [...events.values()].find((event) => event.orderId === orderId) ?? null,
    ),

    createExpected: vi.fn(async (data: Partial<FeeEvent> & { idempotencyKey: string }) => {
      const event = makeFeeEvent(data);
      events.set(event.id, event);
      eventsByIdempotencyKey.set(event.idempotencyKey, event.id);
      return event;
    }),

    markPending: vi.fn(async (id: number) => {
      const event = events.get(id)!;
      const updated = { ...event, status: 'PENDING' as FeeEventStatus };
      events.set(id, updated);
      return updated;
    }),

    markConfirmed: vi.fn(async (id: number, confirmedFeeUsd: number, builderTxSignature: string) => {
      const event = events.get(id)!;
      const updated = {
        ...event,
        status: 'CONFIRMED' as FeeEventStatus,
        confirmedFeeUsd: confirmedFeeUsd as unknown as FeeEvent['confirmedFeeUsd'],
        builderTxSignature,
        confirmedAt: new Date(),
      };
      events.set(id, updated);
      return updated;
    }),

    markFailed: vi.fn(async (id: number, failureReason: string) => {
      const event = events.get(id)!;
      const updated = { ...event, status: 'FAILED' as FeeEventStatus, failureReason };
      events.set(id, updated);
      return updated;
    }),

    markReconciliationRequired: vi.fn(async (id: number, failureReason: string) => {
      const event = events.get(id)!;
      const updated = { ...event, status: 'RECONCILIATION_REQUIRED' as FeeEventStatus, failureReason };
      events.set(id, updated);
      return updated;
    }),

    listByStatus: vi.fn(async (status: FeeEventStatus, limit = 100) => {
      return [...events.values()].filter((e) => e.status === status).slice(0, limit);
    }),

    listRecent: vi.fn(async (limit = 10) => {
      return [...events.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    }),

    sumConfirmedRevenue: vi.fn(async (sinceDate?: Date) => {
      return [...events.values()]
        .filter((e) => e.status === 'CONFIRMED' && (!sinceDate || (e.confirmedAt && e.confirmedAt >= sinceDate)))
        .reduce((sum, e) => sum + Number(e.confirmedFeeUsd ?? 0), 0);
    }),

    sumExpectedNotYetConfirmed: vi.fn(async (sinceDate?: Date) => {
      return [...events.values()]
        .filter(
          (e) => (e.status === 'EXPECTED' || e.status === 'PENDING') && (!sinceDate || e.createdAt >= sinceDate),
        )
        .reduce((sum, e) => sum + Number(e.expectedFeeUsd ?? 0), 0);
    }),

    sumFailedFees: vi.fn(async (sinceDate?: Date) => {
      return [...events.values()]
        .filter((e) => e.status === 'FAILED' && (!sinceDate || e.createdAt >= sinceDate))
        .reduce((sum, e) => sum + Number(e.expectedFeeUsd ?? 0), 0);
    }),

    countBySinceDate: vi.fn(async (sinceDate?: Date) => {
      return [...events.values()].filter((e) => !sinceDate || e.createdAt >= sinceDate).length;
    }),

    sumNotionalSince: vi.fn(async (sinceDate?: Date) => {
      return [...events.values()]
        .filter((e) => !sinceDate || e.createdAt >= sinceDate)
        .reduce((sum, e) => sum + Number(e.notionalUsd ?? 0), 0);
    }),
  };
}

export type FakeFeeRepository = ReturnType<typeof createFakeFeeRepository>;
