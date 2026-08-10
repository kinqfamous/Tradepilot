import { BotContext } from '../../types/bot.types';
import { userService } from '../../users/user.service';
import { userRepository } from '../../users/user.repository';
import { exchangeAccountService } from '../../users/exchange-account.service';
import { config } from '../../config/env';
import { SCENE_IDS } from '../../constants';
import { mainMenuKeyboard, phoenixRegistrationKeyboard } from '../keyboards';
import { phoenixReferralService } from '../../exchange/phoenix/phoenix-referral.service';

export async function startCommand(ctx: BotContext): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  const payload = (ctx as BotContext & { startPayload?: string }).startPayload;
  const referralCode = payload && payload.length > 0 ? payload : undefined;

  const user = await userService.getOrCreate(fromId, ctx.from?.username, referralCode);
  ctx.appUserId = user.id;

  const exchangeAccount = await exchangeAccountService.getActiveAccount(user.id, config.defaultExchange);
  const requiresPhoenixReferral =
    config.defaultExchange === 'phoenix' &&
    (await phoenixReferralService.isRequired()) &&
    (!exchangeAccount || !(await phoenixReferralService.hasActivatedReferral(exchangeAccount.id)));

  // A pending wallet from an earlier attempt must not bypass the Phoenix gate.
  // This intentionally does not depend on UserStatus: older users may already
  // be ACTIVE while their wallet is still pending registration.
  if (!exchangeAccount || requiresPhoenixReferral || user.status === 'ONBOARDING') {
    await ctx.scene.enter(SCENE_IDS.ONBOARDING);
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

  await ctx.reply(
    '👋 *Welcome back to TradePilot*\n\n' +
      '/trade - Open a new position\n' +
      '/positions - View open positions\n' +
      '/close - Close a position\n' +
      '/balance - View balances\n' +
      '/markets - Browse markets\n' +
      '/referral - Your referral link and stats\n' +
      '/settings - Trading preferences\n' +
      '/history - Recent trades\n' +
      '/help - Show this message again',
    { parse_mode: 'Markdown', ...mainMenuKeyboard },
  );
}

export async function helpCommand(ctx: BotContext): Promise<void> {
  return startCommand(ctx);
}

// Re-export for the identify middleware's early-registration edge case.
export { userRepository };
