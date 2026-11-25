import { describe, expect, it } from 'vitest';
import { detectBosChoch } from '../analysis/bos-choch/index.ts';
import { detectCandlestickPatterns } from '../analysis/candle-patterns/index.ts';
import { detectChartPatterns } from '../analysis/chart-patterns/index.ts';
import { runDeterministicAnalysis } from '../analysis/engine.ts';
import { detectFairValueGaps } from '../analysis/fair-value-gaps/index.ts';
import { detectLiquidityPools } from '../analysis/liquidity/index.ts';
import { buildMarketStructureState } from '../analysis/market-structure/index.ts';
import { buildMultiTimeframeSummary } from '../analysis/multi-timeframe/index.ts';
import { detectOrderBlocks } from '../analysis/order-blocks/index.ts';
import { computeDealingRange } from '../analysis/premium-discount/index.ts';
import { analyzeTradingSessions } from '../analysis/sessions/index.ts';
import { detectSupportResistanceZones } from '../analysis/support-resistance/index.ts';
import { detectSupplyDemandZones } from '../analysis/supply-demand/index.ts';
import { computeATR, detectSwingPoints } from '../analysis/swing-engine/index.ts';
import { detectTrendlines } from '../analysis/trendlines/index.ts';
import { InMemoryEventEngine } from '../monitoring/event-engine/index.ts';
import { LiveZoneMonitor } from '../monitoring/zone-monitor/index.ts';
import { DEFAULT_TECHNICAL_SETTINGS } from '../shared/constants/index.ts';
import type { AnalysisSnapshot, Candle, ProviderStatus, Timeframe } from '../shared/types/index.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

const candles: Candle[] = fixtureCandles as Candle[];

const testProviderStatus: ProviderStatus = {
  symbol: 'BTCUSDT',
  assetClass: 'CRYPTO',
  providerName: 'Binance Spot (Test Fixture)',
  hasHistoricalCredentials: true,
  hasStreamingFeed: true,
  connectionStatus: 'CONNECTED',
  lastUpdateTime: Date.now(),
  feedDelaySeconds: 0,
};

