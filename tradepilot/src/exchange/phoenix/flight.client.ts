import {
  buildTakeProfitStopLossTriggerOrders,
  createPhoenixClient,
  flight,
  MarginType,
  OrderFlags,
  priceUsdToTicksWithMarketParams,
  Side,
} from '@ellipsis-labs/rise';
import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { config } from '../../config/env';
import { withRetry } from '../../utils/retry';

/**
 * Wraps Phoenix's OFFICIAL Rise/Flight SDK (@ellipsis-labs/rise). Every
 * call below was corrected against a real, user-supplied example of the
 * actual SDK usage (given twice, verbatim):
 *
 *   import { Side, createPhoenixClient } from "@ellipsis-labs/rise";
 *   const traderAuthority = "<trader_authority>";
 *   const client = createPhoenixClient({
 *     apiUrl, rpcUrl,
 *     exchangeMetadata: { stream: true },
 *     flight: { builderAuthority, builderPdaIndex: 0, builderSubaccountIndex: 0 },
 *   });
 *   await client.exchange.ready();
 *   const orderPacket = await client.orderPackets.buildLimitOrderPacket({
 *     symbol: "SOL-PERP", side: Side.Bid, priceUsd: "135.87", baseUnits: "0.25",
 *   });
 *   const ix = await client.ixs.buildPlaceLimitOrder({
 *     authority: traderAuthority, symbol: "SOL-PERP", orderPacket,
 *     traderPdaIndex: 0, traderSubaccountIndex: 0,
 *   });
 *
 * IMPORTANT CORRECTION FROM AN EARLIER DRAFT OF THIS FILE: the order-build
 * call is `client.ixs.buildPlaceLimitOrder` (NOT `placeLimitOrder`), and it
 * requires `traderPdaIndex`/`traderSubaccountIndex` in addition to
 * `authority` - these identify the TRADER's own account, separately from
 * the BUILDER's PDA/subaccount configured on the client itself. An earlier
 * version of this file omitted both, which would have either thrown or
 * silently misbehaved. TradePilot gives every user a single trading
 * account, so both default to 0 here - see DEFAULT_TRADER_PDA_INDEX /
 * DEFAULT_TRADER_SUBACCOUNT_INDEX below if that ever needs to change.
 *
 * ONE THING STILL NOT INDEPENDENTLY VERIFIED: the market-order equivalent
 * is assumed to be `client.ixs.buildPlaceMarketOrder` (by symmetry with
 * the confirmed limit-order name above, also taking traderPdaIndex/
 * traderSubaccountIndex) - I have not seen this exact name confirmed the
 * same way. Verify it against the installed package's actual TypeScript
 * types before relying on market orders in production; if it's wrong, the
 * fix is isolated to buildFlightRoutedMarketOrderIx() below.
 *
 * Once a client is constructed WITH a `flight` config, every order
 * instruction built through `client.ixs` is automatically routed through
 * the Flight program with that builder's attribution baked in - there is
 * no separate "routed vs not" flag per order. This is also why builder
 * fees never require a second user-to-builder transfer (acceptance
 * criterion #7): the fee is part of the same routed instruction.
 *
 * Rise returns `@solana/kit`-style instructions. `assembleAndSubmit()`
 * converts them to legacy web3.js instructions because this application
 * signs and sends with `@solana/web3.js`.
 *
 * I also could not find a documented read-only "is this authority
 * registered as a builder" call distinct from checking it as a trader -
 * `verifyBuilderExists()` below is a best-effort check using the
 * trader-state snapshot route, not a Flight-specific registration read.
 * Treat `BuilderConfig.registrationStatus` as informational, not as the
 * sole gate before enabling real fees - always confirm the account on
 * https://flight.phoenix.trade directly too.
 */

const DEFAULT_TRADER_PDA_INDEX = 0;
const DEFAULT_TRADER_SUBACCOUNT_INDEX = 0;

export type PhoenixRiseClient = ReturnType<typeof createPhoenixClient>;

const clientCache = new Map<string, PhoenixRiseClient>();

function cacheKey(builderAuthority: string, pdaIndex: number, subaccountIndex: number, feeBps: number): string {
  return `${builderAuthority}:${pdaIndex}:${subaccountIndex}:${feeBps}`;
}

/**
 * Builds (or reuses) a Rise client configured to route every order through
 * Flight for the given builder authority/PDA/subaccount. A new client is
 * constructed whenever the builder identity changes (e.g. admin points
 * TradePilot at a different registered authority) - Flight routing is
 * baked in at client construction time, not passed per order.
 */
