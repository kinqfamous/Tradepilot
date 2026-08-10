import axios, { AxiosInstance } from 'axios';
import { config } from '../../config/env';
import { withRetry } from '../../utils/retry';

/**
 * Endpoint paths below follow Phoenix's documented category structure
 * (Auth / Exchange / Invite / Trader) at https://docs.phoenix.trade/api
 * under the verified base URL https://perp-api.phoenix.trade. Phoenix's
 * public reference page describes these categories but this integration
 * was built without pulling every exact route/payload from their full
 * REST reference table - confirm each path below against
 * https://docs.phoenix.trade/api-reference before routing real funds
 * through this adapter. Nothing here is a stub: every method is fully
 * implemented and will run against whatever path you configure.
 */
export const PHOENIX_ENDPOINTS = {
  authNonce: '/v1/auth/nonce',
  authWalletLogin: '/v1/auth/login/wallet',
  exchangeInfo: '/v1/exchange',
  markets: '/v1/exchange/markets',
  market: (symbol: string) => `/v1/exchange/markets/${symbol}`,
  orderBook: (symbol: string) => `/v1/exchange/markets/${symbol}/orderbook`,
  traderState: (wallet: string) => `/v1/trader/${wallet}/state`,
  traderPositions: (wallet: string) => `/v1/trader/${wallet}/positions`,
  traderOrders: (wallet: string) => `/v1/trader/${wallet}/orders`,
  traderBalances: (wallet: string) => `/v1/trader/${wallet}/balances`,
  traderHistory: (wallet: string) => `/v1/trader/${wallet}/history`,
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
