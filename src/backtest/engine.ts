import { runDeterministicAnalysis } from '../analysis/engine.ts';
import {
  DEFAULT_TECHNICAL_SETTINGS,
  getInstrumentMeta,
  TIMEFRAME_SECONDS,
} from '../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  BacktestConfig,
  BacktestRunResult,
  BacktestStrategyId,
  BacktestStrategyResult,
  Candle,
  LiveQuote,
  ProviderStatus,
  TechnicalSettings,
  Timeframe,
} from '../shared/types/index.ts';
import { StrategyPortfolioSimulator } from './simulator/index.ts';
import {
  BACKTEST_STRATEGY_DEFINITIONS,
  evaluateStrategiesOnBar,
} from './strategies/index.ts';

export function resolveDefaultHtfTimeframe(tf: Timeframe): Timeframe {
  switch (tf) {
    case '1m':
    case '3m':
      return '1H';
    case '5m':
    case '15m':
    case '30m':
      return '4H';
    case '1H':
    case '2H':
      return '4H';
    case '4H':
    case '6H':
    case '12H':
      return '1D';
    default:
      return '1W';
  }
}

export function buildDefaultBacktestConfig(
  overrides: Partial<BacktestConfig> = {}
): BacktestConfig {
  const timeframe: Timeframe = overrides.timeframe ?? '15m';
  return {
    symbol: overrides.symbol ?? 'BTCUSDT',
    timeframe,
    htfTimeframe: overrides.htfTimeframe ?? resolveDefaultHtfTimeframe(timeframe),
    bars: overrides.bars ?? 500,
    initialCapital: overrides.initialCapital ?? 10000,
    riskPerTradePercent: overrides.riskPerTradePercent ?? 1.0,
    commissionBps: overrides.commissionBps ?? 4,
    slippageBps: overrides.slippageBps ?? 2,
    minRiskReward: overrides.minRiskReward ?? 1.5,
    moveStopToBreakevenAfterTp1: overrides.moveStopToBreakevenAfterTp1 ?? true,
    strategyIds: overrides.strategyIds,
  };
}

