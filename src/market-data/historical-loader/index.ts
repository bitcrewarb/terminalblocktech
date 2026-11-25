import type { Candle, InstrumentSymbol, Timeframe } from '../../shared/types/index.ts';
import type { InstrumentAdapter } from '../adapters/index.ts';
import { InMemoryCandleSeries } from '../candle-builder/index.ts';

export class HistoricalLoader {
  private readonly inflight = new Map<string, Promise<Candle[]>>();

  public async load(
    adapter: InstrumentAdapter,
    series: InMemoryCandleSeries,
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    limit = 450
  ): Promise<Candle[]> {
    const key = `${symbol}:${timeframe}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const raw = await adapter.fetchHistory(timeframe, limit);
        return series.setHistorical(raw);
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
