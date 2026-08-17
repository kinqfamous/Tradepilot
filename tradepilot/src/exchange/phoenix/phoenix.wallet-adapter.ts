import { WalletAdapter, LinkAccountResult, WalletMessageSigner } from '../interfaces/wallet-adapter.interface';
import { AccountBalance, ExchangeCredential, WalletAccountBalances, WithdrawalResult } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';
import { createPhoenixClient, PhoenixHttpClient } from '@ellipsis-labs/rise';
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

interface PhoenixTraderStateResponse {
  snapshot: {
    subaccounts: Array<{ collateral: string }>;
  };
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC_DECIMALS = 6;
// Phoenix returns subaccount collateral as integer micro-PhUSD, the same
// precision used by its deposit/withdrawal instructions. It is not a UI USD
// amount, so exposing it directly makes a 4 USDC deposit look like 4,000,000.
const PHUSD_DECIMALS = 6;

function fromAtomicPhusd(amount: string): number {
  if (!/^-?\d+$/.test(amount)) {
    throw new Error('Phoenix returned an invalid collateral balance.');
  }
  return Number(BigInt(amount)) / 10 ** PHUSD_DECIMALS;
}

function toAtomicUsdc(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,6})?$/.test(String(amount))) {
    throw new Error('Enter a positive USDC amount with no more than 6 decimal places.');
  }
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((fraction + '000000').slice(0, USDC_DECIMALS));
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function createAtaIdempotentInstruction(payer: PublicKey, owner: PublicKey, mint: PublicKey, ata: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferInstruction(source: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3; // SPL Token Transfer
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
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
    const response = await this.client.get<PhoenixTraderStateResponse>(PHOENIX_ENDPOINTS.traderState(credential.walletAddress));
    const total = response.snapshot.subaccounts.reduce((sum, account) => sum + fromAtomicPhusd(account.collateral), 0);

    // Phoenix's trader-state endpoint reports the canonical collateral token,
    // PhUSD, in atomic micro-units, rather than the USDC wallet balance used
    // to make a deposit.
    return [{ asset: 'PhUSD', total, available: total, usedMargin: 0 }];
  }

  async getWalletBalances(credential: ExchangeCredential): Promise<WalletAccountBalances> {
    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const owner = new PublicKey(credential.walletAddress);
    const mint = await this.getUsdcMint();
    const [solLamports, tokenAccounts] = await Promise.all([
      connection.getBalance(owner, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed'),
    ]);
    const usdc = tokenAccounts.value.reduce((sum, account) => sum + Number(account.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
    return { sol: solLamports / LAMPORTS_PER_SOL, usdc };
  }

  async depositFromLinkedWallet(credential: ExchangeCredential, signer: Keypair, amount: number): Promise<WithdrawalResult> {
    if (signer.publicKey.toBase58() !== credential.walletAddress) throw new Error('Funding signer does not match the linked wallet.');
    const atomicAmount = toAtomicUsdc(amount);
    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const mint = await this.getUsdcMint();
    const source = associatedTokenAddress(signer.publicKey, mint);
    const sourceBalance = await connection.getTokenAccountBalance(source, 'confirmed').catch(() => null);
    if (!sourceBalance || BigInt(sourceBalance.value.amount) < atomicAmount) throw new Error('Your wallet does not have enough USDC to fund Phoenix.');
    const phoenix = createPhoenixClient({ apiUrl: config.phoenix.restUrl, rpcUrl: config.phoenix.solanaRpcUrl, ws: false });
    try {
      const built = await phoenix.ixs.buildDepositIxs({ authority: credential.walletAddress as never, amount: atomicAmount });
      const instructions = built.instructions.map((instruction) => new TransactionInstruction({
        programId: new PublicKey(instruction.programAddress),
        keys: instruction.accounts.map((account) => ({
          pubkey: new PublicKey(account.address),
          isSigner: account.role === 2 || account.role === 3,
          isWritable: account.role === 1 || account.role === 3,
        })),
        data: Buffer.from(instruction.data),
      }));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(...instructions);
      transaction.sign(signer);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Phoenix funding failed: ${JSON.stringify(confirmation.value.err)}`);
      return { transactionSignature: signature };
    } finally {
      phoenix.dispose();
    }
  }

  async withdrawToLinkedWallet(credential: ExchangeCredential, signer: Keypair, amount: number): Promise<WithdrawalResult> {
    if (signer.publicKey.toBase58() !== credential.walletAddress) throw new Error('Withdrawal signer does not match the linked wallet.');
    const atomicAmount = toAtomicUsdc(amount);
    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const phoenix = createPhoenixClient({ apiUrl: config.phoenix.restUrl, rpcUrl: config.phoenix.solanaRpcUrl, ws: false });
    try {
      const built = await phoenix.ixs.buildWithdrawIxs({ authority: credential.walletAddress as never, amount: atomicAmount });
      const instructions = built.instructions.map((instruction) => new TransactionInstruction({
        programId: new PublicKey(instruction.programAddress),
        keys: instruction.accounts.map((account) => ({
          pubkey: new PublicKey(account.address),
          isSigner: account.role === 2 || account.role === 3,
          isWritable: account.role === 1 || account.role === 3,
        })),
        data: Buffer.from(instruction.data),
      }));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(...instructions);
      transaction.sign(signer);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Phoenix withdrawal failed: ${JSON.stringify(confirmation.value.err)}`);
      return { transactionSignature: signature };
    } finally {
      phoenix.dispose();
    }
  }

  async withdrawFromWallet(credential: ExchangeCredential, signer: Keypair, destination: string, amount: number): Promise<WithdrawalResult> {
    if (signer.publicKey.toBase58() !== credential.walletAddress) throw new Error('Withdrawal signer does not match the linked wallet.');
    const atomicAmount = toAtomicUsdc(amount);
    const destinationOwner = new PublicKey(destination);
    const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
    const mint = await this.getUsdcMint();
    const source = associatedTokenAddress(signer.publicKey, mint);
    const target = associatedTokenAddress(destinationOwner, mint);
    const sourceBalance = await connection.getTokenAccountBalance(source, 'confirmed').catch(() => null);
    if (!sourceBalance || BigInt(sourceBalance.value.amount) < atomicAmount) throw new Error('Your wallet does not have enough USDC for this withdrawal.');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(
      createAtaIdempotentInstruction(signer.publicKey, destinationOwner, mint, target),
      transferInstruction(source, target, signer.publicKey, atomicAmount),
    );
    transaction.sign(signer);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) throw new Error(`Wallet withdrawal failed: ${JSON.stringify(confirmation.value.err)}`);
    return { transactionSignature: signature };
  }

  private async getUsdcMint(): Promise<PublicKey> {
    const exchange = await new PhoenixHttpClient({ apiUrl: config.phoenix.restUrl }).exchange().getSnapshot();
    // Deposits source standard USDC from the linked wallet. canonicalMint is
    // Phoenix's internal PhUSD collateral mint, so using it for this preflight
    // incorrectly reports a missing USDC balance.
    return new PublicKey(exchange.exchange.usdcMint);
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
