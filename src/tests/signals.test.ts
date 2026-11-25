import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDeterministicAnalysis } from '../analysis/engine.ts';
import {
  DEFAULT_SIGNAL_SETTINGS,
  DEFAULT_TECHNICAL_SETTINGS,
  TIMEFRAME_SECONDS,
} from '../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  Candle,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  SignalSettings,
  Timeframe,
  TradingSignal,
} from '../shared/types/index.ts';
import { buildSnapshotsRecord, SignalEngine } from '../signals/engine.ts';
import { SignalLifecycleManager } from '../signals/lifecycle/index.ts';
import { computeSignalPerformance } from '../signals/performance/index.ts';
import {
  applyRiskRewardScore,
  classifySignalScore,
  evaluateDirectionalScore,
} from '../signals/scoring/index.ts';
import { SignalSqliteStore } from '../signals/storage/sqlite.ts';
import { buildTradePlan } from '../signals/trade-plan/index.ts';
import { validateMarketDataIntegrity } from '../signals/validation/index.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

const realBtcCandles: Candle[] = fixtureCandles as Candle[];

function makeProvider(symbol: InstrumentSymbol = 'BTCUSDT', healthy = true): ProviderStatus {
  return {
    symbol,
    assetClass: symbol === 'XAUUSD' || symbol === 'XAGUSD' ? 'METALS' : 'CRYPTO',
    providerName: 'Test Market Feed',
    hasHistoricalCredentials: healthy,
    hasStreamingFeed: healthy,
    connectionStatus: healthy ? 'CONNECTED' : 'ERROR',
    lastUpdateTime: Date.now(),
    feedDelaySeconds: 0,
  };
}

function makeQuote(symbol: InstrumentSymbol, price: number, stale = false): LiveQuote {
  const now = Date.now();
  return {
    symbol,
    price,
    change24h: 0,
    changePercent24h: 0,
    direction: 'neutral',
    provider: 'Test Market Feed',
    feedDelaySeconds: 0,
    connectionStatus: 'CONNECTED',
    marketOpen: true,
    lastUpdateTime: now,
    providerTimestamp: now,
    stale,
  };
}

function makeCandles(
  count: number,
  tf: Timeframe,
  basePrice: number,
  step: number,
  nowSec: number,
  volume = 1200
): Candle[] {
  const sec = TIMEFRAME_SECONDS[tf];
  const start = nowSec - count * sec;
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const open = basePrice + i * step;
    const close = open + step * 0.8;
    const high = Math.max(open, close) + Math.abs(step) * 0.4 + 2;
    const low = Math.min(open, close) - Math.abs(step) * 0.4 - 2;
    out.push({
      time: start + i * sec,
      open,
      high,
      low,
      close,
      volume,
      isClosed: true,
    });
  }
  return out;
}

function makeSnapshot(params: {
  symbol?: InstrumentSymbol;
  timeframe: Timeframe;
  trend: 'bullish' | 'bearish' | 'consolidation';
  price: number;
  atr: number;
  nowSec: number;
  volume?: number;
}): AnalysisSnapshot {
  const symbol = params.symbol ?? 'BTCUSDT';
  const candles = makeCandles(
    45,
    params.timeframe,
    params.price - (params.trend === 'bullish' ? 200 : -200),
    params.trend === 'bullish' ? 4.5 : -4.5,
    params.nowSec,
    params.volume ?? 1500
  );
  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    close: params.price,
    high: params.price + params.atr * 0.6,
    low: params.price - params.atr * 0.6,
    volume: (params.volume ?? 1500) * 1.8,
    isClosed: true,
  };

  return {
    symbol,
    timeframe: params.timeframe,
    candles,
    quote: makeQuote(symbol, params.price),
    providerStatus: makeProvider(symbol, true),
    atr: params.atr,
    marketStructure: {
      symbol,
      timeframe: params.timeframe,
      trend: params.trend,
      internalTrend: params.trend,
      lastExternalLabel: params.trend === 'bullish' ? 'HH' : 'LL',
      lastInternalLabel: params.trend === 'bullish' ? 'HH' : 'LL',
      swings: [],
      breaks: [],
      currentRangeHigh: params.price + params.atr * 4,
      currentRangeLow: params.price - params.atr * 4,
    },
    candlestickPatterns: [],
    chartPatterns: [],
    supportResistance: [],
    supplyDemand: [],
    liquidityPools: [],
    orderBlocks: [],
    fairValueGaps: [],
    trendlines: [],
    dealingRange: null,
    sessions: [],
    sessionAnchors: {
      dailyOpen: params.price - 100,
      dailyOpenTime: params.nowSec - 3600 * 6,
      weeklyOpen: params.price - 250,
      weeklyOpenTime: params.nowSec - 86400 * 2,
      prevDayHigh: params.price + 400,
      prevDayLow: params.price - 400,
      prevWeekHigh: params.price + 800,
      prevWeekLow: params.price - 800,
      prevMonthHigh: null,
      prevMonthLow: null,
    },
    zoneInteractions: [],
    liveEvents: [],
    lastAnalyzedAt: params.nowSec * 1000,
  };
}

