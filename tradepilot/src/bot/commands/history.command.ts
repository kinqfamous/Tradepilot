import { BotContext } from '../../types/bot.types';
import { tradingRepository } from '../../trading/trading.repository';
import { formatUsd } from '../../utils/format';

export async function historyCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  const trades = await tradingRepository.listRecentTrades(ctx.appUserId, 10);

  if (trades.length === 0) {
    await ctx.reply('📜 No trade history yet.');
    return;
  }

  const text = trades
    .map(
      (t) =>
        `${t.side === 'BUY' ? '🟢' : '🔴'} *${t.market}* - ${t.side} ${Number(t.size).toFixed(4)} @ ${Number(t.price).toFixed(4)}\n` +
        `Fee: ${formatUsd(Number(t.feePaid))} | ${t.executedAt.toLocaleString()}`,
    )
    .join('\n\n');

  await ctx.reply(`📜 *Recent Trades*\n\n${text}`, { parse_mode: 'Markdown' });
}
