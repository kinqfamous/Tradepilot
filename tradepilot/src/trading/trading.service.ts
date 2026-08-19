import crypto from 'crypto';
import { exchangeAccountService } from '../users/exchange-account.service';
import { tradingRepository } from './trading.repository';
import { settingsService } from '../settings/settings.service';
import { referralService } from '../referrals/referral.service';
import { notificationService } from '../notifications/notification.service';
import { systemStateService } from '../admin/system-state.service';
import { marketQueryService } from './market-query.service';
import { log } from '../logger/logger';
import { PlaceOrderResult } from '../types/exchange.types';
import { walletKeyService } from '../exchange/wallet-key.service';
import { createPhoenixConnection } from '../exchange/phoenix/phoenix.order-adapter';
import { phoenixFlightExecutionService } from '../exchange/phoenix/phoenix-flight-execution.service';
import { formatSignedPnlPercent } from '../utils/format';

export interface OpenPositionRequest {
  userId: number;
  exchange: string;
  market: string;
  side: 'LONG' | 'SHORT';
  collateralUsd: number;
  leverage: number;
  slippageBpsOverride?: number;
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  idempotencyKey?: string;
}

export interface ClosePositionRequest {
  userId: number;
  exchange: string;
  market: string;
  percent: number;
  idempotencyKey?: string;
}

