import { Scenes } from 'telegraf';
import { BotContext, TradeWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { tradingService } from '../../trading/trading.service';
import { settingsService } from '../../settings/settings.service';
import { marketQueryService } from '../../trading/market-query.service';
import { formatNumber, parseTickerInput } from '../../utils/format';
import { confirmCancelKeyboard, mainMenuKeyboard, orderTypeKeyboard, sideKeyboard, skipKeyboard } from '../keyboards';
import { config } from '../../config/env';
import { parseOrError, usdAmountSchema, leverageSchema, priceSchema } from '../../validators/trade.validators';

function state(ctx: BotContext): TradeWizardState {
  return ctx.wizard.state as TradeWizardState;
}

async function currentMarkPriceText(exchange: string, symbol?: string): Promise<string> {
  if (!symbol) return '';
  try {
    const market = (await marketQueryService.listMarkets(exchange, true))
      .find((candidate) => candidate.symbol === symbol);
    return market && Number.isFinite(market.markPrice) && market.markPrice > 0
      ? `\n\nCurrent ${market.symbol} mark price: *$${formatNumber(market.markPrice)}*`
      : '';
  } catch {
    // Market data is informative here; it must not trap the user in the wizard.
    return '\n\nCurrent mark price is temporarily unavailable.';
  }
}

async function leverageLimits(exchange: string, symbol: string | undefined, userCap: number) {
  if (!symbol) return { marketMax: userCap, effectiveMax: userCap };
  const market = await marketQueryService.getMarket(exchange, symbol);
  const marketMax = market && Number.isFinite(market.maxLeverage) && market.maxLeverage > 0
    ? market.maxLeverage
    : userCap;
  return { marketMax, effectiveMax: Math.min(marketMax, userCap) };
}

// Step map: 0 entry; 1 ticker input and market resolution; 2 side selection;
// 3 collateral; 4 leverage; 5 order type; 6 limit price; 7 stop loss;
// 8 take profit; 9 confirmation and execution.
export const tradeScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.TRADE,
  // Step 0: entry -> ask for a ticker (+ optional side)
  async (ctx) => {
    // `scene.enter(id, initialState)` stores its payload on scene.state, not
    // wizard.state. Preserve that payload and always retain a valid exchange
    // if a stale/incomplete wizard session is resumed.
    const preSeeded = ctx.scene.state as Partial<TradeWizardState> | undefined;
    const existing = ctx.wizard.state as TradeWizardState | undefined;
    // Keep the same object Telegraf persists in scene.state. Assigning a new
    // object to wizard.state would lose these fields on the next update.
    Object.assign(ctx.wizard.state as TradeWizardState, {
      ...existing,
      ...preSeeded,
      exchange: preSeeded?.exchange ?? existing?.exchange ?? config.defaultExchange,
    });
    if (state(ctx).market && state(ctx).side) {
      await ctx.reply(`*${state(ctx).side} ${state(ctx).market}* — how much collateral (USD) do you want to put in?`, {
        parse_mode: 'Markdown',
      });
      return ctx.wizard.selectStep(3);
    }
    await ctx.reply('📈 *New Trade*\n\nWhich ticker? (e.g. `SOL` or `SOL long`)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },
  // Step 1: parse ticker input -> resolve market -> step 2 or jump to step 3
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a ticker as text, or /cancel.');
      return;
    }
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    const parsed = parseTickerInput(ctx.message.text);
    if (!parsed) {
      await ctx.reply("That doesn't look like a ticker. Try `SOL` or `SOL long`.", { parse_mode: 'Markdown' });
      return;
    }

    // Wizard state can be cleared by a bot restart between the prompt and the
    // user's reply. Phoenix is the configured default in that case.
    const market = await marketQueryService.resolveTicker(state(ctx).exchange ?? config.defaultExchange, parsed.rawTicker);

    if (!market) {
      await ctx.reply(`Unknown ticker "${parsed.rawTicker}". Check /markets for valid symbols, or /cancel.`);
      return;
    }

    state(ctx).market = market.symbol;
    if (parsed.side) {
      state(ctx).side = parsed.side;
      const side = parsed.side === 'LONG' ? '🟢 Long' : '🔴 Short';
      await ctx.reply(`${side} *${market.symbol}* — how much collateral (USD) do you want to put in?`, {
        parse_mode: 'Markdown',
      });
      return ctx.wizard.selectStep(3);
    }

    await ctx.reply(
      `Long or short *${market.symbol}*?\nCurrent mark price: *$${formatNumber(market.markPrice)}*`,
      { parse_mode: 'Markdown', ...sideKeyboard },
    );
    return ctx.wizard.next();
  },
  // Step 2: side
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the Long/Short buttons above.');
      return;
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data !== 'side_long' && data !== 'side_short') return;

    state(ctx).side = data === 'side_long' ? 'LONG' : 'SHORT';
    await ctx.reply('How much collateral (USD) do you want to put in?');
    return ctx.wizard.next();
  },
  // Step 3: collateral
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a numeric USD amount.');
      return;
    }
    const raw = ctx.message.text.trim();
    if (raw === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const amount = Number(raw);
    const parsed = parseOrError(usdAmountSchema, amount);
    if ('error' in parsed) {
      await ctx.reply(`${parsed.error} Or /cancel.`);
      return;
    }

    state(ctx).collateralUsd = parsed.value;

    const settings = await settingsService.get(ctx.appUserId!);
    const userCap = Number(settings.maxLeverage);
    const limits = await leverageLimits(
      state(ctx).exchange ?? config.defaultExchange,
      state(ctx).market,
      userCap,
    );
    state(ctx).effectiveMaxLeverage = limits.effectiveMax;
    const example = Math.min(Number(settings.defaultLeverage), limits.effectiveMax);
    await ctx.reply(
      `What leverage?\n\n` +
      `${state(ctx).market} maximum: *${formatNumber(limits.marketMax, 2)}x*\n` +
      `Your configured cap: *${formatNumber(userCap, 2)}x*\n` +
      `Available range: *1-${formatNumber(limits.effectiveMax, 2)}x* (e.g. ${formatNumber(example, 2)})`,
      { parse_mode: 'Markdown' },
    );
    return ctx.wizard.next();
  },
  // Step 4: leverage
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a numeric leverage value.');
      return;
    }
    const raw = ctx.message.text.trim();
    if (raw === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const leverage = Number(raw);
    const settings = await settingsService.get(ctx.appUserId!);
    const parsed = parseOrError(leverageSchema, leverage);
    if ('error' in parsed) {
      await ctx.reply(`${parsed.error} Or /cancel.`);
      return;
    }
    const effectiveMax = state(ctx).effectiveMaxLeverage ??
      (await leverageLimits(
          state(ctx).exchange ?? config.defaultExchange,
          state(ctx).market,
          Number(settings.maxLeverage),
        )).effectiveMax;
    if (parsed.value > effectiveMax) {
      await ctx.reply(
        `${state(ctx).market ?? 'This market'} allows a maximum of ${formatNumber(effectiveMax, 2)}x ` +
        `after applying your configured cap. Enter a lower value, or /cancel.`,
      );
      return;
    }

    state(ctx).leverage = parsed.value;
    const exchange = state(ctx).exchange ?? config.defaultExchange;
    const currentPrice = await currentMarkPriceText(exchange, state(ctx).market);
    await ctx.reply(`Order type?${currentPrice}`, { parse_mode: 'Markdown', ...orderTypeKeyboard });
    return ctx.wizard.next();
  },
  // Step 5: order type -> branches to step 6 (limit price) or jumps to step 7 (stop loss)
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the buttons above.');
      return;
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === 'order_market') {
      state(ctx).orderType = 'MARKET';
      await ctx.reply('Optional stop loss price? Send a price, or Skip.', skipKeyboard);
      return ctx.wizard.selectStep(7);
    }
    if (data === 'order_limit') {
      state(ctx).orderType = 'LIMIT';
      await ctx.reply('What limit price?');
      return ctx.wizard.next(); // -> step 6
    }
  },
  // Step 6: limit price entry (only reached for LIMIT orders)
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a numeric price, or /cancel.');
      return;
    }
    const raw = ctx.message.text.trim();
    if (raw === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const price = Number(raw);
    const parsed = parseOrError(priceSchema, price);
    if ('error' in parsed) {
      await ctx.reply(`${parsed.error} Or /cancel.`);
      return;
    }
    state(ctx).limitPrice = parsed.value;
    await ctx.reply('Optional stop loss price? Send a price, or Skip.', skipKeyboard);
    return ctx.wizard.next(); // -> step 7
  },
  // Step 7: stop loss (optional)
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      await ctx.answerCbQuery();
      if (ctx.callbackQuery.data === 'cancel') {
        await ctx.reply('Cancelled.', mainMenuKeyboard);
        return ctx.scene.leave();
      }
      if (ctx.callbackQuery.data === 'skip') {
        await ctx.reply('Optional take profit price? Send a price, or Skip.', skipKeyboard);
        return ctx.wizard.next(); // -> step 8
      }
      return;
    }
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a price, or use the buttons above.');
      return;
    }
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const price = Number(ctx.message.text.trim());
    if (!Number.isFinite(price) || price <= 0) {
      await ctx.reply('Please enter a valid positive price, or /cancel.');
      return;
    }
    state(ctx).stopLossPrice = price;
    await ctx.reply('Optional take profit price? Send a price, or Skip.', skipKeyboard);
    return ctx.wizard.next(); // -> step 8
  },
  // Step 8: take profit (optional) -> confirmation
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      await ctx.answerCbQuery();
      if (ctx.callbackQuery.data === 'cancel') {
        await ctx.reply('Cancelled.', mainMenuKeyboard);
        return ctx.scene.leave();
      }
      if (ctx.callbackQuery.data === 'skip') {
        return showConfirmation(ctx);
      }
      return;
    }
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a price, or use the buttons above.');
      return;
    }
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const price = Number(ctx.message.text.trim());
    if (!Number.isFinite(price) || price <= 0) {
      await ctx.reply('Please enter a valid positive price, or /cancel.');
      return;
    }
    state(ctx).takeProfitPrice = price;
    return showConfirmation(ctx);
  },
  // Step 9: confirm & execute
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the Confirm or Cancel buttons above.');
      return;
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === 'cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    if (data === 'confirm') {
      const s = state(ctx);
      const exchange = s.exchange ?? config.defaultExchange;
      if (!s.market || !s.side || !s.collateralUsd || !s.leverage) {
        await ctx.reply('⚠️ Your trade details expired. Please start the trade again.', mainMenuKeyboard);
        return ctx.scene.leave();
      }
      await ctx.reply('⏳ Submitting trade...');

      const result = await tradingService.open({
        userId: ctx.appUserId!,
        exchange,
        market: s.market,
        side: s.side,
        collateralUsd: s.collateralUsd,
        leverage: s.leverage,
        orderType: s.orderType,
        limitPrice: s.limitPrice,
        stopLossPrice: s.stopLossPrice,
        takeProfitPrice: s.takeProfitPrice,
      });

      if (result.status === 'REJECTED') {
        await ctx.reply(`❌ Trade failed: ${result.errorMessage}`, mainMenuKeyboard);
      } else if (s.orderType === 'LIMIT' && result.status === 'SUBMITTED') {
        await ctx.reply(
          `✅ *${s.side} ${s.market}* limit order placed at $${s.limitPrice}.\n\n` +
            (result.txSignature ? `Tx: \`${result.txSignature}\`` : ''),
          { parse_mode: 'Markdown', ...mainMenuKeyboard },
        );
      } else {
        await ctx.reply(
          `✅ *${s.side} ${s.market}* submitted at ${s.leverage}x.\n\n` +
            (result.txSignature ? `Tx: \`${result.txSignature}\`` : ''),
          { parse_mode: 'Markdown', ...mainMenuKeyboard },
        );
      }

      return ctx.scene.leave();
    }
  },
);

async function showConfirmation(ctx: BotContext) {
  const s = state(ctx);
  await ctx.reply(
    `🔍 *Review your trade*\n\n` +
      `Market: ${s.market}\n` +
      `Side: ${s.side}\n` +
      `Collateral: $${s.collateralUsd}\n` +
      `Leverage: ${s.leverage}x\n` +
      `Order Type: ${s.orderType}\n` +
      (s.limitPrice ? `Limit Price: ${s.limitPrice}\n` : '') +
      (s.stopLossPrice ? `Stop Loss: ${s.stopLossPrice}\n` : '') +
      (s.takeProfitPrice ? `Take Profit: ${s.takeProfitPrice}\n` : '') +
      `\nConfirm to submit?`,
    { parse_mode: 'Markdown', ...confirmCancelKeyboard },
  );
  return ctx.wizard.selectStep(9);
}
