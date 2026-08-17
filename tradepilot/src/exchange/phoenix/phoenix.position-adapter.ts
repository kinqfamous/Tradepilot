import { PositionAdapter } from '../interfaces/position-adapter.interface';
import { ExchangeCredential, ExchangePosition, PositionSide } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';

interface PhoenixTraderStateResponse {
  snapshot: {
    subaccounts: Array<{
      collateral: string;
      positions: Array<{
        positionSequenceNumber: string;
        symbol: string;
        basePositionUnits?: string;
        basePositionLots: string;
        entryPriceUsd?: string;
        accumulatedFundingQuoteLots: string;
      }>;
    }>;
  };
}

interface PhoenixMarketResponse {
  symbol: string;
  baseLotsDecimals: number;
}

interface PhoenixMarketsStatsResponse {
  markets: Array<{
    symbol: string;
    mark_price: number;
  }>;
}

type PhoenixRawPosition = PhoenixTraderStateResponse['snapshot']['subaccounts'][number]['positions'][number];
const QUOTE_LOTS_PER_USD = 1_000_000;

function basePositionSize(p: PhoenixRawPosition, baseLotsDecimals: number): number {
  // The trader-state API may omit the convenience `basePositionUnits` field.
  // `basePositionLots` is a raw integer, not a base-asset amount, so passing
  // it directly to Rise would multiply the close size by 10^baseLotsDecimals.
  if (p.basePositionUnits !== undefined && p.basePositionUnits !== null) return Number(p.basePositionUnits);
  return Number(p.basePositionLots) / 10 ** baseLotsDecimals;
}

function toExchangePosition(
  p: PhoenixRawPosition,
  collateralQuoteLots: number,
  baseLotsDecimals: number,
  markPrice: number,
): ExchangePosition {
  const size = basePositionSize(p, baseLotsDecimals);
  const entryPrice = Number(p.entryPriceUsd ?? 0);
  const margin = collateralQuoteLots / QUOTE_LOTS_PER_USD;
  const absoluteSize = Math.abs(size);
  const unrealizedPnl = markPrice > 0 && entryPrice > 0
    ? (markPrice - entryPrice) * size
    : 0;
  return {
    externalId: p.positionSequenceNumber,
    market: p.symbol,
    side: (size >= 0 ? 'LONG' : 'SHORT') as PositionSide,
    entryPrice,
    markPrice,
    size: absoluteSize,
    // Phoenix reports subaccount collateral, not the original order margin.
    // This is nevertheless the best live estimate of effective leverage.
    leverage: margin > 0 && markPrice > 0 ? (absoluteSize * markPrice) / margin : 0,
    margin,
    liquidationPrice: null,
    unrealizedPnl,
    roePercent: margin > 0 ? (unrealizedPnl / margin) * 100 : 0,
    fundingPaid: Number(p.accumulatedFundingQuoteLots) / QUOTE_LOTS_PER_USD,
  };
}

export class PhoenixPositionAdapter implements PositionAdapter {
  constructor(private readonly client: PhoenixRestClient) {}

  async getOpenPositions(credential: ExchangeCredential): Promise<ExchangePosition[]> {
    const response = await this.client.get<PhoenixTraderStateResponse>(PHOENIX_ENDPOINTS.traderState(credential.walletAddress));
    const positions = response.snapshot.subaccounts.flatMap((account) =>
      account.positions.map((position) => ({ position, collateral: Number(account.collateral) })),
    );
    const [markets, marketStats] = await Promise.all([
      this.client.get<PhoenixMarketResponse[]>(PHOENIX_ENDPOINTS.markets),
      this.client.get<PhoenixMarketsStatsResponse>(PHOENIX_ENDPOINTS.marketsStats),
    ]);
    const decimalsBySymbol = new Map(markets.map((market) => [market.symbol, market.baseLotsDecimals]));
    const marksBySymbol = new Map(marketStats.markets.map((market) => [market.symbol, Number(market.mark_price)]));

    return positions.flatMap(({ position, collateral }) => {
      const baseLotsDecimals = decimalsBySymbol.get(position.symbol);
      if (baseLotsDecimals === undefined) {
        throw new Error(`Phoenix market metadata is unavailable for ${position.symbol}.`);
      }
      const size = basePositionSize(position, baseLotsDecimals);
      return size === 0 ? [] : [toExchangePosition(position, collateral, baseLotsDecimals, marksBySymbol.get(position.symbol) ?? 0)];
    });
  }

  async getPosition(credential: ExchangeCredential, market: string): Promise<ExchangePosition | null> {
    const positions = await this.getOpenPositions(credential);
    return positions.find((p) => p.market === market) ?? null;
  }
}
