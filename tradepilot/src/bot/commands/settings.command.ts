import { BotContext } from '../../types/bot.types';
import { settingsMenuKeyboard } from '../keyboards';
import { settingsService } from '../../settings/settings.service';
import { SCENE_IDS } from '../../constants';
import { exchangeAccountService } from '../../users/exchange-account.service';
import { walletKeyService } from '../../exchange/wallet-key.service';
import { config } from '../../config/env';
import { Markup } from 'telegraf';

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

export async function handleSettingsImportWallet(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('For your security, wallet import is only available in a private chat with this bot.');
    return;
  }
  await ctx.reply('Choose **Import Existing Wallet** in the next screen. Importing replaces this exchange wallet only after the new wallet authenticates.', {
    parse_mode: 'Markdown',
  });
  await ctx.scene.enter(SCENE_IDS.LINK_ACCOUNT);
}

export async function handleSettingsExportWallet(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  if (!ctx.appUserId) {
    await ctx.reply('Please send /start first.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('For your security, private-key export is only available in a private chat with this bot.');
    return;
  }

  const account = await exchangeAccountService.getActiveAccount(ctx.appUserId, config.defaultExchange);
  if (!account || !(await walletKeyService.hasSigningKey(account.id))) {
    await ctx.reply('No exportable wallet is linked yet.');
    return;
  }

  await ctx.reply(
    '⚠️ *Export private key?* Anyone with this key can control your wallet. Only continue in a private chat and delete the message after saving it.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Reveal private key', 'settings_export_wallet_confirm')],
        [Markup.button.callback('Cancel', 'settings_export_wallet_cancel')],
      ]),
    },
  );
}

export async function handleSettingsExportWalletConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  if (!ctx.appUserId || !ctx.chat) return;
  if (ctx.chat.type !== 'private') {
    await ctx.reply('For your security, private-key export is only available in a private chat with this bot.');
    return;
  }

  try {
    const account = await exchangeAccountService.getActiveAccount(ctx.appUserId, config.defaultExchange);
    if (!account) throw new Error('No wallet is linked yet.');
    const privateKey = await walletKeyService.exportSigningKey(account.id);
    await ctx.editMessageText('✅ Private key revealed below.');
    const sent = await ctx.reply(`🔐 *Private key — keep it secret*\n\n\`${privateKey}\`\n\nThis message will be deleted in 60 seconds.`, {
      parse_mode: 'Markdown',
    });
    const deletionTimer = setTimeout(() => {
      void ctx.telegram.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => undefined);
    }, 60_000);
    deletionTimer.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}

export async function handleSettingsExportWalletCancel(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery('Export cancelled.');
  await ctx.editMessageText('Private-key export cancelled.');
}
