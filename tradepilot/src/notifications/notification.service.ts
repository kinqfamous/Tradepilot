import { prisma } from '../database/prisma';
import { NotificationType } from '@prisma/client';
import { notificationQueue } from '../queues/notification.queue';
import { log } from '../logger/logger';

export class NotificationService {
  async notify(
    userId: number,
    type: NotificationType,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const settings = await prisma.userSettings.findUnique({ where: { userId } });
    if (settings && !settings.notificationsOn) return;

    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        message,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });

    await notificationQueue.add('deliver', {
      notificationId: notification.id,
      userId,
      message,
    });

    await log.info('SYSTEM', 'Notification queued', { userId, type });
  }

  async broadcast(userIds: number[], message: string): Promise<void> {
    for (const userId of userIds) {
      await this.notify(userId, 'MAINTENANCE_ANNOUNCEMENT', message);
    }
  }

  async markDelivered(notificationId: number): Promise<void> {
    await prisma.notification.update({ where: { id: notificationId }, data: { deliveredAt: new Date() } });
  }
}

export const notificationService = new NotificationService();
