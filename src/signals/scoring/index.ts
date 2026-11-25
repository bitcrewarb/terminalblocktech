import { TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  Candle,
  SignalClassification,
  SignalDirection,
  SignalHtfBiasSummary,
  SignalScoreBreakdown,
  SignalScoreCategory,
  SignalSettings,
  StructureBreak,
} from '../../shared/types/index.ts';

export function classifySignalScore(score: number): SignalClassification {
  if (score >= 85) return 'Excellent';
  if (score >= 75) return 'Strong';
  if (score >= 65) return 'Moderate';
  return 'No Trade';
}

export function extractHtfBiasSummary(
  snapshots: Partial<Record<string, AnalysisSnapshot | null>>
): SignalHtfBiasSummary {
  const getTrend = (tf: string): 'bullish' | 'bearish' | 'consolidation' | 'unavailable' => {
    const snap = snapshots[tf];
    if (!snap || snap.candles.length < 15) return 'unavailable';
    return snap.marketStructure.trend;
  };
  return {
    d1: getTrend('1D'),
    h4: getTrend('4H'),
    h1: getTrend('1H'),
    m15: getTrend('15m'),
    m5: getTrend('5m'),
    m1: snapshots['1m'] ? getTrend('1m') : undefined,
  };
}

function getLatestClosedCandle(candles: Candle[]): Candle | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].isClosed) return candles[i];
  }
  return null;
}

/**
 * Deduplicates simultaneous MSS + CHoCH tags emitted at the exact same breakTime
 * by the existing bos-choch engine so a single reversal is never double-counted.
 */
function deduplicateBreaks(breaks: StructureBreak[]): StructureBreak[] {
  const byKey = new Map<string, StructureBreak>();
  for (const br of breaks) {
    const key = `${br.timeframe}:${br.scope}:${br.direction}:${br.breakTime}`;
    const existing = byKey.get(key);
    if (!existing || br.type === 'MSS') {
      byKey.set(key, br);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.breakTime - b.breakTime);
}

function computeMomentumDisplacementAtr(snap: AnalysisSnapshot | null | undefined): number {
  if (!snap || snap.candles.length < 6 || snap.atr <= 0) return 0;
  const closed = snap.candles.filter((c) => c.isClosed);
  if (closed.length < 5) return 0;
  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 5];
  return (last.close - prev.open) / Math.max(1e-8, snap.atr);
}

function computeRelativeVolume(snap: AnalysisSnapshot | null | undefined): {
  hasReliableVolume: boolean;
  relVol: number;
} {
  if (!snap || snap.candles.length < 22) {
    return { hasReliableVolume: false, relVol: 0 };
  }
  const closed = snap.candles.filter((c) => c.isClosed);
  if (closed.length < 21) return { hasReliableVolume: false, relVol: 0 };
  const recent = closed.slice(-3);
  const baseline = closed.slice(-23, -3);
  const avgVol = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length;
  if (!Number.isFinite(avgVol) || avgVol <= 0) {
    return { hasReliableVolume: false, relVol: 0 };
  }
  const maxRecentVol = Math.max(...recent.map((c) => c.volume));
  return {
    hasReliableVolume: true,
    relVol: maxRecentVol / avgVol,
  };
}

export interface ScoredCandidateFactors {
  scoreBreakdown: SignalScoreBreakdown;
  hasLiquiditySweep: boolean;
  hasStructuralConfirmation: boolean;
  hasClosedCandleConfirmation: boolean;
  hasConfluenceZone: boolean;
  hasStrongConflict: boolean;
  conflictReasons: string[];
  confluenceReasons: string[];
  anchorCandleTime: number;
}

