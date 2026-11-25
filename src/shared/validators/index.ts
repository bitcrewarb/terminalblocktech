import { TIMEFRAME_SECONDS } from '../constants/index.ts';
import type { Candle, InstrumentSymbol, Timeframe } from '../types/index.ts';

export function isValidInstrument(value: string): value is InstrumentSymbol {
  return value === 'XAUUSD' || value === 'XAGUSD' || value === 'BTCUSDT' || value === 'ETHUSDT';
}

export function isValidTimeframe(value: string): value is Timeframe {
  return value in TIMEFRAME_SECONDS;
}

export function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    c.time > 0 &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume) &&
    c.open > 0 &&
    c.high >= c.low &&
    c.high >= c.open &&
    c.high >= c.close &&
    c.low <= c.open &&
    c.low <= c.close &&
    c.volume >= 0
  );
}

export interface IntegrityCheckResult {
  candles: Candle[];
  duplicatesRemoved: number;
  outOfOrderFixed: number;
  missingIntervals: number[];
}

/**
 * Validates, deduplicates, sorts chronologically, and detects missing candle intervals.
 * Prevents duplicate candles and out-of-order updates per Data Integrity Requirements.
 */
export function sanitizeAndInspectCandles(
  raw: Candle[],
  timeframe: Timeframe,
  is24x7Market: boolean
): IntegrityCheckResult {
  const map = new Map<number, Candle>();
  let duplicatesRemoved = 0;

  for (const c of raw) {
    if (!isValidCandle(c)) continue;
    const existing = map.get(c.time);
    if (existing) {
      duplicatesRemoved++;
      // Keep the more up-to-date or closed candle
      if (c.isClosed || !existing.isClosed) {
        map.set(c.time, c);
      }
    } else {
      map.set(c.time, c);
    }
  }

  const arr = Array.from(map.values());
  let outOfOrderFixed = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].time < arr[i - 1].time) {
      outOfOrderFixed++;
    }
  }
  arr.sort((a, b) => a.time - b.time);

  const missingIntervals: number[] = [];
  const step = TIMEFRAME_SECONDS[timeframe];
  if (is24x7Market && timeframe !== '1M' && arr.length > 1) {
    for (let i = 1; i < arr.length; i++) {
      const diff = arr[i].time - arr[i - 1].time;
      if (diff > step * 1.5) {
        for (let t = arr[i - 1].time + step; t < arr[i].time; t += step) {
          missingIntervals.push(t);
          if (missingIntervals.length >= 25) break;
        }
      }
      if (missingIntervals.length >= 25) break;
    }
  }

  return {
    candles: arr,
    duplicatesRemoved,
    outOfOrderFixed,
    missingIntervals,
  };
}

export function alignTimestampToTimeframe(epochSeconds: number, timeframe: Timeframe): number {
  if (timeframe === '1M') {
    const d = new Date(epochSeconds * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0) / 1000);
  }
  if (timeframe === '1W') {
    // Align to Monday 00:00 UTC
    const daySec = 86400;
    const daysSinceEpoch = Math.floor(epochSeconds / daySec);
    // 1970-01-01 was Thursday (day 4). Monday offset is +3 mod 7.
    const daysSinceMonday = (daysSinceEpoch + 3) % 7;
    return (daysSinceEpoch - daysSinceMonday) * daySec;
  }
  const step = TIMEFRAME_SECONDS[timeframe];
  return Math.floor(epochSeconds / step) * step;
}
