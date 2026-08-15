export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(amount: number, maxFractionDigits = 4): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits });
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function isValidBase58PrivateKey(value: string): boolean {
  // Solana base58 secret keys decode to 64 bytes; base58 alphabet excludes 0, O, I, l.
  return /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(value.trim());
}

export function isLikelyMarketSymbol(value: string): boolean {
  return /^[A-Z0-9]{2,10}-PERP$/i.test(value.trim());
}

export function normalizeMarketSymbol(value: string): string {
  return value.trim().toUpperCase();
}

const LONG_WORDS = new Set(['long', 'buy', 'l']);
const SHORT_WORDS = new Set(['short', 'sell', 's']);

export interface ParsedTickerInput {
  rawTicker: string;
  side?: 'LONG' | 'SHORT';
}

export function parseTickerInput(text: string): ParsedTickerInput | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const rawTicker = tokens[0];
  if (!/^[A-Za-z0-9-]{2,15}$/.test(rawTicker)) return null;

  let side: 'LONG' | 'SHORT' | undefined;
  if (tokens.length > 1) {
    const word = tokens[1].toLowerCase();
    if (LONG_WORDS.has(word)) side = 'LONG';
    else if (SHORT_WORDS.has(word)) side = 'SHORT';
  }

  return { rawTicker, side };
}

export interface ParsedGroupCommand {
  rawTicker: string;
  side?: 'LONG' | 'SHORT';
}

/** Parses a group command after the bot mention has been removed. */
export function parseGroupCommand(textWithoutMention: string): ParsedGroupCommand | null {
  const tokens = textWithoutMention
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^\$/, ''));

  if (tokens.length === 0) return null;

  let side: 'LONG' | 'SHORT' | undefined;
  let rawTicker: string | undefined;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!side && LONG_WORDS.has(lower)) {
      side = 'LONG';
      continue;
    }
    if (!side && SHORT_WORDS.has(lower)) {
      side = 'SHORT';
      continue;
    }
    if (!rawTicker && /^[A-Za-z0-9-]{2,15}$/.test(token)) rawTicker = token;
  }

  return rawTicker ? { rawTicker, side } : null;
}
