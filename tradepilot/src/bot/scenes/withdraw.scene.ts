import { Scenes } from 'telegraf';
import { BotContext, WithdrawWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { config } from '../../config/env';
import { accountBalanceService } from '../../users/account-balance.service';
import { marketQueryService } from '../../trading/market-query.service';
import { confirmCancelKeyboard, mainMenuKeyboard, withdrawalSourceKeyboard } from '../keyboards';
import { PublicKey } from '@solana/web3.js';

function state(ctx: BotContext): WithdrawWizardState {
  return ctx.wizard.state as WithdrawWizardState;
}

function parseAmount(input: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(input)) return null;
  const amount = Number(input);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export const withdrawScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.WITHDRAW,
  async (ctx) => {
    if (!ctx.appUserId) return ctx.scene.leave();
    await ctx.reply('💸 *Withdraw funds*\n\nChoose the account to withdraw from:', { parse_mode: 'Markdown', ...withdrawalSourceKeyboard });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return ctx.reply('Please use the buttons above.');
    await ctx.answerCbQuery();
    if (ctx.callbackQuery.data === 'cancel') return cancel(ctx);
    if (ctx.callbackQuery.data !== 'withdraw_phoenix' && ctx.callbackQuery.data !== 'withdraw_wallet') return;
    state(ctx).source = ctx.callbackQuery.data === 'withdraw_phoenix' ? 'PHOENIX' : 'WALLET';
    if (state(ctx).source === 'PHOENIX') {
      const balances = await marketQueryService.getBalances(ctx.appUserId!, config.defaultExchange);
      const available = balances.find((balance) => balance.asset === 'PhUSD')?.available ?? 0;
      await ctx.reply(`Phoenix available PhUSD collateral: *${available.toFixed(6)}*\n\nEnter the amount to redeem to USDC in your linked wallet. Phoenix withdrawals cannot go to another address.`, { parse_mode: 'Markdown' });
    } else {
      const wallet = await accountBalanceService.getWalletBalances(ctx.appUserId!, config.defaultExchange);
      await ctx.reply(`Wallet USDC: *${wallet.usdc.toFixed(6)}*\n\nEnter the amount to send.`, { parse_mode: 'Markdown' });
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return ctx.reply('Enter a USDC amount, or /cancel.');
    if (ctx.message.text.trim() === '/cancel') return cancel(ctx);
    const amount = parseAmount(ctx.message.text.trim());
    if (!amount) return ctx.reply('Enter a positive USDC amount with no more than 6 decimal places.');
    state(ctx).amount = amount;
    if (state(ctx).source === 'PHOENIX') return preview(ctx);
    await ctx.reply('Enter the destination Solana wallet address:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return ctx.reply('Enter a Solana wallet address, or /cancel.');
    if (ctx.message.text.trim() === '/cancel') return cancel(ctx);
    try {
      state(ctx).destination = new PublicKey(ctx.message.text.trim()).toBase58();
    } catch {
      return ctx.reply('That is not a valid Solana wallet address. Try again, or /cancel.');
    }
    return preview(ctx);
  },
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return ctx.reply('Please use Confirm or Cancel.');
    await ctx.answerCbQuery();
    if (ctx.callbackQuery.data === 'cancel') return cancel(ctx);
    if (ctx.callbackQuery.data !== 'confirm') return;
    const request = state(ctx);
    await ctx.reply('⏳ Submitting withdrawal...');
    try {
      const result = request.source === 'PHOENIX'
        ? await accountBalanceService.withdrawFromPhoenix(ctx.appUserId!, config.defaultExchange, request.amount!)
        : await accountBalanceService.withdrawFromWallet(ctx.appUserId!, config.defaultExchange, request.destination!, request.amount!);
      await ctx.reply(`✅ Withdrawal confirmed.\n\nAmount: *${request.amount} ${request.source === 'PHOENIX' ? 'PhUSD redeemed to USDC' : 'USDC'}*\nTransaction: \`${result.transactionSignature}\``, { parse_mode: 'Markdown', ...mainMenuKeyboard });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Withdrawal failed: ${message}`, mainMenuKeyboard);
    }
    return ctx.scene.leave();
  },
);

async function preview(ctx: BotContext) {
  const request = state(ctx);
  const destination = request.source === 'PHOENIX' ? 'your linked wallet' : `\`${request.destination}\``;
  const asset = request.source === 'PHOENIX' ? 'PhUSD (redeemed to USDC)' : 'USDC';
  await ctx.reply(`🔍 *Confirm withdrawal*\n\nFrom: ${request.source === 'PHOENIX' ? 'Phoenix account' : 'Your wallet'}\nAmount: *${request.amount} ${asset}*\nTo: ${destination}`, { parse_mode: 'Markdown', ...confirmCancelKeyboard });
  return ctx.wizard.selectStep(4);
}

async function cancel(ctx: BotContext) {
  await ctx.reply('Cancelled.', mainMenuKeyboard);
  return ctx.scene.leave();
}
