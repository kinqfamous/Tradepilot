import { PositionAdapter } from '../interfaces/position-adapter.interface';
import { ExchangeCredential, ExchangePosition, MarginMode, PositionSide } from '../../types/exchange.types';
import { PhoenixRestClient, PHOENIX_ENDPOINTS } from './phoenix.rest-client';
import { getPlainClient } from './flight.client';
import { ticksToUsdWithMarketParams } from '@ellipsis-labs/rise';

interface PhoenixTraderStateResponse {
  snapshot: {
    subaccounts: Array<{
      collateral: string;
      // Phoenix omits `positions` entirely for empty child/isolated
      // subaccounts instead of returning an empty array.
      positions?: Array<{
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

type PhoenixRawPosition = NonNullable<PhoenixTraderStateResponse['snapshot']['subaccounts'][number]['positions']>[number];
const QUOTE_LOTS_PER_USD = 1_000_000;
const LIQUIDATION_LOOKUP_TIMEOUT_MS = 2_500;

/** Reads Phoenix's protocol-calculated liquidation threshold through Hawkeye. */
export interface PhoenixLiquidationReader {
  getLiquidationPrice(walletAddress: string, subaccountIndex: number, symbol: string): Promise<number | null>;
}

export class PhoenixHawkeyeLiquidationReader implements PhoenixLiquidationReader {
  async getLiquidationPrice(walletAddress: string, subaccountIndex: number, symbol: string): Promise<number | null> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.readPrice(walletAddress, subaccountIndex, symbol),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), LIQUIDATION_LOOKUP_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // A display query must not make position retrieval fail. It is safer to
      // show `Unavailable` than to fall back to a non-Phoenix estimate.
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async readPrice(walletAddress: string, subaccountIndex: number, symbol: string): Promise<number | null> {
    const client = await getPlainClient();
    const result = await client.rpc.hawkeye.viewLiquidationPrice({
      authority: walletAddress as never,
      traderPdaIndex: 0,
      traderSubaccountIndex: subaccountIndex,
      symbol: symbol as never,
    });
    const market = client.exchange.market(symbol);
    const liquidation = result.returnData?.decoded;

    // Only `found` is a price Phoenix says is a future liquidation threshold.
    // The other statuses mean no threshold is available (or the account is
    // already liquidatable), so never substitute a locally calculated value.
    if (result.err || !market || !liquidation || liquidation.status.label !== 'found') return null;

    const price = ticksToUsdWithMarketParams(liquidation.liquidationPriceTicks, {
      tickSize: market.tickSize,
      baseLotsDecimals: market.baseLotsDecimals,
    });
    return Number.isFinite(price) && price > 0 ? price : null;
  }
}

const phoenixHawkeyeLiquidationReader = new PhoenixHawkeyeLiquidationReader();

function basePositionSize(p: PhoenixRawPosition, baseLotsDecimals: number): number {
  // The trader-state API may omit the convenience `basePositionUnits` field.
  // `basePositionLots` is a raw integer, not a base-asset amount, so passing
  // it directly to Rise would multiply the close size by 10^baseLotsDecimals.
  if (p.basePositionUnits !== undefined && p.basePositionUnits !== null) return Number(p.basePositionUnits);
  return Number(p.basePositionLots) / 10 ** baseLotsDecimals;
}

function toExchangePosition(
  p: PhoenixRawPosition,
  margin: number,
  baseLotsDecimals: number,
  markPrice: number,
  liquidationPrice: number | null,
  marginMode: MarginMode,
): ExchangePosition {
  const size = basePositionSize(p, baseLotsDecimals);
  const entryPrice = Number(p.entryPriceUsd ?? 0);
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
    // Phoenix reports collateral at subaccount level. It is allocated by
    // notional when more than one position shares a subaccount.
    leverage: margin > 0 && markPrice > 0 ? (absoluteSize * markPrice) / margin : 0,
    margin,
    liquidationPrice,
    unrealizedPnl,
    roePercent: margin > 0 ? (unrealizedPnl / margin) * 100 : 0,
    fundingPaid: Number(p.accumulatedFundingQuoteLots) / QUOTE_LOTS_PER_USD,
    marginMode,
  };
}

export class PhoenixPositionAdapter implements PositionAdapter {
  constructor(
    private readonly client: PhoenixRestClient,
    private readonly liquidationReader: PhoenixLiquidationReader = phoenixHawkeyeLiquidationReader,
  ) {}

  async getOpenPositions(credential: ExchangeCredential): Promise<ExchangePosition[]> {
    const response = await this.client.get<PhoenixTraderStateResponse>(PHOENIX_ENDPOINTS.traderState(credential.walletAddress));
    const [markets, marketStats] = await Promise.all([
      this.client.get<PhoenixMarketResponse[]>(PHOENIX_ENDPOINTS.markets),
      this.client.get<PhoenixMarketsStatsResponse>(PHOENIX_ENDPOINTS.marketsStats),
    ]);
    const decimalsBySymbol = new Map(markets.map((market) => [market.symbol, market.baseLotsDecimals]));
    const marksBySymbol = new Map(marketStats.markets.map((market) => [market.symbol, Number(market.mark_price)]));

    const positionsBySubaccount = response.snapshot.subaccounts.map((account, subaccountIndex) => {
      const activePositions = (account.positions ?? []).flatMap((position) => {
        const baseLotsDecimals = decimalsBySymbol.get(position.symbol);
        if (baseLotsDecimals === undefined) {
          throw new Error(`Phoenix market metadata is unavailable for ${position.symbol}.`);
        }
        const size = basePositionSize(position, baseLotsDecimals);
        if (size === 0) return [];
        const markPrice = marksBySymbol.get(position.symbol) ?? 0;
        return [{ position, baseLotsDecimals, size, markPrice, notional: Math.abs(size) * markPrice }];
      });
      const totalNotional = activePositions.reduce((total, position) => total + position.notional, 0);
      const collateralUsd = Number(account.collateral) / QUOTE_LOTS_PER_USD;

      return activePositions.map(({ position, baseLotsDecimals, markPrice, notional }) => {
        const margin = totalNotional > 0 ? collateralUsd * (notional / totalNotional) : 0;
        return { position, margin, baseLotsDecimals, markPrice, subaccountIndex };
      });
    });

    const rawPositions = positionsBySubaccount.flat();
    return Promise.all(rawPositions.map(async ({ position, margin, baseLotsDecimals, markPrice, subaccountIndex }) => {
      const liquidationPrice = await this.liquidationReader.getLiquidationPrice(
        credential.walletAddress,
        subaccountIndex,
        position.symbol,
      );
      return toExchangePosition(
        position,
        margin,
        baseLotsDecimals,
        markPrice,
        liquidationPrice,
        subaccountIndex === 0 ? 'CROSS' : 'ISOLATED',
      );
    }));
  }

  async getPosition(credential: ExchangeCredential, market: string): Promise<ExchangePosition | null> {
    const positions = await this.getOpenPositions(credential);
    return positions.find((p) => p.market === market) ?? null;
  }
}
