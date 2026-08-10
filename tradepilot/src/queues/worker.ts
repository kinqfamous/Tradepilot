import { Worker } from 'bullmq';
import { Telegraf } from 'telegraf';
import { createQueueConnection } from '../database/redis';
import { config } from '../config/env';
import { NOTIFICATION_QUEUE_NAME } from '../constants';
import { NotificationJobData } from './notification.queue';
import { prisma } from '../database/prisma';
import { notificationService } from '../notifications/notification.service';
import { fileLogger } from '../logger/logger';

const telegram = new Telegraf(config.telegram.botToken).telegram;

const worker = new Worker<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  async (job) => {
    const user = await prisma.user.findUnique({ where: { id: job.data.userId } });
    if (!user) return;

    await telegram.sendMessage(user.telegramId.toString(), job.data.message, { parse_mode: 'Markdown' });
    await notificationService.markDelivered(job.data.notificationId);
  },
  {
    connection: createQueueConnection(),
    prefix: config.queue.prefix,
    concurrency: 10,
  },
);

worker.on('completed', (job) => {
  fileLogger.info(`Notification ${job.id} delivered`);
});

worker.on('failed', (job, err) => {
  fileLogger.error({ err }, `Notification ${job?.id} failed to deliver`);
});

fileLogger.info('TradePilot notification worker started.');

process.once('SIGINT', () => worker.close());
process.once('SIGTERM', () => worker.close());
