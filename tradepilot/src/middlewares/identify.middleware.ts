import { MiddlewareFn } from 'telegraf';
import { BotContext } from '../types/bot.types';
import { userRepository } from '../users/user.repository';

/**
 * Runs after /start has had a chance to register the user. If no user
 * exists yet (e.g. someone sends a command before /start), we don't
 * silently create one here - registration is explicit and goes through
 * onboarding (terms acceptance, etc.) in the /start flow.
 */
export const identify: MiddlewareFn<BotContext> = async (ctx, next) => {
  const fromId = ctx.from?.id;
  if (fromId) {
    const user = await userRepository.findByTelegramId(BigInt(fromId));
    if (user) ctx.appUserId = user.id;
  }
  return next();
};
