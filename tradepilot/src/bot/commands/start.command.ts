import { BotContext } from '../../types/bot.types';
import { userService } from '../../users/user.service';
import { userRepository } from '../../users/user.repository';
import { exchangeAccountService } from '../../users/exchange-account.service';
import { config } from '../../config/env';
import { SCENE_IDS } from '../../constants';
import { dashboardKeyboard, phoenixRegistrationKeyboard } from '../keyboards';
import { phoenixReferralService } from '../../exchange/phoenix/phoenix-referral.service';
import { marketQueryService } from '../../trading/market-query.service';
import { formatNumber, formatUsd } from '../../utils/format';
import { MarketInfo } from '../../types/exchange.types';
import { parseGroupTradeDeepLink } from '../group-trade.util';
import { accountBalanceService } from '../../users/account-balance.service';
import { tradingRepository } from '../../trading/trading.repository';

export async function startCommand(ctx: BotContext): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  const payload = (ctx as BotContext & { startPayload?: string }).startPayload;
  const groupTrade = parseGroupTradeDeepLink(payload);
  const referralCode = !groupTrade && payload && payload.length > 0 ? payload : undefined;

  const user = await userService.getOrCreate(fromId, ctx.from?.username, referralCode);
  ctx.appUserId = user.id;

  const resolvedGroupTradeMarket = groupTrade
    ? await marketQueryService.resolveTicker(config.defaultExchange, groupTrade.rawTicker)
    : null;
  if (groupTrade && !resolvedGroupTradeMarket) {
    await ctx.reply(`Unknown ticker "${groupTrade.rawTicker}". Opening the normal menu instead.`);
  }

  const exchangeAccount = await exchangeAccountService.getActiveAccount(user.id, config.defaultExchange);
  const requiresPhoenixReferral =
    config.defaultExchange === 'phoenix' &&
    (await phoenixReferralService.isRequired()) &&
    (!exchangeAccount || !(await phoenixReferralService.hasActivatedReferral(exchangeAccount.id)));

  // A pending wallet from an earlier attempt must not bypass the Phoenix gate.
  // This intentionally does not depend on UserStatus: older users may already
  // be ACTIVE while their wallet is still pending registration.
  if (!exchangeAccount || requiresPhoenixReferral || user.status === 'ONBOARDING') {
    await ctx.scene.enter(
      SCENE_IDS.ONBOARDING,
      resolvedGroupTradeMarket && groupTrade
        ? { pendingTrade: { market: resolvedGroupTradeMarket.symbol, side: groupTrade.side } }
        : undefined,
    );
    return;
  }

  if (resolvedGroupTradeMarket && groupTrade) {
    await ctx.scene.enter(SCENE_IDS.TRADE, {
      exchange: config.defaultExchange,
      market: resolvedGroupTradeMarket.symbol,
      side: groupTrade.side,
    });
    return;
  }

  if (!exchangeAccount || exchangeAccount.status !== 'VERIFIED') {
    await ctx.reply(
      '🔗 Your wallet is connected, but Phoenix trader registration is pending.\n\n' +
      `Wallet: \`${exchangeAccount?.walletAddress ?? 'not linked'}\`\n\n` +
      'Fund this wallet with at least 0.04 SOL, then tap below. The registration rent and network fee are paid from your wallet.',
      { parse_mode: 'Markdown', ...phoenixRegistrationKeyboard },
    );
    return;
  }

  await ctx.reply(await buildDashboard(user.id, exchangeAccount.walletAddress), {
    parse_mode: 'Markdown',
    ...dashboardKeyboard(user.id),
  });
}

