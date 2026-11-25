import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  InstrumentSymbol,
  SignalDirection,
  SignalSettings,
  SignalTakeProfit,
} from '../../shared/types/index.ts';
import type { TradePlanResult } from '../types.ts';

function roundPrice(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

interface RawTargetCandidate {
  price: number;
  sourceLabel: string;
  priority: number; // higher = higher timeframe / cleaner liquidity target
}

/**
 * Computes structure-backed Entry Zone, Structural Invalidation, ATR-buffered Stop Loss,
 * and genuine opposing-structure Take Profits (TP1, TP2, optional TP3).
 * Never invents arbitrary target prices when structure does not support them.
 */
export function buildTradePlan(
  symbol: InstrumentSymbol,
  direction: SignalDirection,
  snapshots: Partial<Record<string, AnalysisSnapshot | null>>,
  currentPrice: number,
  settings: SignalSettings
): TradePlanResult {
  const meta = getInstrumentMeta(symbol);
  const p = meta.pricePrecision;
  const tfs = settings.timeframes;
  const isBuy = direction === 'BUY';

  const snap5m = snapshots[tfs.entryTf] ?? null;
  const snap15m = snapshots[tfs.setupTf] ?? null;
  const snap1H = snapshots[tfs.secondaryConfirmTf] ?? null;
  const snap4H = snapshots[tfs.primaryBiasTf] ?? null;

  const invalidPlan = (reason: string): TradePlanResult => ({
    valid: false,
    entryPrice: roundPrice(currentPrice, p),
    entryZone: { lower: roundPrice(currentPrice, p), upper: roundPrice(currentPrice, p) },
    stopLoss: 0,
    invalidationLevel: 0,
    atrBuffer: 0,
    takeProfits: [],
    primaryRR: 0,
    maxRR: 0,
    rejectionReason: reason,
    planNotes: [],
  });

  if (!snap5m || snap5m.candles.length < 15 || snap5m.atr <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return invalidPlan('Primary execution timeframe (5m) data or ATR unavailable');
  }

  const atr = snap5m.atr;
  const atr15 = snap15m?.atr && snap15m.atr > 0 ? snap15m.atr : atr * 1.5;
  const atrBuffer = Math.max(meta.minMove, atr * settings.atrStopBufferMultiplier);
  const planNotes: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Entry Price & Entry Zone (Anchored to nearest valid OB / FVG / Demand-Supply or market confirmation)
  // ---------------------------------------------------------------------------
  let entryLower = currentPrice - atr * 0.15;
  let entryUpper = currentPrice + atr * 0.15;
  let entryPrice = currentPrice;

  const zoneSearchTol = atr * 1.5;
  const matchingObs = [...(snap5m.orderBlocks ?? []), ...(snap15m?.orderBlocks ?? [])]
    .filter((ob) =>
      ob.valid &&
      (isBuy ? ob.kind === 'bullish_ob' || ob.kind === 'breaker_block' : ob.kind === 'bearish_ob' || ob.kind === 'breaker_block') &&
      (isBuy ? ob.upper <= currentPrice + zoneSearchTol && ob.lower < currentPrice : ob.lower >= currentPrice - zoneSearchTol && ob.upper > currentPrice)
    )
    .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice));

  const matchingFvgs = [...(snap5m.fairValueGaps ?? []), ...(snap15m?.fairValueGaps ?? [])]
    .filter((f) =>
      f.status !== 'fully_filled' &&
      f.status !== 'inverted' &&
      (isBuy ? f.kind === 'bullish_fvg' : f.kind === 'bearish_fvg') &&
      (isBuy ? f.upper <= currentPrice + zoneSearchTol && f.lower < currentPrice : f.lower >= currentPrice - zoneSearchTol && f.upper > currentPrice)
    )
    .sort((a, b) => Math.abs(a.consequentEncroachment - currentPrice) - Math.abs(b.consequentEncroachment - currentPrice));

  const matchingSd = [...(snap5m.supplyDemand ?? []), ...(snap15m?.supplyDemand ?? [])]
    .filter((z) =>
      z.freshness !== 'invalidated' &&
      z.freshness !== 'fully_mitigated' &&
      z.kind === (isBuy ? 'demand' : 'supply') &&
      (isBuy ? z.proximal <= currentPrice + zoneSearchTol : z.proximal >= currentPrice - zoneSearchTol)
    )
    .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice));

  if (matchingObs.length > 0) {
    const ob = matchingObs[0];
    if (currentPrice >= ob.lower && currentPrice <= ob.upper) {
      entryLower = ob.lower;
      entryUpper = ob.upper;
      entryPrice = currentPrice;
      planNotes.push(`Entry inside ${ob.timeframe} ${ob.kind.replace('_', ' ')}`);
    } else if (Math.abs(currentPrice - (isBuy ? ob.upper : ob.lower)) <= atr * 1.1) {
      entryLower = ob.lower;
      entryUpper = ob.upper;
      entryPrice = isBuy ? ob.upper : ob.lower;
      planNotes.push(`Retest entry at ${ob.timeframe} ${ob.kind.replace('_', ' ')} edge`);
    }
  } else if (matchingFvgs.length > 0) {
    const fvg = matchingFvgs[0];
    if (Math.abs(currentPrice - fvg.consequentEncroachment) <= atr * 1.1) {
      entryLower = fvg.lower;
      entryUpper = fvg.upper;
      entryPrice = currentPrice >= fvg.lower && currentPrice <= fvg.upper ? currentPrice : fvg.consequentEncroachment;
      planNotes.push(`Entry anchored to ${fvg.timeframe} FVG`);
    }
  } else if (matchingSd.length > 0) {
    const sd = matchingSd[0];
    const lo = Math.min(sd.proximal, sd.distal);
    const hi = Math.max(sd.proximal, sd.distal);
    if (Math.abs(currentPrice - sd.proximal) <= atr * 1.1) {
      entryLower = lo;
      entryUpper = hi;
      entryPrice = currentPrice >= lo && currentPrice <= hi ? currentPrice : sd.proximal;
      planNotes.push(`Entry anchored to ${sd.timeframe} ${sd.patternType} zone`);
    }
  }

  entryPrice = roundPrice(entryPrice, p);
  entryLower = roundPrice(Math.min(entryLower, entryUpper), p);
  entryUpper = roundPrice(Math.max(entryLower, entryUpper), p);

  // ---------------------------------------------------------------------------
  // 2. Structural Invalidation & ATR-Buffered Stop Loss
  // ---------------------------------------------------------------------------
  const invalidationCandidates: Array<{ price: number; label: string }> = [];

  if (isBuy) {
    for (const sw of snap5m.marketStructure.swings) {
      if (sw.kind === 'low' && sw.confirmationStatus === 'confirmed' && sw.price < entryLower) {
        invalidationCandidates.push({ price: sw.price, label: `5m Swing Low (${sw.structureLabel})` });
      }
    }
    for (const sw of snap15m?.marketStructure.swings ?? []) {
      if (sw.kind === 'low' && sw.confirmationStatus === 'confirmed' && sw.price < entryLower) {
        invalidationCandidates.push({ price: sw.price, label: `15m Swing Low (${sw.structureLabel})` });
      }
    }
    for (const ob of matchingObs.slice(0, 2)) {
      if (ob.lower < entryPrice) {
        invalidationCandidates.push({ price: ob.lower, label: `${ob.timeframe} OB Distal` });
      }
    }
    for (const l of snap5m.liquidityPools) {
      if (
        l.swept &&
        (l.kind === 'sell_side' || l.kind === 'equal_lows' || l.kind === 'pdl') &&
        l.price < entryPrice
      ) {
        invalidationCandidates.push({ price: l.lower, label: `Swept ${l.label}` });
      }
    }
    // Recent 12 closed 5m candle low as fallback structural floor if swings are far
    const recentClosed = snap5m.candles.filter((c) => c.isClosed).slice(-12);
    if (recentClosed.length >= 3) {
      const localLow = Math.min(...recentClosed.map((c) => c.low));
      if (localLow < entryLower) {
        invalidationCandidates.push({ price: localLow, label: '5m Recent Protected Low' });
      }
    }
  } else {
    for (const sw of snap5m.marketStructure.swings) {
      if (sw.kind === 'high' && sw.confirmationStatus === 'confirmed' && sw.price > entryUpper) {
        invalidationCandidates.push({ price: sw.price, label: `5m Swing High (${sw.structureLabel})` });
      }
    }
    for (const sw of snap15m?.marketStructure.swings ?? []) {
      if (sw.kind === 'high' && sw.confirmationStatus === 'confirmed' && sw.price > entryUpper) {
        invalidationCandidates.push({ price: sw.price, label: `15m Swing High (${sw.structureLabel})` });
      }
    }
    for (const ob of matchingObs.slice(0, 2)) {
      if (ob.upper > entryPrice) {
        invalidationCandidates.push({ price: ob.upper, label: `${ob.timeframe} OB Distal` });
      }
    }
    for (const l of snap5m.liquidityPools) {
      if (
        l.swept &&
        (l.kind === 'buy_side' || l.kind === 'equal_highs' || l.kind === 'pdh') &&
        l.price > entryPrice
      ) {
        invalidationCandidates.push({ price: l.upper, label: `Swept ${l.label}` });
      }
    }
    const recentClosed = snap5m.candles.filter((c) => c.isClosed).slice(-12);
    if (recentClosed.length >= 3) {
      const localHigh = Math.max(...recentClosed.map((c) => c.high));
      if (localHigh > entryUpper) {
        invalidationCandidates.push({ price: localHigh, label: '5m Recent Protected High' });
      }
    }
  }

  // Pick a structurally tight yet protected invalidation level (at least 0.5x ATR from entry, max 6x ATR15)
  const minDist = atr * 0.4;
  const maxDist = atr15 * 5.0;

  const validStops = invalidationCandidates
    .filter((c) => {
      const dist = isBuy ? entryPrice - c.price : c.price - entryPrice;
      return dist >= minDist && dist <= maxDist;
    })
    .sort((a, b) => {
      const da = Math.abs(entryPrice - a.price);
      const db = Math.abs(entryPrice - b.price);
      return da - db;
    });

  if (validStops.length === 0) {
    return invalidPlan(`No valid structural invalidation level found within risk bounds for ${direction}`);
  }

  const chosenInvalidation = validStops[0];
  const invalidationLevel = roundPrice(chosenInvalidation.price, p);
  const stopLoss = roundPrice(
    isBuy ? invalidationLevel - atrBuffer : invalidationLevel + atrBuffer,
    p
  );
  const risk = isBuy ? entryPrice - stopLoss : stopLoss - entryPrice;

  if (risk <= 0 || !Number.isFinite(risk)) {
    return invalidPlan('Computed stop-loss risk distance is non-positive');
  }
  if ((isBuy && currentPrice <= stopLoss) || (!isBuy && currentPrice >= stopLoss)) {
    return invalidPlan('Entry/structural stop-loss level is already invalidated by current price');
  }

  planNotes.push(`SL anchored beyond ${chosenInvalidation.label} + ${settings.atrStopBufferMultiplier}x ATR buffer`);

  // ---------------------------------------------------------------------------
  // 3. Opposing Structural Targets (Liquidity, S/R, Supply/Demand, HTF Swings)
  // ---------------------------------------------------------------------------
  const rawTargets: RawTargetCandidate[] = [];

  const collectFromSnapshot = (snap: AnalysisSnapshot | null, tfLabel: string, basePriority: number) => {
    if (!snap) return;
    // Opposing Liquidity Pools (unswept)
    for (const liq of snap.liquidityPools) {
      if (liq.swept) continue;
      const isTargetSide = isBuy
        ? liq.kind === 'buy_side' || liq.kind === 'equal_highs' || liq.kind === 'pdh' || liq.kind === 'pwh' || liq.kind === 'internal'
        : liq.kind === 'sell_side' || liq.kind === 'equal_lows' || liq.kind === 'pdl' || liq.kind === 'pwl' || liq.kind === 'internal';
      if (!isTargetSide) continue;
      if ((isBuy && liq.price > entryPrice) || (!isBuy && liq.price < entryPrice)) {
        rawTargets.push({
          price: liq.price,
          sourceLabel: `${tfLabel} ${liq.label}`,
          priority: basePriority + 2,
        });
      }
    }

    // Opposing S/R Zones
    for (const sr of snap.supportResistance) {
      if (sr.status === 'Invalidated' || sr.status === 'Broken') continue;
      if (isBuy && sr.kind === 'resistance' && sr.lower > entryPrice) {
        rawTargets.push({
          price: sr.lower,
          sourceLabel: `${tfLabel} ${sr.label}`,
          priority: basePriority + 1,
        });
      } else if (!isBuy && sr.kind === 'support' && sr.upper < entryPrice) {
        rawTargets.push({
          price: sr.upper,
          sourceLabel: `${tfLabel} ${sr.label}`,
          priority: basePriority + 1,
        });
      }
    }

    // Opposing Supply / Demand Zones
    for (const sd of snap.supplyDemand) {
      if (sd.freshness === 'invalidated' || sd.freshness === 'fully_mitigated') continue;
      if (isBuy && sd.kind === 'supply' && sd.proximal > entryPrice) {
        rawTargets.push({
          price: sd.proximal,
          sourceLabel: `${tfLabel} ${sd.patternType} Supply`,
          priority: basePriority + 1,
        });
      } else if (!isBuy && sd.kind === 'demand' && sd.proximal < entryPrice) {
        rawTargets.push({
          price: sd.proximal,
          sourceLabel: `${tfLabel} ${sd.patternType} Demand`,
          priority: basePriority + 1,
        });
      }
    }

    // External Opposing Swing Highs / Lows
    for (const sw of snap.marketStructure.swings) {
      if (sw.scope !== 'external' || sw.confirmationStatus !== 'confirmed') continue;
      if (isBuy && sw.kind === 'high' && sw.price > entryPrice) {
        rawTargets.push({
          price: sw.price,
          sourceLabel: `${tfLabel} Swing High (${sw.structureLabel})`,
          priority: basePriority,
        });
      } else if (!isBuy && sw.kind === 'low' && sw.price < entryPrice) {
        rawTargets.push({
          price: sw.price,
          sourceLabel: `${tfLabel} Swing Low (${sw.structureLabel})`,
          priority: basePriority,
        });
      }
    }
  };

  collectFromSnapshot(snap5m, tfs.entryTf, 1);
  collectFromSnapshot(snap15m, tfs.setupTf, 2);
  collectFromSnapshot(snap1H, tfs.secondaryConfirmTf, 3);
  collectFromSnapshot(snap4H, tfs.primaryBiasTf, 4);

  // Filter targets meeting minimum R:R threshold & sort closest-first
  const minRewardDist = risk * settings.minTp1RiskReward;
  const directionalTargets = rawTargets
    .filter((t) => {
      const reward = isBuy ? t.price - entryPrice : entryPrice - t.price;
      return reward >= minRewardDist;
    })
    .sort((a, b) => {
      const da = Math.abs(a.price - entryPrice);
      const db = Math.abs(b.price - entryPrice);
      if (Math.abs(da - db) < atr * 0.25) return b.priority - a.priority;
      return da - db;
    });

  // Deduplicate targets that sit too close to an already selected target
  const minStepDist = Math.max(risk * 0.5, atr * 0.6);
  const selectedTargets: RawTargetCandidate[] = [];
  for (const cand of directionalTargets) {
    if (selectedTargets.length === 0) {
      selectedTargets.push(cand);
      continue;
    }
    const prev = selectedTargets[selectedTargets.length - 1];
    const gap = Math.abs(cand.price - prev.price);
    if (gap >= minStepDist) {
      selectedTargets.push(cand);
    }
    if (selectedTargets.length >= 3) break;
  }

  if (selectedTargets.length === 0) {
    return invalidPlan(
      `No opposing structural target meets minimum 1:${settings.minTp1RiskReward} risk/reward`
    );
  }

  const takeProfits: SignalTakeProfit[] = selectedTargets.map((t, idx) => {
    const price = roundPrice(t.price, p);
    const reward = isBuy ? price - entryPrice : entryPrice - price;
    return {
      level: (idx + 1) as 1 | 2 | 3,
      price,
      riskReward: Number((reward / risk).toFixed(2)),
      sourceLabel: t.sourceLabel,
      hit: false,
      hitTime: null,
    };
  });

  const primaryRR = takeProfits[0].riskReward;
  const maxRR = takeProfits[takeProfits.length - 1].riskReward;

  return {
    valid: true,
    entryPrice,
    entryZone: { lower: entryLower, upper: entryUpper },
    stopLoss,
    invalidationLevel,
    atrBuffer: roundPrice(atrBuffer, p),
    takeProfits,
    primaryRR,
    maxRR,
    planNotes,
  };
}