export function evaluateDirectionalScore(
  direction: SignalDirection,
  snapshots: Partial<Record<string, AnalysisSnapshot | null>>,
  settings: SignalSettings,
  currentPrice: number
): ScoredCandidateFactors {
  const w = settings.weights;
  const tfs = settings.timeframes;
  const isBuy = direction === 'BUY';
  const targetTrend = isBuy ? 'bullish' : 'bearish';
  const opposingTrend = isBuy ? 'bearish' : 'bullish';

  const snap1D = snapshots[tfs.majorDirectionTf] ?? null;
  const snap4H = snapshots[tfs.primaryBiasTf] ?? null;
  const snap1H = snapshots[tfs.secondaryConfirmTf] ?? null;
  const snap15m = snapshots[tfs.setupTf] ?? null;
  const snap5m = snapshots[tfs.entryTf] ?? null;
  const snap1m = snapshots[tfs.refinementTf] ?? null;

  const confluenceReasons: string[] = [];
  const conflictReasons: string[] = [];

  const d1Trend = snap1D?.marketStructure.trend ?? 'consolidation';
  const h4Trend = snap4H?.marketStructure.trend ?? 'consolidation';
  const h1Trend = snap1H?.marketStructure.trend ?? 'consolidation';
  const m15Trend = snap15m?.marketStructure.trend ?? 'consolidation';
  const m5Trend = snap5m?.marketStructure.trend ?? 'consolidation';

  // -------------------------------------------------------------------------
  // 1. Higher-Timeframe Alignment (default weight: 20)
  // -------------------------------------------------------------------------
  let htfRaw = 0;
  const htfNotes: string[] = [];
  if (snap4H && snap4H.candles.length >= 15) {
    if (h4Trend === targetTrend) {
      htfRaw += 0.5; // 10/20
      htfNotes.push(`4H ${h4Trend}`);
    } else if (h4Trend === opposingTrend) {
      conflictReasons.push(`4H market structure is ${h4Trend} (opposes ${direction})`);
    } else {
      htfRaw += 0.15;
      htfNotes.push('4H consolidation');
    }
  }
  if (snap1D && snap1D.candles.length >= 15) {
    if (d1Trend === targetTrend) {
      htfRaw += 0.25; // 5/20
      htfNotes.push(`1D ${d1Trend}`);
    } else if (d1Trend === opposingTrend) {
      htfNotes.push(`1D ${d1Trend} (counter-trend)`);
      if (h4Trend === opposingTrend) {
        conflictReasons.push(`Both 1D and 4H oppose ${direction}`);
      }
    } else {
      htfRaw += 0.1;
      htfNotes.push('1D neutral');
    }
  }
  if (snap1H && snap1H.candles.length >= 15) {
    if (h1Trend === targetTrend) {
      htfRaw += 0.25; // 5/20
      htfNotes.push(`1H ${h1Trend}`);
    } else if (h1Trend === opposingTrend) {
      if (settings.require1HAlignment) {
        conflictReasons.push(`1H alignment required but 1H is ${h1Trend}`);
      } else {
        htfNotes.push(`1H ${h1Trend}`);
      }
    }
  }

  const htfScore = Math.min(w.htfAlignment, Math.round(htfRaw * w.htfAlignment));
  if (htfScore >= w.htfAlignment * 0.5) {
    confluenceReasons.push(`HTF Alignment: ${htfNotes.join(', ')}`);
  }

  // -------------------------------------------------------------------------
  // 2. Liquidity Sweep (default weight: 15)
  // -------------------------------------------------------------------------
  const m5Closed = snap5m ? getLatestClosedCandle(snap5m.candles) : null;
  const m5LastTime = m5Closed?.time ?? snap5m?.candles[snap5m.candles.length - 1]?.time ?? 0;
  const m5SweepWindow = TIMEFRAME_SECONDS[tfs.entryTf] * 36; // last 36 bars (~3h on 5m)
  const m15SweepWindow = TIMEFRAME_SECONDS[tfs.setupTf] * 20; // last 20 bars (~5h on 15m)

  const matchingPoolKinds = isBuy
    ? new Set(['sell_side', 'equal_lows', 'pdl', 'pwl', 'inducement'])
    : new Set(['buy_side', 'equal_highs', 'pdh', 'pwh', 'inducement']);

  const isSideCorrectPool = (kind: string, label: string) => {
    if (kind === 'inducement') {
      return isBuy ? label.includes('Low') : label.includes('High');
    }
    return matchingPoolKinds.has(kind);
  };

  const recentM5Sweeps = (snap5m?.liquidityPools ?? []).filter(
    (l) =>
      l.swept &&
      l.sweepTime !== null &&
      m5LastTime - l.sweepTime <= m5SweepWindow &&
      isSideCorrectPool(l.kind, l.label)
  );
  const recentM15Sweeps = (snap15m?.liquidityPools ?? []).filter(
    (l) =>
      l.swept &&
      l.sweepTime !== null &&
      m5LastTime - l.sweepTime <= m15SweepWindow &&
      isSideCorrectPool(l.kind, l.label)
  );

  // Also detect equal lows/highs or rejection candle near liquidity
  const hasEqualPool = [...recentM5Sweeps, ...recentM15Sweeps].some(
    (l) => l.kind === (isBuy ? 'equal_lows' : 'equal_highs') || l.kind === (isBuy ? 'pdl' : 'pdh')
  );
  const hasStopHunt = [...recentM5Sweeps, ...recentM15Sweeps].some(
    (l) => l.sweepType === 'stop_hunt' || l.sweepType === 'sweep'
  );
  const hasRejectionCandle = (snap5m?.candlestickPatterns ?? []).some(
    (p) =>
      p.confirmationStatus === 'confirmed' &&
      p.direction === targetTrend &&
      m5LastTime - p.detectionTime <= TIMEFRAME_SECONDS[tfs.entryTf] * 8
  );

  const hasLiquiditySweep = recentM5Sweeps.length > 0 || recentM15Sweeps.length > 0;
  let sweepRaw = 0;
  if (hasLiquiditySweep) {
    sweepRaw += 0.65;
    if (hasStopHunt || hasRejectionCandle) sweepRaw += 0.2;
    if (hasEqualPool || (recentM5Sweeps.length > 0 && recentM15Sweeps.length > 0)) sweepRaw += 0.15;
    const sweepLabel = recentM15Sweeps[0]?.label ?? recentM5Sweeps[0]?.label ?? (isBuy ? 'SSL' : 'BSL');
    confluenceReasons.push(
      `${isBuy ? 'Sell-side' : 'Buy-side'} liquidity sweep (${sweepLabel}${hasStopHunt ? ', stop-hunt rejection' : ''})`
    );
  }
  const sweepScore = Math.min(w.liquiditySweep, Math.round(sweepRaw * w.liquiditySweep));

  // -------------------------------------------------------------------------
  // 3. Market Structure Confirmation (default weight: 20)
  // -------------------------------------------------------------------------
  const m5Breaks = deduplicateBreaks(snap5m?.marketStructure.breaks ?? []);
  const m15Breaks = deduplicateBreaks(snap15m?.marketStructure.breaks ?? []);
  const m1Breaks = deduplicateBreaks(snap1m?.marketStructure.breaks ?? []);

  const m5WindowSec = TIMEFRAME_SECONDS[tfs.entryTf] * 24;
  const m15WindowSec = TIMEFRAME_SECONDS[tfs.setupTf] * 16;

  const confirmedM5Breaks = m5Breaks.filter(
    (b) =>
      b.confirmationStatus === 'confirmed' &&
      b.direction === targetTrend &&
      m5LastTime - b.breakTime <= m5WindowSec
  );
  const provisionalM5Breaks = m5Breaks.filter(
    (b) =>
      b.confirmationStatus === 'provisional' &&
      b.direction === targetTrend &&
      m5LastTime - b.breakTime <= m5WindowSec
  );
  const confirmedM15Breaks = m15Breaks.filter(
    (b) =>
      b.confirmationStatus === 'confirmed' &&
      b.direction === targetTrend &&
      m5LastTime - b.breakTime <= m15WindowSec
  );
  const confirmedM1Breaks = m1Breaks.filter(
    (b) =>
      b.confirmationStatus === 'confirmed' &&
      b.direction === targetTrend &&
      m5LastTime - b.breakTime <= TIMEFRAME_SECONDS[tfs.refinementTf] * 30
  );

  // Latest structural break on 5m must not be directly contradicted by a newer opposing external break
  const latestM5ExtBreak = [...m5Breaks].filter((b) => b.scope === 'external' && b.confirmationStatus === 'confirmed').pop();
  const latestM15ExtBreak = [...m15Breaks].filter((b) => b.scope === 'external' && b.confirmationStatus === 'confirmed').pop();

  if (
    latestM5ExtBreak &&
    latestM5ExtBreak.direction === opposingTrend &&
    m5LastTime - latestM5ExtBreak.breakTime <= TIMEFRAME_SECONDS[tfs.entryTf] * 6 &&
    m5Trend === opposingTrend &&
    m15Trend === opposingTrend
  ) {
    conflictReasons.push(`Recent ${tfs.entryTf} & ${tfs.setupTf} ${opposingTrend} structure break conflicts with ${direction}`);
  }

  const hasClosedCandleConfirmation = confirmedM5Breaks.length > 0 || confirmedM15Breaks.length > 0;
  const hasStructuralConfirmation =
    hasClosedCandleConfirmation || (settings.allowIntrabarWatching && provisionalM5Breaks.length > 0);

  let structRaw = 0;
  const activeBreaks = hasClosedCandleConfirmation
    ? [...confirmedM15Breaks, ...confirmedM5Breaks]
    : provisionalM5Breaks;

  if (activeBreaks.length > 0) {
    const hasShift = activeBreaks.some((b) => b.type === 'MSS' || b.type === 'CHoCH');
    const hasBos = activeBreaks.some((b) => b.type === 'BOS');
    const hasDualTf =
      (confirmedM15Breaks.length > 0 && confirmedM5Breaks.length > 0) ||
      (confirmedM5Breaks.length > 0 && m15Trend === targetTrend);

    if (hasShift) structRaw += 0.6;
    else if (hasBos) structRaw += 0.45;

    if (hasBos && hasShift) structRaw += 0.2;
    if (hasDualTf) structRaw += 0.2;
    if (confirmedM1Breaks.length > 0) structRaw = Math.min(1, structRaw + 0.1);

    const latestBr = activeBreaks[activeBreaks.length - 1];
    confluenceReasons.push(
      `${isBuy ? 'Bullish' : 'Bearish'} ${latestBr.type} on ${latestBr.timeframe} @ ${latestBr.levelPrice.toFixed(2)}${
        hasClosedCandleConfirmation ? ' (Closed candle)' : ' (Intrabar)'
      }`
    );
  }

  if (settings.require1MRefinement && confirmedM1Breaks.length === 0) {
    conflictReasons.push('1m entry refinement structure confirmation not yet present');
  }

  const structScore = Math.min(
    w.structureConfirmation,
    Math.round(structRaw * w.structureConfirmation)
  );

  // -------------------------------------------------------------------------
  // 4. Order Block / FVG / Supply-Demand Confluence (default weight: 15)
  // -------------------------------------------------------------------------
  const atr5m = snap5m?.atr ?? snap15m?.atr ?? 0;
  const proximityTol = Math.max(1e-8, atr5m * 1.8);

  const validObs = [
    ...(snap5m?.orderBlocks ?? []),
    ...(snap15m?.orderBlocks ?? []),
  ].filter(
    (ob) =>
      ob.valid &&
      (isBuy ? ob.kind === 'bullish_ob' || ob.kind === 'breaker_block' : ob.kind === 'bearish_ob' || ob.kind === 'breaker_block') &&
      currentPrice >= ob.lower - proximityTol &&
      currentPrice <= ob.upper + proximityTol
  );

  const validFvgs = [
    ...(snap5m?.fairValueGaps ?? []),
    ...(snap15m?.fairValueGaps ?? []),
  ].filter(
    (fvg) =>
      fvg.status !== 'fully_filled' &&
      fvg.status !== 'inverted' &&
      (isBuy ? fvg.kind === 'bullish_fvg' : fvg.kind === 'bearish_fvg') &&
      currentPrice >= fvg.lower - proximityTol &&
      currentPrice <= fvg.upper + proximityTol
  );

  const validSd = [
    ...(snap5m?.supplyDemand ?? []),
    ...(snap15m?.supplyDemand ?? []),
    ...(snap1H?.supplyDemand ?? []),
  ].filter(
    (z) =>
      z.freshness !== 'invalidated' &&
      z.freshness !== 'fully_mitigated' &&
      z.kind === (isBuy ? 'demand' : 'supply') &&
      currentPrice >= Math.min(z.proximal, z.distal) - proximityTol * 1.3 &&
      currentPrice <= Math.max(z.proximal, z.distal) + proximityTol * 1.3
  );

  const hasConfluenceZone = validObs.length > 0 || validFvgs.length > 0 || validSd.length > 0;
  let zoneRaw = 0;
  const zoneParts: string[] = [];
  if (validObs.length > 0) {
    zoneRaw += 0.45;
    zoneParts.push(`${validObs[0].timeframe} ${validObs[0].kind.replace('_', ' ').toUpperCase()}`);
  }
  if (validFvgs.length > 0) {
    zoneRaw += 0.35;
    zoneParts.push(`${validFvgs[0].timeframe} ${isBuy ? 'Bullish' : 'Bearish'} FVG`);
  }
  if (validSd.length > 0) {
    zoneRaw += 0.25;
    zoneParts.push(`${validSd[0].timeframe} ${validSd[0].patternType} ${isBuy ? 'Demand' : 'Supply'}`);
  }
  if (zoneParts.length > 0) {
    confluenceReasons.push(`Zone Confluence: ${zoneParts.join(' + ')}`);
  }
  const obFvgScore = Math.min(
    w.obFvgConfluence,
    Math.round(Math.min(1, zoneRaw) * w.obFvgConfluence)
  );

  // -------------------------------------------------------------------------
  // 5. Premium / Discount & OTE Positioning (default weight: 10)
  // -------------------------------------------------------------------------
  const dr = snap15m?.dealingRange ?? snap1H?.dealingRange ?? snap5m?.dealingRange ?? null;
  let pdRaw = 0;
  let pdDetail = 'Dealing range unavailable';
  if (dr) {
    if (isBuy) {
      if (dr.currentPosition === 'discount') {
        pdRaw = dr.inOteZone ? 1.0 : 0.75;
        pdDetail = `Discount (${dr.retracementPercent}%${dr.inOteZone ? ', OTE zone' : ''})`;
      } else if (dr.currentPosition === 'equilibrium') {
        pdRaw = 0.35;
        pdDetail = `Equilibrium (${dr.retracementPercent}%)`;
      } else {
        pdRaw = 0;
        pdDetail = `Premium (${dr.retracementPercent}%) — unfavorable for BUY`;
        if (dr.retracementPercent < 20 && h4Trend === 'bearish') {
          conflictReasons.push('BUY candidate sits in extreme premium against bearish 4H trend');
        }
      }
    } else {
      if (dr.currentPosition === 'premium') {
        pdRaw = dr.inOteZone ? 1.0 : 0.75;
        pdDetail = `Premium (${dr.retracementPercent}%${dr.inOteZone ? ', OTE zone' : ''})`;
      } else if (dr.currentPosition === 'equilibrium') {
        pdRaw = 0.35;
        pdDetail = `Equilibrium (${dr.retracementPercent}%)`;
      } else {
        pdRaw = 0;
        pdDetail = `Discount (${dr.retracementPercent}%) — unfavorable for SELL`;
        if (dr.retracementPercent < 20 && h4Trend === 'bullish') {
          conflictReasons.push('SELL candidate sits in extreme discount against bullish 4H trend');
        }
      }
    }
    if (pdRaw >= 0.7) {
      confluenceReasons.push(`Dealing Range: ${pdDetail}`);
    }
  }
  const pdScore = Math.min(w.premiumDiscount, Math.round(pdRaw * w.premiumDiscount));

  // -------------------------------------------------------------------------
  // 6. Volume and Momentum (default weight: 10)
  // -------------------------------------------------------------------------
  const disp5m = computeMomentumDisplacementAtr(snap5m);
  const disp15m = computeMomentumDisplacementAtr(snap15m);
  const { hasReliableVolume, relVol } = computeRelativeVolume(snap5m);
  const signedDisp5m = isBuy ? disp5m : -disp5m;
  const signedDisp15m = isBuy ? disp15m : -disp15m;

  let vmRaw = 0;
  const vmNotes: string[] = [];
  if (signedDisp5m >= 0.45 || signedDisp15m >= 0.45) {
    vmRaw += 0.5;
    vmNotes.push(`${isBuy ? 'Bullish' : 'Bearish'} displacement (${Math.max(signedDisp5m, signedDisp15m).toFixed(2)}x ATR)`);
  } else if (signedDisp5m < -0.9 && signedDisp15m < -0.9) {
    conflictReasons.push(`Strong opposing momentum (${disp5m.toFixed(2)}x ATR) against ${direction}`);
  }

  if (hasReliableVolume) {
    if (relVol >= 1.2) {
      vmRaw += 0.5;
      vmNotes.push(`Volume ${relVol.toFixed(2)}x avg`);
    } else if (relVol >= 0.85) {
      vmRaw += 0.25;
      vmNotes.push(`Steady volume (${relVol.toFixed(2)}x avg)`);
    }
  }
  if (vmNotes.length > 0) {
    confluenceReasons.push(`Momentum & Volume: ${vmNotes.join(', ')}`);
  }
  const vmScore = Math.min(w.volumeMomentum, Math.round(vmRaw * w.volumeMomentum));

  // -------------------------------------------------------------------------
  // 7. Risk/Reward placeholder (populated after trade-plan calculation)
  // -------------------------------------------------------------------------
  const zeroCategory = (maxScore: number, detail: string): SignalScoreCategory => ({
    score: 0,
    maxScore,
    met: false,
    detail,
  });

  const preTotal = htfScore + sweepScore + structScore + obFvgScore + pdScore + vmScore;

  const scoreBreakdown: SignalScoreBreakdown = {
    htfAlignment: {
      score: htfScore,
      maxScore: w.htfAlignment,
      met: htfScore >= Math.round(w.htfAlignment * 0.5),
      detail: htfNotes.join(', ') || 'HTF data unavailable',
    },
    liquiditySweep: {
      score: sweepScore,
      maxScore: w.liquiditySweep,
      met: hasLiquiditySweep,
      detail: hasLiquiditySweep
        ? `${recentM5Sweeps.length + recentM15Sweeps.length} recent sweep(s)`
        : 'No recent opposing liquidity sweep',
    },
    structureConfirmation: {
      score: structScore,
      maxScore: w.structureConfirmation,
      met: hasStructuralConfirmation,
      detail: hasStructuralConfirmation
        ? `${activeBreaks[activeBreaks.length - 1]?.type ?? 'BOS'} (${hasClosedCandleConfirmation ? 'confirmed' : 'provisional'})`
        : 'No MSS/CHoCH/BOS confirmation',
    },
    obFvgConfluence: {
      score: obFvgScore,
      maxScore: w.obFvgConfluence,
      met: hasConfluenceZone,
      detail: zoneParts.join(' + ') || 'No active OB/FVG/SD zone confluence',
    },
    premiumDiscount: {
      score: pdScore,
      maxScore: w.premiumDiscount,
      met: pdRaw >= 0.65,
      detail: pdDetail,
    },
    volumeMomentum: {
      score: vmScore,
      maxScore: w.volumeMomentum,
      met: vmScore >= Math.round(w.volumeMomentum * 0.5),
      detail: vmNotes.join(', ') || (hasReliableVolume ? 'Neutral momentum/volume' : 'Volume/momentum neutral'),
    },
    riskRewardQuality: zeroCategory(w.riskRewardQuality, 'Pending R:R calculation'),
    totalScore: preTotal,
    classification: classifySignalScore(preTotal),
  };

  const latestActiveBreakTime =
    activeBreaks.length > 0 ? activeBreaks[activeBreaks.length - 1].breakTime : m5LastTime;

  return {
    scoreBreakdown,
    hasLiquiditySweep,
    hasStructuralConfirmation,
    hasClosedCandleConfirmation,
    hasConfluenceZone,
    hasStrongConflict: conflictReasons.length > 0,
    conflictReasons,
    confluenceReasons,
    anchorCandleTime: latestActiveBreakTime || m5LastTime,
  };
}

