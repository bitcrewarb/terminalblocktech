import { INSTRUMENTS, TIMEFRAMES } from '../../shared/constants/index.ts';
import type {
  Candle,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  Timeframe,
} from '../../shared/types/index.ts';
import { createInstrumentAdapter, type InstrumentAdapter } from '../adapters/index.ts';
import { InMemoryCandleSeries } from '../candle-builder/index.ts';
import { HistoricalLoader } from '../historical-loader/index.ts';

export interface MarketDataListener {
  onQuote?: (quote: LiveQuote) => void;
  onCandle?: (
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    candles: Candle[],
    updated: Candle,
    closedPrev: Candle | null
  ) => void;
  onStatus?: (status: ProviderStatus) => void;
}

const STALE_THRESHOLD_MS = 20000;

/**
 * Central in-memory market data manager for all 4 independent instrument feeds.
 * Handles historical caching, stale-feed detection, and reconnection resynchronization.
 */
export class MarketDataManager {
  private readonly adapters = new Map<InstrumentSymbol, InstrumentAdapter>();
  private readonly seriesMap = new Map<string, InMemoryCandleSeries>();
  private readonly loader = new HistoricalLoader();
  private readonly listeners = new Set<MarketDataListener>();
  private staleTimer: NodeJS.Timeout | null = null;

  public subscribe(listener: MarketDataListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async startAll(): Promise<void> {
    for (const inst of INSTRUMENTS) {
      const is24x7 = inst.assetClass === 'CRYPTO';
      for (const tf of TIMEFRAMES) {
        this.seriesMap.set(`${inst.symbol}:${tf}`, new InMemoryCandleSeries(tf, is24x7, 800));
      }

      const adapter = createInstrumentAdapter(inst.symbol, {
        onQuoteUpdate: (quote) => {
          for (const l of this.listeners) l.onQuote?.(quote);
        },
        onCandleUpdate: (tf, incoming) => {
          const series = this.seriesMap.get(`${inst.symbol}:${tf}`);
          if (!series) return;
          if (series.getCandles().length === 0) return;

          const res = series.applyCandle(incoming);
          if (!res || res.rejectedReason) return;

          for (const l of this.listeners) {
            l.onCandle?.(
              inst.symbol,
              tf,
              res.candles,
              res.updatedCandle,
              res.closedPreviousCandle
            );
          }
        },
        onResyncRequired: (sym) => {
          void this.resyncActiveTimeframes(sym);
        },
        onStatusChange: (status) => {
          for (const l of this.listeners) l.onStatus?.(status);
        },
      });

      this.adapters.set(inst.symbol, adapter);
      await adapter.start();

      // Preload core timeframes where credentials are available
      if (adapter.getProviderStatus().hasHistoricalCredentials) {
        void this.preloadCoreTimeframes(inst.symbol);
      }
    }

    this.staleTimer = setInterval(() => this.checkStaleFeeds(), 5000);
  }

  public stopAll(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    for (const adapter of this.adapters.values()) {
      adapter.stop();
    }
    this.adapters.clear();
  }

  private async preloadCoreTimeframes(symbol: InstrumentSymbol): Promise<void> {
    const core: Timeframe[] = ['5m', '15m', '1H', '4H', '1D'];
    for (const tf of core) {
      try {
        await this.ensureHistory(symbol, tf);
      } catch {
        // Error surfaced via provider status
      }
    }
  }

  private async resyncActiveTimeframes(symbol: InstrumentSymbol): Promise<void> {
    const loaded: Timeframe[] = [];
    for (const tf of TIMEFRAMES) {
      const series = this.seriesMap.get(`${symbol}:${tf}`);
      if (series && series.getCandles().length > 0) {
        loaded.push(tf);
      }
    }
    const adapter = this.adapters.get(symbol);
    if (!adapter) return;
    for (const tf of loaded) {
      const series = this.seriesMap.get(`${symbol}:${tf}`)!;
      try {
        await this.loader.load(adapter, series, symbol, tf, 450);
      } catch {
        // ignore individual resync error
      }
    }
  }

  private readonly trackedBySymbol = new Map<InstrumentSymbol, Set<Timeframe>>();

  public async ensureHistory(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    forceReload = false
  ): Promise<Candle[]> {
    const adapter = this.adapters.get(symbol);
    const series = this.seriesMap.get(`${symbol}:${timeframe}`);
    if (!adapter || !series) return [];

    let tracked = this.trackedBySymbol.get(symbol);
    if (!tracked) {
      tracked = new Set<Timeframe>(['5m', '15m', '1H', '4H', '1D']);
      this.trackedBySymbol.set(symbol, tracked);
    }
    if (!tracked.has(timeframe)) {
      tracked.add(timeframe);
      adapter.trackTimeframes(Array.from(tracked));
    }

    if (!forceReload && series.getCandles().length > 0) {
      return series.getCandles();
    }
    return this.loader.load(adapter, series, symbol, timeframe, 450);
  }

  public getCachedCandles(symbol: InstrumentSymbol, timeframe: Timeframe): Candle[] {
    return this.seriesMap.get(`${symbol}:${timeframe}`)?.getCandles() ?? [];
  }

  public async fetchRawHistory(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    limit = 600
  ): Promise<Candle[]> {
    const adapter = this.adapters.get(symbol);
    const cached = this.getCachedCandles(symbol, timeframe);
    if (!adapter) return cached;

    try {
      const fetched = await adapter.fetchHistory(timeframe, limit);
      if (fetched.length > 0) {
        return fetched;
      }
    } catch {
      if (cached.length > 0) return cached;
      throw new Error(`Unable to fetch ${symbol} ${timeframe} historical candles for backtest`);
    }
    return cached;
  }

  public getQuote(symbol: InstrumentSymbol): LiveQuote | null {
    return this.adapters.get(symbol)?.getQuote() ?? null;
  }

  public getAllQuotes(): LiveQuote[] {
    const out: LiveQuote[] = [];
    for (const inst of INSTRUMENTS) {
      const q = this.adapters.get(inst.symbol)?.getQuote();
      if (q) out.push(q);
    }
    return out;
  }

  public getProviderStatus(symbol: InstrumentSymbol): ProviderStatus | null {
    return this.adapters.get(symbol)?.getProviderStatus() ?? null;
  }

  public getAllProviderStatuses(): ProviderStatus[] {
    return INSTRUMENTS.map((i) => this.adapters.get(i.symbol)?.getProviderStatus()).filter(
      (s): s is ProviderStatus => Boolean(s)
    );
  }

  private checkStaleFeeds(): void {
    const now = Date.now();
    for (const inst of INSTRUMENTS) {
      const adapter = this.adapters.get(inst.symbol);
      const quote = adapter?.getQuote();
      if (!adapter || !quote) continue;
      if (!quote.marketOpen) continue;
      if (quote.connectionStatus === 'CREDENTIALS_REQUIRED') continue;

      const age = now - quote.lastUpdateTime;
      if (age > STALE_THRESHOLD_MS && !quote.stale) {
        const staleQuote: LiveQuote = {
          ...quote,
          stale: true,
          connectionStatus: 'STALE',
        };
        for (const l of this.listeners) l.onQuote?.(staleQuote);
      }
    }
  }
}
