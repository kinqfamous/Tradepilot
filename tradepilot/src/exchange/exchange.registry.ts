import { ExchangeAdapter } from './interfaces/exchange-adapter.interface';
import { createPhoenixAdapter } from './phoenix/phoenix.adapter';
import { config } from '../config/env';

/**
 * Every supported exchange is registered here exactly once. Nothing
 * outside this file and the interfaces/ folder should ever import a
 * concrete exchange module - services, the trading layer, and the bot
 * only ever ask ExchangeRegistry for "the adapter for exchange X".
 *
 * To add Hyperliquid, Drift, or Jupiter Perps: implement ExchangeAdapter
 * (see exchange/phoenix/ as the reference implementation) and add one
 * line to `factories` below. No other file in the codebase changes.
 */
class ExchangeRegistry {
  private readonly factories: Record<string, () => ExchangeAdapter> = {
    phoenix: createPhoenixAdapter,
  };

  private readonly instances = new Map<string, ExchangeAdapter>();

  get(exchangeKey: string | undefined): ExchangeAdapter {
    if (!exchangeKey || typeof exchangeKey !== 'string') {
      throw new Error(`No exchange was selected. Supported exchanges: ${Object.keys(this.factories).join(', ')}.`);
    }
    const key = exchangeKey.toLowerCase();
    if (!this.instances.has(key)) {
      const factory = this.factories[key];
      if (!factory) {
        throw new Error(
          `Unknown exchange "${exchangeKey}". Supported exchanges: ${Object.keys(this.factories).join(', ')}.`,
        );
      }
      this.instances.set(key, factory());
    }
    return this.instances.get(key)!;
  }

  getDefault(): ExchangeAdapter {
    return this.get(config.defaultExchange);
  }

  listSupported(): string[] {
    return Object.keys(this.factories);
  }
}

export const exchangeRegistry = new ExchangeRegistry();
