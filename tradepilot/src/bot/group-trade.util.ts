import { config } from '../config/env';

export interface GroupTradePayload {
  side: 'LONG' | 'SHORT';
  rawTicker: string;
}

const PAYLOAD_PREFIX = 'gt_';

export function buildGroupTradeDeepLink(side: 'LONG' | 'SHORT', rawTicker: string): string {
  const safeTicker = rawTicker.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `https://t.me/${config.telegram.botUsername}?start=${PAYLOAD_PREFIX}${side}_${safeTicker}`;
}

export function parseGroupTradeDeepLink(payload: string | undefined): GroupTradePayload | null {
  if (!payload || !payload.startsWith(PAYLOAD_PREFIX)) return null;
  const rest = payload.slice(PAYLOAD_PREFIX.length);
  const separatorIndex = rest.indexOf('_');
  if (separatorIndex === -1) return null;

  const side = rest.slice(0, separatorIndex);
  const rawTicker = rest.slice(separatorIndex + 1);
  if ((side !== 'LONG' && side !== 'SHORT') || !rawTicker) return null;
  return { side, rawTicker };
}
