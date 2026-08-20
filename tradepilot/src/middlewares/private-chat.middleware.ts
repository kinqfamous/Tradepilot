import { Markup, MiddlewareFn } from 'telegraf';
import { config } from '../config/env';
import { BotContext } from '../types/bot.types';

const PUBLIC_COMMAND = /^\/(?:help|markets|pnl|positions)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const PUBLIC_CALLBACK = /^(?:markets_page_\d+|grouptrade\|(?:LONG|SHORT)\|[A-Z0-9-]+)$/;
const PUBLIC_REPLY_BUTTONS = new Set(['📊 Positions', '🌐 Markets', '📜 PnL']);
const PRIVATE_REPLY_BUTTONS = new Set([
  '🏠 Start',
  '📈 Trade',
  '💰 Balance',
  '💸 Withdraw',
  '➕ Fund Phoenix',
  '⚙️ Settings',
  '📜 History',
]);

/**
 * Public chats may display market data plus the requesting user's positions
 * and PnL. Every action that exposes credentials, changes account state, or
 * signs a transaction must continue in a private chat.
 */
export function isPublicChatUpdateAllowed(text?: string, callbackData?: string): boolean {
  if (callbackData !== undefined) return PUBLIC_CALLBACK.test(callbackData);
  if (text === undefined) return false;
  if (PUBLIC_COMMAND.test(text) || PUBLIC_REPLY_BUTTONS.has(text)) return true;
  if (text.startsWith('/')) return false;
  return !PRIVATE_REPLY_BUTTONS.has(text);
}

export const privateChatOnly: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat?.type === 'private') return next();

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : undefined;
  const callbackData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  if (isPublicChatUpdateAllowed(text, callbackData)) return next();

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('Continue this action in a private chat.', { show_alert: true });
    return;
  }

  const username = config.telegram.botUsername.replace(/^@/, '');
  await ctx.reply(
    '🔒 This action is only available in a private chat with TradePilot.',
    Markup.inlineKeyboard([Markup.button.url('Open TradePilot Privately', `https://t.me/${username}`)]),
  );
};
