import type {
  BacktestStrategyCategory,
  BacktestStrategyId,
  BacktestStrategyResult,
} from '../shared/types/index.ts';

export interface AlignedStrategySeries {
  strategy: BacktestStrategyResult;
  returns: Float64Array;
  normalized: Float64Array;
  hasVariance: boolean;
}

export interface PositionOverlapMetrics {
  sameDirOverlapPct: number;
  oppDirOverlapPct: number;
  totalTimeOverlapPct: number;
  concurrentTradeRatio: number;
}

export interface StrategyCorrelationPeer {
  strategy: BacktestStrategyResult;
  correlation: number;
  overlap: PositionOverlapMetrics;
}

export interface CorrelationBucket {
  bucket: string;
  rangeLabel: string;
  count: number;
  profitableCount: number;
  tone: 'hedge' | 'uncorrelated' | 'low' | 'moderate' | 'high' | 'duplicate';
}

export interface AnchorCorrelationReport {
  anchor: BacktestStrategyResult;
  activeCount: number;
  redundantPeers: StrategyCorrelationPeer[];
  diversifierPeers: StrategyCorrelationPeer[];
  allPeerCorrelations: Map<BacktestStrategyId, number>;
  highOverlapCount: number;
  uncorrelatedCount: number;
  inverseHedgeCount: number;
  distributionBuckets: CorrelationBucket[];
}

export interface CorrelationMatrixCell {
  rowId: BacktestStrategyId;
  colId: BacktestStrategyId;
  correlation: number;
  sameDirOverlapPct: number;
  oppDirOverlapPct: number;
}

export interface CorrelationMatrixData {
  strategies: BacktestStrategyResult[];
  cells: CorrelationMatrixCell[][];
  avgPairwiseCorrelation: number;
  avgSameDirOverlapPct: number;
}

export interface BlendedPortfolioPoint {
  time: number;
  anchorReturnPct: number;
  peerReturnPct: number;
  blendedReturnPct: number;
}

export interface BlendedPortfolioSummary {
  anchor: BacktestStrategyResult;
  peer: BacktestStrategyResult;
  correlation: number;
  overlap: PositionOverlapMetrics;
  anchorReturnPct: number;
  peerReturnPct: number;
  blendedReturnPct: number;
  anchorMaxDdPct: number;
  peerMaxDdPct: number;
  avgStandaloneMaxDdPct: number;
  blendedMaxDdPct: number;
  drawdownReductionPctPoints: number;
  drawdownReductionRelativePct: number;
  series: BlendedPortfolioPoint[];
}

function buildUnifiedTimeGrid(
  strategies: BacktestStrategyResult[],
  maxPoints = 72
): number[] {
  const timeSet = new Set<number>();
  for (const s of strategies) {
    for (const pt of s.equityCurve) {
      timeSet.add(pt.time);
    }
  }
  const sorted = Array.from(timeSet).sort((a, b) => a - b);
  if (sorted.length <= maxPoints) return sorted;

  const step = (sorted.length - 1) / (maxPoints - 1);
  const grid: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(sorted.length - 1, Math.round(i * step));
    if (grid.length === 0 || grid[grid.length - 1] !== sorted[idx]) {
      grid.push(sorted[idx]);
    }
  }
  return grid;
}

function interpolateEquityAtGrid(
  curve: BacktestStrategyResult['equityCurve'],
  grid: number[],
  fallbackEquity: number
): Float64Array {
  const out = new Float64Array(grid.length);
  if (curve.length === 0) {
    out.fill(fallbackEquity);
    return out;
  }

  let cIdx = 0;
  for (let gIdx = 0; gIdx < grid.length; gIdx++) {
    const t = grid[gIdx];
    while (cIdx + 1 < curve.length && curve[cIdx + 1].time <= t) {
      cIdx += 1;
    }
    if (t <= curve[0].time) {
      out[gIdx] = curve[0].equity;
    } else if (cIdx >= curve.length - 1) {
      out[gIdx] = curve[curve.length - 1].equity;
    } else {
      const p0 = curve[cIdx];
      const p1 = curve[cIdx + 1];
      const dt = p1.time - p0.time;
      if (dt <= 0) {
        out[gIdx] = p1.equity;
      } else {
        const ratio = (t - p0.time) / dt;
        out[gIdx] = p0.equity + (p1.equity - p0.equity) * ratio;
      }
    }
  }
  return out;
}

