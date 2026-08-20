import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import path from 'path';

export interface PnlCardData {
  market: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  marginMode: 'CROSS' | 'ISOLATED';
  pnlPercent?: number;
  entryPrice: number;
  /** Mark price for an open position; close-fill price for a completed one. */
  exitPrice: number;
  status: 'OPEN' | 'CLOSED' | 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION';
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  })[character] ?? character);
}

function number(value: number, maximumFractionDigits = 4): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

// This is the user-supplied source artwork, not a recreated logo. The card
// uses a tightly cropped area of it so the monogram geometry stays exact.
const logoDataUri = `data:image/jpeg;base64,${readFileSync(
  path.resolve(process.cwd(), 'assets/tradepilot-logo.jpg'),
).toString('base64')}`;

/** Creates the PNG share card sent for open and closed position PnL. */
export class PnlCardService {
  render(data: PnlCardData): Buffer {
    const isConfirmation = data.status === 'ENTRY';
    const isExitEvent = ['STOP_LOSS', 'TAKE_PROFIT', 'LIQUIDATION'].includes(data.status);
    const profitable = data.status === 'ENTRY' ? data.side === 'LONG' : (data.pnlPercent ?? 0) >= 0;
    const accent = profitable ? '#2DE38A' : '#FF5C6C';
    const pnlSign = profitable ? '+' : '-';
    const priceLabel = data.status === 'CLOSED' || isExitEvent ? 'EXIT PRICE' : 'MARK PRICE';
    const title = data.status === 'ENTRY' ? 'LIMIT ORDER FILLED'
      : data.status === 'STOP_LOSS' ? 'STOP LOSS FILLED'
      : data.status === 'TAKE_PROFIT' ? 'TAKE PROFIT FILLED'
      : data.status === 'LIQUIDATION' ? 'POSITION LIQUIDATED'
      : data.status === 'OPEN' ? 'OPEN PNL' : 'CLOSED PNL';
    const headlineLabel = isConfirmation ? 'STATUS'
      : data.status === 'STOP_LOSS' ? 'SL PNL'
      : data.status === 'TAKE_PROFIT' ? 'TP PNL'
      : data.status === 'LIQUIDATION' ? 'LIQ PNL'
      : 'PNL';
    const headlineValue = isConfirmation
      ? 'CONFIRMED'
      : `${pnlSign}${Math.abs(data.pnlPercent ?? 0).toFixed(2)}%`;
    const headlineSize = isConfirmation ? 42 : 70;
    const market = escapeXml(data.market.replace(/-PERP$/i, ''));
    const direction = data.side === 'LONG' ? 'LONG' : 'SHORT';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <defs>
          <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#101114"/><stop offset="100%" stop-color="#18191d"/>
          </linearGradient>
          <filter id="glow"><feGaussianBlur stdDeviation="22"/></filter>
          <clipPath id="logo-crop"><rect x="86" y="48" width="94" height="82"/></clipPath>
        </defs>
        <rect width="1200" height="630" fill="#050505"/>
        <circle cx="1050" cy="95" r="170" fill="${accent}" opacity=".10" filter="url(#glow)"/>
        <rect x="28" y="28" width="1144" height="574" rx="38" fill="url(#background)" stroke="#44464b" stroke-width="2"/>
        <image href="${logoDataUri}" x="18" y="-24" width="220" height="220" preserveAspectRatio="none" clip-path="url(#logo-crop)"/>
        <text x="190" y="119" fill="#ffffff" font-family="Arial, sans-serif" font-weight="700" font-size="39">Tradepilot</text>
        <text x="86" y="194" fill="#9b9da5" font-family="Arial, sans-serif" font-weight="700" font-size="19" letter-spacing="2">${title}</text>
        <text x="86" y="293" fill="#ffffff" font-family="Arial, sans-serif" font-weight="800" font-size="66">${market}</text>
        <rect x="86" y="319" width="105" height="39" rx="19" fill="${data.side === 'LONG' ? '#103b2a' : '#491c25'}"/>
        <text x="138" y="346" text-anchor="middle" fill="${accent}" font-family="Arial, sans-serif" font-weight="800" font-size="18">${direction}</text>
        <text x="212" y="346" fill="#c5c7cc" font-family="Arial, sans-serif" font-weight="700" font-size="22">${number(data.leverage, 2)}x</text>
        <text x="1114" y="199" text-anchor="end" fill="#9b9da5" font-family="Arial, sans-serif" font-weight="700" font-size="19" letter-spacing="2">${headlineLabel}</text>
        <text x="1114" y="289" text-anchor="end" fill="${accent}" font-family="Arial, sans-serif" font-weight="900" font-size="${headlineSize}">${headlineValue}</text>
        <line x1="86" y1="409" x2="1114" y2="409" stroke="#393b40" stroke-width="2"/>
        <text x="86" y="459" fill="#8e9098" font-family="Arial, sans-serif" font-weight="700" font-size="17" letter-spacing="1.5">ENTRY PRICE</text>
        <text x="86" y="500" fill="#ffffff" font-family="Arial, sans-serif" font-weight="700" font-size="28">$${number(data.entryPrice)}</text>
        <text x="506" y="459" fill="#8e9098" font-family="Arial, sans-serif" font-weight="700" font-size="17" letter-spacing="1.5">${priceLabel}</text>
        <text x="506" y="500" fill="#ffffff" font-family="Arial, sans-serif" font-weight="700" font-size="28">$${number(data.exitPrice)}</text>
        <text x="86" y="559" fill="#777a82" font-family="Arial, sans-serif" font-size="17">Margin ${data.marginMode === 'ISOLATED' ? 'Isolated' : 'Cross'}</text>
        <text x="1114" y="559" text-anchor="end" fill="#777a82" font-family="Arial, sans-serif" font-size="17">tradepilot</text>
      </svg>`;

    return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  }
}

export const pnlCardService = new PnlCardService();
