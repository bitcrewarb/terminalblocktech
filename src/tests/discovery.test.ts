import { describe, expect, it } from 'vitest';
import {
  buildDefaultDiscoveryConfig,
  computeIsolatedSegmentMetrics,
  inspectDiscoveryCombinationDetail,
  runDiscoveryOptimizationScan,
  selectDiscoveryStrategies,
} from '../backtest/discovery/engine.ts';
import { classifyMarketRegimesCausally } from '../backtest/discovery/regime.ts';
import { buildDefaultBacktestConfig } from '../backtest/engine.ts';
import { StrategyPortfolioSimulator } from '../backtest/simulator/index.ts';
import { BacktestSqliteStore } from '../backtest/storage/sqlite.ts';
import { BACKTEST_STRATEGY_DEFINITIONS } from '../backtest/strategies/index.ts';
import { formatRiskRewardRatio } from '../frontend/discovery/HintBadge.tsx';
import type { BacktestTradeRecord, Candle, Timeframe } from '../shared/types/index.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

const realBtc15m = fixtureCandles as Candle[];

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

describe('Best Strategy Discovery & Optimization Scanner', () => {
  it('classifies market regimes causally with strict zero future lookahead', () => {
    const full = classifyMarketRegimesCausally(realBtc15m);
    const prefixLen = Math.min(80, Math.floor(realBtc15m.length * 0.7));
    const prefix = classifyMarketRegimesCausally(realBtc15m.slice(0, prefixLen));

    expect(full).toHaveLength(realBtc15m.length);
    expect(prefix).toHaveLength(prefixLen);

    for (let i = 0; i < prefixLen; i++) {
      expect(prefix[i].regime).toBe(full[i].regime);
      expect(prefix[i].atr).toBeCloseTo(full[i].atr, 8);
      expect(prefix[i].adx).toBeCloseTo(full[i].adx, 8);
      expect(prefix[i].volPercentile).toBeCloseTo(full[i].volPercentile, 8);
    }

    const distinctRegimes = new Set(full.map((f) => f.regime));
    expect(distinctRegimes.size).toBeGreaterThanOrEqual(2);
  });

  it('selects balanced strategies across all 5 categories for core scope and full catalog for all scope', () => {
    const core = selectDiscoveryStrategies('core');
    expect(core.length).toBe(125);
    const cats = new Set(core.map((s) => s.category));
    expect(cats.size).toBe(5);

    const all = selectDiscoveryStrategies('all');
    expect(all.length).toBe(BACKTEST_STRATEGY_DEFINITIONS.length);
  });

  it('isolates Final Holdout completely from OOS ranking, Walk-Forward folds, and validation status', async () => {
    // Build a continuous 240-bar series by chaining real 120-bar fixture candles cleanly in time
    const span = realBtc15m[realBtc15m.length - 1].time - realBtc15m[0].time + 900;
    const extendedBtc: Candle[] = [
      ...realBtc15m,
      ...realBtc15m.map((c) => ({ ...c, time: c.time + span })),
    ];
    const htf1H = aggregateCandles(extendedBtc, 4);

    const baseCfg = buildDefaultDiscoveryConfig({
      symbols: ['BTCUSDT'],
      timeframes: ['15m'],
      barsPerTimeframe: extendedBtc.length,
      strategyScope: 'core',
      minRiskReward: 1.4,
      minOosTradesForValidation: 3,
      minTotalSampleForValidation: 6,
    });

    const runA = await runDiscoveryOptimizationScan({
      config: baseCfg,
      fetchHistory: async (_sym, tf) => ({
        candles: tf === '15m' ? extendedBtc : tf === '1H' || tf === '4H' ? htf1H : [],
        provider: 'Fixture Feed A',
      }),
    });

    // Mutate ONLY the final 18% of bars (strictly inside Final Holdout window, after oosEndTime)
    const oosEnd = runA.marketCoverage[0].oosEndTime;
    const mutatedBtc = extendedBtc.map((c) => {
      if (c.time > oosEnd + 900 * 4) {
        return {
          ...c,
          open: c.open * 0.55,
          high: c.high * 0.65,
          low: c.low * 0.45,
          close: c.close * 0.5,
        };
      }
      return c;
    });
    const mutatedHtf = aggregateCandles(mutatedBtc, 4);

    const runB = await runDiscoveryOptimizationScan({
      config: baseCfg,
      fetchHistory: async (_sym, tf) => ({
        candles: tf === '15m' ? mutatedBtc : tf === '1H' || tf === '4H' ? mutatedHtf : [],
        provider: 'Fixture Feed B',
      }),
    });

    expect(runA.combinations.length).toBeGreaterThan(10);
    expect(runB.combinations.length).toBe(runA.combinations.length);

    // Every single combination's rank, OOS score, IS/OOS metrics, WF consistency, and validation status MUST match 100%
    for (let i = 0; i < Math.min(40, runA.combinations.length); i++) {
      const a = runA.combinations[i];
      const b = runB.combinations[i];
      expect(b.comboKey).toBe(a.comboKey);
      expect(b.rank).toBe(a.rank);
      expect(b.validationStatus).toBe(a.validationStatus);
      expect(b.oosScore).toBe(a.oosScore);
      expect(b.wfConsistencyPercent).toBe(a.wfConsistencyPercent);
      expect(b.isMetrics).toEqual(a.isMetrics);
      expect(b.oosMetrics).toEqual(a.oosMetrics);
      expect(b.walkForwardFolds).toEqual(a.walkForwardFolds);
      expect(b.bestSession).toBe(a.bestSession);
      expect(b.bestUtcHours).toBe(a.bestUtcHours);
      expect(b.avoidSessions).toEqual(a.avoidSessions);
      expect(b.productionAudit?.edgeConfidencePercent).toBe(
        a.productionAudit?.edgeConfidencePercent
      );
      expect(b.sessionBreakdown?.length).toBe(5);
    }

    // Reconstruct full detail for #1 combination and verify zero-lookahead trade timestamps
    const top = runA.combinations[0];
    const detail = await inspectDiscoveryCombinationDetail({
      combination: top,
      config: runA.config,
      fetchHistory: async (_sym, tf: Timeframe) => ({
        candles: tf === '15m' ? extendedBtc : tf === '1H' || tf === '4H' ? htf1H : [],
        provider: 'Fixture Detail',
      }),
    });

    expect(detail.combination.comboKey).toBe(top.comboKey);
    expect(detail.annotatedTrades.length).toBeGreaterThan(0);
    for (const tr of detail.annotatedTrades) {
      expect(tr.entryTime).toBeGreaterThan(tr.signalTime);
      expect(tr.exitTime).toBeGreaterThanOrEqual(tr.entryTime);
      expect(['IS', 'OOS', 'HOLDOUT']).toContain(tr.split);
    }
  });

  it('fills Stop Loss realistically at bar.open when market gaps past SL', () => {
    const def = BACKTEST_STRATEGY_DEFINITIONS[0];
    const config = buildDefaultBacktestConfig({
      symbol: 'XAUUSD',
      timeframe: '15m',
      initialCapital: 10000,
      riskPerTradePercent: 1.0,
      commissionBps: 0,
      slippageBps: 0,
    });
    const sim = new StrategyPortfolioSimulator(def, config, 1000);

    sim.submitSignal(
      {
        strategyId: def.id,
        direction: 'BUY',
        entryMode: 'market_close',
        entryPrice: 2000,
        entryZone: { lower: 1998, upper: 2002 },
        stopLoss: 1990,
        invalidationLevel: 1989,
        takeProfits: [
          {
            level: 1,
            price: 2020,
            riskReward: 2.0,
            sourceLabel: 'TP1',
            hit: false,
            hitTime: null,
          },
        ],
        confluenceScore: 85,
        entryRationale: ['Gap test'],
      },
      0,
      1000
    );

    // Bar 1: normal open fills BUY at 2000
    sim.onBar(
      { time: 1900, open: 2000, high: 2005, low: 1995, close: 2002, volume: 100, isClosed: true },
      1
    );
    // Bar 2: overnight gap down opens at 1980 (below 1990 SL!) -> must fill at 1980 (-2R), not 1990 (-1R)
    sim.onBar(
      { time: 2800, open: 1980, high: 1985, low: 1978, close: 1982, volume: 100, isClosed: true },
      2
    );

    const res = sim.buildResult();
    expect(res.metrics.totalTrades).toBe(1);
    expect(res.trades[0].exitPrice).toBe(1980);
    expect(res.trades[0].realizedR).toBe(-2);
    expect(res.trades[0].exitNote).toContain('gapped at open');
  });

  it('persists, lists, retrieves, and deletes DiscoveryScanRuns in SQLite', async () => {
    const store = new BacktestSqliteStore(':memory:');
    const htf1H = aggregateCandles(realBtc15m, 4);
    const run = await runDiscoveryOptimizationScan({
      config: {
        symbols: ['BTCUSDT'],
        timeframes: ['15m'],
        barsPerTimeframe: realBtc15m.length,
        strategyScope: 'category',
        categories: ['SMC'],
      },
      fetchHistory: async (_sym, tf) => ({
        candles: tf === '15m' ? realBtc15m : tf === '1H' || tf === '4H' ? htf1H : [],
        provider: 'SQLite Discovery Fixture',
      }),
    });

    store.saveDiscoveryRun(run);
    const list = store.listDiscoveryRuns();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(run.id);
    expect(list[0].totalCombinations).toBe(run.combinations.length);

    const loaded = store.getDiscoveryRunById(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.combinations.length).toBe(run.combinations.length);

    expect(store.deleteDiscoveryRun(run.id)).toBe(true);
    expect(store.listDiscoveryRuns()).toHaveLength(0);
    store.close();
  });

  it('prevents phantom limit_retest fills when price only touches entryZone edge without reaching entryPrice', () => {
    const def = BACKTEST_STRATEGY_DEFINITIONS[0];
    const config = buildDefaultBacktestConfig({
      symbol: 'XAUUSD',
      timeframe: '15m',
      initialCapital: 10000,
      riskPerTradePercent: 1.0,
      commissionBps: 0,
      slippageBps: 0,
    });
    const sim = new StrategyPortfolioSimulator(def, config, 1000);

    sim.submitSignal(
      {
        strategyId: def.id,
        direction: 'BUY',
        entryMode: 'limit_retest',
        entryPrice: 2000,
        entryZone: { lower: 1996, upper: 2008 },
        stopLoss: 1990,
        invalidationLevel: 1989,
        takeProfits: [
          {
            level: 1,
            price: 2020,
            riskReward: 2.0,
            sourceLabel: 'TP1',
            hit: false,
            hitTime: null,
          },
        ],
        confluenceScore: 85,
        entryRationale: ['Strict limit fill test'],
      },
      0,
      1000
    );

    // Bar 1: dips into entryZone (low = 2004 <= 2008) but NEVER reaches entryPrice (2000) -> MUST NOT fill
    sim.onBar(
      { time: 1900, open: 2010, high: 2014, low: 2004, close: 2012, volume: 100, isClosed: true },
      1
    );
    expect(sim.hasOpenOrPending()).toBe(true);
    expect(sim.buildResult().metrics.totalTrades).toBe(0);

    // Bar 2: actually trades down to entryPrice (low = 1999 <= 2000) and bounces to close above TP? Keep below TP first, then TP on Bar 3
    sim.onBar(
      { time: 2800, open: 2012, high: 2013, low: 1999, close: 2006, volume: 100, isClosed: true },
      2
    );
    sim.onBar(
      { time: 3700, open: 2006, high: 2022, low: 2005, close: 2021, volume: 100, isClosed: true },
      3
    );

    const res = sim.buildResult();
    expect(res.metrics.totalTrades).toBe(1);
    expect(res.trades[0].entryPrice).toBe(2000);
    expect(res.trades[0].entryTime).toBe(2800);
    expect(res.trades[0].exitReason).toBe('TP1_FULL');
  });

  it('supports up to 20,000 barsPerTimeframe and clamps values above 20,000', () => {
    const maxCfg = buildDefaultDiscoveryConfig({ barsPerTimeframe: 20000 });
    expect(maxCfg.barsPerTimeframe).toBe(20000);

    const overCfg = buildDefaultDiscoveryConfig({ barsPerTimeframe: 35000 });
    expect(overCfg.barsPerTimeframe).toBe(20000);

    const lowCfg = buildDefaultDiscoveryConfig({ barsPerTimeframe: 100 });
    expect(lowCfg.barsPerTimeframe).toBe(240);
  });

  it('computes exact avgWinR, avgLossR, and rewardToRiskRatio plus legacy fallback', () => {
    const makeTrade = (
      id: string,
      tradeNumber: number,
      realizedR: number,
      entryTime: number
    ): BacktestTradeRecord => ({
      id,
      tradeNumber,
      strategyId: BACKTEST_STRATEGY_DEFINITIONS[0].id,
      direction: 'BUY',
      entryMode: 'market_close',
      signalTime: entryTime - 900,
      entryTime,
      exitTime: entryTime + 1800,
      barsHeld: 2,
      entryPrice: 100,
      stopLoss: 99,
      initialStopLoss: 99,
      invalidationLevel: 98.5,
      exitPrice: realizedR > 0 ? 102 : 99,
      takeProfits: [],
      tp1Hit: realizedR > 0,
      tp2Hit: false,
      tp3Hit: false,
      exitReason: realizedR > 0 ? 'TP1_FULL' : 'STOP_LOSS',
      units: 100,
      riskAmount: 100,
      grossPnl: realizedR * 100,
      feesAndSlippage: 0,
      netPnl: realizedR * 100,
      returnPercent: realizedR,
      realizedR,
      mfeR: Math.max(0.2, realizedR),
      maeR: -0.2,
      equityAfter: 10000 + realizedR * 100,
      confluenceScore: 80,
      entryRationale: [],
      exitNote: '',
    });

    const trades: BacktestTradeRecord[] = [
      makeTrade('t1', 1, 2.0, 1000),
      makeTrade('t2', 2, 3.0, 4000),
      makeTrade('t3', 3, -1.0, 7000),
      makeTrade('t4', 4, -1.0, 10000),
    ];

    const seg = computeIsolatedSegmentMetrics(trades, 1.0, '15m', 'BTCUSDT');
    expect(seg.wins).toBe(2);
    expect(seg.losses).toBe(2);
    expect(seg.avgWinR).toBe(2.5);
    expect(seg.avgLossR).toBe(1.0);
    expect(seg.rewardToRiskRatio).toBe(2.5);

    const exactFormatted = formatRiskRewardRatio(seg);
    expect(exactFormatted.ratioText).toBe('1 : 2.50');
    expect(exactFormatted.avgWinR).toBe(2.5);
    expect(exactFormatted.avgLossR).toBe(1.0);

    // Legacy saved segment without avgWinR/avgLossR/rewardToRiskRatio falls back accurately via PF * (losses / wins)
    const legacyFormatted = formatRiskRewardRatio({
      trades: seg.trades,
      wins: seg.wins,
      losses: seg.losses,
      profitFactor: seg.profitFactor,
      expectancyR: seg.expectancyR,
    });
    expect(legacyFormatted.ratioText).toBe('1 : 2.50');
  });
});

