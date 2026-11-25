import type {
  Candle,
  DealingRange,
  InstrumentSymbol,
  SwingPoint,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Computes Dealing Range, Equilibrium (50%), Premium/Discount zones,
 * and Optimal Trade Entry (62%, 70.5%, 79%) levels from confirmed swings or custom swing range.
 */
export function computeDealingRange(
  candles: Candle[],
  swings: SwingPoint[],
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  sourceTimeframe: Timeframe = timeframe,
  customSwingLookback?: number
): DealingRange | null {
  if (candles.length < 10) return null;

  const currentPrice = candles[candles.length - 1].close;
  const confirmedExtHighs = swings.filter(
    (s) => s.scope === 'external' && s.kind === 'high' && s.confirmationStatus === 'confirmed'
  );
  const confirmedExtLows = swings.filter(
    (s) => s.scope === 'external' && s.kind === 'low' && s.confirmationStatus === 'confirmed'
  );

  let rangeHigh: number;
  let rangeLow: number;
  let highTime: number;
  let lowTime: number;

  if (
    !customSwingLookback &&
    confirmedExtHighs.length > 0 &&
    confirmedExtLows.length > 0
  ) {
    // Use the latest major swing leg
    const lastHigh = confirmedExtHighs[confirmedExtHighs.length - 1];
    const lastLow = confirmedExtLows[confirmedExtLows.length - 1];
    rangeHigh = lastHigh.price;
    rangeLow = lastLow.price;
    highTime = lastHigh.candleTime;
    lowTime = lastLow.candleTime;

    // Ensure range covers meaningful span
    if (rangeHigh <= rangeLow) {
      const slice = candles.slice(-80);
      let maxC = slice[0];
      let minC = slice[0];
      for (const c of slice) {
        if (c.high > maxC.high) maxC = c;
        if (c.low < minC.low) minC = c;
      }
      rangeHigh = maxC.high;
      highTime = maxC.time;
      rangeLow = minC.low;
      lowTime = minC.time;
    }
  } else {
    const lookback = customSwingLookback ?? Math.min(120, candles.length);
    const slice = candles.slice(-lookback);
    let maxC = slice[0];
    let minC = slice[0];
    for (const c of slice) {
      if (c.high > maxC.high) maxC = c;
      if (c.low < minC.low) minC = c;
    }
    rangeHigh = maxC.high;
    highTime = maxC.time;
    rangeLow = minC.low;
    lowTime = minC.time;
  }

  const span = rangeHigh - rangeLow;
  if (span <= 0) return null;

  const isUpswing = lowTime <= highTime;
  const equilibrium = rangeLow + span * 0.5;
  // Retracements from the impulse direction
  const fib62 = isUpswing ? rangeHigh - span * 0.62 : rangeLow + span * 0.62;
  const ote705 = isUpswing ? rangeHigh - span * 0.705 : rangeLow + span * 0.705;
  const fib79 = isUpswing ? rangeHigh - span * 0.79 : rangeLow + span * 0.79;

  const pctFromLow = ((currentPrice - rangeLow) / span) * 100;
  let currentPosition: DealingRange['currentPosition'] = 'equilibrium';
  if (pctFromLow > 52) currentPosition = 'premium';
  else if (pctFromLow < 48) currentPosition = 'discount';

  const retracementPercent = isUpswing
    ? ((rangeHigh - currentPrice) / span) * 100
    : ((currentPrice - rangeLow) / span) * 100;

  const oteLow = Math.min(fib62, fib79);
  const oteHigh = Math.max(fib62, fib79);
  const inOteZone = currentPrice >= oteLow && currentPrice <= oteHigh;

  return {
    id: `${symbol}:${timeframe}:dealing_range:${highTime}:${lowTime}`,
    symbol,
    timeframe,
    sourceTimeframe,
    rangeHigh,
    rangeLow,
    equilibrium,
    fib62,
    ote705,
    fib79,
    highTime,
    lowTime,
    currentPosition,
    retracementPercent: Number(retracementPercent.toFixed(1)),
    inOteZone,
  };
}
