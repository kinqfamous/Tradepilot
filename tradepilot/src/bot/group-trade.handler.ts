import { Markup, Telegraf } from 'telegraf';
import { config } from '../config/env';
import { SCENE_IDS } from '../constants';
import { settingsService } from '../settings/settings.service';
import { marketQueryService } from '../trading/market-query.service';
import { tradingService } from '../trading/trading.service';
import { BotContext } from '../types/bot.types';
import { formatNumber, formatPercent } from '../utils/format';
import { exchangeAccountService } from '../users/exchange-account.service';
import { userRepository } from '../users/user.repository';
import { buildGroupTradeDeepLink } from './group-trade.util';
import { MarketInfo } from '../types/exchange.types';

async function isVerified(telegramId: number): Promise<{ ok: boolean; userId?: number }> {
  const user = await userRepository.findByTelegramId(BigInt(telegramId));
  if (!user || user.status !== 'ACTIVE') return { ok: false };
  const account = await exchangeAccountService.getActiveAccount(user.id, config.defaultExchange);
  return account?.status === 'VERIFIED' ? { ok: true, userId: user.id } : { ok: false };
}

function verifyPrompt(side: 'LONG' | 'SHORT', rawTicker: string) {
  return {
    text: `To ${side.toLowerCase()} ${rawTicker}, verify your account in a private chat first.`,
    extra: Markup.inlineKeyboard([
      Markup.button.url('🔗 Verify & Get Started', buildGroupTradeDeepLink(side, rawTicker)),
    ]),
  };
}

async function handleDirectInstruction(
  ctx: BotContext,
  market: MarketInfo,
  side: 'LONG' | 'SHORT',
  rawTicker: string,
): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId) return;
  const verified = await isVerified(fromId);
  if (!verified.ok || !verified.userId) {
    const prompt = verifyPrompt(side, rawTicker);
    await ctx.reply(prompt.text, prompt.extra);
    return;
  }
  const settings = await settingsService.get(verified.userId);
  await ctx.reply(
    `🔍 *Confirm ${side} ${market.symbol}*\n\n` +
      `Collateral: $${settings.defaultCollateralUsd}\n` +
      `Leverage: ${settings.defaultLeverage}x\n` +
      `Mark price: $${formatNumber(market.markPrice)}\n\n` +
      `<a href="tg://user?id=${fromId}">Only this user</a> can confirm this trade.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirm', `gtconfirm|${fromId}|${side}|${market.symbol}`),
        Markup.button.callback('❌ Cancel', `gtcancel|${fromId}`),
      ]),
    },
  );
}

function isOwner(ctx: BotContext, telegramId: number): boolean {
  return ctx.from?.id === telegramId;
}

async function rejectNonOwner(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery("This confirmation isn't yours.", { show_alert: true });
}

export function registerGroupTradeHandlers(bot: Telegraf<BotContext>): void {
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next();

    const market = await findMentionedMarket(text);
    if (!market) return next();

    const side = inferSide(text);
    if (side) {
      if (ctx.chat?.type === 'private') {
        if (!ctx.appUserId) {
          await ctx.reply('Send /start first to set up your trading account.');
          return;
        }
        return ctx.scene.enter(SCENE_IDS.TRADE, { exchange: config.defaultExchange, market: market.symbol, side });
      }
      await handleDirectInstruction(ctx, market, side, market.baseAsset);
      return;
    }
    await showMarketPrompt(ctx, market);
  });

  bot.action(/^grouptrade\|(LONG|SHORT)\|(.+)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery) || !ctx.from) return;
    const match = /^grouptrade\|(LONG|SHORT)\|(.+)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    const side = match[1] as 'LONG' | 'SHORT';
    const symbol = match[2];
    if (ctx.chat?.type === 'private') {
      if (!ctx.appUserId) return ctx.reply('Send /start first to set up your trading account.');
      return ctx.scene.enter(SCENE_IDS.TRADE, { exchange: config.defaultExchange, market: symbol, side });
    }
    const verified = await isVerified(ctx.from.id);
    if (!verified.ok) {
      const prompt = verifyPrompt(side, symbol);
      await ctx.reply(prompt.text, prompt.extra);
      return;
    }
    try {
      await ctx.telegram.sendMessage(ctx.from.id, `Ready to ${side.toLowerCase()} ${symbol}?`, {
        ...Markup.inlineKeyboard([Markup.button.callback('▶️ Continue', `continue_trade|${side}|${symbol}`)]),
      });
      await ctx.reply('📩 I sent you a private message to continue your trade.');
    } catch {
      await ctx.reply('Please start a private chat with me first.', Markup.inlineKeyboard([
        Markup.button.url('Open TradePilot', `https://t.me/${config.telegram.botUsername}`),
      ]));
    }
  });

  bot.action(/^continue_trade\|(LONG|SHORT)\|(.+)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^continue_trade\|(LONG|SHORT)\|(.+)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    return ctx.scene.enter(SCENE_IDS.TRADE, { exchange: config.defaultExchange, market: match[2], side: match[1] });
  });

  bot.action(/^gtconfirm\|(\d+)\|(LONG|SHORT)\|(.+)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^gtconfirm\|(\d+)\|(LONG|SHORT)\|(.+)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    const telegramId = Number(match[1]);
    if (!isOwner(ctx, telegramId)) return rejectNonOwner(ctx);
    await ctx.answerCbQuery();
    const user = await userRepository.findByTelegramId(BigInt(telegramId));
    if (!user) return;
    const settings = await settingsService.get(user.id);
    await ctx.reply('⏳ Submitting trade...');
    const result = await tradingService.open({
      userId: user.id,
      exchange: config.defaultExchange,
      market: match[3],
      side: match[2] as 'LONG' | 'SHORT',
      collateralUsd: Number(settings.defaultCollateralUsd),
      leverage: Number(settings.defaultLeverage),
      orderType: 'MARKET',
    });
    await ctx.reply(result.status === 'REJECTED'
      ? `❌ Trade failed: ${result.errorMessage}`
      : `✅ ${match[2]} ${match[3]} submitted at ${settings.defaultLeverage}x.`);
  });

  bot.action(/^gtcancel\|(\d+)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^gtcancel\|(\d+)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    if (!isOwner(ctx, Number(match[1]))) return rejectNonOwner(ctx);
    await ctx.answerCbQuery();
    await ctx.reply('Cancelled.');
  });
}

