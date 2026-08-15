import { MarketAdapter } from '../interfaces/market-adapter.interface';
import { MarketInfo, OrderBookSnapshot } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';

interface PhoenixMarketResponse {
  symbol: string;
  baseLotsDecimals: number;
  tickSize: number;
  leverageTiers: Array<{ maxLeverage: number }>;
}

interface PhoenixMarkPriceResponse {
  symbol: string;
  markPrice: { price: number } | null;
}

interface PhoenixOrderBookResponse {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

const MARKET_CACHE_TTL_MS = 30_000;

function toMarketInfo(m: PhoenixMarketResponse, markPrice?: number): MarketInfo {
  const [baseAsset = m.symbol, quoteAsset = 'USD'] = m.symbol.split('-');
  return {
    symbol: m.symbol,
    baseAsset,
    quoteAsset,
    markPrice: markPrice ?? 0,
    indexPrice: markPrice ?? 0,
    fundingRate: 0,
    openInterest: 0,
    maxLeverage: Math.max(...m.leverageTiers.map((tier) => tier.maxLeverage), 1),
    minOrderSize: 10 ** -m.baseLotsDecimals,
    tickSize: m.tickSize,
  };
}

export class PhoenixMarketAdapter implements MarketAdapter {
  private cache: { markets: MarketInfo[]; fetchedAt: number } | null = null;

  constructor(private readonly client: PhoenixRestClient) {}

  async listMarkets(): Promise<MarketInfo[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < MARKET_CACHE_TTL_MS) {
      return this.cache.markets;
    }

    const configs = await this.client.get<PhoenixMarketResponse[]>(PHOENIX_ENDPOINTS.markets);
    const markets = configs.map((market) => toMarketInfo(market));
    this.cache = { markets, fetchedAt: now };
    return markets;
  }

  async getMarket(symbol: string): Promise<MarketInfo | null> {
    try {
      const [market, markPrice] = await Promise.all([
        this.client.get<PhoenixMarketResponse>(PHOENIX_ENDPOINTS.market(symbol)),
        this.client.get<PhoenixMarkPriceResponse>(PHOENIX_ENDPOINTS.markPrice(symbol)),
      ]);
      return toMarketInfo(market, markPrice.markPrice?.price);
    } catch {
      return null;
    }
  }

  async getOrderBook(symbol: string, depth = 20): Promise<OrderBookSnapshot> {
    const response = await this.client.get<PhoenixOrderBookResponse>(
      PHOENIX_ENDPOINTS.orderBook(symbol),
      undefined,
      { depth },
    );

    return {
      market: response.symbol,
      bids: response.bids.map(([price, size]) => ({ price: Number(price), size: Number(size) })),
      asks: response.asks.map(([price, size]) => ({ price: Number(price), size: Number(size) })),
      timestamp: response.timestamp,
    };
  }
}
