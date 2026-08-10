import { BotContext } from '../../types/bot.types';
import { adminMenuKeyboard } from '../keyboards';
import { adminService } from '../../admin/admin.service';
import { systemStateService } from '../../admin/system-state.service';
import { formatUsd } from '../../utils/format';
import { SCENE_IDS } from '../../constants';
import { phoenixReferralService } from '../../exchange/phoenix/phoenix-referral.service';

export async function adminCommand(ctx: BotContext): Promise<void> {
  const state = await systemStateService.get();
  const phoenixReferralCodeRequired = await phoenixReferralService.isRequired();
  await ctx.reply(`🛠️ *Admin Panel*\n\nCurrent mode: *${state.mode}*`, {
    parse_mode: 'Markdown',
    ...adminMenuKeyboard(phoenixReferralCodeRequired),
  });
}

export async function handleAdminStats(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  const stats = await adminService.getStats();
  const volume7d = await adminService.getTradingVolume(7);

  await ctx.reply(
    `📊 *Platform Stats*\n\n` +
      `Total Users: ${stats.totalUsers}\n` +
      `Active: ${stats.activeUsers} | Onboarding: ${stats.onboardingUsers} | Suspended: ${stats.suspendedUsers}\n` +
      `Open Positions: ${stats.openPositions}\n` +
      `Total Trades: ${stats.totalTrades}\n` +
      `7-Day Volume: ${formatUsd(volume7d)}\n` +
      `Total Referrals: ${stats.totalReferrals}\n` +
      `Total Referral Rewards Paid: ${formatUsd(stats.totalReferralRewardsUsd)}`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleAdminBroadcast(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.BROADCAST);
}

async function setMode(ctx: BotContext, mode: 'NORMAL' | 'READ_ONLY' | 'MAINTENANCE' | 'EMERGENCY_STOP') {
  await ctx.answerCbQuery();
  await systemStateService.setMode(mode, ctx.appUserId!);
  await adminService.recordAudit(ctx.appUserId!, `SET_MODE_${mode}`);
  await ctx.reply(`✅ Trading mode set to *${mode}*.`, { parse_mode: 'Markdown' });
}

export const handleAdminModeNormal = (ctx: BotContext) => setMode(ctx, 'NORMAL');
export const handleAdminModeReadonly = (ctx: BotContext) => setMode(ctx, 'READ_ONLY');
export const handleAdminModeMaintenance = (ctx: BotContext) => setMode(ctx, 'MAINTENANCE');
export const handleAdminModeEmergency = (ctx: BotContext) => setMode(ctx, 'EMERGENCY_STOP');

export async function handleAdminTogglePhoenixReferralGate(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  const required = !(await phoenixReferralService.isRequired());
  await systemStateService.setPhoenixReferralCodeRequired(required, ctx.appUserId!);
  await adminService.recordAudit(ctx.appUserId!, 'SET_PHOENIX_REFERRAL_CODE_GATE', { required });
  await ctx.reply(
    `✅ Phoenix referral-code gate is now *${required ? 'ON' : 'OFF'}*. ` +
      'Phoenix on-chain registration still uses the user wallet for rent and network fees.',
    { parse_mode: 'Markdown' },
  );
}