export async function refreshDashboard(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const match = /^dashboard_refresh_(\d+)$/.exec(ctx.callbackQuery.data);
  if (!match || Number(match[1]) !== ctx.appUserId) {
    await ctx.answerCbQuery('This dashboard belongs to another user.', { show_alert: true });
    return;
  }
  await ctx.answerCbQuery('Refreshing…');
  const account = await exchangeAccountService.getActiveAccount(ctx.appUserId, config.defaultExchange);
  if (!account || account.status !== 'VERIFIED') {
    await ctx.reply('Your Phoenix account is not ready. Send /start to continue setup.');
    return;
  }
  try {
    await ctx.editMessageText(await buildDashboard(ctx.appUserId, account.walletAddress, true), {
      parse_mode: 'Markdown',
      ...dashboardKeyboard(ctx.appUserId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('message is not modified')) throw error;
  }
}

async function buildDashboard(userId: number, walletAddress: string, forceMarketRefresh = false): Promise<string> {
  const [balancesResult, positionsResult, walletResult, marketsResult, protectionsResult] = await Promise.allSettled([
    marketQueryService.getBalances(userId, config.defaultExchange),
    marketQueryService.getOpenPositions(userId, config.defaultExchange),
    accountBalanceService.getWalletBalances(userId, config.defaultExchange),
    marketQueryService.listMarkets(config.defaultExchange, forceMarketRefresh),
    tradingRepository.listActiveProtections(userId, config.defaultExchange),
  ]);

  const phoenixPhusd = balancesResult.status === 'fulfilled'
    ? balancesResult.value.find((balance) => balance.asset === 'PhUSD')?.total ?? 0
    : null;
  const wallet = walletResult.status === 'fulfilled' ? walletResult.value : null;
  const pnl = positionsResult.status === 'fulfilled'
    ? positionsResult.value.reduce((total, position) => total + position.unrealizedPnl, 0)
    : null;
  const openTrades = positionsResult.status === 'fulfilled' ? positionsResult.value : null;
  const markets = marketsResult.status === 'fulfilled' ? marketsResult.value : null;
  const protections = protectionsResult.status === 'fulfilled' ? protectionsResult.value : [];

  return [
    '👋 *Welcome back to TradePilot*',
    '',
    '💼 *Your Wallet Account*',
    `Address: \`${walletAddress}\``,
    `SOL: ${wallet ? wallet.sol.toFixed(6) : 'Unavailable'}`,
    `USDC: ${wallet ? formatUsd(wallet.usdc) : 'Unavailable'}`,
    '',
    '🏦 *Your Phoenix Account*',
    `PhUSD Collateral: ${phoenixPhusd === null ? 'Unavailable' : formatUsd(phoenixPhusd)}`,
    `Open PnL: ${pnl === null ? 'Unavailable' : formatSignedUsd(pnl)}`,
    '📊 *Open Positions*',
    formatOpenTrades(openTrades, protections),
    '',
    '📈 *Top 3 Market Gainers — 24h*',
    formatMarketSection(markets, 'gainers'),
    '',
    '📉 *Top 3 Market Losers — 24h*',
    formatMarketSection(markets, 'losers'),
    '',
    '💡 Use the menu below to trade, manage positions, fund your account, and access other TradePilot features.',
  ].join('\n');
}

function formatSignedUsd(amount: number): string {
  const emoji = amount >= 0 ? '🟢' : '🔴';
  return `${emoji} ${amount >= 0 ? '+' : '-'}${formatUsd(Math.abs(amount))}`;
}

function formatOpenTrades(
  positions: Awaited<ReturnType<typeof marketQueryService.getOpenPositions>> | null,
  protections: Awaited<ReturnType<typeof tradingRepository.listActiveProtections>>,
): string {
  if (positions === null) return 'Unavailable';
  if (positions.length === 0) return 'None';
  return positions
    .map((position) => {
      const protection = protections.filter((order) => order.market === position.market);
      const stopLoss = protection.find((order) => order.type === 'STOP_LOSS')?.triggerPrice;
      const takeProfit = protection.find((order) => order.type === 'TAKE_PROFIT')?.triggerPrice;
      return [
        `${position.side === 'LONG' ? '🟢 Long' : '🔴 Short'} *${position.market}*`,
        `Entry: $${formatNumber(position.entryPrice)} | Size: ${formatNumber(position.size)}`,
        `Liq. Price: ${position.liquidationPrice === null ? 'Unavailable' : `$${formatNumber(position.liquidationPrice)}`}`,
        `SL: ${stopLoss === null || stopLoss === undefined ? 'None' : `$${formatNumber(Number(stopLoss))}`}`,
        `TP: ${takeProfit === null || takeProfit === undefined ? 'None' : `$${formatNumber(Number(takeProfit))}`}`,
      ].join(' | ');
    })
    .join('\n');
}

function formatMarketSection(markets: MarketInfo[] | null, kind: 'gainers' | 'losers'): string {
  if (!markets) return 'Market data is unavailable right now.';
  const selected = markets
    .filter((market) => Number.isFinite(market.markPrice) && Number.isFinite(market.priceChange24hPercent))
    .filter((market) => kind === 'gainers' ? market.priceChange24hPercent > 0 : market.priceChange24hPercent < 0)
    .sort((left, right) => kind === 'gainers'
      ? right.priceChange24hPercent - left.priceChange24hPercent
      : left.priceChange24hPercent - right.priceChange24hPercent)
    .slice(0, 3);
  if (selected.length === 0) return `No ${kind} available right now.`;
  return selected.map((market) => {
    const emoji = market.priceChange24hPercent >= 0 ? '🟢' : '🔴';
    const change = `${market.priceChange24hPercent >= 0 ? '+' : ''}${market.priceChange24hPercent.toFixed(2)}%`;
    return `${emoji} *${market.baseAsset}*  ${formatMarketPrice(market.markPrice)}  ${change}`;
  }).join('\n');
}

function formatMarketPrice(price: number): string {
  return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: price < 1 ? 8 : 2 })}`;
}

export async function helpCommand(ctx: BotContext): Promise<void> {
  return startCommand(ctx);
}

// Re-export for the identify middleware's early-registration edge case.
export { userRepository };
