import type {
  AnalysisSnapshot,
  Candle,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  TechnicalSettings,
  Timeframe,
} from '../shared/types/index.ts';
import { detectBosChoch } from './bos-choch/index.ts';
import { detectCandlestickPatterns } from './candle-patterns/index.ts';
import { detectChartPatterns } from './chart-patterns/index.ts';
import { detectFairValueGaps } from './fair-value-gaps/index.ts';
import { detectLiquidityPools } from './liquidity/index.ts';
import { buildMarketStructureState } from './market-structure/index.ts';
import { detectOrderBlocks } from './order-blocks/index.ts';
import { computeDealingRange } from './premium-discount/index.ts';
import { analyzeTradingSessions } from './sessions/index.ts';
import { detectSupportResistanceZones } from './support-resistance/index.ts';
import { detectSupplyDemandZones } from './supply-demand/index.ts';
import { computeATR, detectSwingPoints } from './swing-engine/index.ts';
import { detectTrendlines } from './trendlines/index.ts';

export interface RunAnalysisInput {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  candles: Candle[];
  dailyCandles: Candle[];
  htfTrend: 'bullish' | 'bearish' | 'consolidation';
  quote: LiveQuote | null;
  providerStatus: ProviderStatus;
  settings: TechnicalSettings;
  dealingRangeLookback?: number;
}

/**
 * Runs deterministic technical analysis & Smart Money Concepts across genuine OHLCV candles.
 * Zero AI, zero synthetic data, strict non-repainting separation of confirmed vs provisional detections.
 */
export function runDeterministicAnalysis(input: RunAnalysisInput): AnalysisSnapshot {
  const {
    symbol,
    timeframe,
    candles,
    dailyCandles,
    htfTrend,
    quote,
    providerStatus,
    settings,
    dealingRangeLookback,
  } = input;

  const atr = computeATR(candles, 14);
  const rawSwings = detectSwingPoints(candles, symbol, timeframe, settings);
  const breaks = detectBosChoch(candles, rawSwings, symbol, timeframe, settings);
  const marketStructure = buildMarketStructureState(symbol, timeframe, rawSwings, breaks);

  const { sessions, anchors } = analyzeTradingSessions(candles, dailyCandles, symbol);
  const supportResistance = detectSupportResistanceZones(
    candles,
    marketStructure.swings,
    anchors,
    sessions,
    atr,
    symbol,
    timeframe,
    settings
  );
  const supplyDemand = detectSupplyDemandZones(
    candles,
    atr,
    symbol,
    timeframe,
    htfTrend,
    settings
  );
  const liquidityPools = detectLiquidityPools(
    candles,
    marketStructure.swings,
    anchors,
    atr,
    symbol,
    timeframe,
    settings
  );
  const orderBlocks = detectOrderBlocks(candles, breaks, atr, symbol, timeframe, settings);
  const fairValueGaps = detectFairValueGaps(candles, atr, symbol, timeframe, settings);
  const trendlines = detectTrendlines(
    candles,
    marketStructure.swings,
    atr,
    symbol,
    timeframe,
    settings
  );
  const dealingRange = computeDealingRange(
    candles,
    marketStructure.swings,
    symbol,
    timeframe,
    timeframe,
    dealingRangeLookback
  );
  const candlestickPatterns = detectCandlestickPatterns(
    candles,
    atr,
    symbol,
    timeframe,
    settings
  );
  const chartPatterns = detectChartPatterns(
    candles,
    marketStructure.swings,
    atr,
    symbol,
    timeframe,
    settings
  );

  return {
    symbol,
    timeframe,
    candles,
    quote,
    providerStatus,
    atr,
    marketStructure,
    candlestickPatterns,
    chartPatterns,
    supportResistance,
    supplyDemand,
    liquidityPools,
    orderBlocks,
    fairValueGaps,
    trendlines,
    dealingRange,
    sessions,
    sessionAnchors: anchors,
    zoneInteractions: [],
    liveEvents: [],
    lastAnalyzedAt: Date.now(),
  };
}
