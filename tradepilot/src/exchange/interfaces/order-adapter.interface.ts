import {
  CancelOrderParams,
  ExchangeCredential,
  PlaceOrderParams,
  PlaceOrderResult,
} from '../../types/exchange.types';

export interface ExchangeOrder {
  externalOrderId: string;
  market: string;
  side: 'BUY' | 'SELL';
  type: string;
  size: number;
  price: number | null;
  status: string;
  createdAt: number;
}

export interface OrderAdapter {
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
  cancelOrder(params: CancelOrderParams): Promise<boolean>;
  getOpenOrders(credential: ExchangeCredential, market?: string): Promise<ExchangeOrder[]>;
}
