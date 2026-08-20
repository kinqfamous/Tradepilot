import { Connection, Keypair } from '@solana/web3.js';
import * as flightClient from './flight.client';
import { builderFeeService as defaultBuilderFeeService, BuilderFeeService } from '../../fees/builder-fee.service';
import { log } from '../../logger/logger';
import { MarginMode } from '../../types/exchange.types';

export interface ExecuteOrderParams {
  connection: Connection;
  traderKeypair: Keypair;
  userId: number;
  orderId?: number;
  symbol: string;
  side: 'buy' | 'sell';
  baseUnits: string;
  notionalUsd: number;
  /** Collateral to fund a new isolated-only market such as WTIOIL. */
  collateralUsd?: number;
  /** User-selected mode; Phoenix isolated-only markets override this to ISOLATED. */
  marginMode?: MarginMode;
  idempotencyKey: string;
  type: 'market' | 'limit';
  priceUsd?: string; // required for type: 'limit'
  stopLossPrice?: string;
  takeProfitPrice?: string;
  slippageBps?: number;
  reduceOnly?: boolean;
}

export interface ExecuteOrderResult {
  success: boolean;
  signature?: string;
  errorMessage?: string;
  feeEventId?: number;
  /** A market IOC is settled on confirmation; a limit transaction only places a resting order. */
  settled: boolean;
}

/** The Flight order-building/submission calls this service depends on - injectable so tests never touch Solana or the network. */
export interface FlightOrderExecutor {
  getFlightRoutedClient: typeof flightClient.getFlightRoutedClient;
  getPlainClient: typeof flightClient.getPlainClient;
  isIsolatedOnlyMarket: typeof flightClient.isIsolatedOnlyMarket;
  buildIsolatedMarketOrderIxs: typeof flightClient.buildIsolatedMarketOrderIxs;
  buildIsolatedLimitOrderIxs: typeof flightClient.buildIsolatedLimitOrderIxs;
  buildFlightRoutedMarketOrderIx: typeof flightClient.buildFlightRoutedMarketOrderIx;
  buildFlightRoutedMarketOrderWithProtectionsIxs?: typeof flightClient.buildFlightRoutedMarketOrderWithProtectionsIxs;
  buildFlightRoutedLimitOrderIx: typeof flightClient.buildFlightRoutedLimitOrderIx;
  buildFlightRoutedLimitOrderWithProtectionsIxs?: typeof flightClient.buildFlightRoutedLimitOrderWithProtectionsIxs;
  buildPlainMarketOrderIx: typeof flightClient.buildPlainMarketOrderIx;
  buildPlainMarketOrderWithProtectionsIxs?: typeof flightClient.buildPlainMarketOrderWithProtectionsIxs;
  buildPlainLimitOrderIx: typeof flightClient.buildPlainLimitOrderIx;
  buildPlainLimitOrderWithProtectionsIxs?: typeof flightClient.buildPlainLimitOrderWithProtectionsIxs;
  assembleAndSubmit: typeof flightClient.assembleAndSubmit;
}

const defaultExecutor: FlightOrderExecutor = {
  getFlightRoutedClient: flightClient.getFlightRoutedClient,
  getPlainClient: flightClient.getPlainClient,
  isIsolatedOnlyMarket: flightClient.isIsolatedOnlyMarket,
  buildIsolatedMarketOrderIxs: flightClient.buildIsolatedMarketOrderIxs,
  buildIsolatedLimitOrderIxs: flightClient.buildIsolatedLimitOrderIxs,
  buildFlightRoutedMarketOrderIx: flightClient.buildFlightRoutedMarketOrderIx,
  buildFlightRoutedMarketOrderWithProtectionsIxs: flightClient.buildFlightRoutedMarketOrderWithProtectionsIxs,
  buildFlightRoutedLimitOrderIx: flightClient.buildFlightRoutedLimitOrderIx,
  buildFlightRoutedLimitOrderWithProtectionsIxs: flightClient.buildFlightRoutedLimitOrderWithProtectionsIxs,
  buildPlainMarketOrderIx: flightClient.buildPlainMarketOrderIx,
  buildPlainMarketOrderWithProtectionsIxs: flightClient.buildPlainMarketOrderWithProtectionsIxs,
  buildPlainLimitOrderIx: flightClient.buildPlainLimitOrderIx,
  buildPlainLimitOrderWithProtectionsIxs: flightClient.buildPlainLimitOrderWithProtectionsIxs,
  assembleAndSubmit: flightClient.assembleAndSubmit,
};

/**
 * The single place trades actually get built, signed, and submitted for
 * Phoenix (sections 6 & 9 of the Flight builder-fee spec). Whether a trade
 * is routed through Flight (with a builder fee attached) or executes
 * plainly depends entirely on BuilderConfig at the moment of execution -
 * callers never decide this themselves.
 *
 * Both dependencies are constructor-injected (defaulting to the real
 * singleton service and the real Rise SDK calls) so this can be unit
 * tested with plain in-memory fakes - see
 * phoenix-flight-execution.service.test.ts.
 */
