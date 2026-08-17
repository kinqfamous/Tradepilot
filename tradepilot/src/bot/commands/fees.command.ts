import { BotContext } from '../../types/bot.types';
import { builderFeeService } from '../../fees/builder-fee.service';
import { formatUsd } from '../../utils/format';

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}

export async function handleAdminFees(ctx: BotContext, args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === 'on') {
    const updated = await builderFeeService.setFeeEnabled(ctx.appUserId!, true);
    await ctx.reply(`✅ Builder fees *enabled* at ${updated.builderFeeBps} bps (${bpsToPercent(updated.builderFeeBps)}%).`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  if (sub === 'off') {
    await builderFeeService.setFeeEnabled(ctx.appUserId!, false);
    await ctx.reply(
      `⚠️ Builder fees *disabled*. Trades will continue to execute without a TradePilot fee attached ` +
        `until this is turned back on with /admin fees on.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const cfg = await builderFeeService.getConfig();
  await ctx.reply(
    `💰 *Builder Fees*\n\n` +
      `Status: ${cfg.builderFeeEnabled ? '✅ Enabled' : '⛔ Disabled'}\n` +
      `Fee: ${cfg.builderFeeBps} bps (${bpsToPercent(cfg.builderFeeBps)}%)\n` +
      `Max allowed: ${cfg.maxFeeBps} bps (${bpsToPercent(cfg.maxFeeBps)}%)\n` +
      `Builder authority: ${cfg.builderAuthority ? `\`${cfg.builderAuthority}\`` : 'not configured'}\n` +
      `Registration status: ${cfg.registrationStatus}\n\n` +
      `Commands: /admin fees on, /admin fees off, /admin setbuilderfee <bps>`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleAdminBuilder(ctx: BotContext): Promise<void> {
  const before = await builderFeeService.getConfig();

  if (!before.builderAuthority) {
    await ctx.reply(
      '⚠️ No builder authority configured yet. Set `TRADEPILOT_BUILDER_AUTHORITY` in .env (or run ' +
        '`npm run register-builder` to create and register one), then restart the bot.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  await ctx.reply('⏳ Checking registration status...');
  const cfg = await builderFeeService.verifyBuilderRegistration();

  await ctx.reply(
    `🏗️ *Builder Account*\n\n` +
      `Authority: \`${cfg.builderAuthority}\`\n` +
      (cfg.builderTraderAccount ? `Trader account: \`${cfg.builderTraderAccount}\`\n` : '') +
      `Trader PDA index: ${cfg.builderPdaIndex}\n` +
      `Subaccount index: ${cfg.builderSubaccountIndex}\n` +
      `Fee rate: ${cfg.builderFeeBps} bps (${bpsToPercent(cfg.builderFeeBps)}%)\n` +
      `Registration: ${cfg.registrationStatus}${cfg.registrationCheckedAt ? ` (checked ${cfg.registrationCheckedAt.toLocaleString()})` : ''}\n\n` +
      `Balance and withdrawal are managed entirely by Phoenix, not TradePilot - view and withdraw ` +
      `accumulated fees at https://flight.phoenix.trade`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleAdminRevenue(ctx: BotContext): Promise<void> {
  const now = Date.now();
  const periods: Array<{ label: string; since?: Date }> = [
    { label: 'Today', since: new Date(new Date().setHours(0, 0, 0, 0)) },
    { label: '7 Days', since: new Date(now - 7 * 24 * 60 * 60 * 1000) },
    { label: '30 Days', since: new Date(now - 30 * 24 * 60 * 60 * 1000) },
    { label: 'All Time', since: undefined },
  ];

  const reports = await Promise.all(
    periods.map((p) => builderFeeService.getRevenueReport(p.label, p.since)),
  );

  const text = reports
    .map(
      (r) =>
        `*${r.periodLabel}*\n` +
        `Trades: ${r.tradeCount} | Volume: ${formatUsd(r.volumeUsd)}\n` +
        `Confirmed: ${formatUsd(r.confirmedFeeUsd)} | Pending: ${formatUsd(r.expectedFeeUsd)} | Failed: ${formatUsd(r.failedFeeUsd)}\n` +
        `Avg fee/trade: ${formatUsd(r.averageFeeUsd)}`,
    )
    .join('\n\n');

  await ctx.reply(`📈 *Revenue Report*\n\n${text}\n\nOnly *Confirmed* counts as real revenue.`, {
    parse_mode: 'Markdown',
  });
}

export async function handleAdminSetBuilderFee(ctx: BotContext, args: string[]): Promise<void> {
  const raw = args[0];
  const bps = Number(raw);

  if (!raw || !Number.isFinite(bps)) {
    await ctx.reply('Usage: /admin setbuilderfee <bps>  (e.g. /admin setbuilderfee 8 for 0.08%)');
    return;
  }

  try {
    const updated = await builderFeeService.setFeeBps(ctx.appUserId!, bps);
    await ctx.reply(
      `✅ Builder fee changed to ${updated.builderFeeBps} bps (${bpsToPercent(updated.builderFeeBps)}%). ` +
        `Takes effect on the next trade.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${message}`);
  }
}

// Inline-button wrappers for the admin panel keyboard (mirror the slash-command handlers above).
export async function handleAdminFeesButton(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await handleAdminFees(ctx, []);
}
export async function handleAdminBuilderButton(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await handleAdminBuilder(ctx);
}
export async function handleAdminRevenueButton(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await handleAdminRevenue(ctx);
}
