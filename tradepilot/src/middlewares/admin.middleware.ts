import { MiddlewareFn } from 'telegraf';
import { config } from '../config/env';
import { BotContext } from '../types/bot.types';
import { log } from '../logger/logger';

/** Pure, dependency-free check - kept separate from the middleware so admin-permission logic is testable without booting the full app config. */
export function isAdminId(fromId: number | undefined, adminIds: number[]): boolean {
  return Boolean(fromId) && adminIds.includes(fromId as number);
}

export const adminOnly: MiddlewareFn<BotContext> = async (ctx, next) => {
  const fromId = ctx.from?.id;

  if (!isAdminId(fromId, config.telegram.adminIds)) {
    await log.warn('ADMIN', 'Blocked admin command from non-admin user', { fromId });
    await ctx.reply('This command is restricted to platform administrators.');
    return;
  }

  return next();
};
