import { Scenes } from 'telegraf';
import { SCENE_IDS } from '../../constants';
import { config } from '../../config/env';
import { pendingLimitService } from '../../trading/pending-limit.service';
import { BotContext, PendingLimitEditWizardState } from '../../types/bot.types';
import { mainMenuKeyboard } from '../keyboards';
import { marketQueryService } from '../../trading/market-query.service';
import { tradingRepository } from '../../trading/trading.repository';
import { formatNumber } from '../../utils/format';

const state = (ctx: BotContext) => ctx.wizard.state as PendingLimitEditWizardState;

export const pendingLimitEditScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.PENDING_LIMIT_EDIT,
  async (ctx) => {
    Object.assign(ctx.wizard.state as PendingLimitEditWizardState, ctx.scene.state, {
      exchange: (ctx.scene.state as PendingLimitEditWizardState).exchange ?? config.defaultExchange,
    });
    const s = state(ctx);
    const label = s.kind === 'ENTRY' ? 'entry price' : s.kind === 'STOP_LOSS' ? 'stop-loss' : 'take-profit';
    const order = s.orderId && ctx.appUserId
      ? await tradingRepository.findUserPendingLimitOrder(s.orderId, ctx.appUserId, s.exchange!).catch(() => null)
      : null;
    const market = order ? await marketQueryService.getMarket(s.exchange!, order.market).catch(() => null) : null;
    const currentPrice = market?.markPrice && market.markPrice > 0 ? market.markPrice : null;
    const currentPriceInput = currentPrice?.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 6 });
    const absoluteExample = currentPrice
      ? `Current market price: *$${formatNumber(currentPrice, 6)}*\n\nSend an absolute price, such as \`${currentPriceInput}\``
      : 'Send an absolute market price';
    await ctx.reply(
      `Enter the new ${label}.\n\n` +
      (s.kind === 'ENTRY'
        ? `${absoluteExample}.`
        : `${absoluteExample}, or a target ROE, such as \`5%\`.`) +
      '\nThe resting order will be cancelled and replaced while keeping its other saved protection.',
      { parse_mode: 'Markdown' },
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return ctx.reply('Send a numeric value, or /cancel.');
    if (ctx.message.text.trim() === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    const s = state(ctx);
    const raw = ctx.message.text.trim();
    const percentageMatch = s.kind === 'ENTRY' ? null : /^(\d+(?:\.\d+)?)%$/.exec(raw);
    const percentage = percentageMatch ? Number(percentageMatch[1]) : undefined;
    const price = percentage === undefined ? Number(raw.replace(/^\$/, '')) : undefined;
    if (!s.orderId || !s.kind || (!Number.isFinite(price) && !Number.isFinite(percentage)) || (price ?? percentage ?? 0) <= 0) {
      return ctx.reply('Enter a positive price' + (s.kind === 'ENTRY' ? '' : ' or percentage') + ', or /cancel.');
    }
    await ctx.reply('⏳ Replacing the pending limit order on Phoenix...');
    try {
      const result = await pendingLimitService.edit({
        userId: ctx.appUserId!, exchange: s.exchange!, orderId: s.orderId, kind: s.kind, price, percentage,
      });
      const detail = s.kind === 'ENTRY'
        ? `New entry: *$${result.entryPrice.toLocaleString()}*`
        : `${s.kind === 'STOP_LOSS' ? 'Stop loss' : 'Take profit'}: *$${result.protectionPrice?.toLocaleString()}*`;
      await ctx.reply(`✅ Pending limit order replaced.\n${detail}\nTx: \`${result.result.txSignature}\``, {
        parse_mode: 'Markdown', ...mainMenuKeyboard,
      });
      return ctx.scene.leave();
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : String(error)}\n\nEnter another value, or /cancel.`);
    }
  },
);
