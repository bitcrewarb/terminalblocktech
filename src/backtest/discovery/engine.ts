import { runDeterministicAnalysis } from '../../analysis/engine.ts';
import {
  DEFAULT_TECHNICAL_SETTINGS,
  getInstrumentMeta,
  INSTRUMENTS,
  TIMEFRAME_SECONDS,
} from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  AnnotatedDiscoveryTrade,
  BacktestConfig,
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  BacktestTradeRecord,
  Candle,
  ChronologicalSplitLabel,
  CombinationDetailResult,
  CombinationRegimePerformance,
  DiscoveryMarketCoverage,
  DiscoveryScanConfig,
  DiscoveryScanRun,
  DiscoveryStrategyScope,
  InstrumentSymbol,
  LiveQuote,
  MarketRegimeType,
  PoorRegimeSummary,
  ProductionAuditSummary,
  ProductionReadinessStatus,
  ProviderStatus,
  SessionTimePerformance,
  StrategyDiscoveryCombination,
  TechnicalSettings,
  Timeframe,
  TradingSessionName,
  ValidationStatus,
  WalkForwardFoldResult,
  WindowSegmentMetrics,
} from '../../shared/types/index.ts';
import { buildDefaultBacktestConfig, resolveDefaultHtfTimeframe } from '../engine.ts';
import { StrategyPortfolioSimulator } from '../simulator/index.ts';
import { BACKTEST_STRATEGY_DEFINITIONS, evaluateStrategiesOnBar } from '../strategies/index.ts';
import {
  ALL_MARKET_REGIMES,
  buildRegimeDistribution,
  type CausalRegimeBarFeature,
  classifyMarketRegimesCausally,
} from './regime.ts';