export async function getFlightRoutedClient(params: {
  builderAuthority: string;
  builderPdaIndex: number;
  builderSubaccountIndex: number;
  feeBps: number;
}): Promise<PhoenixRiseClient> {
  const key = cacheKey(params.builderAuthority, params.builderPdaIndex, params.builderSubaccountIndex, params.feeBps);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = createPhoenixClient({
    apiUrl: config.phoenix.restUrl,
    rpcUrl: config.phoenix.solanaRpcUrl,
    exchangeMetadata: { stream: false },
    flight: {
      builderAuthority: params.builderAuthority as never,
      builderPdaIndex: params.builderPdaIndex,
      builderSubaccountIndex: params.builderSubaccountIndex,
      // Use Flight's standard proxy instruction and the builder fee that is
      // registered on-chain. The optional feeBpsOverride selects a different
      // proxy instruction intended only for exceptional per-route pricing;
      // it fails for WTIOIL on the current Phoenix program account layout.
      // The active builder is registered at the same 8 bps rate stored by
      // TradePilot, so no fee behavior changes here.
    },
  });

  await client.exchange.ready();
  clientCache.set(key, client);
  return client;
}

/** A plain (non-Flight-routed) client, for read-only market data when no builder is configured. */
export async function getPlainClient(): Promise<PhoenixRiseClient> {
  const key = 'plain';
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = createPhoenixClient({
    apiUrl: config.phoenix.restUrl,
    rpcUrl: config.phoenix.solanaRpcUrl,
    exchangeMetadata: { stream: false },
  });

  await client.exchange.ready();
  clientCache.set(key, client);
  return client;
}

export interface BuildRoutedOrderParams {
  client: PhoenixRiseClient;
  connection: Connection;
  traderAuthority: string;
  symbol: string;
  side: 'buy' | 'sell';
  baseUnits: string;
  traderPdaIndex?: number;
  traderSubaccountIndex?: number;
  /** IOC orders must either completely fill or fail; this prevents the DB from overstating a partial fill. */
  requireFullFill?: boolean;
  stopLossPrice?: string;
  takeProfitPrice?: string;
  slippageBps?: number;
  /** Closing orders must never open a position in the opposite direction. */
  reduceOnly?: boolean;
}

/** Parameters for Phoenix's server-built isolated-market-order route. */
export interface BuildIsolatedMarketOrderParams {
  client: PhoenixRiseClient;
  traderAuthority: string;
  symbol: string;
  side: 'buy' | 'sell';
  baseUnits: string;
  /** New isolated positions must be funded from the user's cross account. */
  collateralUsd?: number;
  stopLossPrice?: string;
  takeProfitPrice?: string;
  reduceOnly?: boolean;
}

/**
 * Phoenix commodities such as WTIOIL are isolated-only. They cannot be sent
 * to cross subaccount 0, even if that is the user's normal trading account.
 */
export function isIsolatedOnlyMarket(client: PhoenixRiseClient, symbol: string): boolean {
  const market = client.exchange.market(symbol);
  if (!market) throw new Error(`Phoenix market metadata is unavailable for ${symbol}.`);
  return market.isolatedOnly === true;
}

/**
 * Builds the complete isolated-order setup supplied by Phoenix: allocation
 * (and registration when necessary), parent/child synchronisation, collateral
 * transfer, the order itself, and the post-order collateral sweep.  The API
 * route also inherits the Flight configuration from the supplied client.
 */
export async function buildIsolatedMarketOrderIxs(params: BuildIsolatedMarketOrderParams): Promise<unknown[]> {
  const quantity = Number(params.baseUnits);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Isolated market order quantity must be a positive number.');
  }

  let transferAmount: number | undefined;
  if (!params.reduceOnly) {
    if (!Number.isFinite(params.collateralUsd) || (params.collateralUsd ?? 0) <= 0) {
      throw new Error('Collateral is required to open an isolated Phoenix position.');
    }
    // Phoenix collateral is denominated in USDC quote lots (six decimals).
    transferAmount = Math.round((params.collateralUsd ?? 0) * 1_000_000);
    if (!Number.isSafeInteger(transferAmount) || transferAmount <= 0) {
      throw new Error('Isolated position collateral is outside Phoenix\'s supported range.');
    }
  }

  return params.client.api.orders().placeIsolatedMarketOrder({
    authority: params.traderAuthority,
    symbol: params.symbol,
    side: params.side,
    quantity,
    transferAmount,
    pdaIndex: DEFAULT_TRADER_PDA_INDEX,
    isReduceOnly: params.reduceOnly,
    tpSl: params.stopLossPrice || params.takeProfitPrice
      ? {
          stopLossTriggerPrice: params.stopLossPrice ? Number(params.stopLossPrice) : undefined,
          takeProfitTriggerPrice: params.takeProfitPrice ? Number(params.takeProfitPrice) : undefined,
          quantity,
        }
      : undefined,
  });
}

function hasProtectionOrders(params: BuildRoutedOrderParams): boolean {
  return Boolean(params.stopLossPrice || params.takeProfitPrice);
}

