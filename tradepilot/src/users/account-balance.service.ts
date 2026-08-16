import { exchangeRegistry } from '../exchange/exchange.registry';
import { walletKeyService } from '../exchange/wallet-key.service';
import { ExchangeAccount } from '@prisma/client';
import { exchangeAccountService } from './exchange-account.service';
import { WalletAccountBalances, WithdrawalResult } from '../types/exchange.types';

export class AccountBalanceService {
  async getWalletBalances(userId: number, exchange: string): Promise<WalletAccountBalances> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const wallet = exchangeRegistry.get(exchange).wallet;
    if (!wallet.getWalletBalances) throw new Error('Wallet balances are not available for this exchange.');
    return wallet.getWalletBalances(await exchangeAccountService.getCredential(account));
  }

  async withdrawFromPhoenix(userId: number, exchange: string, amount: number): Promise<WithdrawalResult> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    return this.withdrawPhoenixAccount(account, amount);
  }

  async fundPhoenix(userId: number, exchange: string, amount: number): Promise<WithdrawalResult> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const wallet = exchangeRegistry.get(exchange).wallet;
    if (!wallet.depositFromLinkedWallet) throw new Error('Phoenix funding is not available for this exchange.');
    return wallet.depositFromLinkedWallet(
      await exchangeAccountService.getCredential(account),
      await walletKeyService.getKeypair(account.id),
      amount,
    );
  }

  async withdrawFromWallet(userId: number, exchange: string, destination: string, amount: number): Promise<WithdrawalResult> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const wallet = exchangeRegistry.get(exchange).wallet;
    if (!wallet.withdrawFromWallet) throw new Error('Wallet withdrawals are not available for this exchange.');
    return wallet.withdrawFromWallet(
      await exchangeAccountService.getCredential(account),
      await walletKeyService.getKeypair(account.id),
      destination,
      amount,
    );
  }

  private async withdrawPhoenixAccount(account: ExchangeAccount, amount: number): Promise<WithdrawalResult> {
    const wallet = exchangeRegistry.get(account.exchange).wallet;
    if (!wallet.withdrawToLinkedWallet) throw new Error('Phoenix withdrawals are not available for this exchange.');
    // No destination parameter exists here by design: Phoenix funds can only
    // return to this account's linked wallet.
    return wallet.withdrawToLinkedWallet(
      await exchangeAccountService.getCredential(account),
      await walletKeyService.getKeypair(account.id),
      amount,
    );
  }
}

export const accountBalanceService = new AccountBalanceService();
