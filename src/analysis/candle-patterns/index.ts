import type {
  Candle,
  CandlestickPattern,
  InstrumentSymbol,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Deterministic Candlestick Pattern Recognition Engine (all 22 requested patterns).
 * Non-repainting: only scans closed candles (or latest candle as provisional if enabled).
 */
export function detectCandlestickPatterns(
  candles: Candle[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): CandlestickPattern[] {
  if (candles.length < 10) return [];

  const patterns: CandlestickPattern[] = [];
  const sensitivity = Math.max(1, Math.min(10, settings.patternSensitivity));
  // Higher sensitivity slightly relaxes body/doji tolerances
  const dojiBodyRatio = 0.08 + sensitivity * 0.01;
  const tweezerTol = atr * (0.04 + sensitivity * 0.008);

  const avgBody = (endIdx: number, len = 10) => {
    const start = Math.max(0, endIdx - len);
    let sum = 0;
    let count = 0;
    for (let k = start; k < endIdx; k++) {
      sum += Math.abs(candles[k].close - candles[k].open);
      count++;
    }
    return Math.max(1e-8, sum / Math.max(1, count));
  };

  const recentTrend = (idx: number, lookback = 5): 'up' | 'down' | 'flat' => {
    if (idx < lookback) return 'flat';
    const diff = candles[idx - 1].close - candles[idx - lookback].open;
    if (diff > atr * 0.5) return 'up';
    if (diff < -atr * 0.5) return 'down';
    return 'flat';
  };

  const startScan = Math.max(5, candles.length - 180);

  for (let i = startScan; i < candles.length; i++) {
    const c = candles[i];
    if (!c.isClosed && !settings.showProvisional) continue;

    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const range = Math.max(1e-8, c.high - c.low);
    const body = Math.abs(c.close - c.open);
    const bodyTop = Math.max(c.open, c.close);
    const bodyBot = Math.min(c.open, c.close);
    const upperWick = c.high - bodyTop;
    const lowerWick = bodyBot - c.low;
    const isBull = c.close > c.open;
    const isBear = c.close < c.open;
    const ab = avgBody(i);
    const trend = recentTrend(i);
    const confStatus = c.isClosed ? 'confirmed' : 'provisional';
    const confTime = c.isClosed ? c.time : null;

    const push = (
      name: CandlestickPattern['name'],
      category: CandlestickPattern['category'],
      direction: CandlestickPattern['direction'],
      bars: Candle[],
      invalidationLevel: number,
      qualityScore: number,
      description: string
    ) => {
      const highBound = Math.max(...bars.map((b) => b.high));
      const lowBound = Math.min(...bars.map((b) => b.low));
      patterns.push({
        id: `${symbol}:${timeframe}:cp:${name}:${c.time}`,
        symbol,
        timeframe,
        name,
        category,
        direction,
        startTime: bars[0].time,
        endTime: bars[bars.length - 1].time,
        highBound,
        lowBound,
        formationPrice: c.close,
        invalidationLevel,
        qualityScore: Math.min(98, Math.max(40, Math.round(qualityScore))),
        candleTimes: bars.map((b) => b.time),
        description,
        formationTime: bars[0].time,
        confirmationTime: confTime,
        detectionTime: c.time,
        invalidationTime: null,
        confirmationStatus: confStatus,
      });
    };

    const c1Body = Math.abs(c1.close - c1.open);
    const c1Bull = c1.close > c1.open;
    const c1Bear = c1.close < c1.open;

    // 1. Marubozu
    if (body >= ab * 1.4 && upperWick <= range * 0.08 && lowerWick <= range * 0.08) {
      push(
        'Marubozu',
        'continuation',
        isBull ? 'bullish' : 'bearish',
        [c],
        isBull ? c.low : c.high,
        78 + Math.min(18, (body / ab) * 5),
        `${isBull ? 'Bullish' : 'Bearish'} full-bodied momentum candle with minimal wicks.`
      );
      continue;
    }

    // 2. Three White Soldiers / Three Black Crows
    if (
      c2.close > c2.open &&
      c1Bull &&
      isBull &&
      c1.open >= c2.open &&
      c1.close > c2.close &&
      c.open >= c1.open &&
      c.close > c1.close &&
      body >= ab * 0.7 &&
      c1Body >= ab * 0.7
    ) {
      push(
        'Three White Soldiers',
        'reversal',
        'bullish',
        [c2, c1, c],
        c2.low,
        88,
        'Three consecutive strong bullish closes signaling sustained buyer control.'
      );
      continue;
    }

    if (
      c2.close < c2.open &&
      c1Bear &&
      isBear &&
      c1.open <= c2.open &&
      c1.close < c2.close &&
      c.open <= c1.open &&
      c.close < c1.close &&
      body >= ab * 0.7 &&
      c1Body >= ab * 0.7
    ) {
      push(
        'Three Black Crows',
        'reversal',
        'bearish',
        [c2, c1, c],
        c2.high,
        88,
        'Three consecutive strong bearish closes signaling aggressive seller control.'
      );
      continue;
    }

    // 3. Morning Star / Evening Star
    const c2Body = Math.abs(c2.close - c2.open);
    const c1Small = c1Body <= ab * 0.55;
    if (
      c2.close < c2.open &&
      c2Body >= ab * 0.8 &&
      c1Small &&
      isBull &&
      c.close > (c2.open + c2.close) / 2
    ) {
      push(
        'Morning Star',
        'reversal',
        'bullish',
        [c2, c1, c],
        Math.min(c2.low, c1.low, c.low),
        86,
        'Three-candle bullish reversal closing above midpoint of initial bearish leg.'
      );
      continue;
    }

    if (
      c2.close > c2.open &&
      c2Body >= ab * 0.8 &&
      c1Small &&
      isBear &&
      c.close < (c2.open + c2.close) / 2
    ) {
      push(
        'Evening Star',
        'reversal',
        'bearish',
        [c2, c1, c],
        Math.max(c2.high, c1.high, c.high),
        86,
        'Three-candle bearish reversal closing below midpoint of initial bullish leg.'
      );
      continue;
    }

    // 4. Bullish / Bearish Engulfing
    if (c1Bear && isBull && c.open <= c1.close && c.close >= c1.open && body > c1Body * 1.05) {
      push(
        'Bullish Engulfing',
        'reversal',
        'bullish',
        [c1, c],
        Math.min(c1.low, c.low),
        82 + (trend === 'down' ? 8 : 0),
        'Bullish body completely engulfs prior bearish candle body.'
      );
      continue;
    }

    if (c1Bull && isBear && c.open >= c1.close && c.close <= c1.open && body > c1Body * 1.05) {
      push(
        'Bearish Engulfing',
        'reversal',
        'bearish',
        [c1, c],
        Math.max(c1.high, c.high),
        82 + (trend === 'up' ? 8 : 0),
        'Bearish body completely engulfs prior bullish candle body.'
      );
      continue;
    }

    // 5. Piercing Pattern / Dark Cloud Cover
    if (
      c1Bear &&
      c1Body >= ab * 0.8 &&
      isBull &&
      c.open <= c1.close &&
      c.close > (c1.open + c1.close) / 2 &&
      c.close < c1.open
    ) {
      push(
        'Piercing Pattern',
        'reversal',
        'bullish',
        [c1, c],
        Math.min(c1.low, c.low),
        76,
        'Bullish candle opens below prior close and reclaims over 50% of prior bearish body.'
      );
      continue;
    }

    if (
      c1Bull &&
      c1Body >= ab * 0.8 &&
      isBear &&
      c.open >= c1.close &&
      c.close < (c1.open + c1.close) / 2 &&
      c.close > c1.open
    ) {
      push(
        'Dark Cloud Cover',
        'reversal',
        'bearish',
        [c1, c],
        Math.max(c1.high, c.high),
        76,
        'Bearish candle opens at/above prior close and penetrates below 50% of prior bullish body.'
      );
      continue;
    }

    // 6. Bullish / Bearish Harami
    if (
      c1Bear &&
      c1Body >= ab * 0.9 &&
      isBull &&
      bodyTop <= c1.open &&
      bodyBot >= c1.close &&
      body < c1Body * 0.65
    ) {
      push(
        'Bullish Harami',
        'reversal',
        'bullish',
        [c1, c],
        c1.low,
        72,
        'Compact bullish body contained inside preceding bearish expansion candle.'
      );
      continue;
    }

    if (
      c1Bull &&
      c1Body >= ab * 0.9 &&
      isBear &&
      bodyTop <= c1.close &&
      bodyBot >= c1.open &&
      body < c1Body * 0.65
    ) {
      push(
        'Bearish Harami',
        'reversal',
        'bearish',
        [c1, c],
        c1.high,
        72,
        'Compact bearish body contained inside preceding bullish expansion candle.'
      );
      continue;
    }

    // 7. Tweezer Top / Tweezer Bottom
    if (trend === 'up' && c1Bull && isBear && Math.abs(c.high - c1.high) <= tweezerTol) {
      push(
        'Tweezer Top',
        'reversal',
        'bearish',
        [c1, c],
        Math.max(c1.high, c.high),
        74,
        'Matching double rejection highs signaling overhead resistance.'
      );
      continue;
    }

    if (trend === 'down' && c1Bear && isBull && Math.abs(c.low - c1.low) <= tweezerTol) {
      push(
        'Tweezer Bottom',
        'reversal',
        'bullish',
        [c1, c],
        Math.min(c1.low, c.low),
        74,
        'Matching double rejection lows signaling demand defense.'
      );
      continue;
    }

    // 8. Outside Bar / Inside Bar
    if (c.high > c1.high && c.low < c1.low && body >= ab * 0.7) {
      push(
        'Outside Bar',
        'continuation',
        isBull ? 'bullish' : 'bearish',
        [c1, c],
        isBull ? c.low : c.high,
        70,
        'Full high-low range expansion engulfing previous bar range.'
      );
      continue;
    }

    if (c.high < c1.high && c.low > c1.low) {
      push(
        'Inside Bar',
        'indecision',
        'neutral',
        [c1, c],
        c1.low,
        66,
        'Volatility contraction inside prior bar range preceding expansion.'
      );
      continue;
    }

    // 9. Doji family (Dragonfly, Gravestone, Classic Doji)
    if (body <= range * dojiBodyRatio && range >= atr * 0.35) {
      if (lowerWick >= range * 0.6 && upperWick <= range * 0.15) {
        push(
          'Dragonfly Doji',
          'reversal',
          'bullish',
          [c],
          c.low,
          75,
          'Long lower rejection wick with open/close near session high.'
        );
      } else if (upperWick >= range * 0.6 && lowerWick <= range * 0.15) {
        push(
          'Gravestone Doji',
          'reversal',
          'bearish',
          [c],
          c.high,
          75,
          'Long upper rejection wick with open/close near session low.'
        );
      } else {
        push(
          'Doji',
          'indecision',
          'neutral',
          [c],
          c.low,
          64,
          'Equilibrium candle where open and close converge.'
        );
      }
      continue;
    }

    // 10. Pin Bar / Single-candle Reversals: Hammer, Hanging Man, Inverted Hammer, Shooting Star
    if (lowerWick >= body * 2.0 && upperWick <= Math.max(body * 0.6, range * 0.15) && range >= atr * 0.45) {
      if (trend === 'up') {
        push(
          'Hanging Man',
          'reversal',
          'bearish',
          [c],
          c.high,
          71,
          'Long lower shadow appearing after an upswing, warning of exhaustion.'
        );
      } else {
        push(
          'Hammer',
          'reversal',
          'bullish',
          [c],
          c.low,
          77 + (trend === 'down' ? 7 : 0),
          'Strong lower wick rejection with close near the candle high.'
        );
      }
      continue;
    }

    if (upperWick >= body * 2.0 && lowerWick <= Math.max(body * 0.6, range * 0.15) && range >= atr * 0.45) {
      if (trend === 'up') {
        push(
          'Shooting Star',
          'reversal',
          'bearish',
          [c],
          c.high,
          77,
          'Upper wick rejection after rally signaling supply absorption.'
        );
      } else {
        push(
          'Inverted Hammer',
          'reversal',
          'bullish',
          [c],
          c.low,
          70,
          'Upper probe after decline indicating emerging buyer test.'
        );
      }
    }
  }

  // Keep latest 36 detections so chart stays crisp
  return patterns.slice(-36);
}
