import { prisma } from '../database/prisma';
import { ExchangeAccount } from '@prisma/client';
import { exchangeRegistry } from '../exchange/exchange.registry';
import { walletKeyService } from '../exchange/wallet-key.service';
import { log } from '../logger/logger';
import { ExchangeCredential } from '../types/exchange.types';
import { decrypt, encrypt } from '../utils/encryption';
import { LinkAccountResult } from '../exchange/interfaces/wallet-adapter.interface';
import { phoenixReferralService } from '../exchange/phoenix/phoenix-referral.service';

export class ExchangeAccountService {
  async getActiveAccount(userId: number, exchange: string): Promise<ExchangeAccount | null> {
    return prisma.exchangeAccount.findUnique({ where: { userId_exchange: { userId, exchange } } });
  }

  async requireVerifiedAccount(userId: number, exchange: string): Promise<ExchangeAccount> {
    const account = await this.getActiveAccount(userId, exchange);
    if (!account) {
      throw new Error(`No ${exchange} account linked yet. Use /link to connect one first.`);
    }
    if (account.status !== 'VERIFIED') {
      throw new Error(`Your ${exchange} account is not verified yet.`);
    }
    return account;
  }

  /**
   * Generates a fresh, bot-held Solana wallet and links it as the user's
   * trading wallet for the given exchange. This is the fast path: no
   * external wallet app required, the bot can sign trades instantly.
   */
  async linkNewGeneratedWallet(userId: number, exchange: string): Promise<ExchangeAccount> {
    const adapter = exchangeRegistry.get(exchange);
    const account = await this.getOrCreatePendingAccount(userId, exchange);
    const walletAddress = (await walletKeyService.hasSigningKey(account.id))
      ? (await walletKeyService.getKeypair(account.id)).publicKey.toBase58()
      : await walletKeyService.generateSigningKey(account.id);
    const updated = await this.authenticateAndSave(account, walletAddress, adapter.wallet.linkAccount.bind(adapter.wallet));

    await log.info('AUTH', 'Generated and linked new exchange wallet', {
      userId,
      exchange,
      exchangeAccountId: account.id,
    });

    return updated;
  }

  /** Imports an existing Solana wallet (base58 private key) as the trading wallet. */
  async linkImportedWallet(userId: number, exchange: string, privateKeyBase58: string): Promise<ExchangeAccount> {
    const adapter = exchangeRegistry.get(exchange);
    const account = await this.getOrCreatePendingAccount(userId, exchange);
    // Retain the previous encrypted material until the replacement wallet has
    // authenticated successfully. A failed import must not strand the user
    // without the key/session for their current wallet.
    const previous = {
      walletAddress: account.walletAddress,
      encryptedPrivateKey: account.encryptedPrivateKey,
      privateKeyIv: account.privateKeyIv,
      privateKeyAuthTag: account.privateKeyAuthTag,
      encryptedCredential: account.encryptedCredential,
      credentialIv: account.credentialIv,
      credentialAuthTag: account.credentialAuthTag,
      status: account.status,
      verifiedAt: account.verifiedAt,
    };

    let walletAddress: string;
    let updated: ExchangeAccount;
    try {
      walletAddress = await walletKeyService.storeSigningKey(account.id, privateKeyBase58);
      updated = await this.authenticateAndSave(account, walletAddress, adapter.wallet.linkAccount.bind(adapter.wallet));
    } catch (error) {
      await prisma.exchangeAccount.update({ where: { id: account.id }, data: previous });
      throw error;
    }

    await log.info('AUTH', 'Imported and linked exchange wallet', {
      userId,
      exchange,
      exchangeAccountId: account.id,
    });

    return updated;
  }

