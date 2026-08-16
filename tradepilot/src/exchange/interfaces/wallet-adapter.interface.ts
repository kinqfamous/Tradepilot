import { AccountBalance, ExchangeCredential, WalletAccountBalances, WithdrawalResult } from '../../types/exchange.types';
import type { Keypair } from '@solana/web3.js';

export interface LinkAccountResult {
  walletAddress: string;
  sessionSecret?: string;
  requiresOnChainActivation: boolean;
  /** The wallet authenticated, but the exchange still requires trader registration. */
  requiresTraderRegistration?: boolean;
  /** Base64/hex unsigned transaction the user's wallet must sign to activate, if required. */
  activationTransaction?: string;
}

/** Signs the exact byte sequence supplied by an exchange during wallet login. */
export type WalletMessageSigner = (message: Uint8Array) => Promise<string>;

export interface RegisterAccountResult {
  transactionSignature: string;
  traderAccount: string;
}

/**
 * Handles linking a user's wallet to the exchange and reading balances.
 * Every exchange adapter must implement this so onboarding never needs
 * exchange-specific branches in the bot layer.
 */
export interface WalletAdapter {
  /** Links a wallet, signing any exchange challenge with the wallet authority. */
  linkAccount(walletAddress: string, signMessage: WalletMessageSigner): Promise<LinkAccountResult>;

  /** Registers a trade-ready account on the exchange, using the wallet as fee payer. */
  registerAccount?(walletAddress: string, feePayer: Keypair): Promise<RegisterAccountResult>;

  getBalances(credential: ExchangeCredential): Promise<AccountBalance[]>;
  /** Balances held in the user's Solana wallet, separate from exchange collateral. */
  getWalletBalances?(credential: ExchangeCredential): Promise<WalletAccountBalances>;
  /** Funds Phoenix USDC collateral directly from the linked wallet. */
  depositFromLinkedWallet?(credential: ExchangeCredential, signer: Keypair, amount: number): Promise<WithdrawalResult>;
  /** Moves USDC out of Phoenix. The destination is deliberately the linked wallet only. */
  withdrawToLinkedWallet?(credential: ExchangeCredential, signer: Keypair, amount: number): Promise<WithdrawalResult>;
  /** Sends USDC from the linked wallet to a user-confirmed Solana address. */
  withdrawFromWallet?(credential: ExchangeCredential, signer: Keypair, destination: string, amount: number): Promise<WithdrawalResult>;
}
