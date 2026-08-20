import { Scenes } from 'telegraf';
import { BotContext, OnboardingWizardState } from '../../types/bot.types';
import { SCENE_IDS } from '../../constants';
import { userService } from '../../users/user.service';
import { userRepository } from '../../users/user.repository';
import { exchangeAccountService } from '../../users/exchange-account.service';
import { phoenixReferralService } from '../../exchange/phoenix/phoenix-referral.service';
import { config } from '../../config/env';
import { acceptTermsKeyboard, linkMethodKeyboard, mainMenuKeyboard, phoenixRegistrationKeyboard } from '../keyboards';
import { isValidBase58PrivateKey } from '../../utils/format';

function state(ctx: BotContext): OnboardingWizardState {
  return ctx.wizard.state as OnboardingWizardState;
}

async function finishOnboarding(ctx: BotContext): Promise<void> {
  const pendingTrade = state(ctx).pendingTrade;
  if (pendingTrade) {
    await ctx.reply('✅ Setup complete — continuing your trade.');
    await ctx.scene.enter(SCENE_IDS.TRADE, {
      exchange: config.defaultExchange,
      market: pendingTrade.market,
      side: pendingTrade.side,
    });
    return;
  }
  await ctx.reply('✅ Setup complete.', mainMenuKeyboard);
  await ctx.scene.leave();
}

async function promptForLinkMethod(ctx: BotContext): Promise<void> {
  await ctx.reply(
    '🔗 *Link your Phoenix account*\n\n' +
      'Generate a new wallet (fastest - TradePilot manages the key for you and can trade instantly), ' +
      'or import an existing Solana wallet.',
    { parse_mode: 'Markdown', ...linkMethodKeyboard },
  );
}

async function promptForPhoenixReferralCode(ctx: BotContext): Promise<void> {
  await ctx.reply(
    '🔐 Send your *Phoenix referral code* to continue. It will be activated for your Phoenix wallet using Phoenix\'s referral flow.\n\n' +
      'Referral activation does not replace Phoenix trader registration. Your wallet still pays any on-chain registration rent and network fees. Send /cancel to abort.',
    { parse_mode: 'Markdown' },
  );
}

async function applyPhoenixReferralCode(ctx: BotContext): Promise<{ transactionSignature?: string; accountStatus: string } | undefined> {
  const code = state(ctx).phoenixReferralCode;
  if (!code || !ctx.appUserId) return;
  const result = await exchangeAccountService.activatePhoenixReferralAndRegister(ctx.appUserId, code);
  delete state(ctx).phoenixReferralCode;
  return { transactionSignature: result.transactionSignature, accountStatus: result.account.status };
}

