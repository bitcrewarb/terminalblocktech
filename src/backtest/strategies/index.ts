import { getInstrumentMeta, TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  BacktestConfig,
  BacktestStrategyId,
  BacktestTradeTarget,
  Candle,
  CandlestickPattern,
  ChartPattern,
  FairValueGap,
  LiquidityPool,
  OrderBlock,
  SDZone,
  SignalDirection,
  SRZone,
  StructureBreak,
  Trendline,
} from '../../shared/types/index.ts';
import { BACKTEST_STRATEGY_DEFINITIONS } from './catalog.ts';
import { evaluateComboStrategiesOnBar } from './combinations.ts';

export { BACKTEST_STRATEGY_DEFINITIONS };

export interface StrategySignalCandidate {
  strategyId: BacktestStrategyId;
  direction: SignalDirection;
  entryMode: 'market_close' | 'limit_retest';
  entryPrice: number;
  entryZone: { lower: number; upper: number };
  stopLoss: number;
  invalidationLevel: number;
  takeProfits: BacktestTradeTarget[];
  confluenceScore: number;
  entryRationale: string[];
}

function roundPrice(val: number, precision: number): number {
  const f = Math.pow(10, precision);
  return Math.round(val * f) / f;
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

interface BarContext {
  execSnap: AnalysisSnapshot;
  htfSnap: AnalysisSnapshot | null;
  bar: Candle;
  prevBar: Candle;
  candles: Candle[];
  atr: number;
  tfSec: number;
  precision: number;
  price: number;
  htfTrend: 'bullish' | 'bearish' | 'consolidation';
  execTrend: 'bullish' | 'bearish' | 'consolidation';
  barRange: number;
  barBody: number;
  upperWick: number;
  lowerWick: number;
  isBullBar: boolean;
  isBearBar: boolean;
  displacementSigned: number;
  volRatio: number;
  ema20: number;
  ema20Prev: number;
  ema50: number;
  donchianHigh20: number;
  donchianLow20: number;
  donchianHigh10: number;
  donchianLow10: number;
  nr4: boolean;
  nr7: boolean;
  coil3: boolean;
  prevConsecBull: number;
  prevConsecBear: number;
  recent3High: number;
  recent3Low: number;
  confirmedBreaks: StructureBreak[];
  confirmedCandles: CandlestickPattern[];
  activeObs: OrderBlock[];
  activeFvgs: FairValueGap[];
  activeSds: SDZone[];
  activeSrs: SRZone[];
  brokenOrRetestSrs: SRZone[];
  activeTrendlines: Trendline[];
  activeChartPatterns: ChartPattern[];
  recentSweeps: LiquidityPool[];
}

function buildBarContext(
  execSnap: AnalysisSnapshot,
  htfSnap: AnalysisSnapshot | null,
  bar: Candle,
  config: BacktestConfig
): BarContext {
  const candles = execSnap.candles;
  const n = candles.length;
  const prevBar = candles[n - 2] ?? bar;
  const atr = Math.max(1e-8, execSnap.atr);
  const tfSec = TIMEFRAME_SECONDS[config.timeframe];
  const precision = getInstrumentMeta(config.symbol).pricePrecision;
  const price = bar.close;

  const barRange = Math.max(1e-8, bar.high - bar.low);
  const barBody = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const isBullBar = bar.close > bar.open;
  const isBearBar = bar.close < bar.open;

  // Volume ratio vs prior 20 bars
  const volStart = Math.max(0, n - 21);
  let volSum = 0;
  let volCount = 0;
  for (let i = volStart; i < n - 1; i++) {
    if (candles[i].volume > 0) {
      volSum += candles[i].volume;
      volCount += 1;
    }
  }
  const avgVol = volCount > 0 ? volSum / volCount : 0;
  const volRatio = avgVol > 0 && bar.volume > 0 ? bar.volume / avgVol : 1.0;

  const ema20 = computeEma(candles, 20);
  const ema20Prev = computeEma(candles.slice(0, -1), 20);
  const ema50 = computeEma(candles, 50);

  // Prior 20-bar / 10-bar Donchian (strictly excluding current bar to detect breakout/fakeout)
  let donchianHigh20 = -Infinity;
  let donchianLow20 = Infinity;
  let donchianHigh10 = -Infinity;
  let donchianLow10 = Infinity;
  const d20Start = Math.max(0, n - 21);
  const d10Start = Math.max(0, n - 11);
  for (let i = d20Start; i < n - 1; i++) {
    if (candles[i].high > donchianHigh20) donchianHigh20 = candles[i].high;
    if (candles[i].low < donchianLow20) donchianLow20 = candles[i].low;
    if (i >= d10Start) {
      if (candles[i].high > donchianHigh10) donchianHigh10 = candles[i].high;
      if (candles[i].low < donchianLow10) donchianLow10 = candles[i].low;
    }
  }

  // NR4 / NR7 on prevBar vs prior 4/7 bars
  const prevRange = prevBar.high - prevBar.low;
  let nr4 = prevRange < atr * 0.8;
  let nr7 = prevRange < atr * 0.75;
  for (let i = Math.max(0, n - 5); i < n - 2; i++) {
    if (candles[i].high - candles[i].low <= prevRange) nr4 = false;
  }
  for (let i = Math.max(0, n - 8); i < n - 2; i++) {
    if (candles[i].high - candles[i].low <= prevRange) nr7 = false;
  }

  // 3-bar compression coil prior to current bar
  const coil3 =
    n >= 5 &&
    candles[n - 2].high - candles[n - 2].low < atr * 0.8 &&
    candles[n - 3].high - candles[n - 3].low < atr * 0.8 &&
    candles[n - 4].high - candles[n - 4].low < atr * 0.8;

  let prevConsecBull = 0;
  let prevConsecBear = 0;
  for (let i = n - 2; i >= Math.max(0, n - 8); i--) {
    if (candles[i].close > candles[i].open) {
      if (prevConsecBear > 0) break;
      prevConsecBull += 1;
    } else if (candles[i].close < candles[i].open) {
      if (prevConsecBull > 0) break;
      prevConsecBear += 1;
    } else {
      break;
    }
  }

  const prev3 = candles.slice(Math.max(0, n - 4), n - 1);
  const recent3High = prev3.length > 0 ? Math.max(...prev3.map((c) => c.high)) : prevBar.high;
  const recent3Low = prev3.length > 0 ? Math.min(...prev3.map((c) => c.low)) : prevBar.low;

  return {
    execSnap,
    htfSnap,
    bar,
    prevBar,
    candles,
    atr,
    tfSec,
    precision,
    price,
    htfTrend: htfSnap?.marketStructure.trend ?? 'consolidation',
    execTrend: execSnap.marketStructure.trend,
    barRange,
    barBody,
    upperWick,
    lowerWick,
    isBullBar,
    isBearBar,
    displacementSigned: (bar.close - bar.open) / atr,
    volRatio,
    ema20,
    ema20Prev,
    ema50,
    donchianHigh20,
    donchianLow20,
    donchianHigh10,
    donchianLow10,
    nr4,
    nr7,
    coil3,
    prevConsecBull,
    prevConsecBear,
    recent3High,
    recent3Low,
    confirmedBreaks: execSnap.marketStructure.breaks.filter(
      (b) => b.confirmationStatus === 'confirmed'
    ),
    confirmedCandles: execSnap.candlestickPatterns.filter(
      (c) => c.confirmationStatus === 'confirmed'
    ),
    activeObs: execSnap.orderBlocks.filter((o) => o.valid),
    activeFvgs: execSnap.fairValueGaps,
    activeSds: execSnap.supplyDemand.filter(
      (z) => z.freshness !== 'invalidated' && z.freshness !== 'fully_mitigated'
    ),
    activeSrs: execSnap.supportResistance.filter(
      (s) => s.status !== 'Invalidated' && s.status !== 'Broken'
    ),
    brokenOrRetestSrs: execSnap.supportResistance.filter(
      (s) => s.status === 'Retesting' || s.status === 'Broken' || s.status === 'Breaking'
    ),
    activeTrendlines: execSnap.trendlines.filter((t) => t.status !== 'invalidated'),
    activeChartPatterns: execSnap.chartPatterns.filter((p) => p.status !== 'Invalidated'),
    recentSweeps: execSnap.liquidityPools.filter((l) => l.swept && l.sweepTime !== null),
  };
}

interface RawTarget {
  price: number;
  sourceLabel: string;
  priority: number;
}

function selectTargetsForDirection(
  direction: SignalDirection,
  entryPrice: number,
  stopLoss: number,
  atr: number,
  minRR: number,
  execSnap: AnalysisSnapshot,
  htfSnap: AnalysisSnapshot | null,
  precision: number,
  extraTarget?: { price: number; label: string } | null
): BacktestTradeTarget[] {
  const isBuy = direction === 'BUY';
  const risk = isBuy ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (!Number.isFinite(risk) || risk <= 0) return [];

  const raw: RawTarget[] = [];

  if (extraTarget && Number.isFinite(extraTarget.price)) {
    if ((isBuy && extraTarget.price > entryPrice) || (!isBuy && extraTarget.price < entryPrice)) {
      raw.push({ price: extraTarget.price, sourceLabel: extraTarget.label, priority: 5 });
    }
  }

  const collect = (snap: AnalysisSnapshot | null, tfTag: string, basePrio: number) => {
    if (!snap) return;
    for (const liq of snap.liquidityPools) {
      if (liq.swept) continue;
      const validSide = isBuy
        ? liq.kind === 'buy_side' ||
          liq.kind === 'equal_highs' ||
          liq.kind === 'pdh' ||
          liq.kind === 'pwh' ||
          liq.kind === 'external'
        : liq.kind === 'sell_side' ||
          liq.kind === 'equal_lows' ||
          liq.kind === 'pdl' ||
          liq.kind === 'pwl' ||
          liq.kind === 'external';
      if (!validSide) continue;
      if ((isBuy && liq.price > entryPrice) || (!isBuy && liq.price < entryPrice)) {
        raw.push({ price: liq.price, sourceLabel: `${tfTag} ${liq.label}`, priority: basePrio + 2 });
      }
    }
    for (const sr of snap.supportResistance) {
      if (sr.status === 'Invalidated' || sr.status === 'Broken') continue;
      if (isBuy && sr.kind === 'resistance' && sr.lower > entryPrice) {
        raw.push({ price: sr.lower, sourceLabel: `${tfTag} ${sr.label}`, priority: basePrio + 1 });
      } else if (!isBuy && sr.kind === 'support' && sr.upper < entryPrice) {
        raw.push({ price: sr.upper, sourceLabel: `${tfTag} ${sr.label}`, priority: basePrio + 1 });
      }
    }
    for (const sd of snap.supplyDemand) {
      if (sd.freshness === 'invalidated' || sd.freshness === 'fully_mitigated') continue;
      if (isBuy && sd.kind === 'supply' && sd.proximal > entryPrice) {
        raw.push({ price: sd.proximal, sourceLabel: `${tfTag} Supply`, priority: basePrio + 1 });
      } else if (!isBuy && sd.kind === 'demand' && sd.proximal < entryPrice) {
        raw.push({ price: sd.proximal, sourceLabel: `${tfTag} Demand`, priority: basePrio + 1 });
      }
    }
    for (const sw of snap.marketStructure.swings) {
      if (sw.confirmationStatus !== 'confirmed') continue;
      if (isBuy && sw.kind === 'high' && sw.price > entryPrice) {
        raw.push({ price: sw.price, sourceLabel: `${tfTag} Swing High`, priority: basePrio });
      } else if (!isBuy && sw.kind === 'low' && sw.price < entryPrice) {
        raw.push({ price: sw.price, sourceLabel: `${tfTag} Swing Low`, priority: basePrio });
      }
    }
    if (snap.dealingRange) {
      if (isBuy && snap.dealingRange.rangeHigh > entryPrice) {
        raw.push({
          price: snap.dealingRange.rangeHigh,
          sourceLabel: `${tfTag} Range High`,
          priority: basePrio + 1,
        });
      } else if (!isBuy && snap.dealingRange.rangeLow < entryPrice) {
        raw.push({
          price: snap.dealingRange.rangeLow,
          sourceLabel: `${tfTag} Range Low`,
          priority: basePrio + 1,
        });
      }
    }
  };

  collect(execSnap, execSnap.timeframe, 1);
  collect(htfSnap, htfSnap?.timeframe ?? 'HTF', 3);

  const minReward = risk * minRR;
  const maxReward = risk * 8.5;
  const filtered = raw
    .filter((t) => {
      const reward = isBuy ? t.price - entryPrice : entryPrice - t.price;
      return reward >= minReward && reward <= maxReward;
    })
    .sort((a, b) => {
      const da = Math.abs(a.price - entryPrice);
      const db = Math.abs(b.price - entryPrice);
      if (Math.abs(da - db) < atr * 0.25) return b.priority - a.priority;
      return da - db;
    });

  const minStep = Math.max(risk * 0.45, atr * 0.5);
  const chosen: RawTarget[] = [];
  for (const cand of filtered) {
    if (chosen.length === 0) {
      chosen.push(cand);
      continue;
    }
    const prev = chosen[chosen.length - 1];
    if (Math.abs(cand.price - prev.price) >= minStep) {
      chosen.push(cand);
    }
    if (chosen.length >= 3) break;
  }

  return chosen.map((c, idx) => {
    const p = roundPrice(c.price, precision);
    const reward = isBuy ? p - entryPrice : entryPrice - p;
    return {
      level: (idx + 1) as 1 | 2 | 3,
      price: p,
      riskReward: Number((reward / risk).toFixed(2)),
      sourceLabel: c.sourceLabel,
      hit: false,
      hitTime: null,
    };
  });
}

function findProtectedInvalidation(
  direction: SignalDirection,
  entryPrice: number,
  atr: number,
  execSnap: AnalysisSnapshot,
  extraAnchor?: number
): number | null {
  const isBuy = direction === 'BUY';
  const candidates: number[] = [];
  if (extraAnchor !== undefined && Number.isFinite(extraAnchor)) {
    if ((isBuy && extraAnchor < entryPrice) || (!isBuy && extraAnchor > entryPrice)) {
      candidates.push(extraAnchor);
    }
  }
  for (const sw of execSnap.marketStructure.swings) {
    if (sw.confirmationStatus !== 'confirmed') continue;
    if (isBuy && sw.kind === 'low' && sw.price < entryPrice) candidates.push(sw.price);
    if (!isBuy && sw.kind === 'high' && sw.price > entryPrice) candidates.push(sw.price);
  }
  const recent = execSnap.candles.slice(-10);
  if (recent.length >= 3) {
    const ext = isBuy
      ? Math.min(...recent.map((c) => c.low))
      : Math.max(...recent.map((c) => c.high));
    if ((isBuy && ext < entryPrice) || (!isBuy && ext > entryPrice)) {
      candidates.push(ext);
    }
  }

  const minDist = atr * 0.4;
  const maxDist = atr * 6.5;
  const valid = candidates
    .filter((lvl) => {
      const d = isBuy ? entryPrice - lvl : lvl - entryPrice;
      return d >= minDist && d <= maxDist;
    })
    .sort((a, b) => Math.abs(entryPrice - a) - Math.abs(entryPrice - b));

  return valid.length > 0 ? valid[0] : null;
}

function buildPlan(
  ctx: BarContext,
  config: BacktestConfig,
  params: {
    strategyId: BacktestStrategyId;
    direction: SignalDirection;
    entryMode: 'market_close' | 'limit_retest';
    entryPrice?: number;
    entryZone?: { lower: number; upper: number };
    invalidationLevel: number | null;
    atrMultiplier?: number;
    minRiskReward?: number;
    confluenceScore: number;
    entryRationale: string[];
    extraTarget?: { price: number; label: string } | null;
  }
): StrategySignalCandidate | null {
  if (params.invalidationLevel === null) return null;
  const isBuy = params.direction === 'BUY';
  const entryPrice = roundPrice(params.entryPrice ?? ctx.price, ctx.precision);
  const invalidationLevel = roundPrice(params.invalidationLevel, ctx.precision);
  const buffer = ctx.atr * (params.atrMultiplier ?? 0.45);
  const stopLoss = roundPrice(
    isBuy ? invalidationLevel - buffer : invalidationLevel + buffer,
    ctx.precision
  );
  const risk = isBuy ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (risk <= 0 || !Number.isFinite(risk)) return null;

  const takeProfits = selectTargetsForDirection(
    params.direction,
    entryPrice,
    stopLoss,
    ctx.atr,
    params.minRiskReward ?? config.minRiskReward,
    ctx.execSnap,
    ctx.htfSnap,
    ctx.precision,
    params.extraTarget
  );
  if (takeProfits.length === 0) return null;

  const z = params.entryZone ?? {
    lower: entryPrice - ctx.atr * 0.15,
    upper: entryPrice + ctx.atr * 0.15,
  };

  return {
    strategyId: params.strategyId,
    direction: params.direction,
    entryMode: params.entryMode,
    entryPrice,
    entryZone: {
      lower: roundPrice(Math.min(z.lower, z.upper), ctx.precision),
      upper: roundPrice(Math.max(z.lower, z.upper), ctx.precision),
    },
    stopLoss,
    invalidationLevel,
    takeProfits,
    confluenceScore: Math.min(100, Math.max(0, Math.round(params.confluenceScore))),
    entryRationale: params.entryRationale,
  };
}

type Direction = 'BUY' | 'SELL';
const DIRS: readonly Direction[] = ['BUY', 'SELL'];

function trendLabel(d: Direction): 'bullish' | 'bearish' {
  return d === 'BUY' ? 'bullish' : 'bearish';
}
function oppTrend(d: Direction): 'bullish' | 'bearish' {
  return d === 'BUY' ? 'bearish' : 'bullish';
}

function evalSingleStrategy(
  id: BacktestStrategyId,
  ctx: BarContext,
  config: BacktestConfig
): StrategySignalCandidate | null {
  const { execSnap, htfSnap, bar, prevBar, atr, tfSec, precision: p, price, htfTrend, execTrend } = ctx;
  const dr = execSnap.dealingRange;
  const anchors = execSnap.sessionAnchors;

  // Helpers scoped to ctx
  const sweepsByKinds = (d: Direction, maxBars: number, kinds?: LiquidityPool['kind'][]) => {
    const defaultKinds: LiquidityPool['kind'][] =
      d === 'BUY'
        ? ['sell_side', 'equal_lows', 'pdl', 'pwl', 'inducement', 'internal', 'external']
        : ['buy_side', 'equal_highs', 'pdh', 'pwh', 'inducement', 'internal', 'external'];
    const allowed = new Set(kinds ?? defaultKinds);
    return ctx.recentSweeps.filter(
      (l) =>
        l.sweepTime !== null &&
        bar.time - l.sweepTime <= tfSec * maxBars &&
        allowed.has(l.kind)
    );
  };

  const breaksByTypes = (
    d: Direction,
    maxBars: number,
    types: StructureBreak['type'][],
    scope?: StructureBreak['scope']
  ) => {
    const tgt = trendLabel(d);
    const tSet = new Set(types);
    return ctx.confirmedBreaks.filter(
      (b) =>
        b.direction === tgt &&
        tSet.has(b.type) &&
        (!scope || b.scope === scope) &&
        bar.time - b.breakTime <= tfSec * maxBars
    );
  };

  const candlesByNames = (d: Direction, maxBars: number, names?: CandlestickPattern['name'][]) => {
    const tgt = trendLabel(d);
    const nameSet = names ? new Set(names) : null;
    return ctx.confirmedCandles.filter(
      (cp) =>
        cp.direction === tgt &&
        bar.time - cp.detectionTime <= tfSec * maxBars &&
        (!nameSet || nameSet.has(cp.name))
    );
  };

  const nearbyObs = (d: Direction, maxAtrDist: number, opts?: { unmitigatedOnly?: boolean; minDisp?: number; kinds?: OrderBlock['kind'][] }) => {
    const isBuy = d === 'BUY';
    return ctx.activeObs
      .filter((ob) => {
        if (opts?.unmitigatedOnly && ob.mitigated) return false;
        if (opts?.minDisp && ob.displacementAtr < opts.minDisp) return false;
        if (opts?.kinds) {
          if (!opts.kinds.includes(ob.kind)) return false;
        } else {
          if (isBuy ? ob.kind !== 'bullish_ob' : ob.kind !== 'bearish_ob') return false;
        }
        return isBuy
          ? ob.upper <= price + atr * 0.35 && price - ob.upper <= atr * maxAtrDist
          : ob.lower >= price - atr * 0.35 && ob.lower - price <= atr * maxAtrDist;
      })
      .sort((a, b) => Math.abs(a.midpoint - price) - Math.abs(b.midpoint - price));
  };

  const nearbyFvgs = (d: Direction, maxAtrDist: number, kinds?: FairValueGap['kind'][], allowFilled = false) => {
    const isBuy = d === 'BUY';
    return ctx.activeFvgs
      .filter((f) => {
        if (!allowFilled && (f.status === 'fully_filled' || f.status === 'inverted')) return false;
        if (kinds && !kinds.includes(f.kind)) return false;
        if (!kinds) {
          if (isBuy ? f.kind !== 'bullish_fvg' : f.kind !== 'bearish_fvg') return false;
        }
        return Math.abs(f.consequentEncroachment - price) <= atr * maxAtrDist;
      })
      .sort((a, b) => Math.abs(a.consequentEncroachment - price) - Math.abs(b.consequentEncroachment - price));
  };

  const nearbySrs = (d: Direction, maxAtrDist: number, opts?: { minStrength?: number; minTouches?: number; minRejections?: number; sources?: SRZone['source'][]; includeBroken?: boolean }) => {
    const isBuy = d === 'BUY';
    const pool = opts?.includeBroken ? [...ctx.activeSrs, ...ctx.brokenOrRetestSrs] : ctx.activeSrs;
    return pool
      .filter((sr) => {
        if (!opts?.includeBroken && sr.kind !== (isBuy ? 'support' : 'resistance')) return false;
        if (opts?.minStrength && sr.strengthScore < opts.minStrength) return false;
        if (opts?.minTouches && sr.touches < opts.minTouches) return false;
        if (opts?.minRejections && sr.rejections < opts.minRejections) return false;
        if (opts?.sources && !opts.sources.includes(sr.source)) return false;
        return price >= sr.lower - atr * maxAtrDist && price <= sr.upper + atr * maxAtrDist;
      })
      .sort((a, b) => b.strengthScore - a.strengthScore);
  };

  const chartPatternsMatching = (
    d: Direction,
    names: ChartPattern['name'][] | null,
    statuses: ChartPattern['status'][] = ['Breakout', 'Retest'],
    maxBars = 8
  ) => {
    const tgt = trendLabel(d);
    const nSet = names ? new Set(names) : null;
    const sSet = new Set(statuses);
    return ctx.activeChartPatterns
      .filter(
        (cp) =>
          cp.direction === tgt &&
          sSet.has(cp.status) &&
          (!nSet || nSet.has(cp.name)) &&
          (cp.breakoutTime === null || bar.time - cp.breakoutTime <= tfSec * maxBars)
      )
      .sort((a, b) => b.qualityScore - a.qualityScore);
  };

  const dirCloseOk = (d: Direction, minBodyAtr = 0.1) =>
    d === 'BUY' ? ctx.displacementSigned >= minBodyAtr : ctx.displacementSigned <= -minBodyAtr;

  // =========================================================================
  // DISPATCH ACROSS ALL 120 INSTITUTIONAL STRATEGIES
  // =========================================================================

  switch (id) {
    // 1. SMC_LIQ_SWEEP_MSS
    case 'SMC_LIQ_SWEEP_MSS': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const sweeps = sweepsByKinds(d, 18, d === 'BUY' ? ['sell_side', 'equal_lows', 'pdl'] : ['buy_side', 'equal_highs', 'pdh']);
        const shifts = breaksByTypes(d, 8, ['MSS', 'CHoCH']);
        if (sweeps.length > 0 && shifts.length > 0) {
          const sw = sweeps[sweeps.length - 1];
          const sh = shifts[shifts.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 74 + (htfTrend === trendLabel(d) ? 14 : 4),
            entryRationale: [`Sweep (${sw.label})`, `Confirmed ${sh.type} @ ${sh.levelPrice.toFixed(p)}`, `HTF: ${htfTrend}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 2. SMC_OB_FVG_CONFLUENCE
    case 'SMC_OB_FVG_CONFLUENCE': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d) && execTrend === oppTrend(d)) continue;
        const obs = nearbyObs(d, 2.5, { unmitigatedOnly: true });
        const fvgs = nearbyFvgs(d, 3.0);
        const hasBos = breaksByTypes(d, 20, ['BOS', 'MSS', 'CHoCH']).length > 0;
        if (obs.length > 0 && (fvgs.length > 0 || hasBos)) {
          const ob = obs[0];
          const limitEntry = price >= ob.lower && price <= ob.upper ? price : d === 'BUY' ? ob.upper : ob.lower;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: limitEntry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 72 + (fvgs.length > 0 ? 12 : 0) + (htfTrend === trendLabel(d) ? 10 : 0),
            entryRationale: [`Unmitigated OB [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`, fvgs.length > 0 ? 'FVG confluence' : 'BOS flow', `HTF: ${htfTrend}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 3. SMC_OTE_RETRACEMENT
    case 'SMC_OTE_RETRACEMENT': {
      if (!dr) return null;
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d) && execTrend !== trendLabel(d)) continue;
        const inZone =
          d === 'BUY'
            ? dr.currentPosition === 'discount' && (dr.inOteZone || dr.retracementPercent >= 55)
            : dr.currentPosition === 'premium' && (dr.inOteZone || dr.retracementPercent >= 55);
        const trigger = candlesByNames(d, 3).length > 0 || breaksByTypes(d, 6, ['BOS', 'CHoCH', 'MSS']).length > 0;
        if (inZone && trigger) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? dr.rangeLow : dr.rangeHigh);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 74 + (dr.inOteZone ? 10 : 4) + (htfTrend === trendLabel(d) ? 8 : 0),
            entryRationale: [`Dealing Range ${dr.currentPosition} (${dr.retracementPercent}%)`, `HTF ${htfTrend} / Exec ${execTrend}`, 'Confirmed OTE trigger'],
            extraTarget: { price: d === 'BUY' ? dr.rangeHigh : dr.rangeLow, label: `Dealing Range ${d === 'BUY' ? 'High' : 'Low'}` },
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 4. SMC_BOS_SD_CONTINUATION
    case 'SMC_BOS_SD_CONTINUATION': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const bos = breaksByTypes(d, 16, ['BOS']);
        const sds = ctx.activeSds.filter(
          (z) => (z.freshness === 'fresh' || z.freshness === 'tested') && z.kind === (d === 'BUY' ? 'demand' : 'supply') && Math.abs(z.proximal - price) <= atr * 2.4
        );
        if (bos.length > 0 && sds.length > 0) {
          const sd = sds[0];
          const lo = Math.min(sd.proximal, sd.distal);
          const hi = Math.max(sd.proximal, sd.distal);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: price >= lo && price <= hi ? price : sd.proximal,
            entryZone: { lower: lo, upper: hi },
            invalidationLevel: sd.distal,
            atrMultiplier: 0.45,
            confluenceScore: 74 + (sd.freshness === 'fresh' ? 10 : 5) + (sd.htfAligned ? 6 : 0),
            entryRationale: [`HTF ${htfTrend} + ${bos.length} BOS`, `${sd.freshness} ${sd.patternType} ${sd.kind}`, `Departure ${sd.departureStrength.toFixed(1)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 5. SMC_EQUAL_HL_SWEEP_REVERSAL
    case 'SMC_EQUAL_HL_SWEEP_REVERSAL': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const eqSweeps = sweepsByKinds(d, 10, d === 'BUY' ? ['equal_lows'] : ['equal_highs']);
        if (eqSweeps.length > 0 && dirCloseOk(d, 0.35)) {
          const sw = eqSweeps[eqSweeps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76 + (htfTrend === trendLabel(d) ? 12 : 0),
            entryRationale: [`Equal ${d === 'BUY' ? 'Lows' : 'Highs'} swept (${sw.label})`, `Displacement close ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 6. SMC_PDH_PDL_SWEEP_MSS
    case 'SMC_PDH_PDL_SWEEP_MSS': {
      for (const d of DIRS) {
        const pdSweeps = sweepsByKinds(d, 20, d === 'BUY' ? ['pdl'] : ['pdh']);
        const shifts = breaksByTypes(d, 10, ['MSS', 'CHoCH']);
        if (pdSweeps.length > 0 && shifts.length > 0) {
          const sw = pdSweeps[pdSweeps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 80,
            entryRationale: [`${d === 'BUY' ? 'PDL' : 'PDH'} liquidity raided @ ${sw.price.toFixed(p)}`, `Confirmed ${shifts[shifts.length - 1].type} reversal`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 7. SMC_PWH_PWL_SWEEP_REVERSAL
    case 'SMC_PWH_PWL_SWEEP_REVERSAL': {
      for (const d of DIRS) {
        const pwSweeps = sweepsByKinds(d, 24, d === 'BUY' ? ['pwl'] : ['pwh']);
        const triggers = candlesByNames(d, 3);
        if (pwSweeps.length > 0 && (triggers.length > 0 || dirCloseOk(d, 0.3))) {
          const sw = pwSweeps[pwSweeps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.55,
            confluenceScore: 82,
            entryRationale: [`Weekly ${d === 'BUY' ? 'PWL' : 'PWH'} liquidity raid`, triggers[0] ? `Confirmed ${triggers[0].name}` : 'Strong reversal displacement'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 8. SMC_INDUCEMENT_SWEEP_BOS
    case 'SMC_INDUCEMENT_SWEEP_BOS': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const ind = sweepsByKinds(d, 16, ['inducement', 'internal']);
        const extBos = breaksByTypes(d, 12, ['BOS', 'MSS'], 'external');
        if (ind.length > 0 && extBos.length > 0) {
          const sw = ind[ind.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 79,
            entryRationale: [`Internal inducement swept (${sw.label})`, `External ${extBos[extBos.length - 1].type} continuation`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 9. SMC_HIGH_DISP_OB_LIMIT
    case 'SMC_HIGH_DISP_OB_LIMIT': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const obs = nearbyObs(d, 2.8, { unmitigatedOnly: true, minDisp: 1.8 });
        if (obs.length > 0) {
          const ob = obs[0];
          const entry = price >= ob.lower && price <= ob.upper ? price : d === 'BUY' ? ob.upper : ob.lower;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.4,
            confluenceScore: 78 + (htfTrend === trendLabel(d) ? 10 : 0),
            entryRationale: [`High-displacement OB (${ob.displacementAtr.toFixed(1)}x ATR)`, `Limit entry @ ${entry.toFixed(p)}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 10. SMC_BREAKER_BLOCK_RETEST
    case 'SMC_BREAKER_BLOCK_RETEST': {
      for (const d of DIRS) {
        const breakers = nearbyObs(d, 2.5, { kinds: ['breaker_block'] });
        const hasShift = breaksByTypes(d, 18, ['MSS', 'CHoCH']).length > 0;
        if (breakers.length > 0 && hasShift) {
          const ob = breakers[0];
          const entry = price >= ob.lower && price <= ob.upper ? price : ob.midpoint;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Institutional Breaker Block [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`, 'Confirmed MSS/CHoCH flip'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 11. SMC_MITIGATION_BLOCK_ENTRY
    case 'SMC_MITIGATION_BLOCK_ENTRY': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d) && execTrend !== trendLabel(d)) continue;
        const mit = nearbyObs(d, 2.5, { kinds: ['mitigation_block'] });
        if (mit.length > 0) {
          const ob = mit[0];
          const entry = price >= ob.lower && price <= ob.upper ? price : ob.midpoint;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 74,
            entryRationale: [`Mitigation Block [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`, `Trend aligned (${execTrend})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 12. SMC_FVG_CE_MIDPOINT_LIMIT
    case 'SMC_FVG_CE_MIDPOINT_LIMIT': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const fvgs = nearbyFvgs(d, 2.5);
        if (fvgs.length > 0) {
          const f = fvgs[0];
          const ce = f.consequentEncroachment;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: ce,
            entryZone: { lower: f.lower, upper: f.upper },
            invalidationLevel: d === 'BUY' ? f.lower : f.upper,
            atrMultiplier: 0.45,
            confluenceScore: 73 + (htfTrend === trendLabel(d) ? 10 : 0),
            entryRationale: [`${f.kind.replace('_', ' ')} 50% CE @ ${ce.toFixed(p)}`, `Fill ${Math.round(f.fillPercent)}%`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 13. SMC_INVERSE_FVG_FLIP
    case 'SMC_INVERSE_FVG_FLIP': {
      for (const d of DIRS) {
        const ifvgs = ctx.activeFvgs.filter(
          (f) =>
            (f.kind === 'inverse_fvg' || f.status === 'inverted') &&
            Math.abs(f.consequentEncroachment - price) <= atr * 2.2
        );
        if (ifvgs.length > 0 && dirCloseOk(d, 0.25)) {
          const f = ifvgs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? f.lower : f.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`Inverted FVG polarity flip @ ${f.consequentEncroachment.toFixed(p)}`, `Close confirmation ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 14. SMC_VOLUME_IMBALANCE_FILL
    case 'SMC_VOLUME_IMBALANCE_FILL': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d) && execTrend !== trendLabel(d)) continue;
        const vis = nearbyFvgs(d, 2.2, ['volume_imbalance']);
        if (vis.length > 0) {
          const vi = vis[0];
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: vi.consequentEncroachment,
            entryZone: { lower: vi.lower, upper: vi.upper },
            invalidationLevel: d === 'BUY' ? vi.lower : vi.upper,
            atrMultiplier: 0.4,
            confluenceScore: 73,
            entryRationale: [`Volume Imbalance gap [${vi.lower.toFixed(p)}–${vi.upper.toFixed(p)}]`, `Trend: ${execTrend}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 15. SMC_REJECTION_BLOCK_ENTRY
    case 'SMC_REJECTION_BLOCK_ENTRY': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const rbs = nearbyFvgs(d, 2.2, ['rejection_block']);
        if (rbs.length > 0 && dirCloseOk(d, 0.15)) {
          const rb = rbs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? rb.lower : rb.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`SMC Rejection Block [${rb.lower.toFixed(p)}–${rb.upper.toFixed(p)}]`, `Strict HTF ${htfTrend} alignment`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 16. SMC_ASIAN_SWEEP_KILLZONE
    case 'SMC_ASIAN_SWEEP_KILLZONE': {
      const asian = execSnap.sessions.filter((s) => s.session === 'Asian');
      if (asian.length === 0) return null;
      const latest = asian[asian.length - 1];
      for (const d of DIRS) {
        const swept = d === 'BUY' ? latest.sweptPrevLow : latest.sweptPrevHigh;
        if (swept && dirCloseOk(d, 0.25)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? latest.lowPrice : latest.highPrice);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 75,
            entryRationale: [`Asian session ${d === 'BUY' ? 'Low' : 'High'} liquidity swept`, `Reversal displacement ${ctx.displacementSigned.toFixed(2)}x ATR`],
            extraTarget: { price: d === 'BUY' ? latest.highPrice : latest.lowPrice, label: 'Asian Opposite Range' },
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 17. SMC_LONDON_NY_SWEEP
    case 'SMC_LONDON_NY_SWEEP': {
      const lny = execSnap.sessions.filter((s) => s.session === 'London' || s.session === 'New York');
      if (lny.length === 0) return null;
      const latest = lny[lny.length - 1];
      for (const d of DIRS) {
        const swept = d === 'BUY' ? latest.sweptPrevLow : latest.sweptPrevHigh;
        const hasShift = breaksByTypes(d, 10, ['MSS', 'CHoCH']).length > 0;
        if (swept && (hasShift || dirCloseOk(d, 0.35))) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? latest.lowPrice : latest.highPrice);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 77,
            entryRationale: [`${latest.session} session ${d === 'BUY' ? 'Low' : 'High'} swept`, hasShift ? 'MSS/CHoCH shift' : 'Directional displacement'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 18. SMC_INTERNAL_CHOCH_SCALP
    case 'SMC_INTERNAL_CHOCH_SCALP': {
      if (!dr) return null;
      for (const d of DIRS) {
        const intChoch = breaksByTypes(d, 6, ['CHoCH', 'MSS'], 'internal');
        const favorable = d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium';
        if (intChoch.length > 0 && favorable) {
          const b = intChoch[intChoch.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.4,
            confluenceScore: 74,
            entryRationale: [`Internal ${b.type} @ ${b.levelPrice.toFixed(p)}`, `Inside ${dr.currentPosition} (${dr.retracementPercent}%)`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 19. SMC_EXTERNAL_BOS_PULLBACK
    case 'SMC_EXTERNAL_BOS_PULLBACK': {
      if (!dr) return null;
      for (const d of DIRS) {
        const extBos = breaksByTypes(d, 14, ['BOS'], 'external');
        const nearEq = d === 'BUY' ? price <= dr.equilibrium + atr * 0.4 : price >= dr.equilibrium - atr * 0.4;
        if (extBos.length > 0 && nearEq && dirCloseOk(d, 0.15)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 76,
            entryRationale: [`External BOS within 14 bars`, `Pullback near 50% equilibrium (${dr.equilibrium.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 20. SMC_DOUBLE_FVG_STACK
    case 'SMC_DOUBLE_FVG_STACK': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const fvgs = nearbyFvgs(d, 3.5);
        if (fvgs.length >= 2) {
          const f = fvgs[0];
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: f.consequentEncroachment,
            entryZone: { lower: f.lower, upper: f.upper },
            invalidationLevel: d === 'BUY' ? fvgs[fvgs.length - 1].lower : fvgs[fvgs.length - 1].upper,
            atrMultiplier: 0.45,
            confluenceScore: 78,
            entryRationale: [`${fvgs.length} stacked ${trendLabel(d)} FVGs within 3.5x ATR`, `Limit @ CE ${f.consequentEncroachment.toFixed(p)}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 21. SMC_HTF_BIAS_DISCOUNT_OB
    case 'SMC_HTF_BIAS_DISCOUNT_OB': {
      if (!dr) return null;
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const quadOk = d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium';
        const obs = nearbyObs(d, 2.5, { unmitigatedOnly: true });
        if (quadOk && obs.length > 0) {
          const ob = obs[0];
          const entry = price >= ob.lower && price <= ob.upper ? price : d === 'BUY' ? ob.upper : ob.lower;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 84,
            entryRationale: [`Strict HTF ${htfTrend}`, `Dealing Range ${dr.currentPosition}`, `Valid OB [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 22. SMC_FRESH_RBR_DBD_ZONE
    case 'SMC_FRESH_RBR_DBD_ZONE': {
      for (const d of DIRS) {
        const pt = d === 'BUY' ? 'RBR' : 'DBD';
        const zones = ctx.activeSds.filter(
          (z) => z.freshness === 'fresh' && z.patternType === pt && z.departureStrength >= 1.5 && Math.abs(z.proximal - price) <= atr * 2.5
        );
        if (zones.length > 0) {
          const z = zones[0];
          const lo = Math.min(z.proximal, z.distal);
          const hi = Math.max(z.proximal, z.distal);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: price >= lo && price <= hi ? price : z.proximal,
            entryZone: { lower: lo, upper: hi },
            invalidationLevel: z.distal,
            atrMultiplier: 0.45,
            confluenceScore: 79,
            entryRationale: [`Fresh ${pt} ${z.kind} zone`, `Departure ${z.departureStrength.toFixed(1)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 23. SMC_FRESH_DBR_RBD_TURN
    case 'SMC_FRESH_DBR_RBD_TURN': {
      for (const d of DIRS) {
        const pt = d === 'BUY' ? 'DBR' : 'RBD';
        const zones = ctx.activeSds.filter(
          (z) => z.freshness === 'fresh' && z.patternType === pt && Math.abs(z.proximal - price) <= atr * 2.5
        );
        if (zones.length > 0) {
          const z = zones[0];
          const lo = Math.min(z.proximal, z.distal);
          const hi = Math.max(z.proximal, z.distal);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: price >= lo && price <= hi ? price : z.proximal,
            entryZone: { lower: lo, upper: hi },
            invalidationLevel: z.distal,
            atrMultiplier: 0.5,
            confluenceScore: 76,
            entryRationale: [`Fresh ${pt} reversal origin [${lo.toFixed(p)}–${hi.toFixed(p)}]`, `Departure ${z.departureStrength.toFixed(1)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 24. SMC_SWEEP_FVG_MARKET
    case 'SMC_SWEEP_FVG_MARKET': {
      for (const d of DIRS) {
        const sweeps = sweepsByKinds(d, 12);
        const fvgs = nearbyFvgs(d, 2.5);
        if (sweeps.length > 0 && fvgs.length > 0 && dirCloseOk(d, 0.25)) {
          const sw = sweeps[sweeps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sw.lower : sw.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 81,
            entryRationale: [`Recent sweep (${sw.label})`, `Fresh FVG displacement @ ${fvgs[0].consequentEncroachment.toFixed(p)}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 25. SMC_DAILY_OPEN_JUDAS_SWING
    case 'SMC_DAILY_OPEN_JUDAS_SWING': {
      const dOpen = anchors.dailyOpen;
      if (dOpen === null) return null;
      for (const d of DIRS) {
        const judasWick =
          d === 'BUY'
            ? (bar.low < dOpen || prevBar.low < dOpen) && price > dOpen && ctx.isBullBar
            : (bar.high > dOpen || prevBar.high > dOpen) && price < dOpen && ctx.isBearBar;
        const hasShift = breaksByTypes(d, 12, ['MSS', 'CHoCH', 'BOS']).length > 0;
        if (judasWick && hasShift) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(bar.low, prevBar.low) : Math.max(bar.high, prevBar.high));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 78,
            entryRationale: [`Judas Swing false break of Daily Open (${dOpen.toFixed(p)})`, 'Confirmed structure shift snapback'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 26. SMC_WEEKLY_OPEN_DISCOUNT_OB
    case 'SMC_WEEKLY_OPEN_DISCOUNT_OB': {
      const wOpen = anchors.weeklyOpen;
      if (wOpen === null) return null;
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const okSide = d === 'BUY' ? price <= wOpen + atr * 0.5 : price >= wOpen - atr * 0.5;
        const obs = nearbyObs(d, 2.5);
        if (okSide && obs.length > 0) {
          const ob = obs[0];
          const entry = price >= ob.lower && price <= ob.upper ? price : ob.midpoint;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: ob.lower, upper: ob.upper },
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Weekly Open (${wOpen.toFixed(p)}) favorable quadrant`, `OB [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 27. SMC_OTE_705_SNIPER
    case 'SMC_OTE_705_SNIPER': {
      if (!dr || !dr.inOteZone) return null;
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d) && execTrend !== trendLabel(d)) continue;
        const correctSide = d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium';
        if (!correctSide) continue;
        const inv = findProtectedInvalidation(d, dr.ote705, atr, execSnap, d === 'BUY' ? dr.rangeLow : dr.rangeHigh);
        const plan = buildPlan(ctx, config, {
          strategyId: id,
          direction: d,
          entryMode: 'limit_retest',
          entryPrice: dr.ote705,
          entryZone: { lower: Math.min(dr.fib62, dr.fib79), upper: Math.max(dr.fib62, dr.fib79) },
          invalidationLevel: inv,
          atrMultiplier: 0.4,
          confluenceScore: 81,
          entryRationale: [`Strict OTE 70.5% pocket (${dr.ote705.toFixed(p)})`, `Retracement ${dr.retracementPercent}% in ${execTrend} trend`],
          extraTarget: { price: d === 'BUY' ? dr.rangeHigh : dr.rangeLow, label: `Range ${d === 'BUY' ? 'High' : 'Low'}` },
        });
        if (plan) return plan;
      }
      return null;
    }

    // 28. SMC_HTF_TREND_DISCOUNT_BOS
    case 'SMC_HTF_TREND_DISCOUNT_BOS': {
      if (!dr) return null;
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const bos = breaksByTypes(d, 10, ['BOS']);
        const discOk = d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium';
        if (bos.length > 0 && discOk) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 83,
            entryRationale: [`HTF ${htfTrend} aligned`, `Confirmed BOS within 10 bars`, `Favorable ${dr.currentPosition} pricing`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 29. SMC_LIQ_POOL_MAGNET_EXPANSION
    case 'SMC_LIQ_POOL_MAGNET_EXPANSION': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const breaks = breaksByTypes(d, 8, ['MSS', 'BOS']);
        if (breaks.length === 0) continue;
        const inv = findProtectedInvalidation(d, price, atr, execSnap);
        const plan = buildPlan(ctx, config, {
          strategyId: id,
          direction: d,
          entryMode: 'market_close',
          invalidationLevel: inv,
          atrMultiplier: 0.45,
          minRiskReward: Math.max(2.0, config.minRiskReward),
          confluenceScore: 80,
          entryRationale: [`Confirmed ${breaks[breaks.length - 1].type} targeting unswept liquidity >= 2.0R`, `HTF context: ${htfTrend}`],
        });
        if (plan) return plan;
      }
      return null;
    }

    // 30. SMC_PARTIAL_MITIGATED_OB
    case 'SMC_PARTIAL_MITIGATED_OB': {
      for (const d of DIRS) {
        const obs = ctx.activeObs.filter(
          (ob) =>
            (d === 'BUY' ? ob.kind === 'bullish_ob' : ob.kind === 'bearish_ob') &&
            ob.mitigationPercent >= 10 &&
            ob.mitigationPercent <= 65 &&
            Math.abs(ob.midpoint - price) <= atr * 1.4
        );
        if (obs.length > 0 && dirCloseOk(d, 0.2)) {
          const ob = obs[0];
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: d === 'BUY' ? ob.lower : ob.upper,
            atrMultiplier: 0.45,
            confluenceScore: 74,
            entryRationale: [`Partially mitigated OB (${Math.round(ob.mitigationPercent)}%) second bounce`, `Rejection close ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // =======================================================================
    // 31–60: PRICE ACTION & CANDLESTICK STRATEGIES
    // =======================================================================

    // 31. PA_SR_REJECTION_CANDLE
    case 'PA_SR_REJECTION_CANDLE': {
      for (const d of DIRS) {
        const revNames: CandlestickPattern['name'][] =
          d === 'BUY'
            ? ['Bullish Engulfing', 'Hammer', 'Morning Star', 'Tweezer Bottom', 'Piercing Pattern', 'Dragonfly Doji']
            : ['Bearish Engulfing', 'Shooting Star', 'Evening Star', 'Tweezer Top', 'Dark Cloud Cover', 'Gravestone Doji'];
        const srs = nearbySrs(d, 1.1, { minStrength: 55 });
        const cps = candlesByNames(d, 3, revNames);
        if (srs.length > 0 && cps.length > 0) {
          const sr = srs[0];
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(cp.lowBound, sr.lower) : Math.max(cp.highBound, sr.upper));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 72 + Math.min(14, Math.round((sr.strengthScore - 50) / 3)),
            entryRationale: [`Rejecting ${sr.label} (str ${sr.strengthScore})`, `Confirmed ${cp.name}`, `HTF: ${htfTrend}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 32. PA_ENGULFING_VOLUME
    case 'PA_ENGULFING_VOLUME': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Bullish Engulfing' : 'Bearish Engulfing';
        const cps = candlesByNames(d, 1, [name]);
        if (cps.length > 0 && ctx.volRatio >= 1.2 && ctx.barBody >= atr * 0.4) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`Confirmed ${name}`, `Volume surge ${ctx.volRatio.toFixed(2)}x avg`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 33. PA_ENGULFING_PULLBACK
    case 'PA_ENGULFING_PULLBACK': {
      for (const d of DIRS) {
        if (execTrend !== trendLabel(d) && htfTrend !== trendLabel(d)) continue;
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Bullish Engulfing' : 'Bearish Engulfing';
        const cps = candlesByNames(d, 1, [name]);
        const hadPullback = ctx.candles.slice(-5, -1).filter((c) => (d === 'BUY' ? c.close < c.open : c.close > c.open)).length >= 2;
        if (cps.length > 0 && hadPullback) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 78,
            entryRationale: [`Trend-pullback ${name}`, `Follows >= 2 pullback bars in ${execTrend} trend`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 34. PA_HAMMER_SHOOTING_STAR
    case 'PA_HAMMER_SHOOTING_STAR': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const names: CandlestickPattern['name'][] =
          d === 'BUY' ? ['Hammer', 'Inverted Hammer'] : ['Shooting Star', 'Hanging Man'];
        const cps = candlesByNames(d, 2, names);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed ${cp.name} wick rejection`, `HTF bias: ${htfTrend}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 35. PA_MORNING_EVENING_STAR
    case 'PA_MORNING_EVENING_STAR': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Morning Star' : 'Evening Star';
        const cps = candlesByNames(d, 2, [name]);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed 3-bar ${name}`, `Pattern boundary [${cp.lowBound.toFixed(p)}–${cp.highBound.toFixed(p)}]`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 36. PA_INSIDE_BAR_BREAKOUT
    case 'PA_INSIDE_BAR_BREAKOUT': {
      for (const d of DIRS) {
        const ibs = ctx.confirmedCandles.filter((cp) => cp.name === 'Inside Bar' && bar.time - cp.detectionTime <= tfSec * 3 && bar.time - cp.detectionTime >= tfSec);
        if (ibs.length === 0) continue;
        const ib = ibs[ibs.length - 1];
        const broke = d === 'BUY' ? bar.close > ib.highBound : bar.close < ib.lowBound;
        if (broke && dirCloseOk(d, 0.3)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? ib.lowBound : ib.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.4,
            confluenceScore: 75,
            entryRationale: [`Inside Bar coil breakout above/below [${ib.lowBound.toFixed(p)}–${ib.highBound.toFixed(p)}]`, `Displacement ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 37. PA_OUTSIDE_BAR_EXPANSION
    case 'PA_OUTSIDE_BAR_EXPANSION': {
      for (const d of DIRS) {
        const obs = candlesByNames(d, 1, ['Outside Bar']);
        if (obs.length > 0 && dirCloseOk(d, 0.35) && ctx.volRatio >= 1.0) {
          const cp = obs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Confirmed Outside Bar range expansion`, `Volume ${ctx.volRatio.toFixed(2)}x avg`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 38. PA_FAKEY_TRAP
    case 'PA_FAKEY_TRAP': {
      const ibs = ctx.confirmedCandles.filter((cp) => cp.name === 'Inside Bar' && bar.time - cp.detectionTime <= tfSec * 4 && bar.time - cp.detectionTime >= tfSec * 2);
      if (ibs.length === 0) return null;
      const ib = ibs[ibs.length - 1];
      for (const d of DIRS) {
        const falseWick = d === 'BUY' ? (prevBar.low < ib.lowBound || bar.low < ib.lowBound) && bar.close > ib.lowBound : (prevBar.high > ib.highBound || bar.high > ib.highBound) && bar.close < ib.highBound;
        if (falseWick && dirCloseOk(d, 0.25)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(bar.low, prevBar.low) : Math.max(bar.high, prevBar.high));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 79,
            entryRationale: [`Fakey trap: Inside Bar false break snapped back`, `Reversal close ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 39. PA_THREE_SOLDIERS_CROWS
    case 'PA_THREE_SOLDIERS_CROWS': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Three White Soldiers' : 'Three Black Crows';
        const cps = candlesByNames(d, 1, [name]);
        if (cps.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed ${name}`, `Sustained 3-bar directional thrust`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 40. PA_MARUBOZU_IMPULSE
    case 'PA_MARUBOZU_IMPULSE': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const cps = candlesByNames(d, 1, ['Marubozu']);
        if (cps.length > 0 && ctx.volRatio >= 1.05) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`Confirmed ${trendLabel(d)} Marubozu impulse`, `Volume ${ctx.volRatio.toFixed(2)}x avg`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 41. PA_TWEEZER_REVERSAL
    case 'PA_TWEEZER_REVERSAL': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Tweezer Bottom' : 'Tweezer Top';
        const cps = candlesByNames(d, 2, [name]);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed ${name} matching extreme pivot`, `Range [${cp.lowBound.toFixed(p)}–${cp.highBound.toFixed(p)}]`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 42. PA_PIERCING_DARK_CLOUD
    case 'PA_PIERCING_DARK_CLOUD': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Piercing Pattern' : 'Dark Cloud Cover';
        const cps = candlesByNames(d, 2, [name]);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed ${name} >50% bar penetration`, 'Counter-attack reversal'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 43. PA_HARAMI_BREAK
    case 'PA_HARAMI_BREAK': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Bullish Harami' : 'Bearish Harami';
        const cps = candlesByNames(d, 3, [name]);
        if (cps.length > 0 && dirCloseOk(d, 0.2)) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 73,
            entryRationale: [`Confirmed ${name} compression`, `Follow-through bar ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 44. PA_DRAGONFLY_GRAVESTONE_DOJI
    case 'PA_DRAGONFLY_GRAVESTONE_DOJI': {
      for (const d of DIRS) {
        const name: CandlestickPattern['name'] = d === 'BUY' ? 'Dragonfly Doji' : 'Gravestone Doji';
        const cps = candlesByNames(d, 2, [name]);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Confirmed ${name} long-tail rejection`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 45. PA_DOJI_CONFIRM_FLIP
    case 'PA_DOJI_CONFIRM_FLIP': {
      const dojis = ctx.confirmedCandles.filter((cp) => cp.name === 'Doji' && bar.time - cp.detectionTime <= tfSec * 2 && bar.time - cp.detectionTime >= tfSec);
      if (dojis.length === 0) return null;
      const doji = dojis[dojis.length - 1];
      for (const d of DIRS) {
        if (dirCloseOk(d, 0.4) && ctx.volRatio >= 1.05) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? doji.lowBound : doji.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 74,
            entryRationale: ['Prior indecision Doji', `Confirmed directional breakout (${ctx.displacementSigned.toFixed(2)}x ATR)`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 46. PA_EMA20_PULLBACK
    case 'PA_EMA20_PULLBACK': {
      for (const d of DIRS) {
        const slopeOk = d === 'BUY' ? ctx.ema20 > ctx.ema20Prev : ctx.ema20 < ctx.ema20Prev;
        const dippedNear = d === 'BUY' ? (bar.low <= ctx.ema20 + atr * 0.25 && bar.close > ctx.ema20) : (bar.high >= ctx.ema20 - atr * 0.25 && bar.close < ctx.ema20);
        if (slopeOk && dippedNear && dirCloseOk(d, 0.25)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`20-EMA (${ctx.ema20.toFixed(p)}) rising/falling slope`, `Dynamic pullback bounce ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 47. PA_EMA20_50_TREND_CROSS
    case 'PA_EMA20_50_TREND_CROSS': {
      for (const d of DIRS) {
        const stacked = d === 'BUY' ? ctx.ema20 > ctx.ema50 : ctx.ema20 < ctx.ema50;
        const pullbackTouch =
          d === 'BUY'
            ? prevBar.low <= ctx.ema20 && bar.close > ctx.ema20 && bar.close > ctx.ema50
            : prevBar.high >= ctx.ema20 && bar.close < ctx.ema20 && bar.close < ctx.ema50;
        if (stacked && pullbackTouch && dirCloseOk(d, 0.2)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, ctx.ema50);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 78,
            entryRationale: [`20/50 EMA stacked (${ctx.ema20.toFixed(p)} / ${ctx.ema50.toFixed(p)})`, 'Ribbon pullback trend resumption'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 48. PA_DONCHIAN_20_BREAKOUT
    case 'PA_DONCHIAN_20_BREAKOUT': {
      for (const d of DIRS) {
        const broke = d === 'BUY' ? bar.close > ctx.donchianHigh20 : bar.close < ctx.donchianLow20;
        if (broke && dirCloseOk(d, 0.45) && ctx.volRatio >= 1.05) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? ctx.donchianLow10 : ctx.donchianHigh10);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 77,
            entryRationale: [`20-Bar Donchian breakout @ ${(d === 'BUY' ? ctx.donchianHigh20 : ctx.donchianLow20).toFixed(p)}`, `Volume ${ctx.volRatio.toFixed(2)}x avg`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 49. PA_DONCHIAN_TURTLE_SOUP
    case 'PA_DONCHIAN_TURTLE_SOUP': {
      for (const d of DIRS) {
        const swept =
          d === 'BUY'
            ? bar.low < ctx.donchianLow20 && bar.close > ctx.donchianLow20 && ctx.lowerWick >= atr * 0.35
            : bar.high > ctx.donchianHigh20 && bar.close < ctx.donchianHigh20 && ctx.upperWick >= atr * 0.35;
        if (swept) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const mid = (ctx.donchianHigh20 + ctx.donchianLow20) / 2;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Turtle Soup false 20-bar breakout @ ${(d === 'BUY' ? ctx.donchianLow20 : ctx.donchianHigh20).toFixed(p)}`, 'Reversal close back inside channel'],
            extraTarget: { price: mid, label: 'Donchian 50% Midline' },
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 50. PA_NR4_VOLATILITY_BREAK
    case 'PA_NR4_VOLATILITY_BREAK': {
      if (!ctx.nr4) return null;
      for (const d of DIRS) {
        const broke = d === 'BUY' ? bar.close > prevBar.high : bar.close < prevBar.low;
        if (broke && dirCloseOk(d, 0.4)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? prevBar.low : prevBar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: ['Prior bar NR4 tightest range of 4 bars', `Breakout close ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 51. PA_NR7_VOLATILITY_BREAK
    case 'PA_NR7_VOLATILITY_BREAK': {
      if (!ctx.nr7) return null;
      for (const d of DIRS) {
        const broke = d === 'BUY' ? bar.close > prevBar.high : bar.close < prevBar.low;
        if (broke && dirCloseOk(d, 0.4) && ctx.volRatio >= 1.05) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? prevBar.low : prevBar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 78,
            entryRationale: ['NR7 deep volatility contraction breakout', `Volume expansion ${ctx.volRatio.toFixed(2)}x`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 52. PA_TWO_BAR_RAIL_REVERSAL
    case 'PA_TWO_BAR_RAIL_REVERSAL': {
      const prevBody = Math.abs(prevBar.close - prevBar.open);
      if (prevBody < atr * 0.55) return null;
      for (const d of DIRS) {
        const match =
          d === 'BUY'
            ? prevBar.close < prevBar.open && ctx.isBullBar && ctx.barBody >= prevBody * 0.8 && bar.close >= prevBar.open
            : prevBar.close > prevBar.open && ctx.isBearBar && ctx.barBody >= prevBody * 0.8 && bar.close <= prevBar.open;
        if (match) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(bar.low, prevBar.low) : Math.max(bar.high, prevBar.high));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: ['Two-Bar Rail-Track opposing engulfing impulse', `Reclaimed >= 80% of prior bar`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 53. PA_EXHAUSTION_5BAR_FADE
    case 'PA_EXHAUSTION_5BAR_FADE': {
      for (const d of DIRS) {
        const exhausted = d === 'BUY' ? ctx.prevConsecBear >= 4 : ctx.prevConsecBull >= 4;
        if (exhausted && dirCloseOk(d, 0.5)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(bar.low, prevBar.low) : Math.max(bar.high, prevBar.high));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 74,
            entryRationale: [`Snapback after ${d === 'BUY' ? ctx.prevConsecBear : ctx.prevConsecBull} consecutive exhaustion bars`, `Strong reversal bar ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 54. PA_HTF_ALIGNED_PINBAR
    case 'PA_HTF_ALIGNED_PINBAR': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const cps = candlesByNames(d, 2, ['Hammer', 'Shooting Star', 'Dragonfly Doji', 'Gravestone Doji']);
        if (cps.length > 0) {
          const cp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? cp.lowBound : cp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 81,
            entryRationale: [`Strict HTF ${htfTrend} trend`, `Confirmed ${cp.name} pullback rejection`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 55. PA_BODY_DOMINANCE_75
    case 'PA_BODY_DOMINANCE_75': {
      if (ctx.barBody / ctx.barRange < 0.75 || ctx.barBody < atr * 1.1) return null;
      for (const d of DIRS) {
        if (execTrend !== trendLabel(d)) continue;
        if ((d === 'BUY' && ctx.isBullBar) || (d === 'SELL' && ctx.isBearBar)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`75%+ body dominance (${Math.round((ctx.barBody / ctx.barRange) * 100)}%)`, `Aligned with ${execTrend} structure`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 56. PA_SWING_HL_LH_BOUNCE
    case 'PA_SWING_HL_LH_BOUNCE': {
      const swings = execSnap.marketStructure.swings.filter((s) => s.confirmationStatus === 'confirmed');
      for (const d of DIRS) {
        if (execTrend !== trendLabel(d)) continue;
        const label = d === 'BUY' ? 'HL' : 'LH';
        const match = swings.filter((s) => s.structureLabel === label).slice(-1)[0];
        if (match && bar.time - match.candleTime <= tfSec * 18 && dirCloseOk(d, 0.25)) {
          const near = d === 'BUY' ? bar.low <= match.price + atr * 1.2 && bar.close > match.price : bar.high >= match.price - atr * 1.2 && bar.close < match.price;
          if (near) {
            const inv = findProtectedInvalidation(d, price, atr, execSnap, match.price);
            const plan = buildPlan(ctx, config, {
              strategyId: id,
              direction: d,
              entryMode: 'market_close',
              invalidationLevel: inv,
              atrMultiplier: 0.45,
              confluenceScore: 77,
              entryRationale: [`Confirmed ${label} pivot @ ${match.price.toFixed(p)}`, `Trend bounce in ${execTrend} structure`],
            });
            if (plan) return plan;
          }
        }
      }
      return null;
    }

    // 57. PA_SWEEP_WICK_SNAPBACK
    case 'PA_SWEEP_WICK_SNAPBACK': {
      for (const d of DIRS) {
        const match =
          d === 'BUY'
            ? bar.low < ctx.recent3Low && bar.close > ctx.recent3Low && ctx.lowerWick / ctx.barRange >= 0.5
            : bar.high > ctx.recent3High && bar.close < ctx.recent3High && ctx.upperWick / ctx.barRange >= 0.5;
        if (match) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`Swept prior 3-bar ${d === 'BUY' ? 'low' : 'high'}`, `>= 50% rejection tail (${Math.round(((d === 'BUY' ? ctx.lowerWick : ctx.upperWick) / ctx.barRange) * 100)}%)`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 58. PA_BACK_TO_BACK_PATTERNS
    case 'PA_BACK_TO_BACK_PATTERNS': {
      for (const d of DIRS) {
        const cps = candlesByNames(d, 4);
        const uniqueNames = new Set(cps.map((c) => c.name));
        if (cps.length >= 2 && uniqueNames.size >= 2 && dirCloseOk(d, 0.15)) {
          const lastCp = cps[cps.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? lastCp.lowBound : lastCp.highBound);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 79,
            entryRationale: [`Cluster of ${cps.length} ${trendLabel(d)} patterns: ${Array.from(uniqueNames).join(' + ')}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 59. PA_VOLUME_CLIMAX_TURN
    case 'PA_VOLUME_CLIMAX_TURN': {
      if (ctx.volRatio < 1.9) return null;
      for (const d of DIRS) {
        const wickOk = d === 'BUY' ? ctx.lowerWick >= atr * 0.4 || ctx.isBullBar : ctx.upperWick >= atr * 0.4 || ctx.isBearBar;
        if (wickOk) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 76,
            entryRationale: [`Volume climax spike (${ctx.volRatio.toFixed(2)}x average)`, 'Exhaustion rejection'],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 60. PA_MULTI_BAR_COMPRESSION_RELEASE
    case 'PA_MULTI_BAR_COMPRESSION_RELEASE': {
      if (!ctx.coil3 || ctx.barRange < atr * 1.05) return null;
      for (const d of DIRS) {
        if (dirCloseOk(d, 0.55)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? ctx.recent3Low : ctx.recent3High);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: ['3-bar tight volatility compression coil released', `Expansion candle ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // =======================================================================
    // 61–87: CHART PATTERNS & TRENDLINES
    // =======================================================================

    // 61. PA_TRENDLINE_PATTERN_BREAK
    case 'PA_TRENDLINE_PATTERN_BREAK': {
      for (const d of DIRS) {
        if (!dirCloseOk(d, 0.25)) continue;
        const tls = ctx.activeTrendlines.filter(
          (t) =>
            (t.status === 'broken' || t.status === 'retested') &&
            t.breakoutTime !== null &&
            bar.time - t.breakoutTime <= tfSec * 5 &&
            (d === 'BUY' ? t.kind === 'bearish_resistance' : t.kind === 'bullish_support')
        );
        const cps = chartPatternsMatching(d, null, ['Confirmed', 'Breakout', 'Retest'], 6);
        if (tls.length > 0 || cps.length > 0) {
          const cp = cps[0] ?? null;
          const tl = tls[0] ?? null;
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp ? cp.invalidationLevel : undefined);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 72 + (cp ? 12 : 6) + (htfTrend === trendLabel(d) ? 8 : 0),
            entryRationale: [cp ? `${cp.name} (${cp.status})` : `Trendline ${tl!.status}`, `Momentum ${ctx.displacementSigned.toFixed(2)}x ATR`],
            extraTarget: cp?.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 62. CP_DOUBLE_TOP_BOTTOM_BREAK
    case 'CP_DOUBLE_TOP_BOTTOM_BREAK': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Double Bottom' : 'Double Top';
        const cps = chartPatternsMatching(d, [patName], ['Breakout', 'Retest'], 8);
        if (cps.length > 0 && dirCloseOk(d, 0.15)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} neckline breakout`, `Quality ${cp.qualityScore}/100`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 63. CP_DOUBLE_TOP_BOTTOM_RETEST
    case 'CP_DOUBLE_TOP_BOTTOM_RETEST': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Double Bottom' : 'Double Top';
        const cps = chartPatternsMatching(d, [patName], ['Retest'], 12);
        if (cps.length > 0 && dirCloseOk(d, 0.1)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(96, cp.qualityScore + 5),
            entryRationale: [`${patName} neckline retest @ ${cp.breakoutLevel.toFixed(p)}`, `Measured target active`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Retest Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 64. CP_TRIPLE_TOP_BOTTOM_BREAK
    case 'CP_TRIPLE_TOP_BOTTOM_BREAK': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Triple Bottom' : 'Triple Top';
        const cps = chartPatternsMatching(d, [patName], ['Breakout', 'Retest'], 10);
        if (cps.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} neckline ${cp.status}`, `Quality ${cp.qualityScore}/100`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 65. CP_HEAD_SHOULDERS_BREAK
    case 'CP_HEAD_SHOULDERS_BREAK': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Inverse Head and Shoulders' : 'Head and Shoulders';
        const cps = chartPatternsMatching(d, [patName], ['Breakout', 'Retest'], 8);
        if (cps.length > 0 && dirCloseOk(d, 0.15)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} neckline break @ ${cp.breakoutLevel.toFixed(p)}`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 66. CP_HEAD_SHOULDERS_RETEST
    case 'CP_HEAD_SHOULDERS_RETEST': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Inverse Head and Shoulders' : 'Head and Shoulders';
        const cps = chartPatternsMatching(d, [patName], ['Retest'], 12);
        if (cps.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(96, cp.qualityScore + 4),
            entryRationale: [`${patName} neckline retest confirmation`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 67. CP_ASCENDING_TRIANGLE_BREAK
    case 'CP_ASCENDING_TRIANGLE_BREAK': {
      const cps = chartPatternsMatching('BUY', ['Ascending Triangle'], ['Breakout', 'Retest'], 8);
      if (cps.length === 0 || !dirCloseOk('BUY', 0.15)) return null;
      const cp = cps[0];
      const inv = findProtectedInvalidation('BUY', price, atr, execSnap, cp.invalidationLevel);
      return buildPlan(ctx, config, {
        strategyId: id,
        direction: 'BUY',
        entryMode: 'market_close',
        invalidationLevel: inv,
        atrMultiplier: 0.45,
        confluenceScore: cp.qualityScore,
        entryRationale: [`Ascending Triangle upward breakout @ ${cp.breakoutLevel.toFixed(p)}`],
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Ascending Triangle Target' } : null,
      });
    }

    // 68. CP_DESCENDING_TRIANGLE_BREAK
    case 'CP_DESCENDING_TRIANGLE_BREAK': {
      const cps = chartPatternsMatching('SELL', ['Descending Triangle'], ['Breakout', 'Retest'], 8);
      if (cps.length === 0 || !dirCloseOk('SELL', 0.15)) return null;
      const cp = cps[0];
      const inv = findProtectedInvalidation('SELL', price, atr, execSnap, cp.invalidationLevel);
      return buildPlan(ctx, config, {
        strategyId: id,
        direction: 'SELL',
        entryMode: 'market_close',
        invalidationLevel: inv,
        atrMultiplier: 0.45,
        confluenceScore: cp.qualityScore,
        entryRationale: [`Descending Triangle breakdown @ ${cp.breakoutLevel.toFixed(p)}`],
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Descending Triangle Target' } : null,
      });
    }

    // 69. CP_SYMMETRICAL_TRIANGLE_BREAK
    case 'CP_SYMMETRICAL_TRIANGLE_BREAK': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, ['Symmetrical Triangle'], ['Breakout', 'Retest'], 8);
        if (cps.length > 0 && dirCloseOk(d, 0.25)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Symmetrical Triangle ${trendLabel(d)} apex breakout`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Triangle Measured Target' } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 70. CP_RISING_WEDGE_BREAKDOWN
    case 'CP_RISING_WEDGE_BREAKDOWN': {
      const cps = chartPatternsMatching('SELL', ['Rising Wedge'], ['Breakout', 'Retest'], 8);
      if (cps.length === 0) return null;
      const cp = cps[0];
      const inv = findProtectedInvalidation('SELL', price, atr, execSnap, cp.invalidationLevel);
      return buildPlan(ctx, config, {
        strategyId: id,
        direction: 'SELL',
        entryMode: 'market_close',
        invalidationLevel: inv,
        atrMultiplier: 0.5,
        confluenceScore: cp.qualityScore,
        entryRationale: [`Rising Wedge bearish breakdown @ ${cp.breakoutLevel.toFixed(p)}`],
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Rising Wedge Target' } : null,
      });
    }

    // 71. CP_FALLING_WEDGE_BREAKOUT
    case 'CP_FALLING_WEDGE_BREAKOUT': {
      const cps = chartPatternsMatching('BUY', ['Falling Wedge'], ['Breakout', 'Retest'], 8);
      if (cps.length === 0) return null;
      const cp = cps[0];
      const inv = findProtectedInvalidation('BUY', price, atr, execSnap, cp.invalidationLevel);
      return buildPlan(ctx, config, {
        strategyId: id,
        direction: 'BUY',
        entryMode: 'market_close',
        invalidationLevel: inv,
        atrMultiplier: 0.5,
        confluenceScore: cp.qualityScore,
        entryRationale: [`Falling Wedge bullish breakout @ ${cp.breakoutLevel.toFixed(p)}`],
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Falling Wedge Target' } : null,
      });
    }

    // 72. CP_FLAG_BREAKOUT
    case 'CP_FLAG_BREAKOUT': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Bullish Flag' : 'Bearish Flag';
        const cps = chartPatternsMatching(d, [patName], ['Breakout'], 6);
        if (cps.length > 0 && dirCloseOk(d, 0.15)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} continuation breakout @ ${cp.breakoutLevel.toFixed(p)}`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 73. CP_FLAG_RETEST
    case 'CP_FLAG_RETEST': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Bullish Flag' : 'Bearish Flag';
        const cps = chartPatternsMatching(d, [patName], ['Retest'], 10);
        if (cps.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(95, cp.qualityScore + 4),
            entryRationale: [`${patName} breakout retest entry`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 74. CP_PENNANT_BREAKOUT
    case 'CP_PENNANT_BREAKOUT': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Bullish Pennant' : 'Bearish Pennant';
        const cps = chartPatternsMatching(d, [patName], ['Breakout', 'Retest'], 8);
        if (cps.length > 0 && dirCloseOk(d, 0.2)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} continuation breakout`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 75. CP_RECTANGLE_BREAKOUT
    case 'CP_RECTANGLE_BREAKOUT': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, ['Rectangle'], ['Breakout', 'Retest'], 8);
        if (cps.length > 0 && dirCloseOk(d, 0.25)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Rectangle box ${trendLabel(d)} breakout @ ${cp.breakoutLevel.toFixed(p)}`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Rectangle Target' } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 76. CP_CUP_HANDLE_BREAKOUT
    case 'CP_CUP_HANDLE_BREAKOUT': {
      const cps = chartPatternsMatching('BUY', ['Cup and Handle'], ['Confirmed', 'Breakout', 'Retest'], 10);
      if (cps.length === 0 || !dirCloseOk('BUY', 0.15)) return null;
      const cp = cps[0];
      const inv = findProtectedInvalidation('BUY', price, atr, execSnap, cp.invalidationLevel);
      return buildPlan(ctx, config, {
        strategyId: id,
        direction: 'BUY',
        entryMode: 'market_close',
        invalidationLevel: inv,
        atrMultiplier: 0.45,
        confluenceScore: cp.qualityScore,
        entryRationale: [`Cup and Handle (${cp.status}) @ ${cp.breakoutLevel.toFixed(p)}`],
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Cup & Handle Target' } : null,
      });
    }

    // 77. CP_ROUNDING_REVERSAL
    case 'CP_ROUNDING_REVERSAL': {
      for (const d of DIRS) {
        const patName: ChartPattern['name'] = d === 'BUY' ? 'Rounding Bottom' : 'Rounding Top';
        const cps = chartPatternsMatching(d, [patName], ['Breakout', 'Retest', 'Confirmed'], 10);
        if (cps.length > 0 && dirCloseOk(d, 0.15)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: cp.qualityScore,
            entryRationale: [`${patName} (${cp.status}) turnaround`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${patName} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 78. CP_HIGH_SCORE_PATTERN_78
    case 'CP_HIGH_SCORE_PATTERN_78': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, null, ['Breakout', 'Retest'], 8).filter((c) => c.qualityScore >= 78);
        if (cps.length > 0 && dirCloseOk(d, 0.15)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: cp.qualityScore,
            entryRationale: [`Ultra-high quality ${cp.name} (Score ${cp.qualityScore}/100)`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 79. CP_HTF_ALIGNED_PATTERN
    case 'CP_HTF_ALIGNED_PATTERN': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const cps = chartPatternsMatching(d, null, ['Breakout', 'Retest'], 8);
        if (cps.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(98, cp.qualityScore + 8),
            entryRationale: [`${cp.name} strictly aligned with HTF ${htfTrend}`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 80. CP_VOLUME_CONFIRMED_PATTERN
    case 'CP_VOLUME_CONFIRMED_PATTERN': {
      if (ctx.volRatio < 1.25) return null;
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, null, ['Breakout'], 6);
        if (cps.length > 0 && dirCloseOk(d, 0.2)) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(97, cp.qualityScore + 6),
            entryRationale: [`${cp.name} breakout confirmed by ${ctx.volRatio.toFixed(2)}x volume surge`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 81. CP_FORMING_BOUNDARY_TURN
    case 'CP_FORMING_BOUNDARY_TURN': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, null, ['Confirmed'], 20).filter((c) => c.qualityScore >= 70);
        const triggers = candlesByNames(d, 2);
        if (cps.length > 0 && triggers.length > 0) {
          const cp = cps[0];
          if (Math.abs(price - cp.invalidationLevel) <= atr * 1.5) {
            const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
            const plan = buildPlan(ctx, config, {
              strategyId: id,
              direction: d,
              entryMode: 'market_close',
              invalidationLevel: inv,
              atrMultiplier: 0.45,
              confluenceScore: cp.qualityScore,
              entryRationale: [`${cp.name} boundary defense with ${triggers[0].name}`],
              extraTarget: { price: cp.breakoutLevel, label: `${cp.name} Neckline` },
            });
            if (plan) return plan;
          }
        }
      }
      return null;
    }

    // 82. CP_TRENDLINE_3TOUCH_BOUNCE
    case 'CP_TRENDLINE_3TOUCH_BOUNCE': {
      for (const d of DIRS) {
        const tls = ctx.activeTrendlines.filter(
          (t) =>
            t.status === 'confirmed' &&
            t.touches >= 3 &&
            (d === 'BUY' ? t.kind === 'bullish_support' : t.kind === 'bearish_resistance') &&
            Math.abs(price - t.currentProjectedPrice) <= atr * 0.75
        );
        if (tls.length > 0 && dirCloseOk(d, 0.2)) {
          const tl = tls[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, tl.currentProjectedPrice);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 78,
            entryRationale: [`${tl.touches}-touch ${tl.kind.replace('_', ' ')} trendline bounce`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 83. CP_TRENDLINE_BREAK_CLOSE
    case 'CP_TRENDLINE_BREAK_CLOSE': {
      for (const d of DIRS) {
        const tls = ctx.activeTrendlines.filter(
          (t) =>
            t.status === 'broken' &&
            t.breakoutTime !== null &&
            bar.time - t.breakoutTime <= tfSec * 4 &&
            (d === 'BUY' ? t.kind === 'bearish_resistance' : t.kind === 'bullish_support')
        );
        if (tls.length > 0 && dirCloseOk(d, 0.35)) {
          const tl = tls[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Broken ${tl.kind.replace('_', ' ')} (${tl.touches} touches)`, `Displacement ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 84. CP_TRENDLINE_RETEST_FLIP
    case 'CP_TRENDLINE_RETEST_FLIP': {
      for (const d of DIRS) {
        const tls = ctx.activeTrendlines.filter(
          (t) =>
            t.status === 'retested' &&
            t.retestTime !== null &&
            bar.time - t.retestTime <= tfSec * 6 &&
            (d === 'BUY' ? t.kind === 'bearish_resistance' : t.kind === 'bullish_support')
        );
        if (tls.length > 0 && dirCloseOk(d, 0.15)) {
          const tl = tls[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, tl.currentProjectedPrice);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 80,
            entryRationale: [`Broken ${tl.kind.replace('_', ' ')} retest flip @ ${tl.currentProjectedPrice.toFixed(p)}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 85. CP_CHANNEL_MEAN_REVERSION
    case 'CP_CHANNEL_MEAN_REVERSION': {
      const channels = ctx.activeTrendlines.filter(
        (t) =>
          (t.kind === 'ascending_channel' || t.kind === 'descending_channel' || t.kind === 'parallel_channel') &&
          t.channelOffset !== undefined
      );
      for (const ch of channels) {
        const upper = Math.max(ch.currentProjectedPrice, ch.currentProjectedPrice + (ch.channelOffset ?? 0));
        const lower = Math.min(ch.currentProjectedPrice, ch.currentProjectedPrice + (ch.channelOffset ?? 0));
        if (Math.abs(price - lower) <= atr * 0.7 && dirCloseOk('BUY', 0.15)) {
          const inv = findProtectedInvalidation('BUY', price, atr, execSnap, lower);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: 'BUY',
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`Lower ${ch.kind.replace('_', ' ')} rail bounce`],
            extraTarget: { price: upper, label: 'Upper Channel Rail' },
          });
          if (plan) return plan;
        }
        if (Math.abs(price - upper) <= atr * 0.7 && dirCloseOk('SELL', 0.15)) {
          const inv = findProtectedInvalidation('SELL', price, atr, execSnap, upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: 'SELL',
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 75,
            entryRationale: [`Upper ${ch.kind.replace('_', ' ')} rail rejection`],
            extraTarget: { price: lower, label: 'Lower Channel Rail' },
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 86. CP_CHANNEL_BREAKOUT
    case 'CP_CHANNEL_BREAKOUT': {
      const channels = ctx.activeTrendlines.filter(
        (t) =>
          (t.kind === 'ascending_channel' || t.kind === 'descending_channel' || t.kind === 'parallel_channel') &&
          (t.status === 'broken' || t.status === 'retested') &&
          t.breakoutTime !== null &&
          bar.time - t.breakoutTime <= tfSec * 5
      );
      if (channels.length === 0) return null;
      for (const d of DIRS) {
        if (dirCloseOk(d, 0.35) && ctx.volRatio >= 1.0) {
          const ch = channels[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`${ch.kind.replace('_', ' ')} breakout`, `Displacement ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 87. CP_PATTERN_WITH_CANDLE
    case 'CP_PATTERN_WITH_CANDLE': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, null, ['Confirmed', 'Breakout', 'Retest'], 8);
        const candles = candlesByNames(d, 3);
        if (cps.length > 0 && candles.length > 0) {
          const cp = cps[0];
          const pat = candles[candles.length - 1];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(97, cp.qualityScore + 8),
            entryRationale: [`${cp.name} (${cp.status})`, `Confirmed by ${pat.name}`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // =======================================================================
    // 88–111: SUPPORT & RESISTANCE (S/R) STRATEGIES
    // =======================================================================

    // 88. SR_MAJOR_CLUSTER_70
    case 'SR_MAJOR_CLUSTER_70': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { minStrength: 70 });
        if (srs.length > 0 && dirCloseOk(d, 0.2)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: sr.strengthScore,
            entryRationale: [`Major ${sr.label} cluster (Strength ${sr.strengthScore}/100)`, `Directional bounce ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 89. SR_MULTI_TOUCH_3PLUS
    case 'SR_MULTI_TOUCH_3PLUS': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { minTouches: 3 });
        if (srs.length > 0 && dirCloseOk(d, 0.2)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: Math.min(94, 70 + sr.touches * 4),
            entryRationale: [`${sr.touches}-touch fortified ${sr.label} (${sr.kind})`, `Held on close`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 90. SR_BREAKOUT_RETEST_FLIP
    case 'SR_BREAKOUT_RETEST_FLIP': {
      for (const d of DIRS) {
        const flipped = ctx.brokenOrRetestSrs.filter(
          (sr) =>
            sr.status === 'Retesting' &&
            (d === 'BUY' ? sr.kind === 'resistance' : sr.kind === 'support') &&
            price >= sr.lower - atr * 0.9 &&
            price <= sr.upper + atr * 0.9
        );
        if (flipped.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = flipped[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 79,
            entryRationale: [`S/R Polarity Flip Retest: ${sr.label} turned ${d === 'BUY' ? 'Support' : 'Resistance'}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 91. SR_IMPULSE_BREAKOUT
    case 'SR_IMPULSE_BREAKOUT': {
      for (const d of DIRS) {
        const breaking = ctx.brokenOrRetestSrs.filter(
          (sr) =>
            (sr.status === 'Breaking' || sr.status === 'Broken') &&
            (d === 'BUY' ? sr.kind === 'resistance' && price > sr.upper : sr.kind === 'support' && price < sr.lower) &&
            Math.abs(price - sr.midpoint) <= atr * 2.2
        );
        if (breaking.length > 0 && dirCloseOk(d, 0.55) && ctx.volRatio >= 1.15) {
          const sr = breaking[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 77,
            entryRationale: [`High-momentum breakout through ${sr.label}`, `Body ${ctx.displacementSigned.toFixed(2)}x ATR · Vol ${ctx.volRatio.toFixed(2)}x`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 92. SR_PDH_PDL_REJECTION
    case 'SR_PDH_PDL_REJECTION': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { sources: ['pdh_pdl'] });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`${sr.label} (${sr.midpoint.toFixed(p)}) rejection`, `Daily Open reference active`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 93. SR_PDH_PDL_BREAK_CONTINUATION
    case 'SR_PDH_PDL_BREAK_CONTINUATION': {
      const { prevDayHigh, prevDayLow } = anchors;
      if (prevDayHigh === null || prevDayLow === null) return null;
      for (const d of DIRS) {
        const crossed =
          d === 'BUY'
            ? prevBar.close <= prevDayHigh && bar.close > prevDayHigh
            : prevBar.close >= prevDayLow && bar.close < prevDayLow;
        if (crossed && dirCloseOk(d, 0.35)) {
          const level = d === 'BUY' ? prevDayHigh : prevDayLow;
          const inv = findProtectedInvalidation(d, price, atr, execSnap, level);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 78,
            entryRationale: [`Clean close breakout beyond ${d === 'BUY' ? 'PDH' : 'PDL'} (${level.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 94. SR_PWH_PWL_DEFENSE
    case 'SR_PWH_PWL_DEFENSE': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.2, { sources: ['pwh_pwl'] });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 80,
            entryRationale: [`Weekly ${sr.label} defense (${sr.midpoint.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 95. SR_PMH_PML_MACRO_REACTION
    case 'SR_PMH_PML_MACRO_REACTION': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.4, { sources: ['pmh_pml'] });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.55,
            confluenceScore: 82,
            entryRationale: [`Macro Monthly ${sr.label} reaction (${sr.midpoint.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 96. SR_DAILY_FLOOR_PIVOT
    case 'SR_DAILY_FLOOR_PIVOT': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { sources: ['pivot'] });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 73,
            entryRationale: [`Floor ${sr.label} (${sr.midpoint.toFixed(p)}) mean-reversion bounce`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 97. SR_SESSION_HL_DEFENSE
    case 'SR_SESSION_HL_DEFENSE': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { sources: ['session_hl'] });
        if (srs.length > 0 && dirCloseOk(d, 0.2)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 74,
            entryRationale: [`Session ${sr.label} S/R defense (${sr.midpoint.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 98. SR_SWING_CLUSTER_SUPPORT
    case 'SR_SWING_CLUSTER_SUPPORT': {
      if (htfTrend === 'bearish') return null;
      const srs = nearbySrs('BUY', 1.0, { sources: ['swing_cluster'] });
      if (srs.length > 0 && ctx.isBullBar && price > srs[0].midpoint) {
        const sr = srs[0];
        const inv = findProtectedInvalidation('BUY', price, atr, execSnap, sr.lower);
        return buildPlan(ctx, config, {
          strategyId: id,
          direction: 'BUY',
          entryMode: 'market_close',
          invalidationLevel: inv,
          atrMultiplier: 0.45,
          confluenceScore: 74,
          entryRationale: [`Swing-cluster Support hold @ ${sr.midpoint.toFixed(p)} (${sr.touches} touches)`],
        });
      }
      return null;
    }

    // 99. SR_SWING_CLUSTER_RESISTANCE
    case 'SR_SWING_CLUSTER_RESISTANCE': {
      if (htfTrend === 'bullish') return null;
      const srs = nearbySrs('SELL', 1.0, { sources: ['swing_cluster'] });
      if (srs.length > 0 && ctx.isBearBar && price < srs[0].midpoint) {
        const sr = srs[0];
        const inv = findProtectedInvalidation('SELL', price, atr, execSnap, sr.upper);
        return buildPlan(ctx, config, {
          strategyId: id,
          direction: 'SELL',
          entryMode: 'market_close',
          invalidationLevel: inv,
          atrMultiplier: 0.45,
          confluenceScore: 74,
          entryRationale: [`Swing-cluster Resistance rejection @ ${sr.midpoint.toFixed(p)} (${sr.touches} touches)`],
        });
      }
      return null;
    }

    // 100. SR_HTF_ALIGNED_BOUNCE
    case 'SR_HTF_ALIGNED_BOUNCE': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const srs = nearbySrs(d, 1.0);
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 81,
            entryRationale: [`Strict HTF ${htfTrend} aligned S/R pullback (${sr.label})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 101. SR_WICK_ABSORPTION
    case 'SR_WICK_ABSORPTION': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 0.5);
        if (srs.length === 0) continue;
        const sr = srs[0];
        const absorbed =
          d === 'BUY'
            ? bar.low <= sr.upper && bar.close > sr.upper && ctx.lowerWick / ctx.barRange >= 0.4
            : bar.high >= sr.lower && bar.close < sr.lower && ctx.upperWick / ctx.barRange >= 0.4;
        if (absorbed) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(bar.low, sr.lower) : Math.max(bar.high, sr.upper));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`S/R Wick absorption at ${sr.label} (${sr.midpoint.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 102. SR_LIMIT_MIDPOINT_PASSIVE
    case 'SR_LIMIT_MIDPOINT_PASSIVE': {
      for (const d of DIRS) {
        if (htfTrend === oppTrend(d)) continue;
        const srs = nearbySrs(d, 2.4, { minStrength: 60 });
        if (srs.length > 0) {
          const sr = srs[0];
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: sr.midpoint,
            entryZone: { lower: sr.lower, upper: sr.upper },
            invalidationLevel: d === 'BUY' ? sr.lower : sr.upper,
            atrMultiplier: 0.45,
            confluenceScore: 73,
            entryRationale: [`Passive limit at ${sr.label} midpoint (${sr.midpoint.toFixed(p)})`, `Strength ${sr.strengthScore}/100`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 103. SR_RANGE_BOUND_FADE
    case 'SR_RANGE_BOUND_FADE': {
      if (execTrend !== 'consolidation') return null;
      for (const d of DIRS) {
        const srs = nearbySrs(d, 0.9, { minStrength: 50 });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 74,
            entryRationale: [`Consolidation regime S/R fade off ${sr.label}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 104. SR_EQUILIBRIUM_OVERLAP
    case 'SR_EQUILIBRIUM_OVERLAP': {
      if (!dr) return null;
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0).filter((sr) => Math.abs(sr.midpoint - dr.equilibrium) <= atr * 0.6);
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 77,
            entryRationale: [`${sr.label} overlaps 50% Equilibrium (${dr.equilibrium.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 105. SR_HIGH_VOLUME_HOLD
    case 'SR_HIGH_VOLUME_HOLD': {
      if (ctx.volRatio < 1.3) return null;
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0);
        if (srs.length > 0 && dirCloseOk(d, 0.2)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 79,
            entryRationale: [`High-volume (${ctx.volRatio.toFixed(2)}x) defense at ${sr.label}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 106. SR_VERIFIED_REJECTION_HOLD
    case 'SR_VERIFIED_REJECTION_HOLD': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0, { minRejections: 2 });
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 78,
            entryRationale: [`${sr.label} (${sr.rejections} verified rejections)`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 107. SR_MTF_HTF_CONFLUENCE
    case 'SR_MTF_HTF_CONFLUENCE': {
      if (!htfSnap) return null;
      for (const d of DIRS) {
        const execSrs = nearbySrs(d, 1.1);
        const htfSrs = htfSnap.supportResistance.filter(
          (hs) => hs.status !== 'Invalidated' && hs.kind === (d === 'BUY' ? 'support' : 'resistance')
        );
        const overlap = execSrs.find((es) => htfSrs.some((hs) => Math.abs(es.midpoint - hs.midpoint) <= atr * 0.8));
        if (overlap && dirCloseOk(d, 0.15)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? overlap.lower : overlap.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 84,
            entryRationale: [`MTF Nested S/R: Exec ${overlap.label} overlaps ${config.htfTimeframe} S/R`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 108. SR_FALSE_BREAK_SNAPBACK
    case 'SR_FALSE_BREAK_SNAPBACK': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 0.8);
        if (srs.length === 0) continue;
        const sr = srs[0];
        const snapback =
          d === 'BUY'
            ? bar.low < sr.lower && bar.close > sr.midpoint && ctx.displacementSigned >= 0.35
            : bar.high > sr.upper && bar.close < sr.midpoint && ctx.displacementSigned <= -0.35;
        if (snapback) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? bar.low : bar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 80,
            entryRationale: [`False breakout trap of ${sr.label} (${sr.midpoint.toFixed(p)})`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 109. SR_TRENDLINE_CONFLUENCE
    case 'SR_TRENDLINE_CONFLUENCE': {
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0);
        const tls = ctx.activeTrendlines.filter((t) => t.status === 'confirmed');
        const matchSr = srs.find((sr) => tls.some((tl) => Math.abs(sr.midpoint - tl.currentProjectedPrice) <= atr * 0.9));
        if (matchSr && dirCloseOk(d, 0.2)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? matchSr.lower : matchSr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 81,
            entryRationale: [`Horizontal ${matchSr.label} + diagonal Trendline vertex bounce`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 110. SR_COMPRESSION_BREAKOUT
    case 'SR_COMPRESSION_BREAKOUT': {
      const tightPrev = prevBar.high - prevBar.low < atr * 0.85;
      if (!tightPrev) return null;
      for (const d of DIRS) {
        const breaking = ctx.brokenOrRetestSrs.filter(
          (sr) =>
            (sr.status === 'Breaking' || sr.status === 'Broken') &&
            (d === 'BUY' ? sr.kind === 'resistance' && price > sr.upper : sr.kind === 'support' && price < sr.lower)
        );
        if (breaking.length > 0 && dirCloseOk(d, 0.7)) {
          const sr = breaking[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? prevBar.low : prevBar.high);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Tight coil breakout through ${sr.label}`, `Impulse ${ctx.displacementSigned.toFixed(2)}x ATR`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 111. SR_DAILY_OPEN_ANCHOR_SR
    case 'SR_DAILY_OPEN_ANCHOR_SR': {
      const dOpen = anchors.dailyOpen;
      if (dOpen === null) return null;
      for (const d of DIRS) {
        const srs = nearbySrs(d, 1.0).filter((sr) => Math.abs(sr.midpoint - dOpen) <= atr * 0.9);
        if (srs.length > 0 && dirCloseOk(d, 0.15)) {
          const sr = srs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? sr.lower : sr.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 76,
            entryRationale: [`Daily Open (${dOpen.toFixed(p)}) + ${sr.label} dual anchor bounce`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // =======================================================================
    // 112–120: HYBRID CONFLUENCE STRATEGIES
    // =======================================================================

    // 112. SMC_INSTITUTIONAL_CONSENSUS
    case 'SMC_INSTITUTIONAL_CONSENSUS': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const brk = breaksByTypes(d, 12, ['MSS', 'CHoCH', 'BOS'])[0];
        if (!brk) continue;
        let pillars = 2;
        const reasons = [`Strict HTF ${htfTrend}`, `Confirmed ${brk.type} @ ${brk.levelPrice.toFixed(p)}`];
        if (sweepsByKinds(d, 24).length > 0) {
          pillars += 1;
          reasons.push('Prior liquidity sweep');
        }
        if (nearbyObs(d, 1.5).length > 0 || nearbyFvgs(d, 1.5).length > 0) {
          pillars += 1;
          reasons.push('Active OB/FVG zone confluence');
        }
        if (dr && (d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium')) {
          pillars += 1;
          reasons.push(`Favorable ${dr.currentPosition} (${dr.retracementPercent}%)`);
        }
        if (pillars >= 4) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            minRiskReward: Math.max(1.8, config.minRiskReward),
            confluenceScore: Math.min(98, 65 + pillars * 7),
            entryRationale: reasons,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 113. HYBRID_SWEEP_SR_CANDLE
    case 'HYBRID_SWEEP_SR_CANDLE': {
      for (const d of DIRS) {
        const sw = sweepsByKinds(d, 14)[0];
        const sr = nearbySrs(d, 1.1, { minStrength: 55 })[0];
        const cp = candlesByNames(d, 3)[0];
        if (sw && sr && cp) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(sw.lower, sr.lower) : Math.max(sw.upper, sr.upper));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 86,
            entryRationale: [`Sweep (${sw.label})`, `${sr.label} (Str ${sr.strengthScore})`, `Confirmed ${cp.name}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 114. HYBRID_OB_SR_LIMIT
    case 'HYBRID_OB_SR_LIMIT': {
      for (const d of DIRS) {
        const obs = nearbyObs(d, 2.5, { unmitigatedOnly: true });
        const srs = nearbySrs(d, 2.5);
        const matchOb = obs.find((ob) => srs.some((sr) => Math.abs(ob.midpoint - sr.midpoint) <= atr * 0.8));
        if (matchOb) {
          const entry = price >= matchOb.lower && price <= matchOb.upper ? price : d === 'BUY' ? matchOb.upper : matchOb.lower;
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: entry,
            entryZone: { lower: matchOb.lower, upper: matchOb.upper },
            invalidationLevel: d === 'BUY' ? matchOb.lower : matchOb.upper,
            atrMultiplier: 0.45,
            confluenceScore: 83,
            entryRationale: [`OB [${matchOb.lower.toFixed(p)}–${matchOb.upper.toFixed(p)}] overlaps Major S/R cluster`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 115. HYBRID_FVG_SD_LIMIT
    case 'HYBRID_FVG_SD_LIMIT': {
      for (const d of DIRS) {
        const fvgs = nearbyFvgs(d, 2.5);
        const sds = ctx.activeSds.filter((z) => z.kind === (d === 'BUY' ? 'demand' : 'supply') && Math.abs(z.proximal - price) <= atr * 2.5);
        const matchSd = sds.find((sd) => fvgs.some((f) => Math.abs(f.consequentEncroachment - sd.midpoint) <= atr * 0.9));
        if (matchSd) {
          const lo = Math.min(matchSd.proximal, matchSd.distal);
          const hi = Math.max(matchSd.proximal, matchSd.distal);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'limit_retest',
            entryPrice: price >= lo && price <= hi ? price : matchSd.proximal,
            entryZone: { lower: lo, upper: hi },
            invalidationLevel: matchSd.distal,
            atrMultiplier: 0.45,
            confluenceScore: 82,
            entryRationale: [`${matchSd.patternType} ${matchSd.kind} paired with unfilled FVG overlap`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 116. HYBRID_HTF_OB_ENGULF
    case 'HYBRID_HTF_OB_ENGULF': {
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const obs = nearbyObs(d, 1.2);
        const eng = candlesByNames(d, 2, [d === 'BUY' ? 'Bullish Engulfing' : 'Bearish Engulfing']);
        if (obs.length > 0 && eng.length > 0) {
          const ob = obs[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? ob.lower : ob.upper);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 87,
            entryRationale: [`HTF ${htfTrend}`, `Active OB [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`, `Confirmed ${eng[0].name}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 117. HYBRID_PATTERN_OB_ORIGIN
    case 'HYBRID_PATTERN_OB_ORIGIN': {
      for (const d of DIRS) {
        const cps = chartPatternsMatching(d, null, ['Breakout', 'Retest'], 8);
        const obs = nearbyObs(d, 3.5);
        if (cps.length > 0 && obs.length > 0) {
          const cp = cps[0];
          const inv = findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 84,
            entryRationale: [`${cp.name} breakout backed by aligned OB origin`],
            extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 118. HYBRID_TRENDLINE_FVG_SNAP
    case 'HYBRID_TRENDLINE_FVG_SNAP': {
      for (const d of DIRS) {
        const tls = ctx.activeTrendlines.filter(
          (t) =>
            (t.status === 'broken' || t.status === 'retested') &&
            t.breakoutTime !== null &&
            bar.time - t.breakoutTime <= tfSec * 6 &&
            (d === 'BUY' ? t.kind === 'bearish_resistance' : t.kind === 'bullish_support')
        );
        const fvgs = nearbyFvgs(d, 2.5);
        if (tls.length > 0 && fvgs.length > 0 && dirCloseOk(d, 0.2)) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 81,
            entryRationale: [`Trendline ${tls[0].status} leaving unfilled FVG displacement`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 119. HYBRID_OTE_SR_PINBAR
    case 'HYBRID_OTE_SR_PINBAR': {
      if (!dr || !dr.inOteZone) return null;
      for (const d of DIRS) {
        const quadOk = d === 'BUY' ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium';
        const sr = nearbySrs(d, 1.2)[0];
        const cp = candlesByNames(d, 3, ['Hammer', 'Shooting Star', 'Dragonfly Doji', 'Gravestone Doji'])[0];
        if (quadOk && sr && cp) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap, d === 'BUY' ? Math.min(sr.lower, cp.lowBound) : Math.max(sr.upper, cp.highBound));
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.45,
            confluenceScore: 88,
            entryRationale: [`OTE ${dr.retracementPercent}% pocket`, `Overlapping ${sr.label}`, `Confirmed ${cp.name}`],
            extraTarget: { price: d === 'BUY' ? dr.rangeHigh : dr.rangeLow, label: 'Dealing Range Extreme' },
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    // 120. HYBRID_QUADRUPLE_TRIFECTA
    case 'HYBRID_QUADRUPLE_TRIFECTA': {
      if (ctx.volRatio < 1.2) return null;
      for (const d of DIRS) {
        if (htfTrend !== trendLabel(d)) continue;
        const brk = breaksByTypes(d, 10, ['BOS', 'MSS', 'CHoCH'])[0];
        const cp = candlesByNames(d, 2)[0];
        if (brk && cp) {
          const inv = findProtectedInvalidation(d, price, atr, execSnap);
          const plan = buildPlan(ctx, config, {
            strategyId: id,
            direction: d,
            entryMode: 'market_close',
            invalidationLevel: inv,
            atrMultiplier: 0.5,
            confluenceScore: 89,
            entryRationale: [`HTF ${htfTrend}`, `${brk.type} break`, `Volume ${ctx.volRatio.toFixed(2)}x`, `Confirmed ${cp.name}`],
          });
          if (plan) return plan;
        }
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Evaluates all selected SMC, Price Action, Chart Pattern, S/R, and Hybrid strategies
 * on a single closed bar using strictly causal analysis slices.
 */
export function evaluateStrategiesOnBar(
  enabledIds: Set<BacktestStrategyId>,
  execSnap: AnalysisSnapshot,
  htfSnap: AnalysisSnapshot | null,
  bar: Candle,
  config: BacktestConfig
): StrategySignalCandidate[] {
  const candidates: StrategySignalCandidate[] = [];
  if (!Number.isFinite(execSnap.atr) || execSnap.atr <= 0 || execSnap.candles.length < 40) {
    return candidates;
  }

  const ctx = buildBarContext(execSnap, htfSnap, bar, config);
  for (const id of enabledIds) {
    if (id.startsWith('CMB_')) continue;
    const plan = evalSingleStrategy(id, ctx, config);
    if (plan) candidates.push(plan);
  }

  const comboPlans = evaluateComboStrategiesOnBar<StrategySignalCandidate>(enabledIds, {
    ctx,
    config,
    findProtectedInvalidation,
    buildPlan,
  });
  for (const plan of comboPlans) {
    candidates.push(plan);
  }

  return candidates;
}
