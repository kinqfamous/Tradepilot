import { BotContext } from '../../types/bot.types';
import { marketQueryService } from '../../trading/market-query.service';
import { config } from '../../config/env';
import { formatPercent, formatUsd } from '../../utils/format';
import { Markup } from 'telegraf';

export async function positionsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const positions = await marketQueryService.getOpenPositions(ctx.appUserId, config.defaultExchange);

    if (positions.length === 0) {
      await ctx.reply('📊 You have no open positions.');
      return;
    }

    const text = positions
      .map((p) => {
        const pnlEmoji = p.unrealizedPnl >= 0 ? '🟢' : '🔴';
        return (
          `${pnlEmoji} *${p.market}* - ${p.side} ${p.leverage}x\n` +
          `Entry: ${p.entryPrice} | Mark: ${p.markPrice}\n` +
          `Size: ${p.size} | Margin: ${formatUsd(p.margin)}\n` +
          `PnL: ${formatUsd(p.unrealizedPnl)} (${formatPercent(p.roePercent)})\n` +
          `Liq. Price: ${p.liquidationPrice ?? 'N/A'}\n` +
          `Funding Paid: ${formatUsd(p.fundingPaid)}`
        );
      })
      .join('\n\n');

    await ctx.reply(`📊 *Open Positions*\n\n${text}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(
        positions.map((position) => [Markup.button.callback(`🔴 Close 100% ${position.market}`, `close_position|${position.market}|100`)]),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
