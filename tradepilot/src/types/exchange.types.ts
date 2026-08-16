export type PositionSide = 'LONG' | 'SHORT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';

export interface ExchangeCredential {
  walletAddress: string;
  /** Decrypted session/auth secret, if the exchange requires one beyond wallet signatures. */
  sessionSecret?: string;
}

export interface MarketInfo {
  symbol: string; // e.g. "SOL-PERP"
  baseAsset: string;
  quoteAsset: string;
  markPrice: number;
  indexPrice: number;
  /** Change in the mark price over the preceding 24 hours, as a percentage. */
  priceChange24hPercent: number;
  fundingRate: number; // per funding interval, decimal (0.0001 = 0.01%)
  openInterest: number;
  maxLeverage: number;
  minOrderSize: number;
  tickSize: number;
}

export interface AccountBalance {
  asset: string;
  total: number;
  available: number;
  usedMargin: number;
}

export interface WalletAccountBalances {
  sol: number;
  usdc: number;
}

export interface WithdrawalResult {
  transactionSignature: string;
}

export interface ExchangePosition {
  externalId: string;
  market: string;
  side: PositionSide;
  entryPrice: number;
  markPrice: number;
  size: number;
  leverage: number;
  margin: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  roePercent: number;
  fundingPaid: number;
}

export interface PlaceOrderParams {
  credential: ExchangeCredential;
  market: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  leverage: number;
  slippageBps: number;
  price?: number; // required for LIMIT
  triggerPrice?: number; // required for STOP_LOSS / TAKE_PROFIT
  reduceOnly?: boolean;
  idempotencyKey: string;
}

export interface PlaceOrderResult {
  externalOrderId: string;
  status: 'SUBMITTED' | 'FILLED' | 'REJECTED';
  txSignature?: string;
  fillPrice?: number;
  errorMessage?: string;
}

export interface CancelOrderParams {
  credential: ExchangeCredential;
  externalOrderId: string;
  market: string;
}

export interface ClosePositionParams {
  credential: ExchangeCredential;
  market: string;
  percent: number; // 1-100
  slippageBps: number;
  idempotencyKey: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  market: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export type RealtimeEventType =
  | 'price'
  | 'position_update'
  | 'order_update'
  | 'pnl_update'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface RealtimeEvent<T = unknown> {
  type: RealtimeEventType;
  market?: string;
  walletAddress?: string;
  payload: T;
  timestamp: number;
}

export type RealtimeEventHandler = (event: RealtimeEvent) => void;
