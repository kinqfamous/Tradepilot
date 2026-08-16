import { BotContext } from '../../types/bot.types';
import { marketQueryService } from '../../trading/market-query.service';
import { config } from '../../config/env';
import { formatUsd } from '../../utils/format';
import { accountBalanceService } from '../../users/account-balance.service';

export async function balanceCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const [balances, wallet] = await Promise.all([
      marketQueryService.getBalances(ctx.appUserId, config.defaultExchange),
      accountBalanceService.getWalletBalances(ctx.appUserId, config.defaultExchange),
    ]);

    const text = balances
      .map((b) => `*${b.asset}*: ${formatUsd(b.total)} (available: ${formatUsd(b.available)}, in margin: ${formatUsd(b.usedMargin)})`)
      .join('\n');

    await ctx.reply(
      `💰 *Accounts*\n\n*Wallet*\nSOL: ${wallet.sol.toFixed(6)}\nUSDC: ${formatUsd(wallet.usdc)}\n\n*Phoenix*\n${text}`,
      { parse_mode: 'Markdown' },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
