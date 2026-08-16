import { exchangeRegistry } from '../exchange/exchange.registry';
import { exchangeAccountService } from '../users/exchange-account.service';
import { MarketInfo, AccountBalance, ExchangePosition } from '../types/exchange.types';

export class MarketQueryService {
  async listMarkets(exchange: string, forceRefresh = false): Promise<MarketInfo[]> {
    return exchangeRegistry.get(exchange).market.listMarkets(forceRefresh);
  }

  /** Resolves free-form ticker text against the real market list for an exchange. */
  async resolveTicker(exchange: string, rawTicker: string): Promise<MarketInfo | null> {
    const markets = await this.listMarkets(exchange);
    const upper = rawTicker.trim().toUpperCase();
    const candidateSymbol = upper.endsWith('-PERP') ? upper : `${upper}-PERP`;
    const matched = markets.find((market) => market.symbol === candidateSymbol) ??
      markets.find((market) => market.baseAsset === upper);
    if (!matched) return null;
    return exchangeRegistry.get(exchange).market.getMarket(matched.symbol) ?? matched;
  }

  async getBalances(userId: number, exchange: string): Promise<AccountBalance[]> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const credential = await exchangeAccountService.getCredential(account);
    return exchangeRegistry.get(exchange).wallet.getBalances(credential);
  }

  async getOpenPositions(userId: number, exchange: string): Promise<ExchangePosition[]> {
    const account = await exchangeAccountService.requireVerifiedAccount(userId, exchange);
    const credential = await exchangeAccountService.getCredential(account);
    return exchangeRegistry.get(exchange).position.getOpenPositions(credential);
  }
}

export const marketQueryService = new MarketQueryService();
