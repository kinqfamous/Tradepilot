import { session, Scenes } from 'telegraf';
import { BotContext } from '../types/bot.types';

export function createSessionMiddleware() {
  return session<BotContext['session'], BotContext>({
    defaultSession: () => ({} as BotContext['session']),
  });
}