export const onboardingScene = new Scenes.WizardScene<BotContext>(
  SCENE_IDS.ONBOARDING,
  async (ctx) => {
    const preSeeded = ctx.wizard.state as OnboardingWizardState | undefined;
    (ctx.wizard.state as OnboardingWizardState) = { ...preSeeded };

    // Existing users returning with a pending wallet have already accepted the
    // terms. Resume at the referral-code gate instead of showing registration.
    const existingUser = ctx.appUserId ? await userRepository.findById(ctx.appUserId) : null;
    if (existingUser?.acceptedTermsAt) {
      if (await phoenixReferralService.isRequired()) {
        await promptForPhoenixReferralCode(ctx);
        return ctx.wizard.selectStep(2);
      }
      await promptForLinkMethod(ctx);
      return ctx.wizard.selectStep(3);
    }

    await ctx.reply(
      '👋 *Welcome to TradePilot*\n\n' +
        'TradePilot lets you trade perpetuals directly from Telegram, starting with Phoenix Perps ' +
        'on Solana. Before you begin:\n\n' +
        '• Trading perpetuals with leverage carries substantial risk of loss.\n' +
        '• You are responsible for complying with the laws of your jurisdiction.\n' +
        '• TradePilot signs transactions on your behalf using a wallet you generate or import - ' +
        'you can export your key at any time.\n\n' +
        'Tap below to accept the terms and continue.',
      { parse_mode: 'Markdown', ...acceptTermsKeyboard },
    );
    return ctx.wizard.next();
  },
  // Step 1: accept terms -> Phoenix referral code (when owner has enabled the gate)
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery) || ctx.callbackQuery.data !== 'accept_terms') {
      await ctx.reply('Please tap "I Accept the Terms" to continue.');
      return;
    }
    await ctx.answerCbQuery();

    if (!ctx.appUserId) {
      await ctx.reply('Something went wrong resolving your account. Please send /start again.');
      return ctx.scene.leave();
    }

    await userService.acceptTerms(ctx.appUserId);

    if (await phoenixReferralService.isRequired()) {
      await promptForPhoenixReferralCode(ctx);
      return ctx.wizard.next();
    }

    await promptForLinkMethod(ctx);
    return ctx.wizard.selectStep(3);
  },
  // Step 2: Phoenix referral code
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send the Phoenix referral code as text, or /cancel.');
      return;
    }
    const code = ctx.message.text.trim();
    if (code === '/cancel') {
      await ctx.reply('Cancelled. You can restart onboarding with /start.');
      return ctx.scene.leave();
    }
    if (!code || code.length > 256) {
      await ctx.reply('That does not look like a valid Phoenix referral code. Try again, or /cancel.');
      return;
    }
    state(ctx).phoenixReferralCode = code;
    await ctx.deleteMessage(ctx.message.message_id).catch(() => undefined);

    // Resume an interrupted onboarding without requiring the user to expose
    // their wallet key again. The code is validated against the wallet that
    // is already linked to this TradePilot account.
    const existingAccount = ctx.appUserId
      ? await exchangeAccountService.getActiveAccount(ctx.appUserId, config.defaultExchange)
      : null;
    if (existingAccount?.walletAddress && existingAccount.walletAddress !== 'pending') {
      try {
        const activation = await applyPhoenixReferralCode(ctx);
        await ctx.reply(
          `✅ *Phoenix referral activated and trader account registered!*\n\n` +
            `Address: \`${existingAccount.walletAddress}\`\n\n` +
            `Phoenix used your wallet for the normal registration rent and network fees.${activation?.transactionSignature ? `\nTransaction: \`${activation.transactionSignature}\`` : ''}`,
          { parse_mode: 'Markdown' },
        );
        if (ctx.appUserId) await userService.completeOnboarding(ctx.appUserId);
        return finishOnboarding(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`❌ Phoenix referral activation failed: ${message}\n\nFix the issue, then resend the referral code or /cancel.`);
        return;
      }
    }

    await promptForLinkMethod(ctx);
    return ctx.wizard.next();
  },
  // Step 3: link method selection
  async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      await ctx.reply('Please use the buttons above.');
      return ctx.scene.leave();
    }
    const data = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (!ctx.appUserId) {
      await ctx.reply('Something went wrong resolving your account. Please send /start again.');
      return ctx.scene.leave();
    }

    if (data === 'link_generate') {
      state(ctx).linkMethod = 'generate';
      await ctx.reply('⏳ Generating your wallet and linking it to Phoenix...');

      try {
        const account = await exchangeAccountService.linkNewGeneratedWallet(ctx.appUserId, config.defaultExchange);
        const referralCodeWasRequired = Boolean(state(ctx).phoenixReferralCode);
        const activation = await applyPhoenixReferralCode(ctx);
        await ctx.reply(
          `✅ *Wallet generated and authenticated${referralCodeWasRequired ? ' with Phoenix referral activation and trader registration' : ''}!*\n\n` +
            `Address: \`${account.walletAddress}\`\n` +
            `Status: \`${activation?.accountStatus ?? account.status}\`\n\n` +
            `${referralCodeWasRequired
              ? `Phoenix used the wallet for the normal registration rent and network fees.${activation?.transactionSignature ? `\nTransaction: \`${activation.transactionSignature}\`` : ''}`
              : 'Fund the wallet with at least 0.04 SOL, then register it to enable trading.'}`,
          referralCodeWasRequired ? { parse_mode: 'Markdown' } : { parse_mode: 'Markdown', ...phoenixRegistrationKeyboard },
        );
        await userService.completeOnboarding(ctx.appUserId);
        return finishOnboarding(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`❌ Failed to link wallet or activate the Phoenix referral: ${message}`);
        return;
      }
    }

    if (data === 'link_import') {
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('For your security, wallet import is only available in a private chat with this bot.');
        return ctx.scene.leave();
      }
      state(ctx).linkMethod = 'import';
      await ctx.reply(
        '📥 Send the *base58 private key* of the Solana wallet you want to link.\n\n' +
          '⚠️ Only import a wallet you control. Send /cancel to abort.',
        { parse_mode: 'Markdown' },
      );
      return ctx.wizard.next();
    }
  },
  // Step 4: import wallet private key
  async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('For your security, wallet import is only available in a private chat with this bot.');
      return ctx.scene.leave();
    }
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Please send the private key as text, or /cancel.');
      return;
    }

    const text = ctx.message.text.trim();
    if (text === '/cancel') {
      await ctx.reply('Cancelled. You can restart onboarding with /start.');
      return ctx.scene.leave();
    }

    if (!ctx.appUserId) {
      await ctx.reply('Something went wrong resolving your account. Please send /start again.');
      return ctx.scene.leave();
    }

    if (!isValidBase58PrivateKey(text)) {
      await ctx.reply('That does not look like a valid base58 private key. Try again, or /cancel.');
      return;
    }

    try {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => undefined);

      const account = await exchangeAccountService.linkImportedWallet(ctx.appUserId, config.defaultExchange, text);
      const activation = await applyPhoenixReferralCode(ctx);
      await ctx.reply(
        `✅ *Wallet authenticated${activation ? ', with Phoenix referral activation and trader registration' : ''}!*\n\n` +
          `Address: \`${account.walletAddress}\`\n` +
          `Status: \`${activation?.accountStatus ?? account.status}\`\n\n` +
          `${activation
            ? `Phoenix used the wallet for the normal registration rent and network fees.${activation.transactionSignature ? `\nTransaction: \`${activation.transactionSignature}\`` : ''}`
            : 'Fund the wallet with at least 0.04 SOL, then register it to enable trading.'}`,
        activation ? { parse_mode: 'Markdown' } : { parse_mode: 'Markdown', ...phoenixRegistrationKeyboard },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Failed to link wallet: ${message}`);
      return;
    }

    await userService.completeOnboarding(ctx.appUserId);
    return finishOnboarding(ctx);
  },
);