export class TradingService {
  async open(request: OpenPositionRequest): Promise<PlaceOrderResult> {
    // Platform-wide trading mode (Normal/Read-Only/Maintenance/Emergency
    // Stop) - separate from, and checked in addition to, the builder-fee
    // consistency gate inside phoenixFlightExecutionService.
    const { allowed, reason } = await systemStateService.canTrade();
    if (!allowed) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: reason };
    }
    const account = await exchangeAccountService.requireVerifiedAccount(request.userId, request.exchange);
    const settings = await settingsService.get(request.userId);

    const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();

    const existing = await tradingRepository.findOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { externalOrderId: existing.exchangeOrderId ?? '', status: existing.status as any };
    }

    const leverage = request.leverage;
    const slippageBps = request.slippageBpsOverride ?? settings.defaultSlippageBps;
    const notionalUsd = request.collateralUsd * leverage;

    if (request.orderType === 'LIMIT' && request.limitPrice === undefined) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: 'A limit price is required for limit orders.' };
    }

    // Reference price for sizing: the limit price if given, otherwise the
    // current mark price. This does NOT go through Flight/Rise - it's a
    // read-only market data lookup, which is fine to keep on the existing
    // adapter (no funds move on a read). See phoenix.market-adapter.ts.
    const market = await marketQueryService.getMarket(request.exchange, request.market);
    const referencePrice = request.limitPrice ?? market?.markPrice;
    if (!Number.isFinite(referencePrice) || !referencePrice || referencePrice <= 0) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: `Could not determine a price for ${request.market}.` };
    }
    if (request.stopLossPrice !== undefined || request.takeProfitPrice !== undefined) {
      const stopLoss = request.stopLossPrice;
      const takeProfit = request.takeProfitPrice;
      const isLong = request.side === 'LONG';
      if (
        (stopLoss !== undefined && (!Number.isFinite(stopLoss) || stopLoss <= 0 || (isLong ? stopLoss >= referencePrice : stopLoss <= referencePrice))) ||
        (takeProfit !== undefined && (!Number.isFinite(takeProfit) || takeProfit <= 0 || (isLong ? takeProfit <= referencePrice : takeProfit >= referencePrice)))
      ) {
        return {
          externalOrderId: '',
          status: 'REJECTED',
          errorMessage: isLong
            ? 'For a long position, stop loss must be below and take profit above the entry price.'
            : 'For a short position, stop loss must be above and take profit below the entry price.',
        };
      }
    }
    const baseUnits = notionalUsd / referencePrice;

    const dbOrder = await tradingRepository.createOrder({
      userId: request.userId,
      exchangeAccountId: account.id,
      exchange: request.exchange,
      market: request.market,
      type: request.orderType ?? 'MARKET',
      side: request.side === 'LONG' ? 'BUY' : 'SELL',
      size: baseUnits,
      price: request.orderType === 'LIMIT' ? referencePrice : undefined,
      leverage,
      slippageBps,
      idempotencyKey,
      status: 'PENDING',
    });

    try {
      const traderKeypair = await walletKeyService.getKeypair(account.id);
      const connection = createPhoenixConnection();

      const execResult = await phoenixFlightExecutionService.executeOrder({
        connection,
        traderKeypair,
        userId: request.userId,
        orderId: dbOrder.id,
        symbol: request.market,
        side: request.side === 'LONG' ? 'buy' : 'sell',
        baseUnits: String(baseUnits),
        notionalUsd,
        collateralUsd: request.collateralUsd,
        marginMode: (settings as any).defaultMarginMode ?? 'CROSS',
        idempotencyKey,
        type: request.orderType === 'LIMIT' ? 'limit' : 'market',
        priceUsd: request.orderType === 'LIMIT' ? String(referencePrice) : undefined,
        stopLossPrice: request.stopLossPrice ? String(request.stopLossPrice) : undefined,
        takeProfitPrice: request.takeProfitPrice ? String(request.takeProfitPrice) : undefined,
        slippageBps,
      });

      if (!execResult.success) {
        await tradingRepository.updateOrder(dbOrder.id, { status: 'REJECTED', errorMessage: execResult.errorMessage });
        await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Trade failed: ${execResult.errorMessage}`);
        return { externalOrderId: '', status: 'REJECTED', errorMessage: execResult.errorMessage };
      }

      // A confirmed limit-order transaction means the order is resting on
      // Phoenix, not that it has filled. Do not create a position/trade or
      // recognise the builder fee until an order/fill synchroniser observes
      // the actual fill.
      if (!execResult.settled) {
        await tradingRepository.updateOrder(dbOrder.id, {
          status: 'SUBMITTED',
          exchangeOrderId: execResult.signature,
          txSignature: execResult.signature,
        });
        return { externalOrderId: execResult.signature ?? '', status: 'SUBMITTED', txSignature: execResult.signature };
      }

      await tradingRepository.updateOrder(dbOrder.id, {
        status: 'FILLED',
        exchangeOrderId: execResult.signature,
        txSignature: execResult.signature,
        filledAt: new Date(),
      });

      const position = await tradingRepository.createPosition({
        userId: request.userId,
        exchangeAccountId: account.id,
        exchange: request.exchange,
        market: request.market,
        side: request.side,
        entryPrice: referencePrice,
        size: baseUnits,
        leverage,
        margin: request.collateralUsd,
      });

      // Flight submits the entry and its optional protection triggers in one
      // confirmed transaction. Persist those trigger prices so the dashboard
      // can show the protections currently attached to this position.
      const protectionSide = request.side === 'LONG' ? 'SELL' : 'BUY';
      if (request.stopLossPrice !== undefined) {
        await tradingRepository.createOrder({
          userId: request.userId,
          exchangeAccountId: account.id,
          positionId: position.id,
          exchange: request.exchange,
          market: request.market,
          type: 'STOP_LOSS',
          side: protectionSide,
          status: 'SUBMITTED',
          size: baseUnits,
          triggerPrice: request.stopLossPrice,
          leverage,
          slippageBps,
          exchangeOrderId: execResult.signature,
          txSignature: execResult.signature,
          idempotencyKey: `${idempotencyKey}-sl`,
        });
      }
      if (request.takeProfitPrice !== undefined) {
        await tradingRepository.createOrder({
          userId: request.userId,
          exchangeAccountId: account.id,
          positionId: position.id,
          exchange: request.exchange,
          market: request.market,
          type: 'TAKE_PROFIT',
          side: protectionSide,
          status: 'SUBMITTED',
          size: baseUnits,
          triggerPrice: request.takeProfitPrice,
          leverage,
          slippageBps,
          exchangeOrderId: execResult.signature,
          txSignature: execResult.signature,
          idempotencyKey: `${idempotencyKey}-tp`,
        });
      }

      await tradingRepository.createTrade({
        userId: request.userId,
        exchangeAccountId: account.id,
        orderId: dbOrder.id,
        positionId: position.id,
        exchange: request.exchange,
        market: request.market,
        side: request.side === 'LONG' ? 'BUY' : 'SELL',
        price: referencePrice,
        size: baseUnits,
        txSignature: execResult.signature,
      });

      await referralService.recordTradeVolume(request.userId, notionalUsd);
      await notificationService.notify(
        request.userId,
        'TRADE_FILLED',
        `✅ ${request.side} ${request.market} opened at ${leverage}x.`,
      );

      await log.info('TRADE', 'Position opened', { userId: request.userId, market: request.market, side: request.side });

      return {
        externalOrderId: execResult.signature ?? '',
        status: 'FILLED',
        txSignature: execResult.signature,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await tradingRepository.updateOrder(dbOrder.id, { status: 'FAILED', errorMessage });
      await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Trade failed: ${errorMessage}`);
      await log.error('TRADE', 'Position open failed', { userId: request.userId, errorMessage });
      return { externalOrderId: '', status: 'REJECTED', errorMessage };
    }
  }

  async close(request: ClosePositionRequest): Promise<PlaceOrderResult> {
    const account = await exchangeAccountService.requireVerifiedAccount(request.userId, request.exchange);
    if (!Number.isFinite(request.percent) || request.percent <= 0 || request.percent > 100) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: 'Close percentage must be between 1 and 100.' };
    }

    const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();
    const dbPosition = await tradingRepository.findOpenPosition(request.userId, request.exchange, request.market);
    const exchangePosition = (await marketQueryService.getOpenPositions(request.userId, request.exchange))
      .find((position) => position.market === request.market);
    if (!exchangePosition || exchangePosition.size <= 0) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: 'No open position on this market.' };
    }

    const closingSide: 'buy' | 'sell' = exchangePosition.side === 'LONG' ? 'sell' : 'buy';
    const baseUnitsToClose = (exchangePosition.size * request.percent) / 100;
    const market = await marketQueryService.getMarket(request.exchange, request.market);
    const referencePrice = market?.markPrice ?? exchangePosition.entryPrice ?? (dbPosition ? Number(dbPosition.entryPrice) : 0);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: `Could not determine a price for ${request.market}.` };
    }
    const notionalUsd = baseUnitsToClose * referencePrice;
    const realizedPnl = exchangePosition.entryPrice > 0
      ? (referencePrice - exchangePosition.entryPrice) *
        (exchangePosition.side === 'LONG' ? baseUnitsToClose : -baseUnitsToClose)
      : undefined;
    const realizedPnlPercent = realizedPnl !== undefined && exchangePosition.margin > 0
      ? (realizedPnl / (exchangePosition.margin * request.percent / 100)) * 100
      : undefined;

    try {
      const traderKeypair = await walletKeyService.getKeypair(account.id);
      const connection = createPhoenixConnection();

      const execResult = await phoenixFlightExecutionService.executeOrder({
        connection,
        traderKeypair,
        userId: request.userId,
        symbol: request.market,
        side: closingSide,
        baseUnits: String(baseUnitsToClose),
        notionalUsd,
        idempotencyKey,
        type: 'market',
        reduceOnly: true,
        marginMode: exchangePosition.marginMode,
      });

      if (!execResult.success) {
        await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Close failed: ${execResult.errorMessage}`);
        return { externalOrderId: '', status: 'REJECTED', errorMessage: execResult.errorMessage };
      }

      const cumulativePnl = dbPosition
        ? Number(dbPosition.realizedPnl) + (realizedPnl ?? 0)
        : 0;
      if (dbPosition && request.percent === 100) {
        await tradingRepository.closePosition(dbPosition.id, cumulativePnl);
      } else if (dbPosition) {
        await tradingRepository.updatePositionSize(
          dbPosition.id,
          Math.max(0, Number(dbPosition.size) - baseUnitsToClose),
          cumulativePnl,
        );
      }

      // A close is its own trade event. Its dollar PnL belongs in history,
      // while the immediate close confirmation deliberately shows a percent.
      await tradingRepository.createTrade({
        userId: request.userId,
        exchangeAccountId: account.id,
        positionId: dbPosition?.id,
        exchange: request.exchange,
        market: request.market,
        side: closingSide === 'buy' ? 'BUY' : 'SELL',
        price: referencePrice,
        size: baseUnitsToClose,
        realizedPnl: realizedPnl ?? 0,
        txSignature: execResult.signature,
      });

      await notificationService.notify(
        request.userId,
        'TRADE_FILLED',
        `✅ Closed ${request.percent}% of ${request.market}.` +
          (realizedPnlPercent === undefined ? '' : `\nRealized PnL: ${formatSignedPnlPercent(realizedPnlPercent)}`),
      );

      return {
        externalOrderId: execResult.signature ?? '',
        status: 'FILLED',
        txSignature: execResult.signature,
        realizedPnl,
        realizedPnlPercent,
        closedMargin: exchangePosition.margin * request.percent / 100,
        entryPrice: exchangePosition.entryPrice,
        closePrice: referencePrice,
        positionSide: exchangePosition.side,
        leverage: exchangePosition.leverage,
        closedSize: baseUnitsToClose,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Close failed: ${errorMessage}`);
      await log.error('TRADE', 'Position close failed', { userId: request.userId, errorMessage });
      return { externalOrderId: '', status: 'REJECTED', errorMessage };
    }
  }

  async closeAll(userId: number, exchange: string): Promise<PlaceOrderResult[]> {
    const openPositions = await tradingRepository.listOpenPositions(userId);
    const results: PlaceOrderResult[] = [];

    for (const position of openPositions) {
      const result = await this.close({ userId, exchange, market: position.market, percent: 100 });
      results.push(result);
    }

    await notificationService.notify(userId, 'TRADE_FILLED', `✅ Closed all positions (${results.length}).`);
    return results;
  }
}

export const tradingService = new TradingService();
