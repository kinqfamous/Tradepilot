import crypto from 'crypto';
import { MiddlewareFn } from 'telegraf';
import { BotContext } from '../types/bot.types';
import { log } from '../logger/logger';
import { config } from '../config/env';

const REDACTED = '[REDACTED]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes credentials while preserving enough context to diagnose an incident. */
export function sanitizeErrorText(value: string, configuredSecrets: string[] = []): string {
  let sanitized = value;

  for (const secret of configuredSecrets.filter((item) => item.length >= 8)) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }

  return sanitized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, `$1${REDACTED}@`)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:api[_-]?key|token|secret|password|private[_-]?key)\s*["']?\s*[:=]\s*["']?)[^"',\s}\]]+/gi,
      `$1${REDACTED}`,
    );
}

function configuredSecrets(): string[] {
  return [
    config.telegram.botToken,
    config.security.credentialsEncryptionKeyHex,
    config.security.jwtSecret,
    config.database.url,
    config.redis.url,
    config.phoenix.solanaRpcUrl,
  ];
}

export const errorBoundary: MiddlewareFn<BotContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const incidentId = `TP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const secrets = configuredSecrets();
    const errorMessage = sanitizeErrorText(error instanceof Error ? error.message : String(error), secrets);
    const errorStack = error instanceof Error && error.stack
      ? sanitizeErrorText(error.stack, secrets)
      : undefined;

    await log.error('SYSTEM', 'Unhandled error in update handler', {
      incidentId,
      errorMessage,
      errorStack,
      updateType: ctx.updateType,
    });

    try {
      await ctx.reply(
        `⚠️ Something went wrong. Please try again. If the problem continues, contact support with incident ID \`${incidentId}\`.`,
        { parse_mode: 'Markdown' },
      );
    } catch {
      // Nothing more we can do if even the reply fails.
    }
  }
};
