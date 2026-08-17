import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

function optionalOrNull(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : null;
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppConfig {
  telegram: {
    botToken: string;
    botUsername: string;
    adminIds: number[];
  };
  database: { url: string };
  redis: { url: string };
  security: {
    credentialsEncryptionKeyHex: string;
    jwtSecret: string;
    jwtExpiresIn: string;
  };
    phoenix: {
      restUrl: string;
      wsUrl: string;
      solanaRpcUrl: string;
      registrationMinSol: number;
  };
  flight: {
    /** Public key only - TradePilot never holds or signs with this account's private key.
     *  Registration and fee withdrawal happen externally via flight.phoenix.trade or the
     *  one-time scripts/register-phoenix-flight-builder.ts admin tool. These are only the
     *  INITIAL values - BuilderConfig in the database is the runtime source of truth once
     *  the bot has booted once (see fee.repository.ts). */
    builderAuthority: string | null;
    /** The distinct on-chain trader account address Phoenix derives for the builder authority
     *  (shown separately on the Flight dashboard, alongside the authority itself). Purely
     *  informational/reference - never required for order routing, which only needs the
     *  authority + PDA/subaccount indices. */
    builderTraderAccount: string | null;
    builderPdaIndex: number;
    builderSubaccountIndex: number;
    builderFeeBps: number;
  };
  defaultExchange: string;
  tradingDefaults: {
    leverage: number;
    slippageBps: number;
    orderType: string;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  logging: { level: string; dir: string };
  queue: { prefix: string };
}

/**
 * Loads and format-validates a Solana PUBLIC key from the given env var
 * name. Intentionally optional at boot: fee collection can stay disabled
 * (BuilderConfig.builderFeeEnabled = false) until this is set, so a
 * missing key never blocks the bot from starting - but a present,
 * malformed one is a real misconfiguration and fails fast rather than
 * silently routing fees nowhere.
 */
function loadOptionalPublicKey(envVarName: string): string | null {
  const value = optionalOrNull(envVarName);
  if (!value) return null;

  const isValidBase58PublicKey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  if (!isValidBase58PublicKey) {
    throw new Error(
      `${envVarName} is set but is not a valid-looking Solana public key. ` +
        'This must be the PUBLIC key only - never a private key or seed phrase.',
    );
  }

  return value;
}

function loadConfig(): AppConfig {
  const adminIdsRaw = optional('TELEGRAM_ADMIN_IDS', '');
  const adminIds = adminIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));

  const credentialsEncryptionKeyHex = required('CREDENTIALS_ENCRYPTION_KEY');
  if (credentialsEncryptionKeyHex.length !== 64) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  return {
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
      botUsername: optional('TELEGRAM_BOT_USERNAME', 'TradePilotBot'),
      adminIds,
    },
    database: { url: required('DATABASE_URL') },
    redis: { url: required('REDIS_URL') },
    security: {
      credentialsEncryptionKeyHex,
      jwtSecret: required('JWT_SECRET'),
      jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),
    },
    phoenix: {
      restUrl: optional('PHOENIX_REST_URL', 'https://perp-api.phoenix.trade'),
      wsUrl: optional('PHOENIX_WS_URL', 'wss://perp-api.phoenix.trade/v1/ws'),
      solanaRpcUrl: optional('PHOENIX_SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
      registrationMinSol: optionalNumber('PHOENIX_REGISTRATION_MIN_SOL', 0.04),
    },
    flight: {
      builderAuthority: loadOptionalPublicKey('TRADEPILOT_BUILDER_AUTHORITY'),
      builderTraderAccount: loadOptionalPublicKey('TRADEPILOT_BUILDER_TRADER_ACCOUNT'),
      builderPdaIndex: optionalNumber('TRADEPILOT_BUILDER_PDA_INDEX', 0),
      builderSubaccountIndex: optionalNumber('TRADEPILOT_BUILDER_SUBACCOUNT_INDEX', 0),
      // Spec default is 5 bps (0.05%); TradePilot's actual configured fee is 8 bps (0.08%).
      builderFeeBps: optionalNumber('TRADEPILOT_BUILDER_FEE_BPS', 8),
    },
    defaultExchange: optional('DEFAULT_EXCHANGE', 'phoenix'),
    tradingDefaults: {
      leverage: optionalNumber('DEFAULT_LEVERAGE', 5),
      slippageBps: optionalNumber('DEFAULT_SLIPPAGE_BPS', 50),
      orderType: optional('DEFAULT_ORDER_TYPE', 'market'),
    },
    rateLimit: {
      windowMs: optionalNumber('RATE_LIMIT_WINDOW_MS', 10_000),
      maxRequests: optionalNumber('RATE_LIMIT_MAX_REQUESTS', 15),
    },
    logging: {
      level: optional('LOG_LEVEL', 'info'),
      dir: optional('LOG_DIR', './logs'),
    },
    queue: { prefix: optional('QUEUE_PREFIX', 'tradepilot') },
  };
}

export const config = loadConfig();
