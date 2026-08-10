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
