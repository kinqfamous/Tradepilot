import { MarketAdapter } from '../interfaces/market-adapter.interface';
import { MarketInfo, OrderBookSnapshot } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';

interface PhoenixMarketResponse {
  symbol: string;
  baseLotsDecimals: number;
  tickSize: number;
  leverageTiers: Array<{ maxLeverage: number }>;
}

interface PhoenixMarketStats {
  symbol: string;
  mark_price: number;
  oracle_price: number;
  current_funding_rate: number;
  open_interest: number;
}

interface PhoenixOrderBookResponse {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

const MARKET_CACHE_TTL_MS = 30_000;

function toMarketInfo(m: PhoenixMarketResponse, stats?: PhoenixMarketStats): MarketInfo {
  const [baseAsset = m.symbol, quoteAsset = 'USD'] = m.symbol.split('-');
  return {
    symbol: m.symbol,
    baseAsset,
    quoteAsset,
    markPrice: stats?.mark_price ?? 0,
    indexPrice: stats?.oracle_price ?? 0,
    fundingRate: stats?.current_funding_rate ?? 0,
    openInterest: stats?.open_interest ?? 0,
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

    const [configs, statsResponse] = await Promise.all([
      this.client.get<PhoenixMarketResponse[]>(PHOENIX_ENDPOINTS.markets),
      this.client.get<{ markets: PhoenixMarketStats[] }>(PHOENIX_ENDPOINTS.marketsStats),
    ]);
    const statsBySymbol = new Map(statsResponse.markets.map((stats) => [stats.symbol, stats]));
    const markets = configs.map((market) => toMarketInfo(market, statsBySymbol.get(market.symbol)));
    this.cache = { markets, fetchedAt: now };
    return markets;
  }

  async getMarket(symbol: string): Promise<MarketInfo | null> {
    const cached = (await this.listMarkets()).find((m) => m.symbol === symbol);
    if (cached) return cached;

    try {
      const [market, stats] = await Promise.all([
        this.client.get<PhoenixMarketResponse>(PHOENIX_ENDPOINTS.market(symbol)),
        this.client.get<PhoenixMarketStats>(PHOENIX_ENDPOINTS.marketStats(symbol)),
      ]);
      return toMarketInfo(market, stats);
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
