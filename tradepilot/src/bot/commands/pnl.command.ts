import { Input, Markup } from 'telegraf';
import { BotContext } from '../../types/bot.types';
import { config } from '../../config/env';
import { marketQueryService } from '../../trading/market-query.service';
import { pnlCardService } from '../../pnl/pnl-card.service';

/** Sends one live PnL share card for every open position. */
export async function pnlCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const positions = await marketQueryService.getOpenPositions(ctx.appUserId, config.defaultExchange);
    if (positions.length === 0) {
      await ctx.reply('📊 No active trades to show PnL for.');
      return;
    }

    // Telegram accepts up to 10 media items in an album; individual photos keep
    // the cards readable and also work when a user has more than 10 positions.
    for (const position of positions) {
      const card = pnlCardService.render({
        market: position.market,
        side: position.side,
        leverage: position.leverage,
        marginMode: position.marginMode,
        pnlPercent: position.roePercent,
        entryPrice: position.entryPrice,
        exitPrice: position.markPrice,
        status: 'OPEN',
      });
      const photo = Input.fromBuffer(card, `tradepilot-${position.market}-open-pnl.png`);
      if (ctx.chat?.type === 'private') {
        await ctx.replyWithPhoto(
          photo,
          Markup.inlineKeyboard([
            [Markup.button.callback(`🔴 Close ${position.market}`, `close_position|${position.market}|100`)],
          ]),
        );
      } else {
        await ctx.replyWithPhoto(photo);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
