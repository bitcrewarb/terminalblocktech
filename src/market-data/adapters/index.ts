import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type {
  Candle,
  ConnectionStatus,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  Timeframe,
} from '../../shared/types/index.ts';
import {
  BinanceSymbolStream,
  fetchBinance24hStats,
  fetchBinanceHistoricalCandles,
} from '../providers/binance.ts';
import { isMetalsMarketOpen, type MetalsSymbol } from '../providers/metals.ts';
import {
  fetchTradingViewHistoricalCandles,
  TRADINGVIEW_PROVIDER_LABEL,
  TradingViewSymbolStream,
} from '../providers/tradingview.ts';

export interface AdapterCallbacks {
  onQuoteUpdate: (quote: LiveQuote) => void;
  onCandleUpdate: (timeframe: Timeframe, candle: Candle, closedPrevious: Candle | null) => void;
  onResyncRequired: (symbol: InstrumentSymbol) => void;
  onStatusChange: (status: ProviderStatus) => void;
}

export interface InstrumentAdapter {
  readonly symbol: InstrumentSymbol;
  start(): Promise<void>;
  stop(): void;
  fetchHistory(timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  trackTimeframes(timeframes: Timeframe[]): void;
  getQuote(): LiveQuote | null;
  getProviderStatus(): ProviderStatus;
}

export class CryptoInstrumentAdapter implements InstrumentAdapter {
  public readonly symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>;
  private readonly callbacks: AdapterCallbacks;
  private stream: BinanceSymbolStream | null = null;
  private quote: LiveQuote | null = null;
  private status: ProviderStatus;
  private trackedTimeframes: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'];

  constructor(
    symbol: Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>,
    callbacks: AdapterCallbacks
  ) {
    this.symbol = symbol;
    this.callbacks = callbacks;
    this.status = {
      symbol,
      assetClass: 'CRYPTO',
      providerName: 'Binance Spot (Direct)',
      hasHistoricalCredentials: true,
      hasStreamingFeed: true,
      connectionStatus: 'CONNECTING',
      lastUpdateTime: null,
      feedDelaySeconds: 0,
    };
  }

  public async start(): Promise<void> {
    try {
      const stats = await fetchBinance24hStats(this.symbol);
      this.quote = {
        symbol: this.symbol,
        price: stats.price,
        bid: stats.bid,
        ask: stats.ask,
        spread: Number((stats.ask - stats.bid).toFixed(4)),
        change24h: stats.change24h,
        changePercent24h: stats.changePercent24h,
        high24h: stats.high24h,
        low24h: stats.low24h,
        volume24h: stats.volume24h,
        direction:
          stats.changePercent24h > 0
            ? 'bullish'
            : stats.changePercent24h < 0
              ? 'bearish'
              : 'neutral',
        provider: 'Binance Spot (Direct)',
        feedDelaySeconds: 0,
        connectionStatus: 'CONNECTED',
        marketOpen: true,
        lastUpdateTime: Date.now(),
        providerTimestamp: stats.timestamp,
        stale: false,
      };
      this.callbacks.onQuoteUpdate(this.quote);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Binance initial REST error';
      this.status = { ...this.status, connectionStatus: 'ERROR', errorMessage: msg };
      this.callbacks.onStatusChange(this.status);
    }

    this.stream = new BinanceSymbolStream(this.symbol, {
      onStatus: (connStatus: ConnectionStatus, error?: string) => {
        this.status = {
          ...this.status,
          connectionStatus: connStatus,
          errorMessage: error,
        };
        if (this.quote) {
          this.quote = { ...this.quote, connectionStatus: connStatus, errorMessage: error };
          this.callbacks.onQuoteUpdate(this.quote);
        }
        this.callbacks.onStatusChange(this.status);
      },
      onQuote: (partial) => {
        const now = Date.now();
        this.quote = {
          symbol: this.symbol,
          price: partial.price ?? this.quote?.price ?? 0,
          bid: partial.bid ?? this.quote?.bid,
          ask: partial.ask ?? this.quote?.ask,
          spread: partial.spread ?? this.quote?.spread,
          change24h: partial.change24h ?? this.quote?.change24h ?? 0,
          changePercent24h: partial.changePercent24h ?? this.quote?.changePercent24h ?? 0,
          high24h: partial.high24h ?? this.quote?.high24h,
          low24h: partial.low24h ?? this.quote?.low24h,
          volume24h: partial.volume24h ?? this.quote?.volume24h,
          direction: partial.direction ?? this.quote?.direction ?? 'neutral',
          provider: 'Binance Spot (Direct)',
          feedDelaySeconds: 0,
          connectionStatus: 'CONNECTED',
          marketOpen: true,
          lastUpdateTime: now,
          providerTimestamp: partial.providerTimestamp ?? this.quote?.providerTimestamp ?? now,
          stale: false,
        };
        this.status = { ...this.status, lastUpdateTime: now, connectionStatus: 'CONNECTED' };
        this.callbacks.onQuoteUpdate(this.quote);
      },
      onKline: (tf, candle) => {
        this.callbacks.onCandleUpdate(tf, candle, null);
      },
      onReconnect: () => {
        this.callbacks.onResyncRequired(this.symbol);
      },
    });
    this.stream.setTrackedTimeframes(this.trackedTimeframes);
    this.stream.start();
  }

  public stop(): void {
    this.stream?.stop();
    this.stream = null;
  }

  public async fetchHistory(timeframe: Timeframe, limit = 450): Promise<Candle[]> {
    return fetchBinanceHistoricalCandles(this.symbol, timeframe, limit);
  }

