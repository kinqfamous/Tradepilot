import { Scenes } from 'telegraf';
import { BotContext, SettingsWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { settingsService } from '../../settings/settings.service';
import { mainMenuKeyboard } from '../keyboards';

export const settingsScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.SETTINGS,
  async (ctx) => {
    const field = (ctx.wizard.state as SettingsWizardState).field;
    const prompts: Record<string, string> = {
      leverage: 'Enter your new default leverage (e.g. 5):',
      slippage: 'Enter your new default slippage in basis points (e.g. 50 = 0.5%):',
      orderType: 'Enter your new default order type (MARKET or LIMIT):',
      language: 'Enter your language code (e.g. en, es, fr):',
      timezone: 'Enter your timezone (e.g. UTC, America/New_York):',
      maxLeverage: 'Enter your new max leverage cap (e.g. 20):',
    };

    if (!field || !prompts[field]) {
      await ctx.reply('Unknown settings field.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    await ctx.reply(prompts[field] + '\n\nSend /cancel to abort.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a text value.');
      return;
    }

    const raw = ctx.message.text.trim();
    if (raw === '/cancel') {
      await ctx.reply('Cancelled.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    const field = (ctx.wizard.state as SettingsWizardState).field;
    const userId = ctx.appUserId!;

    try {
      if (field === 'leverage') {
        const updated = await settingsService.setDefaultLeverage(userId, Number(raw));
        await ctx.reply(`✅ Default leverage set to ${updated.defaultLeverage}x.`, mainMenuKeyboard);
      } else if (field === 'slippage') {
        const updated = await settingsService.setDefaultSlippage(userId, Number(raw));
        await ctx.reply(`✅ Default slippage set to ${updated.defaultSlippageBps} bps.`, mainMenuKeyboard);
      } else if (field === 'orderType') {
        const value = raw.toUpperCase();
        if (value !== 'MARKET' && value !== 'LIMIT') {
          await ctx.reply('Please send MARKET or LIMIT.');
          return;
        }
        const updated = await settingsService.setDefaultOrderType(userId, value as any);
        await ctx.reply(`✅ Default order type set to ${updated.defaultOrderType}.`, mainMenuKeyboard);
      } else if (field === 'language') {
        const updated = await settingsService.setLanguage(userId, raw);
        await ctx.reply(`✅ Language set to ${updated.language}.`, mainMenuKeyboard);
      } else if (field === 'timezone') {
        const updated = await settingsService.setTimezone(userId, raw);
        await ctx.reply(`✅ Timezone set to ${updated.timezone}.`, mainMenuKeyboard);
      } else if (field === 'maxLeverage') {
        const updated = await settingsService.setMaxLeverage(userId, Number(raw));
        await ctx.reply(`✅ Max leverage cap set to ${updated.maxLeverage}x.`, mainMenuKeyboard);
      } else {
        await ctx.reply('Unknown settings field.', mainMenuKeyboard);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ ${message}`, mainMenuKeyboard);
    }

    return ctx.scene.leave();
  },
);
