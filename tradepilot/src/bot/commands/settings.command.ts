import { BotContext } from '../../types/bot.types';
import { settingsMenuKeyboard } from '../keyboards';
import { settingsService } from '../../settings/settings.service';
import { SCENE_IDS } from '../../constants';

export async function settingsCommand(ctx: BotContext): Promise<void> {
  const settings = await settingsService.get(ctx.appUserId!);
  await ctx.reply(
    `⚙️ *Settings*\n\n` +
      `Default Leverage: ${settings.defaultLeverage}x\n` +
      `Default Slippage: ${settings.defaultSlippageBps} bps\n` +
      `Default Order Type: ${settings.defaultOrderType}\n` +
      `Language: ${settings.language}\n` +
      `Timezone: ${settings.timezone}\n` +
      `Notifications: ${settings.notificationsOn ? 'On' : 'Off'}\n` +
      `Max Leverage Cap: ${settings.maxLeverage}x\n\n` +
      `What would you like to change?`,
    { parse_mode: 'Markdown', ...settingsMenuKeyboard },
  );
}

export async function handleSettingsLeverage(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'leverage' });
}
export async function handleSettingsSlippage(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'slippage' });
}
export async function handleSettingsOrderType(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'orderType' });
}
export async function handleSettingsLanguage(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'language' });
}
export async function handleSettingsTimezone(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'timezone' });
}
export async function handleSettingsMaxLeverage(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'maxLeverage' });
}
export async function handleSettingsNotifications(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  const updated = await settingsService.toggleNotifications(ctx.appUserId!);
  await ctx.reply(`🔔 Notifications ${updated.notificationsOn ? 'enabled' : 'disabled'}.`);
}
