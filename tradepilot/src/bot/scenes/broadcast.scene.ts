import { Scenes } from 'telegraf';
import { BotContext, BroadcastWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { adminService } from '../../admin/admin.service';
import { adminMenuKeyboard } from '../keyboards';

export const broadcastScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.BROADCAST,
  async (ctx) => {
    (ctx.wizard.state as BroadcastWizardState) = {};
    await ctx.reply('📢 Send the message you want to broadcast to all active users, or /cancel.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send a text message, or /cancel.');
      return;
    }
    const text = ctx.message.text.trim();
    if (text === '/cancel') {
      await ctx.reply('Cancelled.');
      return ctx.scene.leave();
    }

    const count = await adminService.broadcastToAll(ctx.appUserId!, text);
    await ctx.reply(`✅ Broadcast queued for ${count} active users.`, adminMenuKeyboard(true));
    return ctx.scene.leave();
  },
);