export class PhoenixFlightExecutionService {
  constructor(
    private readonly feeService: Pick<
      BuilderFeeService,
      'canTradeWithFee' | 'recordExpectedFee' | 'markPending' | 'confirmFee' | 'failFee' | 'getConfig'
    > = defaultBuilderFeeService,
    private readonly executor: FlightOrderExecutor = defaultExecutor,
  ) {}

  async executeOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
    if (params.type === 'limit' && !params.priceUsd) {
      return { success: false, errorMessage: 'priceUsd is required for limit orders.', settled: false };
    }

    // Emergency-stop / consistency gate (spec section 17) - checked fresh
    // on every order, not cached, so an admin flipping fees mid-session
    // takes effect on the very next trade.
    const tradeGate = await this.feeService.canTradeWithFee();
    if (!tradeGate.allowed) {
      await log.warn('TRADE', 'Trade blocked by builder-fee consistency gate', {
        userId: params.userId,
        reason: tradeGate.reason,
      });
      return { success: false, errorMessage: tradeGate.reason, settled: false };
    }

    // Record EXPECTED fee before anything touches the chain - this also
    // gives us idempotency: a retried call with the same idempotencyKey
    // returns the existing record instead of double-charging.
    const feeEvent = await this.feeService.recordExpectedFee({
      userId: params.userId,
      orderId: params.orderId,
      market: params.symbol,
      notionalUsd: params.notionalUsd,
      idempotencyKey: params.idempotencyKey,
    });

    // Route from the immutable FeeEvent snapshot, rather than reading mutable
    // admin configuration a second time. This prevents a fee record from
    // describing a different builder or rate than the submitted transaction.
    const routeThroughFlight = feeEvent.feeBps > 0 && Boolean(feeEvent.builderAuthority);

    try {
      const traderAuthority = params.traderKeypair.publicKey.toBase58();
      let instructions: unknown[];
      const hasProtections = Boolean(params.stopLossPrice || params.takeProfitPrice);
      const orderParams = {
        connection: params.connection,
        traderAuthority,
        symbol: params.symbol,
        side: params.side,
        baseUnits: params.baseUnits,
        requireFullFill: params.type === 'market',
        stopLossPrice: params.stopLossPrice,
        takeProfitPrice: params.takeProfitPrice,
        slippageBps: params.slippageBps,
        reduceOnly: params.reduceOnly,
      };

      const client = routeThroughFlight && feeEvent.builderAuthority
        ? await this.executor.getFlightRoutedClient({
          builderAuthority: feeEvent.builderAuthority,
          builderPdaIndex: feeEvent.builderPdaIndex,
          builderSubaccountIndex: feeEvent.builderSubaccountIndex,
          feeBps: feeEvent.feeBps,
        })
        : await this.executor.getPlainClient();
      const isolatedOnly = this.executor.isIsolatedOnlyMarket(client, params.symbol);
      const useIsolatedMargin = isolatedOnly || params.marginMode === 'ISOLATED';

      if (useIsolatedMargin) {
        // Phoenix rejects isolated-only commodities when submitted through
        // cross subaccount 0. Its isolated API route allocates or finds the
        // correct child subaccount and includes all setup instructions.
        const isolatedParams = {
          client,
          traderAuthority,
          symbol: params.symbol,
          side: params.side,
          baseUnits: params.baseUnits,
          collateralUsd: params.collateralUsd,
          stopLossPrice: params.stopLossPrice,
          takeProfitPrice: params.takeProfitPrice,
          reduceOnly: params.reduceOnly,
        };
        instructions = params.type === 'market'
          ? await this.executor.buildIsolatedMarketOrderIxs(isolatedParams)
          : await this.executor.buildIsolatedLimitOrderIxs({
              ...isolatedParams,
              priceUsd: params.priceUsd!,
            });
      } else if (routeThroughFlight && feeEvent.builderAuthority) {
        instructions = params.type === 'market'
          ? hasProtections
            ? await this.executor.buildFlightRoutedMarketOrderWithProtectionsIxs!({
                client,
                ...orderParams,
              })
            : [await this.executor.buildFlightRoutedMarketOrderIx({ client, ...orderParams })]
          : hasProtections
            ? await this.executor.buildFlightRoutedLimitOrderWithProtectionsIxs!({
                client,
                ...orderParams,
                priceUsd: params.priceUsd!,
              })
            : [await this.executor.buildFlightRoutedLimitOrderIx({ client, ...orderParams, priceUsd: params.priceUsd! })];
      } else {
        instructions = params.type === 'market'
          ? hasProtections
            ? await this.executor.buildPlainMarketOrderWithProtectionsIxs!({
                ...orderParams,
              })
            : [await this.executor.buildPlainMarketOrderIx(orderParams)]
          : hasProtections
            ? await this.executor.buildPlainLimitOrderWithProtectionsIxs!({
                ...orderParams,
                priceUsd: params.priceUsd!,
              })
            : [await this.executor.buildPlainLimitOrderIx({ ...orderParams, priceUsd: params.priceUsd! })];
      }

      await this.feeService.markPending(feeEvent.id);

      let routedThroughFlight = routeThroughFlight;
      let signature: string;
      try {
        signature = await this.executor.assembleAndSubmit({
          connection: params.connection,
          traderKeypair: params.traderKeypair,
          instructions,
        });
      } catch (error) {
        // A close order is reduce-only, so it is safe to use Phoenix directly
        // if Flight rejects its wrapper before the transaction reaches the
        // chain. This prevents an incompatible builder route from trapping a
        // user in a position. Do not use this escape hatch for opening orders.
        if (!params.reduceOnly || !routeThroughFlight || !isInvalidInstructionDataError(error)) throw error;

        const fallbackInstruction = await this.executor.buildPlainMarketOrderIx(orderParams);
        signature = await this.executor.assembleAndSubmit({
          connection: params.connection,
          traderKeypair: params.traderKeypair,
          instructions: [fallbackInstruction],
        });
        routedThroughFlight = false;
        await log.warn('TRADE', 'Flight rejected a reduce-only close; retried directly on Phoenix', {
          userId: params.userId,
          symbol: params.symbol,
        });
      }

      // Never mark a trade successful merely because it was submitted
      // (spec section 9) - assembleAndSubmit already waits for on-chain
      // confirmation via sendAndConfirmTransaction before returning, so
      // reaching this line means it's genuinely confirmed, not just sent.
      //
      // NOTE ON HONESTY: this confirms the ROUTED TRANSACTION landed
      // on-chain, which is what actually charges the builder fee - but I
      // do not have a verified way to read back the exact fee amount
      // Phoenix's program deducted from that transaction's account deltas
      // (no confirmed Flight API for that - see flight.client.ts header).
      // confirmedFeeUsd is therefore recorded as equal to the expected
      // amount upon successful confirmation. If you later find a way to
      // read the real deducted amount, compare it against this value in
      // reconcile() and flag mismatches rather than silently trusting
      // either side.
      if (params.type === 'market' && routedThroughFlight) {
        await this.feeService.confirmFee(feeEvent.id, Number(feeEvent.expectedFeeUsd), signature);
      } else if (params.type === 'market') {
        // No fee was ever expected on this trade - confirm at $0, not the
        // trade's notional, so revenue reporting stays accurate.
        await this.feeService.confirmFee(feeEvent.id, 0, signature);
      }

      await log.info('TRADE', 'Flight order executed and confirmed', {
        userId: params.userId,
        symbol: params.symbol,
        signature,
        routedThroughFlight,
      });

      return { success: true, signature, feeEventId: feeEvent.id, settled: params.type === 'market' };
    } catch (error) {
      const errorMessage = describeExecutionError(error);
      await this.feeService.failFee(feeEvent.id, errorMessage);
      await log.error('TRADE', 'Flight order execution failed', {
        userId: params.userId,
        symbol: params.symbol,
        errorMessage,
      });
      return { success: false, errorMessage, feeEventId: feeEvent.id, settled: false };
    }
  }
}

