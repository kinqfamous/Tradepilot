import { MiddlewareFn } from 'telegraf';
import { config } from '../config/env';
import { BotContext } from '../types/bot.types';
import { log } from '../logger/logger';

export const adminOnly: MiddlewareFn<BotContext> = async (ctx, next) => {
  const fromId = ctx.from?.id;

  if (!fromId || !config.telegram.adminIds.includes(fromId)) {
    await log.warn('ADMIN', 'Blocked admin command from non-admin user', { fromId });
    await ctx.reply('This command is restricted to platform administrators.');
    return;
  }

  return next();
};
