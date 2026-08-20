import { fetchConditionalOrderCollection } from '@ellipsis-labs/rise';
import { PublicKey } from '@solana/web3.js';
import { assembleAndSubmit, getPlainClient } from '../exchange/phoenix/flight.client';
import { createPhoenixConnection } from '../exchange/phoenix/phoenix.order-adapter';
import { walletKeyService } from '../exchange/wallet-key.service';
import { exchangeAccountService } from '../users/exchange-account.service';
import { settingsService } from '../settings/settings.service';
import { tradingRepository } from './trading.repository';

export function calculateProtectionPrice(params: {
  entryPrice: number;
  leverage: number;
  percentage: number;
  side: 'LONG' | 'SHORT';
  type: 'STOP_LOSS' | 'TAKE_PROFIT';
}): number {
  const favorable = params.type === 'TAKE_PROFIT';
  const direction = params.side === 'LONG'
    ? (favorable ? 1 : -1)
    : (favorable ? -1 : 1);
  const priceMovementPercent = params.percentage / params.leverage;
  return params.entryPrice * (1 + direction * priceMovementPercent / 100);
}

export class PositionProtectionService {
  async setProtection(params: {
    userId: number;
    exchange: string;
    market: string;
    type: 'STOP_LOSS' | 'TAKE_PROFIT';
    price?: number;
    percentage?: number;
  }): Promise<{ signature: string; price: number }> {
    const account = await exchangeAccountService.requireVerifiedAccount(params.userId, params.exchange);
    const settings = await settingsService.get(params.userId);
    const keypair = await walletKeyService.getKeypair(account.id);
    const client = await getPlainClient();
    const connection = createPhoenixConnection();
    const snapshot = await client.api.traders().getTraderStateSnapshot(account.walletAddress, { traderPdaIndex: 0 });
    const subaccount = snapshot.snapshot.subaccounts.find((candidate) =>
      candidate.positions.some((position) => position.symbol === params.market && Number(position.basePositionLots) !== 0),
    );
    const position = subaccount?.positions.find((candidate) => candidate.symbol === params.market);
    if (!subaccount || !position) throw new Error(`No open ${params.market} position was found on Phoenix.`);

    const dbPosition = await tradingRepository.findOpenPosition(params.userId, params.exchange, params.market);
    const isLong = Number(position.basePositionLots) > 0;
    const entryPrice = Number(position.entryPriceUsd ?? dbPosition?.entryPrice ?? 0);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new Error(`Phoenix did not return a valid entry price for ${params.market}.`);
    }
    const percentage = params.percentage;
    if (percentage !== undefined && (!Number.isFinite(percentage) || percentage <= 0)) {
      throw new Error('Protection percentage must be greater than 0%.');
    }
    const leverage = Number(dbPosition?.leverage ?? settings.defaultLeverage);
    if (!Number.isFinite(leverage) || leverage <= 0) {
      throw new Error(`Could not determine valid leverage for ${params.market}.`);
    }
    const price = percentage !== undefined
      ? calculateProtectionPrice({
          entryPrice,
          leverage,
          percentage,
          side: isLong ? 'LONG' : 'SHORT',
          type: params.type,
        })
      : params.price;
    const valid = params.type === 'STOP_LOSS'
      ? (isLong ? (price ?? 0) < entryPrice : (price ?? 0) > entryPrice)
      : (isLong ? (price ?? 0) > entryPrice : (price ?? 0) < entryPrice);
    if (!Number.isFinite(price) || (price ?? 0) <= 0 || !valid) {
      throw new Error(
        `${params.type === 'STOP_LOSS' ? 'Stop loss' : 'Take profit'} must be ` +
        `${isLong ? (params.type === 'STOP_LOSS' ? 'below' : 'above') : (params.type === 'STOP_LOSS' ? 'above' : 'below')} the entry price ($${entryPrice}).`,
      );
    }

