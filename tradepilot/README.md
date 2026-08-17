# TradePilot

A Telegram-native perpetual trading platform. Phoenix Perps (Solana) is the first exchange
integration; the exchange layer is built so Hyperliquid, Drift, or Jupiter Perps can be added
without touching anything outside `src/exchange/`.

---

## Read this first: scope and honesty notes

This is a large platform. Everything listed below is **fully implemented, real, runnable code**
— but a few things are worth knowing before you point it at real funds:

1. **Phoenix endpoint paths are best-effort, not verified against a private route table.**
   Phoenix's public docs (`docs.phoenix.trade/api`) describe endpoint *categories* (Auth,
   Exchange, Invite, Trader) under the verified base URL `https://perp-api.phoenix.trade`, but
   I could not pull their exact per-route paths and payload shapes. Every path lives in one
   place — `src/exchange/phoenix/phoenix.rest-client.ts` (`PHOENIX_ENDPOINTS`) — confirm each
   one against Phoenix's live reference before routing real funds through this adapter.
2. **Self-custodial, bot-signed trading.** Like most instant-execution Telegram trading bots,
   TradePilot holds an encrypted copy of each user's Solana signing key (AES-256-GCM, same
   pattern used for the standalone pump.fun bot) so it can sign and submit transactions the
   instant someone taps "Confirm" — no external wallet app round-trip. Users can generate a
   fresh bot-managed wallet or import one they already control.
3. **Not a custodial brokerage.** Phoenix Perps settles on-chain; positions live in the user's
   own wallet, not in a TradePilot-controlled pool. That said, running this for other people —
   especially with the referral/rewards program switched on — carries real compliance
   obligations (geographic restrictions, KYC decisions, referral-fee handling) that are on you
   to work out before going live. This isn't legal advice, just a flag.
4. **Scope cuts, clearly labeled:**
   - i18n: `language`/`timezone` are stored per-user but no translation layer exists yet —
     all bot copy is English.
   - The admin panel covers stats, revenue (7-day volume), broadcast, and the four trading
     modes — it does not include a full audit-log viewer UI (the data is all in
     `AdminAuditLog`/`LogEntry`, queryable directly or easy to add a `/logs` command for).
   - WebSocket streaming (`PhoenixWebSocketAdapter`) has real reconnect/backoff/heartbeat
     logic and is ready to wire into live position/PnL push updates in Telegram, but the bot
     layer currently polls REST on-demand (`/positions`, `/balance`) rather than pushing
     unsolicited updates — wiring `realtime.subscribeAccount` to a notification is a
     small, contained addition on top of what's here.
   - **Limit-order cancellation is not implemented.** `/trade` supports placing limit orders,
     but there's currently no way to cancel a resting one. I could not find a confirmed
     `@ellipsis-labs/rise` cancel-order method in what I verified from Phoenix's docs (only
     `placeLimitOrder`/`placeMarketOrder`/registration calls) - rather than invent one, this is
     left as a known gap. Add it to `flight.client.ts` once you've confirmed the real method
     name against the SDK's actual TypeScript types.

Nothing here is a stub pretending to be finished — these are genuine, deliberate scope
boundaries on a platform this size, called out explicitly instead of silently glossed over.

---

## Architecture


src/
├── config/env.ts              # Environment loading & validation
├── constants/                 # Shared constants
├── types/                     # Domain + bot types
├── database/                  # Prisma + Redis clients
├── logger/                    # Pino file logger + DB-backed structured logs
├── utils/                     # Retry, encryption, formatting
├── middlewares/                # Error boundary, identity, rate limit, maintenance gate, admin guard
├── exchange/
│   ├── interfaces/            # ExchangeAdapter + Wallet/Market/Position/Order/Trading/Realtime adapters
│   ├── phoenix/                # Phoenix implementation of every interface above
│   ├── exchange.registry.ts   # The ONLY place a concrete exchange is instantiated
│   └── wallet-key.service.ts  # Encrypted bot-signing key management (exchange-agnostic)
├── users/                     # Registration, onboarding, exchange-account linking
├── settings/                  # Per-user trading defaults
├── referrals/                 # Referral codes, reward crediting, leaderboard
├── trading/                   # TradingService (open/close/closeAll), market/balance queries
├── notifications/             # Notification persistence + BullMQ enqueue
├── queues/                    # BullMQ queue definition + delivery worker (run separately)
├── admin/                     # Platform stats, trading-mode control, audit log
└── bot/
    ├── bot.ts                  # Telegraf wiring: middleware order, commands, actions
    ├── session.ts, keyboards.ts
    ├── scenes/                 # Onboarding, link-account, trade, close-position, settings, broadcast
    └── commands/                # start, positions, balance, markets, referral, settings, history, admin


### Exchange adapter pattern

Nothing outside `exchange/interfaces/` and `exchange/phoenix/` imports a concrete exchange
module. Every call site (bot commands, `TradingService`, `MarketQueryService`) goes through
`exchangeRegistry.get(exchangeKey)` and only ever touches the `ExchangeAdapter` interface.

To add a new exchange (Hyperliquid, Drift, Jupiter Perps):
1. Create `src/exchange/<name>/` implementing `WalletAdapter`, `MarketAdapter`,
   `PositionAdapter`, `OrderAdapter`, `TradingAdapter`, and optionally `RealtimeAdapter`.
