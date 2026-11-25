import type {
  AnalysisSnapshot,
  MultiDimensionalMarketState,
  Timeframe,
} from '../../shared/types/index.ts';

export function buildMultiDimensionalMarketState(
  snapshot: AnalysisSnapshot,
  htfSnapshot: AnalysisSnapshot | null,
  nowMs = Date.now()
): MultiDimensionalMarketState {
  const symbol = snapshot.symbol;
  const timeframe = snapshot.timeframe;
  const reasons: string[] = [];

  const trend = snapshot.marketStructure.trend;
  const direction: MultiDimensionalMarketState['direction'] =
    trend === 'bullish' ? 'Bullish' : trend === 'bearish' ? 'Bearish' : 'Neutral';

  const atr = snapshot.atr;
  const close = snapshot.candles[snapshot.candles.length - 1]?.close ?? 100;
  const atrPercent = close > 0 ? (atr / close) * 100 : 1.0;

  const volatility: MultiDimensionalMarketState['volatility'] =
    atrPercent > 2.5 ? 'Extreme' : atrPercent > 1.2 ? 'High' : atrPercent > 0.4 ? 'Normal' : 'Low';

  const bosCount = snapshot.marketStructure.breaks.filter((b) => b.type === 'BOS').length;
  const chochCount = snapshot.marketStructure.breaks.filter((b) => b.type === 'CHoCH' || b.type === 'MSS').length;

  const trendStrength: MultiDimensionalMarketState['trendStrength'] =
    Math.abs(bosCount - chochCount) >= 2 || atrPercent > 1.0
      ? 'Strong'
      : atrPercent > 0.5
        ? 'Moderate'
        : 'Weak';

  const structure: MultiDimensionalMarketState['structure'] =
    chochCount > 0
      ? 'CHoCH'
      : bosCount > 0
        ? 'BOS'
        : snapshot.orderBlocks.length > 0
          ? 'MSS'
          : 'Consolidation';

  const phase: MultiDimensionalMarketState['phase'] =
    volatility === 'High' || volatility === 'Extreme'
      ? 'Expansion'
      : snapshot.dealingRange
        ? 'Retracement'
        : 'Consolidation';

  const hasSweep = snapshot.liquidityPools.some((p) => p.swept) || (snapshot.liquiditySweeps?.length ?? 0) > 0;
  const liquidity: MultiDimensionalMarketState['liquidity'] = hasSweep
    ? 'Liquidity Sweep'
    : direction === 'Bullish'
      ? 'BSL'
      : direction === 'Bearish'
        ? 'SSL'
        : 'Untouched';

  const currentPrice = snapshot.quote?.price ?? close;
  const range = snapshot.dealingRange;
  let location: MultiDimensionalMarketState['location'] = 'Equilibrium';
  if (range && range.rangeHigh > range.rangeLow) {
    const eq = (range.rangeHigh + range.rangeLow) / 2;
    if (currentPrice > eq + (range.rangeHigh - range.rangeLow) * 0.1) location = 'Premium';
    else if (currentPrice < eq - (range.rangeHigh - range.rangeLow) * 0.1) location = 'Discount';
  }

  const htfTrend = htfSnapshot?.marketStructure.trend ?? trend;
  const htfAligned = htfTrend === trend || htfTrend === 'consolidation';

  let tradingCondition: MultiDimensionalMarketState['tradingCondition'] = 'Caution';
  if (volatility === 'Extreme' || !htfAligned) {
    tradingCondition = 'No Trade';
    reasons.push(`High volatility or HTF conflict (${htfTrend}) advises standing aside.`);
  } else if (structure === 'Consolidation' && volatility === 'Low') {
    tradingCondition = 'No Trade';
    reasons.push('Low volatility consolidation range — unfavorable for directional breakout.');
  } else if ((structure === 'BOS' || structure === 'CHoCH') && htfAligned) {
    tradingCondition = 'Favorable';
    reasons.push(`Clean structure (${structure}) aligned with higher timeframe (${htfTrend}).`);
  } else {
    reasons.push('Mixed structural signals; selective execution recommended.');
  }

  return {
    symbol,
    timeframe,
    evaluatedAt: nowMs,
    direction,
    trendStrength,
    volatility,
    structure,
    phase,
    liquidity,
    location,
    tradingCondition,
    reasons,
  };
}