async function buildConditionalAccountIxIfMissing(params: BuildRoutedOrderParams): Promise<unknown[]> {
  const traderAccount = await params.client.pda.getTraderAddress({
    authority: params.traderAuthority as never,
    traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
    subaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
  });
  const conditionalOrdersAddress = await params.client.pda.getConditionalOrdersAddress({ traderAccount });
  const account = await params.connection.getAccountInfo(new PublicKey(conditionalOrdersAddress), 'confirmed');
  if (account) return [];

  return [
    await params.client.ixs.buildCreateConditionalOrdersAccount({
      authority: params.traderAuthority as never,
      traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
      traderSubaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
    }),
  ];
}

function buildProtectionTriggers(params: BuildRoutedOrderParams) {
  const market = params.client.exchange.market(params.symbol);
  if (!market) throw new Error(`Phoenix market metadata is unavailable for ${params.symbol}.`);

  return buildTakeProfitStopLossTriggerOrders({
    primarySide: params.side === 'buy' ? Side.Bid : Side.Ask,
    takeProfitPrice: params.takeProfitPrice
      ? priceUsdToTicksWithMarketParams(params.takeProfitPrice, {
          tickSize: market.tickSize,
          baseLotsDecimals: market.baseLotsDecimals,
        })
      : null,
    stopLossPrice: params.stopLossPrice
      ? priceUsdToTicksWithMarketParams(params.stopLossPrice, {
          tickSize: market.tickSize,
          baseLotsDecimals: market.baseLotsDecimals,
        })
      : null,
    slippageBps: params.slippageBps,
  });
}

export async function buildFlightRoutedMarketOrderIx(params: BuildRoutedOrderParams) {
  return withRetry(async () => {
    const orderPacket = await params.client.orderPackets.buildMarketOrderPacket({
      symbol: params.symbol,
      side: params.side === 'buy' ? Side.Bid : Side.Ask,
      baseUnits: params.baseUnits,
      minBaseUnitsToFill: params.requireFullFill ? params.baseUnits : undefined,
      orderFlags: params.reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None,
    });

    // NOTE: buildPlaceMarketOrder is inferred by symmetry with the
    // confirmed buildPlaceLimitOrder name below - see file header.
    return params.client.ixs.buildPlaceMarketOrder({
      authority: params.traderAuthority as never,
      symbol: params.symbol as never,
      orderPacket,
      traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
      traderSubaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
    });
  });
}

/**
 * Builds one atomic market-order transaction with optional native Phoenix TP/SL
 * triggers. The conditional-account creation instruction is included only for
 * a trader that does not already have that account.
 */
export async function buildFlightRoutedMarketOrderWithProtectionsIxs(params: BuildRoutedOrderParams): Promise<unknown[]> {
  const orderIx = await buildFlightRoutedMarketOrderIx(params);
  if (!hasProtectionOrders(params)) return [orderIx];

  const [conditionalAccountIxs, triggers] = await Promise.all([
    buildConditionalAccountIxIfMissing(params),
    Promise.resolve(buildProtectionTriggers(params)),
  ]);
  const protectionIx = await params.client.ixs.buildPlacePositionConditionalOrder({
    authority: params.traderAuthority as never,
    symbol: params.symbol as never,
    greaterTriggerOrder: triggers.greaterTriggerOrder,
    lessTriggerOrder: triggers.lessTriggerOrder,
    // 100% makes the trigger reduce the actual position at trigger time,
    // including a position that was only partially filled before the trigger.
    sizePercent: 100,
    traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
    traderSubaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
  });
  return [...conditionalAccountIxs, orderIx, protectionIx];
}

export async function buildFlightRoutedLimitOrderIx(
  params: BuildRoutedOrderParams & { priceUsd: string },
) {
  return withRetry(async () => {
    const orderPacket = await params.client.orderPackets.buildLimitOrderPacket({
      symbol: params.symbol,
      side: params.side === 'buy' ? Side.Bid : Side.Ask,
      priceUsd: params.priceUsd,
      baseUnits: params.baseUnits,
    });

    return params.client.ixs.buildPlaceLimitOrder({
      authority: params.traderAuthority as never,
      symbol: params.symbol as never,
      orderPacket,
      traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
      traderSubaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
    });
  });
}

