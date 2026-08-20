import { Telegraf, Scenes, Markup } from 'telegraf';
import { config } from '../config/env';
import { BotContext } from '../types/bot.types';
import { errorBoundary } from '../middlewares/error.middleware';
import { rateLimit } from '../middlewares/rate-limit.middleware';
import { identify } from '../middlewares/identify.middleware';
import { maintenanceGate } from '../middlewares/maintenance.middleware';
import { adminOnly } from '../middlewares/admin.middleware';
import { privateChatOnly } from '../middlewares/private-chat.middleware';
import { createSessionMiddleware } from './session';
import { SCENE_IDS } from '../constants';

import { onboardingScene } from './scenes/onboarding.scene';
import { linkAccountScene } from './scenes/link-account.scene';
import { tradeScene } from './scenes/trade.scene';
import { closePositionScene } from './scenes/close-position.scene';
import { protectionScene } from './scenes/protection.scene';
import { pendingLimitEditScene } from './scenes/pending-limit-edit.scene';
import { settingsScene } from './scenes/settings.scene';
import { broadcastScene } from './scenes/broadcast.scene';
import { withdrawScene } from './scenes/withdraw.scene';
import { fundPhoenixScene } from './scenes/fund-phoenix.scene';

import { startCommand, helpCommand, refreshDashboard } from './commands/start.command';
import { positionsCommand } from './commands/positions.command';
import { balanceCommand } from './commands/balance.command';
import { marketsCommand, handleMarketsPagination } from './commands/markets.command';
import {
  settingsCommand,
  handleSettingsLeverage,
  handleSettingsSlippage,
  handleSettingsOrderType,
  handleSettingsOrderTypeChoice,
  handleSettingsMarginMode,
  handleSettingsMarginModeChoice,
  handleSettingsLanguage,
  handleSettingsTimezone,
  handleSettingsMaxLeverage,
  handleSettingsDefaultCollateral,
  handleSettingsNotifications,
  handleSettingsImportWallet,
  handleSettingsExportWallet,
} from './commands/settings.command';
import { registerGroupTradeHandlers } from './group-trade.handler';
import { historyCommand } from './commands/history.command';
import { pnlCommand } from './commands/pnl.command';
import {
  adminCommand,
  handleAdminStats,
  handleAdminBroadcast,
  handleAdminModeNormal,
  handleAdminModeReadonly,
  handleAdminModeMaintenance,
  handleAdminModeEmergency,
  handleAdminTogglePhoenixReferralGate,
} from './commands/admin.command';
import {
  handleAdminBuilder,
  handleAdminBuilderButton,
  handleAdminFees,
  handleAdminFeesButton,
  handleAdminRevenue,
  handleAdminRevenueButton,
  handleAdminSetBuilderFee,
} from './commands/fees.command';

import { log } from '../logger/logger';
import { tradingService } from '../trading/trading.service';
import { tradingRepository } from '../trading/trading.repository';
import { marketQueryService } from '../trading/market-query.service';
import { config as appConfig } from '../config/env';
import { exchangeAccountService } from '../users/exchange-account.service';
import { userService } from '../users/user.service';
import { mainMenuKeyboard } from './keyboards';
import { formatSignedPnlPercent, normalizeMarketSymbol } from '../utils/format';
import { pendingLimitService } from '../trading/pending-limit.service';

async function closeAllPositions(ctx: BotContext): Promise<unknown> {
  if (!ctx.appUserId) return ctx.reply('Please send /start first.');
  await ctx.reply('⏳ Closing all positions...');
  const results = await tradingService.closeAll(ctx.appUserId, appConfig.defaultExchange);
  const realizedPnl = results.reduce((total, result) => total + (result.realizedPnl ?? 0), 0);
  const closedMargin = results.reduce((total, result) => total + (result.closedMargin ?? 0), 0);
  return ctx.reply(
    `✅ Closed ${results.filter((result) => result.status !== 'REJECTED').length}/${results.length} positions.\n` +
    (closedMargin > 0 ? `Realized PnL: ${formatSignedPnlPercent((realizedPnl / closedMargin) * 100)}` : ''),
  );
}

