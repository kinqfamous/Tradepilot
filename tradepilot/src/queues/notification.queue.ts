import { Queue } from 'bullmq';
import { createQueueConnection } from '../database/redis';
import { config } from '../config/env';
import { NOTIFICATION_QUEUE_NAME } from '../constants';

export interface NotificationJobData {
  notificationId: number;
  userId: number;
  message: string;
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
