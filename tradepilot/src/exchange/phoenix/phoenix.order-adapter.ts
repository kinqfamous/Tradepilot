import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { OrderAdapter, ExchangeOrder } from '../interfaces/order-adapter.interface';
import {
  CancelOrderParams,
  ExchangeCredential,
  PlaceOrderParams,
  PlaceOrderResult,
} from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';
import { withRetry } from '../../utils/retry';
import { config } from '../../config/env';

interface BuildTxResponse {
  transaction: string; // base64-encoded unsigned VersionedTransaction
}

interface SubmitTxResponse {
  signature: string;
  status: 'submitted' | 'rejected';
  errorMessage?: string;
}

interface PhoenixOrderResponse {
  orderId: string;
  market: string;
  side: 'buy' | 'sell';
  type: string;
  size: string;
  price: string | null;
  status: string;
  createdAt: number;
}

interface PhoenixOrdersResponse {
  orders: PhoenixOrderResponse[];
}

/**
 * Resolves the signer for a given credential. The bot signs on the user's
 * behalf using their encrypted, bot-held key (see WalletKeyService) -
 * consistent with how the rest of the platform executes trades instantly
 * from a Telegram conversation without bouncing to an external wallet app.
 */
export interface PhoenixSignerResolver {
  getKeypair(walletAddress: string): Promise<Keypair>;
}

export class PhoenixOrderAdapter implements OrderAdapter {
  constructor(
    private readonly client: PhoenixRestClient,
    private readonly connection: Connection,
    private readonly signerResolver: PhoenixSignerResolver,
  ) {}

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    return withRetry(async () => {
      const buildResponse = await this.client.post<BuildTxResponse>(
        PHOENIX_ENDPOINTS.buildOrderTx,
        {
          walletAddress: params.credential.walletAddress,
          market: params.market,
          side: params.side.toLowerCase(),
          type: params.type.toLowerCase(),
          size: params.size,
          leverage: params.leverage,
          slippageBps: params.slippageBps,
          price: params.price,
          triggerPrice: params.triggerPrice,
          reduceOnly: params.reduceOnly ?? false,
          idempotencyKey: params.idempotencyKey,
        },
        params.credential.sessionSecret,
      );

      const signer = await this.signerResolver.getKeypair(params.credential.walletAddress);
      const tx = VersionedTransaction.deserialize(Buffer.from(buildResponse.transaction, 'base64'));
      tx.sign([signer]);

      const submitResponse = await this.client.post<SubmitTxResponse>(
        PHOENIX_ENDPOINTS.submitTx,
        { transaction: Buffer.from(tx.serialize()).toString('base64') },
        params.credential.sessionSecret,
      );

      if (submitResponse.status === 'rejected') {
        return {
          externalOrderId: '',
          status: 'REJECTED',
          errorMessage: submitResponse.errorMessage ?? 'Order rejected by Phoenix.',
        };
      }

      await this.connection.confirmTransaction(submitResponse.signature, 'confirmed');

      return {
        externalOrderId: submitResponse.signature,
        status: 'SUBMITTED',
        txSignature: submitResponse.signature,
      };
    });
  }

  async cancelOrder(params: CancelOrderParams): Promise<boolean> {
    const buildResponse = await this.client.post<BuildTxResponse>(
      PHOENIX_ENDPOINTS.buildCancelTx,
      { walletAddress: params.credential.walletAddress, orderId: params.externalOrderId, market: params.market },
      params.credential.sessionSecret,
    );

    const signer = await this.signerResolver.getKeypair(params.credential.walletAddress);
    const tx = VersionedTransaction.deserialize(Buffer.from(buildResponse.transaction, 'base64'));
    tx.sign([signer]);

    const submitResponse = await this.client.post<SubmitTxResponse>(
      PHOENIX_ENDPOINTS.submitTx,
      { transaction: Buffer.from(tx.serialize()).toString('base64') },
      params.credential.sessionSecret,
    );

    return submitResponse.status === 'submitted';
  }

  async getOpenOrders(credential: ExchangeCredential, market?: string): Promise<ExchangeOrder[]> {
    const response = await this.client.get<PhoenixOrdersResponse>(
      PHOENIX_ENDPOINTS.traderOrders(credential.walletAddress),
      credential.sessionSecret,
      market ? { market } : undefined,
    );

    return response.orders.map((o) => ({
      externalOrderId: o.orderId,
      market: o.market,
      side: o.side === 'buy' ? 'BUY' : 'SELL',
      type: o.type,
      size: Number(o.size),
      price: o.price ? Number(o.price) : null,
      status: o.status,
      createdAt: o.createdAt,
    }));
  }
}

export function createPhoenixConnection(): Connection {
  return new Connection(config.phoenix.solanaRpcUrl, 'confirmed');
}
