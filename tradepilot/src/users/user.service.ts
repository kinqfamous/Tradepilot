import crypto from 'crypto';
import { User } from '@prisma/client';
import { userRepository } from './user.repository';
import { log } from '../logger/logger';
import { prisma } from '../database/prisma';

function generateReferralCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export class UserService {
  async getOrCreate(telegramId: number, telegramUsername: string | undefined, referredByCode?: string): Promise<User> {
    const existing = await userRepository.findByTelegramId(BigInt(telegramId));
    if (existing) return existing;

    let referredById: number | undefined;
    if (referredByCode) {
      const referrer = await userRepository.findByReferralCode(referredByCode);
      if (referrer) referredById = referrer.id;
    }

    let referralCode = generateReferralCode();
    // Extremely unlikely collision given 4 random bytes, but guard anyway.
    while (await userRepository.findByReferralCode(referralCode)) {
      referralCode = generateReferralCode();
    }

    const user = await userRepository.create({
      telegramId: BigInt(telegramId),
      telegramUsername,
      referralCode,
      referredById,
    });

    if (referredById) {
      await prisma.referralStats.update({
        where: { userId: referredById },
        data: { totalReferrals: { increment: 1 } },
      });
    }

    await log.info('AUTH', 'New user registered', { userId: user.id, referredById });
    return user;
  }

  async acceptTerms(userId: number): Promise<User> {
    const user = await userRepository.acceptTerms(userId);
    await log.info('AUTH', 'User accepted terms', { userId });
    return user;
  }

  async completeOnboarding(userId: number): Promise<User> {
    const user = await userRepository.updateStatus(userId, 'ACTIVE');
    await log.info('AUTH', 'User completed onboarding', { userId });
    return user;
  }

  async requireActive(userId: number): Promise<User> {
    const user = await userRepository.findById(userId);
    if (!user) throw new Error('User not found.');
    if (user.status === 'SUSPENDED') throw new Error('Your account is suspended.');
    if (user.status === 'BANNED') throw new Error('Your account is banned.');
    return user;
  }

  buildReferralLink(botUsername: string, referralCode: string): string {
    return `https://t.me/${botUsername}?start=${referralCode}`;
  }
}

export const userService = new UserService();
