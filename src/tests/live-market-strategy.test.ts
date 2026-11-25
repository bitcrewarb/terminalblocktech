import { describe, expect, it } from 'vitest';
import { runDeterministicAnalysis } from '../analysis/engine.ts';
import {
  analyzeLiveMarketCondition,
  buildLiveMarketStrategyReport,
  matchBacktestedStrategiesToMarket,
} from '../analysis/live-market-strategy.ts';
import { buildDefaultDiscoveryConfig } from '../backtest/discovery/engine.ts';
import { BacktestSqliteStore } from '../backtest/storage/sqlite.ts';
import { BACKTEST_STRATEGY_DEFINITIONS } from '../backtest/strategies/index.ts';
import { DEFAULT_TECHNICAL_SETTINGS } from '../shared/constants/index.ts';
import type {
  BacktestStrategyDefinition,
  Candle,
  DiscoveryScanRun,
  MarketRegimeType,
  StrategyDiscoveryCombination,
  Timeframe,
  ValidationStatus,
  WindowSegmentMetrics,
} from '../shared/types/index.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

const realBtc15m = fixtureCandles as Candle[];

function makeWindowMetrics(overrides: Partial<WindowSegmentMetrics> = {}): WindowSegmentMetrics {
  return {
    trades: 24,
    wins: 14,
    losses: 10,
    breakevenTrades: 0,
    winRate: 58.3,
    netReturnPercent: 18.4,
    profitFactor: 1.85,
    expectancyR: 0.42,
    avgR: 0.42,
    avgWinR: 1.5,
    avgLossR: 1.0,
    rewardToRiskRatio: 1.5,
    maxDrawdownPercent: 5.2,
    sharpeRatio: 1.9,
    avgBarsHeld: 9,
    ...overrides,
  };
}

function makeCombination(params: {
  strategy: BacktestStrategyDefinition;
  timeframe: Timeframe;
  regime: MarketRegimeType;
  validationStatus: ValidationStatus;
  oosMetrics?: Partial<WindowSegmentMetrics>;
  holdoutMetrics?: Partial<WindowSegmentMetrics>;
  isMetrics?: Partial<WindowSegmentMetrics>;
  wfConsistencyPercent?: number;
  readiness?: 'Production Ready' | 'Verify Paper' | 'Overfit / Decayed' | 'Not Ready';
  poorRegimes?: MarketRegimeType[];
}): StrategyDiscoveryCombination {
  const oos = makeWindowMetrics(params.oosMetrics);
  const holdout = makeWindowMetrics({
    trades: 14,
    wins: 8,
    losses: 6,
    winRate: 57.1,
    netReturnPercent: 10.5,
    profitFactor: 1.65,
    expectancyR: 0.34,
    maxDrawdownPercent: 4.1,
    ...params.holdoutMetrics,
  });
  const isM = makeWindowMetrics({
    trades: 40,
    wins: 23,
    losses: 17,
    winRate: 57.5,
    netReturnPercent: 25,
    profitFactor: 1.78,
    expectancyR: 0.4,
    ...params.isMetrics,
  });

  return {
    comboKey: `${params.strategy.id}__BTCUSDT__${params.timeframe}__${params.regime}`,
    rank: 1,
    strategy: params.strategy,
    symbol: 'BTCUSDT',
    timeframe: params.timeframe,
    htfTimeframe: '4H',
    regime: params.regime,
    validationStatus: params.validationStatus,
    validationReasons: ['Synthetic test fixture validation'],
    oosScore: 78,
    wfConsistencyPercent: params.wfConsistencyPercent ?? 75,
    wfProfitableFolds: 3,
    wfActiveFolds: 4,
    barsInRegime: 450,
    totalIsOosTrades: isM.trades + oos.trades,
    isMetrics: isM,
    oosMetrics: oos,
    holdoutMetrics: holdout,
    poorRegimes: (params.poorRegimes ?? []).map((r) => ({
      regime: r,
      oosTrades: 12,
      oosExpectancyR: -0.28,
      oosProfitFactor: 0.71,
      oosNetReturnPercent: -6.5,
    })),
    allRegimesBreakdown: [],
    walkForwardFolds: [],
    strengths: ['Positive OOS expectancy'],
    weaknesses: [],
    recommendedConditions: [`Trade in ${params.regime}`],
    bestSession: 'London/NY Overlap (12–16 UTC)',
    bestUtcHours: '12:00–16:00 UTC',
    avoidSessions: [],
    productionAudit: {
      readiness: params.readiness ?? 'Production Ready',
      holdoutConfirmed: (params.readiness ?? 'Production Ready') === 'Production Ready',
      edgeConfidencePercent: 92,
      isOosDecayRatio: 0.95,
      summaryNote: 'Validated OOS + Holdout',
    },
  };
}

