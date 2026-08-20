import { prisma } from '../database/prisma';
import { Order, Position, Prisma } from '@prisma/client';

export class TradingRepository {
  async listSubmittedLimitOrders() {
    return prisma.order.findMany({
      where: { type: 'LIMIT', status: { in: ['SUBMITTED', 'PARTIALLY_FILLED'] } },
      include: { exchangeAccount: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listUserPendingLimitOrders(userId: number, exchange: string): Promise<Order[]> {
    return prisma.order.findMany({
      where: {
        userId,
        exchange,
        type: 'LIMIT',
        status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findUserPendingLimitOrder(id: number, userId: number, exchange: string) {
    return prisma.order.findFirst({
      where: {
        id, userId, exchange, type: 'LIMIT',
        status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
      },
      include: { exchangeAccount: true },
    });
  }

  async listPendingLimitProtections(parent: Pick<Order, 'userId' | 'exchange' | 'market' | 'txSignature'>) {
    if (!parent.txSignature) return [];
    return prisma.order.findMany({
      where: {
        userId: parent.userId,
        exchange: parent.exchange,
        market: parent.market,
        exchangeOrderId: parent.txSignature,
        positionId: null,
        type: { in: ['STOP_LOSS', 'TAKE_PROFIT'] },
        status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
      },
    });
  }

  async cancelPendingLimitFamily(parent: Pick<Order, 'id' | 'userId' | 'txSignature'>) {
    return prisma.$transaction([
      prisma.order.update({ where: { id: parent.id }, data: { status: 'CANCELLED' } }),
      prisma.order.updateMany({
        where: {
          userId: parent.userId,
          positionId: null,
          exchangeOrderId: parent.txSignature ?? '__none__',
          type: { in: ['STOP_LOSS', 'TAKE_PROFIT'] },
          status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
        },
        data: { status: 'CANCELLED' },
      }),
    ]);
  }

  async isPhoenixOrderClaimed(exchangeOrderId: string): Promise<boolean> {
    return (await prisma.order.count({ where: { exchangeOrderId, status: 'FILLED' } })) > 0;
  }

  async claimFilledLimitOrder(
    id: number,
    exchangeOrderId: string,
    fillPrice: number,
    txSignature?: string | null,
  ): Promise<boolean> {
    const result = await prisma.order.updateMany({
      where: { id, status: { in: ['SUBMITTED', 'PARTIALLY_FILLED'] } },
      data: {
        status: 'FILLED',
        exchangeOrderId,
        price: fillPrice,
        filledAt: new Date(),
        txSignature: txSignature ?? undefined,
      },
    });
    return result.count === 1;
  }

  async releaseFilledLimitOrderClaim(id: number, placementSignature: string | null): Promise<void> {
    await prisma.order.updateMany({
      where: { id, type: 'LIMIT', status: 'FILLED' },
      data: {
        status: 'SUBMITTED',
        exchangeOrderId: placementSignature,
        filledAt: null,
      },
    });
  }
  async findOrderByIdempotencyKey(key: string): Promise<Order | null> {
    return prisma.order.findUnique({ where: { idempotencyKey: key } });
  }

  async createOrder(data: Prisma.OrderUncheckedCreateInput): Promise<Order> {
    return prisma.order.create({ data });
  }

  async updateOrder(id: number, data: Prisma.OrderUncheckedUpdateInput): Promise<Order> {
    return prisma.order.update({ where: { id }, data });
  }

  async createPosition(data: Prisma.PositionUncheckedCreateInput): Promise<Position> {
    return prisma.position.create({ data });
  }

  async closePosition(id: number, realizedPnl: number): Promise<Position> {
    return prisma.position.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), realizedPnl },
    });
  }

  async updatePositionSize(id: number, size: number, realizedPnl: number): Promise<Position> {
    return prisma.position.update({ where: { id }, data: { size, realizedPnl } });
  }

  async findOpenPosition(userId: number, exchange: string, market: string): Promise<Position | null> {
    return prisma.position.findFirst({
      where: { userId, exchange, market, status: 'OPEN' },
    });
  }

  async listOpenPositions(userId: number): Promise<Position[]> {
    return prisma.position.findMany({ where: { userId, status: 'OPEN' }, orderBy: { openedAt: 'desc' } });
  }

  async listAllOpenPositionsWithAccount() {
    return prisma.position.findMany({
      where: { status: 'OPEN' },
      include: {
        exchangeAccount: true,
        orders: { where: { type: { in: ['STOP_LOSS', 'TAKE_PROFIT'] }, status: 'SUBMITTED' } },
      },
    });
  }

  async listActiveProtections(userId: number, exchange: string): Promise<Order[]> {
    return prisma.order.findMany({
      where: {
        userId,
        exchange,
        type: { in: ['STOP_LOSS', 'TAKE_PROFIT'] },
        status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancelActiveProtections(userId: number, exchange: string, market: string, type: 'STOP_LOSS' | 'TAKE_PROFIT') {
    return prisma.order.updateMany({
      where: { userId, exchange, market, type, status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] } },
      data: { status: 'CANCELLED' },
    });
  }

  async listRecentTrades(userId: number, limit = 10) {
    return prisma.trade.findMany({ where: { userId }, orderBy: { executedAt: 'desc' }, take: limit });
  }

  async createTrade(data: Prisma.TradeUncheckedCreateInput) {
    return prisma.trade.create({ data });
  }
}

export const tradingRepository = new TradingRepository();
