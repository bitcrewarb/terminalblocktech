import type {
  Candle,
  InstrumentSymbol,
  SDZone,
  SRStatus,
  SRZone,
  SessionAnchors,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
  TradingSessionBox,
} from '../../shared/types/index.ts';

interface LevelCandidate {
  price: number;
  time: number;
  source: SRZone['source'];
  label: string;
  weight: number;
}

/**
 * Volatility-adjusted Support & Resistance clustering engine.
 * Clusters confirmed swings, daily/weekly/monthly levels, pivots, and session extremes.
 */
export function detectSupportResistanceZones(
  candles: Candle[],
  swings: SwingPoint[],
  anchors: SessionAnchors,
  sessions: TradingSessionBox[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): SRZone[] {
  if (candles.length < 15) return [];

  const currentPrice = candles[candles.length - 1].close;
  const clusterWidth = Math.max(1e-8, atr * settings.srClusteringAtrMultiplier);
  const candidates: LevelCandidate[] = [];

  // 1. Confirmed swings
  for (const s of swings) {
    if (s.confirmationStatus !== 'confirmed') continue;
    candidates.push({
      price: s.price,
      time: s.candleTime,
      source: 'swing_cluster',
      label: s.scope === 'external' ? 'Major Swing' : 'Swing',
      weight: s.scope === 'external' ? 25 : 14,
    });
  }

  // 2. PDH/PDL, PWH/PWL, PMH/PML
  const firstTime = candles[0].time;
  if (anchors.prevDayHigh !== null) {
    candidates.push({ price: anchors.prevDayHigh, time: firstTime, source: 'pdh_pdl', label: 'PDH', weight: 30 });
  }
  if (anchors.prevDayLow !== null) {
    candidates.push({ price: anchors.prevDayLow, time: firstTime, source: 'pdh_pdl', label: 'PDL', weight: 30 });
  }
  if (anchors.prevWeekHigh !== null) {
    candidates.push({ price: anchors.prevWeekHigh, time: firstTime, source: 'pwh_pwl', label: 'PWH', weight: 35 });
  }
  if (anchors.prevWeekLow !== null) {
    candidates.push({ price: anchors.prevWeekLow, time: firstTime, source: 'pwh_pwl', label: 'PWL', weight: 35 });
  }
  if (anchors.prevMonthHigh !== null) {
    candidates.push({ price: anchors.prevMonthHigh, time: firstTime, source: 'pmh_pml', label: 'PMH', weight: 40 });
  }
  if (anchors.prevMonthLow !== null) {
    candidates.push({ price: anchors.prevMonthLow, time: firstTime, source: 'pmh_pml', label: 'PML', weight: 40 });
  }

  // 3. Classic Floor Pivot from previous day if available
  if (anchors.prevDayHigh !== null && anchors.prevDayLow !== null && anchors.dailyOpen !== null) {
    const pp = (anchors.prevDayHigh + anchors.prevDayLow + anchors.dailyOpen) / 3;
    const r1 = 2 * pp - anchors.prevDayLow;
    const s1 = 2 * pp - anchors.prevDayHigh;
    candidates.push({ price: pp, time: firstTime, source: 'pivot', label: 'Daily Pivot', weight: 22 });
    candidates.push({ price: r1, time: firstTime, source: 'pivot', label: 'Pivot R1', weight: 20 });
    candidates.push({ price: s1, time: firstTime, source: 'pivot', label: 'Pivot S1', weight: 20 });
  }

  // 4. Latest completed session highs/lows
  for (const sess of sessions.slice(-4)) {
    candidates.push({
      price: sess.highPrice,
      time: sess.startTime,
      source: 'session_hl',
      label: `${sess.session} High`,
      weight: 16,
    });
    candidates.push({
      price: sess.lowPrice,
      time: sess.startTime,
      source: 'session_hl',
      label: `${sess.session} Low`,
      weight: 16,
    });
  }

  if (candidates.length === 0) return [];

  // Cluster by price proximity within clusterWidth
  candidates.sort((a, b) => a.price - b.price);
  const clusters: LevelCandidate[][] = [];
  for (const cand of candidates) {
    const lastCluster = clusters[clusters.length - 1];
    if (!lastCluster) {
      clusters.push([cand]);
      continue;
    }
    const avg = lastCluster.reduce((s, c) => s + c.price, 0) / lastCluster.length;
    if (Math.abs(cand.price - avg) <= clusterWidth) {
      lastCluster.push(cand);
    } else {
      clusters.push([cand]);
    }
  }

  const zones: SRZone[] = [];
  const halfZone = atr * 0.18;
  const nearTol = atr * settings.zoneTouchToleranceAtr;
  const approachTol = atr * settings.zoneTouchToleranceAtr * 2.5;

  for (const group of clusters) {
    // Filter weak isolated single internal swings to prevent clutter
    const totalWeight = group.reduce((s, c) => s + c.weight, 0);
    if (group.length === 1 && totalWeight < 20) continue;

    const prices = group.map((g) => g.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const midpoint = (minP + maxP) / 2;
    const lower = Math.min(minP, midpoint - halfZone);
    const upper = Math.max(maxP, midpoint + halfZone);
    const firstDetection = Math.min(...group.map((g) => g.time));

    // Evaluate historical touches, rejections, breakouts across candles after firstDetection
    let touches = 0;
    let rejections = 0;
    let breakouts = 0;
    let lastTest: number | null = null;
    let lastTouchPrice: number | undefined;
    let touchMethod: 'wick' | 'close' | undefined;
    let wasBroken = false;
    let isRetesting = false;

    const kind: SRZone['kind'] = currentPrice >= midpoint ? 'support' : 'resistance';

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.time <= firstDetection) continue;
      if (!c.isClosed) continue;

      const overlaps = c.low <= upper && c.high >= lower;
      if (overlaps) {
        touches++;
        lastTest = c.time;
        lastTouchPrice = c.close;
        const bodyInside =
          Math.max(c.open, c.close) >= lower && Math.min(c.open, c.close) <= upper;
        touchMethod = bodyInside ? 'close' : 'wick';

        if (kind === 'support') {
          if (c.low <= upper && c.close > upper) rejections++;
          if (c.close < lower) breakouts++;
        } else {
          if (c.high >= lower && c.close < lower) rejections++;
          if (c.close > upper) breakouts++;
        }
      }
    }

    const lastCandle = candles[candles.length - 1];
    const distAbs =
      currentPrice > upper ? currentPrice - upper : currentPrice < lower ? lower - currentPrice : 0;
    const distancePercent = Number(((distAbs / Math.max(1e-8, currentPrice)) * 100).toFixed(3));

    if (kind === 'support' && lastCandle.close < lower && lastCandle.isClosed) {
      wasBroken = true;
    } else if (kind === 'resistance' && lastCandle.close > upper && lastCandle.isClosed) {
      wasBroken = true;
    }

    let status: SRStatus = 'Active';
    if (lastCandle.low <= upper && lastCandle.high >= lower) {
      if (
        (kind === 'support' && lastCandle.close < lower) ||
        (kind === 'resistance' && lastCandle.close > upper)
      ) {
        status = lastCandle.isClosed ? 'Broken' : 'Breaking';
      } else {
        const wickedRejection =
          (kind === 'support' && lastCandle.close > upper) ||
          (kind === 'resistance' && lastCandle.close < lower);
        status = wickedRejection ? 'Rejected' : 'Touched';
      }
    } else if (wasBroken) {
      status = distAbs <= nearTol ? 'Retesting' : breakouts > 2 ? 'Invalidated' : 'Broken';
    } else if (distAbs <= nearTol) {
      status = 'Near';
    } else if (distAbs <= approachTol) {
      status = 'Approaching';
    }

    if (status === 'Retesting') isRetesting = true;

    const primaryLabel =
      group.find((g) => g.source !== 'swing_cluster')?.label ??
      (kind === 'support' ? 'Support Zone' : 'Resistance Zone');

    const strengthScore = Math.min(
      100,
      Math.round(totalWeight * 0.6 + touches * 7 + rejections * 9 - breakouts * 6)
    );

    zones.push({
      id: `${symbol}:${timeframe}:sr:${kind}:${Math.round(midpoint * 100)}`,
      symbol,
      timeframe,
      kind,
      source: group[0].source,
      label: `${primaryLabel}${group.length > 1 ? ` (×${group.length})` : ''}`,
      upper,
      lower,
      midpoint,
      touches,
      rejections,
      breakouts,
      strengthScore: Math.max(15, strengthScore),
      firstDetection,
      lastTest,
      distancePercent,
      status,
      interactionState:
        status === 'Broken'
          ? 'Confirmed Breakout'
          : status === 'Breaking'
            ? 'Breaking'
            : status === 'Touched'
              ? 'Touched'
              : status === 'Rejected'
                ? 'Rejected'
                : isRetesting
                  ? 'Retesting'
                  : status === 'Near'
                    ? 'Near'
                    : status === 'Approaching'
                      ? 'Approaching'
                      : status === 'Invalidated'
                        ? 'Invalidated'
                        : 'Far Away',
      touchMethod,
      lastTouchPrice,
      formationTime: firstDetection,
      confirmationTime: firstDetection,
      detectionTime: firstDetection,
      invalidationTime: status === 'Invalidated' ? lastCandle.time : null,
      confirmationStatus: status === 'Invalidated' ? 'invalidated' : 'confirmed',
    });
  }

  // Sort by closeness & strength, cap to top 14 cleanest zones
  return zones
    .filter((z) => z.status !== 'Invalidated')
    .sort((a, b) => a.distancePercent - b.distancePercent || b.strengthScore - a.strengthScore)
    .slice(0, 14);
}
