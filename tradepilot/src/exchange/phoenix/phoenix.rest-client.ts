import axios, { AxiosInstance } from 'axios';
import { config } from '../../config/env';
import { withRetry } from '../../utils/retry';

/**
 * Keep these paths in sync with the version of @ellipsis-labs/rise shipped
 * with this app.  The older `/v1/exchange/markets` and
 * `/v1/trader/:wallet/balances` paths do not exist on the Phoenix API and
 * therefore made every read action fail with a 404 after onboarding.
 */
export const PHOENIX_ENDPOINTS = {
  authNonce: '/v1/auth/nonce',
  authWalletLogin: '/v1/auth/login/wallet',
  exchangeInfo: '/v1/view/exchange',
  markets: '/v1/view/exchange/markets',
  market: (symbol: string) => `/v1/view/exchange/market/${encodeURIComponent(symbol)}`,
  marketStats: (symbol: string) => `/v1/market/${encodeURIComponent(symbol)}/stats/latest`,
  marketsStats: '/v1/markets/stats/latest',
  orderBook: (symbol: string) => `/v1/view/orderbook/${encodeURIComponent(symbol)}`,
  traderState: (wallet: string) => `/v1/trader/state/${encodeURIComponent(wallet)}`,
  traderView: (trader: string) => `/v1/view/trader/${encodeURIComponent(trader)}`,
  traderOrders: (wallet: string) => `/v1/trader/${encodeURIComponent(wallet)}/order-history`,
  traderHistory: (wallet: string) => `/v1/trader/${encodeURIComponent(wallet)}/trades-history`,
  buildOrderTx: '/v1/trader/tx/order',
  buildCancelTx: '/v1/trader/tx/cancel',
  buildClosePositionTx: '/v1/trader/tx/close-position',
  submitTx: '/v1/trader/tx/submit',
  // Access/allowlist codes only. Referral onboarding uses the Rise SDK's
  // authenticated `/v1/referral/activate-tx` transaction flow instead.
  inviteValidate: '/v1/invite/validate',
  inviteActivate: '/v1/invite/activate',
} as const;

export interface PhoenixApiError {
  error: string;
}

export class PhoenixRestClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string = config.phoenix.restUrl) {
    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private withBearer(sessionSecret?: string) {
    return sessionSecret ? { headers: { Authorization: `Bearer ${sessionSecret}` } } : {};
  }

  async get<T>(path: string, sessionSecret?: string, params?: Record<string, unknown>): Promise<T> {
    return withRetry(async () => {
      const response = await this.http.get<T>(path, { ...this.withBearer(sessionSecret), params });
      return response.data;
    });
  }

  async post<T>(path: string, body: unknown, sessionSecret?: string): Promise<T> {
    return withRetry(async () => {
      const response = await this.http.post<T>(path, body, this.withBearer(sessionSecret));
      return response.data;
    });
  }
}

export const phoenixRestClient = new PhoenixRestClient();
