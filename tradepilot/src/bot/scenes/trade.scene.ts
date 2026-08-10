import { Scenes } from 'telegraf';
import { BotContext, TradeWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { tradingService } from '../../trading/trading.service';
import { settingsService } from '../../settings/settings.service';
import { marketQueryService } from '../../trading/market-query.service';
import { normalizeMarketSymbol } from '../../utils/format';
import { confirmCancelKeyboard, mainMenuKeyboard, orderTypeKeyboard, sideKeyboard, skipKeyboard } from '../keyboards';
import { config } from '../../config/env';
import { parseOrError, usdAmountSchema, leverageSchema, priceSchema } from '../../validators/trade.validators';

function state(ctx: BotContext): TradeWizardState {
  return ctx.wizard.state as TradeWizardState;
}

export const tradeScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.TRADE,
  // Step 0: entry -> ask market
  async (ctx) => {
    (ctx.wizard.state as TradeWizardState) = { exchange: config.defaultExchange };
    await ctx.reply('📈 *New Trade*\n\nWhich market? (e.g. `SOL-PERP`)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },
  // Step 1: market
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a market symbol as text, or /cancel.');
      return;
    }
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    const symbol = normalizeMarketSymbol(ctx.message.text);
    // Wizard state can be cleared by a bot restart between the prompt and the
    // user's reply. Phoenix is the configured default in that case.
    const markets = await marketQueryService.listMarkets(state(ctx).exchange ?? config.defaultExchange);
    const market = markets.find((m) => m.symbol === symbol);

    if (!market) {
      await ctx.reply(`Unknown market "${symbol}". Check /markets for the full list, or /cancel.`);
      return;
    }

    state(ctx).market = symbol;
    await ctx.reply(`Long or short *${symbol}*?`, { parse_mode: 'Markdown', ...sideKeyboard });
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
    await ctx.reply(`What leverage? (1-${settings.maxLeverage}x, e.g. ${settings.defaultLeverage})`);
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
    if (parsed.value > Number(settings.maxLeverage)) {
      await ctx.reply(`Your max leverage cap is ${settings.maxLeverage}x. Enter a lower value, or /cancel.`);
      return;
    }

    state(ctx).leverage = parsed.value;
    await ctx.reply('Order type?', orderTypeKeyboard);
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
    if (!Number.isFinite(price) || price <= 0) {
      await ctx.reply('Please enter a valid positive price, or /cancel.');
      return;
    }
    state(ctx).limitPrice = price;
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
      await ctx.reply('⏳ Submitting trade...');

      const result = await tradingService.open({
        userId: ctx.appUserId!,
        exchange: s.exchange!,
        market: s.market!,
        side: s.side!,
        collateralUsd: s.collateralUsd!,
        leverage: s.leverage!,
        orderType: s.orderType,
        limitPrice: s.limitPrice,
        stopLossPrice: s.stopLossPrice,
        takeProfitPrice: s.takeProfitPrice,
      });

      if (result.status === 'REJECTED') {
        await ctx.reply(`❌ Trade failed: ${result.errorMessage}`, mainMenuKeyboard);
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
