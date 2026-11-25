import { classifyMarketRegimesCausally } from '../backtest/discovery/regime.ts';
import { getTradingSessionForTimestamp } from '../backtest/discovery/engine.ts';
import { resolveDefaultHtfTimeframe } from '../backtest/engine.ts';
import { getInstrumentMeta, TIMEFRAME_SECONDS } from '../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  BacktestRunResult,
  BacktestStrategyDefinition,
  Candle,
  DiscoveryScanRun,
  InstrumentSymbol,
  LiveBreakoutState,
  LiveConditionFilterMode,
  LiveMarketConditionAnalysis,
  LiveMarketDirectionLabel,
  LiveMarketLevelSummary,
  LiveMarketRecommendationDecision,
  LiveMarketRegimeLabel,
  LiveMarketStrategyReport,
  LiveQuote,
  LiveVolatilityLevel,
  LiveVolumeStrength,
  MarketRegimeType,
  MultiTimeframeSummary,
  ProductionReadinessStatus,
  StrategyDiscoveryCombination,
  StrategyMatchItem,
  StrategyRecommendationStatus,
  Timeframe,
  TradingSessionName,
  ValidationStatus,
} from '../shared/types/index.ts';

function roundNum(val: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function computeEma(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0;
  const start = Math.max(0, candles.length - period * 3);
  const k = 2 / (period + 1);
  let ema = candles[start].close;
  for (let i = start + 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function sessionShortLabel(
  session: TradingSessionName
): LiveMarketConditionAnalysis['sessionShort'] {
  switch (session) {
    case 'Asian (00–07 UTC)':
      return 'Asian';
    case 'London Open (07–12 UTC)':
      return 'London';
    case 'London/NY Overlap (12–16 UTC)':
      return 'London/NY Overlap';
    case 'NY Afternoon (16–21 UTC)':
      return 'New York';
    default:
      return 'Late / Rollover';
  }
}

export interface AnalyzeLiveMarketConditionInput {
  snapshot: AnalysisSnapshot;
  htfSnapshot?: AnalysisSnapshot | null;
  mtfSummary?: MultiTimeframeSummary | null;
  quote?: LiveQuote | null;
  nowMs?: number;
}

/**
 * Deterministic real-time market condition analyzer using cached OHLCV candles,
 * technical structures, causal Wilder ADX/ATR, Kaufman ER, volume, S/R, and liquidity.
 */
export function analyzeLiveMarketCondition(
  input: AnalyzeLiveMarketConditionInput
): LiveMarketConditionAnalysis {
  const { snapshot, htfSnapshot, mtfSummary, quote } = input;
  const nowMs = input.nowMs ?? Date.now();
  const candles = snapshot.candles;
  const meta = getInstrumentMeta(snapshot.symbol);
  const precision = meta.pricePrecision;
  const htfTimeframe = resolveDefaultHtfTimeframe(snapshot.timeframe);

  const lastCandle = candles[candles.length - 1];
  const latestClosed =
    [...candles].reverse().find((c) => c.isClosed !== false) ?? lastCandle;
  const price =
    (quote && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : undefined) ??
    lastCandle?.close ??
    0;

  const latestCandleTime = lastCandle?.time ?? Math.floor(nowMs / 1000);
  const session = getTradingSessionForTimestamp(Math.floor(nowMs / 1000));
  const sessionShort = sessionShortLabel(session);

  // Causal regime features over available series
  const closedForRegime = candles.length >= 20 ? candles.filter((c) => c.isClosed !== false) : candles;
  const regimeSeries =
    closedForRegime.length > 0 ? closedForRegime : candles;
  const regimeFeatures = classifyMarketRegimesCausally(regimeSeries);
  const latestFeat = regimeFeatures[regimeFeatures.length - 1];

  const atr =
    (latestFeat?.atr && Number.isFinite(latestFeat.atr) ? latestFeat.atr : undefined) ??
    Math.max(1e-8, snapshot.atr);
  const atrPercent = latestFeat?.atrPercent ?? (price > 0 ? (atr / price) * 100 : 0);
  const volPercentileRaw = latestFeat?.volPercentile ?? 0.5;
  const atrPercentile = roundNum(volPercentileRaw * 100, 1);
  const volRatio = roundNum(latestFeat?.volRatio ?? 1.0, 2);
  const adx = roundNum(latestFeat?.adx ?? 18, 1);
  const efficiencyRatio = roundNum(latestFeat?.efficiencyRatio ?? 0.2, 2);
  const emaSeparationAtr = roundNum(latestFeat?.emaSeparationAtr ?? 0.3, 2);

  const emaSeries = regimeSeries.length >= 20 ? regimeSeries : candles;
  const ema20 = roundNum(computeEma(emaSeries, 20), precision);
  const ema20Prev = computeEma(emaSeries.slice(0, -1), 20);
  const ema50 = roundNum(computeEma(emaSeries, 50), precision);

  // Volatility classification (Very Low, Low, Normal, High, Extreme)
  let volatility: LiveVolatilityLevel = 'Normal';
  if (volPercentileRaw >= 0.92 || volRatio >= 1.75) {
    volatility = 'Extreme';
  } else if (volPercentileRaw >= 0.75 || volRatio >= 1.32) {
    volatility = 'High';
  } else if (volPercentileRaw <= 0.14 || volRatio <= 0.65) {
    volatility = 'Very Low';
  } else if (volPercentileRaw <= 0.30 || volRatio <= 0.82) {
    volatility = 'Low';
  }

  const atrCondition = `${atr.toFixed(precision)} (${atrPercent.toFixed(2)}% of price · ${atrPercentile.toFixed(0)}th pct · ${volRatio.toFixed(2)}× median)`;

  let adxCondition = 'No Trend (<18)';
  if (adx >= 32) adxCondition = `Strong Trend (${adx.toFixed(1)})`;
  else if (adx >= 23) adxCondition = `Trending (${adx.toFixed(1)})`;
  else if (adx >= 18) adxCondition = `Emerging (${adx.toFixed(1)})`;
  else adxCondition = `Weak / Sideways (${adx.toFixed(1)})`;

  // Momentum calculation (5-bar displacement + recent bar body pressure)
  const momLookback = Math.min(5, Math.max(1, candles.length - 1));
  const momAnchor = candles[Math.max(0, candles.length - 1 - momLookback)];
  const momentumAtr =
    atr > 1e-8 && momAnchor
      ? roundNum((price - momAnchor.open) / atr, 2)
      : 0;
  const absMom = Math.abs(momentumAtr);
  const momentumDirection: LiveMarketConditionAnalysis['momentumDirection'] =
    momentumAtr >= 0.35 ? 'Bullish' : momentumAtr <= -0.35 ? 'Bearish' : 'Neutral';
  const momentumStrengthScore = Math.round(clamp((absMom / 2.8) * 100, 0, 100));

  // Market Structure (Bullish / Bearish / Neutral)
  const ms = snapshot.marketStructure;
  const htfMs = htfSnapshot?.marketStructure;
  const marketStructure: LiveMarketConditionAnalysis['marketStructure'] =
    ms.trend === 'bullish' ? 'Bullish' : ms.trend === 'bearish' ? 'Bearish' : 'Neutral';
  const htfStructure: LiveMarketConditionAnalysis['htfStructure'] =
    htfMs?.trend === 'bullish'
      ? 'Bullish'
      : htfMs?.trend === 'bearish'
        ? 'Bearish'
        : 'Neutral';

  const recentSwings = ms.swings
    .filter((s) => s.confirmationStatus === 'confirmed' && s.structureLabel !== 'SH' && s.structureLabel !== 'SL')
    .slice(-4)
    .map((s) => s.structureLabel);
  const structureSequence = recentSwings.length > 0 ? recentSwings.join(' → ') : ms.lastExternalLabel;

  const recentConfirmedBreaks = ms.breaks.filter((b) => b.confirmationStatus === 'confirmed');
  const lastBreak = recentConfirmedBreaks[recentConfirmedBreaks.length - 1];
  const structureDetail = lastBreak
    ? `Last ${lastBreak.direction} ${lastBreak.type} @ ${lastBreak.levelPrice.toFixed(precision)} · HTF ${htfTimeframe}: ${htfStructure}`
    : `Structure: ${marketStructure} · HTF ${htfTimeframe}: ${htfStructure}`;

  // Trend Strength (0..100)
  const adxPart = clamp(((adx - 10) / 30) * 40, 0, 40);
  const erPart = clamp((efficiencyRatio / 0.55) * 28, 0, 28);
  const emaSepPart = clamp((emaSeparationAtr / 1.5) * 20, 0, 20);
  const htfBonus =
    marketStructure !== 'Neutral' && marketStructure === htfStructure
      ? 12
      : marketStructure !== 'Neutral' && htfStructure === 'Neutral'
        ? 5
        : 0;
  const trendStrengthScore = Math.round(clamp(adxPart + erPart + emaSepPart + htfBonus, 0, 100));
  const trendStrengthLabel: LiveMarketConditionAnalysis['trendStrengthLabel'] =
    trendStrengthScore >= 72
      ? 'Very Strong'
      : trendStrengthScore >= 52
        ? 'Strong'
        : trendStrengthScore >= 32
          ? 'Developing'
          : 'Weak';

  // Market Direction (Strong Uptrend, Weak Uptrend, Strong Downtrend, Weak Downtrend, Sideways)
  const emaBull = ema20 > ema50 && price >= ema20 && ema20 >= ema20Prev;
  const emaBear = ema20 < ema50 && price <= ema20 && ema20 <= ema20Prev;
  let bullBiasScore = 0;
  let bearBiasScore = 0;
  if (marketStructure === 'Bullish') bullBiasScore += 2;
  if (marketStructure === 'Bearish') bearBiasScore += 2;
  if (htfStructure === 'Bullish') bullBiasScore += 1.5;
  if (htfStructure === 'Bearish') bearBiasScore += 1.5;
  if (emaBull) bullBiasScore += 1.5;
  else if (ema20 > ema50 || price > ema20) bullBiasScore += 0.75;
  if (emaBear) bearBiasScore += 1.5;
  else if (ema20 < ema50 || price < ema20) bearBiasScore += 0.75;
  if (momentumAtr >= 0.45) bullBiasScore += 1;
  if (momentumAtr <= -0.45) bearBiasScore += 1;

  let direction: LiveMarketDirectionLabel = 'Sideways';
  if (bullBiasScore - bearBiasScore >= 1.25) {
    direction =
      trendStrengthScore >= 55 && adx >= 22 && momentumAtr >= 0.25
        ? 'Strong Uptrend'
        : 'Weak Uptrend';
  } else if (bearBiasScore - bullBiasScore >= 1.25) {
    direction =
      trendStrengthScore >= 55 && adx >= 22 && momentumAtr <= -0.25
        ? 'Strong Downtrend'
        : 'Weak Downtrend';
  }

  // Recent 5-bar compression check for Consolidating vs Ranging vs Transitioning
  const recentRanges = closedForRegime.slice(-6).map((c) => Math.max(0, c.high - c.low));
  const avgRecentRange =
    recentRanges.length > 0
      ? recentRanges.reduce((s, v) => s + v, 0) / recentRanges.length
      : atr;
  const isCompressed =
    volatility === 'Very Low' ||
    (atr > 1e-8 && avgRecentRange < atr * 0.72 && adx < 21);

  // Market Regime (Trending, Ranging, Consolidating, Transitioning) + Discovery 5-Regime Mapping
  let regime: LiveMarketRegimeLabel;
  if (isCompressed && (adx < 22 || efficiencyRatio < 0.25)) {
    regime = 'Consolidating';
  } else if (adx >= 23 && (efficiencyRatio >= 0.27 || emaSeparationAtr >= 0.65) && direction !== 'Sideways') {
    regime = 'Trending';
  } else if (adx < 19 && efficiencyRatio < 0.27 && emaSeparationAtr < 0.85) {
    regime = 'Ranging';
  } else {
    regime = 'Transitioning';
  }

  // Exact mapping onto Discovery's 5 causal regimes so historical combination matches align accurately
  const discoveryRegimeMapping: MarketRegimeType =
    latestFeat?.regime ??
    (volatility === 'High' || volatility === 'Extreme'
      ? 'High Volatility'
      : volatility === 'Very Low'
        ? 'Low Volatility'
        : regime === 'Trending'
          ? 'Trending'
          : regime === 'Ranging' || regime === 'Consolidating'
            ? 'Ranging'
            : 'Transitional');

  // Volume Strength & Unusual Volume Activity
  const volClosed = closedForRegime.length >= 22 ? closedForRegime : candles;
  const volTarget = volClosed[volClosed.length - 1];
  const volBaseline = volClosed.slice(Math.max(0, volClosed.length - 21), -1);
  const validBase = volBaseline.filter((c) => Number.isFinite(c.volume) && c.volume > 0);
  const avgVol =
    validBase.length > 0 ? validBase.reduce((s, c) => s + c.volume, 0) / validBase.length : 0;
  const volumeAvailable = avgVol > 0 && Boolean(volTarget && volTarget.volume > 0);
  const relativeVolume =
    volumeAvailable && volTarget ? roundNum(volTarget.volume / avgVol, 2) : 1.0;
  const unusualVolume = volumeAvailable && relativeVolume >= 1.6;

  let volumeStrength: LiveVolumeStrength = 'Normal';
  if (!volumeAvailable) {
    volumeStrength = 'Normal';
  } else if (relativeVolume >= 2.0) {
    volumeStrength = 'Climax';
  } else if (relativeVolume >= 1.3) {
    volumeStrength = 'High';
  } else if (relativeVolume <= 0.55) {
    volumeStrength = 'Very Low';
  } else if (relativeVolume <= 0.8) {
    volumeStrength = 'Low';
  }

  const volumeNote = !volumeAvailable
    ? 'Broker feed reports zero/minimal tick volume on this bar'
    : unusualVolume
      ? `Unusual volume spike (${relativeVolume.toFixed(2)}× 20-bar avg)`
      : `Relative volume ${relativeVolume.toFixed(2)}× 20-bar avg`;

  // Support & Resistance Levels
  const activeSrs = snapshot.supportResistance.filter(
    (z) => z.status !== 'Invalidated' && z.status !== 'Broken'
  );
  const supportLevels: LiveMarketLevelSummary[] = activeSrs
    .filter((z) => z.kind === 'support' && z.midpoint <= price * 1.005)
    .sort((a, b) => b.midpoint - a.midpoint)
    .slice(0, 3)
    .map((z) => ({
      label: z.label,
      price: roundNum(z.midpoint, precision),
      lower: roundNum(z.lower, precision),
      upper: roundNum(z.upper, precision),
      strengthScore: z.strengthScore,
      distancePercent: price > 0 ? roundNum(((price - z.midpoint) / price) * 100, 2) : 0,
    }));

  const resistanceLevels: LiveMarketLevelSummary[] = activeSrs
    .filter((z) => z.kind === 'resistance' && z.midpoint >= price * 0.995)
    .sort((a, b) => a.midpoint - b.midpoint)
    .slice(0, 3)
    .map((z) => ({
      label: z.label,
      price: roundNum(z.midpoint, precision),
      lower: roundNum(z.lower, precision),
      upper: roundNum(z.upper, precision),
      strengthScore: z.strengthScore,
      distancePercent: price > 0 ? roundNum(((z.midpoint - price) / price) * 100, 2) : 0,
    }));

  // Liquidity Conditions
  const tfSec = TIMEFRAME_SECONDS[snapshot.timeframe];
  const recentSweepLookbackSec = tfSec * 15;
  const recentSweeps = snapshot.liquidityPools.filter(
    (l) =>
      l.swept &&
      l.sweepTime !== null &&
      latestCandleTime - l.sweepTime <= recentSweepLookbackSec
  );
  const sweptSellCount = recentSweeps.filter(
    (l) => l.kind === 'sell_side' || l.kind === 'equal_lows' || l.kind === 'pdl' || l.kind === 'pwl'
  ).length;
  const sweptBuyCount = recentSweeps.filter(
    (l) => l.kind === 'buy_side' || l.kind === 'equal_highs' || l.kind === 'pdh' || l.kind === 'pwh'
  ).length;

  const unsweptBuyPools = snapshot.liquidityPools
    .filter((l) => !l.swept && l.price > price)
    .sort((a, b) => a.price - b.price);
  const unsweptSellPools = snapshot.liquidityPools
    .filter((l) => !l.swept && l.price < price)
    .sort((a, b) => b.price - a.price);

  const sweepBias: LiveMarketConditionAnalysis['liquidityCondition']['sweepBias'] =
    sweptSellCount > sweptBuyCount
      ? 'Bullish Sweep'
      : sweptBuyCount > sweptSellCount
        ? 'Bearish Sweep'
        : recentSweeps.length > 0
          ? 'Balanced'
          : 'Quiet';

  const nearestBuySide = unsweptBuyPools[0]
    ? {
        label: unsweptBuyPools[0].label,
        price: roundNum(unsweptBuyPools[0].price, precision),
        distancePercent:
          price > 0 ? roundNum(((unsweptBuyPools[0].price - price) / price) * 100, 2) : 0,
      }
    : null;

  const nearestSellSide = unsweptSellPools[0]
    ? {
        label: unsweptSellPools[0].label,
        price: roundNum(unsweptSellPools[0].price, precision),
        distancePercent:
          price > 0 ? roundNum(((price - unsweptSellPools[0].price) / price) * 100, 2) : 0,
      }
    : null;

  const liquiditySummary =
    recentSweeps.length > 0
      ? `${recentSweeps.length} recent liquidity sweep(s) (${sweepBias}); ${unsweptBuyPools.length} BSL / ${unsweptSellPools.length} SSL resting`
      : `No recent stop-runs; ${unsweptBuyPools.length} buy-side / ${unsweptSellPools.length} sell-side pools resting`;

  // Breakout vs False Breakout Conditions
  const prior20 = candles.slice(Math.max(0, candles.length - 21), -1);
  const donchianHigh = prior20.length > 0 ? Math.max(...prior20.map((c) => c.high)) : price;
  const donchianLow = prior20.length > 0 ? Math.min(...prior20.map((c) => c.low)) : price;
  const barHigh = lastCandle?.high ?? price;
  const barLow = lastCandle?.low ?? price;
  const barClose = lastCandle?.close ?? price;

  const falseBreakBull =
    prior20.length >= 10 &&
    barLow < donchianLow &&
    barClose > donchianLow &&
    (barClose - barLow) >= atr * 0.35;
  const falseBreakBear =
    prior20.length >= 10 &&
    barHigh > donchianHigh &&
    barClose < donchianHigh &&
    (barHigh - barClose) >= atr * 0.35;

  const recentBreak = recentConfirmedBreaks.find(
    (b) => latestCandleTime - b.breakTime <= tfSec * 3
  );
  const retestingSr = snapshot.supportResistance.find((z) => z.status === 'Retesting');
  const retestingCp = snapshot.chartPatterns.find((p) => p.status === 'Retest');
  const activeCpBreak = snapshot.chartPatterns.find(
    (p) =>
      p.status === 'Breakout' &&
      (p.breakoutTime === null || latestCandleTime - p.breakoutTime <= tfSec * 5)
  );

  let breakoutState: LiveBreakoutState = 'Range Bound';
  let breakoutDetail = 'Trading inside established 20-bar range without confirmed expansion';

  if (falseBreakBull || falseBreakBear || (recentSweeps.length > 0 && regime !== 'Trending')) {
    breakoutState = 'False Breakout Trap';
    breakoutDetail = falseBreakBull
      ? `Wick swept below 20-bar low (${donchianLow.toFixed(precision)}) and snapped back inside`
      : falseBreakBear
        ? `Wick pierced above 20-bar high (${donchianHigh.toFixed(precision)}) and closed back inside`
        : `Recent liquidity sweep (${recentSweeps[recentSweeps.length - 1]?.label ?? 'pool'}) failed to sustain breakout`;
  } else if (retestingSr || retestingCp) {
    breakoutState = 'Confirmed Retest';
    breakoutDetail = retestingSr
      ? `Retesting broken S/R flip level (${retestingSr.label})`
      : `Retesting broken ${retestingCp!.name} neckline`;
  } else if (
    activeCpBreak ||
    (recentBreak && recentBreak.type === 'BOS') ||
    (prior20.length >= 10 && (barClose > donchianHigh || barClose < donchianLow))
  ) {
    breakoutState = 'Active Breakout';
    breakoutDetail = activeCpBreak
      ? `${activeCpBreak.name} breakout (${activeCpBreak.direction})`
      : recentBreak
        ? `Confirmed ${recentBreak.direction} ${recentBreak.type} @ ${recentBreak.levelPrice.toFixed(precision)}`
        : `Close breaking 20-bar channel (${barClose > donchianHigh ? 'Upside' : 'Downside'})`;
  } else if (regime === 'Consolidating' || isCompressed) {
    breakoutState = 'Compression Coil';
    breakoutDetail = `Tight volatility squeeze (${atrPercentile.toFixed(0)}th pct ATR) priming for expansion`;
  }

  // Possible Market Reversal Conditions
  const reversalSignals: string[] = [];
  const dr = snapshot.dealingRange;
  if (dr && marketStructure === 'Bullish' && dr.currentPosition === 'premium' && dr.retracementPercent <= 25) {
    reversalSignals.push(`Price stretched deep in Premium (${dr.retracementPercent}%)`);
  } else if (dr && marketStructure === 'Bearish' && dr.currentPosition === 'discount' && dr.retracementPercent >= 75) {
    reversalSignals.push(`Price stretched deep in Discount (${dr.retracementPercent}%)`);
  }

  const recentChochOrMss = recentConfirmedBreaks.find(
    (b) =>
      (b.type === 'CHoCH' || b.type === 'MSS') &&
      latestCandleTime - b.breakTime <= tfSec * 6
  );
  if (recentChochOrMss) {
    reversalSignals.push(
      `Recent ${recentChochOrMss.direction} ${recentChochOrMss.type} signaling potential shift`
    );
  }

  if (recentSweeps.length > 0) {
    reversalSignals.push(
      `Stop-run sweep (${recentSweeps[recentSweeps.length - 1].label}) raises snapback risk`
    );
  }

  const recentReversalCandle = snapshot.candlestickPatterns.find(
    (p) =>
      p.confirmationStatus === 'confirmed' &&
      p.category === 'reversal' &&
      latestCandleTime - p.detectionTime <= tfSec * 3
  );
  if (recentReversalCandle) {
    reversalSignals.push(
      `Confirmed ${recentReversalCandle.name} (${recentReversalCandle.direction})`
    );
  }

  if (mtfSummary?.potentialReversalCondition) {
    reversalSignals.push(mtfSummary.potentialReversalCondition);
  }
  if (unusualVolume && (falseBreakBull || falseBreakBear)) {
    reversalSignals.push('Climax/unusual volume on failed extreme break');
  }

  const reversalRiskLevel: LiveMarketConditionAnalysis['reversalCondition']['riskLevel'] =
    reversalSignals.length >= 3
      ? 'High'
      : reversalSignals.length === 2
        ? 'Elevated'
        : reversalSignals.length === 1
          ? 'Moderate'
          : 'Low';

  const reversalSummary =
    reversalSignals.length > 0
      ? reversalSignals[0]
      : 'No immediate reversal triggers detected; prevailing flow remains intact';

  const marketOpen =
    quote?.marketOpen !== false && snapshot.providerStatus.connectionStatus !== 'MARKET_CLOSED';
  const connectionStatus =
    quote?.connectionStatus ?? snapshot.providerStatus.connectionStatus;

  const conditionSummary = `${snapshot.symbol} (${snapshot.timeframe}) is currently ${regime} in a ${direction} with ${volatility} volatility (ADX ${adx.toFixed(1)}, ATR ${atrPercentile.toFixed(0)}th pct) during ${sessionShort} session. Structure is ${marketStructure} (${htfTimeframe} ${htfStructure}) with ${breakoutState.toLowerCase()} behavior and ${reversalRiskLevel.toLowerCase()} reversal risk.`;

  return {
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    htfTimeframe,
    price: roundNum(price, precision),
    bid: quote?.bid,
    ask: quote?.ask,
    spread: quote?.spread,
    change24h: quote?.change24h ?? 0,
    changePercent24h: quote?.changePercent24h ?? 0,
    marketOpen,
    connectionStatus,
    providerName: quote?.provider ?? snapshot.providerStatus.providerName,
    analyzedAt: nowMs,
    latestCandleTime,
    regime,
    discoveryRegimeMapping,
    direction,
    volatility,
    trendStrengthScore,
    trendStrengthLabel,
    momentumStrengthScore,
    momentumDirection,
    momentumAtr,
    marketStructure,
    htfStructure,
    structureSequence,
    structureDetail,
    adx,
    adxCondition,
    atr: roundNum(atr, precision),
    atrPercent: roundNum(atrPercent, 3),
    atrPercentile,
    volRatio,
    atrCondition,
    efficiencyRatio,
    emaSeparationAtr,
    ema20,
    ema50,
    volumeStrength,
    relativeVolume,
    unusualVolume,
    volumeAvailable,
    volumeNote,
    supportLevels,
    resistanceLevels,
    liquidityCondition: {
      summary: liquiditySummary,
      recentSweepsCount: recentSweeps.length,
      unsweptBuySideCount: unsweptBuyPools.length,
      unsweptSellSideCount: unsweptSellPools.length,
      sweepBias,
      nearestBuySide,
      nearestSellSide,
    },
    breakoutCondition: {
      state: breakoutState,
      detail: breakoutDetail,
    },
    session,
    sessionShort,
    reversalCondition: {
      riskLevel: reversalRiskLevel,
      summary: reversalSummary,
      signals: reversalSignals,
    },
    conditionSummary,
  };
}

// ============================================================================
// Strategy Matching Engine (Pure Deterministic Historical Evidence Matching)
// ============================================================================

type StrategyStyle = 'trend' | 'reversion' | 'breakout' | 'hybrid';

function inferStrategyStyle(strategy: BacktestStrategyDefinition): StrategyStyle {
  const txt = `${strategy.id} ${strategy.name} ${strategy.summary} ${strategy.entryRules.join(' ')}`.toUpperCase();
  if (
    txt.includes('NR4') ||
    txt.includes('NR7') ||
    txt.includes('BREAKOUT') ||
    txt.includes('COIL') ||
    txt.includes('COMPRESSION') ||
    txt.includes('EXPANSION') ||
    txt.includes('DONCHIAN20') ||
    txt.includes('IMPULSE')
  ) {
    return 'breakout';
  }
  if (
    txt.includes('FADE') ||
    txt.includes('TURTLE_SOUP') ||
    txt.includes('RANGE_BOUND') ||
    txt.includes('REVERSAL') ||
    txt.includes('TWEEZER') ||
    txt.includes('SPRING') ||
    txt.includes('REJECTION') ||
    txt.includes('EXHAUST') ||
    txt.includes('CONSOL_REGIME') ||
    txt.includes('PIERCING') ||
    txt.includes('DARK_CLOUD')
  ) {
    return 'reversion';
  }
  if (
    txt.includes('BOS') ||
    txt.includes('EMA20') ||
    txt.includes('EMA50') ||
    txt.includes('EMA_STACK') ||
    txt.includes('HTF_STRICT') ||
    txt.includes('HTF_TREND') ||
    txt.includes('SOLDIERS') ||
    txt.includes('CROWS') ||
    txt.includes('FLAG') ||
    txt.includes('PENNANT') ||
    txt.includes('TREND_REGIME') ||
    txt.includes('RBR') ||
    txt.includes('DBD')
  ) {
    return 'trend';
  }
  return 'hybrid';
}

function timeframeProximityPoints(testedTf: Timeframe, liveTf: Timeframe): {
  pts: number;
  label: string;
} {
  if (testedTf === liveTf) {
    return { pts: 10, label: `Exact timeframe match (${liveTf})` };
  }
  const a = TIMEFRAME_SECONDS[testedTf];
  const b = TIMEFRAME_SECONDS[liveTf];
  const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
  if (ratio <= 2.5) {
    return { pts: 6, label: `Adjacent timeframe (${testedTf} vs live ${liveTf})` };
  }
  if (ratio <= 4.5) {
    return { pts: 3, label: `Different timeframe (${testedTf} vs live ${liveTf})` };
  }
  return { pts: 1, label: `Distant timeframe (${testedTf} vs live ${liveTf})` };
}

function styleCompatibilityPoints(
  style: StrategyStyle,
  condition: LiveMarketConditionAnalysis
): { pts: number; note: string } {
  if (condition.regime === 'Trending') {
    if (style === 'trend') return { pts: 10, note: 'Trend-following logic fits active Trending regime' };
    if (style === 'breakout') return { pts: 7, note: 'Breakout/momentum logic aligns with directional flow' };
    if (style === 'hybrid') return { pts: 6, note: 'Hybrid SMC pullback logic adapts to directional structure' };
    return { pts: 2, note: 'Counter-trend/reversion style fights strong active trend' };
  }
  if (condition.regime === 'Ranging') {
    if (style === 'reversion') return { pts: 10, note: 'Mean-reversion/S&R defense fits Ranging market' };
    if (style === 'hybrid') return { pts: 7, note: 'Sweep/OB hybrid logic captures range extremes' };
    if (style === 'breakout') return { pts: 3, note: 'Breakouts often fake-out inside Ranging conditions' };
    return { pts: 2, note: 'Trend continuation underperforms inside sideways chop' };
  }
  if (condition.regime === 'Consolidating') {
    if (condition.breakoutCondition.state === 'Compression Coil' && style === 'breakout') {
      return { pts: 9, note: 'Volatility compression coil primes breakout release setups' };
    }
    if (style === 'reversion') return { pts: 8, note: 'Range defense fits tight consolidation boundaries' };
    if (style === 'hybrid') return { pts: 5, note: 'Requires clean sweep/breakout trigger from coil' };
    return { pts: 2, note: 'Consolidating market lacks trend follow-through' };
  }
  // Transitioning
  if (condition.reversalCondition.riskLevel === 'High' || condition.reversalCondition.riskLevel === 'Elevated') {
    if (style === 'reversion' || style === 'hybrid') {
      return { pts: 8, note: 'Sweep/reversal structure fits transitional shift signals' };
    }
  }
  if (style === 'hybrid' || style === 'breakout') {
    return { pts: 7, note: 'Adaptive/breakout confirmation suits Transitional structure' };
  }
  return { pts: 5, note: 'Mixed alignment during Transitional shift' };
}

interface DiscoveryStrategyGroup {
  strategy: BacktestStrategyDefinition;
  sourceRunId: string;
  combos: StrategyDiscoveryCombination[];
}

function computeConditionMatches(params: {
  style: StrategyStyle;
  condition: LiveMarketConditionAnalysis;
  directRegimeMatch: boolean;
  liveRegimeExpectancyR: number | null;
  liveRegimeTrades: number;
  bestRegime: MarketRegimeType;
  isPoorInCurrentRegime: boolean;
  highVolBreakdown?: { trades: number; expectancyR: number } | null;
  lowVolBreakdown?: { trades: number; expectancyR: number } | null;
}): StrategyMatchItem['conditionMatches'] {
  const {
    style,
    condition,
    directRegimeMatch,
    liveRegimeExpectancyR,
    liveRegimeTrades,
    bestRegime,
    isPoorInCurrentRegime,
    highVolBreakdown,
    lowVolBreakdown,
  } = params;

  // 1. Regime alignment (0..100)
  let regimeScore = 45;
  if (directRegimeMatch) {
    regimeScore = 92;
  } else if (liveRegimeTrades >= 2 && (liveRegimeExpectancyR ?? 0) > 0) {
    regimeScore = 80;
  } else if (bestRegime === condition.discoveryRegimeMapping) {
    regimeScore = 84;
  } else {
    const stylePts = styleCompatibilityPoints(style, condition).pts;
    regimeScore = Math.round(clamp(30 + stylePts * 5.2, 20, 82));
  }
  if (isPoorInCurrentRegime) {
    regimeScore = Math.min(regimeScore, 24);
  }
  const regimeMatch = !isPoorInCurrentRegime && regimeScore >= 60;

  // 2. Trend alignment (0..100)
  const ts = condition.trendStrengthScore;
  const isSideways = condition.direction === 'Sideways';
  const structureAligned =
    condition.marketStructure !== 'Neutral' &&
    condition.marketStructure === condition.htfStructure;

  let trendScore = 55;
  if (style === 'trend') {
    if (!isSideways && ts >= 48) {
      trendScore = structureAligned ? 95 : 86;
    } else if (!isSideways && ts >= 32) {
      trendScore = 70;
    } else {
      trendScore = 28;
    }
  } else if (style === 'reversion') {
    if (isSideways || ts < 38) {
      trendScore = 90;
    } else if (ts < 52 || condition.reversalCondition.riskLevel === 'High') {
      trendScore = 68;
    } else {
      trendScore = 30;
    }
  } else if (style === 'breakout') {
    if (
      condition.breakoutCondition.state === 'Active Breakout' ||
      condition.breakoutCondition.state === 'Confirmed Retest' ||
      condition.breakoutCondition.state === 'Compression Coil'
    ) {
      trendScore = 90;
    } else if (condition.momentumStrengthScore >= 52 || ts >= 45) {
      trendScore = 74;
    } else {
      trendScore = 42;
    }
  } else {
    // hybrid adapts across directional pullbacks & sweep/reversal setups
    trendScore = structureAligned ? 86 : ts >= 28 || isSideways ? 74 : 58;
  }
  const trendMatch = trendScore >= 60;

  // 3. Volatility alignment (0..100)
  const vol = condition.volatility;
  let volatilityScore = 65;
  if (vol === 'High' || vol === 'Extreme') {
    if (highVolBreakdown && highVolBreakdown.trades >= 3) {
      volatilityScore =
        highVolBreakdown.expectancyR > 0
          ? vol === 'Extreme'
            ? 84
            : 94
          : 26;
    } else if (bestRegime === 'High Volatility') {
      volatilityScore = 90;
    } else if (vol === 'Extreme') {
      volatilityScore = style === 'breakout' ? 52 : 28;
    } else {
      volatilityScore = style === 'trend' || style === 'breakout' ? 76 : 56;
    }
  } else if (vol === 'Low' || vol === 'Very Low') {
    if (lowVolBreakdown && lowVolBreakdown.trades >= 3) {
      volatilityScore = lowVolBreakdown.expectancyR > 0 ? 90 : 30;
    } else if (bestRegime === 'Low Volatility') {
      volatilityScore = 88;
    } else if (
      style === 'breakout' &&
      condition.breakoutCondition.state === 'Compression Coil'
    ) {
      volatilityScore = 84;
    } else if (style === 'reversion' || style === 'hybrid') {
      volatilityScore = 74;
    } else {
      volatilityScore = 46;
    }
  } else {
    // Normal volatility suits most validated strategies cleanly
    volatilityScore = style === 'trend' || style === 'hybrid' ? 86 : 80;
  }
  const volatilityMatch = volatilityScore >= 60;

  const matchedCount =
    (regimeMatch ? 1 : 0) + (trendMatch ? 1 : 0) + (volatilityMatch ? 1 : 0);

  return {
    regimeMatch,
    trendMatch,
    volatilityMatch,
    regimeScore,
    trendScore,
    volatilityScore,
    matchedCount,
  };
}

function evaluateDiscoveryCandidate(
  group: DiscoveryStrategyGroup,
  condition: LiveMarketConditionAnalysis
): StrategyMatchItem {
  // Prefer combos on the exact live timeframe first; otherwise pick best validated combo for this symbol
  const exactTfCombos = group.combos.filter((c) => c.timeframe === condition.timeframe);
  const poolCombos = exactTfCombos.length > 0 ? exactTfCombos : group.combos;

  // Find direct combo matching current mapped regime, or pick highest validated combo across regimes
  const directRegimeCombo =
    poolCombos.find((c) => c.regime === condition.discoveryRegimeMapping) ?? null;

  const bestComboOverall = [...group.combos].sort((a, b) => {
    const valRank = (s: ValidationStatus) =>
      s === 'Validated' ? 3 : s === 'Preliminary Candidate' ? 2 : s === 'Insufficient Evidence' ? 1 : 0;
    const vd = valRank(b.validationStatus) - valRank(a.validationStatus);
    if (vd !== 0) return vd;
    if (b.oosScore !== a.oosScore) return b.oosScore - a.oosScore;
    return b.oosMetrics.expectancyR - a.oosMetrics.expectancyR;
  })[0];

  const primaryCombo =
    directRegimeCombo ??
    [...poolCombos].sort((a, b) => b.oosScore - a.oosScore)[0] ??
    bestComboOverall;

  // Inspect performance specifically inside the live condition's mapped regime
  const liveRegimePerf = primaryCombo.allRegimesBreakdown.find(
    (rb) => rb.regime === condition.discoveryRegimeMapping
  );
  const targetOos = directRegimeCombo
    ? directRegimeCombo.oosMetrics
    : liveRegimePerf && liveRegimePerf.oosMetrics.trades >= 2
      ? liveRegimePerf.oosMetrics
      : primaryCombo.oosMetrics;
  const targetIs = directRegimeCombo
    ? directRegimeCombo.isMetrics
    : liveRegimePerf && liveRegimePerf.isMetrics.trades >= 2
      ? liveRegimePerf.isMetrics
      : primaryCombo.isMetrics;
  const targetHoldout = directRegimeCombo
    ? directRegimeCombo.holdoutMetrics
    : liveRegimePerf
      ? liveRegimePerf.holdoutMetrics
      : primaryCombo.holdoutMetrics;

  const totalIsOosTrades = targetIs.trades + targetOos.trades;
  const unseenTrades = targetOos.trades;
  const matchReasons: string[] = [];
  const cautionNotes: string[] = [];

  const highVolBreakdown = primaryCombo.allRegimesBreakdown.find(
    (rb) => rb.regime === 'High Volatility'
  );
  const lowVolBreakdown = primaryCombo.allRegimesBreakdown.find(
    (rb) => rb.regime === 'Low Volatility'
  );

  // 1. Condition Fit (0..30) across Regime + Trend + Volatility
  let conditionFit = 0;
  const style = inferStrategyStyle(group.strategy);
  const styleEval = styleCompatibilityPoints(style, condition);
  conditionFit += styleEval.pts; // up to 10

  const isPoorInCurrentRegime = primaryCombo.poorRegimes.some(
    (p) => p.regime === condition.discoveryRegimeMapping
  );

  const conditionMatches = computeConditionMatches({
    style,
    condition,
    directRegimeMatch: Boolean(directRegimeCombo),
    liveRegimeExpectancyR: liveRegimePerf?.oosMetrics.expectancyR ?? null,
    liveRegimeTrades: liveRegimePerf?.oosMetrics.trades ?? 0,
    bestRegime: bestComboOverall.regime,
    isPoorInCurrentRegime,
    highVolBreakdown: highVolBreakdown
      ? {
          trades: highVolBreakdown.oosMetrics.trades,
          expectancyR: highVolBreakdown.oosMetrics.expectancyR,
        }
      : null,
    lowVolBreakdown: lowVolBreakdown
      ? {
          trades: lowVolBreakdown.oosMetrics.trades,
          expectancyR: lowVolBreakdown.oosMetrics.expectancyR,
        }
      : null,
  });

  if (directRegimeCombo) {
    conditionFit += 15;
    matchReasons.push(
      `Tested directly in ${condition.discoveryRegimeMapping} regime (${directRegimeCombo.oosMetrics.trades} unseen trades, ${directRegimeCombo.oosMetrics.expectancyR >= 0 ? '+' : ''}${directRegimeCombo.oosMetrics.expectancyR}R avg)`
    );
  } else if (liveRegimePerf && liveRegimePerf.oosMetrics.trades >= 2 && liveRegimePerf.oosMetrics.expectancyR > 0) {
    conditionFit += 11;
    matchReasons.push(
      `Positive unseen expectancy (+${liveRegimePerf.oosMetrics.expectancyR}R) during ${condition.discoveryRegimeMapping} periods`
    );
  } else if (liveRegimePerf && liveRegimePerf.oosMetrics.trades === 0) {
    conditionFit += 4;
    cautionNotes.push(`Zero unseen trades recorded in ${condition.discoveryRegimeMapping} regime`);
  } else {
    conditionFit += 6;
    cautionNotes.push(`Strongest in ${bestComboOverall.regime}, not ${condition.discoveryRegimeMapping}`);
  }

  // Blend explicit Trend + Volatility alignment (0..5)
  conditionFit += ((conditionMatches.trendScore + conditionMatches.volatilityScore) / 200) * 5;

  if (conditionMatches.matchedCount === 3) {
    matchReasons.push(
      `All 3 live filters match (${condition.volatility} Vol, ${condition.direction}, ${condition.regime})`
    );
  } else {
    if (!conditionMatches.volatilityMatch) {
      cautionNotes.push(`Volatility mismatch against current ${condition.volatility} ATR conditions`);
    }
    if (!conditionMatches.trendMatch) {
      cautionNotes.push(
        `Trend filter caution for ${condition.direction} (${condition.trendStrengthScore}/100 strength)`
      );
    }
  }

  if (isPoorInCurrentRegime) {
    conditionFit = Math.max(0, conditionFit - 20);
    cautionNotes.push(
      `Warning: ${condition.discoveryRegimeMapping} is listed among poor regimes for this strategy`
    );
  }
  conditionFit = clamp(conditionFit, 0, 30);
  matchReasons.push(styleEval.note);

  // 2. Validation Quality (0..30)
  let validationQuality = 0;
  const vStatus = primaryCombo.validationStatus;
  const readiness: ProductionReadinessStatus | undefined = primaryCombo.productionAudit?.readiness;

  if (vStatus === 'Validated') {
    validationQuality = readiness === 'Production Ready' ? 28 : 23;
    matchReasons.push(
      readiness === 'Production Ready'
        ? `Passed IS + Unseen Test + Walk-Forward AND Final Holdout (+${targetHoldout.netReturnPercent}%)`
        : 'Passed Out-of-Sample & Walk-Forward validation gates'
    );
  } else if (vStatus === 'Preliminary Candidate') {
    validationQuality = 16;
    cautionNotes.push('Preliminary Candidate — positive OOS edge, needs more validation confirmation');
  } else if (vStatus === 'Insufficient Evidence') {
    validationQuality = 6;
    cautionNotes.push(`Insufficient unseen sample (${unseenTrades} OOS trades)`);
  } else {
    validationQuality = 2;
    cautionNotes.push('Failed OOS validation benchmark');
  }

  if (readiness === 'Overfit / Decayed') {
    validationQuality = Math.max(0, validationQuality - 18);
    cautionNotes.push(
      `Final Holdout decayed (${targetHoldout.netReturnPercent}%) — possible overfit`
    );
  }

  if (primaryCombo.wfConsistencyPercent >= 65) {
    validationQuality = Math.min(30, validationQuality + 2);
    matchReasons.push(
      `Walk-forward consistent (${primaryCombo.wfConsistencyPercent}% across time windows)`
    );
  } else if (primaryCombo.wfConsistencyPercent < 40 && primaryCombo.wfActiveFolds >= 2) {
    cautionNotes.push(`Low walk-forward consistency (${primaryCombo.wfConsistencyPercent}%)`);
  }

  // 3. Risk-Adjusted OOS Expectancy & Drawdown (0..22) — NEVER win-rate alone
  let expectancyRisk = 0;
  const expR = targetOos.expectancyR;
  const pf = targetOos.profitFactor ?? 0;
  const maxDd = targetOos.maxDrawdownPercent;

  if (expR > 0) {
    expectancyRisk += clamp((expR / 0.45) * 12, 0, 12);
    expectancyRisk += clamp(((pf - 1.0) / 1.2) * 10, 0, 10);
  }
  if (maxDd > 12) {
    const ddPenalty = clamp((maxDd - 12) * 0.85, 0, 16);
    expectancyRisk = Math.max(0, expectancyRisk - ddPenalty);
    cautionNotes.push(`Elevated unseen drawdown (${maxDd.toFixed(1)}%)`);
  }

  // 4. Timeframe & Active Session Fit (0..18)
  const tfEval = timeframeProximityPoints(primaryCombo.timeframe, condition.timeframe);
  let sessionPts = 4; // neutral default
  if (primaryCombo.bestSession && primaryCombo.bestSession === condition.session) {
    sessionPts = 8;
    matchReasons.push(`Current ${condition.sessionShort} session matches best historical window`);
  } else if (primaryCombo.avoidSessions?.includes(condition.session)) {
    sessionPts = 0;
    cautionNotes.push(`Current ${condition.sessionShort} session is listed in Avoid Sessions`);
  }
  if (primaryCombo.timeframe === condition.timeframe) {
    matchReasons.push(tfEval.label);
  } else {
    cautionNotes.push(tfEval.label);
  }
  const timeframeSessionFit = clamp(tfEval.pts + sessionPts, 0, 18);

  // Sample size dampener & hard caps
  let rawScore = conditionFit + validationQuality + expectancyRisk + timeframeSessionFit;
  if (primaryCombo.avoidSessions?.includes(condition.session)) {
    rawScore -= 12;
  }
  if (unseenTrades < 4) {
    rawScore = Math.min(rawScore, 48);
  } else if (unseenTrades < 8) {
    rawScore = rawScore * (0.76 + 0.06 * (unseenTrades - 4));
  }

  const matchingScore = Math.round(clamp(rawScore, 0, 100));

  // Status assignment strictly grounded in OOS + sample + validation
  let status: StrategyRecommendationStatus;
  if (unseenTrades < 4 || totalIsOosTrades < 6 || vStatus === 'Insufficient Evidence') {
    status = 'INSUFFICIENT DATA';
  } else if (
    expR <= 0 ||
    (targetOos.profitFactor !== null && pf < 1.0) ||
    isPoorInCurrentRegime ||
    readiness === 'Overfit / Decayed' ||
    vStatus === 'Failed Validation' ||
    (primaryCombo.avoidSessions?.includes(condition.session) && matchingScore < 55) ||
    matchingScore < 42
  ) {
    status = 'POOR MATCH';
  } else if (
    matchingScore >= 74 &&
    vStatus === 'Validated' &&
    expR >= 0.08 &&
    pf >= 1.2 &&
    unseenTrades >= 5 &&
    maxDd <= 22 &&
    primaryCombo.timeframe === condition.timeframe
  ) {
    status = 'BEST MATCH';
  } else if (
    matchingScore >= 58 &&
    expR > 0 &&
    (targetOos.profitFactor === null || pf >= 1.1) &&
    unseenTrades >= 4
  ) {
    status = 'GOOD MATCH';
  } else {
    status = 'MODERATE MATCH';
  }

  // Positive performance reasons
  if (expR >= 0.15 && pf >= 1.25) {
    matchReasons.push(
      `Strong unseen OOS expectancy (+${expR.toFixed(2)}R/trade, PF ${pf.toFixed(2)}, ${targetOos.winRate}% WR)`
    );
  }

  const bestConditions: string[] = [
    `${bestComboOverall.regime} market`,
    `${bestComboOverall.timeframe} timeframe`,
    ...(bestComboOverall.bestSession ? [bestComboOverall.bestSession] : []),
  ];

  const performanceSeries: StrategyMatchItem['performanceSeries'] = [
    {
      label: 'In-Sample',
      returnPercent: targetIs.netReturnPercent,
      expectancyR: targetIs.expectancyR,
      trades: targetIs.trades,
    },
    {
      label: 'Unseen OOS',
      returnPercent: targetOos.netReturnPercent,
      expectancyR: targetOos.expectancyR,
      trades: targetOos.trades,
    },
    ...(targetHoldout.trades > 0
      ? [
          {
            label: 'Final Holdout',
            returnPercent: targetHoldout.netReturnPercent,
            expectancyR: targetHoldout.expectancyR,
            trades: targetHoldout.trades,
          },
        ]
      : []),
  ];

  return {
    rank: 0,
    strategy: group.strategy,
    matchingScore,
    status,
    evidenceSource: 'discovery_combo',
    sourceRunId: group.sourceRunId,
    sourceComboKey: primaryCombo.comboKey,
    matchedSymbol: primaryCombo.symbol,
    matchedTimeframe: primaryCombo.timeframe,
    bestTimeframe: bestComboOverall.timeframe,
    bestRegime: bestComboOverall.regime,
    bestConditions,
    winRate: targetOos.winRate,
    profitFactor: targetOos.profitFactor,
    avgRMultiple: targetOos.expectancyR,
    expectancyR: targetOos.expectancyR,
    maxDrawdownPercent: targetOos.maxDrawdownPercent,
    tradesTested: totalIsOosTrades,
    unseenTestTrades: unseenTrades,
    recentOosPerformance: {
      winRate: targetOos.winRate,
      profitFactor: targetOos.profitFactor,
      expectancyR: targetOos.expectancyR,
      netReturnPercent: targetOos.netReturnPercent,
      maxDrawdownPercent: targetOos.maxDrawdownPercent,
      trades: targetOos.trades,
      holdoutReturnPercent: targetHoldout.trades > 0 ? targetHoldout.netReturnPercent : null,
      holdoutTrades: targetHoldout.trades > 0 ? targetHoldout.trades : null,
      wfConsistencyPercent: primaryCombo.wfConsistencyPercent,
    },
    validationStatus: primaryCombo.validationStatus,
    productionReadiness: readiness,
    bestSession: primaryCombo.bestSession,
    avoidSessions: primaryCombo.avoidSessions,
    matchReasons: matchReasons.slice(0, 4),
    cautionNotes: cautionNotes.slice(0, 3),
    componentScores: {
      conditionFit: Math.round(conditionFit),
      validationQuality: Math.round(validationQuality),
      expectancyRisk: Math.round(expectancyRisk),
      timeframeSessionFit: Math.round(timeframeSessionFit),
    },
    conditionMatches,
    performanceSeries,
  };
}

function evaluateStandaloneBacktestCandidate(
  run: BacktestRunResult,
  stratIdx: number,
  condition: LiveMarketConditionAnalysis
): StrategyMatchItem {
  const res = run.strategies[stratIdx];
  const m = res.metrics;
  const style = inferStrategyStyle(res.strategy);
  const styleEval = styleCompatibilityPoints(style, condition);
  const tfEval = timeframeProximityPoints(run.config.timeframe, condition.timeframe);

  const matchReasons: string[] = [styleEval.note];
  const cautionNotes: string[] = [
    'Standalone backtest without IS/OOS regime split — run Discovery Scan for full out-of-sample validation',
  ];

  // Style/condition fit (0..22 max for unsplit backtests)
  const conditionFit = clamp(styleEval.pts * 1.9, 0, 20);
  // Validation quality capped (max 14/30 since no unseen OOS split exists)
  const validationQuality = m.totalTrades >= 20 ? 14 : m.totalTrades >= 10 ? 10 : 5;

  let expectancyRisk = 0;
  const pf = m.profitFactor ?? 0;
  if (m.expectancyR > 0) {
    expectancyRisk += clamp((m.expectancyR / 0.45) * 11, 0, 11);
    expectancyRisk += clamp(((pf - 1.0) / 1.2) * 9, 0, 9);
  }
  if (m.maxDrawdownPercent > 12) {
    expectancyRisk = Math.max(0, expectancyRisk - clamp((m.maxDrawdownPercent - 12) * 0.85, 0, 15));
    cautionNotes.push(`Historical Max Drawdown ${m.maxDrawdownPercent.toFixed(1)}%`);
  }

  const timeframeSessionFit = clamp(tfEval.pts + 3, 0, 15);
  if (run.config.timeframe === condition.timeframe) {
    matchReasons.push(tfEval.label);
  } else {
    cautionNotes.push(tfEval.label);
  }

  let rawScore = conditionFit + validationQuality + expectancyRisk + timeframeSessionFit;
  if (m.totalTrades < 8) {
    rawScore = Math.min(rawScore, 45);
    cautionNotes.push(`Small sample (${m.totalTrades} trades)`);
  } else if (m.totalTrades < 15) {
    rawScore *= 0.85;
  }

  const matchingScore = Math.round(clamp(rawScore, 0, 82));

  let status: StrategyRecommendationStatus;
  if (m.totalTrades < 8) {
    status = 'INSUFFICIENT DATA';
  } else if (m.expectancyR <= 0 || pf < 1.0 || matchingScore < 40) {
    status = 'POOR MATCH';
  } else if (
    matchingScore >= 60 &&
    m.expectancyR >= 0.08 &&
    pf >= 1.2 &&
    m.totalTrades >= 15 &&
    m.maxDrawdownPercent <= 20
  ) {
    status = 'GOOD MATCH';
  } else {
    status = 'MODERATE MATCH';
  }

  const inferredRegime: MarketRegimeType =
    style === 'trend'
      ? 'Trending'
      : style === 'reversion'
        ? 'Ranging'
        : style === 'breakout'
          ? 'High Volatility'
          : condition.discoveryRegimeMapping;

  const conditionMatches = computeConditionMatches({
    style,
    condition,
    directRegimeMatch: inferredRegime === condition.discoveryRegimeMapping,
    liveRegimeExpectancyR: m.expectancyR,
    liveRegimeTrades: m.totalTrades,
    bestRegime: inferredRegime,
    isPoorInCurrentRegime: false,
  });

  if (conditionMatches.matchedCount === 3) {
    matchReasons.push(
      `All 3 live filters align (${condition.volatility} Vol, ${condition.direction}, ${condition.regime})`
    );
  }

  return {
    rank: 0,
    strategy: res.strategy,
    matchingScore,
    status,
    evidenceSource: 'backtest_run',
    sourceRunId: run.id,
    matchedSymbol: run.config.symbol,
    matchedTimeframe: run.config.timeframe,
    bestTimeframe: run.config.timeframe,
    bestRegime: inferredRegime,
    bestConditions: [`${inferredRegime} bias (${style} style)`, `${run.config.timeframe} timeframe`],
    winRate: m.winRate,
    profitFactor: m.profitFactor,
    avgRMultiple: m.expectancyR,
    expectancyR: m.expectancyR,
    maxDrawdownPercent: m.maxDrawdownPercent,
    tradesTested: m.totalTrades,
    unseenTestTrades: 0,
    recentOosPerformance: {
      winRate: m.winRate,
      profitFactor: m.profitFactor,
      expectancyR: m.expectancyR,
      netReturnPercent: m.netReturnPercent,
      maxDrawdownPercent: m.maxDrawdownPercent,
      trades: m.totalTrades,
      holdoutReturnPercent: null,
      holdoutTrades: null,
      wfConsistencyPercent: null,
    },
    validationStatus: 'Backtest Only',
    bestSession: null,
    avoidSessions: [],
    matchReasons: matchReasons.slice(0, 4),
    cautionNotes: cautionNotes.slice(0, 3),
    componentScores: {
      conditionFit: Math.round(conditionFit),
      validationQuality: Math.round(validationQuality),
      expectancyRisk: Math.round(expectancyRisk),
      timeframeSessionFit: Math.round(timeframeSessionFit),
    },
    conditionMatches,
    performanceSeries: [
      {
        label: 'Full Backtest',
        returnPercent: m.netReturnPercent,
        expectancyR: m.expectancyR,
        trades: m.totalTrades,
      },
    ],
  };
}

/**
 * Filters and scores existing Discovery and Backtest database entries against real-time
 * Volatility, Trend, and Market Regime conditions to populate the Top 50 strategy recommendations.
 * Never fabricates strategies, never ranks solely on win rate, prioritizes unseen OOS + validation.
 */
export function matchBacktestedStrategiesToMarket(params: {
  condition: LiveMarketConditionAnalysis;
  discoveryRuns: DiscoveryScanRun[];
  backtestRuns: BacktestRunResult[];
  conditionFilter?: LiveConditionFilterMode;
  maxRecommendations?: number;
}): {
  decision: LiveMarketRecommendationDecision;
  databaseCoverage: LiveMarketStrategyReport['databaseCoverage'];
} {
  const {
    condition,
    discoveryRuns,
    backtestRuns,
    conditionFilter = 'all',
    maxRecommendations = 50,
  } = params;
  const safeLimit = Math.max(1, Math.min(100, Math.round(maxRecommendations)));
  const symbol = condition.symbol;

  const uniqueStrategies = new Set<string>();
  let matchingSymbolRecords = 0;

  // 1. Index newest Discovery combinations per strategy for the selected symbol
  const discoveryByStrategy = new Map<string, DiscoveryStrategyGroup>();
  for (const run of discoveryRuns) {
    for (const combo of run.combinations) {
      uniqueStrategies.add(combo.strategy.id);
      if (combo.symbol !== symbol) continue;
      matchingSymbolRecords += 1;

      const existing = discoveryByStrategy.get(combo.strategy.id);
      if (!existing) {
        discoveryByStrategy.set(combo.strategy.id, {
          strategy: combo.strategy,
          sourceRunId: run.id,
          combos: [combo],
        });
      } else if (existing.sourceRunId === run.id) {
        existing.combos.push(combo);
      }
    }
  }

  // 2. Index newest standalone Backtest runs for strategies not yet covered by Discovery
  const backtestFallbackByStrategy = new Map<
    string,
    { run: BacktestRunResult; idx: number }
  >();
  for (const run of backtestRuns) {
    for (let i = 0; i < run.strategies.length; i++) {
      const res = run.strategies[i];
      if (res.metrics.totalTrades === 0) continue;
      uniqueStrategies.add(res.strategy.id);
      if (run.config.symbol !== symbol) continue;
      matchingSymbolRecords += 1;

      if (
        !discoveryByStrategy.has(res.strategy.id) &&
        !backtestFallbackByStrategy.has(res.strategy.id)
      ) {
        backtestFallbackByStrategy.set(res.strategy.id, { run, idx: i });
      }
    }
  }

  const evaluated: StrategyMatchItem[] = [];
  for (const group of discoveryByStrategy.values()) {
    evaluated.push(evaluateDiscoveryCandidate(group, condition));
  }
  for (const item of backtestFallbackByStrategy.values()) {
    evaluated.push(evaluateStandaloneBacktestCandidate(item.run, item.idx, condition));
  }

  const statusOrder: Record<StrategyRecommendationStatus, number> = {
    'BEST MATCH': 5,
    'GOOD MATCH': 4,
    'MODERATE MATCH': 3,
    'INSUFFICIENT DATA': 2,
    'POOR MATCH': 1,
  };

  evaluated.sort((a, b) => {
    const sd = statusOrder[b.status] - statusOrder[a.status];
    if (sd !== 0) return sd;
    if (b.matchingScore !== a.matchingScore) return b.matchingScore - a.matchingScore;
    if (b.conditionMatches.matchedCount !== a.conditionMatches.matchedCount) {
      return b.conditionMatches.matchedCount - a.conditionMatches.matchedCount;
    }
    if (b.expectancyR !== a.expectancyR) return b.expectancyR - a.expectancyR;
    return b.unseenTestTrades - a.unseenTestTrades;
  });

  // Compute live condition filter counts across the full evaluated database set
  const regimeMatchedCount = evaluated.filter((s) => s.conditionMatches.regimeMatch).length;
  const trendMatchedCount = evaluated.filter((s) => s.conditionMatches.trendMatch).length;
  const volatilityMatchedCount = evaluated.filter((s) => s.conditionMatches.volatilityMatch).length;
  const matchedConditionPool = evaluated.filter(
    (s) =>
      s.conditionMatches.regimeMatch &&
      s.conditionMatches.trendMatch &&
      s.conditionMatches.volatilityMatch
  );

  const filteredPool =
    conditionFilter === 'matched_conditions'
      ? evaluated.filter(
          (s) =>
            s.conditionMatches.regimeMatch &&
            s.conditionMatches.matchedCount >= 2 &&
            s.status !== 'POOR MATCH'
        )
      : evaluated;

  const topStrategies = filteredPool.slice(0, safeLimit).map((item, idx) => ({
    ...item,
    rank: idx + 1,
  }));

  const reliableItems = topStrategies.filter(
    (s) => s.status === 'BEST MATCH' || s.status === 'GOOD MATCH'
  );
  const hasReliableMatch = reliableItems.length > 0;
  const bestStrategy = topStrategies[0] ?? null;
  const secondBestStrategy = topStrategies[1] ?? null;

  // Check whether top qualified strategies agree
  const positiveMatches = topStrategies.filter(
    (s) =>
      s.status === 'BEST MATCH' ||
      s.status === 'GOOD MATCH' ||
      s.status === 'MODERATE MATCH'
  );
  let strategiesAgree = false;
  let agreementSummary = 'Not enough qualifying strategies to check consensus.';
  if (positiveMatches.length >= 2) {
    const sampleSize = Math.min(5, positiveMatches.length);
    const styles = positiveMatches.slice(0, sampleSize).map((s) => inferStrategyStyle(s.strategy));
    const dominantStyle = styles[0];
    const agreeCount = styles.filter((st) => st === dominantStyle || st === 'hybrid').length;
    strategiesAgree = agreeCount >= 2;
    agreementSummary = strategiesAgree
      ? `${agreeCount} of top ${sampleSize} matched strategies agree on ${condition.regime} (${dominantStyle}/SMC) market execution.`
      : `Top matched strategies use diverging styles (${Array.from(new Set(styles)).join(' vs ')}) — look for extra confirmation before entering.`;
  } else if (positiveMatches.length === 1) {
    agreementSummary = `Only 1 strategy (${positiveMatches[0].strategy.name}) currently matches with positive evidence.`;
  }

  // Determine Market Suitability & Trade vs Wait Verdict
  const verdictReasons: string[] = [];
  let marketSuitability: LiveMarketRecommendationDecision['marketSuitability'] = 'WAIT';
  let actionVerdict: LiveMarketRecommendationDecision['actionVerdict'] = 'WAIT';

  if (!condition.marketOpen) {
    marketSuitability = 'WAIT';
    actionVerdict = 'WAIT';
    verdictReasons.push(`Market is currently closed for ${condition.symbol}.`);
  } else if (matchingSymbolRecords === 0) {
    marketSuitability = 'WAIT';
    actionVerdict = 'WAIT';
    verdictReasons.push(
      `No historical Discovery or Backtest runs exist yet for ${condition.symbol}. Run Strategy Discovery or Backtest first.`
    );
  } else if (!hasReliableMatch) {
    marketSuitability = 'WAIT';
    actionVerdict = 'WAIT';
    verdictReasons.push(
      `NO RELIABLE STRATEGY MATCH: Best candidate scored ${bestStrategy?.matchingScore ?? 0}% (${bestStrategy?.status ?? 'No Data'}) with insufficient validated OOS proof in ${condition.regime}.`
    );
  } else if (
    condition.volatility === 'Extreme' &&
    bestStrategy?.bestRegime !== 'High Volatility'
  ) {
    marketSuitability = 'WAIT';
    actionVerdict = 'WAIT';
    verdictReasons.push(
      `Extreme volatility (${condition.atrPercentile.toFixed(0)}th pct) exceeds normal validated conditions for ${bestStrategy?.strategy.name}.`
    );
  } else if (condition.sessionShort === 'Late / Rollover' && condition.symbol.startsWith('XA')) {
    marketSuitability = 'SELECTIVE';
    actionVerdict = 'WAIT';
    verdictReasons.push(
      'Metals Late / Rollover window (21:00–00:00 UTC) typically carries wide spreads; wait for Asian/London liquidity.'
    );
  } else if (
    bestStrategy?.status === 'BEST MATCH' &&
    (strategiesAgree || (bestStrategy.productionReadiness === 'Production Ready')) &&
    condition.reversalCondition.riskLevel !== 'High'
  ) {
    marketSuitability = 'TRADEABLE';
    actionVerdict = 'TRADE NOW';
    verdictReasons.push(
      `${bestStrategy.strategy.name} is a ${bestStrategy.matchingScore}% BEST MATCH in ${condition.regime} (${condition.discoveryRegimeMapping}) on ${bestStrategy.matchedTimeframe}.`
    );
    verdictReasons.push(
      `Unseen OOS Expectancy +${bestStrategy.expectancyR.toFixed(2)}R across ${bestStrategy.unseenTestTrades} test trades (PF ${bestStrategy.profitFactor?.toFixed(2) ?? '—'}).`
    );
  } else {
    marketSuitability = 'SELECTIVE';
    actionVerdict = 'SELECTIVE SETUP';
    verdictReasons.push(
      `${bestStrategy!.strategy.name} is a ${bestStrategy!.status} (${bestStrategy!.matchingScore}%) — wait for clean structural trigger or ${condition.breakoutCondition.state.toLowerCase()} confirmation.`
    );
    if (condition.reversalCondition.riskLevel === 'High') {
      verdictReasons.push(
        `Elevated reversal risk detected (${condition.reversalCondition.summary}); reduce size or wait for confirmation.`
      );
    }
  }

  return {
    decision: {
      hasReliableMatch,
      bestStrategy,
      secondBestStrategy,
      topStrategies,
      allEvaluatedCount: evaluated.length,
      filterCriteria: {
        liveVolatility: condition.volatility,
        liveTrendDirection: condition.direction,
        liveTrendStrength: condition.trendStrengthLabel,
        liveRegime: condition.regime,
        mappedRegime: condition.discoveryRegimeMapping,
        conditionFilterMode: conditionFilter,
        maxRecommendations: safeLimit,
      },
      filterCounts: {
        totalEvaluated: evaluated.length,
        matchedConditionCount: matchedConditionPool.length,
        regimeMatchedCount,
        trendMatchedCount,
        volatilityMatchedCount,
        bestMatchCount: evaluated.filter((s) => s.status === 'BEST MATCH').length,
        goodMatchCount: evaluated.filter((s) => s.status === 'GOOD MATCH').length,
        moderateMatchCount: evaluated.filter((s) => s.status === 'MODERATE MATCH').length,
        returnedCount: topStrategies.length,
      },
      strategiesAgree,
      agreementSummary,
      marketSuitability,
      actionVerdict,
      verdictReasons,
    },
    databaseCoverage: {
      discoveryRunsCount: discoveryRuns.length,
      backtestRunsCount: backtestRuns.length,
      uniqueStrategiesTested: uniqueStrategies.size,
      matchingSymbolRecords,
      latestDiscoveryRunId: discoveryRuns[0]?.id ?? null,
      latestBacktestRunId: backtestRuns[0]?.id ?? null,
    },
  };
}

export function buildLiveMarketStrategyReport(params: {
  snapshot: AnalysisSnapshot;
  htfSnapshot?: AnalysisSnapshot | null;
  mtfSummary?: MultiTimeframeSummary | null;
  quote?: LiveQuote | null;
  discoveryRuns: DiscoveryScanRun[];
  backtestRuns: BacktestRunResult[];
  conditionFilter?: LiveConditionFilterMode;
  maxRecommendations?: number;
  nowMs?: number;
}): LiveMarketStrategyReport {
  const condition = analyzeLiveMarketCondition({
    snapshot: params.snapshot,
    htfSnapshot: params.htfSnapshot,
    mtfSummary: params.mtfSummary,
    quote: params.quote,
    nowMs: params.nowMs,
  });

  const { decision, databaseCoverage } = matchBacktestedStrategiesToMarket({
    condition,
    discoveryRuns: params.discoveryRuns,
    backtestRuns: params.backtestRuns,
    conditionFilter: params.conditionFilter,
    maxRecommendations: params.maxRecommendations,
  });

  return {
    condition,
    decision,
    databaseCoverage,
  };
}
