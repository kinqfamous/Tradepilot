<div align="center">
  <img src="assets/tradepilot-logo.jpg" alt="TradePilot logo" width="180" />

  # TradePilot

  **Trade perpetual futures without leaving Telegram.**

  TradePilot brings account access, order entry, position management, and performance tracking
  into one conversational trading experience. Phoenix Perps on Solana is the first supported
  market.
</div>

> [!WARNING]
> TradePilot is under active development. Trading perpetual futures involves substantial risk,
> including the possible loss of all deposited funds. Review the code and test your deployment
> carefully before using real assets.

## Why TradePilot?

Trading should not require keeping a complex dashboard open all day. TradePilot turns common
trading actions into focused Telegram flows, making it easier to monitor markets and respond from
any device.

- **Trade from Telegram** — open market or limit orders through a guided conversation.
- **Manage risk** — configure leverage, margin preferences, stop loss, and take profit.
- **Stay on top of positions** — view balances, open positions, trade history, and PnL summaries.
- **Move funds when needed** — access funding and withdrawal flows from the bot.
- **Share your performance** — generate visual PnL cards directly in Telegram.
- **Built for operators** — includes administrative controls, usage statistics, broadcasts, and
  audit logging.
- **Designed to grow** — starts with Phoenix Perps while leaving room for additional exchanges.

## What you can do

| Experience | Included capabilities |
| --- | --- |
| Trading | Market and limit orders, long and short positions, partial closes, and close-all |
| Risk controls | Stop loss, take profit, leverage, slippage, and margin preferences |
| Portfolio | Balances, positions, history, and PnL cards |
| Accounts | Telegram onboarding, wallet linking, funding, and withdrawals |
| Community | Referral attribution and reward tracking |
| Operations | Maintenance controls, emergency controls, broadcasts, statistics, and audit logs |

## Getting started

TradePilot currently requires Node.js 18+, PostgreSQL, Redis, a Telegram bot token, a Solana RPC
endpoint, and access to Phoenix Perps.

```bash
git clone <your-fork-or-repository-url>
cd tradepilot
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:deploy
```

Add your credentials and deployment settings to `.env`, then start the bot:

```bash
npm run dev
```

The normal bot process also starts notification delivery and Phoenix fill reconciliation, so TP,
SL, liquidation, and limit-fill cards work without a second command.

For a production build:

```bash
npm run build
npm start
```

The production build creates ESM bundles at `dist/index.mjs` and `dist/worker.mjs`. `npm start`
already includes the worker. The standalone worker command is available only for deployments that
intentionally run background processing without the bot process:

```bash
npm run start:worker
```

Do not run the standalone worker alongside the default bot process. Start the selected process with
the project directory as its working directory so `.env` and runtime assets can be resolved.
Production deployments must include `assets/`, `prisma/migrations/`, and
installed production dependencies alongside `dist/`.

Never commit `.env`, wallet keypairs, signing keys, or other secrets. Use a dedicated secret
manager and restricted infrastructure for production deployments.

## Bot commands

| Command | What it does |
| --- | --- |
| `/trade` | Start a guided trade |
| `/positions` | View open positions |
| `/close` | Partially or fully close a position |
| `/closeall` | Close all open positions |
| `/balance` | View account balances |
| `/fund` | Fund the connected account |
| `/withdraw` | Withdraw funds |
| `/markets` | Browse available markets |
| `/history` | View recent trading activity |
| `/pnl` | Create a PnL summary card |
| `/settings` | Update trading and account preferences |
| `/link` | Link or create a wallet |
| `/cancel` | Leave the current conversation |

## Project status

TradePilot is an early-stage project and is not yet a finished, audited trading product. Some
exchange events and advanced order-management experiences are still being expanded. Before a
production launch, validate every supported flow with controlled funds and the smallest practical
order size.

## Security

TradePilot can sign transactions for bot-managed or imported wallets. Anyone operating an
instance is responsible for protecting user funds and deployment secrets.

Production deployments should use strong secret management, restricted database access,
encrypted backups, monitoring, incident-response procedures, and a documented key-rotation
process. An independent security review is strongly recommended before handling public funds.

If you discover a security issue, please report it privately to the project maintainers instead
of opening a public issue.

## Development

Before submitting a change, run:

```bash
npm test
npm run build
npm run lint
```

Automated tests do not submit real transactions. Changes that affect trading or account access
should also be validated in a controlled environment.

## Contributing

Issues, bug reports, and focused pull requests are welcome. Please describe the problem being
solved, keep changes scoped, include tests where practical, and avoid including credentials or
real account data in examples and logs.

## Built with

TypeScript, Node.js, Telegraf, PostgreSQL, Prisma, Redis, BullMQ, Solana Web3.js, and Phoenix Rise.

## Disclaimer

TradePilot is software, not financial advice. No contributor or operator guarantees execution,
availability, profitability, or protection from loss. You are responsible for reviewing the
software, complying with applicable laws, and understanding the risks before trading.
