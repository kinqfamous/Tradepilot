import { BotContext } from '../../types/bot.types';
import { marketQueryService } from '../../trading/market-query.service';
import { config } from '../../config/env';
import { formatNumber, formatPercent, formatUsd } from '../../utils/format';
import { Markup } from 'telegraf';
import { tradingRepository } from '../../trading/trading.repository';

export async function positionsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const [positions, pendingLimits] = await Promise.all([
      marketQueryService.getOpenPositions(ctx.appUserId, config.defaultExchange),
      tradingRepository.listUserPendingLimitOrders(ctx.appUserId, config.defaultExchange),
    ]);

    if (positions.length === 0 && pendingLimits.length === 0) {
      await ctx.reply('📊 You have no open positions or pending limit orders.');
      return;
    }

    const openPositionsText = positions
      .map((p) => {
        const pnlEmoji = p.unrealizedPnl >= 0 ? '🟢' : '🔴';
        return (
          `${pnlEmoji} *${p.market}* - ${p.side} ${p.leverage}x\n` +
          `Margin Type: ${p.marginMode === 'ISOLATED' ? 'Isolated' : 'Cross'}\n` +
          `Entry: ${p.entryPrice} | Mark: ${p.markPrice}\n` +
          `Size: ${p.size} | Margin: ${formatUsd(p.margin)}\n` +
          `PnL: ${formatUsd(p.unrealizedPnl)} (${formatPercent(p.roePercent)})\n` +
          `Liq. Price: ${p.liquidationPrice === null ? 'Unavailable' : `$${formatNumber(p.liquidationPrice)}`}\n` +
          `Funding Paid: ${formatUsd(p.fundingPaid)}`
        );
      })
      .join('\n\n');

    const pendingLimitsText = pendingLimits
      .map((order) => {
        const direction = order.side === 'BUY' ? 'LONG' : 'SHORT';
        return (
          `🕒 *${order.market}* - ${direction} ${formatNumber(Number(order.leverage), 2)}x\n` +
          `Limit Price: $${formatNumber(Number(order.price))}\n` +
          `Size: ${formatNumber(Number(order.size))} | Status: ${order.status.replace('_', ' ')}`
        );
      })
      .join('\n\n');

    const sections = [
      positions.length > 0 ? `*Open Positions*\n\n${openPositionsText}` : '',
      pendingLimits.length > 0 ? `*Pending Limit Orders*\n\n${pendingLimitsText}` : '',
    ].filter(Boolean).join('\n\n──────────\n\n');

    const controls = ctx.chat?.type === 'private'
      ? Markup.inlineKeyboard([
          ...positions.flatMap((position) => [
            [Markup.button.callback(`⚙️ ${position.market} actions`, `position_actions|${position.market}`)],
          ]),
          ...pendingLimits.flatMap((order) => [[
            Markup.button.callback(`✏️ Edit ${order.market}`, `limit_edit_menu|${order.id}`),
            Markup.button.callback(`❌ Cancel ${order.market}`, `limit_cancel_request|${order.id}`),
          ]]),
          ...(positions.length > 1
            ? [[Markup.button.callback('🛑 Close All Positions', 'close_all_request')]]
            : []),
        ])
      : {};

    await ctx.reply(`📊 *Positions & Orders*\n\n${sections}`, {
      parse_mode: 'Markdown',
      ...controls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
