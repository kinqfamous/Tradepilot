import crypto from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { prisma } from '../database/prisma';
import { encrypt, decrypt } from '../utils/encryption';
import { log } from '../logger/logger';

/**
 * Manages the optional bot-held Solana signing key for a linked exchange
 * account. Users who want instant in-Telegram execution (long/short/close
 * without leaving the chat) opt into bot-signed trading; the private key
 * is encrypted at rest with the same AES-256-GCM scheme used throughout
 * the platform and only decrypted in-memory to sign a specific transaction.
 */
export class WalletKeyService {
  async storeSigningKey(exchangeAccountId: number, privateKeyBase58: string): Promise<string> {
    let secretKey: Uint8Array;
    try {
      secretKey = bs58.decode(privateKeyBase58.trim());
    } catch {
      throw new Error('That does not look like a valid base58 Solana private key.');
    }
    if (secretKey.length !== 64) {
      throw new Error('Invalid private key length. Expected a 64-byte Solana secret key.');
    }

    const keypair = Keypair.fromSecretKey(secretKey);
    const { ciphertext, iv, authTag } = encrypt(privateKeyBase58.trim());

    await prisma.exchangeAccount.update({
      where: { id: exchangeAccountId },
      data: {
        encryptedPrivateKey: ciphertext,
        privateKeyIv: iv,
        privateKeyAuthTag: authTag,
      },
    });

    await log.info('AUTH', 'Stored bot-signing key for exchange account', { exchangeAccountId });

    return keypair.publicKey.toBase58();
  }

  async generateSigningKey(exchangeAccountId: number): Promise<string> {
    const keypair = Keypair.generate();
    await this.storeSigningKey(exchangeAccountId, bs58.encode(keypair.secretKey));
    return keypair.publicKey.toBase58();
  }

  async getKeypair(exchangeAccountId: number): Promise<Keypair> {
    const account = await prisma.exchangeAccount.findUnique({ where: { id: exchangeAccountId } });
    if (!account || !account.encryptedPrivateKey || !account.privateKeyIv || !account.privateKeyAuthTag) {
      throw new Error('This account does not have a bot-signing key configured.');
    }

    const privateKeyBase58 = decrypt({
      ciphertext: account.encryptedPrivateKey,
      iv: account.privateKeyIv,
      authTag: account.privateKeyAuthTag,
    });

    return Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  }

  /** Signs an arbitrary wallet-login message and returns the Phoenix-required base58 signature. */
  async signMessage(exchangeAccountId: number, message: Uint8Array): Promise<string> {
    const keypair = await this.getKeypair(exchangeAccountId);
    // Ed25519 PKCS#8 prefix followed by the 32-byte seed from Solana's 64-byte secret key.
    const privateKeyDer = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(keypair.secretKey.slice(0, 32)),
    ]);
    const signature = crypto.sign(
      null,
      Buffer.from(message),
      crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }),
    );
    return bs58.encode(signature);
  }

  async hasSigningKey(exchangeAccountId: number): Promise<boolean> {
    const account = await prisma.exchangeAccount.findUnique({ where: { id: exchangeAccountId } });
    return Boolean(account?.encryptedPrivateKey);
  }
}

export const walletKeyService = new WalletKeyService();
