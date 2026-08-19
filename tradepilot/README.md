# TradePilot

TradePilot is a Telegram-native perpetual futures trading platform. Phoenix Perps on Solana
is the first supported exchange. The exchange layer is adapter-based so additional venues can
be integrated without changing the bot or core trading workflows.

## Features

- Telegram onboarding, account linking, funding, withdrawal, and trading workflows
- Market and limit orders with optional stop-loss and take-profit protection
- Cross and isolated margin support, subject to Phoenix market capabilities
- Position management, partial closes, close-all, trade history, and PnL cards
- User-configurable leverage, slippage, order type, margin mode, and collateral defaults
- Phoenix Flight builder-fee routing and fee-event reconciliation
- Referral attribution and reward accounting
- Redis-backed rate limiting and BullMQ notification delivery
- Administrative trading modes, broadcasts, statistics, and audit logging

## Architecture

```text
src/
|-- admin/                     Platform controls, statistics, and audit logging
|-- bot/                       Telegraf commands, scenes, keyboards, and sessions
|-- config/                    Environment configuration
|-- constants/                 Shared constants
|-- database/                  Prisma and Redis clients
|-- exchange/
|   |-- interfaces/            Exchange capability contracts
|   |-- phoenix/               Phoenix REST, WebSocket, wallet, and execution adapters
|   |-- exchange.registry.ts   Exchange factory registry
|   `-- wallet-key.service.ts  Encrypted signing-key access
|-- fees/                      Builder-fee configuration and event tracking
|-- logger/                    Structured application logging
|-- middlewares/               Identity, rate limit, maintenance, admin, and error handling
|-- notifications/             Notification persistence
|-- pnl/                       PnL card generation
|-- queues/                    Background notification processing
|-- referrals/                 Referral codes and rewards
|-- settings/                  User trading preferences
|-- trading/                   Order orchestration and market queries
|-- types/                     Shared domain types
|-- users/                     User and exchange-account management
`-- validators/                Input validation
```

### Exchange adapters

Exchange integrations implement the contracts in `src/exchange/interfaces/` and are composed
into an `ExchangeAdapter`. Concrete adapters are created only by `exchange.registry.ts`.
Trading and bot services resolve exchanges through the registry and do not depend directly on
a venue-specific implementation.

A new exchange integration requires:

1. Implementing the wallet, market, position, order, and trading adapter contracts.
2. Composing the implementations into an `ExchangeAdapter`.
3. Registering the adapter factory in `exchange.registry.ts`.

## Trading workflow

The `/trade` wizard collects the market, side, collateral, leverage, order type, limit price
when applicable, and optional stop-loss and take-profit prices before displaying a final
confirmation.

Market orders are submitted as full-fill IOC orders. A confirmed market entry is persisted as
a filled order, position, and trade. Stop-loss and take-profit protection is submitted in the
same transaction and stored against the local position.

Limit orders are submitted as resting Phoenix orders and remain `SUBMITTED` locally until an
exchange fill is observed. When protection prices are supplied, Phoenix conditionals are
attached atomically to the limit order. A confirmed placement does not create a local position
or trade because it does not prove that the entry has filled.

Protection rules are validated against the expected entry price:

- Long positions require stop loss below entry and take profit above entry.
- Short positions require stop loss above entry and take profit below entry.

## Requirements

- Node.js 18 or later
- PostgreSQL
- Redis
- A Telegram bot token
- A Solana RPC endpoint
- Phoenix credentials and a funded wallet for live trading

## Installation

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:deploy
```

Generate independent secrets for `CREDENTIALS_ENCRYPTION_KEY` and `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`CREDENTIALS_ENCRYPTION_KEY` must be exactly 32 bytes represented as 64 hexadecimal
characters. Secrets and wallet keypair files must not be committed to source control.

## Configuration

The base environment template is available in `.env.example`. The primary settings are:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot authentication token |
| `TELEGRAM_ADMIN_IDS` | Comma-separated Telegram user IDs with admin access |
| `TELEGRAM_BOT_USERNAME` | Bot username used in referral links |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `CREDENTIALS_ENCRYPTION_KEY` | AES-256-GCM key for stored wallet credentials |
| `JWT_SECRET` | Internal session-token signing secret |
| `PHOENIX_REST_URL` | Phoenix REST API base URL |
| `PHOENIX_WS_URL` | Phoenix WebSocket endpoint |
| `PHOENIX_SOLANA_RPC_URL` | Solana RPC endpoint used for Phoenix transactions |
| `DEFAULT_EXCHANGE` | Default exchange adapter key |
| `DEFAULT_LEVERAGE` | Initial leverage preference |
| `DEFAULT_SLIPPAGE_BPS` | Initial slippage tolerance in basis points |
| `DEFAULT_ORDER_TYPE` | Initial order type preference |
| `LOG_LEVEL` | Application log level |
| `LOG_DIR` | Log output directory |