2. Compose them into one object satisfying `ExchangeAdapter` (see `phoenix.adapter.ts`).
3. Register it: one line in `exchange.registry.ts`'s `factories` map.

No other file changes.

### Telegram flow

**Onboarding:** `/start` → register (referral code captured from deep-link payload) → accept
terms → link Phoenix account (generate or import wallet) → active.

**Trade:** market → long/short → collateral (USD) → leverage → order type → optional
limit price → optional SL → optional TP → confirm → execute.

**Close:** shows open positions → pick market → 25/50/75/100%/custom → confirm → execute.

**Admin** (`/admin`, restricted to `TELEGRAM_ADMIN_IDS`): stats, broadcast, and the four
trading modes (Normal / Read-Only / Maintenance / Emergency Stop). Emergency Stop and
Read-Only block **new** trades (enforced in `TradingService.open`, not just at the bot layer,
so it can't be bypassed) while still allowing users to close existing positions to manage risk.
Maintenance mode blocks everything, including reads.

### Security

- Bot-signing keys: AES-256-GCM at rest, decrypted only in-memory to sign a specific
  transaction (`WalletKeyService`).
- Rate limiting: Redis-backed fixed-window limiter, per Telegram user ID.
- Idempotency: every order carries a unique `idempotencyKey`; `TradingService.open` checks
  for an existing order with that key before submitting, so retries/duplicate taps can't
  double-execute a trade.
- Admin commands: gated by `TELEGRAM_ADMIN_IDS`, every admin action recorded to
  `AdminAuditLog`.

---

## Environment variables

See `.env.example` for the full list with descriptions. The two you must generate yourself:

```bash



CREDENTIALS_ENCRYPTION_KEY and JWT_SECRET

node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"


## Database

```bash
npm run prisma:migrate   # creates the schema in your Postgres instance

Running

npm run dev       # the bot itself
npm run worker     # separately: the notification-delivery worker (requires Redis)

Phoenix Flight builder fees

TradePilot charges its own platform fee (default 8 bps / 0.08%) on trades, additive on top
of Phoenix's own trading fee, using Phoenix's official Flight/Rise builder-fee mechanism
(@ellipsis-labs/rise). See src/exchange/phoenix/flight.client.ts for the full technical
notes on what's independently verified vs. best-effort.

Setup:





Register a builder authority - either through

flight.phoenix.trade directly with your own wallet, or via
 npm run register-builder -- --keypair ./builder-keypair.json --fee-bps 8 (see the script's
 header comment for full usage; the signer file must never be committed or placed in .env).



Set TRADEPILOT_BUILDER_AUTHORITY in .env to that account's public key.



Restart the bot. /admin builder confirms registration status.

Admin commands: /admin fees, /admin fees on, /admin fees off, /admin builder,
/admin revenue, /admin setbuilderfee <bps>.

Design notes worth knowing:





The database (BuilderConfig) is the runtime source of truth for the fee rate after first
boot - .env only seeds the initial value. Changing the fee via /admin setbuilderfee does
not touch anything on-chain; it only changes what TradePilot calculates and displays as
"expected." Whether Phoenix's Flight program itself supports updating a fee on an
already-registered builder (vs. requiring re-registration) is not something I could
independently confirm - verify this before assuming a DB-level change alone changes what's
actually charged on-chain.



Every FeeEvent snapshots the builder authority/PDA/subaccount/fee-bps at the moment of the
trade, so a later admin change never rewrites fee history.



confirmedFeeUsd is recorded as equal to the expected amount once the routed transaction
confirms on-chain - there's no independently verified way to read back the exact amount
Phoenix's program actually deducted. If you find that API, wire the comparison into
reconcile() and flag mismatches rather than trusting either number blindly.



Withdrawal is entirely Phoenix's mechanism, not TradePilot's - /admin builder links to
flight.phoenix.trade rather than fabricating a withdrawal endpoint.

Production validation checklist

Run through this in order before enabling public trading with real funds. None of this is
automated - each step requires a live action and a human looking at the result.





npm test - all automated tests pass (uses mocks only, never real funds).



Register the Flight builder (see Setup above) and confirm /admin builder shows

REGISTERED.



Confirm the fee is set to 8 bps: /admin fees.



Execute one very small real test trade (smallest size Phoenix allows).



Confirm the trade transaction on-chain via a Solana explorer.



Confirm Phoenix's own trading fee was charged as expected (check the transaction's parsed

instructions/balance changes).



Confirm TradePilot's builder fee was charged as part of the same transaction - it should

not be a second, separate transaction.



Check /admin builder - the builder account's balance should reflect the new fee.



Confirm that fee shows up in Phoenix's own Flight interface

(flight.phoenix.trade) under your builder account, not just in TradePilot's database.



Do a real (small) withdrawal through Phoenix's official Flight withdrawal flow - confirm the

funds actually arrive in your wallet.



Only after all ten steps check out, flip real users on.

Tech stack

TypeScript, Node.js, Telegraf, PostgreSQL, Prisma ORM, Redis, BullMQ, Axios, ws, Pino, Zod,
@solana/web3.js, @ellipsis-labs/rise, Vitest.