  public trackTimeframes(timeframes: Timeframe[]): void {
    this.trackedTimeframes = timeframes;
    this.stream?.setTrackedTimeframes(timeframes);
  }

  public getQuote(): LiveQuote | null {
    return this.quote;
  }

  public getProviderStatus(): ProviderStatus {
    return this.status;
  }
}

export class MetalsInstrumentAdapter implements InstrumentAdapter {
  public readonly symbol: MetalsSymbol;
  private readonly callbacks: AdapterCallbacks;
  private stream: TradingViewSymbolStream | null = null;
  private quote: LiveQuote | null = null;
  private status: ProviderStatus;
  private trackedTimeframes: Timeframe[] = ['5m', '15m', '1H', '4H', '1D'];

  constructor(symbol: MetalsSymbol, callbacks: AdapterCallbacks) {
    this.symbol = symbol;
    this.callbacks = callbacks;
    this.status = {
      symbol,
      assetClass: 'METALS',
      providerName: TRADINGVIEW_PROVIDER_LABEL[symbol],
      hasHistoricalCredentials: true,
      hasStreamingFeed: true,
      connectionStatus: isMetalsMarketOpen() ? 'CONNECTING' : 'MARKET_CLOSED',
      lastUpdateTime: null,
      feedDelaySeconds: 0,
    };
  }

  public async start(): Promise<void> {
    this.stream = new TradingViewSymbolStream(this.symbol, {
      onStatus: (connStatus, error) => {
        const marketOpen = isMetalsMarketOpen();
        const effectiveStatus: ConnectionStatus =
          !marketOpen && (connStatus === 'CONNECTED' || connStatus === 'CONNECTING')
            ? 'MARKET_CLOSED'
            : connStatus;
        this.status = {
          ...this.status,
          connectionStatus: effectiveStatus,
          errorMessage: error,
        };
        if (this.quote) {
          this.quote = {
            ...this.quote,
            connectionStatus: effectiveStatus,
            marketOpen,
            errorMessage: error,
          };
          this.callbacks.onQuoteUpdate(this.quote);
        }
        this.callbacks.onStatusChange(this.status);
      },
      onQuote: (partial) => {
        const now = Date.now();
        const calendarOpen = isMetalsMarketOpen(new Date(now));
        const marketOpen = calendarOpen && (partial.marketOpen ?? true);
        const connStatus: ConnectionStatus = marketOpen ? 'CONNECTED' : 'MARKET_CLOSED';
        this.quote = {
          symbol: this.symbol,
          price: partial.price ?? this.quote?.price ?? 0,
          bid: partial.bid ?? this.quote?.bid,
          ask: partial.ask ?? this.quote?.ask,
          spread: partial.spread ?? this.quote?.spread,
          change24h: partial.change24h ?? this.quote?.change24h ?? 0,
          changePercent24h: partial.changePercent24h ?? this.quote?.changePercent24h ?? 0,
          high24h: partial.high24h ?? this.quote?.high24h,
          low24h: partial.low24h ?? this.quote?.low24h,
          volume24h: partial.volume24h ?? this.quote?.volume24h,
          direction: partial.direction ?? this.quote?.direction ?? 'neutral',
          provider: TRADINGVIEW_PROVIDER_LABEL[this.symbol],
          feedDelaySeconds: 0,
          connectionStatus: connStatus,
          marketOpen,
          lastUpdateTime: now,
          providerTimestamp: partial.providerTimestamp ?? now,
          stale: false,
        };
        this.status = {
          ...this.status,
          lastUpdateTime: now,
          connectionStatus: connStatus,
        };
        if (this.quote.price > 0) {
          this.callbacks.onQuoteUpdate(this.quote);
        }
      },
      onCandle: (tf, candle) => {
        this.callbacks.onCandleUpdate(tf, candle, null);
      },
      onReconnect: () => {
        this.callbacks.onResyncRequired(this.symbol);
      },
    });
    this.stream.setTrackedTimeframes(this.trackedTimeframes);
    this.stream.start();
  }

  public stop(): void {
    this.stream?.stop();
    this.stream = null;
  }

  public async fetchHistory(timeframe: Timeframe, limit = 450): Promise<Candle[]> {
    return fetchTradingViewHistoricalCandles(this.symbol, timeframe, limit);
  }

  public trackTimeframes(timeframes: Timeframe[]): void {
    this.trackedTimeframes = timeframes;
    this.stream?.setTrackedTimeframes(timeframes);
  }

  public getQuote(): LiveQuote | null {
    if (!this.quote) return null;
    if (!isMetalsMarketOpen()) {
      return {
        ...this.quote,
        marketOpen: false,
        connectionStatus: 'MARKET_CLOSED',
      };
    }
    return this.quote;
  }

  public getProviderStatus(): ProviderStatus {
    if (!isMetalsMarketOpen() && this.status.connectionStatus === 'CONNECTED') {
      return {
        ...this.status,
        connectionStatus: 'MARKET_CLOSED',
      };
    }
    return this.status;
  }
}

export function createInstrumentAdapter(
  symbol: InstrumentSymbol,
  callbacks: AdapterCallbacks
): InstrumentAdapter {
  const meta = getInstrumentMeta(symbol);
  if (meta.assetClass === 'CRYPTO') {
    return new CryptoInstrumentAdapter(
      symbol as Extract<InstrumentSymbol, 'BTCUSDT' | 'ETHUSDT'>,
      callbacks
    );
  }
  return new MetalsInstrumentAdapter(symbol as MetalsSymbol, callbacks);
}
