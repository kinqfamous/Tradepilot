import { MiddlewareFn } from 'telegraf';
import { BotContext } from '../types/bot.types';
import { log } from '../logger/logger';

export const errorBoundary: MiddlewareFn<BotContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await log.error('SYSTEM', 'Unhandled error in update handler', {
      errorMessage,
      errorStack: error instanceof Error ? error.stack : undefined,
      updateType: ctx.updateType,
    });

    try {
      await ctx.reply(`⚠️ Something went wrong: ${errorMessage}`);
    } catch {
      // Nothing more we can do if even the reply fails.
    }
  }
};