function roundNum(val: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function normalizeDiscoveryCandles(candles: Candle[]): Candle[] {
  const sorted = [...candles]
    .filter(
      (c) =>
        c.isClosed !== false &&
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  const deduped: Candle[] = [];
  for (const c of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === c.time) {
      deduped[deduped.length - 1] = { ...c, isClosed: true };
    } else {
      deduped.push({ ...c, isClosed: true });
    }
  }
  return deduped;
}

export function buildDefaultDiscoveryConfig(
  overrides: Partial<DiscoveryScanConfig> = {}
): DiscoveryScanConfig {
  const symbols: InstrumentSymbol[] =
    overrides.symbols && overrides.symbols.length > 0
      ? overrides.symbols
      : INSTRUMENTS.map((i) => i.symbol);
  const timeframes: Timeframe[] =
    overrides.timeframes && overrides.timeframes.length > 0
      ? overrides.timeframes
      : ['5m', '15m', '30m', '1H', '4H'];

  return {
    symbols,
    timeframes,
    barsPerTimeframe: Math.max(240, Math.min(20000, Math.round(overrides.barsPerTimeframe ?? 900))),
    initialCapital: overrides.initialCapital ?? 10000,
    riskPerTradePercent: overrides.riskPerTradePercent ?? 1.0,
    commissionBps: overrides.commissionBps ?? 4,
    slippageBps: overrides.slippageBps ?? 2,
    minRiskReward: overrides.minRiskReward ?? 1.5,
    moveStopToBreakevenAfterTp1: overrides.moveStopToBreakevenAfterTp1 ?? true,
    strategyScope: overrides.strategyScope ?? 'core',
    categories: overrides.categories,
    minOosTradesForValidation: Math.max(2, Math.round(overrides.minOosTradesForValidation ?? 4)),
    minTotalSampleForValidation: Math.max(6, Math.round(overrides.minTotalSampleForValidation ?? 10)),
    isRatio: overrides.isRatio ?? 0.5,
    oosRatio: overrides.oosRatio ?? 0.25,
  };
}

/**
 * Selects strategies deterministically based on scope:
 * - 'core': balanced ~125-strategy institutional suite (25 per category including base + dynamic/W/M/hybrid variants)
 * - 'category': all strategies matching requested categories
 * - 'all': complete 1,117+ strategy catalog
 */
export function selectDiscoveryStrategies(
  scope: DiscoveryStrategyScope,
  categories?: BacktestStrategyCategory[]
): BacktestStrategyDefinition[] {
  const filteredByCategory =
    categories && categories.length > 0
      ? BACKTEST_STRATEGY_DEFINITIONS.filter((d) => categories.includes(d.category))
      : BACKTEST_STRATEGY_DEFINITIONS;

  if (scope === 'all' || scope === 'category') {
    return filteredByCategory;
  }

  // 'core' balanced institutional sample across all 5 categories (25 per category = ~125 strategies)
  const targetPerCategory = 25;
  const cats: BacktestStrategyCategory[] =
    categories && categories.length > 0
      ? categories
      : ['SMC', 'Price Action', 'Chart Patterns', 'Support & Resistance', 'Hybrid SMC/PA'];

  const selected: BacktestStrategyDefinition[] = [];
  for (const cat of cats) {
    const bucket = filteredByCategory.filter((d) => d.category === cat);
    if (bucket.length <= targetPerCategory) {
      selected.push(...bucket);
      continue;
    }
    // Always include first 8 foundational strategies + 17 evenly spaced strategies across the bucket
    const picks = new Set<BacktestStrategyDefinition>();
    for (let i = 0; i < Math.min(8, bucket.length); i++) {
      picks.add(bucket[i]);
    }
    const remainingPool = bucket.slice(8);
    const needed = targetPerCategory - picks.size;
    if (needed > 0 && remainingPool.length > 0) {
      const step = remainingPool.length / needed;
      for (let j = 0; j < needed; j++) {
        const idx = Math.min(remainingPool.length - 1, Math.floor(j * step));
        picks.add(remainingPool[idx]);
      }
    }
    selected.push(...picks);
  }
  return selected;
}

/**
 * Evaluates a chronological slice of trades on a clean fixed-base capital trajectory ($10,000 start)
 * using each trade's actual realizedR and risk-per-trade % so segment metrics (IS, OOS, Holdout, WF Fold)
 * are strictly isolated from prior window equity compounding.
 */
export function computeIsolatedSegmentMetrics(
  trades: BacktestTradeRecord[],
  riskPerTradePercent: number,
  timeframe: Timeframe,
  symbol: InstrumentSymbol
): WindowSegmentMetrics {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const total = ordered.length;
  if (total === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      breakevenTrades: 0,
      winRate: 0,
      netReturnPercent: 0,
      profitFactor: null,
      expectancyR: 0,
      avgR: 0,
      avgWinR: 0,
      avgLossR: 0,
      rewardToRiskRatio: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      avgBarsHeld: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let breakevenTrades = 0;
  let grossProfitR = 0;
  let grossLossR = 0;
  let sumR = 0;
  let sumBars = 0;

  let equity = 10000;
  let peak = 10000;
  let maxDdPct = 0;
  const tradeReturns: number[] = [];
  const riskFrac = Math.max(0.0005, riskPerTradePercent / 100);

  for (const t of ordered) {
    const r = Number.isFinite(t.realizedR) ? t.realizedR : 0;
    sumR += r;
    sumBars += t.barsHeld;

    if (r > 0.02) {
      wins += 1;
      grossProfitR += r;
    } else if (r < -0.02) {
      losses += 1;
      grossLossR += Math.abs(r);
    } else {
      breakevenTrades += 1;
    }

    const retPct = r * riskFrac;
    tradeReturns.push(retPct);
    equity = Math.max(0, equity * (1 + retPct));
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  const netReturnPercent = roundNum(((equity - 10000) / 10000) * 100, 2);
  const winRate = roundNum((wins / total) * 100, 1);
  const profitFactor =
    grossLossR > 0 ? roundNum(grossProfitR / grossLossR, 2) : grossProfitR > 0 ? 9.9 : null;
  const expectancyR = roundNum(sumR / total, 2);
  const avgBarsHeld = roundNum(sumBars / total, 1);

  let sharpeRatio = 0;
  if (tradeReturns.length >= 2) {
    const mean = tradeReturns.reduce((s, v) => s + v, 0) / tradeReturns.length;
    const variance =
      tradeReturns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / tradeReturns.length;
    const sd = Math.sqrt(variance);
    if (sd > 1e-8) {
      const spanSec = Math.max(
        TIMEFRAME_SECONDS[timeframe],
        ordered[ordered.length - 1].exitTime - ordered[0].entryTime
      );
      const isCrypto = symbol === 'BTCUSDT' || symbol === 'ETHUSDT';
      const secPerYear = (isCrypto ? 365 : 252) * 86400;
      const tradesPerYear = Math.min(2500, Math.max(1, (total / spanSec) * secPerYear));
      sharpeRatio = roundNum((mean / sd) * Math.sqrt(tradesPerYear), 2);
    }
  }

  const avgWinR = wins > 0 ? roundNum(grossProfitR / wins, 2) : 0;
  const avgLossR = losses > 0 ? roundNum(grossLossR / losses, 2) : 0;
  const rewardToRiskRatio =
    avgLossR > 0 ? roundNum(avgWinR / avgLossR, 2) : avgWinR > 0 ? roundNum(avgWinR, 2) : 0;

  return {
    trades: total,
    wins,
    losses,
    breakevenTrades,
    winRate,
    netReturnPercent,
    profitFactor,
    expectancyR,
    avgR: expectancyR,
    avgWinR,
    avgLossR,
    rewardToRiskRatio,
    maxDrawdownPercent: roundNum(maxDdPct, 2),
    sharpeRatio,
    avgBarsHeld,
  };
}

export interface SingleSeriesSimulationOutput {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  provider: string;
  execCandles: Candle[];
  warmupBars: number;
  evaluatedBars: number;
  isEndIndex: number;
  oosEndIndex: number;
  startTime: number;
  isEndTime: number;
  oosEndTime: number;
  endTime: number;
  regimeFeatures: CausalRegimeBarFeature[];
  regimeByTime: Map<number, MarketRegimeType>;
  tradesByStrategy: Map<BacktestStrategyId, BacktestTradeRecord[]>;
  fullResultsByStrategy: Map<BacktestStrategyId, ReturnType<StrategyPortfolioSimulator['buildResult']>>;
}

/**
 * Runs a single causal pass for one (Symbol, Timeframe) across all requested strategies,
 * collecting chronological trades + causal bar-by-bar market regimes.
 * Never mixes Final Holdout data into IS/OOS/WF evaluation.
 */
export async function simulateSeriesForDiscovery(params: {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  execCandlesRaw: Candle[];
  htfCandlesRaw: Candle[];
  dailyCandlesRaw: Candle[];
  providerName: string;
  strategies: BacktestStrategyDefinition[];
  config: DiscoveryScanConfig;
  technicalSettings?: TechnicalSettings;
}): Promise<SingleSeriesSimulationOutput> {
  const execCandles = normalizeDiscoveryCandles(params.execCandlesRaw).slice(
    -params.config.barsPerTimeframe
  );
  const htfCandles = normalizeDiscoveryCandles(params.htfCandlesRaw);
  const dailyCandles = normalizeDiscoveryCandles(params.dailyCandlesRaw);

  if (execCandles.length < 100) {
    throw new Error(
      `Insufficient closed candles for ${params.symbol} ${params.timeframe} (got ${execCandles.length}, need >= 100 for IS/OOS/Holdout validation)`
    );
  }

  const regimeFeatures = classifyMarketRegimesCausally(execCandles);
  const regimeByTime = new Map<number, MarketRegimeType>();
  for (const f of regimeFeatures) {
    regimeByTime.set(f.time, f.regime);
  }

  const warmupBars = Math.min(80, Math.max(24, Math.floor(execCandles.length * 0.16)));
  const evalSpan = execCandles.length - 1 - warmupBars;
  const isCount = Math.max(24, Math.floor(evalSpan * params.config.isRatio));
  const oosCount = Math.max(15, Math.floor(evalSpan * params.config.oosRatio));
  const isEndIndex = Math.min(execCandles.length - 20, warmupBars + isCount);
  const oosEndIndex = Math.min(execCandles.length - 10, isEndIndex + oosCount);

  const startTime = execCandles[warmupBars].time;
  const isEndTime = execCandles[isEndIndex].time;
  const oosEndTime = execCandles[oosEndIndex].time;
  const endTime = execCandles[execCandles.length - 1].time;

  const btConfig: BacktestConfig = buildDefaultBacktestConfig({
    symbol: params.symbol,
    timeframe: params.timeframe,
    htfTimeframe: params.htfTimeframe,
    bars: execCandles.length,
    initialCapital: params.config.initialCapital,
    riskPerTradePercent: params.config.riskPerTradePercent,
    commissionBps: params.config.commissionBps,
    slippageBps: params.config.slippageBps,
    minRiskReward: params.config.minRiskReward,
    moveStopToBreakevenAfterTp1: params.config.moveStopToBreakevenAfterTp1,
    strategyIds: params.strategies.map((s) => s.id),
  });

  const simulators = new Map<BacktestStrategyId, StrategyPortfolioSimulator>();
  const enabledSet = new Set<BacktestStrategyId>();
  for (const def of params.strategies) {
    enabledSet.add(def.id);
    simulators.set(def.id, new StrategyPortfolioSimulator(def, btConfig, startTime));
  }

  const techSettings = params.technicalSettings ?? DEFAULT_TECHNICAL_SETTINGS;
  const execSec = TIMEFRAME_SECONDS[params.timeframe];
  const htfSec = TIMEFRAME_SECONDS[params.htfTimeframe];
  const daySec = TIMEFRAME_SECONDS['1D'];
  const assetClass = getInstrumentMeta(params.symbol).assetClass;

  const providerStatus: ProviderStatus = {
    symbol: params.symbol,
    assetClass,
    providerName: params.providerName,
    connectionStatus: 'CONNECTED',
    feedDelaySeconds: 0,
    lastUpdateTime: Date.now(),
    hasHistoricalCredentials: true,
    hasStreamingFeed: false,
  };

  let htfCursor = 0;
  let dayCursor = 0;
  let lastHtfComputedCount = -1;
  let cachedHtfSnap: AnalysisSnapshot | null = null;
  let evaluatedBars = 0;

  for (let i = warmupBars; i < execCandles.length; i++) {
    if (i % 120 === 0) {
      await yieldToEventLoop();
    }

    const bar = execCandles[i];
    const barCloseTime = bar.time + execSec;

    for (const sim of simulators.values()) {
      sim.onBar(bar, i);
    }

    if (i >= execCandles.length - 1) {
      break;
    }

    evaluatedBars += 1;

    while (
      dayCursor < dailyCandles.length &&
      dailyCandles[dayCursor].time + daySec <= barCloseTime
    ) {
      dayCursor += 1;
    }
    const causalDailyWindow = dailyCandles.slice(Math.max(0, dayCursor - 90), dayCursor);

    while (
      htfCursor < htfCandles.length &&
      htfCandles[htfCursor].time + htfSec <= barCloseTime
    ) {
      htfCursor += 1;
    }

    if (htfCursor >= 25 && htfCursor !== lastHtfComputedCount) {
      lastHtfComputedCount = htfCursor;
      const causalHtfWindow = htfCandles.slice(Math.max(0, htfCursor - 160), htfCursor);
      const htfLast = causalHtfWindow[causalHtfWindow.length - 1];
      const htfQuote: LiveQuote | null = htfLast
        ? {
            symbol: params.symbol,
            price: htfLast.close,
            change24h: 0,
            changePercent24h: 0,
            direction: htfLast.close >= htfLast.open ? 'bullish' : 'bearish',
            provider: params.providerName,
            lastUpdateTime: htfLast.time * 1000,
            providerTimestamp: htfLast.time * 1000,
            feedDelaySeconds: 0,
            connectionStatus: 'CONNECTED',
            marketOpen: true,
            stale: false,
          }
        : null;

      cachedHtfSnap = runDeterministicAnalysis({
        symbol: params.symbol,
        timeframe: params.htfTimeframe,
        candles: causalHtfWindow,
        dailyCandles: causalDailyWindow,
        htfTrend: 'consolidation',
        quote: htfQuote,
        providerStatus,
        settings: techSettings,
      });
    }

    let anyReady = false;
    for (const sim of simulators.values()) {
      if (!sim.hasOpenOrPending()) {
        anyReady = true;
        break;
      }
    }
    if (!anyReady) continue;

    const execWindow = execCandles.slice(Math.max(0, i - 160), i + 1);
    const barQuote: LiveQuote = {
      symbol: params.symbol,
      price: bar.close,
      change24h: 0,
      changePercent24h: 0,
      direction: bar.close >= bar.open ? 'bullish' : 'bearish',
      provider: params.providerName,
      lastUpdateTime: bar.time * 1000,
      providerTimestamp: bar.time * 1000,
      feedDelaySeconds: 0,
      connectionStatus: 'CONNECTED',
      marketOpen: true,
      stale: false,
    };

    const execSnap = runDeterministicAnalysis({
      symbol: params.symbol,
      timeframe: params.timeframe,
      candles: execWindow,
      dailyCandles: causalDailyWindow,
      htfTrend: cachedHtfSnap?.marketStructure.trend ?? 'consolidation',
      quote: barQuote,
      providerStatus,
      settings: techSettings,
    });

    const readyIds = new Set<BacktestStrategyId>();
    for (const [id, sim] of simulators.entries()) {
      if (enabledSet.has(id) && !sim.hasOpenOrPending()) {
        readyIds.add(id);
      }
    }

    const candidates = evaluateStrategiesOnBar(
      readyIds,
      execSnap,
      cachedHtfSnap,
      bar,
      btConfig
    );

    for (const candidate of candidates) {
      simulators.get(candidate.strategyId)?.submitSignal(candidate, i, bar.time);
    }
  }

  const lastBar = execCandles[execCandles.length - 1];
  const lastIndex = execCandles.length - 1;
  for (const sim of simulators.values()) {
    sim.finalizeAtEndOfData(lastBar, lastIndex);
  }

  const tradesByStrategy = new Map<BacktestStrategyId, BacktestTradeRecord[]>();
  const fullResultsByStrategy = new Map<
    BacktestStrategyId,
    ReturnType<StrategyPortfolioSimulator['buildResult']>
  >();
  for (const [id, sim] of simulators.entries()) {
    const res = sim.buildResult();
    fullResultsByStrategy.set(id, res);
    tradesByStrategy.set(id, [...res.trades].sort((a, b) => a.signalTime - b.signalTime));
  }

  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    htfTimeframe: params.htfTimeframe,
    provider: params.providerName,
    execCandles,
    warmupBars,
    evaluatedBars,
    isEndIndex,
    oosEndIndex,
    startTime,
    isEndTime,
    oosEndTime,
    endTime,
    regimeFeatures,
    regimeByTime,
    tradesByStrategy,
    fullResultsByStrategy,
  };
}

function classifyTradeSplit(
  trade: BacktestTradeRecord,
  isEndTime: number,
  oosEndTime: number
): ChronologicalSplitLabel {
  // Strict zero-leakage chronological containment:
  // IS: signal, entry, AND exit must all complete by isEndTime.
  // OOS: signal, entry, AND exit must all occur strictly within [isEndTime, oosEndTime] so zero Holdout bars ever leak into OOS.
  if (trade.signalTime < isEndTime && trade.exitTime <= isEndTime) {
    return 'IS';
  }
  if (trade.signalTime >= isEndTime && trade.exitTime <= oosEndTime) {
    return 'OOS';
  }
  return 'HOLDOUT';
}

export function computeWalkForwardFolds(
  preHoldoutTradesInRegime: BacktestTradeRecord[],
  startTime: number,
  oosEndTime: number,
  riskPerTradePercent: number,
  timeframe: Timeframe,
  symbol: InstrumentSymbol
): {
  folds: WalkForwardFoldResult[];
  activeFolds: number;
  profitableFolds: number;
  wfConsistencyPercent: number;
} {
  const span = Math.max(1, oosEndTime - startTime);
  const tfSeconds = TIMEFRAME_SECONDS[timeframe] || 900;
  // Purging + Embargo buffer (3 bars) prevents overlapping trade labels from leaking across train/test boundaries
  const embargoSec = tfSeconds * 3;
  // 4 rolling chronological walk-forward folds strictly inside [startTime, oosEndTime) (pre-holdout!)
  const foldWindows: Array<[number, number, number, number]> = [
    [0.0, 0.4, 0.4, 0.55],
    [0.15, 0.55, 0.55, 0.7],
    [0.3, 0.7, 0.7, 0.85],
    [0.45, 0.85, 0.85, 1.0],
  ];

  const folds: WalkForwardFoldResult[] = [];
  let activeFolds = 0;
  let profitableFolds = 0;

  foldWindows.forEach(([tr0, tr1, te0, te1], idx) => {
    const trainStartTime = Math.floor(startTime + span * tr0);
    const trainEndTime = Math.floor(startTime + span * tr1);
    const testStartTime = Math.floor(startTime + span * te0);
    const testEndTime = Math.floor(startTime + span * te1);

    // Purged training window: trade signal AND complete exit must finish before embargo cutoff prior to testStartTime
    const purgedTrainEnd = Math.max(trainStartTime, Math.min(trainEndTime, testStartTime - embargoSec));
    const trainTrades = preHoldoutTradesInRegime.filter(
      (t) =>
        t.signalTime >= trainStartTime &&
        t.entryTime >= trainStartTime &&
        t.exitTime <= purgedTrainEnd
    );

    // Strict isolated test window: trade signal, entry, AND complete exit outcome must fall inside [testStartTime, testEndTime]
    const testTrades = preHoldoutTradesInRegime.filter(
      (t) =>
        t.signalTime >= testStartTime &&
        t.entryTime >= testStartTime &&
        t.exitTime <= testEndTime
    );

    const trainMetrics = computeIsolatedSegmentMetrics(
      trainTrades,
      riskPerTradePercent,
      timeframe,
      symbol
    );
    const testMetrics = computeIsolatedSegmentMetrics(
      testTrades,
      riskPerTradePercent,
      timeframe,
      symbol
    );

    const active = testMetrics.trades >= 1;
    const positiveExpectancy = active && testMetrics.expectancyR > 0;
    const profitable =
      active && testMetrics.netReturnPercent > 0 && (testMetrics.profitFactor ?? 0) >= 1.05;

    if (active) {
      activeFolds += 1;
      if (positiveExpectancy && profitable) {
        profitableFolds += 1;
      }
    }

    folds.push({
      foldIndex: idx + 1,
      trainStartTime,
      trainEndTime,
      testStartTime,
      testEndTime,
      trainMetrics,
      testMetrics,
      active,
      profitable,
      positiveExpectancy,
    });
  });

  // Penalize low fold coverage so 1 lucky fold out of 4 isn't rewarded as 100% consistent
  const rawRate = activeFolds > 0 ? profitableFolds / activeFolds : 0;
  const coverageFactor = Math.min(1, activeFolds / 3);
  const wfConsistencyPercent = roundNum(rawRate * coverageFactor * 100, 1);

  return {
    folds,
    activeFolds,
    profitableFolds,
    wfConsistencyPercent,
  };
}

/**
 * Computes OOS Ranking Score (0..100) using ONLY IS, OOS, and Walk-Forward metrics.
 * Final Holdout is NEVER referenced here — guaranteeing zero holdout optimization bias.
 */
function computeOosRankingScore(
  isMetrics: WindowSegmentMetrics,
  oosMetrics: WindowSegmentMetrics,
  wfConsistencyPercent: number,
  wfActiveFolds: number
): number {
  if (oosMetrics.trades === 0) return 0;

  const expComponent = Math.max(-15, Math.min(28, oosMetrics.expectancyR * 35));
  const pfVal = Math.min(4.0, oosMetrics.profitFactor ?? 0);
  const pfComponent = Math.min(22, (pfVal / 2.2) * 22);
  const retComponent = Math.max(-12, Math.min(16, oosMetrics.netReturnPercent * 1.1));
  const wfComponent = (wfConsistencyPercent / 100) * 20;
  const winComponent = (oosMetrics.winRate / 100) * 10;

  // IS-to-OOS stability retention bonus (rewards edges that hold up OOS instead of collapsing from IS)
  let retentionBonus = 0;
  if (isMetrics.trades >= 3 && isMetrics.expectancyR > 0 && oosMetrics.expectancyR > 0) {
    const ratio = Math.min(1.2, oosMetrics.expectancyR / isMetrics.expectancyR);
    retentionBonus = ratio * 4;
  }

  const ddPenalty = Math.min(24, oosMetrics.maxDrawdownPercent * 1.25);
  const sampleDampener = 0.35 + 0.65 * Math.min(1, oosMetrics.trades / 10);
  const wfCoverageDampener = wfActiveFolds >= 2 ? 1.0 : 0.72;

  const raw =
    (expComponent + pfComponent + retComponent + wfComponent + winComponent + retentionBonus - ddPenalty) *
    sampleDampener *
    wfCoverageDampener;

  return Math.max(0, Math.min(100, roundNum(raw, 1)));
}

function evaluateValidationGate(params: {
  isMetrics: WindowSegmentMetrics;
  oosMetrics: WindowSegmentMetrics;
  wfConsistencyPercent: number;
  wfActiveFolds: number;
  wfProfitableFolds: number;
  config: DiscoveryScanConfig;
  poorRegimes: PoorRegimeSummary[];
}): { status: ValidationStatus; reasons: string[] } {
  const {
    isMetrics,
    oosMetrics,
    wfConsistencyPercent,
    wfActiveFolds,
    wfProfitableFolds,
    config,
    poorRegimes,
  } = params;
  const reasons: string[] = [];
  const totalIsOos = isMetrics.trades + oosMetrics.trades;

  const hasMinOos = oosMetrics.trades >= config.minOosTradesForValidation;
  const hasMinTotal = totalIsOos >= config.minTotalSampleForValidation;
  const hasMinWf = wfActiveFolds >= 2;

  reasons.push(
    `Sample size: ${oosMetrics.trades} OOS / ${isMetrics.trades} IS (${totalIsOos} combined, min ${config.minOosTradesForValidation} OOS & ${config.minTotalSampleForValidation} combined)`
  );
  reasons.push(
    `Walk-forward folds: ${wfProfitableFolds}/${wfActiveFolds} active test windows profitable (${wfConsistencyPercent}% weighted consistency)`
  );
  reasons.push(
    `OOS Expectancy: ${oosMetrics.expectancyR >= 0 ? '+' : ''}${oosMetrics.expectancyR}R | OOS PF: ${oosMetrics.profitFactor ?? 'N/A'} | OOS MaxDD: ${oosMetrics.maxDrawdownPercent}%`
  );

  if (poorRegimes.length > 0) {
    const worst = poorRegimes[0];
    reasons.push(
      `Weakest condition: ${worst.regime} (${worst.oosExpectancyR >= 0 ? '+' : ''}${worst.oosExpectancyR}R across ${worst.oosTrades} OOS trades)`
    );
  }

  // Gate 1: Strict Insufficient Evidence check
  if (oosMetrics.trades < Math.max(3, config.minOosTradesForValidation - 1) || totalIsOos < Math.max(6, config.minTotalSampleForValidation - 3) || wfActiveFolds < 2) {
    reasons.unshift('Insufficient out-of-sample trades or walk-forward fold coverage to confirm edge');
    return { status: 'Insufficient Evidence', reasons };
  }

  // Gate 2: Failed Validation check (adequate OOS sample, edge fails)
  if (
    hasMinOos &&
    (oosMetrics.expectancyR <= 0 ||
      oosMetrics.netReturnPercent <= 0 ||
      (oosMetrics.profitFactor ?? 0) < 1.0 ||
      wfConsistencyPercent < 30)
  ) {
    reasons.unshift('Out-of-sample expectancy or profit factor collapsed below breakeven threshold');
    return { status: 'Failed Validation', reasons };
  }

  // Gate 3: Full Institutional Validated Status
  if (
    hasMinOos &&
    hasMinTotal &&
    hasMinWf &&
    oosMetrics.expectancyR >= 0.08 &&
    (oosMetrics.profitFactor ?? 0) >= 1.2 &&
    oosMetrics.netReturnPercent > 0 &&
    isMetrics.expectancyR > 0 &&
    wfConsistencyPercent >= 50 &&
    oosMetrics.maxDrawdownPercent <= 25
  ) {
    reasons.unshift('Passed chronological IS + OOS + Walk-Forward consistency gates with zero holdout leakage');
    return { status: 'Validated', reasons };
  }

  // Gate 4: Preliminary Research Candidate (positive OOS direction but borderline sample/WF/IS alignment)
  reasons.unshift('Positive OOS edge observed, but below full sample, IS-retention, or WF consistency gate');
  return { status: 'Preliminary Candidate', reasons };
}

const SESSION_WINDOWS: Array<{
  session: TradingSessionName;
  utcStartHour: number;
  utcEndHour: number;
}> = [
  { session: 'Asian (00–07 UTC)', utcStartHour: 0, utcEndHour: 7 },
  { session: 'London Open (07–12 UTC)', utcStartHour: 7, utcEndHour: 12 },
  { session: 'London/NY Overlap (12–16 UTC)', utcStartHour: 12, utcEndHour: 16 },
  { session: 'NY Afternoon (16–21 UTC)', utcStartHour: 16, utcEndHour: 21 },
  { session: 'Late / Rollover (21–00 UTC)', utcStartHour: 21, utcEndHour: 24 },
];

export function getTradingSessionForTimestamp(unixSec: number): TradingSessionName {
  const hour = new Date(unixSec * 1000).getUTCHours();
  for (const w of SESSION_WINDOWS) {
    if (hour >= w.utcStartHour && hour < w.utcEndHour) {
      return w.session;
    }
  }
  return 'Late / Rollover (21–00 UTC)';
}

function approxNormalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

export function computeEdgeConfidencePercent(preHoldoutTrades: BacktestTradeRecord[]): number {
  const n = preHoldoutTrades.length;
  if (n < 4) return 0;
  const rs = preHoldoutTrades.map((t) => (Number.isFinite(t.realizedR) ? t.realizedR : 0));
  const mean = rs.reduce((s, v) => s + v, 0) / n;
  if (mean <= 0) return 0;
  const variance = rs.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  if (sd <= 1e-8) return 99.0;
  const tStat = mean / (sd / Math.sqrt(n));
  // Mild small-sample Student-t adjustment factor so tiny samples are not overconfident
  const dfPenalty = Math.sqrt(Math.max(1, n - 1) / (n + 2));
  const cdf = approxNormalCdf(tStat * dfPenalty);
  return roundNum(Math.max(0, Math.min(99.9, cdf * 100)), 1);
}

export function computeSessionTimeBreakdown(params: {
  preHoldoutTrades: BacktestTradeRecord[];
  holdoutTrades: BacktestTradeRecord[];
  riskPerTradePercent: number;
  timeframe: Timeframe;
  symbol: InstrumentSymbol;
}): {
  breakdown: SessionTimePerformance[];
  bestSession: TradingSessionName | null;
  bestUtcHours: string | null;
  avoidSessions: TradingSessionName[];
} {
  const { preHoldoutTrades, holdoutTrades, riskPerTradePercent, timeframe, symbol } = params;

  const breakdown: SessionTimePerformance[] = SESSION_WINDOWS.map((w) => {
    const pre = preHoldoutTrades.filter(
      (t) => getTradingSessionForTimestamp(t.signalTime) === w.session
    );
    const hold = holdoutTrades.filter(
      (t) => getTradingSessionForTimestamp(t.signalTime) === w.session
    );
    const preMetrics = computeIsolatedSegmentMetrics(pre, riskPerTradePercent, timeframe, symbol);
    const holdMetrics = computeIsolatedSegmentMetrics(hold, riskPerTradePercent, timeframe, symbol);
    return {
      session: w.session,
      utcStartHour: w.utcStartHour,
      utcEndHour: w.utcEndHour,
      preHoldoutTrades: preMetrics.trades,
      winRate: preMetrics.winRate,
      expectancyR: preMetrics.expectancyR,
      profitFactor: preMetrics.profitFactor,
      netReturnPercent: preMetrics.netReturnPercent,
      holdoutTrades: holdMetrics.trades,
      holdoutExpectancyR: holdMetrics.expectancyR,
    };
  });

  // Select bestSession STRICTLY from pre-holdout metrics (zero holdout leakage)
  const qualifiedBest = breakdown
    .filter((b) => b.preHoldoutTrades >= 2 && b.expectancyR > 0 && b.netReturnPercent > 0)
    .sort((a, b) => {
      const scoreA = a.expectancyR * Math.sqrt(a.preHoldoutTrades);
      const scoreB = b.expectancyR * Math.sqrt(b.preHoldoutTrades);
      return scoreB - scoreA;
    });

  const bestRow = qualifiedBest[0] ?? null;
  const bestSession = bestRow ? bestRow.session : null;
  const bestUtcHours = bestRow
    ? `${String(bestRow.utcStartHour).padStart(2, '0')}:00–${String(bestRow.utcEndHour % 24).padStart(2, '0')}:00 UTC`
    : null;

  const avoidSessions = breakdown
    .filter(
      (b) =>
        b.preHoldoutTrades >= 2 &&
        (b.expectancyR < 0 || b.netReturnPercent < 0 || (b.profitFactor ?? 0) < 0.95)
    )
    .map((b) => b.session);

  return { breakdown, bestSession, bestUtcHours, avoidSessions };
}

function evaluateProductionAudit(params: {
  validationStatus: ValidationStatus;
  isMetrics: WindowSegmentMetrics;
  oosMetrics: WindowSegmentMetrics;
  holdoutMetrics: WindowSegmentMetrics;
  edgeConfidencePercent: number;
}): ProductionAuditSummary {
  const { validationStatus, isMetrics, oosMetrics, holdoutMetrics, edgeConfidencePercent } = params;

  const isOosDecayRatio =
    isMetrics.expectancyR > 0.02
      ? roundNum(oosMetrics.expectancyR / isMetrics.expectancyR, 2)
      : null;

  const holdoutConfirmed =
    holdoutMetrics.trades >= 3 &&
    holdoutMetrics.expectancyR > 0 &&
    holdoutMetrics.netReturnPercent > 0 &&
    (holdoutMetrics.profitFactor ?? 0) >= 1.05;

  const holdoutCollapsed =
    holdoutMetrics.trades >= 3 &&
    (holdoutMetrics.expectancyR <= 0 || holdoutMetrics.netReturnPercent <= 0);

  let readiness: ProductionReadinessStatus = 'Not Ready';
  let summaryNote = 'Insufficient unseen trades or negative test expectancy.';

  if (validationStatus === 'Validated' && holdoutConfirmed && oosMetrics.trades >= 5) {
    readiness = 'Production Ready';
    summaryNote = `Passed IS + OOS + Walk-Forward AND stayed profitable on ${holdoutMetrics.trades} untouched Final Check trades (+${holdoutMetrics.netReturnPercent}%).`;
  } else if (
    (validationStatus === 'Validated' || validationStatus === 'Preliminary Candidate') &&
    holdoutCollapsed
  ) {
    readiness = 'Overfit / Decayed';
    summaryNote = `Looked strong in Unseen Test, but lost ${holdoutMetrics.netReturnPercent}% across ${holdoutMetrics.trades} Final Check trades. Skip live trading.`;
  } else if (validationStatus === 'Validated' || validationStatus === 'Preliminary Candidate') {
    readiness = 'Verify Paper';
    summaryNote =
      holdoutMetrics.trades < 3
        ? `Strong pre-holdout edge, only ${holdoutMetrics.trades} Final Check trades so far. Verify on paper first.`
        : `Profitable overall, borderline sample or confidence (${edgeConfidencePercent}%).`;
  }

  return {
    readiness,
    holdoutConfirmed,
    edgeConfidencePercent,
    isOosDecayRatio,
    summaryNote,
  };
}

/**
 * Transforms simulated series outputs across multiple (Symbol, Timeframe) datasets into
 * ranked Strategy + Instrument + Timeframe + Market Regime combinations.
 * Strictly isolated from Final Holdout during scoring, validation, and sorting.
 */
export function buildDiscoveryCombinationsFromSeries(
  seriesList: SingleSeriesSimulationOutput[],
  strategies: BacktestStrategyDefinition[],
  config: DiscoveryScanConfig
): StrategyDiscoveryCombination[] {
  const defMap = new Map(strategies.map((s) => [s.id, s]));
  const rawCombos: StrategyDiscoveryCombination[] = [];

  for (const series of seriesList) {
    const regimeBarCounts = buildRegimeDistribution(
      series.regimeFeatures,
      series.warmupBars,
      series.execCandles.length - 2
    );

    for (const [strategyId, allTrades] of series.tradesByStrategy.entries()) {
      const strategy = defMap.get(strategyId);
      if (!strategy || allTrades.length === 0) continue;

      // Partition trades strictly into IS, OOS, HOLDOUT and tag entryRegime causally
      const tradesByRegimeAndSplit = new Map<
        MarketRegimeType,
        {
          is: BacktestTradeRecord[];
          oos: BacktestTradeRecord[];
          holdout: BacktestTradeRecord[];
          preHoldout: BacktestTradeRecord[];
        }
      >();

      for (const r of ALL_MARKET_REGIMES) {
        tradesByRegimeAndSplit.set(r, { is: [], oos: [], holdout: [], preHoldout: [] });
      }

      for (const t of allTrades) {
        // Regime at signal bar close (causal: known at decision bar!)
        const entryRegime = series.regimeByTime.get(t.signalTime) ?? 'Transitional';
        const split = classifyTradeSplit(t, series.isEndTime, series.oosEndTime);
        const bucket = tradesByRegimeAndSplit.get(entryRegime)!;
        if (split === 'IS') {
          bucket.is.push(t);
          bucket.preHoldout.push(t);
        } else if (split === 'OOS') {
          bucket.oos.push(t);
          bucket.preHoldout.push(t);
        } else {
          bucket.holdout.push(t);
        }
      }

      // Compute full per-regime breakdown for this (Strategy, Symbol, Timeframe)
      const allRegimesBreakdown: CombinationRegimePerformance[] = ALL_MARKET_REGIMES.map(
        (regime) => {
          const b = tradesByRegimeAndSplit.get(regime)!;
          return {
            regime,
            barsInRegime: regimeBarCounts[regime] ?? 0,
            isMetrics: computeIsolatedSegmentMetrics(
              b.is,
              config.riskPerTradePercent,
              series.timeframe,
              series.symbol
            ),
            oosMetrics: computeIsolatedSegmentMetrics(
              b.oos,
              config.riskPerTradePercent,
              series.timeframe,
              series.symbol
            ),
            holdoutMetrics: computeIsolatedSegmentMetrics(
              b.holdout,
              config.riskPerTradePercent,
              series.timeframe,
              series.symbol
            ),
            fullPreHoldoutMetrics: computeIsolatedSegmentMetrics(
              b.preHoldout,
              config.riskPerTradePercent,
              series.timeframe,
              series.symbol
            ),
          };
        }
      );

      // Identify market conditions where this (Strategy, Symbol, Timeframe) performs poorly in OOS
      const poorRegimes: PoorRegimeSummary[] = allRegimesBreakdown
        .filter(
          (rb) =>
            rb.oosMetrics.trades >= 2 &&
            (rb.oosMetrics.expectancyR < 0 ||
              rb.oosMetrics.netReturnPercent < 0 ||
              (rb.oosMetrics.profitFactor ?? 0) < 1.0)
        )
        .sort((a, b) => a.oosMetrics.expectancyR - b.oosMetrics.expectancyR)
        .map((rb) => ({
          regime: rb.regime,
          oosTrades: rb.oosMetrics.trades,
          oosExpectancyR: rb.oosMetrics.expectancyR,
          oosProfitFactor: rb.oosMetrics.profitFactor,
          oosNetReturnPercent: rb.oosMetrics.netReturnPercent,
        }));

      // Evaluate every regime that produced at least 2 combined IS+OOS trades (or >=1 OOS trade)
      for (const rb of allRegimesBreakdown) {
        const b = tradesByRegimeAndSplit.get(rb.regime)!;
        const totalIsOosTrades = rb.isMetrics.trades + rb.oosMetrics.trades;
        if (totalIsOosTrades < 2 || rb.oosMetrics.trades === 0) continue;

        const wf = computeWalkForwardFolds(
          b.preHoldout,
          series.startTime,
          series.oosEndTime,
          config.riskPerTradePercent,
          series.timeframe,
          series.symbol
        );

        const oosScore = computeOosRankingScore(
          rb.isMetrics,
          rb.oosMetrics,
          wf.wfConsistencyPercent,
          wf.activeFolds
        );

        const gate = evaluateValidationGate({
          isMetrics: rb.isMetrics,
          oosMetrics: rb.oosMetrics,
          wfConsistencyPercent: wf.wfConsistencyPercent,
          wfActiveFolds: wf.activeFolds,
          wfProfitableFolds: wf.profitableFolds,
          config,
          poorRegimes: poorRegimes.filter((p) => p.regime !== rb.regime),
        });

        const strengths: string[] = [];
        const weaknesses: string[] = [];
        const recommendedConditions: string[] = [];

        if (rb.oosMetrics.expectancyR > 0.15) {
          strengths.push(`Strong OOS expectancy (+${rb.oosMetrics.expectancyR}R / trade)`);
        }
        if ((rb.oosMetrics.profitFactor ?? 0) >= 1.4) {
          strengths.push(`Healthy OOS Profit Factor (${rb.oosMetrics.profitFactor})`);
        }
        if (wf.wfConsistencyPercent >= 60) {
          strengths.push(
            `Walk-forward stability (${wf.profitableFolds}/${wf.activeFolds} test windows profitable)`
          );
        }
        if (rb.oosMetrics.maxDrawdownPercent <= 5) {
          strengths.push(`Contained OOS drawdown (${rb.oosMetrics.maxDrawdownPercent}%)`);
        }
        if (rb.isMetrics.expectancyR > 0 && rb.oosMetrics.expectancyR >= rb.isMetrics.expectancyR * 0.7) {
          strengths.push('Low IS-to-OOS decay');
        }

        if (rb.oosMetrics.expectancyR <= 0) {
          weaknesses.push(`Negative OOS expectancy (${rb.oosMetrics.expectancyR}R)`);
        }
        if (rb.oosMetrics.trades < config.minOosTradesForValidation) {
          weaknesses.push(
            `Low OOS trade sample (${rb.oosMetrics.trades} < ${config.minOosTradesForValidation})`
          );
        }
        if (rb.oosMetrics.maxDrawdownPercent > 12) {
          weaknesses.push(`Elevated OOS drawdown (${rb.oosMetrics.maxDrawdownPercent}%)`);
        }
        if (wf.activeFolds < 2 || wf.wfConsistencyPercent < 50) {
          weaknesses.push(`Uneven walk-forward consistency (${wf.wfConsistencyPercent}%)`);
        }
        for (const pr of poorRegimes.slice(0, 2)) {
          if (pr.regime !== rb.regime) {
            weaknesses.push(
              `Avoid ${pr.regime} (${pr.oosExpectancyR >= 0 ? '+' : ''}${pr.oosExpectancyR}R OOS over ${pr.oosTrades} trades)`
            );
          }
        }

        const preHoldoutSessionScope =
          b.preHoldout.length >= 4
            ? b.preHoldout
            : [...tradesByRegimeAndSplit.values()].flatMap((v) => v.preHoldout);
        const holdoutSessionScope =
          b.preHoldout.length >= 4
            ? b.holdout
            : [...tradesByRegimeAndSplit.values()].flatMap((v) => v.holdout);

        const sessionStats = computeSessionTimeBreakdown({
          preHoldoutTrades: preHoldoutSessionScope,
          holdoutTrades: holdoutSessionScope,
          riskPerTradePercent: config.riskPerTradePercent,
          timeframe: series.timeframe,
          symbol: series.symbol,
        });

        const edgeConfidencePercent = computeEdgeConfidencePercent(b.preHoldout);
        const productionAudit = evaluateProductionAudit({
          validationStatus: gate.status,
          isMetrics: rb.isMetrics,
          oosMetrics: rb.oosMetrics,
          holdoutMetrics: rb.holdoutMetrics,
          edgeConfidencePercent,
        });

        recommendedConditions.push(
          `Trade ${strategy.name} on ${series.symbol} (${series.timeframe}, HTF ${series.htfTimeframe}) during ${rb.regime} regime`
        );
        if (sessionStats.bestSession) {
          recommendedConditions.push(
            `Best Time Window: ${sessionStats.bestSession}`
          );
        }
        if (poorRegimes.length > 0) {
          recommendedConditions.push(
            `Stand aside or reduce risk during ${poorRegimes.map((p) => p.regime).join(', ')}`
          );
        }
        if (gate.status !== 'Validated') {
          recommendedConditions.push(
            `Status ${gate.status} — collect more closed historical samples before live allocation`
          );
        }

        rawCombos.push({
          comboKey: `${strategy.id}__${series.symbol}__${series.timeframe}__${rb.regime}`,
          rank: 0,
          strategy,
          symbol: series.symbol,
          timeframe: series.timeframe,
          htfTimeframe: series.htfTimeframe,
          regime: rb.regime,
          validationStatus: gate.status,
          validationReasons: gate.reasons,
          oosScore,
          wfConsistencyPercent: wf.wfConsistencyPercent,
          wfProfitableFolds: wf.profitableFolds,
          wfActiveFolds: wf.activeFolds,
          barsInRegime: rb.barsInRegime,
          totalIsOosTrades,
          isMetrics: rb.isMetrics,
          oosMetrics: rb.oosMetrics,
          holdoutMetrics: rb.holdoutMetrics,
          poorRegimes,
          allRegimesBreakdown,
          walkForwardFolds: wf.folds,
          strengths,
          weaknesses,
          recommendedConditions,
          bestSession: sessionStats.bestSession,
          bestUtcHours: sessionStats.bestUtcHours,
          avoidSessions: sessionStats.avoidSessions,
          sessionBreakdown: sessionStats.breakdown,
          productionAudit,
        });
      }
    }
  }

  // Strictly rank using ONLY ValidationStatus tier + OOS metrics + WF consistency.
  // NEVER inspect holdoutMetrics when sorting!
  const statusTier: Record<ValidationStatus, number> = {
    Validated: 3,
    'Preliminary Candidate': 2,
    'Insufficient Evidence': 1,
    'Failed Validation': 0,
  };

  rawCombos.sort((a, b) => {
    const tDiff = statusTier[b.validationStatus] - statusTier[a.validationStatus];
    if (tDiff !== 0) return tDiff;
    if (b.oosScore !== a.oosScore) return b.oosScore - a.oosScore;
    if (b.oosMetrics.expectancyR !== a.oosMetrics.expectancyR) {
      return b.oosMetrics.expectancyR - a.oosMetrics.expectancyR;
    }
    const aPf = a.oosMetrics.profitFactor ?? 0;
    const bPf = b.oosMetrics.profitFactor ?? 0;
    if (bPf !== aPf) return bPf - aPf;
    if (b.wfConsistencyPercent !== a.wfConsistencyPercent) {
      return b.wfConsistencyPercent - a.wfConsistencyPercent;
    }
    return b.oosMetrics.trades - a.oosMetrics.trades;
  });

  // Cap persisted array to top 500 combinations while preserving all Validated & Preliminary rows
  const validatedAndPrelim = rawCombos.filter(
    (c) => c.validationStatus === 'Validated' || c.validationStatus === 'Preliminary Candidate'
  );
  const rest = rawCombos.filter(
    (c) => c.validationStatus !== 'Validated' && c.validationStatus !== 'Preliminary Candidate'
  );
  const maxRows = 600;
  const kept =
    validatedAndPrelim.length >= maxRows
      ? validatedAndPrelim.slice(0, maxRows)
      : [...validatedAndPrelim, ...rest.slice(0, maxRows - validatedAndPrelim.length)];

  return kept.map((c, idx) => ({
    ...c,
    rank: idx + 1,
  }));
}

export interface DiscoveryMarketFetchFn {
  (symbol: InstrumentSymbol, timeframe: Timeframe, bars: number): Promise<{
    candles: Candle[];
    provider: string;
  }>;
}

export interface RunDiscoveryScanInput {
  config: Partial<DiscoveryScanConfig>;
  fetchHistory: DiscoveryMarketFetchFn;
  technicalSettings?: TechnicalSettings;
  onProgress?: (info: {
    completedSteps: number;
    totalSteps: number;
    currentSymbol?: InstrumentSymbol;
    currentTimeframe?: Timeframe;
    message: string;
  }) => void;
}

export async function runDiscoveryOptimizationScan(
  input: RunDiscoveryScanInput
): Promise<DiscoveryScanRun> {
  const startedAt = Date.now();
  const config = buildDefaultDiscoveryConfig(input.config);
  const strategies = selectDiscoveryStrategies(config.strategyScope, config.categories);

  if (strategies.length === 0) {
    throw new Error('No strategies matched the selected Discovery Scanner scope/categories');
  }

  const pairs: Array<{ symbol: InstrumentSymbol; timeframe: Timeframe }> = [];
  for (const symbol of config.symbols) {
    for (const timeframe of config.timeframes) {
      pairs.push({ symbol, timeframe });
    }
  }

  const totalSteps = pairs.length + 1;
  const seriesOutputs: SingleSeriesSimulationOutput[] = [];
  const marketCoverage: DiscoveryMarketCoverage[] = [];

  for (let idx = 0; idx < pairs.length; idx++) {
    const { symbol, timeframe } = pairs[idx];
    const htfTimeframe = resolveDefaultHtfTimeframe(timeframe);

    input.onProgress?.({
      completedSteps: idx,
      totalSteps,
      currentSymbol: symbol,
      currentTimeframe: timeframe,
      message: `Simulating ${strategies.length} strategies on ${symbol} ${timeframe} (HTF ${htfTimeframe})...`,
    });

    try {
      const execSec = TIMEFRAME_SECONDS[timeframe];
      const htfSec = TIMEFRAME_SECONDS[htfTimeframe];
      const tfRatio = Math.max(1, Math.round(htfSec / Math.max(60, execSec)));
      const htfBars = Math.max(200, Math.min(10000, Math.ceil(config.barsPerTimeframe / tfRatio) + 120));
      const dailyBars = Math.max(200, Math.min(4000, Math.ceil((config.barsPerTimeframe * execSec) / 86400) + 90));

      const [execRes, htfRes, dailyRes] = await Promise.all([
        input.fetchHistory(symbol, timeframe, config.barsPerTimeframe),
        input.fetchHistory(symbol, htfTimeframe, htfBars),
        input.fetchHistory(symbol, '1D', dailyBars).catch(() => ({ candles: [] as Candle[], provider: 'Fallback' })),
      ]);

      const simOut = await simulateSeriesForDiscovery({
        symbol,
        timeframe,
        htfTimeframe,
        execCandlesRaw: execRes.candles,
        htfCandlesRaw: htfRes.candles,
        dailyCandlesRaw: dailyRes.candles,
        providerName: execRes.provider,
        strategies,
        config,
        technicalSettings: input.technicalSettings,
      });

      seriesOutputs.push(simOut);

      const regimeDist = buildRegimeDistribution(
        simOut.regimeFeatures,
        simOut.warmupBars,
        simOut.execCandles.length - 2
      );

      marketCoverage.push({
        symbol,
        timeframe,
        htfTimeframe,
        totalBars: simOut.execCandles.length,
        evaluatedBars: simOut.evaluatedBars,
        isBars: simOut.isEndIndex - simOut.warmupBars,
        oosBars: simOut.oosEndIndex - simOut.isEndIndex,
        holdoutBars: simOut.execCandles.length - 1 - simOut.oosEndIndex,
        startTime: simOut.startTime,
        isEndTime: simOut.isEndTime,
        oosEndTime: simOut.oosEndTime,
        endTime: simOut.endTime,
        provider: execRes.provider,
        regimeDistribution: regimeDist,
      });
    } catch (err) {
      marketCoverage.push({
        symbol,
        timeframe,
        htfTimeframe,
        totalBars: 0,
        evaluatedBars: 0,
        isBars: 0,
        oosBars: 0,
        holdoutBars: 0,
        startTime: 0,
        isEndTime: 0,
        oosEndTime: 0,
        endTime: 0,
        provider: 'Unavailable',
        regimeDistribution: {
          Trending: 0,
          Ranging: 0,
          'High Volatility': 0,
          'Low Volatility': 0,
          Transitional: 0,
        },
        error: err instanceof Error ? err.message : 'Market fetch failed',
      });
    }
  }

  input.onProgress?.({
    completedSteps: pairs.length,
    totalSteps,
    message: 'Scoring IS/OOS/Walk-Forward consistency and ranking Strategy + Instrument + Timeframe + Regime combinations...',
  });

  const combinations = buildDiscoveryCombinationsFromSeries(seriesOutputs, strategies, config);

  let validatedCount = 0;
  let preliminaryCount = 0;
  let insufficientCount = 0;
  let failedCount = 0;
  for (const c of combinations) {
    if (c.validationStatus === 'Validated') validatedCount += 1;
    else if (c.validationStatus === 'Preliminary Candidate') preliminaryCount += 1;
    else if (c.validationStatus === 'Insufficient Evidence') insufficientCount += 1;
    else failedCount += 1;
  }

  return {
    id: `DISC-${startedAt}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    config,
    strategiesEvaluatedCount: strategies.length,
    marketCoverage,
    summaryStats: {
      totalCombinationsEvaluated: combinations.length,
      validatedCount,
      preliminaryCount,
      insufficientCount,
      failedCount,
      instrumentsScanned: Array.from(new Set(seriesOutputs.map((s) => s.symbol))),
      timeframesScanned: Array.from(new Set(seriesOutputs.map((s) => s.timeframe))),
    },
    combinations,
  };
}

/**
 * Computes complete on-demand backtest + chronological regime trade ledger for a single discovered combination.
 */
export async function inspectDiscoveryCombinationDetail(params: {
  combination: StrategyDiscoveryCombination;
  config: DiscoveryScanConfig;
  fetchHistory: DiscoveryMarketFetchFn;
  technicalSettings?: TechnicalSettings;
}): Promise<CombinationDetailResult> {
  const { combination, config } = params;
  const execSec = TIMEFRAME_SECONDS[combination.timeframe];
  const htfSec = TIMEFRAME_SECONDS[combination.htfTimeframe];
  const tfRatio = Math.max(1, Math.round(htfSec / Math.max(60, execSec)));
  const htfBars = Math.max(200, Math.min(10000, Math.ceil(config.barsPerTimeframe / tfRatio) + 120));
  const dailyBars = Math.max(200, Math.min(4000, Math.ceil((config.barsPerTimeframe * execSec) / 86400) + 90));

  const [execRes, htfRes, dailyRes] = await Promise.all([
    params.fetchHistory(combination.symbol, combination.timeframe, config.barsPerTimeframe),
    params.fetchHistory(combination.symbol, combination.htfTimeframe, htfBars),
    params.fetchHistory(combination.symbol, '1D', dailyBars).catch(() => ({ candles: [] as Candle[], provider: 'Fallback' })),
  ]);

  const simOut = await simulateSeriesForDiscovery({
    symbol: combination.symbol,
    timeframe: combination.timeframe,
    htfTimeframe: combination.htfTimeframe,
    execCandlesRaw: execRes.candles,
    htfCandlesRaw: htfRes.candles,
    dailyCandlesRaw: dailyRes.candles,
    providerName: execRes.provider,
    strategies: [combination.strategy],
    config,
    technicalSettings: params.technicalSettings,
  });

  const backtestResult = simOut.fullResultsByStrategy.get(combination.strategy.id)!;
  const annotatedTrades: AnnotatedDiscoveryTrade[] = backtestResult.trades.map((t) => ({
    ...t,
    split: classifyTradeSplit(t, simOut.isEndTime, simOut.oosEndTime),
    entryRegime: simOut.regimeByTime.get(t.signalTime) ?? 'Transitional',
  }));

  const regimeTimeline = simOut.regimeFeatures.slice(simOut.warmupBars).map((f) => ({
    time: f.time,
    regime: f.regime,
    split: (f.time < simOut.isEndTime
      ? 'IS'
      : f.time < simOut.oosEndTime
        ? 'OOS'
        : 'HOLDOUT') as ChronologicalSplitLabel,
  }));

  const tradesInTargetRegime = annotatedTrades.filter((t) => t.entryRegime === combination.regime);
  const sessionSource = tradesInTargetRegime.length >= 4 ? tradesInTargetRegime : annotatedTrades;
  const computedSessions = computeSessionTimeBreakdown({
    preHoldoutTrades: sessionSource.filter((t) => t.split !== 'HOLDOUT'),
    holdoutTrades: sessionSource.filter((t) => t.split === 'HOLDOUT'),
    riskPerTradePercent: config.riskPerTradePercent,
    timeframe: combination.timeframe,
    symbol: combination.symbol,
  });

  return {
    combination,
    backtestResult,
    annotatedTrades,
    splitBoundaries: {
      startTime: simOut.startTime,
      isEndTime: simOut.isEndTime,
      oosEndTime: simOut.oosEndTime,
      endTime: simOut.endTime,
    },
    regimeTimeline,
    sessionBreakdown: computedSessions.breakdown,
  };
}
