import { PhoenixHttpClient } from '@ellipsis-labs/rise';
import { Connection, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { prisma } from '../../database/prisma';
import { config } from '../../config/env';
import { systemStateService } from '../../admin/system-state.service';
import { walletKeyService } from '../wallet-key.service';
import { encrypt } from '../../utils/encryption';

export interface PhoenixReferralActivation {
  transactionSignature?: string;
  traderPda: string;
  status: 'activated' | 'submitted' | 'already_activated';
}

/**
 * Phoenix referral onboarding only. Access/allowlist codes deliberately use
 * a different Phoenix API and are not accepted or validated by this service.
 */
export class PhoenixReferralService {
  async isRequired(): Promise<boolean> {
    const state = await systemStateService.get();
    const [setting] = await prisma.$queryRaw<Array<{ requirePhoenixReferralCode: boolean }>>`
      SELECT "requirePhoenixReferralCode" FROM "SystemState" WHERE "id" = ${state.id}
    `;
    return setting?.requirePhoenixReferralCode ?? true;
  }

  async hasActivatedReferral(exchangeAccountId: number): Promise<boolean> {
    const [account] = await prisma.$queryRaw<Array<{ phoenixReferralActivatedAt: Date | null }>>`
      SELECT "phoenixReferralActivatedAt" FROM "ExchangeAccount" WHERE "id" = ${exchangeAccountId}
    `;
    return Boolean(account?.phoenixReferralActivatedAt);
  }

  /**
   * Activates a referral and onboards the default trader account through
   * Phoenix's referral-specific transaction flow. This is deliberately not
   * the access-code / allowlist endpoint (`/v1/invite/activate`).
   *
   * Phoenix's builder conditionally adds `register_trader` for a missing
   * account, so the wallet remains the fee and rent payer. A referral only
   * changes referral eligibility; it does not sponsor or waive registration.
   */
  async activateReferral(exchangeAccountId: number, referralCode: string): Promise<PhoenixReferralActivation> {
    const normalizedCode = referralCode.trim();
    if (!normalizedCode || normalizedCode.length > 256) {
      throw new Error('Enter a valid Phoenix referral code.');
    }

    const account = await prisma.exchangeAccount.findUnique({ where: { id: exchangeAccountId } });
    if (!account || account.exchange !== 'phoenix' || account.walletAddress === 'pending') {
      throw new Error('Link a Phoenix wallet before activating a referral.');
    }

    // Referral activation requires an authenticated session for the same
    // wallet authority. `authConfig: {}` enables Rise's managed in-memory
    // session; `auth: true` alone does not initialize an auth client.
    const phoenix = new PhoenixHttpClient({
      apiUrl: config.phoenix.restUrl,
      auth: true,
      authConfig: {},
    });
    const auth = phoenix.auth();
    if (!auth) throw new Error('Phoenix authentication is unavailable.');
    const nonce = await auth.getWalletNonce(account.walletAddress);
    const signature = await walletKeyService.signMessage(account.id, new TextEncoder().encode(nonce.message));
    const session = await auth.loginWithWalletSignature(account.walletAddress, signature, nonce.nonce_id);

    const signer = await walletKeyService.getKeypair(account.id);
    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    // `buildActivateReferralTxRequest` is Rise's official referral flow for
    // POST /v1/referral/activate-tx. It checks whether the default trader PDA
    // exists and includes normal registration only when needed.
    const built = await phoenix.invite().buildActivateReferralTxRequest({
      referralCode: normalizedCode,
      traderAuthority: account.walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      recentBlockhash: blockhash,
      lastValidBlockHeight: BigInt(lastValidBlockHeight),
      registerTraderMaxPositions: 128n,
      rpcUrl: config.phoenix.solanaRpcUrl,
      signTransaction: (_transaction, context) => {
        const transaction = VersionedTransaction.deserialize(context.unsignedTransactionBytes);
        transaction.sign([signer]);
        return transaction.serialize();
      },
    });

    // Referral onboarding registers a missing default trader account in this
    // same transaction. Phoenix does not sponsor that registration, so give a
    // clear local error before its simulator returns an opaque program error.
    if (built.includeRegisterTrader) {
      const balance = await connection.getBalance(signer.publicKey, 'confirmed');
      const minimumLamports = Math.ceil(config.phoenix.registrationMinSol * LAMPORTS_PER_SOL);
      if (balance < minimumLamports) {
        throw new Error(
          `Fund this wallet with at least ${config.phoenix.registrationMinSol} SOL before activating the Phoenix referral. ` +
            'Phoenix uses the wallet to pay normal trader-account rent and network fees.',
        );
      }
    }

    const activation = await phoenix.invite().activateReferralTx(built.request);

    // Phoenix submits the fully signed transaction. Do not record local
    // activation until it has landed when Phoenix returns a signature.
    if (activation.signature) {
      const confirmation = await connection.confirmTransaction(activation.signature, 'confirmed');
      if (confirmation.value.err) {
        throw new Error(`Phoenix referral activation transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
    } else if (activation.status !== 'already_activated') {
      throw new Error('Phoenix accepted referral activation without a transaction signature; registration cannot be verified yet. Please try again.');
    }

    // Other Phoenix adapter calls still consume the bearer access token.
    const credential = encrypt(session.accessToken);
    await prisma.$transaction([
      prisma.exchangeAccount.update({
        where: { id: account.id },
        data: {
          encryptedCredential: credential.ciphertext,
          credentialIv: credential.iv,
          credentialAuthTag: credential.authTag,
        },
      }),
      prisma.$executeRaw`
        UPDATE "ExchangeAccount" SET "phoenixReferralActivatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${account.id}
      `,
    ]);

    return {
      transactionSignature: activation.signature,
      traderPda: activation.trader_pda,
      status: activation.status,
    };
  }
}

export const phoenixReferralService = new PhoenixReferralService();
