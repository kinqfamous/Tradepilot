import { MarketAdapter } from '../interfaces/market-adapter.interface';
import { MarketInfo, OrderBookSnapshot } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';

interface PhoenixMarketResponse {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  openInterest: string;
  maxLeverage: number;
  minOrderSize: string;
  tickSize: string;
}

interface PhoenixMarketsResponse {
  markets: PhoenixMarketResponse[];
}

interface PhoenixOrderBookResponse {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

const MARKET_CACHE_TTL_MS = 30_000;

function toMarketInfo(m: PhoenixMarketResponse): MarketInfo {
  return {
    symbol: m.symbol,
    baseAsset: m.baseAsset,
    quoteAsset: m.quoteAsset,
    markPrice: Number(m.markPrice),
    indexPrice: Number(m.indexPrice),
    fundingRate: Number(m.fundingRate),
    openInterest: Number(m.openInterest),
    maxLeverage: m.maxLeverage,
    minOrderSize: Number(m.minOrderSize),
    tickSize: Number(m.tickSize),
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

    const response = await this.client.get<PhoenixMarketsResponse>(PHOENIX_ENDPOINTS.markets);
    const markets = response.markets.map(toMarketInfo);
    this.cache = { markets, fetchedAt: now };
    return markets;
  }

  async getMarket(symbol: string): Promise<MarketInfo | null> {
    const cached = (await this.listMarkets()).find((m) => m.symbol === symbol);
    if (cached) return cached;

    try {
      const response = await this.client.get<PhoenixMarketResponse>(PHOENIX_ENDPOINTS.market(symbol));
      return toMarketInfo(response);
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
