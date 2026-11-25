import { HTF_TIMEFRAMES, LTF_TIMEFRAMES, TIMEFRAMES } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  InstrumentSymbol,
  MultiTimeframeSummary,
  Timeframe,
  TimeframeAnalysisSummary,
} from '../../shared/types/index.ts';

function computeMomentum(snapshot: AnalysisSnapshot): TimeframeAnalysisSummary['momentum'] {
  const candles = snapshot.candles;
  if (candles.length < 10) return 'neutral';
  const last = candles[candles.length - 1];
  const prev5 = candles[Math.max(0, candles.length - 6)];
  const moveAtr = (last.close - prev5.open) / Math.max(1e-8, snapshot.atr);

  if (moveAtr >= 1.5) return 'strong_bullish';
  if (moveAtr >= 0.4) return 'bullish';
  if (moveAtr <= -1.5) return 'strong_bearish';
  if (moveAtr <= -0.4) return 'bearish';
  return 'neutral';
}

export function summarizeTimeframeSnapshot(
  timeframe: Timeframe,
  snapshot: AnalysisSnapshot | null
): TimeframeAnalysisSummary {
  if (!snapshot || snapshot.candles.length < 15) {
    return {
      timeframe,
      available: false,
      candleCount: snapshot?.candles.length ?? 0,
      trend: 'consolidation',
      structure: 'Awaiting Data',
      lastSequence: 'NONE',
      bosCount: 0,
      chochCount: 0,
      mssCount: 0,
      activeOrderBlocks: 0,
      activeFvgs: 0,
      nearestSupport: null,
      nearestResistance: null,
      nearestDemand: null,
      nearestSupply: null,
      nearestImportantZone: '—',
      liquidityTarget: '—',
      premiumDiscount: 'n/a',
      momentum: 'neutral',
      alignment: 'neutral',
      lastUpdated: Date.now(),
    };
  }

  const ms = snapshot.marketStructure;
  const price = snapshot.candles[snapshot.candles.length - 1].close;
  const bosCount = ms.breaks.filter((b) => b.type === 'BOS').length;
  const chochCount = ms.breaks.filter((b) => b.type === 'CHoCH').length;
  const mssCount = ms.breaks.filter((b) => b.type === 'MSS').length;

  const activeOrderBlocks = snapshot.orderBlocks.filter((o) => o.valid).length;
  const activeFvgs = snapshot.fairValueGaps.filter((f) => f.status !== 'fully_filled' && f.status !== 'inverted').length;

  const supports = snapshot.supportResistance
    .filter((z) => z.kind === 'support' && z.midpoint <= price)
    .sort((a, b) => b.midpoint - a.midpoint);
  const resistances = snapshot.supportResistance
    .filter((z) => z.kind === 'resistance' && z.midpoint >= price)
    .sort((a, b) => a.midpoint - b.midpoint);

  const demands = snapshot.supplyDemand
    .filter((z) => z.kind === 'demand' && z.freshness !== 'invalidated' && z.midpoint <= price)
    .sort((a, b) => b.midpoint - a.midpoint);
  const supplies = snapshot.supplyDemand
    .filter((z) => z.kind === 'supply' && z.freshness !== 'invalidated' && z.midpoint >= price)
    .sort((a, b) => a.midpoint - b.midpoint);

  const nearestSupport = supports[0]?.midpoint ?? null;
  const nearestResistance = resistances[0]?.midpoint ?? null;
  const nearestDemand = demands[0]?.midpoint ?? null;
  const nearestSupply = supplies[0]?.midpoint ?? null;

  const candidates: { label: string; dist: number }[] = [];
  if (nearestSupport !== null) candidates.push({ label: `SUP ${nearestSupport.toFixed(2)}`, dist: Math.abs(price - nearestSupport) });
  if (nearestResistance !== null) candidates.push({ label: `RES ${nearestResistance.toFixed(2)}`, dist: Math.abs(price - nearestResistance) });
  if (nearestDemand !== null) candidates.push({ label: `DEM ${nearestDemand.toFixed(2)}`, dist: Math.abs(price - nearestDemand) });
  if (nearestSupply !== null) candidates.push({ label: `SUPP ${nearestSupply.toFixed(2)}`, dist: Math.abs(price - nearestSupply) });
  candidates.sort((a, b) => a.dist - b.dist);

  const unsweptLiq = snapshot.liquidityPools
    .filter((l) => !l.swept)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  const recentExt = ms.swings
    .filter((s) => s.scope === 'external' && s.structureLabel !== 'SH' && s.structureLabel !== 'SL')
    .slice(-3)
    .map((s) => s.structureLabel)
    .join(' → ');

  return {
    timeframe,
    available: true,
    candleCount: snapshot.candles.length,
    trend: ms.trend,
    structure: `${ms.lastExternalLabel !== 'NONE' ? ms.lastExternalLabel : 'Range'} (${ms.internalTrend})`,
    lastSequence: recentExt || ms.lastExternalLabel,
    bosCount,
    chochCount,
    mssCount,
    activeOrderBlocks,
    activeFvgs,
    nearestSupport,
    nearestResistance,
    nearestDemand,
    nearestSupply,
    nearestImportantZone: candidates[0]?.label ?? 'None nearby',
    liquidityTarget: unsweptLiq[0] ? `${unsweptLiq[0].label} @ ${unsweptLiq[0].price.toFixed(2)}` : '—',
    premiumDiscount: snapshot.dealingRange?.currentPosition ?? 'n/a',
    momentum: computeMomentum(snapshot),
    alignment:
      ms.trend === 'bullish'
        ? 'bullish_aligned'
        : ms.trend === 'bearish'
          ? 'bearish_aligned'
          : 'neutral',
    lastUpdated: snapshot.lastAnalyzedAt,
  };
}

