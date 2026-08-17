import { Markup } from 'telegraf';

export const mainMenuKeyboard = Markup.keyboard([
  ['📈 Trade', '📊 Positions'],
  ['🔴 Close Position', '💰 Balance'],
  ['➕ Fund Phoenix', '💸 Withdraw'],
  ['🌐 Markets', '⚙️ Settings'],
  ['📜 History'],
]).resize();

export const withdrawalSourceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🏦 Phoenix → My Wallet', 'withdraw_phoenix')],
  [Markup.button.callback('👛 My Wallet → Any Address', 'withdraw_wallet')],
  [Markup.button.callback('❌ Cancel', 'cancel')],
]);

export function dashboardKeyboard(userId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', `dashboard_refresh_${userId}`)],
  ]);
}

export const acceptTermsKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('✅ I Accept the Terms', 'accept_terms'),
]);

export const linkMethodKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🆕 Generate New Wallet', 'link_generate')],
  [Markup.button.callback('📥 Import Existing Wallet', 'link_import')],
]);

export const phoenixRegistrationKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Register Phoenix account (uses wallet SOL)', 'phoenix_register')],
]);

export const sideKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('🟢 Long', 'side_long'),
  Markup.button.callback('🔴 Short', 'side_short'),
]);

export const orderTypeKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('⚡ Market', 'order_market'),
  Markup.button.callback('📝 Limit', 'order_limit'),
]);

export const skipKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('⏭️ Skip', 'skip'),
  Markup.button.callback('❌ Cancel', 'cancel'),
]);

export const confirmCancelKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('✅ Confirm', 'confirm'),
  Markup.button.callback('❌ Cancel', 'cancel'),
]);

export const closePercentKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('25%', 'close_25'),
    Markup.button.callback('50%', 'close_50'),
    Markup.button.callback('75%', 'close_75'),
    Markup.button.callback('100%', 'close_100'),
  ],
  [Markup.button.callback('✏️ Custom %', 'close_custom')],
  [Markup.button.callback('❌ Cancel', 'cancel')],
]);

export const settingsMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('⚖️ Default Leverage', 'settings_leverage')],
  [Markup.button.callback('📉 Default Slippage', 'settings_slippage')],
  [Markup.button.callback('📋 Default Order Type', 'settings_order_type')],
  [Markup.button.callback('🌍 Language', 'settings_language')],
  [Markup.button.callback('🕒 Timezone', 'settings_timezone')],
  [Markup.button.callback('🔔 Toggle Notifications', 'settings_notifications')],
  [Markup.button.callback('🛡️ Max Leverage Cap', 'settings_max_leverage')],
  [Markup.button.callback('💵 Default Group-Trade Amount', 'settings_default_collateral')],
  [Markup.button.callback('📥 Import Wallet', 'settings_import_wallet')],
  [Markup.button.callback('📤 Export Private Key', 'settings_export_wallet')],
]);

export function adminMenuKeyboard(phoenixReferralCodeRequired: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Stats', 'admin_stats')],
    [Markup.button.callback('📢 Broadcast', 'admin_broadcast')],
    [Markup.button.callback('💸 Builder Fee Status', 'admin_fees_status')],
    [Markup.button.callback('✈️ Flight Builder Status', 'admin_builder_status')],
    [Markup.button.callback('📈 Builder Revenue', 'admin_revenue')],
    [
      Markup.button.callback(
        `🔐 Phoenix referral-code gate: ${phoenixReferralCodeRequired ? 'ON' : 'OFF'}`,
        'admin_toggle_phoenix_referral_gate',
      ),
    ],
    [Markup.button.callback('🟢 Normal Mode', 'admin_mode_normal')],
    [Markup.button.callback('👁️ Read-Only Mode', 'admin_mode_readonly')],
    [Markup.button.callback('🛠️ Maintenance Mode', 'admin_mode_maintenance')],
    [Markup.button.callback('🛑 Emergency Stop', 'admin_mode_emergency')],
  ]);
}

export function paginationKeyboard(page: number, hasNext: boolean, prefix: string) {
  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback('⬅️ Prev', `${prefix}_page_${page - 1}`));
  if (hasNext) buttons.push(Markup.button.callback('Next ➡️', `${prefix}_page_${page + 1}`));
  return Markup.inlineKeyboard([buttons]);
}