export function alignActiveStrategySeries(
  strategies: BacktestStrategyResult[],
  initialCapital: number
): { grid: number[]; seriesList: AlignedStrategySeries[]; byId: Map<BacktestStrategyId, AlignedStrategySeries> } {
  const active = strategies.filter(
    (s) => s.metrics.totalTrades > 0 && s.equityCurve.length >= 3
  );
  const grid = buildUnifiedTimeGrid(active, 72);
  const retLen = Math.max(0, grid.length - 1);
  const seriesList: AlignedStrategySeries[] = [];
  const byId = new Map<BacktestStrategyId, AlignedStrategySeries>();

  for (const s of active) {
    const eq = interpolateEquityAtGrid(s.equityCurve, grid, initialCapital);
    const returns = new Float64Array(retLen);
    let sum = 0;
    for (let i = 0; i < retLen; i++) {
      const prev = eq[i] > 1 ? eq[i] : initialCapital;
      const r = (eq[i + 1] - eq[i]) / prev;
      returns[i] = r;
      sum += r;
    }
    const mean = retLen > 0 ? sum / retLen : 0;
    const normalized = new Float64Array(retLen);
    let sqSum = 0;
    for (let i = 0; i < retLen; i++) {
      const diff = returns[i] - mean;
      normalized[i] = diff;
      sqSum += diff * diff;
    }
    const norm = Math.sqrt(sqSum);
    const hasVariance = norm > 1e-10;
    if (hasVariance) {
      for (let i = 0; i < retLen; i++) {
        normalized[i] /= norm;
      }
    }

    const item: AlignedStrategySeries = {
      strategy: s,
      returns,
      normalized,
      hasVariance,
    };
    seriesList.push(item);
    byId.set(s.strategy.id, item);
  }

  return { grid, seriesList, byId };
}

export function dotCorrelation(a: AlignedStrategySeries, b: AlignedStrategySeries): number {
  if (!a.hasVariance || !b.hasVariance) return 0;
  if (a.strategy.strategy.id === b.strategy.strategy.id) return 1;
  let dot = 0;
  const n = Math.min(a.normalized.length, b.normalized.length);
  for (let i = 0; i < n; i++) {
    dot += a.normalized[i] * b.normalized[i];
  }
  const clamped = Math.max(-1, Math.min(1, dot));
  return Math.round(clamped * 1000) / 1000;
}

interface Interval {
  start: number;
  end: number;
  dir: 'BUY' | 'SELL';
}

function getSortedIntervals(s: BacktestStrategyResult): Interval[] {
  if (s.trades.length === 0) return [];
  const intervals: Interval[] = [];
  for (const t of s.trades) {
    const start = t.entryTime;
    const end = Math.max(t.entryTime + 1, t.exitTime);
    intervals.push({ start, end, dir: t.direction });
  }
  intervals.sort((x, y) => x.start - y.start);
  return intervals;
}

function sumIntervalDuration(intervals: Interval[]): number {
  let total = 0;
  for (const iv of intervals) {
    total += iv.end - iv.start;
  }
  return total;
}

