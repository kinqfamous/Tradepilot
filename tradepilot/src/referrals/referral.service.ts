import { prisma } from '../database/prisma';
import { REFERRAL_REWARD_BPS } from '../constants';
import { log } from '../logger/logger';
import { notificationService } from '../notifications/notification.service';

export interface LeaderboardEntry {
  userId: number;
  telegramUsername: string | null;
  totalReferrals: number;
  totalVolumeUsd: number;
  totalRewardsUsd: number;
}

export class ReferralService {
  async getStats(userId: number) {
    const stats = await prisma.referralStats.findUnique({ where: { userId } });
    if (stats) return stats;
    return prisma.referralStats.create({ data: { userId } });
  }

  /**
   * Called after a trade settles. Credits the referrer (if any) a small
   * percentage of the trade's notional value and updates volume stats.
   */
  async recordTradeVolume(userId: number, notionalUsd: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    if (user.referredById) {
      const rewardUsd = (notionalUsd * REFERRAL_REWARD_BPS) / 10_000;

      await prisma.referralReward.create({
        data: {
          referrerId: user.referredById,
          referredUserId: userId,
          amountUsd: rewardUsd,
          status: 'CREDITED',
          creditedAt: new Date(),
        },
      });

      await prisma.referralStats.upsert({
        where: { userId: user.referredById },
        create: { userId: user.referredById, totalVolumeUsd: notionalUsd, totalRewardsUsd: rewardUsd },
        update: {
          totalVolumeUsd: { increment: notionalUsd },
          totalRewardsUsd: { increment: rewardUsd },
        },
      });

      await notificationService.notify(user.referredById, 'REFERRAL_REWARD', `You earned $${rewardUsd.toFixed(2)} from a referral's trade.`);
      await log.info('REFERRAL', 'Referral reward credited', {
        referrerId: user.referredById,
        referredUserId: userId,
        rewardUsd,
      });
    }
  }

  async getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
    const rows = await prisma.referralStats.findMany({
      orderBy: { totalVolumeUsd: 'desc' },
      take: limit,
      include: { user: true },
    });

    return rows.map((r) => ({
      userId: r.userId,
      telegramUsername: r.user.telegramUsername,
      totalReferrals: r.totalReferrals,
      totalVolumeUsd: Number(r.totalVolumeUsd),
      totalRewardsUsd: Number(r.totalRewardsUsd),
    }));
  }
}

export const referralService = new ReferralService();
