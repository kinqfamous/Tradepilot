import { prisma } from '../database/prisma';
import { UserSettings, OrderType, Prisma } from '@prisma/client';
import { MAX_LEVERAGE_HARD_CAP, MIN_LEVERAGE } from '../constants';
import { log } from '../logger/logger';

export class SettingsService {
  async get(userId: number): Promise<UserSettings & { defaultCollateralUsd: Prisma.Decimal }> {
    const existing = await prisma.userSettings.findUnique({ where: { userId } });
    if (existing) return existing as UserSettings & { defaultCollateralUsd: Prisma.Decimal };
    const created = await prisma.userSettings.create({ data: { userId } });
    return created as UserSettings & { defaultCollateralUsd: Prisma.Decimal };
  }

  async setDefaultLeverage(userId: number, leverage: number): Promise<UserSettings> {
    if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE_HARD_CAP) {
      throw new Error(`Leverage must be between ${MIN_LEVERAGE}x and ${MAX_LEVERAGE_HARD_CAP}x.`);
    }
    const updated = await prisma.userSettings.update({ where: { userId }, data: { defaultLeverage: leverage } });
    await log.info('SYSTEM', 'Updated default leverage', { userId, leverage });
    return updated;
  }

  async setDefaultSlippage(userId: number, slippageBps: number): Promise<UserSettings> {
    if (slippageBps <= 0 || slippageBps > 5000) {
      throw new Error('Slippage must be between 1 and 5000 basis points (0.01%-50%).');
    }
    return prisma.userSettings.update({ where: { userId }, data: { defaultSlippageBps: slippageBps } });
  }

  async setDefaultOrderType(userId: number, orderType: OrderType): Promise<UserSettings> {
    return prisma.userSettings.update({ where: { userId }, data: { defaultOrderType: orderType } });
  }

  async setLanguage(userId: number, language: string): Promise<UserSettings> {
    return prisma.userSettings.update({ where: { userId }, data: { language } });
  }

  async setTimezone(userId: number, timezone: string): Promise<UserSettings> {
    return prisma.userSettings.update({ where: { userId }, data: { timezone } });
  }

  async toggleNotifications(userId: number): Promise<UserSettings> {
    const current = await this.get(userId);
    return prisma.userSettings.update({
      where: { userId },
      data: { notificationsOn: !current.notificationsOn },
    });
  }

  async setPreferredExchange(userId: number, exchange: string): Promise<UserSettings> {
    return prisma.userSettings.update({ where: { userId }, data: { preferredExchange: exchange } });
  }

  async setMaxLeverage(userId: number, maxLeverage: number): Promise<UserSettings> {
    if (maxLeverage < MIN_LEVERAGE || maxLeverage > MAX_LEVERAGE_HARD_CAP) {
      throw new Error(`Max leverage must be between ${MIN_LEVERAGE}x and ${MAX_LEVERAGE_HARD_CAP}x.`);
    }
    return prisma.userSettings.update({ where: { userId }, data: { maxLeverage } });
  }

  async setDefaultCollateralUsd(userId: number, amountUsd: number): Promise<UserSettings & { defaultCollateralUsd: Prisma.Decimal }> {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error('Default collateral must be a positive USD amount.');
    }
    const updated = await prisma.userSettings.update({
      where: { userId },
      // Cast keeps this branch buildable until the local Prisma client is regenerated after migration.
      data: { defaultCollateralUsd: amountUsd } as any,
    });
    await log.info('SYSTEM', 'Updated default group-trade collateral', { userId, amountUsd });
    return updated as UserSettings & { defaultCollateralUsd: Prisma.Decimal };
  }
}

export const settingsService = new SettingsService();
