import { WalletAdapter } from './wallet-adapter.interface';
import { MarketAdapter } from './market-adapter.interface';
import { PositionAdapter } from './position-adapter.interface';
import { OrderAdapter } from './order-adapter.interface';
import { TradingAdapter } from './trading-adapter.interface';
import { RealtimeEventHandler } from '../../types/exchange.types';

/**
 * Real-time subscription surface. Every exchange adapter that supports
 * streaming implements this; the WebSocket transport details (reconnects,
 * heartbeats, backoff) live entirely inside the adapter implementation.
 */
export interface RealtimeAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  subscribePrices(markets: string[], handler: RealtimeEventHandler): void;
  subscribeAccount(walletAddress: string, handler: RealtimeEventHandler): void;
  unsubscribeAccount(walletAddress: string): void;
}

/**
 * The single object a new exchange integration must produce. Phoenix is
 * the first implementation; Hyperliquid/Drift/Jupiter Perps only need to
 * implement this same interface and register themselves in
 * ExchangeRegistry - nothing else in the codebase should ever import a
 * concrete exchange module directly.
 */
export interface ExchangeAdapter {
  readonly key: string; // e.g. "phoenix"
  readonly displayName: string; // e.g. "Phoenix Perps"

  wallet: WalletAdapter;
  market: MarketAdapter;
  position: PositionAdapter;
  order: OrderAdapter;
  trading: TradingAdapter;
  realtime: RealtimeAdapter;
}
