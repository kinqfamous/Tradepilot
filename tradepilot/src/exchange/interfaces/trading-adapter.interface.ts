import { ClosePositionParams, ExchangeCredential, PlaceOrderResult } from '../../types/exchange.types';

export interface OpenPositionParams {
  credential: ExchangeCredential;
  market: string;
  side: 'LONG' | 'SHORT';
  collateralUsd: number;
  leverage: number;
  slippageBps: number;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  idempotencyKey: string;
}

/**
 * High-level trading operations composed from OrderAdapter + PositionAdapter.
 * This is the interface the bot/trading service calls directly - it never
 * talks to OrderAdapter/PositionAdapter for a specific exchange itself.
 */
export interface TradingAdapter {
  openPosition(params: OpenPositionParams): Promise<PlaceOrderResult>;
  closePosition(params: ClosePositionParams): Promise<PlaceOrderResult>;
  closeAllPositions(credential: ExchangeCredential): Promise<PlaceOrderResult[]>;
}
