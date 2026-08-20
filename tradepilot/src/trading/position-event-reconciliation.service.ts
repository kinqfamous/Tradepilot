import { prisma } from '../database/prisma';
import { getPlainClient } from '../exchange/phoenix/flight.client';
import { log } from '../logger/logger';
import { notificationService } from '../notifications/notification.service';
import { settingsService } from '../settings/settings.service';
import { formatNumber, formatSignedPnlPercent } from '../utils/format';
import { marketQueryService } from './market-query.service';
import { tradingRepository } from './trading.repository';

type ExitType = 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION';

function eventTimeMs(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

export class PositionEventReconciliationService {
  async reconcile(): Promise<void> {
    const positions = await tradingRepository.listAllOpenPositionsWithAccount();
    if (positions.length === 0) return;
    const client = await getPlainClient();

    for (const position of positions) {
      try {
        const history = await client.api.trades().getTraderTradesHistory(
          position.exchangeAccount.walletAddress,
          { marketSymbol: position.market, limit: 100 },
        );
        const fills = history.data
          .filter((fill) => {
            const closesPosition = position.side === 'LONG'
              ? Number(fill.baseLotsDelta) < 0
              : Number(fill.baseLotsDelta) > 0;
            return closesPosition && eventTimeMs(fill.timestamp) >= position.openedAt.getTime() - 60_000;
          })
          .sort((a, b) => b.timestamp - a.timestamp);
        let matched = fills.find((fill) => fill.tradeType === 'liquidation');
        let type: ExitType | undefined = matched ? 'LIQUIDATION' : undefined;

        if (!matched) {
          for (const protection of position.orders) {
            const trigger = Number(protection.triggerPrice);
            const candidate = fills.find((fill) => {
              if (eventTimeMs(fill.timestamp) < protection.createdAt.getTime() - 60_000) return false;
              const price = Number(fill.price);
              const tolerance = trigger * 0.02;
              return Number.isFinite(price) && Math.abs(price - trigger) <= tolerance;
            });
            if (candidate) {
              matched = candidate;
              type = protection.type as ExitType;
              break;
            }
          }
        }
        if (!matched || !type) continue;

        // Notify only after Phoenix reports the position fully gone. A trigger
        // can receive several partial fills before its requested 100% closes.
        const stillOpen = (await marketQueryService.getOpenPositions(position.userId, position.exchange))
          .some((candidate) => candidate.market === position.market && candidate.size > Number(position.size) * 0.001);
        if (stillOpen) continue;

        const eventKey = matched.fillId ?? `${matched.signature}:${matched.slot}:${matched.eventIndex}`;
        const alreadyHandled = await prisma.notification.findFirst({ where: { metadata: { contains: eventKey } } });
        if (alreadyHandled) continue;

        const exitPrice = Number(matched.price);
        const entryPrice = Number(position.entryPrice);
        const size = Number(position.size);
        const sideMultiplier = position.side === 'LONG' ? 1 : -1;
        const realizedPnl = (exitPrice - entryPrice) * size * sideMultiplier;
        const pnlPercent = Number(position.margin) > 0 ? (realizedPnl / Number(position.margin)) * 100 : 0;
        await tradingRepository.closePosition(position.id, realizedPnl);
        if (type === 'LIQUIDATION') {
          await prisma.order.updateMany({
            where: { positionId: position.id, type: { in: ['STOP_LOSS', 'TAKE_PROFIT'] }, status: 'SUBMITTED' },
            data: { status: 'CANCELLED' },
          });
        } else {
          await Promise.all([
            prisma.order.updateMany({
              where: { positionId: position.id, type, status: 'SUBMITTED' },
              data: { status: 'FILLED', filledAt: new Date() },
            }),
            prisma.order.updateMany({
              where: {
                positionId: position.id,
                type: type === 'STOP_LOSS' ? 'TAKE_PROFIT' : 'STOP_LOSS',
                status: 'SUBMITTED',
              },
              data: { status: 'CANCELLED' },
            }),
          ]);
        }
        await tradingRepository.createTrade({
          userId: position.userId,
          exchangeAccountId: position.exchangeAccountId,
          positionId: position.id,
          exchange: position.exchange,
          market: position.market,
          side: position.side === 'LONG' ? 'SELL' : 'BUY',
          price: exitPrice,
          size,
          realizedPnl,
          txSignature: matched.signature,
        });

        const [market, settings] = await Promise.all([
          marketQueryService.getMarket(position.exchange, position.market),
          settingsService.get(position.userId),
        ]);
        const marketPrice = market?.markPrice && market.markPrice > 0 ? market.markPrice : exitPrice;
        const label = type === 'STOP_LOSS' ? 'Stop loss' : type === 'TAKE_PROFIT' ? 'Take profit' : 'Liquidation';
        await notificationService.notify(
          position.userId,
          type === 'STOP_LOSS' ? 'STOP_LOSS' : type === 'TAKE_PROFIT' ? 'TAKE_PROFIT' : 'TRADE_FILLED',
          `${type === 'LIQUIDATION' ? '⚠️' : '✅'} *${label} filled for ${position.market}*\n` +
            `Entry: *$${formatNumber(entryPrice)}*\nFill: *$${formatNumber(exitPrice)}*\n` +
            `Market: *$${formatNumber(marketPrice)}*\nPnL: ${formatSignedPnlPercent(pnlPercent)}`,
          { eventKey, type, fillPrice: exitPrice, marketPrice },
          {
            market: position.market,
            side: position.side,
            leverage: Number(position.leverage),
            marginMode: settings.defaultMarginMode,
            entryPrice,
            marketPrice,
            exitPrice,
            pnlPercent,
            eventType: type,
          },
        );
        await log.info('TRADE', 'Phoenix position exit reconciled', { positionId: position.id, type, eventKey });
      } catch (error) {
        await log.error('TRADE', 'Position event reconciliation failed', {
          positionId: position.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const positionEventReconciliationService = new PositionEventReconciliationService();