function buildFullBullishSnapshots(nowSec: number): Record<string, AnalysisSnapshot> {
  const price = 60000;
  const atr = 50;

  const snap1D = makeSnapshot({ timeframe: '1D', trend: 'bullish', price, atr: 600, nowSec });
  const snap4H = makeSnapshot({ timeframe: '4H', trend: 'bullish', price, atr: 250, nowSec });
  const snap1H = makeSnapshot({ timeframe: '1H', trend: 'bullish', price, atr: 120, nowSec });
  const snap15m = makeSnapshot({ timeframe: '15m', trend: 'bullish', price, atr: 70, nowSec });
  const snap5m = makeSnapshot({ timeframe: '5m', trend: 'bullish', price, atr, nowSec });

  // Sell-side liquidity sweep on 5m
  snap5m.liquidityPools.push({
    id: 'BTCUSDT:5m:liq:ssl1',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    kind: 'equal_lows',
    label: 'Equal Lows SSL',
    price: 59900,
    upper: 59915,
    lower: 59890,
    originTimes: [nowSec - 1800, nowSec - 900],
    swept: true,
    sweepTime: nowSec - 300,
    sweepType: 'stop_hunt',
    interactionState: 'Confirmed Breakout',
    formationTime: nowSec - 1800,
    confirmationTime: nowSec - 600,
    detectionTime: nowSec - 600,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  // Closed-candle structural CHoCH + MSS at same breakTime (verifies no double-counting) + BOS
  snap5m.marketStructure.breaks.push(
    {
      id: 'br-choch',
      symbol: 'BTCUSDT',
      timeframe: '5m',
      type: 'CHoCH',
      scope: 'external',
      direction: 'bullish',
      levelPrice: 59960,
      originTime: nowSec - 900,
      breakTime: nowSec - 240,
      breakMethod: 'close',
      swingPointId: 'sw1',
      formationTime: nowSec - 900,
      confirmationTime: nowSec - 240,
      detectionTime: nowSec - 240,
      invalidationTime: null,
      confirmationStatus: 'confirmed',
    },
    {
      id: 'br-mss',
      symbol: 'BTCUSDT',
      timeframe: '5m',
      type: 'MSS',
      scope: 'external',
      direction: 'bullish',
      levelPrice: 59960,
      originTime: nowSec - 900,
      breakTime: nowSec - 240,
      breakMethod: 'close',
      swingPointId: 'sw1',
      formationTime: nowSec - 900,
      confirmationTime: nowSec - 240,
      detectionTime: nowSec - 240,
      invalidationTime: null,
      confirmationStatus: 'confirmed',
    },
    {
      id: 'br-bos',
      symbol: 'BTCUSDT',
      timeframe: '5m',
      type: 'BOS',
      scope: 'internal',
      direction: 'bullish',
      levelPrice: 59990,
      originTime: nowSec - 480,
      breakTime: nowSec - 120,
      breakMethod: 'close',
      swingPointId: 'sw2',
      formationTime: nowSec - 480,
      confirmationTime: nowSec - 120,
      detectionTime: nowSec - 120,
      invalidationTime: null,
      confirmationStatus: 'confirmed',
    }
  );
  snap15m.marketStructure.breaks.push({
    id: 'br-15m-bos',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    type: 'BOS',
    scope: 'external',
    direction: 'bullish',
    levelPrice: 59980,
    originTime: nowSec - 1800,
    breakTime: nowSec - 300,
    breakMethod: 'close',
    swingPointId: 'sw15',
    formationTime: nowSec - 1800,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  // Bullish Order Block + Bullish FVG + Demand zone confluence around 60000
  snap5m.orderBlocks.push({
    id: 'ob-bull-5m',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    kind: 'bullish_ob',
    upper: 60015,
    lower: 59970,
    midpoint: 59992.5,
    originTime: nowSec - 600,
    displacementAtr: 2.1,
    valid: true,
    mitigated: false,
    mitigationPercent: 0,
    touches: 0,
    interactionState: 'Entered Zone',
    formationTime: nowSec - 600,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });
  snap5m.fairValueGaps.push({
    id: 'fvg-bull-5m',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    kind: 'bullish_fvg',
    upper: 60020,
    lower: 59985,
    consequentEncroachment: 60002.5,
    originTime: nowSec - 450,
    fillPercent: 0,
    status: 'unfilled',
    interactionState: 'Entered Zone',
    formationTime: nowSec - 450,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });
  snap15m.supplyDemand.push({
    id: 'sd-dem-15m',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    kind: 'demand',
    patternType: 'DBR',
    proximal: 60010,
    distal: 59950,
    midpoint: 59980,
    width: 60,
    originCandleTime: nowSec - 1800,
    departureStrength: 2.3,
    touches: 0,
    mitigationPercent: 0,
    freshness: 'fresh',
    htfAligned: true,
    distancePercent: 0.02,
    interactionState: 'Entered Zone',
    lastTouchTime: null,
    formationTime: nowSec - 1800,
    confirmationTime: nowSec - 900,
    detectionTime: nowSec - 900,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  // Discount + OTE positioning
  snap15m.dealingRange = {
    id: 'dr-15m',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    sourceTimeframe: '15m',
    rangeHigh: 60600,
    rangeLow: 59700,
    equilibrium: 60150,
    fib62: 60042,
    ote705: 59965.5,
    fib79: 59889,
    highTime: nowSec - 1800,
    lowTime: nowSec - 7200,
    currentPosition: 'discount',
    retracementPercent: 66.7,
    inOteZone: true,
  };

  // Protected structural swing low for SL invalidation
  snap5m.marketStructure.swings.push({
    id: 'sw-low-5m',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    kind: 'low',
    scope: 'external',
    price: 59920,
    candleTime: nowSec - 600,
    formationTime: nowSec - 600,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    candleIndex: 35,
    structureLabel: 'HL',
    confirmationStatus: 'confirmed',
  });

  // Three distinct opposing structural targets above entry
  snap5m.liquidityPools.push({
    id: 'liq-bsl-tp1',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    kind: 'buy_side',
    label: '5m BSL High',
    price: 60210,
    upper: 60220,
    lower: 60200,
    originTimes: [nowSec - 2400],
    swept: false,
    sweepTime: null,
    sweepType: null,
    interactionState: 'Far Away',
    formationTime: nowSec - 2400,
    confirmationTime: nowSec - 1800,
    detectionTime: nowSec - 1800,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });
  snap15m.supportResistance.push({
    id: 'sr-res-tp2',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    kind: 'resistance',
    source: 'swing_cluster',
    label: '15m Key Resistance',
    upper: 60400,
    lower: 60360,
    midpoint: 60380,
    touches: 3,
    rejections: 2,
    breakouts: 0,
    strengthScore: 82,
    firstDetection: nowSec - 5400,
    lastTest: nowSec - 1800,
    distancePercent: 0.6,
    status: 'Active',
    interactionState: 'Far Away',
    formationTime: nowSec - 5400,
    confirmationTime: nowSec - 3600,
    detectionTime: nowSec - 3600,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });
  snap1H.liquidityPools.push({
    id: 'liq-bsl-tp3',
    symbol: 'BTCUSDT',
    timeframe: '1H',
    kind: 'pdh',
    label: '1H Previous High BSL',
    price: 60580,
    upper: 60595,
    lower: 60565,
    originTimes: [nowSec - 14400],
    swept: false,
    sweepTime: null,
    sweepType: null,
    interactionState: 'Far Away',
    formationTime: nowSec - 14400,
    confirmationTime: nowSec - 10800,
    detectionTime: nowSec - 10800,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  return {
    '1D': snap1D,
    '4H': snap4H,
    '1H': snap1H,
    '15m': snap15m,
    '5m': snap5m,
  };
}

function buildFullBearishSnapshots(nowSec: number): Record<string, AnalysisSnapshot> {
  const price = 2700;
  const atr = 3.5;

  const snap1D = makeSnapshot({ symbol: 'XAUUSD', timeframe: '1D', trend: 'bearish', price, atr: 28, nowSec });
  const snap4H = makeSnapshot({ symbol: 'XAUUSD', timeframe: '4H', trend: 'bearish', price, atr: 14, nowSec });
  const snap1H = makeSnapshot({ symbol: 'XAUUSD', timeframe: '1H', trend: 'bearish', price, atr: 7.5, nowSec });
  const snap15m = makeSnapshot({ symbol: 'XAUUSD', timeframe: '15m', trend: 'bearish', price, atr: 5.0, nowSec });
  const snap5m = makeSnapshot({ symbol: 'XAUUSD', timeframe: '5m', trend: 'bearish', price, atr, nowSec });

  snap5m.liquidityPools.push({
    id: 'XAUUSD:5m:liq:bsl1',
    symbol: 'XAUUSD',
    timeframe: '5m',
    kind: 'equal_highs',
    label: 'Equal Highs BSL',
    price: 2708,
    upper: 2709,
    lower: 2707,
    originTimes: [nowSec - 1800, nowSec - 900],
    swept: true,
    sweepTime: nowSec - 300,
    sweepType: 'stop_hunt',
    interactionState: 'Confirmed Breakout',
    formationTime: nowSec - 1800,
    confirmationTime: nowSec - 600,
    detectionTime: nowSec - 600,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  snap5m.marketStructure.breaks.push(
    {
      id: 'xau-mss',
      symbol: 'XAUUSD',
      timeframe: '5m',
      type: 'MSS',
      scope: 'external',
      direction: 'bearish',
      levelPrice: 2702,
      originTime: nowSec - 900,
      breakTime: nowSec - 240,
      breakMethod: 'close',
      swingPointId: 'xau-sw1',
      formationTime: nowSec - 900,
      confirmationTime: nowSec - 240,
      detectionTime: nowSec - 240,
      invalidationTime: null,
      confirmationStatus: 'confirmed',
    },
    {
      id: 'xau-bos',
      symbol: 'XAUUSD',
      timeframe: '5m',
      type: 'BOS',
      scope: 'internal',
      direction: 'bearish',
      levelPrice: 2700.5,
      originTime: nowSec - 480,
      breakTime: nowSec - 120,
      breakMethod: 'close',
      swingPointId: 'xau-sw2',
      formationTime: nowSec - 480,
      confirmationTime: nowSec - 120,
      detectionTime: nowSec - 120,
      invalidationTime: null,
      confirmationStatus: 'confirmed',
    }
  );
  snap15m.marketStructure.breaks.push({
    id: 'xau-15m-bos',
    symbol: 'XAUUSD',
    timeframe: '15m',
    type: 'BOS',
    scope: 'external',
    direction: 'bearish',
    levelPrice: 2701,
    originTime: nowSec - 1800,
    breakTime: nowSec - 300,
    breakMethod: 'close',
    swingPointId: 'xau-sw15',
    formationTime: nowSec - 1800,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  snap5m.orderBlocks.push({
    id: 'xau-ob-bear-5m',
    symbol: 'XAUUSD',
    timeframe: '5m',
    kind: 'bearish_ob',
    upper: 2703,
    lower: 2699,
    midpoint: 2701,
    originTime: nowSec - 600,
    displacementAtr: 2.2,
    valid: true,
    mitigated: false,
    mitigationPercent: 0,
    touches: 0,
    interactionState: 'Entered Zone',
    formationTime: nowSec - 600,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  snap15m.dealingRange = {
    id: 'xau-dr-15m',
    symbol: 'XAUUSD',
    timeframe: '15m',
    sourceTimeframe: '15m',
    rangeHigh: 2715,
    rangeLow: 2665,
    equilibrium: 2690,
    fib62: 2696,
    ote705: 2700.25,
    fib79: 2704.5,
    highTime: nowSec - 7200,
    lowTime: nowSec - 1800,
    currentPosition: 'premium',
    retracementPercent: 70,
    inOteZone: true,
  };

  snap5m.marketStructure.swings.push({
    id: 'xau-sw-high-5m',
    symbol: 'XAUUSD',
    timeframe: '5m',
    kind: 'high',
    scope: 'external',
    price: 2707,
    candleTime: nowSec - 600,
    formationTime: nowSec - 600,
    confirmationTime: nowSec - 300,
    detectionTime: nowSec - 300,
    invalidationTime: null,
    candleIndex: 35,
    structureLabel: 'LH',
    confirmationStatus: 'confirmed',
  });

  snap5m.liquidityPools.push({
    id: 'xau-ssl-tp1',
    symbol: 'XAUUSD',
    timeframe: '5m',
    kind: 'sell_side',
    label: '5m SSL Low',
    price: 2684,
    upper: 2684.5,
    lower: 2683.5,
    originTimes: [nowSec - 2400],
    swept: false,
    sweepTime: null,
    sweepType: null,
    interactionState: 'Far Away',
    formationTime: nowSec - 2400,
    confirmationTime: nowSec - 1800,
    detectionTime: nowSec - 1800,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });
  snap1H.supportResistance.push({
    id: 'xau-sup-tp2',
    symbol: 'XAUUSD',
    timeframe: '1H',
    kind: 'support',
    source: 'swing_cluster',
    label: '1H Key Support',
    upper: 2671,
    lower: 2669,
    midpoint: 2670,
    touches: 3,
    rejections: 2,
    breakouts: 0,
    strengthScore: 86,
    firstDetection: nowSec - 7200,
    lastTest: nowSec - 3600,
    distancePercent: 1.1,
    status: 'Active',
    interactionState: 'Far Away',
    formationTime: nowSec - 7200,
    confirmationTime: nowSec - 3600,
    detectionTime: nowSec - 3600,
    invalidationTime: null,
    confirmationStatus: 'confirmed',
  });

  return {
    '1D': snap1D,
    '4H': snap4H,
    '1H': snap1H,
    '15m': snap15m,
    '5m': snap5m,
  };
}

describe('Institutional BUY / SELL Signal Generation System', () => {
  it('enforces market data integrity and rejects missing, stale, or unhealthy feeds', () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const full = buildFullBullishSnapshots(nowSec);

    const missing4h = { ...full, '4H': null };
    const missingRes = validateMarketDataIntegrity(
      'BTCUSDT',
      missing4h,
      makeQuote('BTCUSDT', 60000),
      makeProvider('BTCUSDT', true),
      DEFAULT_SIGNAL_SETTINGS,
      nowMs
    );
    expect(missingRes.ok).toBe(false);
    expect(missingRes.reasons.some((r: string) => r.includes('4H'))).toBe(true);

    const staleRes = validateMarketDataIntegrity(
      'BTCUSDT',
      full,
      makeQuote('BTCUSDT', 60000, true),
      makeProvider('BTCUSDT', true),
      DEFAULT_SIGNAL_SETTINGS,
      nowMs
    );
    expect(staleRes.ok).toBe(false);
    expect(staleRes.reasons.some((r: string) => r.toLowerCase().includes('stale'))).toBe(true);

    const errRes = validateMarketDataIntegrity(
      'BTCUSDT',
      full,
      makeQuote('BTCUSDT', 60000),
      makeProvider('BTCUSDT', false),
      DEFAULT_SIGNAL_SETTINGS,
      nowMs
    );
    expect(errRes.ok).toBe(false);
  });

  it('never generates a signal from a liquidity sweep alone without structural confirmation', () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const snaps = buildFullBullishSnapshots(nowSec);
    snaps['5m'].marketStructure.breaks = [];
    snaps['15m'].marketStructure.breaks = [];

    const engine = new SignalEngine();
    const res = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: snaps,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs,
    });

    expect(res.diagnostic.status).toBe('NO_TRADE');
    expect(res.emittedSignals.length).toBe(0);
    expect(
      res.diagnostic.rejectionReasons.some((r: string) =>
        r.includes('without structural MSS/CHoCH/BOS confirmation')
      )
    ).toBe(true);
  });

  it('prevents double-counting simultaneous MSS + CHoCH and gives zero volume points when volume is missing', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const snaps = buildFullBullishSnapshots(nowSec);

    snaps['5m'].candles = snaps['5m'].candles.map((c) => ({ ...c, volume: 0 }));
    const lastIdx = snaps['5m'].candles.length - 1;
    snaps['5m'].candles[lastIdx - 4].open = 60000;
    snaps['5m'].candles[lastIdx].close = 60000;
    snaps['15m'].candles[snaps['15m'].candles.length - 5].open = 60000;
    snaps['15m'].candles[snaps['15m'].candles.length - 1].close = 60000;

    const factors = evaluateDirectionalScore('BUY', snaps, DEFAULT_SIGNAL_SETTINGS, 60000);
    expect(factors.scoreBreakdown.structureConfirmation.score).toBeLessThanOrEqual(
      DEFAULT_SIGNAL_SETTINGS.weights.structureConfirmation
    );
    expect(factors.scoreBreakdown.volumeMomentum.score).toBe(0);
    expect(classifySignalScore(88)).toBe('Excellent');
    expect(classifySignalScore(78)).toBe('Strong');
    expect(classifySignalScore(68)).toBe('Moderate');
    expect(classifySignalScore(64)).toBe('No Trade');
  });

  it('builds valid BUY & SELL trade plans with ATR-buffered SL and never invents 3 targets if structure only supports fewer', () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const bullSnaps = buildFullBullishSnapshots(nowSec);

    const buyPlan = buildTradePlan('BTCUSDT', 'BUY', bullSnaps, 60000, DEFAULT_SIGNAL_SETTINGS);
    expect(buyPlan.valid).toBe(true);
    expect(buyPlan.stopLoss).toBeLessThan(buyPlan.invalidationLevel);
    expect(buyPlan.invalidationLevel).toBeLessThan(buyPlan.entryPrice);
    expect(buyPlan.takeProfits.length).toBe(3);
    expect(buyPlan.primaryRR).toBeGreaterThanOrEqual(DEFAULT_SIGNAL_SETTINGS.minTp1RiskReward);
    expect(buyPlan.takeProfits[0].price).toBeLessThan(buyPlan.takeProfits[1].price);
    expect(buyPlan.takeProfits[1].price).toBeLessThan(buyPlan.takeProfits[2].price);

    // Remove TP2 and TP3 structural levels -> must return ONLY 1 TP, never fabricate 3
    bullSnaps['15m'].supportResistance = [];
    bullSnaps['1H'].liquidityPools = [];
    const singleTpPlan = buildTradePlan('BTCUSDT', 'BUY', bullSnaps, 60000, DEFAULT_SIGNAL_SETTINGS);
    expect(singleTpPlan.valid).toBe(true);
    expect(singleTpPlan.takeProfits.length).toBe(1);

    const bearSnaps = buildFullBearishSnapshots(nowSec);
    const sellPlan = buildTradePlan('XAUUSD', 'SELL', bearSnaps, 2700, DEFAULT_SIGNAL_SETTINGS);
    expect(sellPlan.valid).toBe(true);
    expect(sellPlan.stopLoss).toBeGreaterThan(sellPlan.invalidationLevel);
    expect(sellPlan.invalidationLevel).toBeGreaterThan(sellPlan.entryPrice);
    expect(sellPlan.takeProfits.length).toBe(2);
    expect(sellPlan.primaryRR).toBeGreaterThanOrEqual(DEFAULT_SIGNAL_SETTINGS.minTp1RiskReward);

    const strictSettings: SignalSettings = {
      ...DEFAULT_SIGNAL_SETTINGS,
      minTp1RiskReward: 10,
    };
    const rejectedPlan = buildTradePlan('XAUUSD', 'SELL', bearSnaps, 2700, strictSettings);
    expect(rejectedPlan.valid).toBe(false);
    expect(rejectedPlan.rejectionReason).toContain('risk/reward');
  });

  it('generates CONFIRMED BUY and SELL signals when institutional criteria are satisfied and prevents duplicates', () => {
    const nowMs = Date.UTC(2026, 10, 18, 14, 0, 0); // Open Wednesday session UTC
    const nowSec = Math.floor(nowMs / 1000);
    const engine = new SignalEngine();

    const bullRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildFullBullishSnapshots(nowSec),
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs,
    });
    expect(bullRes.diagnostic.status).toBe('SIGNAL_GENERATED');
    expect(bullRes.emittedSignals.length).toBe(1);
    const buySig = bullRes.emittedSignals[0];
    expect(buySig.direction).toBe('BUY');
    expect(buySig.state).toBe('CONFIRMED');
    expect(buySig.score).toBeGreaterThanOrEqual(75);
    expect(buySig.takeProfits.length).toBe(3);

    const dupRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildFullBullishSnapshots(nowSec),
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowMs + 5000,
    });
    expect(engine.getSignals('BTCUSDT').length).toBe(1);
    expect(
      dupRes.diagnostic.rejectionReasons.some((r: string) => r.includes('Duplicate active'))
    ).toBe(true);

    const sellRes = engine.evaluate({
      symbol: 'XAUUSD',
      snapshots: buildFullBearishSnapshots(nowSec),
      quote: makeQuote('XAUUSD', 2700),
      providerStatus: makeProvider('XAUUSD', true),
      nowMs,
    });
    expect(sellRes.diagnostic.status).toBe('SIGNAL_GENERATED');
    expect(sellRes.emittedSignals[0].direction).toBe('SELL');
    expect(sellRes.emittedSignals[0].state).toBe('CONFIRMED');
  });

  it('tracks full lifecycle states: WATCHING -> CONFIRMED -> ACTIVE -> TP1_HIT -> TP2_HIT -> TP3_HIT, STOPPED, EXPIRED, CANCELLED', () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const bullSnaps = buildFullBullishSnapshots(nowSec);

    bullSnaps['5m'].marketStructure.breaks = [
      {
        id: 'br-prov',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: 'MSS',
        scope: 'external',
        direction: 'bullish',
        levelPrice: 59960,
        originTime: nowSec - 600,
        breakTime: nowSec - 60,
        breakMethod: 'wick',
        swingPointId: 'sw1',
        formationTime: nowSec - 600,
        confirmationTime: null,
        detectionTime: nowSec - 60,
        invalidationTime: null,
        confirmationStatus: 'provisional',
      },
    ];
    bullSnaps['15m'].marketStructure.breaks = [];

    const engine = new SignalEngine();
    const watchRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: bullSnaps,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs,
    });
    expect(watchRes.diagnostic.status).toBe('WATCHING_CANDIDATE');
    expect(watchRes.emittedSignals[0].state).toBe('WATCHING');
    expect(watchRes.emittedSignals[0].provisional).toBe(true);

    const confirmedSnaps = buildFullBullishSnapshots(nowSec + 60);
    const confRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: confirmedSnaps,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowMs + 60_000,
    });
    expect(confRes.diagnostic.status).toBe('SIGNAL_GENERATED');
    const sig = engine.getSignals('BTCUSDT')[0];
    expect(sig.state).toBe('CONFIRMED');
    expect(sig.provisional).toBe(false);

    engine.processLiveQuote({ ...makeQuote('BTCUSDT', sig.entryPrice), lastUpdateTime: nowMs + 65_000 });
    expect(engine.getSignals('BTCUSDT')[0].state).toBe('ACTIVE');

    engine.processLiveQuote({
      ...makeQuote('BTCUSDT', sig.takeProfits[0].price + 1),
      lastUpdateTime: nowMs + 70_000,
    });
    const afterTp1 = engine.getSignals('BTCUSDT')[0];
    expect(afterTp1.state).toBe('TP1_HIT');
    expect(afterTp1.timeline.some((t) => t.state === 'PARTIAL')).toBe(true);

    engine.processLiveQuote({
      ...makeQuote('BTCUSDT', sig.takeProfits[1].price + 1),
      lastUpdateTime: nowMs + 75_000,
    });
    expect(engine.getSignals('BTCUSDT')[0].state).toBe('TP2_HIT');

    engine.processLiveQuote({
      ...makeQuote('BTCUSDT', sig.takeProfits[2].price + 1),
      lastUpdateTime: nowMs + 80_000,
    });
    const afterTp3 = engine.getSignals('BTCUSDT')[0];
    expect(afterTp3.state).toBe('TP3_HIT');
    expect(afterTp3.closedAt).not.toBeNull();
    expect(afterTp3.realizedR ?? 0).toBeGreaterThan(0);

    const lifecycle = new SignalLifecycleManager();
    const bearSnaps = buildFullBearishSnapshots(nowSec);
    const factors = evaluateDirectionalScore('SELL', bearSnaps, DEFAULT_SIGNAL_SETTINGS, 2700);
    const plan = buildTradePlan('XAUUSD', 'SELL', bearSnaps, 2700, DEFAULT_SIGNAL_SETTINGS);
    const breakdown = applyRiskRewardScore(factors.scoreBreakdown, plan.primaryRR, 1.5, 10);
    const candidate = {
      direction: 'SELL' as const,
      preRiskScoreBreakdown: factors.scoreBreakdown,
      finalScoreBreakdown: breakdown,
      tradePlan: plan,
      hasLiquiditySweep: factors.hasLiquiditySweep,
      hasStructuralConfirmation: factors.hasStructuralConfirmation,
      hasClosedCandleConfirmation: true,
      hasConfluenceZone: factors.hasConfluenceZone,
      hasStrongConflict: false,
      conflictReasons: [],
      confluenceReasons: factors.confluenceReasons,
      anchorCandleTime: nowSec,
      htfBias: {
        d1: 'bearish',
        h4: 'bearish',
        h1: 'bearish',
        m15: 'bearish',
        m5: 'bearish',
      } as const,
    };

    const up = lifecycle.upsertCandidate('XAUUSD', candidate, false, DEFAULT_SIGNAL_SETTINGS, nowMs);
    expect(up.signal.state).toBe('CONFIRMED');
    lifecycle.processPriceUpdate('XAUUSD', up.signal.entryPrice, null, DEFAULT_SIGNAL_SETTINGS, nowMs + 1000);
    expect(up.signal.state).toBe('ACTIVE');
    lifecycle.processPriceUpdate('XAUUSD', up.signal.stopLoss + 1, null, DEFAULT_SIGNAL_SETTINGS, nowMs + 2000);
    expect(up.signal.state).toBe('STOPPED');
    expect(up.signal.realizedR).toBe(-1);

    const watchUp = lifecycle.upsertCandidate('XAUUSD', candidate, true, DEFAULT_SIGNAL_SETTINGS, nowMs + 3000);
    expect(watchUp.signal.state).toBe('WATCHING');
    const cancelled = lifecycle.cancelSignal(watchUp.signal.id, nowMs + 4000);
    expect(cancelled?.state).toBe('CANCELLED');

    const expUp = lifecycle.upsertCandidate('XAUUSD', candidate, true, DEFAULT_SIGNAL_SETTINGS, nowMs + 5000);
    expect(expUp.signal.state).toBe('WATCHING');
    lifecycle.processPriceUpdate(
      'XAUUSD',
      2700,
      null,
      DEFAULT_SIGNAL_SETTINGS,
      nowMs + 5000 + (DEFAULT_SIGNAL_SETTINGS.maxWatchingMinutes + 5) * 60_000
    );
    expect(expUp.signal.state).toBe('EXPIRED');
  });

  it('computes accurate signal performance metrics strictly from recorded outcomes', () => {
    const baseSignal = (overrides: Partial<TradingSignal>): TradingSignal => ({
      id: `sig-${Math.random()}`,
      symbol: 'BTCUSDT',
      entryTimeframe: '5m',
      setupTimeframe: '15m',
      direction: 'BUY',
      state: 'TP3_HIT',
      provisional: false,
      score: 85,
      classification: 'Excellent',
      scoreBreakdown: {} as TradingSignal['scoreBreakdown'],
      htfBias: { d1: 'bullish', h4: 'bullish', h1: 'bullish', m15: 'bullish', m5: 'bullish' },
      entryPrice: 60000,
      entryZone: { lower: 59980, upper: 60020 },
      stopLoss: 59900,
      invalidationLevel: 59920,
      atrBuffer: 20,
      takeProfits: [
        { level: 1, price: 60200, riskReward: 2.0, sourceLabel: 'BSL', hit: true, hitTime: 1000 },
        { level: 2, price: 60400, riskReward: 4.0, sourceLabel: 'Res', hit: true, hitTime: 2000 },
      ],
      primaryRR: 2.0,
      maxRR: 4.0,
      confluenceReasons: [],
      timeframeSummary: '',
      createdAt: 100,
      confirmedAt: 200,
      activatedAt: 300,
      closedAt: 2000,
      candleTime: 10,
      realizedR: 3.0,
      highestFavorableR: 4.0,
      maxAdverseR: 0.2,
      timeline: [],
      ...overrides,
    });

    const recorded: TradingSignal[] = [
      baseSignal({ id: 's1', symbol: 'BTCUSDT', direction: 'BUY', realizedR: 3.0, closedAt: 1000 }),
      baseSignal({
        id: 's2',
        symbol: 'XAUUSD',
        direction: 'SELL',
        state: 'STOPPED',
        realizedR: -1.0,
        closedAt: 2000,
        takeProfits: [
          { level: 1, price: 2680, riskReward: 2.0, sourceLabel: 'SSL', hit: false, hitTime: null },
          { level: 2, price: 2660, riskReward: 4.0, sourceLabel: 'Sup', hit: false, hitTime: null },
        ],
      }),
      baseSignal({
        id: 's3',
        symbol: 'ETHUSDT',
        state: 'WATCHING',
        provisional: true,
        confirmedAt: null,
        activatedAt: null,
        closedAt: null,
        realizedR: null,
        takeProfits: [
          { level: 1, price: 3200, riskReward: 2.0, sourceLabel: 'BSL', hit: false, hitTime: null },
        ],
      }),
    ];

    const perf = computeSignalPerformance(recorded);
    expect(perf.totalSignals).toBe(2);
    expect(perf.watchingCount).toBe(1);
    expect(perf.winningSignals).toBe(1);
    expect(perf.losingSignals).toBe(1);
    expect(perf.winRate).toBe(50);
    expect(perf.tp1HitRate).toBe(50);
    expect(perf.tp2HitRate).toBe(50);
    expect(perf.slHitRate).toBe(50);
    expect(perf.avgRMultiple).toBe(1.0);
    expect(perf.profitFactor).toBe(3.0);
    expect(perf.maxDrawdownR).toBe(1.0);
    expect(perf.byInstrument.BTCUSDT.wins).toBe(1);
    expect(perf.byInstrument.XAUUSD.losses).toBe(1);
    expect(perf.byTimeframe['5m'].total).toBe(2);
  });

  it('evaluates real BTCUSDT historical fixture snapshots deterministically without error', () => {
    const snap15 = runDeterministicAnalysis({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles: realBtcCandles,
      dailyCandles: realBtcCandles,
      htfTrend: 'consolidation',
      quote: null,
      providerStatus: makeProvider('BTCUSDT', true),
      settings: DEFAULT_TECHNICAL_SETTINGS,
    });

    const engine = new SignalEngine();
    const res = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildSnapshotsRecord([
        ['15m', snap15],
        ['5m', snap15],
      ]),
      quote: null,
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: (realBtcCandles[realBtcCandles.length - 1].time + 60) * 1000,
    });

    expect(res.diagnostic.status).toBe('NO_TRADE');
    expect(res.diagnostic.rejectionReasons.length).toBeGreaterThan(0);
  });

  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists signals in SQLite across restarts and supports single, batch, and scoped deletion', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbt-sqlite-test-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'signals.sqlite');

    const nowMs = Date.UTC(2026, 10, 18, 14, 0, 0); // Open Wednesday session UTC
    const nowSec = Math.floor(nowMs / 1000);

    // 1. Create signals and progress lifecycle in first engine instance
    const store1 = new SignalSqliteStore(dbPath);
    const engine1 = new SignalEngine(store1);

    const buyRes = engine1.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildFullBullishSnapshots(nowSec),
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs,
    });
    expect(buyRes.emittedSignals.length).toBe(1);
    const btcSig = buyRes.emittedSignals[0];

    // Activate and hit TP1 on BTC signal
    engine1.processLiveQuote({ ...makeQuote('BTCUSDT', btcSig.entryPrice), lastUpdateTime: nowMs + 2000 });
    engine1.processLiveQuote({
      ...makeQuote('BTCUSDT', btcSig.takeProfits[0].price + 2),
      lastUpdateTime: nowMs + 4000,
    });

    // Generate XAUUSD SELL signal and stop it out (closed state)
    const sellRes = engine1.evaluate({
      symbol: 'XAUUSD',
      snapshots: buildFullBearishSnapshots(nowSec),
      quote: makeQuote('XAUUSD', 2700),
      providerStatus: makeProvider('XAUUSD', true),
      nowMs: nowMs + 5000,
    });
    expect(sellRes.emittedSignals.length).toBe(1);
    const xauSig = sellRes.emittedSignals[0];
    engine1.processLiveQuote({ ...makeQuote('XAUUSD', xauSig.entryPrice), lastUpdateTime: nowMs + 6000 });
    engine1.processLiveQuote({ ...makeQuote('XAUUSD', xauSig.stopLoss + 1), lastUpdateTime: nowMs + 8000 });

    // Create a provisional WATCHING candidate on ETHUSDT (reusing bullish snaps under ETHUSDT)
    const ethSnaps = buildFullBullishSnapshots(nowSec + 60);
    for (const snap of Object.values(ethSnaps)) {
      snap.symbol = 'ETHUSDT';
      snap.quote = makeQuote('ETHUSDT', 60000);
      snap.providerStatus = makeProvider('ETHUSDT', true);
    }
    ethSnaps['5m'].marketStructure.breaks = [
      {
        id: 'eth-prov',
        symbol: 'ETHUSDT',
        timeframe: '5m',
        type: 'MSS',
        scope: 'external',
        direction: 'bullish',
        levelPrice: 59960,
        originTime: nowSec - 600,
        breakTime: nowSec - 60,
        breakMethod: 'wick',
        swingPointId: 'sw-eth',
        formationTime: nowSec - 600,
        confirmationTime: null,
        detectionTime: nowSec - 60,
        invalidationTime: null,
        confirmationStatus: 'provisional',
      },
    ];
    ethSnaps['15m'].marketStructure.breaks = [];
    const ethRes = engine1.evaluate({
      symbol: 'ETHUSDT',
      snapshots: ethSnaps,
      quote: makeQuote('ETHUSDT', 60000),
      providerStatus: makeProvider('ETHUSDT', true),
      nowMs: nowMs + 10_000,
    });
    expect(ethRes.emittedSignals.length).toBe(1);
    const ethSig = ethRes.emittedSignals[0];
    expect(ethSig.state).toBe('WATCHING');

    store1.close();

    // 2. Simulate server restart by opening a fresh store + engine on the same SQLite file
    const store2 = new SignalSqliteStore(dbPath);
    const engine2 = new SignalEngine(store2);

    const rehydrated = engine2.getSignals();
    expect(rehydrated.length).toBe(3);
    expect(rehydrated.find((s) => s.id === btcSig.id)?.state).toBe('TP1_HIT');
    const rehydratedXau = rehydrated.find((s) => s.id === xauSig.id);
    expect(rehydratedXau?.state).toBe('STOPPED');
    expect(rehydratedXau?.generationSummary).toContain('SELL XAUUSD');
    expect(rehydratedXau?.outcomeSummary).toContain('Stopped out');
    expect((rehydratedXau?.failureReasons ?? []).length).toBeGreaterThanOrEqual(2);
    expect(rehydrated.find((s) => s.id === ethSig.id)?.state).toBe('WATCHING');
    expect(engine2.getNotifications().length).toBeGreaterThanOrEqual(3);

    // 3. Clear closed entries only -> XAUUSD (STOPPED) removed, BTCUSDT (TP1_HIT) & ETHUSDT (WATCHING) remain
    const clearedClosed = engine2.clearSignals('closed');
    expect(clearedClosed).toEqual([xauSig.id]);
    expect(engine2.getSignals().map((s) => s.id).sort()).toEqual([btcSig.id, ethSig.id].sort());

    // 4. Single delete on ETHUSDT WATCHING signal
    const deletedSingle = engine2.deleteSignal(ethSig.id);
    expect(deletedSingle).toBe(true);
    expect(engine2.deleteSignal('non-existent-id')).toBe(false);
    expect(engine2.getSignals().map((s) => s.id)).toEqual([btcSig.id]);

    // 5. Batch delete remaining signal
    const deletedBatch = engine2.deleteSignals([btcSig.id, 'missing-id']);
    expect(deletedBatch).toEqual([btcSig.id]);
    expect(engine2.getSignals().length).toBe(0);
    store2.close();

    // 6. Verify fresh SQLite connection confirms all rows & notifications were removed
    const store3 = new SignalSqliteStore(dbPath);
    expect(store3.getAllSignals().length).toBe(0);
    expect(store3.getNotifications().length).toBe(0);
    store3.close();
  });

  it('never generates or saves signals when the market is closed and ignores closed-market quote ticks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbt-closed-mkt-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'signals.sqlite');

    const weekendMs = Date.UTC(2026, 10, 21, 5, 0, 0); // Saturday UTC (spot metals closed)
    const weekendSec = Math.floor(weekendMs / 1000);

    const store = new SignalSqliteStore(dbPath);
    const engine = new SignalEngine(store);

    // Even if TradingView quote omits closed flag, XAUUSD weekend calendar blocks signal generation
    const xauRes = engine.evaluate({
      symbol: 'XAUUSD',
      snapshots: buildFullBearishSnapshots(weekendSec),
      quote: makeQuote('XAUUSD', 2700),
      providerStatus: makeProvider('XAUUSD', true),
      nowMs: weekendMs,
    });
    expect(xauRes.diagnostic.status).toBe('NO_TRADE');
    expect(xauRes.emittedSignals.length).toBe(0);
    expect(xauRes.diagnostic.rejectionReasons.some((r) => r.toLowerCase().includes('closed'))).toBe(
      true
    );

    // Explicit marketOpen: false / MARKET_CLOSED blocks even non-metals feeds
    const btcClosedRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildFullBullishSnapshots(weekendSec),
      quote: { ...makeQuote('BTCUSDT', 60000), marketOpen: false, connectionStatus: 'MARKET_CLOSED' },
      providerStatus: { ...makeProvider('BTCUSDT', true), connectionStatus: 'MARKET_CLOSED' },
      nowMs: weekendMs,
    });
    expect(btcClosedRes.diagnostic.status).toBe('NO_TRADE');
    expect(btcClosedRes.emittedSignals.length).toBe(0);
    expect(store.getAllSignals().length).toBe(0);

    // Closed-market quote tick does not mutate anything
    const quoteTickRes = engine.processLiveQuote({
      ...makeQuote('XAUUSD', 2700),
      marketOpen: false,
      connectionStatus: 'MARKET_CLOSED',
      lastUpdateTime: weekendMs,
    });
    expect(quoteTickRes.updatedSignals.length).toBe(0);
    store.close();
  });

  it('enforces individually toggled SMC pre-trigger criteria (Order Blocks, Fair Value Gaps, Liquidity Sweeps) before triggering signals', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(DEFAULT_SIGNAL_SETTINGS.smcCriteria).toEqual({
      requireOrderBlock: false,
      requireFairValueGap: false,
      requireLiquiditySweep: false,
    });

    // Build full bullish setup then selectively strip individual SMC elements
    const snapsNoOb = buildFullBullishSnapshots(nowSec);
    snapsNoOb['5m'].orderBlocks = [];
    snapsNoOb['15m'].orderBlocks = [];

    const engine = new SignalEngine();
    engine.updateSettings({
      smcCriteria: {
        requireOrderBlock: true,
        requireFairValueGap: false,
        requireLiquiditySweep: false,
      },
    });

    const missingObRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: snapsNoOb,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowSec * 1000,
    });
    expect(missingObRes.emittedSignals).toHaveLength(0);
    expect(missingObRes.diagnostic.rejectionReasons.some((r) => r.includes('Order Block'))).toBe(true);

    // Now test Fair Value Gap gate independently
    const snapsNoFvg = buildFullBullishSnapshots(nowSec);
    snapsNoFvg['5m'].fairValueGaps = [];
    snapsNoFvg['15m'].fairValueGaps = [];

    engine.updateSettings({
      smcCriteria: {
        requireOrderBlock: false,
        requireFairValueGap: true,
        requireLiquiditySweep: false,
      },
    });

    const missingFvgRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: snapsNoFvg,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowSec * 1000,
    });
    expect(missingFvgRes.emittedSignals).toHaveLength(0);
    expect(missingFvgRes.diagnostic.rejectionReasons.some((r) => r.includes('Fair Value Gap'))).toBe(true);

    // Now test Liquidity Sweep gate independently
    const snapsNoSweep = buildFullBullishSnapshots(nowSec);
    snapsNoSweep['5m'].liquidityPools = [];
    snapsNoSweep['15m'].liquidityPools = [];

    engine.updateSettings({
      smcCriteria: {
        requireOrderBlock: false,
        requireFairValueGap: false,
        requireLiquiditySweep: true,
      },
    });

    const missingSweepRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: snapsNoSweep,
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowSec * 1000,
    });
    expect(missingSweepRes.emittedSignals).toHaveLength(0);
    expect(missingSweepRes.diagnostic.rejectionReasons.some((r) => r.includes('Liquidity Sweep'))).toBe(true);

    // With all three enabled AND all three present on full bullish snapshots, BUY signal emits
    engine.updateSettings({
      smcCriteria: {
        requireOrderBlock: true,
        requireFairValueGap: true,
        requireLiquiditySweep: true,
      },
    });
    const fullRes = engine.evaluate({
      symbol: 'BTCUSDT',
      snapshots: buildFullBullishSnapshots(nowSec),
      quote: makeQuote('BTCUSDT', 60000),
      providerStatus: makeProvider('BTCUSDT', true),
      nowMs: nowSec * 1000,
    });
    expect(fullRes.emittedSignals.length).toBeGreaterThanOrEqual(1);
    expect(fullRes.emittedSignals[0].direction).toBe('BUY');
  });
});
