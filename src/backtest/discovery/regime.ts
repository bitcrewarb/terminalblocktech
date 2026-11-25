import type { Candle, MarketRegimeType } from '../../shared/types/index.ts';

export const ALL_MARKET_REGIMES: readonly MarketRegimeType[] = [
  'Trending',
  'Ranging',
  'High Volatility',
  'Low Volatility',
  'Transitional',
] as const;

export interface CausalRegimeBarFeature {
  time: number;
  regime: MarketRegimeType;
  atr: number;
  atrPercent: number;
  volRatio: number;
  volPercentile: number;
  adx: number;
  efficiencyRatio: number;
  emaSeparationAtr: number;
}

/**
 * Classifies every candle bar causally using ONLY bars [0..i] (zero lookahead).
 * Deterministic mathematical indicators:
 * - Wilder ATR(14) & rolling 100-bar volatility percentile / median ratio
 * - Wilder ADX(14) directional strength
 * - Kaufman Efficiency Ratio ER(20)
 * - EMA(20) vs EMA(50) separation normalized by ATR
 */
export function classifyMarketRegimesCausally(candles: Candle[]): CausalRegimeBarFeature[] {
  const n = candles.length;
  if (n === 0) return [];

  const features: CausalRegimeBarFeature[] = new Array(n);

  const period = 14;
  let prevClose = candles[0].close;
  let prevHigh = candles[0].high;
  let prevLow = candles[0].low;

  let atr = Math.max(1e-8, candles[0].high - candles[0].low);
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  let smoothTr = atr;
  let adx = 18;

  const k20 = 2 / (20 + 1);
  const k50 = 2 / (50 + 1);
  let ema20 = candles[0].close;
  let ema50 = candles[0].close;

  const atrPctHistory: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const hl = Math.max(1e-8, c.high - c.low);
    const tr =
      i === 0
        ? hl
        : Math.max(hl, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));

    // Causal Wilder ATR(14)
    if (i === 0) {
      atr = tr;
      smoothTr = tr;
    } else if (i < period) {
      atr = ((atr * i) + tr) / (i + 1);
      smoothTr = atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      smoothTr = (smoothTr * (period - 1) + tr) / period;
    }

    // Causal +DM / -DM & ADX(14)
    if (i > 0) {
      const upMove = c.high - prevHigh;
      const downMove = prevLow - c.low;
      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

      if (i < period) {
        smoothPlusDm = ((smoothPlusDm * (i - 1)) + plusDm) / i;
        smoothMinusDm = ((smoothMinusDm * (i - 1)) + minusDm) / i;
      } else {
        smoothPlusDm = (smoothPlusDm * (period - 1) + plusDm) / period;
        smoothMinusDm = (smoothMinusDm * (period - 1) + minusDm) / period;
      }

      const denom = Math.max(1e-8, smoothTr);
      const plusDi = (smoothPlusDm / denom) * 100;
      const minusDi = (smoothMinusDm / denom) * 100;
      const diSum = plusDi + minusDi;
      const dx = diSum > 1e-6 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;
      adx = i < period ? (adx * 0.8 + dx * 0.2) : (adx * (period - 1) + dx) / period;
    }

    // Causal EMA(20) & EMA(50)
    if (i > 0) {
      ema20 = c.close * k20 + ema20 * (1 - k20);
      ema50 = c.close * k50 + ema50 * (1 - k50);
    }

    // Causal Kaufman Efficiency Ratio over past 20 closed bars [max(0, i-20)..i]
    const erLookback = Math.min(20, i);
    let er = 0;
    if (erLookback >= 4) {
      const netChange = Math.abs(c.close - candles[i - erLookback].close);
      let pathSum = 0;
      for (let k = i - erLookback + 1; k <= i; k++) {
        pathSum += Math.abs(candles[k].close - candles[k - 1].close);
      }
      er = pathSum > 1e-8 ? netChange / pathSum : 0;
    }

    const price = Math.max(1e-8, c.close);
    const atrPercent = (atr / price) * 100;
    atrPctHistory.push(atrPercent);

    // Causal rolling 100-bar volatility baseline [max(0, i-99)..i]
    const histStart = Math.max(0, atrPctHistory.length - 100);
    const volWindow = atrPctHistory.slice(histStart);
    let volPercentile = 0.5;
    let volRatio = 1.0;

    if (volWindow.length >= 12) {
      let countBelowOrEq = 0;
      for (const v of volWindow) {
        if (v <= atrPercent) countBelowOrEq += 1;
      }
      volPercentile = countBelowOrEq / volWindow.length;

      const sorted = [...volWindow].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || atrPercent;
      volRatio = median > 1e-8 ? atrPercent / median : 1.0;
    }

    const emaSeparationAtr = atr > 1e-8 ? Math.abs(ema20 - ema50) / atr : 0;

    // Deterministic causal regime decision tree (mutually exclusive)
    let regime: MarketRegimeType;
    if (volWindow.length >= 16 && (volPercentile >= 0.82 || volRatio >= 1.42)) {
      regime = 'High Volatility';
    } else if (volWindow.length >= 16 && (volPercentile <= 0.18 || volRatio <= 0.7)) {
      regime = 'Low Volatility';
    } else if (adx >= 23 && (er >= 0.27 || emaSeparationAtr >= 0.65)) {
      regime = 'Trending';
    } else if (adx < 19 && er < 0.27 && emaSeparationAtr < 0.85) {
      regime = 'Ranging';
    } else {
      regime = 'Transitional';
    }

    features[i] = {
      time: c.time,
      regime,
      atr,
      atrPercent,
      volRatio,
      volPercentile,
      adx,
      efficiencyRatio: er,
      emaSeparationAtr,
    };

    prevClose = c.close;
    prevHigh = c.high;
    prevLow = c.low;
  }

  return features;
}

export function buildRegimeDistribution(
  features: CausalRegimeBarFeature[],
  startIdx: number,
  endIdxInclusive: number
): Record<MarketRegimeType, number> {
  const counts: Record<MarketRegimeType, number> = {
    Trending: 0,
    Ranging: 0,
    'High Volatility': 0,
    'Low Volatility': 0,
    Transitional: 0,
  };
  for (let i = Math.max(0, startIdx); i <= Math.min(features.length - 1, endIdxInclusive); i++) {
    counts[features[i].regime] += 1;
  }
  return counts;
}
