import { prisma } from '../database/prisma';
import { notificationService } from '../notifications/notification.service';
import { log } from '../logger/logger';

export interface PlatformStats {
  totalUsers: number;
  activeUsers: number;
  onboardingUsers: number;
  suspendedUsers: number;
  openPositions: number;
  totalTrades: number;
  totalReferrals: number;
  totalReferralRewardsUsd: number;
}

export class AdminService {
  async recordAudit(adminId: number, action: string, details?: Record<string, unknown>): Promise<void> {
    await prisma.adminAuditLog.create({
      data: { adminId, action, details: details ? JSON.stringify(details) : null },
    });
    await log.info('ADMIN', `Admin action: ${action}`, { adminId, ...details });
  }

  async getStats(): Promise<PlatformStats> {
    const [totalUsers, activeUsers, onboardingUsers, suspendedUsers, openPositions, totalTrades, referralAgg] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count({ where: { status: 'ONBOARDING' } }),
        prisma.user.count({ where: { status: 'SUSPENDED' } }),
        prisma.position.count({ where: { status: 'OPEN' } }),
        prisma.trade.count(),
        prisma.referralStats.aggregate({
          _sum: { totalReferrals: true, totalRewardsUsd: true },
        }),
      ]);

    return {
      totalUsers,
      activeUsers,
      onboardingUsers,
      suspendedUsers,
      openPositions,
      totalTrades,
      totalReferrals: referralAgg._sum.totalReferrals ?? 0,
      totalReferralRewardsUsd: Number(referralAgg._sum.totalRewardsUsd ?? 0),
    };
  }

  async getTradingVolume(days = 7): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const trades = await prisma.trade.findMany({
      where: { executedAt: { gte: since } },
      select: { price: true, size: true },
    });
    return trades.reduce((sum, t) => sum + Number(t.price) * Number(t.size), 0);
  }

  async broadcastToAll(adminId: number, message: string): Promise<number> {
    const users = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    await notificationService.broadcast(users.map((u) => u.id), message);
    await this.recordAudit(adminId, 'BROADCAST', { recipientCount: users.length });
    return users.length;
  }

  async suspendUser(adminId: number, userId: number): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    await this.recordAudit(adminId, 'SUSPEND_USER', { userId });
  }

  async reinstateUser(adminId: number, userId: number): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    await this.recordAudit(adminId, 'REINSTATE_USER', { userId });
  }
}

export const adminService = new AdminService();