/** Places a resting limit order with Phoenix-native, attached TP/SL children. */
export async function buildFlightRoutedLimitOrderWithProtectionsIxs(
  params: BuildRoutedOrderParams & { priceUsd: string },
): Promise<unknown[]> {
  if (!hasProtectionOrders(params)) return [await buildFlightRoutedLimitOrderIx(params)];

  const orderPacket = await params.client.orderPackets.buildLimitOrderPacket({
    symbol: params.symbol,
    side: params.side === 'buy' ? Side.Bid : Side.Ask,
    priceUsd: params.priceUsd,
    baseUnits: params.baseUnits,
  });
  const [conditionalAccountIxs, triggers] = await Promise.all([
    buildConditionalAccountIxIfMissing(params),
    Promise.resolve(buildProtectionTriggers(params)),
  ]);
  const limitWithProtectionsIx = await params.client.ixs.buildPlaceLimitOrderWithConditionals({
    authority: params.traderAuthority as never,
    symbol: params.symbol as never,
    orderPacket: { __kind: 'Limit', ...orderPacket } as never,
    greaterTriggerOrder: triggers.greaterTriggerOrder,
    lessTriggerOrder: triggers.lessTriggerOrder,
    traderPdaIndex: params.traderPdaIndex ?? DEFAULT_TRADER_PDA_INDEX,
    traderSubaccountIndex: params.traderSubaccountIndex ?? DEFAULT_TRADER_SUBACCOUNT_INDEX,
  });
  return [...conditionalAccountIxs, limitWithProtectionsIx];
}

/**
 * Same order-building calls as above, but against a plain (non-Flight)
 * client - used when builder fees are administratively disabled per
 * spec section 17 case B ("route trades without the builder fee only if
 * the admin explicitly enabled that behavior"). Trades still execute
 * normally on Phoenix; there's just no builder attribution/fee on them.
 */
export async function buildPlainMarketOrderIx(params: Omit<BuildRoutedOrderParams, 'client'>) {
  const client = await getPlainClient();
  return buildFlightRoutedMarketOrderIx({ ...params, client });
}

export async function buildPlainMarketOrderWithProtectionsIxs(params: Omit<BuildRoutedOrderParams, 'client'>) {
  const client = await getPlainClient();
  return buildFlightRoutedMarketOrderWithProtectionsIxs({ ...params, client });
}

export async function buildPlainLimitOrderIx(
  params: Omit<BuildRoutedOrderParams, 'client'> & { priceUsd: string },
) {
  const client = await getPlainClient();
  return buildFlightRoutedLimitOrderIx({ ...params, client });
}

export async function buildPlainLimitOrderWithProtectionsIxs(
  params: Omit<BuildRoutedOrderParams, 'client'> & { priceUsd: string },
) {
  const client = await getPlainClient();
  return buildFlightRoutedLimitOrderWithProtectionsIxs({ ...params, client });
}

interface SolanaKitInstruction {
  programAddress: string;
  accounts: ReadonlyArray<{ address: string; role: number }>;
  data: Uint8Array;
}

/** Converts the Rise SDK's Solana Kit instruction shape for web3.js v1 transactions. */
export function toWeb3Instruction(instruction: SolanaKitInstruction): TransactionInstruction {
  if (!instruction?.programAddress) {
    throw new Error('Phoenix returned an instruction without a program address.');
  }

  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      // Solana Kit encodes signer/writable as bit flags: 2 and 1 respectively.
      isSigner: (account.role & 0b10) !== 0,
      isWritable: (account.role & 0b01) !== 0,
    })),
    data: Buffer.from(instruction.data),
  });
}

/**
 * Assembles the built instruction(s) into a transaction, signs with the
 * TRADER's own keypair (self-custodial - see WalletKeyService), submits,
 * and waits for confirmation via the trader's own connection. This client
 * never touches a builder private key, and only ever signs with the
 * trader's key for the trader's own trade.
 */
export async function assembleAndSubmit(params: {
  connection: Connection;
  traderKeypair: Keypair;
  instructions: unknown[];
}): Promise<string> {
  return withRetry(async () => {
    const tx = new Transaction();
    // Flight-wrapped orders may settle funding and perform several CPIs. The
    // Solana default (200k units) is insufficient for those valid closes.
    // This only raises the execution ceiling; no priority fee is requested.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    for (const ix of params.instructions) {
      tx.add(toWeb3Instruction(ix as SolanaKitInstruction));
    }

    const signature = await sendAndConfirmTransaction(params.connection, tx, [params.traderKeypair], {
      commitment: 'confirmed',
    });

    return signature;
  });
}

export interface BuilderStatusResult {
  registered: boolean;
}

/**
 * Best-effort registration check (see file header) - confirms the builder
 * authority exists as a registered Phoenix trader account. This is NOT a
 * confirmed Flight-specific "is this a registered builder" read.
 */
export async function verifyBuilderExists(builderAuthority: string): Promise<BuilderStatusResult> {
  try {
    const client = await getPlainClient();
    const snapshot = await client.api
      .traders()
      .getTraderStateSnapshot(builderAuthority, { traderPdaIndex: 0 });
    return { registered: Boolean(snapshot) };
  } catch {
    return { registered: false };
  }
}

export { Side, MarginType, flight, PublicKey };
