import { BotContext } from '../../types/bot.types';
import { marketQueryService } from '../../trading/market-query.service';
import { config } from '../../config/env';
import { formatNumber, formatPercent, formatUsd } from '../../utils/format';
import { paginationKeyboard } from '../keyboards';
import { DEFAULT_PAGE_SIZE } from '../../constants';

async function renderMarketsPage(ctx: BotContext, page: number, edit: boolean): Promise<void> {
  const markets = await marketQueryService.listMarkets(config.defaultExchange);
  const start = page * DEFAULT_PAGE_SIZE;
  const pageMarkets = markets.slice(start, start + DEFAULT_PAGE_SIZE);
  const hasNext = start + DEFAULT_PAGE_SIZE < markets.length;

  if (pageMarkets.length === 0) {
    await ctx.reply('No markets found.');
    return;
  }

  const text = pageMarkets
    .map(
      (m) =>
        `*${m.symbol}*\n` +
        `Price: ${formatUsd(m.markPrice)} | ${m.priceChange24hPercent > 0 ? '🟢' : m.priceChange24hPercent < 0 ? '🔴' : '⚪'} 24h: ${formatPercent(m.priceChange24hPercent)}\n` +
        `Funding: ${formatPercent(m.fundingRate * 100)} | OI: ${formatNumber(m.openInterest, 0)}\n` +
        `Max Leverage: ${m.maxLeverage}x`,
    )
    .join('\n\n');

  const extra = { parse_mode: 'Markdown' as const, ...paginationKeyboard(page, hasNext, 'markets') };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(`🌐 *Markets* (page ${page + 1})\n\n${text}`, extra);
  } else {
    await ctx.reply(`🌐 *Markets* (page ${page + 1})\n\n${text}`, extra);
  }
}

export async function marketsCommand(ctx: BotContext): Promise<void> {
  await renderMarketsPage(ctx, 0, false);
}

export async function handleMarketsPagination(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const match = /^markets_page_(\d+)$/.exec(ctx.callbackQuery.data);
  if (!match) return;
  await renderMarketsPage(ctx, Number(match[1]), true);
}
