import crypto from 'crypto';
import { exchangeRegistry } from '../exchange/exchange.registry';
import { exchangeAccountService } from '../users/exchange-account.service';
import { tradingRepository } from './trading.repository';
import { settingsService } from '../settings/settings.service';
import { referralService } from '../referrals/referral.service';
import { notificationService } from '../notifications/notification.service';
import { systemStateService } from '../admin/system-state.service';
import { log } from '../logger/logger';
import { PlaceOrderResult } from '../types/exchange.types';

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
    const { allowed, reason } = await systemStateService.canTrade();
    if (!allowed) {
      return { externalOrderId: '', status: 'REJECTED', errorMessage: reason };
    }

    const account = await exchangeAccountService.requireVerifiedAccount(request.userId, request.exchange);
    const settings = await settingsService.get(request.userId);
    const adapter = exchangeRegistry.get(request.exchange);
    const credential = await exchangeAccountService.getCredential(account);

    const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();

    const existing = await tradingRepository.findOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { externalOrderId: existing.exchangeOrderId ?? '', status: existing.status as any };
    }

    const leverage = request.leverage;
    const slippageBps = request.slippageBpsOverride ?? settings.defaultSlippageBps;

    const dbOrder = await tradingRepository.createOrder({
      userId: request.userId,
      exchangeAccountId: account.id,
      exchange: request.exchange,
      market: request.market,
      type: request.orderType ?? 'MARKET',
      side: request.side === 'LONG' ? 'BUY' : 'SELL',
      size: 0, // filled in once the adapter computes it
      leverage,
      slippageBps,
      idempotencyKey,
      status: 'PENDING',
    });

    try {
      const result = await adapter.trading.openPosition({
        credential,
        market: request.market,
        side: request.side,
        collateralUsd: request.collateralUsd,
        leverage,
        slippageBps,
        orderType: request.orderType ?? 'MARKET',
        limitPrice: request.limitPrice,
        stopLossPrice: request.stopLossPrice,
        takeProfitPrice: request.takeProfitPrice,
        idempotencyKey,
      });

      if (result.status === 'REJECTED') {
        await tradingRepository.updateOrder(dbOrder.id, { status: 'REJECTED', errorMessage: result.errorMessage });
        await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Trade failed: ${result.errorMessage}`);
        return result;
      }

      await tradingRepository.updateOrder(dbOrder.id, {
        status: 'FILLED',
        exchangeOrderId: result.externalOrderId,
        txSignature: result.txSignature,
        filledAt: new Date(),
      });

      const position = await tradingRepository.createPosition({
        userId: request.userId,
        exchangeAccountId: account.id,
        exchange: request.exchange,
        market: request.market,
        side: request.side,
        entryPrice: result.fillPrice ?? 0,
        size: request.collateralUsd * leverage / (result.fillPrice || 1),
        leverage,
        margin: request.collateralUsd,
      });

      await tradingRepository.createTrade({
        userId: request.userId,
        exchangeAccountId: account.id,
        orderId: dbOrder.id,
        positionId: position.id,
        exchange: request.exchange,
        market: request.market,
        side: request.side === 'LONG' ? 'BUY' : 'SELL',
        price: result.fillPrice ?? 0,
        size: request.collateralUsd * leverage / (result.fillPrice || 1),
        txSignature: result.txSignature,
      });

      await referralService.recordTradeVolume(request.userId, request.collateralUsd * leverage);
      await notificationService.notify(
        request.userId,
        'TRADE_FILLED',
        `✅ ${request.side} ${request.market} opened at ${leverage}x.`,
      );

      await log.info('TRADE', 'Position opened', { userId: request.userId, market: request.market, side: request.side });

      return result;
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
    const settings = await settingsService.get(request.userId);
    const adapter = exchangeRegistry.get(request.exchange);
    const credential = await exchangeAccountService.getCredential(account);

    const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();
    const dbPosition = await tradingRepository.findOpenPosition(request.userId, request.exchange, request.market);

    try {
      const result = await adapter.trading.closePosition({
        credential,
        market: request.market,
        percent: request.percent,
        slippageBps: settings.defaultSlippageBps,
        idempotencyKey,
      });

      if (result.status === 'REJECTED') {
        await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Close failed: ${result.errorMessage}`);
        return result;
      }

      if (dbPosition && request.percent === 100) {
        await tradingRepository.closePosition(dbPosition.id, 0);
      }

      await notificationService.notify(
        request.userId,
        'TRADE_FILLED',
        `✅ Closed ${request.percent}% of ${request.market}.`,
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await notificationService.notify(request.userId, 'TRADE_FAILED', `❌ Close failed: ${errorMessage}`);
      await log.error('TRADE', 'Position close failed', { userId: request.userId, errorMessage });
      return { externalOrderId: '', status: 'REJECTED', errorMessage };
    }
  }

  async closeAll(userId: number, exchange: string): Promise<PlaceOrderResult[]> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const adapter = exchangeRegistry.get(exchange);
    const credential = await exchangeAccountService.getCredential(account);

    const results = await adapter.trading.closeAllPositions(credential);

    const openPositions = await tradingRepository.listOpenPositions(userId);
    for (const position of openPositions) {
      await tradingRepository.closePosition(position.id, 0);
    }

    await notificationService.notify(userId, 'TRADE_FILLED', `✅ Closed all positions (${results.length}).`);
    return results;
  }
}

export const tradingService = new TradingService();