function makeSnapshot(candles: Candle[]) {
  return runDeterministicAnalysis({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    candles,
    dailyCandles: [],
    htfTrend: 'bullish',
    quote: {
      symbol: 'BTCUSDT',
      price: candles[candles.length - 1].close,
      bid: candles[candles.length - 1].close - 1,
      ask: candles[candles.length - 1].close + 1,
      spread: 2,
      change24h: 420,
      changePercent24h: 0.85,
      high24h: Math.max(...candles.map((c) => c.high)),
      low24h: Math.min(...candles.map((c) => c.low)),
      volume24h: 12000,
      direction: 'bullish',
      provider: 'Binance',
      feedDelaySeconds: 0,
      connectionStatus: 'CONNECTED',
      marketOpen: true,
      lastUpdateTime: Date.now(),
      providerTimestamp: Date.now(),
      stale: false,
    },
    providerStatus: {
      symbol: 'BTCUSDT',
      assetClass: 'CRYPTO',
      providerName: 'Binance Spot & Futures',
      hasHistoricalCredentials: true,
      hasStreamingFeed: true,
      connectionStatus: 'CONNECTED',
      lastUpdateTime: Date.now(),
      feedDelaySeconds: 0,
    },
    settings: DEFAULT_TECHNICAL_SETTINGS,
  });
}

