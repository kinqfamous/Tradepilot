import { prisma } from '../database/prisma';
import { Order, Position, Prisma } from '@prisma/client';

export class TradingRepository {
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

  async findOpenPosition(userId: number, exchange: string, market: string): Promise<Position | null> {
    return prisma.position.findFirst({
      where: { userId, exchange, market, status: 'OPEN' },
    });
  }

  async listOpenPositions(userId: number): Promise<Position[]> {
    return prisma.position.findMany({ where: { userId, status: 'OPEN' }, orderBy: { openedAt: 'desc' } });
  }

  async listRecentTrades(userId: number, limit = 10) {
    return prisma.trade.findMany({ where: { userId }, orderBy: { executedAt: 'desc' }, take: limit });
  }

  async createTrade(data: Prisma.TradeUncheckedCreateInput) {
    return prisma.trade.create({ data });
  }
}

export const tradingRepository = new TradingRepository();