/**
 * Builds independent Multi-Timeframe Summary across all 13 timeframes without forcing agreement.
 */
export function buildMultiTimeframeSummary(
  symbol: InstrumentSymbol,
  snapshotsByTf: Map<Timeframe, AnalysisSnapshot | null>
): MultiTimeframeSummary {
  const rows: TimeframeAnalysisSummary[] = TIMEFRAMES.map((tf) =>
    summarizeTimeframeSnapshot(tf, snapshotsByTf.get(tf) ?? null)
  );

  const countBias = (tfs: readonly Timeframe[]): 'bullish' | 'bearish' | 'mixed' => {
    let bull = 0;
    let bear = 0;
    for (const tf of tfs) {
      const r = rows.find((x) => x.timeframe === tf && x.available);
      if (!r) continue;
      if (r.trend === 'bullish') bull++;
      else if (r.trend === 'bearish') bear++;
    }
    if (bull > bear && bull >= 1) return 'bullish';
    if (bear > bull && bear >= 1) return 'bearish';
    return 'mixed';
  };

  const htfBias = countBias(HTF_TIMEFRAMES);
  const ltfBias = countBias(LTF_TIMEFRAMES);

  // Annotate per-row alignment against HTF bias
  for (const row of rows) {
    if (!row.available || row.trend === 'consolidation') {
      row.alignment = 'neutral';
    } else if (htfBias === 'bullish' && row.trend === 'bullish') {
      row.alignment = 'bullish_aligned';
    } else if (htfBias === 'bearish' && row.trend === 'bearish') {
      row.alignment = 'bearish_aligned';
    } else if (htfBias !== 'mixed' && row.trend !== htfBias) {
      row.alignment = 'conflicting';
    }
  }

  let overallAlignment: MultiTimeframeSummary['overallAlignment'] = 'Neutral';
  if (htfBias === 'bullish' && ltfBias === 'bullish') {
    overallAlignment = 'Bullish Alignment';
  } else if (htfBias === 'bearish' && ltfBias === 'bearish') {
    overallAlignment = 'Bearish Alignment';
  } else if (htfBias !== 'mixed' && ltfBias !== 'mixed' && htfBias !== ltfBias) {
    overallAlignment = 'Conflicting Structures';
  }

  // Detect potential reversal condition (HTF at Premium/Discount + LTF CHoCH)
  let potentialReversalCondition: string | null = null;
  const h4 = rows.find((r) => r.timeframe === '4H' && r.available);
  const m15 = rows.find((r) => r.timeframe === '15m' && r.available);
  if (h4 && m15) {
    if (h4.trend === 'bullish' && h4.premiumDiscount === 'premium' && m15.chochCount > 0 && m15.trend === 'bearish') {
      potentialReversalCondition = '4H Premium with 15m Bearish CHoCH — potential pullback/reversal';
    } else if (h4.trend === 'bearish' && h4.premiumDiscount === 'discount' && m15.chochCount > 0 && m15.trend === 'bullish') {
      potentialReversalCondition = '4H Discount with 15m Bullish CHoCH — potential bullish shift';
    }
  }

  return {
    symbol,
    htfBias,
    ltfBias,
    overallAlignment,
    potentialReversalCondition,
    rows,
  };
}
