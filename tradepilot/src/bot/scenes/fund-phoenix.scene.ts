import { Scenes } from 'telegraf';
import { BotContext, FundPhoenixWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { config } from '../../config/env';
import { accountBalanceService } from '../../users/account-balance.service';
import { confirmCancelKeyboard, mainMenuKeyboard } from '../keyboards';

function state(ctx: BotContext): FundPhoenixWizardState {
  return ctx.wizard.state as FundPhoenixWizardState;
}

function parseAmount(input: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(input)) return null;
  const amount = Number(input);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export const fundPhoenixScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.FUND_PHOENIX,
  async (ctx) => {
    if (!ctx.appUserId) return ctx.scene.leave();
    const wallet = await accountBalanceService.getWalletBalances(ctx.appUserId, config.defaultExchange);
    await ctx.reply(
      `➕ *Fund Phoenix*\n\nWallet USDC available: *${wallet.usdc.toFixed(6)}*\n\nEnter the USDC amount to transfer from your linked wallet to your Phoenix account.`,
      { parse_mode: 'Markdown' },
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return ctx.reply('Enter a USDC amount, or /cancel.');
    if (ctx.message.text.trim() === '/cancel') return cancel(ctx);
    const amount = parseAmount(ctx.message.text.trim());
    if (!amount) return ctx.reply('Enter a positive USDC amount with no more than 6 decimal places.');
    state(ctx).amount = amount;
    await ctx.reply(
      `🔍 *Confirm Phoenix funding*\n\nFrom: Your linked wallet\nTo: Your Phoenix account\nAmount: *${amount} USDC*`,
      { parse_mode: 'Markdown', ...confirmCancelKeyboard },
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return ctx.reply('Please use Confirm or Cancel.');
    await ctx.answerCbQuery();
    if (ctx.callbackQuery.data === 'cancel') return cancel(ctx);
    if (ctx.callbackQuery.data !== 'confirm') return;
    await ctx.reply('⏳ Funding your Phoenix account...');
    try {
      const result = await accountBalanceService.fundPhoenix(ctx.appUserId!, config.defaultExchange, state(ctx).amount!);
      await ctx.reply(
        `✅ Phoenix account funded.\n\nAmount: *${state(ctx).amount} USDC*\nTransaction: \`${result.transactionSignature}\``,
        { parse_mode: 'Markdown', ...mainMenuKeyboard },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Phoenix funding failed: ${message}`, mainMenuKeyboard);
    }
    return ctx.scene.leave();
  },
);

async function cancel(ctx: BotContext) {
  await ctx.reply('Cancelled.', mainMenuKeyboard);
  return ctx.scene.leave();
}
