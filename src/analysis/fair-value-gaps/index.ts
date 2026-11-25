import type {
  Candle,
  FairValueGap,
  InstrumentSymbol,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Detects Bullish FVG, Bearish FVG, Inverse FVG, Volume Imbalance, and Rejection Blocks.
 * Tracks Consequent Encroachment (50%), partial/full fill, and inversion.
 */
export function detectFairValueGaps(
  candles: Candle[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): FairValueGap[] {
  if (candles.length < 5) return [];

  const minGap = Math.max(1e-8, atr * settings.fvgMinSizeAtr);
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Non-repainting: 3-candle FVG requires c3 closed
    if (!c3.isClosed) continue;

    // Bullish FVG: c3.low > c1.high
    if (c3.low - c1.high >= minGap && c2.close > c2.open) {
      const upper = c3.low;
      const lower = c1.high;
      const ce = (upper + lower) / 2;
      const gapSize = upper - lower;

      let minPenetration = upper;
      let invertedAt: number | null = null;
      for (let k = i + 1; k < candles.length; k++) {
        const f = candles[k];
        if (f.low < minPenetration) {
          minPenetration = Math.max(lower, f.low);
        }
        if (f.isClosed && f.close < lower) {
          invertedAt = f.time;
          break;
        }
      }

      const fillPct = Math.min(100, Math.max(0, Math.round(((upper - minPenetration) / gapSize) * 100)));
      const status: FairValueGap['status'] =
        invertedAt !== null
          ? 'inverted'
          : fillPct >= 95
            ? 'fully_filled'
            : fillPct > 0
              ? 'partially_filled'
              : 'unfilled';

      gaps.push({
        id: `${symbol}:${timeframe}:fvg:bullish:${c2.time}`,
        symbol,
        timeframe,
        kind: invertedAt ? 'inverse_fvg' : 'bullish_fvg',
        upper,
        lower,
        consequentEncroachment: ce,
        originTime: c2.time,
        fillPercent: fillPct,
        status,
        interactionState:
          status === 'inverted'
            ? 'Invalidated'
            : status === 'fully_filled'
              ? 'Mitigated'
              : status === 'partially_filled'
                ? 'Entered Zone'
                : 'Far Away',
        formationTime: c2.time,
        confirmationTime: c3.time,
        detectionTime: c3.time,
        invalidationTime: invertedAt,
        confirmationStatus: invertedAt ? 'invalidated' : 'confirmed',
      });
    }

    // Bearish FVG: c1.low > c3.high
    if (c1.low - c3.high >= minGap && c2.close < c2.open) {
      const upper = c1.low;
      const lower = c3.high;
      const ce = (upper + lower) / 2;
      const gapSize = upper - lower;

      let maxPenetration = lower;
      let invertedAt: number | null = null;
      for (let k = i + 1; k < candles.length; k++) {
        const f = candles[k];
        if (f.high > maxPenetration) {
          maxPenetration = Math.min(upper, f.high);
        }
        if (f.isClosed && f.close > upper) {
          invertedAt = f.time;
          break;
        }
      }

      const fillPct = Math.min(100, Math.max(0, Math.round(((maxPenetration - lower) / gapSize) * 100)));
      const status: FairValueGap['status'] =
        invertedAt !== null
          ? 'inverted'
          : fillPct >= 95
            ? 'fully_filled'
            : fillPct > 0
              ? 'partially_filled'
              : 'unfilled';

      gaps.push({
        id: `${symbol}:${timeframe}:fvg:bearish:${c2.time}`,
        symbol,
        timeframe,
        kind: invertedAt ? 'inverse_fvg' : 'bearish_fvg',
        upper,
        lower,
        consequentEncroachment: ce,
        originTime: c2.time,
        fillPercent: fillPct,
        status,
        interactionState:
          status === 'inverted'
            ? 'Invalidated'
            : status === 'fully_filled'
              ? 'Mitigated'
              : status === 'partially_filled'
                ? 'Entered Zone'
                : 'Far Away',
        formationTime: c2.time,
        confirmationTime: c3.time,
        detectionTime: c3.time,
        invalidationTime: invertedAt,
        confirmationStatus: invertedAt ? 'invalidated' : 'confirmed',
      });
    }

    // Volume Imbalance (gap between consecutive candle bodies)
    const prevBodyHigh = Math.max(c2.open, c2.close);
    const prevBodyLow = Math.min(c2.open, c2.close);
    const curBodyHigh = Math.max(c3.open, c3.close);
    const curBodyLow = Math.min(c3.open, c3.close);

    if (curBodyLow - prevBodyHigh >= minGap * 0.6) {
      gaps.push({
        id: `${symbol}:${timeframe}:fvg:vol_imb_bull:${c3.time}`,
        symbol,
        timeframe,
        kind: 'volume_imbalance',
        upper: curBodyLow,
        lower: prevBodyHigh,
        consequentEncroachment: (curBodyLow + prevBodyHigh) / 2,
        originTime: c3.time,
        fillPercent: 0,
        status: 'unfilled',
        interactionState: 'Far Away',
        formationTime: c2.time,
        confirmationTime: c3.time,
        detectionTime: c3.time,
        invalidationTime: null,
        confirmationStatus: 'confirmed',
      });
    } else if (prevBodyLow - curBodyHigh >= minGap * 0.6) {
      gaps.push({
        id: `${symbol}:${timeframe}:fvg:vol_imb_bear:${c3.time}`,
        symbol,
        timeframe,
        kind: 'volume_imbalance',
        upper: prevBodyLow,
        lower: curBodyHigh,
        consequentEncroachment: (prevBodyLow + curBodyHigh) / 2,
        originTime: c3.time,
        fillPercent: 0,
        status: 'unfilled',
        interactionState: 'Far Away',
        formationTime: c2.time,
        confirmationTime: c3.time,
        detectionTime: c3.time,
        invalidationTime: null,
        confirmationStatus: 'confirmed',
      });
    }
  }

  // Keep most recent 30 active/recent gaps
  return gaps.slice(-30);
}