export function applyRiskRewardScore(
  preBreakdown: SignalScoreBreakdown,
  primaryRR: number,
  minTp1RR: number,
  maxWeight: number
): SignalScoreBreakdown {
  let rrRaw = 0;
  let detail = `TP1 R:R ${primaryRR.toFixed(2)} (min ${minTp1RR.toFixed(2)})`;
  if (primaryRR >= 2.5) {
    rrRaw = 1.0;
    detail = `TP1 R:R 1:${primaryRR.toFixed(2)} (Institutional >= 2.5R)`;
  } else if (primaryRR >= 2.0) {
    rrRaw = 0.8;
    detail = `TP1 R:R 1:${primaryRR.toFixed(2)} (High >= 2.0R)`;
  } else if (primaryRR >= 1.75) {
    rrRaw = 0.65;
    detail = `TP1 R:R 1:${primaryRR.toFixed(2)} (>= 1.75R)`;
  } else if (primaryRR >= minTp1RR) {
    rrRaw = 0.5;
    detail = `TP1 R:R 1:${primaryRR.toFixed(2)} (Meets ${minTp1RR.toFixed(2)}R min)`;
  } else {
    rrRaw = 0;
    detail = `TP1 R:R 1:${primaryRR.toFixed(2)} below minimum 1:${minTp1RR.toFixed(2)}`;
  }

  const rrScore = Math.min(maxWeight, Math.round(rrRaw * maxWeight));
  const totalScore =
    preBreakdown.htfAlignment.score +
    preBreakdown.liquiditySweep.score +
    preBreakdown.structureConfirmation.score +
    preBreakdown.obFvgConfluence.score +
    preBreakdown.premiumDiscount.score +
    preBreakdown.volumeMomentum.score +
    rrScore;

  return {
    ...preBreakdown,
    riskRewardQuality: {
      score: rrScore,
      maxScore: maxWeight,
      met: primaryRR >= minTp1RR,
      detail,
    },
    totalScore,
    classification: classifySignalScore(totalScore),
  };
}
