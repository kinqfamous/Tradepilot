import { MarketInfo, OrderBookSnapshot } from '../../types/exchange.types';

/**
 * Handles read-only market data. Implementations should cache aggressively
 * where the exchange allows it (market metadata changes rarely; prices do not).
 */
export interface MarketAdapter {
  listMarkets(): Promise<MarketInfo[]>;
  getMarket(symbol: string): Promise<MarketInfo | null>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBookSnapshot>;
}
