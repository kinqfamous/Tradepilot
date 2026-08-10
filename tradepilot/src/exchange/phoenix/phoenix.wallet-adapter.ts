import { WalletAdapter, LinkAccountResult, WalletMessageSigner } from '../interfaces/wallet-adapter.interface';
import { AccountBalance, ExchangeCredential } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';
import { PhoenixHttpClient } from '@ellipsis-labs/rise';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { config } from '../../config/env';

interface PhoenixNonceResponse {
  message: string;
  nonce_id: string;
  expires_at: string;
}

interface PhoenixWalletLoginResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  token_type: string;
}

interface PhoenixBalanceResponse {
  balances: Array<{ asset: string; total: string; available: string; usedMargin: string }>;
}

export class PhoenixWalletAdapter implements WalletAdapter {
  constructor(private readonly client: PhoenixRestClient) {}

  async linkAccount(walletAddress: string, signMessage: WalletMessageSigner): Promise<LinkAccountResult> {
    const nonce = await this.client.get<PhoenixNonceResponse>(PHOENIX_ENDPOINTS.authNonce, undefined, {
      wallet_pubkey: walletAddress,
    });
    const signature = await signMessage(new TextEncoder().encode(nonce.message));
    const session = await this.client.post<PhoenixWalletLoginResponse>(PHOENIX_ENDPOINTS.authWalletLogin, {
      wallet_pubkey: walletAddress,
      nonce_id: nonce.nonce_id,
      signature,
    });

    return {
      walletAddress,
      sessionSecret: session.access_token,
      // Authentication does not create a trader account. Phoenix onboarding is
      // completed separately through its invite or registration transaction flow.
      requiresOnChainActivation: false,
      requiresTraderRegistration: true,
    };
  }

  async getBalances(credential: ExchangeCredential): Promise<AccountBalance[]> {
    const response = await this.client.get<PhoenixBalanceResponse>(
      PHOENIX_ENDPOINTS.traderBalances(credential.walletAddress),
      credential.sessionSecret,
    );

    return response.balances.map((b) => ({
      asset: b.asset,
      total: Number(b.total),
      available: Number(b.available),
      usedMargin: Number(b.usedMargin),
    }));
  }

  async registerAccount(walletAddress: string, feePayer: Keypair) {
    if (feePayer.publicKey.toBase58() !== walletAddress) {
      throw new Error('The registration fee payer must be the wallet being registered.');
    }

    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const balance = await connection.getBalance(feePayer.publicKey, 'confirmed');
    const minimumLamports = Math.ceil(config.phoenix.registrationMinSol * LAMPORTS_PER_SOL);
    if (balance < minimumLamports) {
      throw new Error(
        `Fund this wallet with at least ${config.phoenix.registrationMinSol} SOL before registering with Phoenix.`,
      );
    }

    const phoenix = new PhoenixHttpClient({ apiUrl: config.phoenix.restUrl });
    const built = await phoenix.exchange().buildRegisterIxs({
      traderAuthority: walletAddress,
      txFeePayer: walletAddress,
      maxPositions: 128,
    });
    const instructions = built.instructions.map(
      (instruction) =>
        new TransactionInstruction({
          programId: new PublicKey(instruction.programId),
          keys: instruction.keys.map((key) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
          })),
          data: Buffer.from(instruction.data),
        }),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash }).add(...instructions);
    transaction.partialSign(feePayer);

    // Check account-rent requirements locally before asking Phoenix to sign and
    // submit the transaction. The exact rent depends on the live account size.
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      const insufficientFunds = simulation.value.logs
        ?.join('\n')
        .match(/Transfer: insufficient lamports (\d+), need (\d+)/);
      if (insufficientFunds) {
        const currentSol = Number(insufficientFunds[1]) / LAMPORTS_PER_SOL;
        const requiredSol = Number(insufficientFunds[2]) / LAMPORTS_PER_SOL;
        throw new Error(
          `Insufficient SOL for Phoenix account rent. Current balance: ${currentSol.toFixed(6)} SOL; ` +
            `required before fees: ${requiredSol.toFixed(6)} SOL. Fund the wallet to at least ${
              (requiredSol + 0.001).toFixed(3)
            } SOL and try again.`,
        );
      }
      throw new Error(`Phoenix registration preflight failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const submitted = await phoenix.exchange().sendRegisterIxs({
      transaction: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      traderAuthority: walletAddress,
      txFeePayer: walletAddress,
      maxPositions: 128,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    const confirmation = await connection.confirmTransaction(
      { signature: submitted.signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`Phoenix registration transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { transactionSignature: submitted.signature, traderAccount: submitted.traderPda };
  }
}
