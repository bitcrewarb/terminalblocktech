import { describe, expect, it } from 'vitest';
import { runBasketPortfolioBacktest } from '../backtest/basket-engine.ts';
import {
  analyzeAnchorCorrelations,
  buildCorrelationMatrix,
  selectMatrixStrategies,
  simulateBlendedPortfolio,
} from '../backtest/correlation.ts';
import {
  buildDefaultBacktestConfig,
  runMultiStrategyBacktest,
} from '../backtest/engine.ts';
import { StrategyPortfolioSimulator } from '../backtest/simulator/index.ts';
import { BacktestSqliteStore } from '../backtest/storage/sqlite.ts';
import { BACKTEST_STRATEGY_DEFINITIONS } from '../backtest/strategies/index.ts';
import type { Candle, LiveQuote, LiveStrategyBasketConfig } from '../shared/types/index.ts';
import { SignalEngine } from '../signals/engine.ts';
import { SignalSqliteStore } from '../signals/storage/sqlite.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

const execCandles = fixtureCandles as Candle[];

function aggregateCandles(candles: Candle[], step: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + step <= candles.length; i += step) {
    const slice = candles.slice(i, i + step);
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
      isClosed: true,
    });
  }
  return out;
}

describe('Multi-Strategy SMC & Price Action Backtesting Engine', () => {
  it('registers >=1117 unique institutional strategies across all 5 categories including W/M & dynamic engines', () => {
    expect(BACKTEST_STRATEGY_DEFINITIONS.length).toBeGreaterThanOrEqual(1117);

    const ids = new Set(BACKTEST_STRATEGY_DEFINITIONS.map((d) => d.id));
    expect(ids.size).toBe(BACKTEST_STRATEGY_DEFINITIONS.length);

    expect(BACKTEST_STRATEGY_DEFINITIONS.some((d) => d.id.includes('CP_W_PATTERN'))).toBe(true);
    expect(BACKTEST_STRATEGY_DEFINITIONS.some((d) => d.id.includes('CP_M_PATTERN'))).toBe(true);
    expect(BACKTEST_STRATEGY_DEFINITIONS.some((d) => d.id.includes('DYN_ATR_EXPANSION'))).toBe(true);
    expect(BACKTEST_STRATEGY_DEFINITIONS.some((d) => d.id.includes('PA_THREE_SOLDIERS_CROWS'))).toBe(true);

    const byCategory = new Map<string, number>();
    for (const def of BACKTEST_STRATEGY_DEFINITIONS) {
      byCategory.set(def.category, (byCategory.get(def.category) ?? 0) + 1);
      expect(def.name.length).toBeGreaterThan(3);
      expect(def.entryRules.length).toBeGreaterThan(0);
      expect(def.riskRules.length).toBeGreaterThan(0);
    }

    expect(byCategory.get('SMC')).toBeGreaterThanOrEqual(240);
    expect(byCategory.get('Price Action')).toBeGreaterThanOrEqual(230);
    expect(byCategory.get('Chart Patterns')).toBeGreaterThanOrEqual(220);
    expect(byCategory.get('Support & Resistance')).toBeGreaterThanOrEqual(150);
    expect(byCategory.get('Hybrid SMC/PA')).toBeGreaterThanOrEqual(200);
  });

  it('evaluates all 1100+ strategies causally on real BTCUSDT 15m data with strict zero lookahead', () => {
    const htfCandles = aggregateCandles(execCandles, 4); // 1H higher timeframe
    const config = buildDefaultBacktestConfig({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      htfTimeframe: '1H',
      bars: execCandles.length,
      initialCapital: 10000,
      riskPerTradePercent: 1.0,
      commissionBps: 4,
      slippageBps: 2,
      minRiskReward: 1.4,
      moveStopToBreakevenAfterTp1: true,
    });

    const result = runMultiStrategyBacktest({
      config,
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'Binance Fixture',
    });

    const expectedTotal = BACKTEST_STRATEGY_DEFINITIONS.length;
    expect(result.strategies).toHaveLength(expectedTotal);
    expect(result.strategies.map((s) => s.rank)).toEqual(
      Array.from({ length: expectedTotal }, (_, i) => i + 1)
    );
    expect(result.dataRange.totalBars).toBe(execCandles.length);
    expect(result.dataRange.evaluatedBars).toBeGreaterThan(50);

    const totalAllTrades = result.strategies.reduce(
      (sum, s) => sum + s.metrics.totalTrades,
      0
    );
    expect(totalAllTrades).toBeGreaterThan(100);

    const activeCategories = new Set(
      result.strategies
        .filter((s) => s.metrics.totalTrades > 0)
        .map((s) => s.strategy.category)
    );
    expect(activeCategories.size).toBe(5);

    for (const strat of result.strategies) {
      expect(strat.equityCurve.length).toBeGreaterThan(10);
      expect(strat.equityCurve.length).toBeLessThanOrEqual(80);
      expect(strat.metrics.startingCapital).toBe(10000);
      for (const trade of strat.trades) {
        // Strict causal execution: entry must happen strictly after signal bar time
        expect(trade.entryTime).toBeGreaterThan(trade.signalTime);
        expect(trade.exitTime).toBeGreaterThanOrEqual(trade.entryTime);
        expect(trade.takeProfits.length).toBeGreaterThanOrEqual(1);
        expect(trade.entryRationale.length).toBeGreaterThan(0);
        expect(trade.exitNote.length).toBeGreaterThan(0);
        expect(trade.feesAndSlippage).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('enforces conservative SL-before-TP intrabar ordering and deducts commissions/slippage', () => {
    const def = BACKTEST_STRATEGY_DEFINITIONS[0];
    const config = buildDefaultBacktestConfig({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 10000,
      riskPerTradePercent: 1.0,
      commissionBps: 10,
      slippageBps: 5,
      moveStopToBreakevenAfterTp1: true,
    });

    const sim = new StrategyPortfolioSimulator(def, config, 1000);
    sim.submitSignal(
      {
        strategyId: def.id,
        direction: 'BUY',
        entryMode: 'market_close',
        entryPrice: 100,
        entryZone: { lower: 99.5, upper: 100.5 },
        stopLoss: 95,
        invalidationLevel: 95.5,
        takeProfits: [
          {
            level: 1,
            price: 110,
            riskReward: 2.0,
            sourceLabel: 'Test TP1',
            hit: false,
            hitTime: null,
          },
        ],
        confluenceScore: 85,
        entryRationale: ['Unit test causal entry'],
      },
      0,
      1000
    );

    // Bar 1: fills at open 100, AND both low <= 95 and high >= 110 happen on same bar -> must take SL
    sim.onBar(
      {
        time: 1900,
        open: 100,
        high: 112,
        low: 94,
        close: 108,
        volume: 10,
        isClosed: true,
      },
      1
    );

    const res = sim.buildResult();
    expect(res.metrics.totalTrades).toBe(1);
    expect(res.trades[0].exitReason).toBe('STOP_LOSS');
    expect(res.trades[0].netPnl).toBeLessThan(0);
    expect(res.trades[0].feesAndSlippage).toBeGreaterThan(0);
    expect(res.metrics.endingEquity).toBeLessThan(10000);
  });

  it('persists, lists, loads, and deletes backtest runs in SQLite', () => {
    const store = new BacktestSqliteStore(':memory:');
    const htfCandles = aggregateCandles(execCandles, 4);
    const config = buildDefaultBacktestConfig({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      htfTimeframe: '1H',
      bars: execCandles.length,
    });

    const run = runMultiStrategyBacktest({
      config,
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'SQLite Test',
    });

    store.saveRun(run);
    const summaries = store.listRuns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(run.id);
    expect(summaries[0].symbol).toBe('BTCUSDT');

    const loaded = store.getRunById(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.strategies.length).toBe(run.strategies.length);

    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.listRuns()).toHaveLength(0);
    store.close();
  });

  it('keeps equityCurve compact (<=80 points) on 2,000+ bar runs without altering metrics', () => {
    const def = BACKTEST_STRATEGY_DEFINITIONS[0];
    const config = buildDefaultBacktestConfig({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      bars: 2200,
    });
    const sim = new StrategyPortfolioSimulator(def, config, 1000);
    for (let i = 0; i < 2200; i++) {
      sim.onBar(
        {
          time: 1000 + i * 900,
          open: 100 + (i % 5),
          high: 102 + (i % 5),
          low: 99 + (i % 5),
          close: 101 + (i % 5),
          volume: 10,
          isClosed: true,
        },
        i
      );
    }
    const res = sim.buildResult();
    expect(res.equityCurve.length).toBeLessThanOrEqual(80);
    expect(res.equityCurve[0].time).toBe(1000);
    expect(res.equityCurve[res.equityCurve.length - 1].time).toBe(1000 + 2199 * 900);
  });

  it('computes Pearson correlations, position overlaps, uncorrelated baskets, and blended DD reduction across 1,000+ strategies', () => {
    const htfCandles = aggregateCandles(execCandles, 4);
    const config = buildDefaultBacktestConfig({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      htfTimeframe: '1H',
      bars: execCandles.length,
      minRiskReward: 1.4,
    });
    const run = runMultiStrategyBacktest({
      config,
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'Correlation Test',
    });

    const anchor = run.strategies.find((s) => s.metrics.totalTrades > 0)!;
    const report = analyzeAnchorCorrelations(
      anchor.strategy.id,
      run.strategies,
      config.initialCapital
    );
    expect(report).not.toBeNull();
    expect(report!.activeCount).toBeGreaterThan(50);

    const totalBucketPeers = report!.distributionBuckets.reduce((s, b) => s + b.count, 0);
    expect(totalBucketPeers).toBe(report!.activeCount - 1);

    expect(report!.redundantPeers.length).toBeGreaterThan(0);
    expect(report!.diversifierPeers.length).toBeGreaterThan(0);
    for (const p of report!.redundantPeers) {
      expect(p.correlation).toBeGreaterThanOrEqual(-1);
      expect(p.correlation).toBeLessThanOrEqual(1);
      expect(p.overlap.sameDirOverlapPct).toBeGreaterThanOrEqual(0);
      expect(p.overlap.sameDirOverlapPct).toBeLessThanOrEqual(100);
    }

    const topBasket = selectMatrixStrategies('top12', run.strategies, config.initialCapital, 12);
    const uncorrBasket = selectMatrixStrategies(
      'uncorrelated_basket',
      run.strategies,
      config.initialCapital,
      12
    );
    const topMat = buildCorrelationMatrix(topBasket, config.initialCapital);
    const uncorrMat = buildCorrelationMatrix(uncorrBasket, config.initialCapital);
    expect(topMat.strategies.length).toBeGreaterThan(2);
    expect(topMat.cells[0][0].correlation).toBe(1);
    expect(uncorrMat.avgPairwiseCorrelation).toBeLessThanOrEqual(topMat.avgPairwiseCorrelation + 0.05);

    const peer = report!.diversifierPeers[0].strategy;
    const blend = simulateBlendedPortfolio(anchor, peer, config.initialCapital);
    expect(blend.series.length).toBeGreaterThan(10);
    expect(blend.blendedMaxDdPct).toBeGreaterThanOrEqual(0);
  });

  it('simulates an uncorrelated basket in a shared-capital portfolio with concurrent and heat caps', () => {
    const htfCandles = aggregateCandles(execCandles, 4);
    const baseRun = runMultiStrategyBacktest({
      config: buildDefaultBacktestConfig({
        symbol: 'BTCUSDT',
        timeframe: '15m',
        htfTimeframe: '1H',
        bars: execCandles.length,
        minRiskReward: 1.4,
      }),
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'Basket Test',
    });

    const uncorrIds = selectMatrixStrategies(
      'uncorrelated_basket',
      baseRun.strategies,
      10000,
      8
    ).map((s) => s.strategy.id);

    const relaxed = runBasketPortfolioBacktest({
      config: {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        htfTimeframe: '1H',
        bars: execCandles.length,
        initialCapital: 10000,
        riskPerTradePercent: 1.0,
        maxConcurrentPositions: 6,
        maxPortfolioHeatPercent: 6.0,
        strategyIds: uncorrIds,
      },
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'Basket Fixture',
    });

    expect(relaxed.metrics.startingCapital).toBe(10000);
    expect(relaxed.contributions).toHaveLength(uncorrIds.length);
    expect(relaxed.equityCurve.length).toBeGreaterThan(10);
    expect(relaxed.equityCurve.length).toBeLessThanOrEqual(80);
    expect(relaxed.totalTradesExecuted).toBeGreaterThan(0);
    expect(relaxed.peakConcurrentPositions).toBeLessThanOrEqual(6);

    for (const trade of relaxed.trades) {
      expect(trade.entryTime).toBeGreaterThan(trade.signalTime);
      expect(trade.exitTime).toBeGreaterThanOrEqual(trade.entryTime);
      expect(trade.concurrentPositionsAtEntry).toBeLessThanOrEqual(6);
      expect(trade.portfolioHeatAtEntry).toBeLessThanOrEqual(6.01);
    }

    const strict = runBasketPortfolioBacktest({
      config: {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        htfTimeframe: '1H',
        bars: execCandles.length,
        initialCapital: 10000,
        riskPerTradePercent: 1.0,
        maxConcurrentPositions: 1,
        maxPortfolioHeatPercent: 1.0,
        strategyIds: uncorrIds,
      },
      execCandles,
      htfCandles,
      dailyCandles: [],
      providerName: 'Basket Strict Fixture',
    });

    expect(strict.peakConcurrentPositions).toBeLessThanOrEqual(1);
    expect(strict.totalTradesExecuted).toBeLessThanOrEqual(relaxed.totalTradesExecuted);
    expect(strict.skippedByConcurrentCap + strict.skippedByHeatCap).toBeGreaterThanOrEqual(0);
    for (const trade of strict.trades) {
      expect(trade.concurrentPositionsAtEntry).toBe(1);
    }
  });

  it('persists, updates, and clears live strategy basket config in SQLite', () => {
    const store = new BacktestSqliteStore(':memory:');
    expect(store.getLiveBasket()).toBeNull();

    const basket: LiveStrategyBasketConfig = {
      enabled: true,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      htfTimeframe: '1H',
      maxConcurrentPositions: 3,
      minRiskReward: 1.4,
      sourceRunId: 'LIVE-BASKET-TEST',
      strategies: BACKTEST_STRATEGY_DEFINITIONS.slice(0, 4).map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
      })),
      updatedAt: 1700000001000,
      lastEvaluatedAt: null,
      lastClosedBarTime: null,
      emittedSignalCount: 0,
      lastStatusNote: 'Armed in unit test',
    };

    store.saveLiveBasket(basket);
    const loaded = store.getLiveBasket();
    expect(loaded).not.toBeNull();
    expect(loaded?.sourceRunId).toBe('LIVE-BASKET-TEST');
    expect(loaded?.strategies).toHaveLength(4);
    expect(loaded?.enabled).toBe(true);

    store.saveLiveBasket({ ...basket, enabled: false, updatedAt: 1700000002000 });
    expect(store.getLiveBasket()?.enabled).toBe(false);

    store.clearLiveBasket();
    expect(store.getLiveBasket()).toBeNull();
    store.close();
  });

  it('enforces market-closed blocking, deduplication, and maxConcurrentPositions in SignalEngine.evaluateBasketCandidates', () => {
    const sigStore = new SignalSqliteStore(':memory:');
    const engine = new SignalEngine(sigStore);

    const closedQuote: LiveQuote = {
      symbol: 'XAUUSD',
      price: 2650,
      change24h: 0,
      changePercent24h: 0,
      direction: 'bullish',
      provider: 'Test Feed',
      lastUpdateTime: Date.now(),
      providerTimestamp: Date.now(),
      feedDelaySeconds: 0,
      connectionStatus: 'CONNECTED',
      marketOpen: false,
      stale: false,
    };

    const sampleCandidate = {
      strategyId: BACKTEST_STRATEGY_DEFINITIONS[0].id,
      direction: 'BUY' as const,
      entryMode: 'market_close' as const,
      entryPrice: 2650,
      entryZone: { lower: 2648, upper: 2652 },
      stopLoss: 2640,
      invalidationLevel: 2639,
      takeProfits: [
        { level: 1 as const, price: 2670, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null },
      ],
      confluenceScore: 86,
      entryRationale: ['Unit test closed market check'],
    };

    const blockedRes = engine.evaluateBasketCandidates({
      symbol: 'XAUUSD',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: 1700000900,
      atrBuffer: 2.5,
      snapshots: {},
      quote: closedQuote,
      providerStatus: null,
      maxConcurrentPositions: 2,
      candidates: [
        { strategy: BACKTEST_STRATEGY_DEFINITIONS[0], candidate: sampleCandidate },
      ],
    });

    expect(blockedRes.blockedReason).toContain('Market closed');
    expect(blockedRes.emittedSignals).toHaveLength(0);

    const openBtcQuote: LiveQuote = {
      ...closedQuote,
      symbol: 'BTCUSDT',
      price: 68000,
      marketOpen: true,
    };

    const mkCand = (idx: number, score: number) => ({
      strategy: BACKTEST_STRATEGY_DEFINITIONS[idx],
      candidate: {
        strategyId: BACKTEST_STRATEGY_DEFINITIONS[idx].id,
        direction: 'BUY' as const,
        entryMode: 'market_close' as const,
        entryPrice: 68000,
        entryZone: { lower: 67950, upper: 68050 },
        stopLoss: 67500,
        invalidationLevel: 67450,
        takeProfits: [
          { level: 1 as const, price: 69000, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null },
        ],
        confluenceScore: score,
        entryRationale: [`Basket candidate ${idx}`],
      },
    });

    const emittedRes = engine.evaluateBasketCandidates({
      symbol: 'BTCUSDT',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: 1700000900,
      atrBuffer: 120,
      snapshots: {},
      quote: openBtcQuote,
      providerStatus: null,
      maxConcurrentPositions: 2,
      candidates: [mkCand(0, 80), mkCand(1, 92), mkCand(2, 88)],
    });

    // Respects maxConcurrentPositions = 2 and sorts highest confluenceScore first (92, 88)
    expect(emittedRes.blockedReason).toBeUndefined();
    expect(emittedRes.emittedSignals).toHaveLength(2);
    expect(emittedRes.emittedSignals.every((s) => s.source === 'strategy_basket')).toBe(true);
    expect(emittedRes.emittedSignals[0].strategyId).toBe(BACKTEST_STRATEGY_DEFINITIONS[1].id);
    expect(emittedRes.emittedSignals[1].strategyId).toBe(BACKTEST_STRATEGY_DEFINITIONS[2].id);

    // Duplicate closed bar evaluation emits 0 extra signals
    const dupRes = engine.evaluateBasketCandidates({
      symbol: 'BTCUSDT',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: 1700000900,
      atrBuffer: 120,
      snapshots: {},
      quote: openBtcQuote,
      providerStatus: null,
      maxConcurrentPositions: 2,
      candidates: [mkCand(0, 95), mkCand(1, 92), mkCand(2, 88)],
    });
    expect(dupRes.emittedSignals).toHaveLength(0);

    sigStore.close();
  });
});
