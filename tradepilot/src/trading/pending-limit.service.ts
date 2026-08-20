import crypto from 'crypto';
import { priceUsdToTicksWithMarketParams } from '@ellipsis-labs/rise';
import { assembleAndSubmit, getPlainClient } from '../exchange/phoenix/flight.client';
import { createPhoenixConnection } from '../exchange/phoenix/phoenix.order-adapter';
import { walletKeyService } from '../exchange/wallet-key.service';
import { calculateProtectionPrice } from './position-protection.service';
import { tradingRepository } from './trading.repository';
import { tradingService } from './trading.service';

type EditKind = 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT';

export class PendingLimitService {
  private async resolve(userId: number, exchange: string, orderId: number) {
    const order = await tradingRepository.findUserPendingLimitOrder(orderId, userId, exchange);
    if (!order) throw new Error('This pending limit order no longer exists. Refresh Positions.');
    const client = await getPlainClient();
    const snapshot = await client.api.traders().getTraderStateSnapshot(order.exchangeAccount.walletAddress, { traderPdaIndex: 0 });
    const expectedSide = order.side === 'BUY' ? 'bid' : 'ask';
    const expectedPrice = Number(order.price);
    const marketMetadata = client.exchange.market(order.market);
    if (!marketMetadata) throw new Error(`Phoenix market metadata is unavailable for ${order.market}.`);
    const expectedPriceTicks = String(priceUsdToTicksWithMarketParams(expectedPrice, {
      tickSize: marketMetadata.tickSize,
      baseLotsDecimals: marketMetadata.baseLotsDecimals,
    }));
    const normalizedMarket = (value: string) => value.replace(/-PERP$/i, '').toUpperCase();
    const candidates = snapshot.snapshot.subaccounts.flatMap((subaccount) =>
      subaccount.orders.flatMap((market) => normalizedMarket(market.symbol) === normalizedMarket(order.market)
        ? market.orders.map((resting) => ({ subaccount, resting }))
        : []),
    ).filter(({ resting }) =>
      resting.side === expectedSide &&
      resting.priceTicks === expectedPriceTicks &&
      resting.status !== 'closed' &&
      Number(resting.sizeRemainingLots) > 0,
    ).sort((left, right) => {
      const leftSize = Number(left.resting.sizeRemainingUnits ?? left.resting.sizeRemainingLots);
      const rightSize = Number(right.resting.sizeRemainingUnits ?? right.resting.sizeRemainingLots);
      return Math.abs(leftSize - Number(order.size)) - Math.abs(rightSize - Number(order.size));
    });
    if (candidates.length !== 1) {
      throw new Error(candidates.length === 0
        ? 'The resting Phoenix order was not found. It may already be filled or cancelled.'
        : 'Multiple identical Phoenix orders were found; cancel the intended order directly on Phoenix to avoid ambiguity.');
    }
    return { order, client, ...candidates[0] };
  }

  async cancel(userId: number, exchange: string, orderId: number): Promise<string> {
    const { order, client, subaccount, resting } = await this.resolve(userId, exchange, orderId);
    const keypair = await walletKeyService.getKeypair(order.exchangeAccountId);
    const signature = await assembleAndSubmit({
      connection: createPhoenixConnection(),
      traderKeypair: keypair,
      instructions: [await client.ixs.buildCancelOrdersById({
        authority: order.exchangeAccount.walletAddress as never,
        symbol: order.market as never,
        traderPdaIndex: 0,
        traderSubaccountIndex: subaccount.subaccountIndex,
        orders: [{ priceInTicks: resting.priceTicks, orderSequenceNumber: resting.orderSequenceNumber }],
      })],
    });
    await tradingRepository.cancelPendingLimitFamily(order);
    return signature;
  }

  async edit(params: { userId: number; exchange: string; orderId: number; kind: EditKind; price?: number; percentage?: number }) {
    const found = await tradingRepository.findUserPendingLimitOrder(params.orderId, params.userId, params.exchange);
    if (!found) throw new Error('This pending limit order no longer exists. Refresh Positions.');
    const entry = Number(found.price);
    const side = found.side === 'BUY' ? 'LONG' : 'SHORT';
    const protections = await tradingRepository.listPendingLimitProtections(found);
    let stopLossPrice = Number(protections.find((p) => p.type === 'STOP_LOSS')?.triggerPrice) || undefined;
    let takeProfitPrice = Number(protections.find((p) => p.type === 'TAKE_PROFIT')?.triggerPrice) || undefined;
    let newEntry = entry;
    const selectedPrice = params.percentage === undefined ? params.price : calculateProtectionPrice({
      entryPrice: entry,
      leverage: Number(found.leverage),
      percentage: params.percentage,
      side,
      type: params.kind as 'STOP_LOSS' | 'TAKE_PROFIT',
    });
    if (!Number.isFinite(selectedPrice) || !selectedPrice || selectedPrice <= 0) throw new Error('Enter a positive price or percentage.');
    if (params.kind === 'ENTRY') newEntry = selectedPrice;
    if (params.kind === 'STOP_LOSS') stopLossPrice = selectedPrice;
    if (params.kind === 'TAKE_PROFIT') takeProfitPrice = selectedPrice;
    const invalidStop = stopLossPrice !== undefined && (side === 'LONG' ? stopLossPrice >= newEntry : stopLossPrice <= newEntry);
    const invalidTake = takeProfitPrice !== undefined && (side === 'LONG' ? takeProfitPrice <= newEntry : takeProfitPrice >= newEntry);
    if (invalidStop || invalidTake) {
      throw new Error(side === 'LONG'
        ? 'For a long limit order, stop loss must be below and take profit above the entry price.'
        : 'For a short limit order, stop loss must be above and take profit below the entry price.');
    }
    await this.cancel(params.userId, params.exchange, params.orderId);
    const notional = Number(found.size) * newEntry;
    const result = await tradingService.open({
      userId: params.userId,
      exchange: params.exchange,
      market: found.market,
      side,
      collateralUsd: notional / Number(found.leverage),
      leverage: Number(found.leverage),
      slippageBpsOverride: found.slippageBps,
      orderType: 'LIMIT',
      limitPrice: newEntry,
      stopLossPrice,
      takeProfitPrice,
      idempotencyKey: `edit-limit-${found.id}-${crypto.randomUUID()}`,
    });
    if (result.status === 'REJECTED') throw new Error(result.errorMessage ?? 'Phoenix rejected the replacement limit order.');
    return { result, entryPrice: newEntry, protectionPrice: params.kind === 'ENTRY' ? undefined : selectedPrice };
  }
}

export const pendingLimitService = new PendingLimitService();
