import { Queue } from 'bullmq';
import { createQueueConnection } from '../database/redis';
import { config } from '../config/env';
import { NOTIFICATION_QUEUE_NAME } from '../constants';

export interface NotificationJobData {
  notificationId: number;
  userId: number;
  message: string;
  card?: {
    market: string;
    side: 'LONG' | 'SHORT';
    leverage: number;
    marginMode: 'CROSS' | 'ISOLATED';
    entryPrice: number;
    marketPrice: number;
    exitPrice?: number;
    pnlPercent?: number;
    eventType?: 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION';
  };
}

export const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
  connection: createQueueConnection(),
  prefix: config.queue.prefix,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});