Phoenix Flight configuration is read from `TRADEPILOT_BUILDER_AUTHORITY`,
`TRADEPILOT_BUILDER_TRADER_ACCOUNT`, `TRADEPILOT_BUILDER_PDA_INDEX`,
`TRADEPILOT_BUILDER_SUBACCOUNT_INDEX`, and `TRADEPILOT_BUILDER_FEE_BPS`. Environment values
seed the database on first boot; `BuilderConfig` is the runtime source of truth afterward.

## Running the application

Start the bot in development mode:

```bash
npm run dev
```

Run the notification worker in a separate process:

```bash
npm run worker
```

Production builds use:

```bash
npm run build
npm start
```

## Bot commands

| Command | Description |
| --- | --- |
| `/trade` | Open the trade wizard |
| `/positions` | Display open positions |
| `/close` | Close part or all of a position |
| `/closeall` | Close every open position |
| `/balance` | Display Phoenix balances |
| `/fund` | Fund the linked Phoenix account |
| `/withdraw` | Withdraw through Phoenix |
| `/markets` | Browse supported markets |
| `/history` | Display recent trade history |
| `/pnl` | Generate a PnL summary card |
| `/settings` | Manage trading preferences and wallet options |
| `/link` | Link or create a Phoenix wallet |
| `/cancel` | Exit the active Telegram wizard |
| `/admin` | Open the administrator panel |

The `/cancel` command exits a bot conversation. It does not cancel a resting exchange order.

## Trading modes

Administrators can set one of four platform modes:

- `NORMAL`: all supported operations are available.
- `READ_ONLY`: new entries are blocked; risk-reducing closes remain available.
- `MAINTENANCE`: trading and user-facing reads are blocked.
- `EMERGENCY_STOP`: new entries are blocked; position closes remain available.

Entry restrictions are enforced by `TradingService`, not only by the Telegram interface.

## Phoenix Flight builder fees

TradePilot supports Phoenix Flight builder-fee routing through `@ellipsis-labs/rise`. The
configured builder fee is additive to Phoenix trading fees. Each `FeeEvent` stores an immutable
snapshot of the builder authority, PDA indices, fee rate, expected amount, and associated order.

A builder can be registered through the Phoenix Flight interface or with the bundled script:

```bash
npm run register-builder -- --keypair ./builder-keypair.json --fee-bps 8
```

The registration keypair is an administrative signer and must be stored outside the repository.
The application requires only the builder public configuration during normal operation.

Available administrative fee commands include `/fees`, `/builder`, `/revenue`, and
`/setbuilderfee <bps>`.

`confirmedFeeUsd` currently records the expected fee after the routed market transaction is
confirmed. Exact builder-fee reconciliation from transaction account deltas is not implemented.
Limit-order fee events remain pending until the corresponding fill can be synchronized.

## Security

- Wallet signing keys are encrypted at rest with AES-256-GCM.
- Decrypted keys are held in memory only while signing a transaction.
- Idempotency keys prevent duplicate order submission during retries.
- Telegram admin commands are restricted by numeric user ID.
- Administrative changes are written to the audit log.
- User-level rate limiting is enforced through Redis.
- Trading-mode and builder-fee consistency gates are enforced in the service layer.

TradePilot signs transactions on behalf of users from bot-managed or imported wallets. This
deployment model requires production-grade secret management, restricted database access,
encrypted backups, and a documented key-rotation process.

## Current limitations

- Resting limit orders cannot currently be cancelled through the bot.
- Limit-order fills are not synchronized into local positions, trades, protection records, or
  fee confirmations.
- SL/TP conditionals attached to resting limit orders are active on Phoenix but are not displayed
  locally before fill synchronization.
- WebSocket account subscriptions are implemented at the adapter layer but are not connected to
  proactive Telegram position and PnL notifications.
- Language and timezone preferences are stored, but bot messages are currently English only.
- The administrator interface does not include an audit-log browser.
- Phoenix endpoint compatibility and real-fund flows must be validated against the target Phoenix
  environment before production deployment.

## Verification

Run the automated checks with:

```bash
npm test
npm run build
npm run lint
```

Automated tests use mocks and do not submit real transactions. Production readiness additionally
requires controlled live validation with the minimum supported order size. Validation should
cover market entry, resting limit placement, long and short SL/TP triggers, partial close,
close-all, Flight fee attribution, balance reconciliation, funding, withdrawal, and recovery
from rejected or expired transactions.

## Technology

TypeScript, Node.js, Telegraf, PostgreSQL, Prisma, Redis, BullMQ, Axios, WebSocket, Pino, Zod,
Solana Web3.js, Phoenix Rise SDK, and Vitest.