export function createBot(): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(config.telegram.botToken);

  const stage = new Scenes.Stage<BotContext>([
    onboardingScene,
    linkAccountScene,
    tradeScene,
    closePositionScene,
    protectionScene,
    pendingLimitEditScene,
    settingsScene,
    broadcastScene,
    withdrawScene,
    fundPhoenixScene,
  ]);

  // Order: error boundary wraps everything, then identity resolution,
  // then rate limiting, then session/scenes, then the maintenance gate
  // (which needs to distinguish read vs. write actions before handlers run).
  bot.use(errorBoundary);
  bot.use(identify);
  bot.use(privateChatOnly);
  bot.use(rateLimit);
  bot.use(maintenanceGate);
  bot.use(createSessionMiddleware());
  bot.use(stage.middleware());

  // Slash commands
  bot.start(startCommand);
  bot.help(helpCommand);
  bot.command('trade', (ctx) => ctx.scene.enter(SCENE_IDS.TRADE));
  bot.command('positions', positionsCommand);
  bot.command('close', (ctx) => {
    const [, rawMarket, rawPercent] = ctx.message.text.trim().split(/\s+/);
    if (!rawMarket) return ctx.scene.enter(SCENE_IDS.CLOSE_POSITION);

    const percent = rawPercent === undefined ? undefined : Number(rawPercent);
    if (percent !== undefined && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
      return ctx.reply('Usage: /close <market> [percent]. Example: /close SOL 50');
    }
    return ctx.scene.enter(SCENE_IDS.CLOSE_POSITION, { market: normalizeMarketSymbol(rawMarket), percent });
  });
  bot.command('balance', balanceCommand);
  bot.command('withdraw', (ctx) => ctx.scene.enter(SCENE_IDS.WITHDRAW));
  bot.command('fund', (ctx) => ctx.scene.enter(SCENE_IDS.FUND_PHOENIX));
  bot.command('markets', marketsCommand);
  bot.command('settings', settingsCommand);
  bot.command('history', historyCommand);
  bot.command('pnl', pnlCommand);
  bot.command('link', (ctx) => ctx.scene.enter(SCENE_IDS.LINK_ACCOUNT));
  bot.command('closeall', async (ctx) => {
    if (!ctx.appUserId) return ctx.reply('Please send /start first.');
    return closeAllPositions(ctx);
  });
  bot.command('cancel', async (ctx) => {
    await ctx.scene.leave();
    await ctx.reply('Cancelled.');
  });

  // Admin commands
  bot.command('admin', adminOnly, adminCommand);
  bot.command('fees', adminOnly, (ctx) => handleAdminFees(ctx, ctx.message.text.split(/\s+/).slice(1)));
  bot.command('builder', adminOnly, handleAdminBuilder);
  bot.command('revenue', adminOnly, handleAdminRevenue);
  bot.command('setbuilderfee', adminOnly, (ctx) => handleAdminSetBuilderFee(ctx, ctx.message.text.split(/\s+/).slice(1)));

  // Reply-keyboard buttons (main menu)
  bot.hears('🏠 Start', startCommand);
  bot.hears('📈 Trade', (ctx) => ctx.scene.enter(SCENE_IDS.TRADE));
  bot.hears('📊 Positions', positionsCommand);
  bot.hears('💰 Balance', balanceCommand);
  bot.hears('💸 Withdraw', (ctx) => ctx.scene.enter(SCENE_IDS.WITHDRAW));
  bot.hears('➕ Fund Phoenix', (ctx) => ctx.scene.enter(SCENE_IDS.FUND_PHOENIX));
  bot.hears('🌐 Markets', marketsCommand);
  bot.hears('⚙️ Settings', settingsCommand);
  bot.hears('📜 History', historyCommand);

  // Inline keyboard callback handlers
  bot.action(/^markets_page_\d+$/, handleMarketsPagination);
  bot.action(/^dashboard_refresh_\d+$/, refreshDashboard);
  bot.action(/^dashboard_pnl_\d+$/, async (ctx) => {
    if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^dashboard_pnl_(\d+)$/.exec(ctx.callbackQuery.data);
    if (!match || Number(match[1]) !== ctx.appUserId) {
      await ctx.answerCbQuery('This dashboard belongs to another user.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    return pnlCommand(ctx);
  });
  bot.action(/^close_position\|(.+)\|(\d+(?:\.\d+)?)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^close_position\|(.+)\|(\d+(?:\.\d+)?)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    const percent = Number(match[2]);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return;
    return ctx.scene.enter(SCENE_IDS.CLOSE_POSITION, { market: match[1], percent });
  });
  bot.action(/^position_actions\|(.+)$/, async (ctx) => {
    if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const market = ctx.callbackQuery.data.slice('position_actions|'.length);
    await ctx.answerCbQuery();
    const position = (await marketQueryService.getOpenPositions(ctx.appUserId, appConfig.defaultExchange))
      .find((candidate) => candidate.market === market);
    if (!position) return ctx.reply(`No open position found for ${market}.`);
    const protections = (await tradingRepository.listActiveProtections(ctx.appUserId, appConfig.defaultExchange))
      .filter((order) => order.market === market);
    const stopLoss = protections.find((order) => order.type === 'STOP_LOSS');
    const takeProfit = protections.find((order) => order.type === 'TAKE_PROFIT');
    return ctx.reply(
      `⚙️ *${market} position actions*\nEntry: *$${position.entryPrice}* | Mark: *$${position.markPrice}*\n` +
      `Liquidation: *${position.liquidationPrice === null ? 'Unavailable' : `$${position.liquidationPrice}`}*\n` +
      `Stop loss: *${stopLoss?.triggerPrice ? `$${stopLoss.triggerPrice}` : 'Not set'}* | ` +
      `Take profit: *${takeProfit?.triggerPrice ? `$${takeProfit.triggerPrice}` : 'Not set'}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Close 25%', `close_position|${market}|25`),
            Markup.button.callback('Close 50%', `close_position|${market}|50`),
            Markup.button.callback('Close 100%', `close_position|${market}|100`),
          ],
          [Markup.button.callback('✏️ Custom close', `close_position_custom|${market}`)],
          [
            Markup.button.callback(`🛡 ${stopLoss ? 'Edit' : 'Set'} SL`, `position_protection|${market}|STOP_LOSS`),
            Markup.button.callback(`🎯 ${takeProfit ? 'Edit' : 'Set'} TP`, `position_protection|${market}|TAKE_PROFIT`),
          ],
        ]),
      },
    );
  });
  bot.action(/^limit_edit_menu\|(\d+)$/, async (ctx) => {
    if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const orderId = Number(ctx.callbackQuery.data.split('|')[1]);
    const order = await tradingRepository.findUserPendingLimitOrder(orderId, ctx.appUserId, appConfig.defaultExchange);
    if (!order) return ctx.answerCbQuery('Order not found. Refresh Positions.', { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.reply(`✏️ Edit pending *${order.market}* limit order`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Change entry', `limit_edit|${orderId}|ENTRY`)],
        [
          Markup.button.callback('Edit SL', `limit_edit|${orderId}|STOP_LOSS`),
          Markup.button.callback('Edit TP', `limit_edit|${orderId}|TAKE_PROFIT`),
        ],
      ]),
    });
  });
  bot.action(/^limit_edit\|(\d+)\|(ENTRY|STOP_LOSS|TAKE_PROFIT)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^limit_edit\|(\d+)\|(ENTRY|STOP_LOSS|TAKE_PROFIT)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    return ctx.scene.enter(SCENE_IDS.PENDING_LIMIT_EDIT, { orderId: Number(match[1]), kind: match[2] });
  });
  bot.action(/^limit_cancel_request\|(\d+)$/, async (ctx) => {
    if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const orderId = Number(ctx.callbackQuery.data.split('|')[1]);
    const order = await tradingRepository.findUserPendingLimitOrder(orderId, ctx.appUserId, appConfig.defaultExchange);
    if (!order) return ctx.answerCbQuery('Order not found. Refresh Positions.', { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.reply(`Cancel the pending ${order.market} limit order at $${order.price}?`, Markup.inlineKeyboard([[
      Markup.button.callback('✅ Confirm cancel', `limit_cancel_confirm|${orderId}`),
      Markup.button.callback('Keep order', `limit_cancel_keep|${orderId}`),
    ]]));
  });
  bot.action(/^limit_cancel_confirm\|(\d+)$/, async (ctx) => {
    if (!ctx.appUserId || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    await ctx.answerCbQuery();
    const orderId = Number(ctx.callbackQuery.data.split('|')[1]);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    try {
      const signature = await pendingLimitService.cancel(ctx.appUserId, appConfig.defaultExchange, orderId);
      return ctx.reply(`✅ Pending limit order cancelled.\nTx: \`${signature}\``, { parse_mode: 'Markdown' });
    } catch (error) {
      return ctx.reply(`❌ ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot.action(/^limit_cancel_keep\|(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Order kept');
    return ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^close_position_custom\|(.+)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    await ctx.answerCbQuery();
    return ctx.scene.enter(SCENE_IDS.CLOSE_POSITION, {
      market: ctx.callbackQuery.data.slice('close_position_custom|'.length),
    });
  });
  bot.action(/^position_protection\|(.+)\|(STOP_LOSS|TAKE_PROFIT)$/, async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const match = /^position_protection\|(.+)\|(STOP_LOSS|TAKE_PROFIT)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    return ctx.scene.enter(SCENE_IDS.PROTECTION, { market: match[1], type: match[2] });
  });
  bot.action('close_all_request', async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.appUserId) return ctx.reply('Please send /start first.');
    const positions = await marketQueryService.getOpenPositions(ctx.appUserId, appConfig.defaultExchange);
    if (positions.length === 0) return ctx.reply('📊 You have no open positions.');
    if (positions.length === 1) {
      return ctx.scene.enter(SCENE_IDS.CLOSE_POSITION, { market: positions[0].market, percent: 100 });
    }
    return ctx.reply(
      `⚠️ Close all ${positions.length} open positions?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Close All', 'close_all_confirm'),
          Markup.button.callback('❌ Cancel', 'close_all_cancel'),
        ],
      ]),
    );
  });
  bot.action('close_all_confirm', async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.appUserId) return ctx.reply('Please send /start first.');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    return closeAllPositions(ctx);
  });
  bot.action('close_all_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    return ctx.reply('Close all cancelled. Your positions remain open.');
  });
  bot.action('phoenix_register', async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.appUserId) return ctx.reply('Please send /start first.');
    await ctx.reply('⏳ Registering your Phoenix trader account. This uses SOL from your wallet for fees and rent...');
    try {
      const { account, transactionSignature } = await exchangeAccountService.registerUserFundedPhoenixAccount(
        ctx.appUserId,
        appConfig.defaultExchange,
      );
      await userService.completeOnboarding(ctx.appUserId);
      await ctx.reply(
        `✅ *Phoenix account verified!*\n\nWallet: \`${account.walletAddress}\`\nTransaction: \`${transactionSignature}\``,
        { parse_mode: 'Markdown', ...mainMenuKeyboard },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Phoenix registration failed: ${message}`);
    }
  });

  bot.action('settings_leverage', handleSettingsLeverage);
  bot.action('settings_slippage', handleSettingsSlippage);
  bot.action('settings_order_type', handleSettingsOrderType);
  bot.action(/^settings_order_type:(MARKET|LIMIT)$/, handleSettingsOrderTypeChoice);
  bot.action('settings_margin_mode', handleSettingsMarginMode);
  bot.action(/^settings_margin_mode:(CROSS|ISOLATED)$/, handleSettingsMarginModeChoice);
  bot.action('settings_language', handleSettingsLanguage);
  bot.action('settings_timezone', handleSettingsTimezone);
  bot.action('settings_max_leverage', handleSettingsMaxLeverage);
  bot.action('settings_default_collateral', handleSettingsDefaultCollateral);
  bot.action('settings_notifications', handleSettingsNotifications);
  bot.action('settings_import_wallet', handleSettingsImportWallet);
  bot.action('settings_export_wallet', handleSettingsExportWallet);
  bot.action('admin_stats', adminOnly, handleAdminStats);
  bot.action('admin_broadcast', adminOnly, handleAdminBroadcast);
  bot.action('admin_mode_normal', adminOnly, handleAdminModeNormal);
  bot.action('admin_mode_readonly', adminOnly, handleAdminModeReadonly);
  bot.action('admin_mode_maintenance', adminOnly, handleAdminModeMaintenance);
  bot.action('admin_mode_emergency', adminOnly, handleAdminModeEmergency);
  bot.action('admin_toggle_phoenix_referral_gate', adminOnly, handleAdminTogglePhoenixReferralGate);
  bot.action('admin_fees_status', adminOnly, handleAdminFeesButton);
  bot.action('admin_builder_status', adminOnly, handleAdminBuilderButton);
  bot.action('admin_revenue', adminOnly, handleAdminRevenueButton);

  registerGroupTradeHandlers(bot);

  bot.catch((err, ctx) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error('SYSTEM', 'Telegraf top-level error handler triggered', {
      message,
      updateType: ctx.updateType,
    });
  });

  return bot;
}