function normalizeClosedSeries(candles: Candle[]): Candle[] {
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

export interface RunMultiStrategyBacktestInput {
  config: BacktestConfig;
  execCandles: Candle[];
  htfCandles: Candle[];
  dailyCandles: Candle[];
  providerName: string;
  technicalSettings?: TechnicalSettings;
}

/**
 * Runs a strictly causal, zero-lookahead multi-strategy SMC & Price Action backtest
 * across historical OHLCV bars and ranks all tested strategies by institutional metrics.
 */
export function runMultiStrategyBacktest(
  input: RunMultiStrategyBacktestInput
): BacktestRunResult {
  const startedAt = Date.now();
  const config = buildDefaultBacktestConfig(input.config);
  const techSettings = input.technicalSettings ?? DEFAULT_TECHNICAL_SETTINGS;

  const execCandles = normalizeClosedSeries(input.execCandles).slice(-config.bars);
  const htfCandles = normalizeClosedSeries(input.htfCandles);
  const dailyCandles = normalizeClosedSeries(input.dailyCandles);

  if (execCandles.length < 80) {
    throw new Error(
      `Insufficient historical candles for ${config.symbol} ${config.timeframe} (got ${execCandles.length}, need at least 80)`
    );
  }

  const enabledList =
    config.strategyIds && config.strategyIds.length > 0
      ? BACKTEST_STRATEGY_DEFINITIONS.filter((d) => config.strategyIds!.includes(d.id))
      : BACKTEST_STRATEGY_DEFINITIONS;

  if (enabledList.length === 0) {
    throw new Error('At least one strategy must be enabled for backtesting');
  }

  const enabledSet = new Set<BacktestStrategyId>(enabledList.map((d) => d.id));
  const execSec = TIMEFRAME_SECONDS[config.timeframe];
  const htfSec = TIMEFRAME_SECONDS[config.htfTimeframe];
  const daySec = TIMEFRAME_SECONDS['1D'];

  const warmupBars = Math.min(60, Math.max(30, Math.floor(execCandles.length * 0.2)));
  const startTime = execCandles[warmupBars]?.time ?? execCandles[0].time;

  const simulators = new Map<BacktestStrategyId, StrategyPortfolioSimulator>();
  for (const def of enabledList) {
    simulators.set(def.id, new StrategyPortfolioSimulator(def, config, startTime));
  }

  const assetClass = getInstrumentMeta(config.symbol).assetClass;
  const mockProviderStatus: ProviderStatus = {
    symbol: config.symbol,
    assetClass,
    providerName: input.providerName,
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
    const bar = execCandles[i];
    const barCloseTime = bar.time + execSec;

    // 1. Advance all strategy simulators on bar i BEFORE generating bar-close signals
    for (const sim of simulators.values()) {
      sim.onBar(bar, i);
    }

    // Do not emit new pending signals on final bar since there is no future bar to fill
    if (i >= execCandles.length - 1) {
      break;
    }

    evaluatedBars += 1;

    // 2. Advance strictly closed Daily & HTF cursors up to exec bar close time (zero lookahead)
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
            symbol: config.symbol,
            price: htfLast.close,
            change24h: 0,
            changePercent24h: 0,
            direction: htfLast.close >= htfLast.open ? 'bullish' : 'bearish',
            provider: input.providerName,
            lastUpdateTime: htfLast.time * 1000,
            providerTimestamp: htfLast.time * 1000,
            feedDelaySeconds: 0,
            connectionStatus: 'CONNECTED',
            marketOpen: true,
            stale: false,
          }
        : null;

      cachedHtfSnap = runDeterministicAnalysis({
        symbol: config.symbol,
        timeframe: config.htfTimeframe,
        candles: causalHtfWindow,
        dailyCandles: causalDailyWindow,
        htfTrend: 'consolidation',
        quote: htfQuote,
        providerStatus: mockProviderStatus,
        settings: techSettings,
      });
    }

    // Check if every strategy already has an open or pending position -> skip heavy analysis if busy
    let anyReadyForSignal = false;
    for (const sim of simulators.values()) {
      if (!sim.hasOpenOrPending()) {
        anyReadyForSignal = true;
        break;
      }
    }
    if (!anyReadyForSignal) continue;

    // 3. Causal execution timeframe analysis slice ending at bar i
    const execWindow = execCandles.slice(Math.max(0, i - 160), i + 1);
    const barQuote: LiveQuote = {
      symbol: config.symbol,
      price: bar.close,
      change24h: 0,
      changePercent24h: 0,
      direction: bar.close >= bar.open ? 'bullish' : 'bearish',
      provider: input.providerName,
      lastUpdateTime: bar.time * 1000,
      providerTimestamp: bar.time * 1000,
      feedDelaySeconds: 0,
      connectionStatus: 'CONNECTED',
      marketOpen: true,
      stale: false,
    };

    const execSnap = runDeterministicAnalysis({
      symbol: config.symbol,
      timeframe: config.timeframe,
      candles: execWindow,
      dailyCandles: causalDailyWindow,
      htfTrend: cachedHtfSnap?.marketStructure.trend ?? 'consolidation',
      quote: barQuote,
      providerStatus: mockProviderStatus,
      settings: techSettings,
    });

    // 4. Evaluate only strategies that do not currently hold an active/pending trade
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
      config
    );

    for (const candidate of candidates) {
      simulators.get(candidate.strategyId)?.submitSignal(candidate, i, bar.time);
    }
  }

  // Finalize any positions still open at end of historical dataset
  const lastBar = execCandles[execCandles.length - 1];
  const lastIndex = execCandles.length - 1;
  for (const sim of simulators.values()) {
    sim.finalizeAtEndOfData(lastBar, lastIndex);
  }

  // Build & rank all strategy results
  const rawResults: BacktestStrategyResult[] = Array.from(simulators.values()).map((sim) =>
    sim.buildResult()
  );

  rawResults.sort((a, b) => {
    const aHas = a.metrics.totalTrades > 0 ? 1 : 0;
    const bHas = b.metrics.totalTrades > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    if (b.metrics.compositeScore !== a.metrics.compositeScore) {
      return b.metrics.compositeScore - a.metrics.compositeScore;
    }
    if (b.metrics.netReturnPercent !== a.metrics.netReturnPercent) {
      return b.metrics.netReturnPercent - a.metrics.netReturnPercent;
    }
    const aPf = a.metrics.profitFactor ?? 0;
    const bPf = b.metrics.profitFactor ?? 0;
    if (bPf !== aPf) return bPf - aPf;
    return b.metrics.totalTrades - a.metrics.totalTrades;
  });

  const trimTradesForLargeBatch = rawResults.length > 500;
  const rankedResults = rawResults.map((r, idx) => ({
    ...r,
    rank: idx + 1,
    trades:
      trimTradesForLargeBatch && r.trades.length > 200
        ? r.trades.slice(0, 200)
        : r.trades,
  }));

  const best = rankedResults.find((r) => r.metrics.totalTrades > 0) ?? rankedResults[0] ?? null;
  const bestStrategyId = best ? best.strategy.id : null;
  const bestStrategyReason = best
    ? best.metrics.totalTrades > 0
      ? `${best.strategy.name} ranked #1 (Score ${best.metrics.compositeScore}/100) with ${best.metrics.netReturnPercent >= 0 ? '+' : ''}${best.metrics.netReturnPercent}% return, ${best.metrics.winRate}% win rate across ${best.metrics.totalTrades} trades, PF ${best.metrics.profitFactor ?? '—'}, and ${best.metrics.maxDrawdownPercent}% max drawdown.`
      : `None of the ${rankedResults.length} tested strategies produced qualifying setups in this ${execCandles.length}-bar window.`
    : 'No strategies executed.';

  return {
    id: `BT-${config.symbol}-${config.timeframe}-${startedAt}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    config,
    dataRange: {
      startTime: execCandles[0].time,
      endTime: lastBar.time,
      totalBars: execCandles.length,
      evaluatedBars,
      htfBars: htfCandles.length,
      provider: input.providerName,
    },
    bestStrategyId,
    bestStrategyReason,
    strategies: rankedResults,
  };
}
