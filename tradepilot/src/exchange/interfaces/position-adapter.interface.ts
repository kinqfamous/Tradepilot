import { ExchangeCredential, ExchangePosition } from '../../types/exchange.types';

export interface PositionAdapter {
  getOpenPositions(credential: ExchangeCredential): Promise<ExchangePosition[]>;
  getPosition(credential: ExchangeCredential, market: string): Promise<ExchangePosition | null>;
}