export function computePositionOverlap(
  a: BacktestStrategyResult,
  b: BacktestStrategyResult
): PositionOverlapMetrics {
  if (a.strategy.id === b.strategy.id) {
    return {
      sameDirOverlapPct: 100,
      oppDirOverlapPct: 0,
      totalTimeOverlapPct: 100,
      concurrentTradeRatio: 100,
    };
  }
  const ivA = getSortedIntervals(a);
  const ivB = getSortedIntervals(b);
  if (ivA.length === 0 || ivB.length === 0) {
    return {
      sameDirOverlapPct: 0,
      oppDirOverlapPct: 0,
      totalTimeOverlapPct: 0,
      concurrentTradeRatio: 0,
    };
  }

  let i = 0;
  let j = 0;
  let sameSec = 0;
  let oppSec = 0;
  const overlappingTradesA = new Set<number>();

  while (i < ivA.length && j < ivB.length) {
    const x = ivA[i];
    const y = ivB[j];
    const lo = Math.max(x.start, y.start);
    const hi = Math.min(x.end, y.end);
    if (hi > lo) {
      const sec = hi - lo;
      if (x.dir === y.dir) {
        sameSec += sec;
        overlappingTradesA.add(i);
      } else {
        oppSec += sec;
      }
    }
    if (x.end <= y.end) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const durA = sumIntervalDuration(ivA);
  const durB = sumIntervalDuration(ivB);
  const totalOverlapSec = sameSec + oppSec;
  const unionSec = Math.max(1, durA + durB - totalOverlapSec);

  return {
    sameDirOverlapPct: Math.round((sameSec / unionSec) * 1000) / 10,
    oppDirOverlapPct: Math.round((oppSec / unionSec) * 1000) / 10,
    totalTimeOverlapPct: Math.round((totalOverlapSec / unionSec) * 1000) / 10,
    concurrentTradeRatio: Math.round((overlappingTradesA.size / ivA.length) * 1000) / 10,
  };
}

export function analyzeAnchorCorrelations(
  anchorId: BacktestStrategyId,
  strategies: BacktestStrategyResult[],
  initialCapital: number
): AnchorCorrelationReport | null {
  const { seriesList, byId } = alignActiveStrategySeries(strategies, initialCapital);
  if (seriesList.length === 0) return null;

  const anchorSeries = byId.get(anchorId) ?? seriesList[0];
  const anchor = anchorSeries.strategy;

  const allPeerCorrelations = new Map<BacktestStrategyId, number>();
  const scoredPeers: Array<{ strategy: BacktestStrategyResult; correlation: number }> = [];

  let highOverlapCount = 0;
  let uncorrelatedCount = 0;
  let inverseHedgeCount = 0;

  const bucketDefs: Array<{
    bucket: string;
    rangeLabel: string;
    min: number;
    max: number;
    tone: CorrelationBucket['tone'];
  }> = [
    { bucket: '≤ -0.25', rangeLabel: 'Inverse Hedge (r ≤ -0.25)', min: -1.01, max: -0.25, tone: 'hedge' },
    { bucket: '-0.25..0.15', rangeLabel: 'Uncorrelated (-0.25 to 0.15)', min: -0.25, max: 0.15, tone: 'uncorrelated' },
    { bucket: '0.15..0.45', rangeLabel: 'Low Corr (0.15 to 0.45)', min: 0.15, max: 0.45, tone: 'low' },
    { bucket: '0.45..0.70', rangeLabel: 'Moderate (0.45 to 0.70)', min: 0.45, max: 0.70, tone: 'moderate' },
    { bucket: '0.70..0.85', rangeLabel: 'High Overlap (0.70 to 0.85)', min: 0.70, max: 0.85, tone: 'high' },
    { bucket: '≥ 0.85', rangeLabel: 'Near Duplicate (r ≥ 0.85)', min: 0.85, max: 1.01, tone: 'duplicate' },
  ];
  const bucketCounts = bucketDefs.map(() => ({ count: 0, profitableCount: 0 }));

  for (const item of seriesList) {
    if (item.strategy.strategy.id === anchor.strategy.id) continue;
    const r = dotCorrelation(anchorSeries, item);
    allPeerCorrelations.set(item.strategy.strategy.id, r);
    scoredPeers.push({ strategy: item.strategy, correlation: r });

    if (r >= 0.75) highOverlapCount += 1;
    if (r > -0.25 && r <= 0.25) uncorrelatedCount += 1;
    if (r <= -0.25) inverseHedgeCount += 1;

    for (let b = 0; b < bucketDefs.length; b++) {
      const bd = bucketDefs[b];
      const inLast = b === bucketDefs.length - 1;
      if (r >= bd.min && (inLast ? r <= bd.max : r < bd.max)) {
        bucketCounts[b].count += 1;
        if (item.strategy.metrics.netProfit > 0) {
          bucketCounts[b].profitableCount += 1;
        }
        break;
      }
    }
  }

  const redundantSorted = [...scoredPeers]
    .sort((a, b) => b.correlation - a.correlation || b.strategy.metrics.netProfit - a.strategy.metrics.netProfit)
    .slice(0, 12);

  const diversifierPool = scoredPeers.filter((p) => p.strategy.metrics.netProfit > 0);
  const diversifierSource = diversifierPool.length >= 6 ? diversifierPool : scoredPeers;
  const diversifierSorted = [...diversifierSource]
    .sort((a, b) => a.correlation - b.correlation || b.strategy.metrics.compositeScore - a.strategy.metrics.compositeScore)
    .slice(0, 12);

  const redundantPeers: StrategyCorrelationPeer[] = redundantSorted.map((p) => ({
    strategy: p.strategy,
    correlation: p.correlation,
    overlap: computePositionOverlap(anchor, p.strategy),
  }));

  const diversifierPeers: StrategyCorrelationPeer[] = diversifierSorted.map((p) => ({
    strategy: p.strategy,
    correlation: p.correlation,
    overlap: computePositionOverlap(anchor, p.strategy),
  }));

  const distributionBuckets: CorrelationBucket[] = bucketDefs.map((bd, i) => ({
    bucket: bd.bucket,
    rangeLabel: bd.rangeLabel,
    count: bucketCounts[i].count,
    profitableCount: bucketCounts[i].profitableCount,
    tone: bd.tone,
  }));

  return {
    anchor,
    activeCount: seriesList.length,
    redundantPeers,
    diversifierPeers,
    allPeerCorrelations,
    highOverlapCount,
    uncorrelatedCount,
    inverseHedgeCount,
    distributionBuckets,
  };
}

export type MatrixPreset = 'top12' | 'category_leaders' | 'uncorrelated_basket';

export function selectMatrixStrategies(
  preset: MatrixPreset,
  strategies: BacktestStrategyResult[],
  initialCapital: number,
  maxSize = 12
): BacktestStrategyResult[] {
  const { seriesList } = alignActiveStrategySeries(strategies, initialCapital);
  if (seriesList.length === 0) return [];

  if (preset === 'top12') {
    return seriesList.slice(0, maxSize).map((s) => s.strategy);
  }

  if (preset === 'category_leaders') {
    const categories: BacktestStrategyCategory[] = [
      'SMC',
      'Price Action',
      'Chart Patterns',
      'Support & Resistance',
      'Hybrid SMC/PA',
    ];
    const picked: BacktestStrategyResult[] = [];
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      for (const cat of categories) {
        const match = seriesList.find(
          (s) => s.strategy.strategy.category === cat && !seen.has(s.strategy.strategy.id)
        );
        if (match) {
          seen.add(match.strategy.strategy.id);
          picked.push(match.strategy);
          if (picked.length >= maxSize) return picked;
        }
      }
    }
    return picked;
  }

  // Greedy Uncorrelated Profitable Basket: maximize score while enforcing max |r| < 0.45 against chosen basket
  const profitable = seriesList.filter((s) => s.strategy.metrics.netProfit > 0);
  const candidates = profitable.length >= 6 ? profitable : seriesList;
  const chosen: AlignedStrategySeries[] = [candidates[0]];

  for (const threshold of [0.35, 0.5, 0.65, 0.85]) {
    if (chosen.length >= maxSize) break;
    for (const cand of candidates) {
      if (chosen.some((c) => c.strategy.strategy.id === cand.strategy.strategy.id)) continue;
      const maxPairCorr = Math.max(
        ...chosen.map((c) => dotCorrelation(c, cand))
      );
      if (maxPairCorr <= threshold) {
        chosen.push(cand);
        if (chosen.length >= maxSize) break;
      }
    }
  }

  return chosen.map((c) => c.strategy);
}

