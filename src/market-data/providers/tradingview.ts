import WebSocket from 'ws';
import type {
  Candle,
  ConnectionStatus,
  InstrumentSymbol,
  LiveQuote,
  Timeframe,
} from '../../shared/types/index.ts';
import { alignTimestampToTimeframe } from '../../shared/validators/index.ts';

const TV_WS_URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart%2F';

export const TRADINGVIEW_SYMBOL_MAP: Record<InstrumentSymbol, string> = {
  XAUUSD: 'OANDA:XAUUSD',
  XAGUSD: 'OANDA:XAGUSD',
  BTCUSDT: 'BINANCE:BTCUSDT',
  ETHUSDT: 'BINANCE:ETHUSDT',
};

export const TRADINGVIEW_PROVIDER_LABEL: Record<InstrumentSymbol, string> = {
  XAUUSD: 'TradingView (OANDA)',
  XAGUSD: 'TradingView (OANDA)',
  BTCUSDT: 'TradingView (BINANCE)',
  ETHUSDT: 'TradingView (BINANCE)',
};

const TV_RESOLUTION_MAP: Record<
  Timeframe,
  { tvRes: string; aggregateTo?: Timeframe }
> = {
  '1m': { tvRes: '1' },
  '3m': { tvRes: '3' },
  '5m': { tvRes: '5' },
  '15m': { tvRes: '15' },
  '30m': { tvRes: '30' },
  '1H': { tvRes: '60' },
  '2H': { tvRes: '120' },
  '4H': { tvRes: '240' },
  '6H': { tvRes: '120', aggregateTo: '6H' },
  '12H': { tvRes: '240', aggregateTo: '12H' },
  '1D': { tvRes: '1D' },
  '1W': { tvRes: '1W' },
  '1M': { tvRes: '1M' },
};

