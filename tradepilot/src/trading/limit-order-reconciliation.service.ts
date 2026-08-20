import { Side } from '@ellipsis-labs/rise';
import { getPlainClient } from '../exchange/phoenix/flight.client';
import { builderFeeService } from '../fees/builder-fee.service';
import { log } from '../logger/logger';
import { notificationService } from '../notifications/notification.service';
import { referralService } from '../referrals/referral.service';
import { settingsService } from '../settings/settings.service';
import { formatNumber } from '../utils/format';
import { marketQueryService } from './market-query.service';
import { tradingRepository } from './trading.repository';

function relativeDistance(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / Math.max(Math.abs(right), 1e-12);
}

function timestampMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export class LimitOrderReconciliationService {
  async reconcile(): Promise<void> {
    const orders = await tradingRepository.listSubmittedLimitOrders();
    if (orders.length === 0) return;
    const client = await getPlainClient();

    for (const order of orders) {
      try {
        const history = await client.api.orders().getTraderOrderHistory(
          order.exchangeAccount.walletAddress,
          { marketSymbol: order.market, orderStatus: 'filled', limit: 100 },
        );
        const expectedSide = order.side === 'BUY' ? Side.Bid : Side.Ask;
        const expectedPrice = Number(order.price);
        const expectedSize = Number(order.size);
        const candidates = history.data.filter((candidate) => {
          const completedAt = timestampMs(candidate.completedAt);
          return candidate.status === 'filled' &&
            candidate.side === expectedSide &&
            // Phoenix snaps submitted USD prices to market ticks. The DB has
            // the user's pre-snap value, so exact decimal equality can miss a
            // real fill. Keep the candidate window narrow, then rank it below.
            relativeDistance(Number(candidate.price), expectedPrice) <= 0.001 &&
            Number(candidate.filledBaseQty) > 0 &&
            Number(candidate.remainingBaseQty) === 0 &&
            (completedAt === null || completedAt >= order.createdAt.getTime() - 60_000);
        }).sort((left, right) => {
          const priceDifference = relativeDistance(Number(left.price), expectedPrice) - relativeDistance(Number(right.price), expectedPrice);
          return priceDifference !== 0
            ? priceDifference
            : relativeDistance(Number(left.baseQty), expectedSize) - relativeDistance(Number(right.baseQty), expectedSize);
        });
        let filled: (typeof history.data)[number] | undefined;
        for (const candidate of candidates) {
          if (!(await tradingRepository.isPhoenixOrderClaimed(candidate.orderSequenceNumber))) {
            filled = candidate;
            break;
          }
        }
        const trades = await client.api.trades().getTraderTradesHistory(
          order.exchangeAccount.walletAddress,
          { marketSymbol: order.market, limit: 100 },
        );
        // Isolated-market fills are currently absent from Phoenix's legacy
        // order-history endpoint. An immediately marketable limit still has
        // an authoritative fill record whose signature is the placement
        // transaction, so use that exact identity as the fallback.
        const placementFill = !filled && order.txSignature
          ? trades.data.find((trade) =>
              trade.signature === order.txSignature &&
              trade.tradeType === 'limit' &&
              trade.marketSymbol === order.market &&
              (order.side === 'BUY' ? Number(trade.baseLotsDelta) > 0 : Number(trade.baseLotsDelta) < 0),
            )
          : undefined;
        if (!filled && !placementFill) continue;

        const matchingFills = filled
          ? trades.data.filter((trade) => trade.orderSequenceNumber === Number(filled!.orderSequenceNumber))
          : trades.data.filter((trade) => trade.signature === placementFill!.signature && trade.tradeType === 'limit');
        const fillPrice = matchingFills.length > 0
          ? matchingFills.reduce((sum, trade) => sum + Number(trade.price) * Math.abs(Number(trade.baseLotsDelta)), 0) /
            matchingFills.reduce((sum, trade) => sum + Math.abs(Number(trade.baseLotsDelta)), 0)
          : Number(filled!.price);
        const fillSignature = matchingFills.find((trade) => trade.signature)?.signature ?? placementFill?.signature ?? null;
        const phoenixOrderId = filled?.orderSequenceNumber ?? `fill:${placementFill!.fillId ?? placementFill!.signature}`;
        if (!Number.isFinite(fillPrice) || fillPrice <= 0) continue;
        if (!(await tradingRepository.claimFilledLimitOrder(
          order.id,
          phoenixOrderId,
          fillPrice,
          fillSignature,
        ))) continue;

        const side = order.side === 'BUY' ? 'LONG' as const : 'SHORT' as const;
        const size = Number(order.size);
        const leverage = Number(order.leverage);
        const margin = (size * fillPrice) / leverage;
        const market = await marketQueryService.getMarket(order.exchange, order.market);
        const marketPrice = market?.markPrice && market.markPrice > 0 ? market.markPrice : fillPrice;
        let marginMode: 'CROSS' | 'ISOLATED' = 'CROSS';
        try {
          marginMode = (await settingsService.get(order.userId)).defaultMarginMode;
        } catch (error) {
          await log.warn('TRADE', 'Could not load margin mode for limit fill card; using cross', {
            orderId: order.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Queue the user-facing fill confirmation immediately after the
        // atomic claim. If the outbox write fails, release the claim so the
        // next reconciliation pass retries instead of losing the card.
        try {
          await notificationService.notify(
            order.userId,
            'TRADE_FILLED',
            `✅ *${side} ${order.market} limit order filled*\nEntry: *$${formatNumber(fillPrice)}*\nMarket: *$${formatNumber(marketPrice)}*`,
            { orderId: order.id, fillPrice, marketPrice },
            { market: order.market, side, leverage, marginMode, entryPrice: fillPrice, marketPrice },
          );
        } catch (error) {
          await tradingRepository.releaseFilledLimitOrderClaim(order.id, order.txSignature);
          throw error;
        }
        const position = await tradingRepository.createPosition({
          userId: order.userId,
          exchangeAccountId: order.exchangeAccountId,
          exchange: order.exchange,
          market: order.market,
          side,
          entryPrice: fillPrice,
          size,
          leverage,
          margin,
        });
        await tradingRepository.updateOrder(order.id, { positionId: position.id });
        await tradingRepository.createTrade({
          userId: order.userId,
          exchangeAccountId: order.exchangeAccountId,
          orderId: order.id,
          positionId: position.id,
          exchange: order.exchange,
          market: order.market,
          side: order.side,
          price: fillPrice,
          size,
          txSignature: fillSignature,
        });
        await builderFeeService.confirmFeeForOrder(order.id, fillSignature ?? order.txSignature ?? 'phoenix-limit-fill');
        await referralService.recordTradeVolume(order.userId, size * fillPrice);

        await log.info('TRADE', 'Limit order fill reconciled', { orderId: order.id, fillPrice, marketPrice });
      } catch (error) {
        await log.error('TRADE', 'Limit order reconciliation failed', {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const limitOrderReconciliationService = new LimitOrderReconciliationService();
