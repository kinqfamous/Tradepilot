import { exchangeAccountService } from '../../users/exchange-account.service';
import { walletKeyService } from '../../exchange/wallet-key.service';
import { config } from '../../config/env';
import { BotContext } from '../../types/bot.types';
import { settingsMenuKeyboard } from '../keyboards';
import { settingsService } from '../../settings/settings.service';
import { SCENE_IDS } from '../../constants';

export async function settingsCommand(ctx: BotContext): Promise<void> {
  const settings = await settingsService.get(ctx.appUserId!);
  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `Default Leverage: ${settings.defaultLeverage}x\n` +
    `Default Group-Trade Amount: $${settings.defaultCollateralUsd}\n` +
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
export async function handleSettingsDefaultCollateral(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.SETTINGS, { field: 'defaultCollateral' });
}
export async function handleSettingsNotifications(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  const updated = await settingsService.toggleNotifications(ctx.appUserId!);
  await ctx.reply(`🔔 Notifications ${updated.notificationsOn ? 'enabled' : 'disabled'}.`);
}
export async function handleSettingsImportWallet(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.scene.enter(SCENE_IDS.LINK_ACCOUNT);
}

export async function handleSettingsExportWallet(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();

  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }

  try {
    const account = await exchangeAccountService.getActiveAccount(ctx.appUserId, config.defaultExchange);
    if (!account) {
      await ctx.reply('No wallet linked yet. Use /link to connect one first.');
      return;
    }

    const privateKeyBase58 = await walletKeyService.exportPrivateKeyBase58(account.id);

    const sent = await ctx.reply(
      `🔑 *Private Key* (base58)\n\n\`${privateKeyBase58}\`\n\n` +
      `⚠️ This message contains your private key. Save it somewhere safe now - it will ` +
      `auto-delete from this chat in 60 seconds.`,
      { parse_mode: 'Markdown' },
    );

    setTimeout(() => {
      ctx.telegram.deleteMessage(sent.chat.id, sent.message_id).catch(() => undefined);
    }, 60_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}
