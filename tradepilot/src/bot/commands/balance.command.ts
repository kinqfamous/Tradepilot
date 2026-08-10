import { BotContext } from '../../types/bot.types';
import { marketQueryService } from '../../trading/market-query.service';
import { config } from '../../config/env';
import { formatUsd } from '../../utils/format';

export async function balanceCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const balances = await marketQueryService.getBalances(ctx.appUserId, config.defaultExchange);

    if (balances.length === 0) {
      await ctx.reply('💰 No balances found. Fund your linked wallet to get started.');
      return;
    }

    const text = balances
      .map((b) => `*${b.asset}*: ${formatUsd(b.total)} (available: ${formatUsd(b.available)}, in margin: ${formatUsd(b.usedMargin)})`)
      .join('\n');

    await ctx.reply(`💰 *Balance*\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
