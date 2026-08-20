import { Worker } from 'bullmq';
import { Input, Telegraf } from 'telegraf';
import { createQueueConnection } from '../database/redis';
import { config } from '../config/env';
import { NOTIFICATION_QUEUE_NAME } from '../constants';
import { NotificationJobData } from './notification.queue';
import { prisma } from '../database/prisma';
import { notificationService } from '../notifications/notification.service';
import { fileLogger } from '../logger/logger';
import { builderFeeService } from '../fees/builder-fee.service';
import { pnlCardService } from '../pnl/pnl-card.service';
import { limitOrderReconciliationService } from '../trading/limit-order-reconciliation.service';
import { positionEventReconciliationService } from '../trading/position-event-reconciliation.service';

const telegram = new Telegraf(config.telegram.botToken).telegram;

const worker = new Worker<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  async (job) => {
    const user = await prisma.user.findUnique({ where: { id: job.data.userId } });
    if (!user) return;

    if (job.data.card) {
      const card = pnlCardService.render({
        ...job.data.card,
        exitPrice: job.data.card.exitPrice ?? job.data.card.marketPrice,
        status: job.data.card.eventType ?? 'ENTRY',
      });
      await telegram.sendPhoto(
        user.telegramId.toString(),
        Input.fromBuffer(card, `tradepilot-${job.data.card.market}-entry.png`),
        { caption: job.data.message, parse_mode: 'Markdown' },
      );
    } else {
      await telegram.sendMessage(user.telegramId.toString(), job.data.message, { parse_mode: 'Markdown' });
    }
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

// A submitted Flight transaction whose fee cannot be conclusively reconciled
// must never remain pending forever or silently appear as revenue.
const reconcileFees = async () => {
  try {
    const result = await builderFeeService.reconcile();
    if (result.flaggedCount > 0) {
      fileLogger.warn({ flaggedCount: result.flaggedCount }, 'Flight fee events require reconciliation');
    }
  } catch (error) {
    fileLogger.error({ error }, 'Flight fee reconciliation failed');
  }
};
void reconcileFees();
const feeReconciliationTimer = setInterval(() => void reconcileFees(), 5 * 60_000);
feeReconciliationTimer.unref();

const reconcileLimitOrders = async () => {
  try {
    await limitOrderReconciliationService.reconcile();
  } catch (error) {
    fileLogger.error({ error }, 'Phoenix limit-order reconciliation failed');
  }
};
void reconcileLimitOrders();
const limitOrderReconciliationTimer = setInterval(() => void reconcileLimitOrders(), 30_000);
limitOrderReconciliationTimer.unref();

const reconcilePositionEvents = async () => {
  try {
    await positionEventReconciliationService.reconcile();
  } catch (error) {
    fileLogger.error({ error }, 'Phoenix position-event reconciliation failed');
  }
};
void reconcilePositionEvents();
const positionEventReconciliationTimer = setInterval(() => void reconcilePositionEvents(), 30_000);
positionEventReconciliationTimer.unref();

process.once('SIGINT', () => {
  clearInterval(feeReconciliationTimer);
  clearInterval(limitOrderReconciliationTimer);
  clearInterval(positionEventReconciliationTimer);
  return worker.close();
});
process.once('SIGTERM', () => {
  clearInterval(feeReconciliationTimer);
  clearInterval(limitOrderReconciliationTimer);
  clearInterval(positionEventReconciliationTimer);
  return worker.close();
});
