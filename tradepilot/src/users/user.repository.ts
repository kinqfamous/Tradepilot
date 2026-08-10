import { prisma } from '../database/prisma';
import { User, UserStatus } from '@prisma/client';

export class UserRepository {
  async findByTelegramId(telegramId: bigint): Promise<User | null> {
    return prisma.user.findUnique({ where: { telegramId } });
  }

  async findById(id: number): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async findByReferralCode(code: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { referralCode: code } });
  }

  async create(data: {
    telegramId: bigint;
    telegramUsername?: string;
    referralCode: string;
    referredById?: number;
  }): Promise<User> {
    return prisma.user.create({
      data: {
        telegramId: data.telegramId,
        telegramUsername: data.telegramUsername,
        referralCode: data.referralCode,
        referredById: data.referredById,
        settings: { create: {} },
        referralStats: { create: {} },
      },
    });
  }

  async updateStatus(id: number, status: UserStatus): Promise<User> {
    return prisma.user.update({ where: { id }, data: { status } });
  }

  async acceptTerms(id: number): Promise<User> {
    return prisma.user.update({ where: { id }, data: { acceptedTermsAt: new Date() } });
  }

  async setPreferredExchange(id: number, exchange: string): Promise<User> {
    return prisma.user.update({ where: { id }, data: { preferredExchange: exchange } });
  }

  async listActive(limit: number, offset: number): Promise<User[]> {
    return prisma.user.findMany({
      where: { status: 'ACTIVE' },
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });
  }

  async countByStatus(status: UserStatus): Promise<number> {
    return prisma.user.count({ where: { status } });
  }
}

export const userRepository = new UserRepository();
