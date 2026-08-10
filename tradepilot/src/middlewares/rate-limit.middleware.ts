import { MiddlewareFn } from 'telegraf';
import { redis } from '../database/redis';
import { config } from '../config/env';
import { BotContext } from '../types/bot.types';
import { log } from '../logger/logger';

/**
 * Fixed-window rate limiter keyed per Telegram user. Uses a Redis INCR +
 * EXPIRE pair so it works correctly across multiple bot process instances,
 * not just in-memory per-process counters.
 */
export const rateLimit: MiddlewareFn<BotContext> = async (ctx, next) => {
  const fromId = ctx.from?.id;
  if (!fromId) return next();

  const key = `ratelimit:${fromId}`;
  const windowSeconds = Math.ceil(config.rateLimit.windowMs / 1000);

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (count > config.rateLimit.maxRequests) {
    await log.warn('SYSTEM', 'Rate limit exceeded', { fromId, count });
    await ctx.reply('⏳ You are sending requests too quickly. Please slow down and try again shortly.');
    return;
  }

  return next();
};
