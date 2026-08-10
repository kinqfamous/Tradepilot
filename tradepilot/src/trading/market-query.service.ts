import { exchangeRegistry } from '../exchange/exchange.registry';
import { exchangeAccountService } from '../users/exchange-account.service';
import { MarketInfo, AccountBalance, ExchangePosition } from '../types/exchange.types';

export class MarketQueryService {
  async listMarkets(exchange: string): Promise<MarketInfo[]> {
    return exchangeRegistry.get(exchange).market.listMarkets();
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
