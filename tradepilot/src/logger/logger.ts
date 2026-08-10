import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { config } from '../config/env';
import { prisma } from '../database/prisma';
import { LogCategory, LogLevel, Prisma } from '@prisma/client';

if (!fs.existsSync(config.logging.dir)) {
  fs.mkdirSync(config.logging.dir, { recursive: true });
}

const logFilePath = path.join(config.logging.dir, 'tradepilot.log');

export const fileLogger = pino(
  { level: config.logging.level },
  pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        level: config.logging.level,
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
      {
        target: 'pino/file',
        level: config.logging.level,
        options: { destination: logFilePath, mkdir: true },
      },
    ],
  }),
);

export async function logEvent(
  level: LogLevel,
  category: LogCategory,
  message: string,
  metadata?: Record<string, unknown>,
  latencyMs?: number,
): Promise<void> {
  const meta = metadata ? JSON.stringify(metadata) : null;

  switch (level) {
    case 'ERROR':
      fileLogger.error({ category, latencyMs, ...metadata }, message);
      break;
    case 'WARN':
      fileLogger.warn({ category, latencyMs, ...metadata }, message);
      break;
    default:
      fileLogger.info({ category, latencyMs, ...metadata }, message);
  }

  try {
    await prisma.logEntry.create({
      data: { level, category, message, metadata: meta, latencyMs } as Prisma.LogEntryUncheckedCreateInput,
    });
  } catch (err) {
    fileLogger.error({ err }, 'Failed to persist log entry to database');
  }
}

export const log = {
  info: (category: LogCategory, message: string, metadata?: Record<string, unknown>) =>
    logEvent('INFO', category, message, metadata),
  warn: (category: LogCategory, message: string, metadata?: Record<string, unknown>) =>
    logEvent('WARN', category, message, metadata),
  error: (category: LogCategory, message: string, metadata?: Record<string, unknown>) =>
    logEvent('ERROR', category, message, metadata),
  performance: (category: LogCategory, message: string, latencyMs: number, metadata?: Record<string, unknown>) =>
    logEvent('INFO', category, message, metadata, latencyMs),
};
