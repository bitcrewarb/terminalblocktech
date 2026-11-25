import type {
  Candle,
  InstrumentSymbol,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
  Trendline,
} from '../../shared/types/index.ts';

/**
 * Automatic Trendline & Channel Engine.
 * Uses confirmed pivot highs/lows, minimum pivot separation, volatility-adjusted touch tolerance,
 * and tracks provisional, confirmed, broken, retested, and invalidated states.
 */
export function detectTrendlines(
  candles: Candle[],
  swings: SwingPoint[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): Trendline[] {
  if (candles.length < 25) return [];

  const tol = Math.max(1e-8, atr * settings.zoneTouchToleranceAtr);
  const lastCandle = candles[candles.length - 1];
  const minPivotSep = 6;
  const trendlines: Trendline[] = [];

  const pivotLows = swings
    .filter((s) => s.scope === 'external' && s.kind === 'low' && s.confirmationStatus === 'confirmed')
    .slice(-10);
  const pivotHighs = swings
    .filter((s) => s.scope === 'external' && s.kind === 'high' && s.confirmationStatus === 'confirmed')
    .slice(-10);

  const evaluateLine = (
    p1: SwingPoint,
    p2: SwingPoint,
    kind: 'bullish_support' | 'bearish_resistance'
  ): Trendline | null => {
    if (p2.candleIndex - p1.candleIndex < minPivotSep) return null;
    const dt = p2.candleTime - p1.candleTime;
    if (dt <= 0) return null;

    const slopePerSecond = (p2.price - p1.price) / dt;
    if (kind === 'bullish_support' && slopePerSecond <= 0) return null;
    if (kind === 'bearish_resistance' && slopePerSecond >= 0) return null;

    const projectAt = (t: number) => p1.price + slopePerSecond * (t - p1.candleTime);

    // Ensure no decisive candle body violations between p1 and p2
    let interiorViolations = 0;
    const touchTimes: number[] = [p1.candleTime, p2.candleTime];

    for (let i = p1.candleIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      const linePrice = projectAt(c.time);

      if (i < p2.candleIndex) {
        if (kind === 'bullish_support' && c.close < linePrice - tol) interiorViolations++;
        if (kind === 'bearish_resistance' && c.close > linePrice + tol) interiorViolations++;
      }

      if (i > p2.candleIndex && c.isClosed) {
        if (Math.abs(c.low - linePrice) <= tol || Math.abs(c.high - linePrice) <= tol) {
          if (!touchTimes.includes(c.time)) touchTimes.push(c.time);
        }
      }
    }

    if (interiorViolations > 1) return null;

    // Inspect breakout / retest / invalidation after p2
    let breakoutTime: number | null = null;
    let retestTime: number | null = null;
    let invalidatedAt: number | null = null;

    for (let i = p2.candleIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (!c.isClosed) continue;
      const linePrice = projectAt(c.time);

      if (!breakoutTime) {
        if (kind === 'bullish_support' && c.close < linePrice - tol * 0.5) {
          breakoutTime = c.time;
        } else if (kind === 'bearish_resistance' && c.close > linePrice + tol * 0.5) {
          breakoutTime = c.time;
        }
      } else {
        if (!retestTime && c.low <= linePrice + tol && c.high >= linePrice - tol) {
          retestTime = c.time;
        }
        // Invalidate if price crosses decisively back through the broken line
        if (kind === 'bullish_support' && c.close > linePrice + atr * 1.2) {
          invalidatedAt = c.time;
          break;
        }
        if (kind === 'bearish_resistance' && c.close < linePrice - atr * 1.2) {
          invalidatedAt = c.time;
          break;
        }
      }
    }

    const touches = touchTimes.length;
    const isConfirmed = touches >= settings.trendlineMinTouches;
    if (!isConfirmed && !settings.showProvisional) return null;

    const status: Trendline['status'] = invalidatedAt
      ? 'invalidated'
      : retestTime
        ? 'retested'
        : breakoutTime
          ? 'broken'
          : isConfirmed
            ? 'confirmed'
            : 'provisional';

    return {
      id: `${symbol}:${timeframe}:tl:${kind}:${p1.candleTime}:${p2.candleTime}`,
      symbol,
      timeframe,
      kind,
      p1Time: p1.candleTime,
      p1Price: p1.price,
      p2Time: p2.candleTime,
      p2Price: p2.price,
      slopePerSecond,
      touches,
      touchTimes,
      status,
      breakoutTime,
      retestTime,
      currentProjectedPrice: projectAt(lastCandle.time),
      formationTime: p1.candleTime,
      confirmationTime: isConfirmed ? p2.confirmationTime : null,
      detectionTime: p2.detectionTime,
      invalidationTime: invalidatedAt,
      confirmationStatus:
        status === 'invalidated'
          ? 'invalidated'
          : status === 'provisional'
            ? 'provisional'
            : 'confirmed',
    };
  };

  // Evaluate recent pairs and pick cleanest non-redundant lines
  const bullLines: Trendline[] = [];
  for (let i = 0; i < pivotLows.length; i++) {
    for (let j = i + 1; j < pivotLows.length; j++) {
      const tl = evaluateLine(pivotLows[i], pivotLows[j], 'bullish_support');
      if (tl && tl.status !== 'invalidated') bullLines.push(tl);
    }
  }

  const bearLines: Trendline[] = [];
  for (let i = 0; i < pivotHighs.length; i++) {
    for (let j = i + 1; j < pivotHighs.length; j++) {
      const tl = evaluateLine(pivotHighs[i], pivotHighs[j], 'bearish_resistance');
      if (tl && tl.status !== 'invalidated') bearLines.push(tl);
    }
  }

  const bestBull = bullLines
    .sort((a, b) => b.touches - a.touches || b.p2Time - a.p2Time)
    .slice(0, 2);
  const bestBear = bearLines
    .sort((a, b) => b.touches - a.touches || b.p2Time - a.p2Time)
    .slice(0, 2);

  trendlines.push(...bestBull, ...bestBear);

  // Detect Parallel / Ascending / Descending Channel if slope alignment matches
  if (bestBull.length > 0 && bestBear.length > 0) {
    const b = bestBull[0];
    const r = bestBear[0];
    const relSlopeDiff =
      Math.abs(b.slopePerSecond - r.slopePerSecond) /
      Math.max(1e-12, Math.abs(b.slopePerSecond) + Math.abs(r.slopePerSecond));
    if (relSlopeDiff < 0.35) {
      const kind: Trendline['kind'] =
        b.slopePerSecond > 0
          ? 'ascending_channel'
          : r.slopePerSecond < 0
            ? 'descending_channel'
            : 'parallel_channel';
      trendlines.push({
        ...b,
        id: `${symbol}:${timeframe}:tl:channel:${b.p1Time}:${r.p1Time}`,
        kind,
        channelOffset: r.currentProjectedPrice - b.currentProjectedPrice,
      });
    }
  }

  return trendlines;
}