function encodeTvMessage(method: string, params: unknown[]): string {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${payload.length}~m~${payload}`;
}

function parseTvFrames(raw: string): Array<{ heartbeat?: string; m?: string; p?: unknown[] }> {
  const results: Array<{ heartbeat?: string; m?: string; p?: unknown[] }> = [];
  let idx = 0;
  while (idx < raw.length) {
    if (!raw.startsWith('~m~', idx)) break;
    const lenEnd = raw.indexOf('~m~', idx + 3);
    if (lenEnd === -1) break;
    const len = Number(raw.slice(idx + 3, lenEnd));
    if (!Number.isFinite(len) || len <= 0) break;
    const bodyStart = lenEnd + 3;
    const body = raw.slice(bodyStart, bodyStart + len);
    idx = bodyStart + len;

    if (body.startsWith('~h~')) {
      results.push({ heartbeat: `~m~${body.length}~m~${body}` });
    } else if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as { m?: string; p?: unknown[] };
        results.push(parsed);
      } catch {
        // ignore malformed packet
      }
    }
  }
  return results;
}

function aggregateCandlesToTimeframe(candles: Candle[], targetTf: Timeframe): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const key = alignTimestampToTimeframe(c.time, targetTf);
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  return keys.map((k, idx) => {
    const bars = buckets.get(k)!;
    return {
      time: k,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((acc, b) => acc + b.volume, 0),
      isClosed: idx < keys.length - 1 ? true : bars[bars.length - 1].isClosed,
    };
  });
}

/**
 * Fetches historical OHLCV candles for any of the 4 instruments via TradingView's public chart WebSocket.
 */
export async function fetchTradingViewHistoricalCandles(
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  bars = 450
): Promise<Candle[]> {
  const tvSymbol = TRADINGVIEW_SYMBOL_MAP[symbol];
  const spec = TV_RESOLUTION_MAP[timeframe];
  const targetRaw = spec.aggregateTo ? Math.min(25000, bars * 3) : Math.min(20000, bars);
  const initialRequest = Math.min(5000, targetRaw);

  return new Promise<Candle[]>((resolve, reject) => {
    let settled = false;
    const collected = new Map<number, Candle>();
    let extraRequestsSent = 0;
    const maxExtraRequests = 5;

    const ws = new WebSocket(TV_WS_URL, {
      headers: {
        Origin: 'https://www.tradingview.com',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const chartSession = `cs_${Math.random().toString(36).slice(2, 10)}`;
    const timeoutMs = bars > 5000 ? 28000 : 18000;
    const timeout = setTimeout(() => {
      if (!settled) {
        if (collected.size > 0) {
          finalizeCollection();
          return;
        }
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`TradingView history timeout for ${tvSymbol} (${timeframe})`));
      }
    }, timeoutMs);

    const finish = (err: Error | null, data?: Candle[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close();
        else ws.terminate();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(data ?? []);
    };

    const finalizeCollection = () => {
      const sorted = Array.from(collected.values()).sort((a, b) => a.time - b.time);
      const marked = sorted.map((c, idx) => ({
        ...c,
        isClosed: idx < sorted.length - 1,
      }));
      const finalCandles = spec.aggregateTo
        ? aggregateCandlesToTimeframe(marked, spec.aggregateTo).slice(-bars)
        : marked.slice(-bars);
      finish(null, finalCandles);
    };

    ws.on('open', () => {
      ws.send(encodeTvMessage('set_auth_token', ['unauthorized_user_token']));
      ws.send(encodeTvMessage('chart_create_session', [chartSession, '']));
      ws.send(
        encodeTvMessage('resolve_symbol', [
          chartSession,
          'sds_sym_1',
          `={"symbol":"${tvSymbol}","adjustment":"splits","session":"regular"}`,
        ])
      );
      ws.send(
        encodeTvMessage('create_series', [
          chartSession,
          'sds_1',
          's1',
          'sds_sym_1',
          spec.tvRes,
          initialRequest,
          '',
        ])
      );
    });

    ws.on('message', (buf) => {
      const frames = parseTvFrames(buf.toString());
      for (const f of frames) {
        if (f.heartbeat) {
          if (ws.readyState === WebSocket.OPEN) ws.send(f.heartbeat);
          continue;
        }
        if (f.m === 'timescale_update' && Array.isArray(f.p)) {
          const payload = f.p[1] as {
            sds_1?: { s?: Array<{ i: number; v: number[] }> };
          };
          const rawBars = payload?.sds_1?.s;
          if (Array.isArray(rawBars) && rawBars.length > 0) {
            for (const b of rawBars) {
              const t = Math.floor(b.v[0]);
              const c: Candle = {
                time: t,
                open: Number(b.v[1]),
                high: Number(b.v[2]),
                low: Number(b.v[3]),
                close: Number(b.v[4]),
                volume: Number(b.v[5] ?? 0),
                isClosed: true,
              };
              if (
                Number.isFinite(c.time) &&
                Number.isFinite(c.open) &&
                Number.isFinite(c.high) &&
                Number.isFinite(c.low) &&
                Number.isFinite(c.close)
              ) {
                collected.set(t, c);
              }
            }

            if (collected.size >= targetRaw) {
              finalizeCollection();
              return;
            }
          }
        }
        if (f.m === 'series_completed' && Array.isArray(f.p)) {
          const meta = f.p[4] as { data_completed?: string } | undefined;
          const limitReached = meta?.data_completed === 'limit';
          if (
            !limitReached &&
            collected.size < targetRaw &&
            extraRequestsSent < maxExtraRequests &&
            ws.readyState === WebSocket.OPEN
          ) {
            extraRequestsSent += 1;
            const remaining = Math.min(5000, targetRaw - collected.size);
            ws.send(encodeTvMessage('request_more_data', [chartSession, 'sds_1', remaining]));
          } else if (collected.size > 0) {
            finalizeCollection();
            return;
          }
        }
        if ((f.m === 'series_error' || f.m === 'symbol_error') && Array.isArray(f.p)) {
          if (collected.size > 0) {
            finalizeCollection();
          } else {
            finish(new Error(`TradingView ${f.m}: ${JSON.stringify(f.p)}`));
          }
          return;
        }
      }
    });

    ws.on('error', (err) => {
      if (collected.size > 0) {
        finalizeCollection();
      } else {
        finish(err instanceof Error ? err : new Error('TradingView WebSocket error'));
      }
    });
  });
}

export interface TradingViewStreamCallbacks {
  onStatus: (status: ConnectionStatus, error?: string) => void;
  onQuote: (quote: Partial<LiveQuote>) => void;
  onCandle: (timeframe: Timeframe, candle: Candle) => void;
  onReconnect: () => void;
}

/**
 * Persistent TradingView WebSocket client for a single instrument,
 * streaming live quote ticks (price, bid, ask, ch, chp, volume) and live OHLCV bar updates.
 */
export class TradingViewSymbolStream {
  private readonly symbol: InstrumentSymbol;
  private readonly tvSymbol: string;
  private readonly callbacks: TradingViewStreamCallbacks;

  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private hasConnectedOnce = false;
  private trackedTimeframes: Timeframe[] = ['15m', '1H', '4H', '1D'];

  private connNonce = '';
  private quoteSessionId = '';
  private readonly sessionToRes = new Map<string, string>();
  private readonly subscribedRes = new Set<string>();
  private readonly rawBarsByRes = new Map<string, Map<number, Candle>>();
  private readonly lastEmittedClosedTimeByTf = new Map<Timeframe, number>();

  private latestBid: number | undefined;
  private latestAsk: number | undefined;

  constructor(symbol: InstrumentSymbol, callbacks: TradingViewStreamCallbacks) {
    this.symbol = symbol;
    this.tvSymbol = TRADINGVIEW_SYMBOL_MAP[symbol];
    this.callbacks = callbacks;
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.safeDispose();
  }

  public setTrackedTimeframes(timeframes: Timeframe[]): void {
    const next = Array.from(new Set(timeframes));
    this.trackedTimeframes = next;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const tf of next) {
        this.subscribeSeriesForTimeframe(this.ws, tf);
      }
    }
  }

  private safeDispose(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    old.removeAllListeners();
    old.on('error', () => {});
    try {
      if (old.readyState === WebSocket.OPEN) old.close();
      else old.terminate();
    } catch {
      // ignore
    }
  }

  private subscribeSeriesForTimeframe(ws: WebSocket, tf: Timeframe): void {
    const spec = TV_RESOLUTION_MAP[tf];
    if (this.subscribedRes.has(spec.tvRes)) {
      return;
    }
    this.subscribedRes.add(spec.tvRes);

    // TradingView limits unauthenticated chart sessions to 1 series per session,
    // so each distinct resolution uses its own chart session over the single WS.
    const chartSessionId = `cs_${spec.tvRes}_${this.connNonce}`;
    this.sessionToRes.set(chartSessionId, spec.tvRes);

    const barCount = spec.tvRes === '120' || spec.tvRes === '240' ? 12 : 5;
    ws.send(encodeTvMessage('chart_create_session', [chartSessionId, '']));
    ws.send(
      encodeTvMessage('resolve_symbol', [
        chartSessionId,
        'sym_1',
        `={"symbol":"${this.tvSymbol}","adjustment":"splits","session":"regular"}`,
      ])
    );
    ws.send(
      encodeTvMessage('create_series', [
        chartSessionId,
        'sds_1',
        's1',
        'sym_1',
        spec.tvRes,
        barCount,
        '',
      ])
    );
  }

  private connect(): void {
    if (this.stopped) return;
    this.callbacks.onStatus(this.hasConnectedOnce ? 'RECONNECTING' : 'CONNECTING');
    this.connNonce = Math.random().toString(36).slice(2, 8);
    this.quoteSessionId = `qs_${this.connNonce}`;
    this.sessionToRes.clear();
    this.subscribedRes.clear();
    this.rawBarsByRes.clear();

    const ws = new WebSocket(TV_WS_URL, {
      headers: {
        Origin: 'https://www.tradingview.com',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      const wasReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;
      this.callbacks.onStatus('CONNECTED');

      ws.send(encodeTvMessage('set_auth_token', ['unauthorized_user_token']));
      ws.send(encodeTvMessage('quote_create_session', [this.quoteSessionId]));
      ws.send(
        encodeTvMessage('quote_set_fields', [
          this.quoteSessionId,
          'lp',
          'ch',
          'chp',
          'bid',
          'ask',
          'volume',
          'high_price',
          'low_price',
          'open_price',
          'prev_close_price',
          'current_session',
        ])
      );
      ws.send(encodeTvMessage('quote_add_symbols', [this.quoteSessionId, this.tvSymbol]));

      for (const tf of this.trackedTimeframes) {
        this.subscribeSeriesForTimeframe(ws, tf);
      }

      if (wasReconnect) {
        this.callbacks.onReconnect();
      }
    });

    ws.on('message', (buf) => {
      const frames = parseTvFrames(buf.toString());
      for (const f of frames) {
        if (f.heartbeat) {
          if (ws.readyState === WebSocket.OPEN) ws.send(f.heartbeat);
          continue;
        }

        if (f.m === 'qsd' && Array.isArray(f.p)) {
          const item = f.p[1] as {
            n?: string;
            v?: {
              lp?: number;
              ch?: number;
              chp?: number;
              bid?: number;
              ask?: number;
              volume?: number;
              high_price?: number;
              low_price?: number;
              current_session?: string;
            };
          };
          const v = item?.v;
          if (!v) continue;

          if (typeof v.bid === 'number') this.latestBid = v.bid;
          if (typeof v.ask === 'number') this.latestAsk = v.ask;
          const spread =
            this.latestBid !== undefined && this.latestAsk !== undefined
              ? Number(Math.max(0, this.latestAsk - this.latestBid).toFixed(4))
              : undefined;

          const sessionVal = typeof v.current_session === 'string' ? v.current_session.toLowerCase() : undefined;
          const inferredMarketOpen =
            sessionVal === undefined
              ? undefined
              : sessionVal !== 'out_of_session' &&
                sessionVal !== 'holiday' &&
                sessionVal !== 'closed';

          const pct = typeof v.chp === 'number' ? v.chp : undefined;
          this.callbacks.onQuote({
            price: typeof v.lp === 'number' ? v.lp : undefined,
            bid: this.latestBid,
            ask: this.latestAsk,
            spread,
            change24h: typeof v.ch === 'number' ? v.ch : undefined,
            changePercent24h: pct,
            high24h: typeof v.high_price === 'number' ? v.high_price : undefined,
            low24h: typeof v.low_price === 'number' ? v.low_price : undefined,
            volume24h: typeof v.volume === 'number' ? v.volume : undefined,
            direction:
              pct !== undefined
                ? pct > 0
                  ? 'bullish'
                  : pct < 0
                    ? 'bearish'
                    : 'neutral'
                : undefined,
            marketOpen: inferredMarketOpen,
            providerTimestamp: Date.now(),
            lastUpdateTime: Date.now(),
            stale: false,
          });
          continue;
        }

        if ((f.m === 'timescale_update' || f.m === 'du') && Array.isArray(f.p)) {
          const csId = String(f.p[0] ?? '');
          const tvRes = this.sessionToRes.get(csId);
          if (!tvRes) continue;

          const updates = f.p[1] as Record<
            string,
            { s?: Array<{ i: number; v: number[] }> }
          >;
          const bars = updates?.sds_1?.s;
          if (!Array.isArray(bars) || bars.length === 0) continue;

          let resMap = this.rawBarsByRes.get(tvRes);
          if (!resMap) {
            resMap = new Map<number, Candle>();
            this.rawBarsByRes.set(tvRes, resMap);
          }
          for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            const t = Math.floor(b.v[0]);
            const c: Candle = {
              time: t,
              open: Number(b.v[1]),
              high: Number(b.v[2]),
              low: Number(b.v[3]),
              close: Number(b.v[4]),
              volume: Number(b.v[5] ?? 0),
              isClosed: i < bars.length - 1,
            };
            if (
              Number.isFinite(c.time) &&
              Number.isFinite(c.open) &&
              Number.isFinite(c.high) &&
              Number.isFinite(c.low) &&
              Number.isFinite(c.close)
            ) {
              resMap.set(t, c);
            }
          }
          if (resMap.size > 30) {
            const sortedKeys = Array.from(resMap.keys()).sort((a, b) => a - b);
            for (const oldKey of sortedKeys.slice(0, resMap.size - 30)) {
              resMap.delete(oldKey);
            }
          }

          const matchingTfs = this.trackedTimeframes.filter(
            (tf) => TV_RESOLUTION_MAP[tf].tvRes === tvRes
          );

          const latestRaw = bars[bars.length - 1];
          const prevRaw = bars.length >= 2 ? bars[bars.length - 2] : null;

          for (const tf of matchingTfs) {
            const spec = TV_RESOLUTION_MAP[tf];
            if (spec.aggregateTo) {
              const sortedRaw = Array.from(resMap.values()).sort((a, b) => a.time - b.time);
              const agg = aggregateCandlesToTimeframe(sortedRaw, spec.aggregateTo);
              if (agg.length >= 2 && f.m === 'du') {
                const prevAgg = agg[agg.length - 2];
                const bucketSubCount = sortedRaw.filter(
                  (r) => alignTimestampToTimeframe(r.time, spec.aggregateTo!) === prevAgg.time
                ).length;
                if (bucketSubCount >= 3) {
                  this.callbacks.onCandle(tf, { ...prevAgg, isClosed: true });
                }
              }
              if (agg.length >= 1) {
                this.callbacks.onCandle(tf, { ...agg[agg.length - 1], isClosed: false });
              }
              continue;
            }

            if (prevRaw && f.m === 'du') {
              const prevTime = Math.floor(prevRaw.v[0]);
              if (this.lastEmittedClosedTimeByTf.get(tf) !== prevTime) {
                this.lastEmittedClosedTimeByTf.set(tf, prevTime);
                this.callbacks.onCandle(tf, {
                  time: prevTime,
                  open: Number(prevRaw.v[1]),
                  high: Number(prevRaw.v[2]),
                  low: Number(prevRaw.v[3]),
                  close: Number(prevRaw.v[4]),
                  volume: Number(prevRaw.v[5] ?? 0),
                  isClosed: true,
                });
              }
            }

            this.callbacks.onCandle(tf, {
              time: Math.floor(latestRaw.v[0]),
              open: Number(latestRaw.v[1]),
              high: Number(latestRaw.v[2]),
              low: Number(latestRaw.v[3]),
              close: Number(latestRaw.v[4]),
              volume: Number(latestRaw.v[5] ?? 0),
              isClosed: false,
            });
          }
        }
      }
    });

    ws.on('error', (err) => {
      this.callbacks.onStatus('RECONNECTING', err.message);
    });

    ws.on('close', () => {
      if (this.stopped) return;
      this.callbacks.onStatus('RECONNECTING');
      const delay = Math.min(25000, 1000 * Math.pow(2, Math.min(4, this.reconnectAttempts)));
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
