import { Scenes } from 'telegraf';
import { BotContext, LinkAccountWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { exchangeAccountService } from '../../users/exchange-account.service';
import { config } from '../../config/env';
import { isValidBase58PrivateKey } from '../../utils/format';
import { linkMethodKeyboard, mainMenuKeyboard } from '../keyboards';

function state(ctx: BotContext): LinkAccountWizardState {
  return ctx.wizard.state as LinkAccountWizardState;
}

export const linkAccountScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.LINK_ACCOUNT,
  async (ctx) => {
    (ctx.wizard.state as LinkAccountWizardState) = {};
    await ctx.reply(
      '🔗 *Link/Replace Wallet*\n\n' +
        '⚠️ This replaces your currently linked wallet for this exchange.',
      { parse_mode: 'Markdown', ...linkMethodKeyboard },
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the buttons above.');
      return;
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (data === 'link_generate') {
      state(ctx).method = 'generate';
      await ctx.reply('⏳ Generating a new wallet...');
      const account = await exchangeAccountService.linkNewGeneratedWallet(ctx.appUserId!, config.defaultExchange);
      await ctx.reply(
        `✅ Wallet generated and authenticated.\n\nAddress: \`${account.walletAddress}\`\nStatus: \`${account.status}\`\n\nPhoenix trader registration is still required before trading.`,
        { parse_mode: 'Markdown', ...mainMenuKeyboard },
      );
      return ctx.scene.leave();
    }

    if (data === 'link_import') {
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('For your security, wallet import is only available in a private chat with this bot.');
        return ctx.scene.leave();
      }
      state(ctx).method = 'import';
      await ctx.reply('📥 Send the base58 private key of the wallet to import, or /cancel.');
      return ctx.wizard.next();
    }
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send the private key as text, or /cancel.');
      return;
    }
    const text = ctx.message.text.trim();
    if (text === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }
    if (!isValidBase58PrivateKey(text)) {
      await ctx.reply('That does not look like a valid base58 private key. Try again, or /cancel.');
      return;
    }

    try {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => undefined);
      const account = await exchangeAccountService.linkImportedWallet(ctx.appUserId!, config.defaultExchange, text);
      await ctx.reply(
        `✅ Wallet authenticated.\n\nAddress: \`${account.walletAddress}\`\nStatus: \`${account.status}\`\n\nPhoenix trader registration is still required before trading.`,
        { parse_mode: 'Markdown', ...mainMenuKeyboard },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ ${message}`, mainMenuKeyboard);
    }

    return ctx.scene.leave();
  },
);
