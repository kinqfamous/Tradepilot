import { Scenes } from 'telegraf';
import { SCENE_IDS } from '../../constants';
import { config } from '../../config/env';
import { positionProtectionService } from '../../trading/position-protection.service';
import { BotContext, ProtectionWizardState } from '../../types/bot.types';
import { mainMenuKeyboard } from '../keyboards';
import { marketQueryService } from '../../trading/market-query.service';
import { formatNumber } from '../../utils/format';

function state(ctx: BotContext): ProtectionWizardState {
  return ctx.wizard.state as ProtectionWizardState;
}

export const protectionScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.PROTECTION,
  async (ctx) => {
    Object.assign(ctx.wizard.state as ProtectionWizardState, ctx.scene.state, {
      exchange: (ctx.scene.state as ProtectionWizardState).exchange ?? config.defaultExchange,
    });
    const s = state(ctx);
    const label = s.type === 'STOP_LOSS' ? 'stop-loss' : 'take-profit';
    const market = s.market ? await marketQueryService.getMarket(s.exchange!, s.market).catch(() => null) : null;
    const currentPrice = market?.markPrice && market.markPrice > 0 ? market.markPrice : null;
    const currentPriceInput = currentPrice?.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 6 });
    const priceText = currentPrice
      ? `Current market price: *$${formatNumber(currentPrice, 6)}*\n\nSend an absolute price, such as \`${currentPriceInput}\`, or a target ROE such as \`5%\`.`
      : 'Send an absolute market price, or a target ROE such as `5%`.';
    await ctx.reply(`Enter the new ${label} for *${s.market}*.\n\n${priceText} Percentage targets account for the position's leverage. This replaces the existing ${label}, if any.`, {
      parse_mode: 'Markdown',
    });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return ctx.reply('Please send a numeric price, or /cancel.');
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const raw = ctx.message.text.trim();
    const percentageMatch = /^(\d+(?:\.\d+)?)%$/.exec(raw);
    const percentage = percentageMatch ? Number(percentageMatch[1]) : undefined;
    const price = percentage === undefined ? Number(raw.replace(/^\$/, '')) : undefined;
    const s = state(ctx);
    if (
      (!Number.isFinite(price) && !Number.isFinite(percentage)) ||
      ((price ?? percentage ?? 0) <= 0) ||
      !s.market || !s.type
    ) {
      await ctx.reply('Please enter a positive market price or percentage (for example `5%`), or /cancel.', { parse_mode: 'Markdown' });
      return;
    }
    await ctx.reply('⏳ Updating protection on Phoenix...');
    try {
      const result = await positionProtectionService.setProtection({
        userId: ctx.appUserId!, exchange: s.exchange ?? config.defaultExchange, market: s.market, type: s.type, price, percentage,
      });
      await ctx.reply(
        `✅ ${s.type === 'STOP_LOSS' ? 'Stop loss' : 'Take profit'} set to *$${result.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}*` +
          `${percentage === undefined ? '' : ` (target *${percentage}% ROE*)`} for *${s.market}*.\nTx: \`${result.signature}\``,
        { parse_mode: 'Markdown', ...mainMenuKeyboard },
      );
      return ctx.scene.leave();
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : String(error)}\n\nEnter another price, or /cancel.`);
    }
  },
);
