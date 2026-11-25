import WebSocket from 'ws';
import type { Candle, ConnectionStatus, InstrumentSymbol, LiveQuote, Timeframe } from '../../shared/types/index.ts';

const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3';
const BINANCE_WS_BASE = 'wss://data-stream.binance.vision/stream';

export const BINANCE_TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1H': '1h',
  '2H': '2h',
  '4H': '4h',
  '6H': '6h',
  '12H': '12h',
  '1D': '1d',
  '1W': '1w',
  '1M': '1M',
};

export interface BinanceTickerStats {
  price: number;
  bid: number;
  ask: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  timestamp: number;
}

export async function fetchBinanceHistoricalCandles(
  symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>,
  timeframe: Timeframe,
  limit = 500
): Promise<Candle[]> {
  const interval = BINANCE_TIMEFRAME_MAP[timeframe];
  const target = Math.max(1, Math.min(20000, Math.round(limit)));
  const maxPerPage = 1000;

  const byTime = new Map<number, Candle>();
  let endTimeMs: number | undefined;
  let pages = 0;
  const maxPages = Math.ceil(target / maxPerPage) + 2;

  while (byTime.size < target && pages < maxPages) {
    pages += 1;
    const batchSize = Math.min(maxPerPage, target - byTime.size);
    const params = new URLSearchParams({
      symbol,
      interval,
      limit: String(batchSize),
    });
    if (endTimeMs !== undefined) {
      params.set('endTime', String(endTimeMs));
    }

    const url = `${BINANCE_REST_BASE}/klines?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance REST HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const rows = (await res.json()) as Array<
      [number, string, string, string, string, string, number, ...unknown[]]
    >;
    if (!Array.isArray(rows) || rows.length === 0) break;

    const nowMs = Date.now();
    for (const r of rows) {
      const timeSec = Math.floor(r[0] / 1000);
      byTime.set(timeSec, {
        time: timeSec,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        isClosed: r[6] < nowMs,
      });
    }

    const earliestMs = rows[0][0];
    if (!Number.isFinite(earliestMs) || rows.length < batchSize) {
      break;
    }
    endTimeMs = earliestMs - 1;
  }

  return Array.from(byTime.values())
    .sort((a, b) => a.time - b.time)
    .slice(-target);
}

export async function fetchBinance24hStats(
  symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>
): Promise<BinanceTickerStats> {
  const [tickerRes, bookRes] = await Promise.all([
    fetch(`${BINANCE_REST_BASE}/ticker/24hr?symbol=${symbol}`, {
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`${BINANCE_REST_BASE}/ticker/bookTicker?symbol=${symbol}`, {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!tickerRes.ok) {
    throw new Error(`Binance 24h ticker HTTP ${tickerRes.status}`);
  }

  const ticker = (await tickerRes.json()) as {
    lastPrice: string;
    priceChange: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
    closeTime: number;
  };
  const book = bookRes.ok
    ? ((await bookRes.json()) as { bidPrice: string; askPrice: string })
    : { bidPrice: ticker.lastPrice, askPrice: ticker.lastPrice };

  return {
    price: Number(ticker.lastPrice),
    bid: Number(book.bidPrice),
    ask: Number(book.askPrice),
    change24h: Number(ticker.priceChange),
    changePercent24h: Number(ticker.priceChangePercent),
    high24h: Number(ticker.highPrice),
    low24h: Number(ticker.lowPrice),
    volume24h: Number(ticker.volume),
    timestamp: ticker.closeTime || Date.now(),
  };
}

export interface BinanceStreamCallbacks {
  onStatus: (status: ConnectionStatus, error?: string) => void;
  onQuote: (quote: Partial<LiveQuote>) => void;
  onKline: (timeframe: Timeframe, candle: Candle) => void;
  onReconnect: () => void;
}

export class BinanceSymbolStream {
  private readonly symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>;
  private readonly callbacks: BinanceStreamCallbacks;
  private ws: WebSocket | null = null;
  private activeTimeframes = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W']);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private bookFlushTimer: NodeJS.Timeout | null = null;
  private pendingBookQuote: Partial<LiveQuote> | null = null;
  private lastBookBid: number | null = null;
  private lastBookAsk: number | null = null;
  private lastBookEmitAt = 0;
  private suppressNextReconnectCallback = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private hasConnectedOnce = false;

  constructor(
    symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>,
    callbacks: BinanceStreamCallbacks
  ) {
    this.symbol = symbol;
    this.callbacks = callbacks;
  }

  public setTrackedTimeframes(timeframes: Timeframe[]): void {
    const next = new Set<Timeframe>(timeframes);
    let changed = next.size !== this.activeTimeframes.size;
    if (!changed) {
      for (const tf of next) {
        if (!this.activeTimeframes.has(tf)) {
          changed = true;
          break;
        }
      }
    }
    this.activeTimeframes = next;
    if (changed && this.ws) {
      this.suppressNextReconnectCallback = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectNow();
      }, 250);
    }
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  private safeDisposeSocket(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    old.removeAllListeners();
    old.on('error', () => {});
    try {
      if (old.readyState === WebSocket.OPEN) {
        old.close();
      } else {
        old.terminate();
      }
    } catch {
      // ignore close errors
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.bookFlushTimer) {
      clearTimeout(this.bookFlushTimer);
      this.bookFlushTimer = null;
    }
    this.pendingBookQuote = null;
    this.safeDisposeSocket();
  }

  private reconnectNow(): void {
    this.safeDisposeSocket();
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.callbacks.onStatus(this.hasConnectedOnce ? 'RECONNECTING' : 'CONNECTING');

    const lower = this.symbol.toLowerCase();
    const streams = [
      `${lower}@ticker`,
      `${lower}@bookTicker`,
      ...Array.from(this.activeTimeframes).map(
        (tf) => `${lower}@kline_${BINANCE_TIMEFRAME_MAP[tf]}`
      ),
    ];

    const url = `${BINANCE_WS_BASE}?streams=${streams.join('/')}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      const wasReconnect = this.hasConnectedOnce;
      const shouldSuppressResync = this.suppressNextReconnectCallback;
      this.suppressNextReconnectCallback = false;
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;
      this.callbacks.onStatus('CONNECTED');

      if (wasReconnect && !shouldSuppressResync) {
        this.callbacks.onReconnect();
      }

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 25000);
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (!parsed.stream || !parsed.data) return;

        if (parsed.stream.endsWith('@bookTicker')) {
          const d = parsed.data as { b: string; a: string };
          const bid = Number(d.b);
          const ask = Number(d.a);
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            if (bid === this.lastBookBid && ask === this.lastBookAsk) {
              return;
            }
            this.lastBookBid = bid;
            this.lastBookAsk = ask;
            const now = Date.now();
            const q: Partial<LiveQuote> = {
              bid,
              ask,
              spread: Number((ask - bid).toFixed(4)),
              lastUpdateTime: now,
            };
            if (now - this.lastBookEmitAt >= 150) {
              this.lastBookEmitAt = now;
              this.pendingBookQuote = null;
              if (this.bookFlushTimer) {
                clearTimeout(this.bookFlushTimer);
                this.bookFlushTimer = null;
              }
              this.callbacks.onQuote(q);
            } else {
              this.pendingBookQuote = q;
              if (!this.bookFlushTimer) {
                this.bookFlushTimer = setTimeout(() => {
                  this.bookFlushTimer = null;
                  if (this.stopped || !this.pendingBookQuote) return;
                  const pending = this.pendingBookQuote;
                  this.pendingBookQuote = null;
                  this.lastBookEmitAt = Date.now();
                  this.callbacks.onQuote(pending);
                }, 150);
              }
            }
          }
          return;
        }

        if (parsed.stream.endsWith('@ticker')) {
          const d = parsed.data as {
            c: string;
            p: string;
            P: string;
            h: string;
            l: string;
            v: string;
            E: number;
          };
          const price = Number(d.c);
          const change = Number(d.p);
          const pct = Number(d.P);
          this.callbacks.onQuote({
            price,
            change24h: change,
            changePercent24h: pct,
            high24h: Number(d.h),
            low24h: Number(d.l),
            volume24h: Number(d.v),
            direction: pct > 0 ? 'bullish' : pct < 0 ? 'bearish' : 'neutral',
            providerTimestamp: d.E || Date.now(),
            lastUpdateTime: Date.now(),
            stale: false,
          });
          return;
        }

        if (parsed.stream.includes('@kline_')) {
          const k = (parsed.data as { k?: Record<string, unknown> }).k as {
            t: number;
            i: string;
            o: string;
            h: string;
            l: string;
            c: string;
            v: string;
            x: boolean;
          };
          if (!k) return;

          const tfEntry = (Object.entries(BINANCE_TIMEFRAME_MAP) as [Timeframe, string][]).find(
            ([, v]) => v === k.i
          );
          if (!tfEntry) return;

          const candle: Candle = {
            time: Math.floor(k.t / 1000),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            isClosed: Boolean(k.x),
          };
          this.callbacks.onKline(tfEntry[0], candle);
        }
      } catch {
        // Ignore malformed frame
      }
    });

    ws.on('error', (err) => {
      this.callbacks.onStatus('RECONNECTING', err.message);
    });

    ws.on('close', () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.stopped) return;
      this.callbacks.onStatus('RECONNECTING');
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(5, this.reconnectAttempts)));
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