const TICKER_ALIASES: Record<string, string> = {
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
};

function inferSide(text: string): 'LONG' | 'SHORT' | undefined {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.some((word) => word === 'long' || word === 'buy')) return 'LONG';
  if (words.some((word) => word === 'short' || word === 'sell')) return 'SHORT';
  return undefined;
}

async function findMentionedMarket(text: string): Promise<MarketInfo | null> {
  const candidates = text.match(/\$?[a-z0-9]+(?:-[a-z0-9]+)?/gi) ?? [];
  if (candidates.length === 0) return null;

  const markets = await marketQueryService.listMarkets(config.defaultExchange);
  for (const candidate of candidates) {
    const normalized = candidate.replace(/^\$/, '').toUpperCase();
    const asset = TICKER_ALIASES[normalized] ?? normalized;
    const symbol = asset.endsWith('-PERP') ? asset : `${asset}-PERP`;
    const market = markets.find((item) => item.symbol === symbol || item.baseAsset.toUpperCase() === asset);
    if (market) return market;
  }
  return null;
}

async function showMarketPrompt(ctx: BotContext, market: MarketInfo): Promise<void> {
  await ctx.reply(
    `📈 *${market.symbol}*\n\n` +
      `Mark price: *$${formatNumber(market.markPrice)}*\n` +
      `Funding: ${formatPercent(market.fundingRate * 100)}\n` +
      `Max leverage: ${market.maxLeverage}x\n\n` +
      'Would you like to go long or short?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('🟢 Long', `grouptrade|LONG|${market.symbol}`),
        Markup.button.callback('🔴 Short', `grouptrade|SHORT|${market.symbol}`),
      ]),
    },
  );
}
