import { BotContext } from '../../types/bot.types';
import { userRepository } from '../../users/user.repository';
import { referralService } from '../../referrals/referral.service';
import { userService } from '../../users/user.service';
import { config } from '../../config/env';
import { formatUsd } from '../../utils/format';
import { Markup } from 'telegraf';

const leaderboardKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('🏆 View Leaderboard', 'referral_leaderboard'),
]);

export async function referralCommand(ctx: BotContext): Promise<void> {
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  const user = await userRepository.findById(ctx.appUserId);
  if (!user) return;

  const stats = await referralService.getStats(ctx.appUserId);
  const link = userService.buildReferralLink(config.telegram.botUsername, user.referralCode);

  await ctx.reply(
    `🔗 *Your Referral Link*\n\n${link}\n\n` +
      `Referrals: ${stats.totalReferrals}\n` +
      `Volume Generated: ${formatUsd(Number(stats.totalVolumeUsd))}\n` +
      `Rewards Earned: ${formatUsd(Number(stats.totalRewardsUsd))}`,
    { parse_mode: 'Markdown', ...leaderboardKeyboard },
  );
}

export async function handleReferralLeaderboard(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  const entries = await referralService.getLeaderboard(10);

  if (entries.length === 0) {
    await ctx.reply('No referral activity yet.');
    return;
  }

  const text = entries
    .map(
      (e, i) =>
        `${i + 1}. ${e.telegramUsername ? '@' + e.telegramUsername : 'Anonymous'} - ` +
        `${e.totalReferrals} referrals, ${formatUsd(e.totalVolumeUsd)} volume`,
    )
    .join('\n');

  await ctx.reply(`🏆 *Referral Leaderboard*\n\n${text}`, { parse_mode: 'Markdown' });
}
