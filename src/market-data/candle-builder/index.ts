import type { Candle, Timeframe } from '../../shared/types/index.ts';
import {
  alignTimestampToTimeframe,
  isValidCandle,
  sanitizeAndInspectCandles,
} from '../../shared/validators/index.ts';

export interface CandleUpdateResult {
  candles: Candle[];
  updatedCandle: Candle;
  closedPreviousCandle: Candle | null;
  rejectedReason?: string;
}

/**
 * In-memory candle cache & incremental builder for a single (symbol, timeframe).
 * Prevents duplicates, out-of-order updates, and corrupt OHLC candles.
 */
export class InMemoryCandleSeries {
  private candles: Candle[] = [];
  private readonly maxBars: number;
  private readonly timeframe: Timeframe;
  private readonly is24x7: boolean;

  public duplicatesRemoved = 0;
  public outOfOrderFixed = 0;
  public missingIntervals: number[] = [];

  constructor(timeframe: Timeframe, is24x7: boolean, maxBars = 1000) {
    this.timeframe = timeframe;
    this.is24x7 = is24x7;
    this.maxBars = maxBars;
  }

  public setHistorical(rawCandles: Candle[]): Candle[] {
    const inspected = sanitizeAndInspectCandles(rawCandles, this.timeframe, this.is24x7);
    this.duplicatesRemoved += inspected.duplicatesRemoved;
    this.outOfOrderFixed += inspected.outOfOrderFixed;
    this.missingIntervals = inspected.missingIntervals;

    const sliced =
      inspected.candles.length > this.maxBars
        ? inspected.candles.slice(inspected.candles.length - this.maxBars)
        : inspected.candles;

    this.candles = sliced;
    return this.candles;
  }

  public getCandles(): Candle[] {
    return this.candles;
  }

  public getLatest(): Candle | null {
    return this.candles.length > 0 ? this.candles[this.candles.length - 1] : null;
  }

  /**
   * Applies an incoming live kline candle from a WebSocket or REST poll.
   * Rejects out-of-order older candles to guarantee non-repainting integrity.
   */
  public applyCandle(incoming: Candle): CandleUpdateResult {
    if (!isValidCandle(incoming)) {
      const latest = this.getLatest();
      return {
        candles: this.candles,
        updatedCandle: latest ?? incoming,
        closedPreviousCandle: null,
        rejectedReason: 'Invalid OHLCV invariants',
      };
    }

    const alignedTime = alignTimestampToTimeframe(incoming.time, this.timeframe);
    const normalized: Candle = { ...incoming, time: alignedTime };

    if (this.candles.length === 0) {
      this.candles = [normalized];
      return {
        candles: this.candles,
        updatedCandle: normalized,
        closedPreviousCandle: null,
      };
    }

    const lastIdx = this.candles.length - 1;
    const last = this.candles[lastIdx];

    if (normalized.time < last.time) {
      return {
        candles: this.candles,
        updatedCandle: last,
        closedPreviousCandle: null,
        rejectedReason: `Out-of-order candle (${normalized.time} < ${last.time})`,
      };
    }

    if (normalized.time === last.time) {
      // Update active or finalize closed bar
      const merged: Candle = {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, normalized.high),
        low: Math.min(last.low, normalized.low),
        close: normalized.close,
        volume: Math.max(last.volume, normalized.volume),
        isClosed: last.isClosed || normalized.isClosed,
      };
      this.candles[lastIdx] = merged;
      return {
        candles: this.candles,
        updatedCandle: merged,
        closedPreviousCandle: !last.isClosed && merged.isClosed ? merged : null,
      };
    }

    // New bar started -> mark previous bar closed if it wasn't already
    let closedPreviousCandle: Candle | null = null;
    if (!last.isClosed) {
      closedPreviousCandle = { ...last, isClosed: true };
      this.candles[lastIdx] = closedPreviousCandle;
    }

    this.candles.push(normalized);
    if (this.candles.length > this.maxBars) {
      this.candles.shift();
    }

    return {
      candles: this.candles,
      updatedCandle: normalized,
      closedPreviousCandle,
    };
  }

  /**
   * Applies a single tick/trade price update into the current candle bucket.
   */
  public applyTick(price: number, timestampSec: number, volumeDelta = 0): CandleUpdateResult | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampSec)) {
      return null;
    }
    const bucket = alignTimestampToTimeframe(timestampSec, this.timeframe);
    const last = this.getLatest();

    if (last && bucket < last.time) {
      return null; // Ignore stale out-of-order tick
    }

    if (last && bucket === last.time) {
      return this.applyCandle({
        time: bucket,
        open: last.open,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
        volume: last.volume + Math.max(0, volumeDelta),
        isClosed: false,
      });
    }

    return this.applyCandle({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Math.max(0, volumeDelta),
      isClosed: false,
    });
  }
}