export function buildCorrelationMatrix(
  selectedStrategies: BacktestStrategyResult[],
  initialCapital: number
): CorrelationMatrixData {
  const { seriesList, byId } = alignActiveStrategySeries(selectedStrategies, initialCapital);
  const ordered = selectedStrategies.filter((s) => byId.has(s.strategy.id));
  const n = ordered.length;
  const cells: CorrelationMatrixCell[][] = [];

  let pairSum = 0;
  let overlapSum = 0;
  let pairCount = 0;

  for (let i = 0; i < n; i++) {
    const row: CorrelationMatrixCell[] = [];
    const sA = byId.get(ordered[i].strategy.id) ?? seriesList[i];
    for (let j = 0; j < n; j++) {
      const sB = byId.get(ordered[j].strategy.id) ?? seriesList[j];
      if (i === j) {
        row.push({
          rowId: ordered[i].strategy.id,
          colId: ordered[j].strategy.id,
          correlation: 1,
          sameDirOverlapPct: 100,
          oppDirOverlapPct: 0,
        });
      } else {
        const r = dotCorrelation(sA, sB);
        const ov = computePositionOverlap(ordered[i], ordered[j]);
        row.push({
          rowId: ordered[i].strategy.id,
          colId: ordered[j].strategy.id,
          correlation: r,
          sameDirOverlapPct: ov.sameDirOverlapPct,
          oppDirOverlapPct: ov.oppDirOverlapPct,
        });
        if (j > i) {
          pairSum += r;
          overlapSum += ov.sameDirOverlapPct;
          pairCount += 1;
        }
      }
    }
    cells.push(row);
  }

  return {
    strategies: ordered,
    cells,
    avgPairwiseCorrelation:
      pairCount > 0 ? Math.round((pairSum / pairCount) * 1000) / 1000 : 0,
    avgSameDirOverlapPct:
      pairCount > 0 ? Math.round((overlapSum / pairCount) * 10) / 10 : 0,
  };
}