    const instructions: unknown[] = [];
    const existingGreater = (isLong && params.type === 'TAKE_PROFIT') || (!isLong && params.type === 'STOP_LOSS');
    const traderAccount = await client.pda.getTraderAddress({
      authority: account.walletAddress as never,
      traderPdaIndex: 0,
      subaccountIndex: subaccount.subaccountIndex,
    });
    const conditionalOrdersAddress = await client.pda.getConditionalOrdersAddress({ traderAccount });
    const conditionalAccount = await connection.getAccountInfo(new PublicKey(conditionalOrdersAddress), 'confirmed');
    if (conditionalAccount) {
      const collection = await fetchConditionalOrderCollection({
        address: conditionalOrdersAddress,
        skipCache: true,
        client: {
          fetchAccount: async () => ({ data: new Uint8Array(conditionalAccount.data) }),
          _cacheEnabled: false,
        },
      });
      const assetId = client.exchange.market(params.market)?.assetId;
      if (assetId === undefined) throw new Error(`Phoenix market metadata is unavailable for ${params.market}.`);
      for (const conditionalOrderIndex of collection.activeOrderIndices) {
        const existingOrder = collection.orders[conditionalOrderIndex];
        const matchingLeg = existingGreater
          ? existingOrder.greaterTriggerOrder.isActive
          : existingOrder.lessTriggerOrder.isActive;
        if (existingOrder.assetId !== assetId || !matchingLeg) continue;
        instructions.push(...await client.api.orders().cancelConditionalOrder({
          authority: account.walletAddress,
          traderPdaIndex: 0,
          traderSubaccountIndex: subaccount.subaccountIndex,
          isIsolated: subaccount.subaccountIndex !== 0,
          symbol: params.market,
          conditionalOrderIndex,
          executionDirection: existingGreater ? 'greater_than' : 'less_than',
        }));
      }
    }

    const greater = (isLong && params.type === 'TAKE_PROFIT') || (!isLong && params.type === 'STOP_LOSS');
    const closingSide = isLong ? 'sell' : 'buy';
    const slippageFraction = Number(settings.defaultSlippageBps) / 10_000;
    // Phoenix requires an executable IOC limit in addition to the trigger.
    // A sell exit permits fills below the trigger; a buy exit permits fills above it.
    const executionPrice = closingSide === 'sell'
      ? price! * (1 - slippageFraction)
      : price! * (1 + slippageFraction);
    const trigger = {
      side: closingSide,
      orderKind: 'ioc',
      triggerPrice: price!,
      executionPrice,
    };
    instructions.push(...await client.api.orders().placePositionConditionalOrder({
      authority: account.walletAddress,
      traderPdaIndex: 0,
      traderSubaccountIndex: subaccount.subaccountIndex,
      isIsolated: subaccount.subaccountIndex !== 0,
      symbol: params.market,
      sizePercent: 100,
      greaterTrigger: greater ? trigger : undefined,
      lessTrigger: greater ? undefined : trigger,
    }));

    const signature = await assembleAndSubmit({
      connection,
      traderKeypair: keypair,
      instructions,
    });
    const market = client.exchange.market(params.market);
    const positionSize = position.basePositionUnits !== undefined
      ? Math.abs(Number(position.basePositionUnits))
      : Math.abs(Number(position.basePositionLots)) / 10 ** (market?.baseLotsDecimals ?? 0);
    await tradingRepository.cancelActiveProtections(params.userId, params.exchange, params.market, params.type);
    await tradingRepository.createOrder({
      userId: params.userId,
      exchangeAccountId: account.id,
      positionId: dbPosition?.id,
      exchange: params.exchange,
      market: params.market,
      type: params.type,
      side: isLong ? 'SELL' : 'BUY',
      status: 'SUBMITTED',
      size: positionSize,
      triggerPrice: price!,
      leverage: dbPosition?.leverage ?? 1,
      slippageBps: 0,
      exchangeOrderId: signature,
      txSignature: signature,
      idempotencyKey: `protection-${params.userId}-${params.market}-${params.type}-${signature}`,
    });
    return { signature, price: price! };
  }
}

export const positionProtectionService = new PositionProtectionService();
