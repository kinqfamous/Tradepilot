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

function toExchangePosition(p: PhoenixTraderStateResponse['snapshot']['subaccounts'][number]['positions'][number], collateral: number): ExchangePosition {
  const size = Number(p.basePositionUnits ?? p.basePositionLots);
  return {
    externalId: p.positionSequenceNumber,
    market: p.symbol,
    side: (size >= 0 ? 'LONG' : 'SHORT') as PositionSide,
    entryPrice: Number(p.entryPriceUsd ?? 0),
    markPrice: 0,
    size: Math.abs(size),
    leverage: 0,
    margin: collateral,
    liquidationPrice: null,
    unrealizedPnl: 0,
    roePercent: 0,
    fundingPaid: Number(p.accumulatedFundingQuoteLots),
  };
}

export class PhoenixPositionAdapter implements PositionAdapter {
  constructor(private readonly client: PhoenixRestClient) {}

  async getOpenPositions(credential: ExchangeCredential): Promise<ExchangePosition[]> {
    const response = await this.client.get<PhoenixTraderStateResponse>(PHOENIX_ENDPOINTS.traderState(credential.walletAddress));
    return response.snapshot.subaccounts.flatMap((account) =>
      account.positions
        .filter((position) => Number(position.basePositionUnits ?? position.basePositionLots) !== 0)
        .map((position) => toExchangePosition(position, Number(account.collateral))),
    );
  }

  async getPosition(credential: ExchangeCredential, market: string): Promise<ExchangePosition | null> {
    const positions = await this.getOpenPositions(credential);
    return positions.find((p) => p.market === market) ?? null;
  }
}