describe('Deterministic Technical Analysis & SMC Engines', () => {
  it('enforces non-repainting swing confirmation requiring pivotConfirmationCandles closed bars', () => {
    const strictSettings = {
      ...DEFAULT_TECHNICAL_SETTINGS,
      swingSensitivity: 4,
      pivotConfirmationCandles: 3,
      showProvisional: false,
    };
    const swings = detectSwingPoints(candles, 'BTCUSDT', '15m', strictSettings);
    const lastIdx = candles.length - 1;

    for (const s of swings) {
      expect(s.confirmationStatus).toBe('confirmed');
      expect(s.confirmationTime).not.toBeNull();
      expect(lastIdx - s.candleIndex).toBeGreaterThanOrEqual(strictSettings.pivotConfirmationCandles);
      expect((s.confirmationTime ?? 0)).toBeGreaterThan(s.formationTime);
    }
  });

  it('detects Market Structure, BOS, CHoCH, Liquidity, Order Blocks, FVGs, S/R, S/D, Trendlines, and Dealing Range', () => {
    const atr = computeATR(candles, 14);
    expect(atr).toBeGreaterThan(0);

    const swings = detectSwingPoints(candles, 'BTCUSDT', '15m', DEFAULT_TECHNICAL_SETTINGS);
    const breaks = detectBosChoch(candles, swings, 'BTCUSDT', '15m', DEFAULT_TECHNICAL_SETTINGS);
    const ms = buildMarketStructureState('BTCUSDT', '15m', swings, breaks);

    expect(ms.swings.length).toBeGreaterThan(0);
    expect(['bullish', 'bearish', 'consolidation']).toContain(ms.trend);

    const { sessions, anchors } = analyzeTradingSessions(candles, candles, 'BTCUSDT');
    expect(sessions.length).toBeGreaterThan(0);
    expect(anchors.dailyOpen).not.toBeNull();

    const sr = detectSupportResistanceZones(
      candles,
      ms.swings,
      anchors,
      sessions,
      atr,
      'BTCUSDT',
      '15m',
      DEFAULT_TECHNICAL_SETTINGS
    );
    expect(sr.length).toBeGreaterThan(0);

    const sd = detectSupplyDemandZones(
      candles,
      atr,
      'BTCUSDT',
      '15m',
      ms.trend,
      DEFAULT_TECHNICAL_SETTINGS
    );
    expect(Array.isArray(sd)).toBe(true);

    const liq = detectLiquidityPools(
      candles,
      ms.swings,
      anchors,
      atr,
      'BTCUSDT',
      '15m',
      DEFAULT_TECHNICAL_SETTINGS
    );
    expect(liq.length).toBeGreaterThan(0);

    const obs = detectOrderBlocks(candles, breaks, atr, 'BTCUSDT', '15m', DEFAULT_TECHNICAL_SETTINGS);
    expect(Array.isArray(obs)).toBe(true);

    const fvgs = detectFairValueGaps(candles, atr, 'BTCUSDT', '15m', DEFAULT_TECHNICAL_SETTINGS);
    expect(Array.isArray(fvgs)).toBe(true);

    const trendlines = detectTrendlines(
      candles,
      ms.swings,
      atr,
      'BTCUSDT',
      '15m',
      DEFAULT_TECHNICAL_SETTINGS
    );
    expect(Array.isArray(trendlines)).toBe(true);

    const dr = computeDealingRange(candles, ms.swings, 'BTCUSDT', '15m');
    expect(dr).not.toBeNull();
    expect(dr!.equilibrium).toBeGreaterThan(dr!.rangeLow);
    expect(dr!.equilibrium).toBeLessThan(dr!.rangeHigh);
  });

  it('detects deterministic Candlestick and Chart patterns on historical OHLCV', () => {
    const atr = computeATR(candles, 14);
    const swings = detectSwingPoints(candles, 'BTCUSDT', '15m', DEFAULT_TECHNICAL_SETTINGS);
    const candlePats = detectCandlestickPatterns(
      candles,
      atr,
      'BTCUSDT',
      '15m',
      DEFAULT_TECHNICAL_SETTINGS
    );
    const chartPats = detectChartPatterns(
      candles,
      swings,
      atr,
      'BTCUSDT',
      '15m',
      DEFAULT_TECHNICAL_SETTINGS
    );

    expect(candlePats.length).toBeGreaterThan(0);
    for (const p of candlePats) {
      expect(p.id).toContain('BTCUSDT:15m:cp:');
      expect(p.qualityScore).toBeGreaterThanOrEqual(40);
    }
    expect(Array.isArray(chartPats)).toBe(true);
  });

  it('prevents duplicate zone-touch events and tracks zone interactions accurately', () => {
    const snap = runDeterministicAnalysis({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      dailyCandles: candles,
      htfTrend: 'consolidation',
      quote: null,
      providerStatus: testProviderStatus,
      settings: DEFAULT_TECHNICAL_SETTINGS,
    });

    const monitor = new LiveZoneMonitor();
    const targetSr = snap.supportResistance[0];
    expect(targetSr).toBeDefined();

    // First touch inside zone triggers event
    const first = monitor.evaluate(snap, targetSr.midpoint, DEFAULT_TECHNICAL_SETTINGS);
    expect(first.newlyTriggeredEvents.some((e) => e.objectId === targetSr.id)).toBe(true);

    // Immediate repeated price inside same zone must NOT emit duplicate event
    const second = monitor.evaluate(snap, targetSr.midpoint + 0.01, DEFAULT_TECHNICAL_SETTINGS);
    expect(second.newlyTriggeredEvents.some((e) => e.objectId === targetSr.id)).toBe(false);

    // EventEngine deduplication & chronological descending order
    const eventEngine = new InMemoryEventEngine();
    const added1 = eventEngine.pushEvents(first.newlyTriggeredEvents);
    const added2 = eventEngine.pushEvents(first.newlyTriggeredEvents);
    expect(added1.length).toBe(first.newlyTriggeredEvents.length);
    expect(added2.length).toBe(0);

    // Out-of-order timestamps must remain sorted newest-first without shuffling
    eventEngine.pushEvents([
      {
        id: 'old_ev',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        objectId: 'obj_old',
        objectCategory: 'market_structure',
        objectLabel: 'Older BOS',
        currentPrice: targetSr.midpoint,
        upperBound: targetSr.upper,
        lowerBound: targetSr.lower,
        distancePercent: 0,
        status: 'Confirmed Breakout',
        timestamp: 1000,
      },
      {
        id: 'new_ev',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        objectId: 'obj_new',
        objectCategory: 'market_structure',
        objectLabel: 'Newer CHoCH',
        currentPrice: targetSr.midpoint,
        upperBound: targetSr.upper,
        lowerBound: targetSr.lower,
        distancePercent: 0,
        status: 'Confirmed Breakout',
        timestamp: 9000000000000,
      },
    ]);
    const list = eventEngine.getEvents('BTCUSDT', 50);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].timestamp).toBeGreaterThanOrEqual(list[i].timestamp);
    }

    // Initial evaluation must never emit historical Invalidated/Mitigated/Approaching floods
    const invalidatedObs = snap.orderBlocks.filter((o) => !o.valid);
    for (const ob of invalidatedObs) {
      expect(first.newlyTriggeredEvents.some((e) => e.objectId === ob.id)).toBe(false);
    }
  });

  it('computes independent Multi-Timeframe Summary across timeframes', () => {
    const snap15m = runDeterministicAnalysis({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      dailyCandles: candles,
      htfTrend: 'consolidation',
      quote: null,
      providerStatus: testProviderStatus,
      settings: DEFAULT_TECHNICAL_SETTINGS,
    });

    const map = new Map<Timeframe, AnalysisSnapshot | null>();
    map.set('15m', snap15m);
    const mtf = buildMultiTimeframeSummary('BTCUSDT', map);

    expect(mtf.rows.length).toBe(13);
    const row15 = mtf.rows.find((r) => r.timeframe === '15m')!;
    expect(row15.available).toBe(true);
    expect(row15.candleCount).toBe(candles.length);
  });
});
