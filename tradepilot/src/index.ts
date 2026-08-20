import { config } from './config/env';
import { createBot } from './bot/bot';
import { prisma } from './database/prisma';
import { redis } from './database/redis';
import { fileLogger, log } from './logger/logger';

async function main(): Promise<void> {
  fileLogger.info('Starting TradePilot...');

  try {
    await prisma.$connect();
    await redis.ping();
  } catch (error) {
    fileLogger.error({ error }, 'Failed to connect to database/Redis. Did you run migrations and start Redis?');
    process.exit(1);
  }

  // Notification delivery and Phoenix fill reconciliation are required bot
  // functionality, not an optional deployment companion. Starting them here
  // ensures TP/SL/liquidation cards work under the normal dev/start commands.
  await import('./queues/worker');

  const bot = createBot();

  await bot.launch();
  await log.info('SYSTEM', 'TradePilot bot started', { admins: config.telegram.adminIds });
  fileLogger.info('TradePilot is running with notifications and fill reconciliation enabled.');

  const shutdown = async (signal: string) => {
    fileLogger.info(`Received ${signal}, shutting down gracefully...`);
    bot.stop(signal);
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    fileLogger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    fileLogger.error({ error }, 'Uncaught exception');
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