  async markVerified(exchangeAccountId: number): Promise<ExchangeAccount> {
    return prisma.exchangeAccount.update({
      where: { id: exchangeAccountId },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }

  /**
   * Phoenix referral onboarding registers and activates the default trader
   * account in one Phoenix-signed transaction. The user wallet still pays
   * any required account rent and network fees.
   */
  async activatePhoenixReferralAndRegister(userId: number, referralCode: string): Promise<{ account: ExchangeAccount; transactionSignature?: string }> {
    const account = await this.getActiveAccount(userId, 'phoenix');
    if (!account) throw new Error('Link a Phoenix wallet before activating a referral.');
    if (account.status === 'VERIFIED') throw new Error('Your Phoenix account is already verified.');

    const activation = await phoenixReferralService.activateReferral(account.id, referralCode);
    const verified = await this.markVerified(account.id);
    await log.info('AUTH', 'Activated Phoenix referral and registered trader account', {
      userId,
      exchangeAccountId: account.id,
      traderPda: activation.traderPda,
      transactionSignature: activation.transactionSignature,
    });
    return { account: verified, transactionSignature: activation.transactionSignature };
  }

  async registerUserFundedPhoenixAccount(userId: number, exchange: string): Promise<{ account: ExchangeAccount; transactionSignature: string }> {
    const account = await this.getActiveAccount(userId, exchange);
    if (!account) throw new Error(`No ${exchange} wallet is linked yet. Start onboarding first.`);
    if (account.status === 'VERIFIED') throw new Error('Your Phoenix account is already verified.');
    if (exchange === 'phoenix' && (await phoenixReferralService.isRequired()) && !(await phoenixReferralService.hasActivatedReferral(account.id))) {
      throw new Error('A valid Phoenix referral code is required before registration. Send /start to continue onboarding.');
    }
    const adapter = exchangeRegistry.get(exchange);
    if (!adapter.wallet.registerAccount) throw new Error(`${adapter.displayName} does not support wallet-funded registration.`);

    const result = await adapter.wallet.registerAccount(account.walletAddress, await walletKeyService.getKeypair(account.id));
    const verified = await this.markVerified(account.id);
    await log.info('AUTH', 'Registered user-funded Phoenix trader account', {
      userId,
      exchange,
      exchangeAccountId: account.id,
      transactionSignature: result.transactionSignature,
    });
    return { account: verified, transactionSignature: result.transactionSignature };
  }

  async getCredential(account: ExchangeAccount): Promise<ExchangeCredential> {
    if (!account.encryptedCredential || !account.credentialIv || !account.credentialAuthTag) {
      return { walletAddress: account.walletAddress };
    }
    return {
      walletAddress: account.walletAddress,
      sessionSecret: decrypt({
        ciphertext: account.encryptedCredential,
        iv: account.credentialIv,
        authTag: account.credentialAuthTag,
      }),
    };
  }

  private async getOrCreatePendingAccount(userId: number, exchange: string): Promise<ExchangeAccount> {
    const existing = await this.getActiveAccount(userId, exchange);
    if (existing) {
      // There is one wallet per exchange. Link/import intentionally replaces
      // it, after the new wallet has authenticated successfully.
      return existing;
    }
    return prisma.exchangeAccount.create({
      data: { userId, exchange, walletAddress: 'pending', status: 'PENDING_VERIFICATION' },
    });
  }

  private async authenticateAndSave(
    account: ExchangeAccount,
    walletAddress: string,
    linkAccount: (walletAddress: string, signMessage: (message: Uint8Array) => Promise<string>) => Promise<LinkAccountResult>,
  ): Promise<ExchangeAccount> {
    const linkResult = await linkAccount(walletAddress, (message) => walletKeyService.signMessage(account.id, message));
    const credential = linkResult.sessionSecret ? encrypt(linkResult.sessionSecret) : null;
    return prisma.exchangeAccount.update({
      where: { id: account.id },
      data: {
        walletAddress,
        encryptedCredential: credential?.ciphertext,
        credentialIv: credential?.iv,
        credentialAuthTag: credential?.authTag,
        status: linkResult.requiresOnChainActivation || linkResult.requiresTraderRegistration ? 'PENDING_VERIFICATION' : 'VERIFIED',
        verifiedAt: linkResult.requiresOnChainActivation || linkResult.requiresTraderRegistration ? null : new Date(),
      },
    });
  }
}

export const exchangeAccountService = new ExchangeAccountService();
