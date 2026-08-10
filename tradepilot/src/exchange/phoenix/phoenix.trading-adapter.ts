import { TradingAdapter, OpenPositionParams } from '../interfaces/trading-adapter.interface';
import { ClosePositionParams, ExchangeCredential, PlaceOrderResult } from '../../types/exchange.types';
import { PhoenixOrderAdapter } from './phoenix.order-adapter';
import { PhoenixPositionAdapter } from './phoenix.position-adapter';
import { PhoenixMarketAdapter } from './phoenix.market-adapter';

export class PhoenixTradingAdapter implements TradingAdapter {
  constructor(
    private readonly orderAdapter: PhoenixOrderAdapter,
    private readonly positionAdapter: PhoenixPositionAdapter,
    private readonly marketAdapter: PhoenixMarketAdapter,
  ) {}

  async openPosition(params: OpenPositionParams): Promise<PlaceOrderResult> {
    const market = await this.marketAdapter.getMarket(params.market);
    if (!market) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: `Unknown market: ${params.market}` };
    }
    if (params.leverage > market.maxLeverage) {
      return {
        externalOrderId: '',
        status: 'REJECTED',
        errorMessage: `Leverage ${params.leverage}x exceeds ${params.market}'s max of ${market.maxLeverage}x.`,
      };
    }

    // Position size in base asset units = (collateral * leverage) / entry price estimate.
    const referencePrice = params.orderType === 'LIMIT' && params.limitPrice ? params.limitPrice : market.markPrice;
    const size = (params.collateralUsd * params.leverage) / referencePrice;

    if (size < market.minOrderSize) {
      return {
        externalOrderId: '',
        status: 'REJECTED',
        errorMessage: `Order size ${size.toFixed(6)} is below ${params.market}'s minimum of ${market.minOrderSize}.`,
      };
    }

    const side = params.side === 'LONG' ? 'BUY' : 'SELL';

    const result = await this.orderAdapter.placeOrder({
      credential: params.credential,
      market: params.market,
      side,
      type: params.orderType,
      size,
      leverage: params.leverage,
      slippageBps: params.slippageBps,
      price: params.limitPrice,
      idempotencyKey: params.idempotencyKey,
    });

    if (result.status === 'REJECTED') return result;

    // Attach SL/TP as separate reduce-only trigger orders once the entry is live.
    if (params.stopLossPrice) {
      await this.orderAdapter.placeOrder({
        credential: params.credential,
        market: params.market,
        side: side === 'BUY' ? 'SELL' : 'BUY',
        type: 'STOP_LOSS',
        size,
        leverage: params.leverage,
        slippageBps: params.slippageBps,
        triggerPrice: params.stopLossPrice,
        reduceOnly: true,
        idempotencyKey: `${params.idempotencyKey}-sl`,
      });
    }

    if (params.takeProfitPrice) {
      await this.orderAdapter.placeOrder({
        credential: params.credential,
        market: params.market,
        side: side === 'BUY' ? 'SELL' : 'BUY',
        type: 'TAKE_PROFIT',
        size,
        leverage: params.leverage,
        slippageBps: params.slippageBps,
        triggerPrice: params.takeProfitPrice,
        reduceOnly: true,
        idempotencyKey: `${params.idempotencyKey}-tp`,
      });
    }

    return result;
  }

  async closePosition(params: ClosePositionParams): Promise<PlaceOrderResult> {
    const position = await this.positionAdapter.getPosition(params.credential, params.market);
    if (!position) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: 'No open position on this market.' };
    }

    const sizeToClose = (position.size * params.percent) / 100;
    const closingSide = position.side === 'LONG' ? 'SELL' : 'BUY';

    return this.orderAdapter.placeOrder({
      credential: params.credential,
      market: params.market,
      side: closingSide,
      type: 'MARKET',
      size: sizeToClose,
      leverage: position.leverage,
      slippageBps: params.slippageBps,
      reduceOnly: true,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async closeAllPositions(credential: ExchangeCredential): Promise<PlaceOrderResult[]> {
    const positions = await this.positionAdapter.getOpenPositions(credential);

    const results: PlaceOrderResult[] = [];
    for (const position of positions) {
      const result = await this.closePosition({
        credential,
        market: position.market,
        percent: 100,
        slippageBps: 100,
        idempotencyKey: `close-all-${position.externalId}-${Date.now()}`,
      });
      results.push(result);
    }
    return results;
  }
}
