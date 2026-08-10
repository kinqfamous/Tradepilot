import { MiddlewareFn } from 'telegraf';
import { systemStateService } from '../admin/system-state.service';
import { BotContext } from '../types/bot.types';

/**
 * Blocks everything during full MAINTENANCE mode. READ_ONLY and
 * EMERGENCY_STOP still allow reads (balance/positions/markets/history) -
 * those modes are enforced authoritatively inside TradingService itself
 * (open/close/closeAll), since trade-mutating actions can be triggered
 * from several different UI entry points (commands, reply-keyboard
 * buttons, inline callbacks) and the single source of truth should be
 * the service that actually executes the trade, not a middleware trying
 * to guess intent from callback data.
 */
export const maintenanceGate: MiddlewareFn<BotContext> = async (ctx, next) => {
  const canRead = await systemStateService.canRead();
  if (!canRead) {
    await ctx.reply('🛠️ The platform is under maintenance. Please try again shortly.');
    return;
  }
  return next();
};
