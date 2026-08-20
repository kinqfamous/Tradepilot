import { exchangeAccountService } from '../../users/exchange-account.service';
import { walletKeyService } from '../../exchange/wallet-key.service';
import { config } from '../../config/env';
import { BotContext } from '../../types/bot.types';
import { settingsMenuKeyboard } from '../keyboards';
import { settingsService } from '../../settings/settings.service';
import { SCENE_IDS } from '../../constants';
import { Markup } from 'telegraf';

export async function settingsCommand(ctx: BotContext): Promise<void> {
  const settings = await settingsService.get(ctx.appUserId!);
  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `Default Leverage: ${settings.defaultLeverage}x\n` +
    `Default Group-Trade Amount: $${settings.defaultCollateralUsd}\n` +
    `Default Slippage: ${settings.defaultSlippageBps} bps\n` +
    `Default Order Type: ${settings.defaultOrderType}\n` +
    `Default Margin Mode: ${settings.defaultMarginMode}\n` +
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
  await ctx.reply(
    '📋 Choose your default order type:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Market', 'settings_order_type:MARKET')],
      [Markup.button.callback('Limit', 'settings_order_type:LIMIT')],
    ]),
  );
}
export async function handleSettingsMarginMode(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.reply(
    '🧮 Choose your default margin mode:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Cross', 'settings_margin_mode:CROSS')],
      [Markup.button.callback('Isolated', 'settings_margin_mode:ISOLATED')],
    ]),
  );
}
export async function handleSettingsOrderTypeChoice(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
  const orderType = data.split(':')[1];
  if (orderType !== 'MARKET' && orderType !== 'LIMIT') return;
  await ctx.answerCbQuery();
  const updated = await settingsService.setDefaultOrderType(ctx.appUserId!, orderType);
  await ctx.reply(`✅ Default order type set to ${updated.defaultOrderType}.`);
}
export async function handleSettingsMarginModeChoice(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
  const marginMode = data.split(':')[1];
  if (marginMode !== 'CROSS' && marginMode !== 'ISOLATED') return;
  await ctx.answerCbQuery();
  await settingsService.setDefaultMarginMode(ctx.appUserId!, marginMode);
  await ctx.reply(`✅ Default margin mode set to ${marginMode}.`);
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

  if (ctx.chat?.type !== 'private') {
    await ctx.reply('For your security, wallet export is only available in a private chat with this bot.');
    return;
  }

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
