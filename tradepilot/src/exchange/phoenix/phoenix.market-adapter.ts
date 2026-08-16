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
  prev_day_mark_price: number;
  open_interest: number;
  current_funding_rate: number;
}

interface PhoenixMarketsStatsResponse {
  markets: PhoenixMarketStats[];
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
  const markPrice = stats?.mark_price ?? 0;
  const previousMarkPrice = stats?.prev_day_mark_price ?? 0;
  return {
    symbol: m.symbol,
    baseAsset,
    quoteAsset,
    markPrice,
    indexPrice: stats?.oracle_price ?? markPrice,
    priceChange24hPercent: previousMarkPrice > 0 ? ((markPrice - previousMarkPrice) / previousMarkPrice) * 100 : 0,
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

  async listMarkets(forceRefresh = false): Promise<MarketInfo[]> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.cache.fetchedAt < MARKET_CACHE_TTL_MS) {
      return this.cache.markets;
    }

    const [configs, { markets: stats }] = await Promise.all([
      this.client.get<PhoenixMarketResponse[]>(PHOENIX_ENDPOINTS.markets),
      this.client.get<PhoenixMarketsStatsResponse>(PHOENIX_ENDPOINTS.marketsStats),
    ]);
    const statsBySymbol = new Map(stats.map((market) => [market.symbol, market]));
    const markets = configs.map((market) => toMarketInfo(market, statsBySymbol.get(market.symbol)));
    this.cache = { markets, fetchedAt: now };
    return markets;
  }

  async getMarket(symbol: string): Promise<MarketInfo | null> {
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
