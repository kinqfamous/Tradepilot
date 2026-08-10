import { prisma } from '../database/prisma';
import { SystemState, TradingMode } from '@prisma/client';
import { log } from '../logger/logger';

export class SystemStateService {
  async get(): Promise<SystemState> {
    const existing = await prisma.systemState.findFirst();
    if (existing) return existing;
    return prisma.systemState.create({ data: { mode: 'NORMAL' } });
  }

  async setMode(mode: TradingMode, changedBy: number, reason?: string): Promise<SystemState> {
    const current = await this.get();
    const updated = await prisma.systemState.update({
      where: { id: current.id },
      data: { mode, changedBy, reason },
    });
    await log.warn('ADMIN', `Trading mode changed to ${mode}`, { changedBy, reason });
    return updated;
  }

  async setPhoenixReferralCodeRequired(required: boolean, changedBy: number): Promise<SystemState> {
    const current = await this.get();
    // Raw SQL keeps this compatible with a running process whose Prisma
    // client was generated before this additive migration; regenerate the
    // client as part of normal deployment nevertheless.
    await prisma.$executeRaw`
      UPDATE "SystemState"
      SET "requirePhoenixReferralCode" = ${required}, "changedBy" = ${changedBy}
      WHERE "id" = ${current.id}
    `;
    await log.warn('ADMIN', `Phoenix referral-code gate ${required ? 'enabled' : 'disabled'}`, { changedBy });
    return this.get();
  }

  async canTrade(): Promise<{ allowed: boolean; reason?: string }> {
    const state = await this.get();
    if (state.mode === 'NORMAL') return { allowed: true };
    if (state.mode === 'READ_ONLY') {
      return { allowed: false, reason: 'The platform is in read-only mode. New trades are temporarily disabled.' };
    }
    if (state.mode === 'MAINTENANCE') {
      return { allowed: false, reason: 'The platform is under maintenance. Please try again shortly.' };
    }
    return { allowed: false, reason: '🛑 Emergency stop is active. All trading is halted.' };
  }

  async canRead(): Promise<boolean> {
    const state = await this.get();
    return state.mode !== 'MAINTENANCE';
  }
}

export const systemStateService = new SystemStateService();