export const phoenixFlightExecutionService = new PhoenixFlightExecutionService();

function isInvalidInstructionDataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid instruction data/i.test(message);
}

/** Converts Phoenix's simulation output into an actionable user-facing error. */
function describeExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const rentFailure = /Transfer: insufficient lamports (\d+), need (\d+)/i.exec(message);
  if (rentFailure) {
    const currentSol = Number(rentFailure[1]) / 1_000_000_000;
    const requiredSol = Number(rentFailure[2]) / 1_000_000_000;
    const additionalSol = Math.max(0, requiredSol - currentSol);
    return `Your trading wallet needs SOL to create Phoenix's isolated account for this market. ` +
      `It has ${currentSol.toFixed(6)} SOL but needs ${requiredSol.toFixed(6)} SOL before network fees. ` +
      `Add at least ${additionalSol.toFixed(6)} SOL (fund it to about 0.004 SOL) and try again.`;
  }
  if (/failed: insufficient funds for instruction|insufficient funds for instruction/i.test(message)) {
    return 'Insufficient available Phoenix collateral to open this position. ' +
      'Make sure your Phoenix account (not only your wallet) holds more than the selected collateral amount plus trading fees, ' +
      'then try again.';
  }
  const iocFailure = /IOC order does not meet minimum requirements\. Min base: (\d+), Min quote: \d+, Filled base: (\d+)/i.exec(message);
  if (!iocFailure) return message;

  const requestedLots = Number(iocFailure[1]);
  const availableLots = Number(iocFailure[2]);
  const availablePercent = requestedLots > 0 ? (availableLots / requestedLots) * 100 : 0;
  const availableText = Number.isFinite(availablePercent) ? `${availablePercent.toFixed(1)}%` : 'too little';
  return `Insufficient market liquidity to fill this close order in full (about ${availableText} is currently available). Try a smaller percentage or try again when liquidity improves.`;
}
