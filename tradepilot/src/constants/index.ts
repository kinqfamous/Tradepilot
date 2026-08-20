export const SCENE_IDS = {
  ONBOARDING: 'onboarding-wizard',
  LINK_ACCOUNT: 'link-account-wizard',
  TRADE: 'trade-wizard',
  CLOSE_POSITION: 'close-position-wizard',
  PROTECTION: 'protection-wizard',
  PENDING_LIMIT_EDIT: 'pending-limit-edit-wizard',
  SETTINGS: 'settings-wizard',
  BROADCAST: 'broadcast-wizard',
  WITHDRAW: 'withdraw-wizard',
  FUND_PHOENIX: 'fund-phoenix-wizard',
} as const;

export const REFERRAL_REWARD_BPS = 10; // 0.10% of trade notional, credited to referrer
export const MAX_LEVERAGE_HARD_CAP = 50;
export const MIN_LEVERAGE = 1;

export const CLOSE_PERCENT_PRESETS = [25, 50, 75, 100] as const;

export const WS_RECONNECT_BASE_DELAY_MS = 1000;
export const WS_RECONNECT_MAX_DELAY_MS = 30_000;
export const WS_HEARTBEAT_INTERVAL_MS = 15_000;
export const WS_HEARTBEAT_TIMEOUT_MS = 45_000;

export const RETRYABLE_ERROR_SNIPPETS = [
  'timeout',
  'timed out',
  'ECONNRESET',
  'ETIMEDOUT',
  'rate limit',
  '429',
  'fetch failed',
  'network error',
];

export const NOTIFICATION_QUEUE_NAME = 'notifications';
export const POSITION_SYNC_QUEUE_NAME = 'position-sync';

export const DEFAULT_PAGE_SIZE = 5;
