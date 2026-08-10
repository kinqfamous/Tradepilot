import { PositionAdapter } from '../interfaces/position-adapter.interface';
import { ExchangeCredential, ExchangePosition, PositionSide } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';

interface PhoenixPositionResponse {
  positionId: string;
  market: string;
  side: 'long' | 'short';
  entryPrice: string;
  markPrice: string;
  size: string;
  leverage: string;
  margin: string;
  liquidationPrice: string | null;
  unrealizedPnl: string;
  roe: string;
  fundingPaid: string;
}

interface PhoenixPositionsResponse {
  positions: PhoenixPositionResponse[];
}

function toExchangePosition(p: PhoenixPositionResponse): ExchangePosition {
  return {
    externalId: p.positionId,
    market: p.market,
    side: (p.side === 'long' ? 'LONG' : 'SHORT') as PositionSide,
    entryPrice: Number(p.entryPrice),
    markPrice: Number(p.markPrice),
    size: Number(p.size),
    leverage: Number(p.leverage),
    margin: Number(p.margin),
    liquidationPrice: p.liquidationPrice ? Number(p.liquidationPrice) : null,
    unrealizedPnl: Number(p.unrealizedPnl),
    roePercent: Number(p.roe),
    fundingPaid: Number(p.fundingPaid),
  };
}

export class PhoenixPositionAdapter implements PositionAdapter {
  constructor(private readonly client: PhoenixRestClient) {}

  async getOpenPositions(credential: ExchangeCredential): Promise<ExchangePosition[]> {
    const response = await this.client.get<PhoenixPositionsResponse>(
      PHOENIX_ENDPOINTS.traderPositions(credential.walletAddress),
      credential.sessionSecret,
    );
    return response.positions.map(toExchangePosition);
  }

  async getPosition(credential: ExchangeCredential, market: string): Promise<ExchangePosition | null> {
    const positions = await this.getOpenPositions(credential);
    return positions.find((p) => p.market === market) ?? null;
  }
}
