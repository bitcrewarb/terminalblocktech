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

function downsampleEquityCurve(
  curve: BacktestStrategyResult['equityCurve'],
  maxPoints: number
): BacktestStrategyResult['equityCurve'] {
  if (curve.length <= maxPoints || maxPoints < 2) return curve;
  const out: BacktestStrategyResult['equityCurve'] = [];
  const step = (curve.length - 1) / (maxPoints - 1);
  for (let k = 0; k < maxPoints; k++) {
    const idx = Math.min(curve.length - 1, Math.round(k * step));
    if (out.length === 0 || out[out.length - 1] !== curve[idx]) {
      out.push(curve[idx]);
    }
  }
  return out;
}

interface PreparedBacktestState {
  startedAt: number;
  config: BacktestConfig;
  techSettings: TechnicalSettings;
  execCandles: Candle[];
  htfCandles: Candle[];
  dailyCandles: Candle[];
  enabledSet: Set<BacktestStrategyId>;
  execSec: number;
  htfSec: number;
  daySec: number;
  warmupBars: number;
  simulators: Map<BacktestStrategyId, StrategyPortfolioSimulator>;
  mockProviderStatus: ProviderStatus;
}

function prepareBacktestState(input: RunMultiStrategyBacktestInput): PreparedBacktestState {
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

  let enabledList = BACKTEST_STRATEGY_DEFINITIONS;
  if (config.strategyIds && config.strategyIds.length > 0) {
    const requestedSet = new Set(config.strategyIds);
    enabledList = BACKTEST_STRATEGY_DEFINITIONS.filter((d) => requestedSet.has(d.id));
  }

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

  return {
    startedAt,
    config,
    techSettings,
    execCandles,
    htfCandles,
    dailyCandles,
    enabledSet,
    execSec,
    htfSec,
    daySec,
    warmupBars,
    simulators,
    mockProviderStatus,
  };
}

function finalizeBacktestResult(
  state: PreparedBacktestState,
  input: RunMultiStrategyBacktestInput,
  evaluatedBars: number
): BacktestRunResult {
  const { startedAt, config, execCandles, htfCandles, simulators } = state;
  const lastBar = execCandles[execCandles.length - 1];
  const lastIndex = execCandles.length - 1;

  for (const sim of simulators.values()) {
    sim.finalizeAtEndOfData(lastBar, lastIndex);
  }

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

  // Trim payload safely on huge 500–3,400+ strategy batches so JSON / SQLite never overflow
  const trimLargeBatch = rawResults.length > 500;
  const rankedResults = rawResults.map((r, idx) => {
    const rank = idx + 1;
    if (!trimLargeBatch) {
      return { ...r, rank };
    }
    const maxTrades = idx < 150 ? 100 : 15;
    const maxCurvePoints = idx < 150 ? 60 : 24;
    return {
      ...r,
      rank,
      trades: r.trades.length > maxTrades ? r.trades.slice(0, maxTrades) : r.trades,
      equityCurve: downsampleEquityCurve(r.equityCurve, maxCurvePoints),
    };
  });

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

/**
 * Runs a strictly causal, zero-lookahead multi-strategy SMC & Price Action backtest
 * across historical OHLCV bars and ranks all tested strategies by institutional metrics.
 */
export function runMultiStrategyBacktest(
  input: RunMultiStrategyBacktestInput
): BacktestRunResult {
  const state = prepareBacktestState(input);
  const {
    config,
    techSettings,
    execCandles,
    htfCandles,
    dailyCandles,
    enabledSet,
    execSec,
    htfSec,
    daySec,
    warmupBars,
    simulators,
    mockProviderStatus,
  } = state;

  let htfCursor = 0;
  let dayCursor = 0;
  let lastHtfComputedCount = -1;
  let cachedHtfSnap: AnalysisSnapshot | null = null;
  let evaluatedBars = 0;

  for (let i = warmupBars; i < execCandles.length; i++) {
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

    let anyReadyForSignal = false;
    for (const sim of simulators.values()) {
      if (!sim.hasOpenOrPending()) {
        anyReadyForSignal = true;
        break;
      }
    }
    if (!anyReadyForSignal) continue;

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

  return finalizeBacktestResult(state, input, evaluatedBars);
}

/**
 * Event-loop friendly async version for large 3,300+ strategy API requests.
 * Yields periodically via setImmediate so WebSocket feeds and UI remain responsive.
 */
export async function runMultiStrategyBacktestAsync(
  input: RunMultiStrategyBacktestInput
): Promise<BacktestRunResult> {
  const state = prepareBacktestState(input);
  const {
    config,
    techSettings,
    execCandles,
    htfCandles,
    dailyCandles,
    enabledSet,
    execSec,
    htfSec,
    daySec,
    warmupBars,
    simulators,
    mockProviderStatus,
  } = state;

  let htfCursor = 0;
  let dayCursor = 0;
  let lastHtfComputedCount = -1;
  let cachedHtfSnap: AnalysisSnapshot | null = null;
  let evaluatedBars = 0;

  for (let i = warmupBars; i < execCandles.length; i++) {
    if (i % 60 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
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

    let anyReadyForSignal = false;
    for (const sim of simulators.values()) {
      if (!sim.hasOpenOrPending()) {
        anyReadyForSignal = true;
        break;
      }
    }
    if (!anyReadyForSignal) continue;

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

  return finalizeBacktestResult(state, input, evaluatedBars);
}
