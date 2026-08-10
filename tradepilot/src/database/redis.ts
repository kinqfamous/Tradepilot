import Redis from 'ioredis';
import { config } from '../config/env';

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

// BullMQ requires maxRetriesPerRequest: null on the connection it's given.
export const redis: Redis =
  global.__redis ??
  new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

if (process.env.NODE_ENV !== 'production') {
  global.__redis = redis;
}

/** Separate connection for BullMQ so its blocking commands never contend with app cache reads. */
export function createQueueConnection(): Redis {
  return new Redis(config.redis.url, { maxRetriesPerRequest: null });
}