describe('LIVE MARKET Strategy Engine & Matcher', () => {
  it('computes deterministic live market conditions from real BTCUSDT candles', () => {
    const snap = makeSnapshot(realBtc15m);
    const overlapTimeMs = Date.UTC(2026, 3, 15, 13, 30, 0);

    const cond1 = analyzeLiveMarketCondition({
      snapshot: snap,
      nowMs: overlapTimeMs,
    });
    const cond2 = analyzeLiveMarketCondition({
      snapshot: snap,
      nowMs: overlapTimeMs,
    });

    // Strictly deterministic across repeated invocations
    expect(cond1).toEqual(cond2);

    expect(cond1.symbol).toBe('BTCUSDT');
    expect(cond1.timeframe).toBe('15m');
    expect(['Trending', 'Ranging', 'Consolidating', 'Transitioning']).toContain(cond1.regime);
    expect([
      'Strong Uptrend',
      'Weak Uptrend',
      'Strong Downtrend',
      'Weak Downtrend',
      'Sideways',
    ]).toContain(cond1.direction);
    expect(['Very Low', 'Low', 'Normal', 'High', 'Extreme']).toContain(cond1.volatility);
    expect(cond1.trendStrengthScore).toBeGreaterThanOrEqual(0);
    expect(cond1.trendStrengthScore).toBeLessThanOrEqual(100);
    expect(cond1.momentumStrengthScore).toBeGreaterThanOrEqual(0);
    expect(cond1.momentumStrengthScore).toBeLessThanOrEqual(100);
    expect(cond1.adx).toBeGreaterThan(0);
    expect(cond1.atr).toBeGreaterThan(0);
    expect(cond1.session).toBe('London/NY Overlap (12–16 UTC)');
    expect(cond1.sessionShort).toBe('London/NY Overlap');
    expect(cond1.conditionSummary.length).toBeGreaterThan(20);
  });

  it('returns NO RELIABLE STRATEGY MATCH when database has no historical backtests', () => {
    const snap = makeSnapshot(realBtc15m);
    const report = buildLiveMarketStrategyReport({
      snapshot: snap,
      discoveryRuns: [],
      backtestRuns: [],
      nowMs: Date.UTC(2026, 3, 15, 13, 30, 0),
    });

    expect(report.decision.hasReliableMatch).toBe(false);
    expect(report.decision.actionVerdict).toBe('WAIT');
    expect(report.decision.marketSuitability).toBe('WAIT');
    expect(report.decision.topStrategies).toHaveLength(0);
    expect(report.databaseCoverage.matchingSymbolRecords).toBe(0);
  });

  it('prioritizes validated unseen OOS/Holdout strategies over inflated win-rate or small-sample candidates', () => {
    const snap = makeSnapshot(realBtc15m);
    const cond = analyzeLiveMarketCondition({
      snapshot: snap,
      nowMs: Date.UTC(2026, 3, 15, 13, 30, 0),
    });

    const stratA = BACKTEST_STRATEGY_DEFINITIONS[0];
    const stratB = BACKTEST_STRATEGY_DEFINITIONS[1];
    const stratC = BACKTEST_STRATEGY_DEFINITIONS[2];
    const stratD = BACKTEST_STRATEGY_DEFINITIONS[3];

    const discoveryRun: DiscoveryScanRun = {
      id: 'disc-live-test-1',
      createdAt: Date.now(),
      durationMs: 1200,
      config: buildDefaultDiscoveryConfig({ symbols: ['BTCUSDT'], timeframes: ['15m'] }),
      strategiesEvaluatedCount: 4,
      marketCoverage: [],
      summaryStats: {
        totalCombinationsEvaluated: 4,
        validatedCount: 2,
        preliminaryCount: 0,
        insufficientCount: 1,
        failedCount: 1,
        instrumentsScanned: ['BTCUSDT'],
        timeframesScanned: ['15m'],
      },
      combinations: [
        // Strategy C has 90% win rate on IS/small OOS, only 2 OOS trades -> INSUFFICIENT DATA
        makeCombination({
          strategy: stratC,
          timeframe: '15m',
          regime: cond.discoveryRegimeMapping,
          validationStatus: 'Insufficient Evidence',
          oosMetrics: {
            trades: 2,
            wins: 2,
            losses: 0,
            winRate: 100,
            netReturnPercent: 8,
            profitFactor: 4.5,
            expectancyR: 1.2,
          },
          readiness: 'Not Ready',
        }),
        // Strategy D failed validation / negative expectancy -> POOR MATCH
        makeCombination({
          strategy: stratD,
          timeframe: '15m',
          regime: cond.discoveryRegimeMapping,
          validationStatus: 'Failed Validation',
          oosMetrics: {
            trades: 20,
            wins: 7,
            losses: 13,
            winRate: 35,
            netReturnPercent: -12,
            profitFactor: 0.72,
            expectancyR: -0.25,
            maxDrawdownPercent: 18,
          },
          holdoutMetrics: {
            trades: 12,
            netReturnPercent: -6,
            expectancyR: -0.2,
          },
          readiness: 'Overfit / Decayed',
        }),
        // Strategy A & B are both validated + Production Ready matching live regime & timeframe
        makeCombination({
          strategy: stratA,
          timeframe: '15m',
          regime: cond.discoveryRegimeMapping,
          validationStatus: 'Validated',
          oosMetrics: {
            trades: 28,
            wins: 16,
            losses: 12,
            winRate: 57.1,
            netReturnPercent: 22.4,
            profitFactor: 1.92,
            expectancyR: 0.45,
            maxDrawdownPercent: 4.8,
          },
          readiness: 'Production Ready',
        }),
        makeCombination({
          strategy: stratB,
          timeframe: '15m',
          regime: cond.discoveryRegimeMapping,
          validationStatus: 'Validated',
          oosMetrics: {
            trades: 22,
            wins: 12,
            losses: 10,
            winRate: 54.5,
            netReturnPercent: 16.0,
            profitFactor: 1.65,
            expectancyR: 0.36,
            maxDrawdownPercent: 5.5,
          },
          readiness: 'Production Ready',
        }),
      ],
    };

    const { decision } = matchBacktestedStrategiesToMarket({
      condition: cond,
      discoveryRuns: [discoveryRun],
      backtestRuns: [],
    });

    expect(decision.hasReliableMatch).toBe(true);
    expect(decision.bestStrategy?.strategy.id).toBe(stratA.id);
    expect(decision.bestStrategy?.status).toBe('BEST MATCH');
    expect(decision.secondBestStrategy?.strategy.id).toBe(stratB.id);

    const smallSampleCard = decision.topStrategies.find((s) => s.strategy.id === stratC.id);
    expect(smallSampleCard?.status).toBe('INSUFFICIENT DATA');

    const failedCard = decision.topStrategies.find((s) => s.strategy.id === stratD.id);
    expect(failedCard?.status).toBe('POOR MATCH');
  });

  it('caches parsed discovery runs in BacktestSqliteStore and invalidates cache on delete/save', () => {
    const store = new BacktestSqliteStore(':memory:');
    const stratA = BACKTEST_STRATEGY_DEFINITIONS[0];

    const run: DiscoveryScanRun = {
      id: 'cache-test-1',
      createdAt: Date.now(),
      durationMs: 500,
      config: buildDefaultDiscoveryConfig({ symbols: ['BTCUSDT'], timeframes: ['15m'] }),
      strategiesEvaluatedCount: 1,
      marketCoverage: [],
      summaryStats: {
        totalCombinationsEvaluated: 1,
        validatedCount: 1,
        preliminaryCount: 0,
        insufficientCount: 0,
        failedCount: 0,
        instrumentsScanned: ['BTCUSDT'],
        timeframesScanned: ['15m'],
      },
      combinations: [
        makeCombination({
          strategy: stratA,
          timeframe: '15m',
          regime: 'Trending',
          validationStatus: 'Validated',
        }),
      ],
    };

    store.saveDiscoveryRun(run);
    const first = store.getCachedDiscoveryRuns(10);
    const second = store.getCachedDiscoveryRuns(10);
    expect(first).toHaveLength(1);
    expect(second[0]).toBe(first[0]); // Same cached object reference

    store.deleteDiscoveryRun('cache-test-1');
    const afterDelete = store.getCachedDiscoveryRuns(10);
    expect(afterDelete).toHaveLength(0);
    store.close();
  });

  it('filters database entries against live Volatility, Trend, and Regime to populate Top 50 recommendations', () => {
    const snap = makeSnapshot(realBtc15m);
    const cond = analyzeLiveMarketCondition({
      snapshot: snap,
      nowMs: Date.UTC(2026, 3, 15, 13, 30, 0),
    });

    const subset = BACKTEST_STRATEGY_DEFINITIONS.slice(0, 65);
    const combos = subset.map((strat, idx) =>
      makeCombination({
        strategy: strat,
        timeframe: '15m',
        regime: idx < 55 ? cond.discoveryRegimeMapping : 'Low Volatility',
        validationStatus: idx < 55 ? 'Validated' : 'Failed Validation',
        oosMetrics: {
          trades: 20 + (idx % 10),
          expectancyR: idx < 55 ? 0.45 - idx * 0.004 : -0.2,
          profitFactor: idx < 55 ? 1.85 - idx * 0.008 : 0.78,
          netReturnPercent: idx < 55 ? 24 - idx * 0.25 : -8,
          maxDrawdownPercent: 4.5 + (idx % 6),
        },
        poorRegimes: idx >= 55 ? [cond.discoveryRegimeMapping] : [],
        readiness: idx < 55 ? 'Production Ready' : 'Overfit / Decayed',
      })
    );

    const largeRun: DiscoveryScanRun = {
      id: 'disc-top50-test',
      createdAt: Date.now(),
      durationMs: 2500,
      config: buildDefaultDiscoveryConfig({ symbols: ['BTCUSDT'], timeframes: ['15m'] }),
      strategiesEvaluatedCount: subset.length,
      marketCoverage: [],
      summaryStats: {
        totalCombinationsEvaluated: combos.length,
        validatedCount: 55,
        preliminaryCount: 0,
        insufficientCount: 0,
        failedCount: 10,
        instrumentsScanned: ['BTCUSDT'],
        timeframesScanned: ['15m'],
      },
      combinations: combos,
    };

    const allTop50 = matchBacktestedStrategiesToMarket({
      condition: cond,
      discoveryRuns: [largeRun],
      backtestRuns: [],
      conditionFilter: 'all',
    });

    expect(allTop50.decision.allEvaluatedCount).toBe(65);
    expect(allTop50.decision.topStrategies).toHaveLength(50);
    expect(allTop50.decision.topStrategies[0].rank).toBe(1);
    expect(allTop50.decision.topStrategies[49].rank).toBe(50);
    expect(allTop50.decision.filterCounts.totalEvaluated).toBe(65);
    expect(allTop50.decision.filterCounts.returnedCount).toBe(50);

    // Every entry exposes deterministic Volatility, Trend, and Regime conditionMatches
    for (const item of allTop50.decision.topStrategies) {
      expect(typeof item.conditionMatches.volatilityMatch).toBe('boolean');
      expect(typeof item.conditionMatches.trendMatch).toBe('boolean');
      expect(typeof item.conditionMatches.regimeMatch).toBe('boolean');
      expect(item.conditionMatches.matchedCount).toBeGreaterThanOrEqual(0);
      expect(item.conditionMatches.matchedCount).toBeLessThanOrEqual(3);
    }

    const strictMatched = matchBacktestedStrategiesToMarket({
      condition: cond,
      discoveryRuns: [largeRun],
      backtestRuns: [],
      conditionFilter: 'matched_conditions',
    });

    expect(strictMatched.decision.filterCriteria.conditionFilterMode).toBe('matched_conditions');
    expect(strictMatched.decision.topStrategies.length).toBeGreaterThan(0);
    expect(strictMatched.decision.topStrategies.length).toBeLessThanOrEqual(50);
    for (const item of strictMatched.decision.topStrategies) {
      expect(item.conditionMatches.regimeMatch).toBe(true);
      expect(item.conditionMatches.matchedCount).toBeGreaterThanOrEqual(2);
      expect(item.status).not.toBe('POOR MATCH');
    }
  });
});