export function simulateBlendedPortfolio(
  anchor: BacktestStrategyResult,
  peer: BacktestStrategyResult,
  initialCapital: number
): BlendedPortfolioSummary {
  const { grid, byId } = alignActiveStrategySeries([anchor, peer], initialCapital);
  const sA = byId.get(anchor.strategy.id);
  const sB = byId.get(peer.strategy.id);

  const correlation = sA && sB ? dotCorrelation(sA, sB) : 0;
  const overlap = computePositionOverlap(anchor, peer);

  const eqA = interpolateEquityAtGrid(anchor.equityCurve, grid, initialCapital);
  const eqB = interpolateEquityAtGrid(peer.equityCurve, grid, initialCapital);

  let blendedEq = initialCapital;
  let peakBlended = initialCapital;
  let blendedMaxDdPct = 0;
  let peakA = initialCapital;
  let maxDdA = 0;
  let peakB = initialCapital;
  let maxDdB = 0;

  const series: BlendedPortfolioPoint[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (i > 0) {
      const rA = eqA[i - 1] > 1 ? (eqA[i] - eqA[i - 1]) / eqA[i - 1] : 0;
      const rB = eqB[i - 1] > 1 ? (eqB[i] - eqB[i - 1]) / eqB[i - 1] : 0;
      blendedEq = Math.max(0, blendedEq * (1 + 0.5 * (rA + rB)));
    }
    peakBlended = Math.max(peakBlended, blendedEq);
    const ddBlend = peakBlended > 0 ? ((peakBlended - blendedEq) / peakBlended) * 100 : 0;
    blendedMaxDdPct = Math.max(blendedMaxDdPct, ddBlend);

    peakA = Math.max(peakA, eqA[i]);
    maxDdA = Math.max(maxDdA, peakA > 0 ? ((peakA - eqA[i]) / peakA) * 100 : 0);

    peakB = Math.max(peakB, eqB[i]);
    maxDdB = Math.max(maxDdB, peakB > 0 ? ((peakB - eqB[i]) / peakB) * 100 : 0);

    series.push({
      time: grid[i],
      anchorReturnPct: Math.round(((eqA[i] - initialCapital) / initialCapital) * 10000) / 100,
      peerReturnPct: Math.round(((eqB[i] - initialCapital) / initialCapital) * 10000) / 100,
      blendedReturnPct: Math.round(((blendedEq - initialCapital) / initialCapital) * 10000) / 100,
    });
  }

  // Use authoritative simulator maxDrawdownPercent for standalone strategies & aligned reduction delta
  const standAvgDd = (anchor.metrics.maxDrawdownPercent + peer.metrics.maxDrawdownPercent) / 2;
  const alignedAvgDd = (maxDdA + maxDdB) / 2;
  const effectiveStandAvg = alignedAvgDd > 0 ? alignedAvgDd : standAvgDd;
  const ddReductionPp = Math.round((effectiveStandAvg - blendedMaxDdPct) * 100) / 100;
  const ddReductionRel =
    effectiveStandAvg > 0
      ? Math.round(((effectiveStandAvg - blendedMaxDdPct) / effectiveStandAvg) * 1000) / 10
      : 0;

  const lastPt = series[series.length - 1];

  return {
    anchor,
    peer,
    correlation,
    overlap,
    anchorReturnPct: anchor.metrics.netReturnPercent,
    peerReturnPct: peer.metrics.netReturnPercent,
    blendedReturnPct: lastPt ? lastPt.blendedReturnPct : 0,
    anchorMaxDdPct: anchor.metrics.maxDrawdownPercent,
    peerMaxDdPct: peer.metrics.maxDrawdownPercent,
    avgStandaloneMaxDdPct: Math.round(effectiveStandAvg * 100) / 100,
    blendedMaxDdPct: Math.round(blendedMaxDdPct * 100) / 100,
    drawdownReductionPctPoints: ddReductionPp,
    drawdownReductionRelativePct: ddReductionRel,
    series,
  };
}
