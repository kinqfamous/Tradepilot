import { ExchangeAdapter } from '../interfaces/exchange-adapter.interface';
import { PhoenixRestClient } from './phoenix.rest-client';
import { PhoenixWalletAdapter } from './phoenix.wallet-adapter';
import { PhoenixMarketAdapter } from './phoenix.market-adapter';
import { PhoenixPositionAdapter } from './phoenix.position-adapter';
import { PhoenixOrderAdapter, createPhoenixConnection, PhoenixSignerResolver } from './phoenix.order-adapter';
import { PhoenixTradingAdapter } from './phoenix.trading-adapter';
import { PhoenixWebSocketAdapter } from './phoenix.ws-client';
import { walletKeyService } from '../wallet-key.service';
import { prisma } from '../../database/prisma';

/**
 * Resolves a Keypair for a given wallet address by looking up which
 * ExchangeAccount owns it and asking WalletKeyService to decrypt its key.
 */
class PhoenixWalletAddressSignerResolver implements PhoenixSignerResolver {
  async getKeypair(walletAddress: string) {
    const account = await prisma.exchangeAccount.findFirst({
      where: { walletAddress, exchange: 'phoenix' },
    });
    if (!account) {
      throw new Error(`No Phoenix account found for wallet ${walletAddress}.`);
    }
    return walletKeyService.getKeypair(account.id);
  }
}

export function createPhoenixAdapter(): ExchangeAdapter {
  const restClient = new PhoenixRestClient();
  const connection = createPhoenixConnection();
  const signerResolver = new PhoenixWalletAddressSignerResolver();

  const wallet = new PhoenixWalletAdapter(restClient);
  const market = new PhoenixMarketAdapter(restClient);
  const position = new PhoenixPositionAdapter(restClient);
  const order = new PhoenixOrderAdapter(restClient, connection, signerResolver);
  const trading = new PhoenixTradingAdapter(order, position, market);
  const realtime = new PhoenixWebSocketAdapter();

  return {
    key: 'phoenix',
    displayName: 'Phoenix Perps',
    wallet,
    market,
    position,
    order,
    trading,
    realtime,
  };
}
