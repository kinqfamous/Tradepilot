import WebSocket from 'ws';
import { config } from '../../config/env';
import { fileLogger } from '../../logger/logger';
import { RealtimeAdapter } from '../interfaces/exchange-adapter.interface';
import { RealtimeEvent, RealtimeEventHandler } from '../../types/exchange.types';
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
} from '../../constants';

interface Subscription {
  channel: string;
  symbol?: string;
  walletAddress?: string;
}

export class PhoenixWebSocketAdapter implements RealtimeAdapter {
  private ws: WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;

  private readonly priceHandlers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly accountHandlers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly activeSubscriptions = new Set<string>();

  constructor(private readonly url: string = config.phoenix.wsUrl) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.ws = socket;

      const onOpenTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('Phoenix WebSocket connection timed out'));
      }, 10_000);

      socket.once('open', () => {
        clearTimeout(onOpenTimeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.resubscribeAll();
        fileLogger.info('Phoenix WebSocket connected');
        this.emitAll('connected', {});
        resolve();
      });

      socket.on('message', (data) => this.handleMessage(data));

      socket.once('error', (err) => {
        clearTimeout(onOpenTimeout);
        fileLogger.error({ err }, 'Phoenix WebSocket error');
        reject(err);
      });

      socket.on('close', () => this.handleClose());
      socket.on('pong', () => this.resetHeartbeatTimeout());
    });
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  subscribePrices(markets: string[], handler: RealtimeEventHandler): void {
    for (const market of markets) {
      if (!this.priceHandlers.has(market)) this.priceHandlers.set(market, new Set());
      this.priceHandlers.get(market)!.add(handler);
      this.sendSubscription({ channel: 'orderbook', symbol: market });
      this.sendSubscription({ channel: 'trades', symbol: market });
    }
  }

  subscribeAccount(walletAddress: string, handler: RealtimeEventHandler): void {
    if (!this.accountHandlers.has(walletAddress)) this.accountHandlers.set(walletAddress, new Set());
    this.accountHandlers.get(walletAddress)!.add(handler);
    this.sendSubscription({ channel: 'trader', walletAddress });
  }

  unsubscribeAccount(walletAddress: string): void {
    this.accountHandlers.delete(walletAddress);
    this.send({
      type: 'unsubscribe',
      subscription: { channel: 'trader', walletAddress },
    });
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private sendSubscription(sub: Subscription): void {
    const key = JSON.stringify(sub);
    this.activeSubscriptions.add(key);
    this.send({ type: 'subscribe', subscription: sub });
  }

  private resubscribeAll(): void {
    for (const key of this.activeSubscriptions) {
      this.send({ type: 'subscribe', subscription: JSON.parse(key) });
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let parsed: any;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const channel: string | undefined = parsed?.subscription?.channel ?? parsed?.channel;
    const symbol: string | undefined = parsed?.subscription?.symbol ?? parsed?.symbol;
    const walletAddress: string | undefined = parsed?.subscription?.walletAddress ?? parsed?.walletAddress;

    if (channel === 'orderbook' || channel === 'trades') {
      const handlers = symbol ? this.priceHandlers.get(symbol) : undefined;
      const event: RealtimeEvent = {
        type: 'price',
        market: symbol,
        payload: parsed,
        timestamp: Date.now(),
      };
      handlers?.forEach((h) => h(event));
      return;
    }

    if (channel === 'trader' && walletAddress) {
      const handlers = this.accountHandlers.get(walletAddress);
      const event: RealtimeEvent = {
        type: 'position_update',
        walletAddress,
        payload: parsed,
        timestamp: Date.now(),
      };
      handlers?.forEach((h) => h(event));
    }
  }

  private emitAll(type: RealtimeEvent['type'], payload: unknown): void {
    const event: RealtimeEvent = { type, payload, timestamp: Date.now() };
    this.priceHandlers.forEach((set) => set.forEach((h) => h(event)));
    this.accountHandlers.forEach((set) => set.forEach((h) => h(event)));
  }

  private handleClose(): void {
    this.connected = false;
    this.stopHeartbeat();
    this.emitAll('disconnected', {});

    if (this.intentionallyClosed) return;

    const delay = Math.min(
      WS_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      WS_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;

    fileLogger.warn(`Phoenix WebSocket disconnected, reconnecting in ${delay}ms`);

    setTimeout(() => {
      this.connect().catch((err) => {
        fileLogger.error({ err }, 'Phoenix WebSocket reconnect attempt failed');
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.resetHeartbeatTimeout();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = setTimeout(() => {
      fileLogger.warn('Phoenix WebSocket heartbeat timed out, forcing reconnect');
      this.ws?.terminate();
    }, WS_HEARTBEAT_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
  }
}
