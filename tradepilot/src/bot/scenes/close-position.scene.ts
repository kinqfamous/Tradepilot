import { Scenes } from 'telegraf';
import { BotContext, ClosePositionWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { tradingService } from '../../trading/trading.service';
import { marketQueryService } from '../../trading/market-query.service';
import { normalizeMarketSymbol } from '../../utils/format';
import { closePercentKeyboard, confirmCancelKeyboard, mainMenuKeyboard } from '../keyboards';
import { config } from '../../config/env';

function state(ctx: BotContext): ClosePositionWizardState {
  return ctx.wizard.state as ClosePositionWizardState;
}

export const closePositionScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.CLOSE_POSITION,
  async (ctx) => {
    const preSeeded = ctx.scene.state as Partial<ClosePositionWizardState> | undefined;
    const existing = ctx.wizard.state as ClosePositionWizardState | undefined;
    // WizardContextWizard holds a reference to scene.state. Replacing the
    // reference only updates this request; mutate it so the exchange and
    // pre-seeded close details survive the confirmation callback.
    Object.assign(ctx.wizard.state as ClosePositionWizardState, {
      ...existing,
      ...preSeeded,
      exchange: preSeeded?.exchange ?? existing?.exchange ?? config.defaultExchange,
    });

    const positions = await marketQueryService.getOpenPositions(ctx.appUserId!, state(ctx).exchange!);
    if (positions.length === 0) {
      await ctx.reply('You have no open positions.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    // Fast paths (/close SOL [percent] and the buttons shown by /positions)
    // enter with both values already known, but still require confirmation.
    if (state(ctx).market && state(ctx).percent) {
      const position = positions.find((p) => p.market === state(ctx).market);
      if (!position) {
        await ctx.reply(`You have no open position on "${state(ctx).market}".`, mainMenuKeyboard);
        return ctx.scene.leave();
      }
      return showConfirmation(ctx);
    }

    if (state(ctx).market) {
      const position = positions.find((p) => p.market === state(ctx).market);
      if (!position) {
        await ctx.reply(`You have no open position on "${state(ctx).market}".`, mainMenuKeyboard);
        return ctx.scene.leave();
      }
      await ctx.reply(`How much of *${state(ctx).market}* do you want to close?`, { parse_mode: 'Markdown', ...closePercentKeyboard });
      return ctx.wizard.selectStep(2);
    }

    const list = positions.map((p) => `• ${p.market} (${p.side}, ${p.leverage}x)`).join('\n');
    await ctx.reply(`🔴 *Close Position*\n\nYour open positions:\n${list}\n\nWhich market?`, {
      parse_mode: 'Markdown',
    });
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
    const positions = await marketQueryService.getOpenPositions(ctx.appUserId!, state(ctx).exchange!);
    const position = positions.find((p) => p.market === symbol);

    if (!position) {
      await ctx.reply(`You have no open position on "${symbol}". Try again, or /cancel.`);
      return;
    }

    state(ctx).market = symbol;
    await ctx.reply('How much do you want to close?', closePercentKeyboard);
    return ctx.wizard.next();
  },
  // Step 2: percentage
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the buttons above.');
      return;
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === 'cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    if (data === 'close_custom') {
      await ctx.reply('Enter a custom percentage (1-100):');
      return ctx.wizard.next();
    }
    const match = /^close_(\d+)$/.exec(data);
    if (match) {
      state(ctx).percent = Number(match[1]);
      return showConfirmation(ctx);
    }
  },
  // Step 3: custom percentage entry
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a numeric percentage.');
      return;
    }
    const raw = ctx.message.text.trim();
    if (raw === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      await ctx.reply('Please enter a number between 1 and 100, or /cancel.');
      return;
    }
    state(ctx).percent = percent;
    return showConfirmation(ctx);
  },
  // Step 4: confirm & execute
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
      if (!s.market || !s.percent) {
        await ctx.reply('⚠️ Close details expired. Please start again.', mainMenuKeyboard);
        return ctx.scene.leave();
      }
      await ctx.reply('⏳ Submitting close order...');

      const result = await tradingService.close({
        userId: ctx.appUserId!,
        exchange: s.exchange ?? config.defaultExchange,
        market: s.market,
        percent: s.percent,
      });

      if (result.status === 'REJECTED') {
        await ctx.reply(`❌ Close failed: ${result.errorMessage}`, mainMenuKeyboard);
      } else {
        await ctx.reply(
          `✅ Closed ${s.percent}% of *${s.market}*.\n\n` + (result.txSignature ? `Tx: \`${result.txSignature}\`` : ''),
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
    `🔍 Close *${s.percent}%* of *${s.market}*?`,
    { parse_mode: 'Markdown', ...confirmCancelKeyboard },
  );
  return ctx.wizard.selectStep(4);
}
