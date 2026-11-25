import type {
  Candle,
  InstrumentSymbol,
  SDZone,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Supply and Demand Zone Engine detecting:
 * - Rally-Base-Rally (RBR)
 * - Drop-Base-Drop (DBD)
 * - Rally-Base-Drop (RBD)
 * - Drop-Base-Rally (DBR)
 * Tracks proximal/distal/midpoint, departure strength, touches, mitigation %, freshness, and HTF alignment.
 */
export function detectSupplyDemandZones(
  candles: Candle[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  htfTrend: 'bullish' | 'bearish' | 'consolidation',
  settings: TechnicalSettings
): SDZone[] {
  if (candles.length < 15) return [];

  const currentPrice = candles[candles.length - 1].close;
  const zones: SDZone[] = [];
  const minImpulseAtr = Math.max(1.2, settings.obMinDisplacementAtr);

  const isImpulseBull = (c: Candle) =>
    c.close > c.open && c.close - c.open >= atr * 0.85 && (c.close - c.open) / Math.max(1e-8, c.high - c.low) >= 0.55;
  const isImpulseBear = (c: Candle) =>
    c.open > c.close && c.open - c.close >= atr * 0.85 && (c.open - c.close) / Math.max(1e-8, c.high - c.low) >= 0.55;
  const isBaseCandle = (c: Candle) => Math.abs(c.close - c.open) <= atr * 0.6;

  for (let i = 2; i < candles.length - 2; i++) {
    const legIn = candles[i - 1];
    const base = candles[i];
    const legOut = candles[i + 1];

    if (!legOut.isClosed) continue;
    if (!isBaseCandle(base)) continue;

    // Look for strong departure on legOut (or legOut + legOut2)
    const next2 = candles[i + 2];
    const bullDeparture =
      Math.max(legOut.high, next2?.high ?? legOut.high) - base.low;
    const bearDeparture =
      base.high - Math.min(legOut.low, next2?.low ?? legOut.low);

    let kind: SDZone['kind'] | null = null;
    let patternType: SDZone['patternType'] | null = null;
    let departureStrength = 0;

    if (isImpulseBull(legOut) && bullDeparture >= atr * minImpulseAtr) {
      kind = 'demand';
      departureStrength = bullDeparture / Math.max(1e-8, atr);
      patternType = legIn.close >= legIn.open ? 'RBR' : 'DBR';
    } else if (isImpulseBear(legOut) && bearDeparture >= atr * minImpulseAtr) {
      kind = 'supply';
      departureStrength = bearDeparture / Math.max(1e-8, atr);
      patternType = legIn.close <= legIn.open ? 'DBD' : 'RBD';
    }

    if (!kind || !patternType) continue;

    const proximal = kind === 'demand' ? Math.max(base.open, base.close, base.high * 0.999) : Math.min(base.open, base.close, base.low * 1.001);
    const distal = kind === 'demand' ? base.low : base.high;
    const highBound = Math.max(proximal, distal);
    const lowBound = Math.min(proximal, distal);
    const midpoint = (highBound + lowBound) / 2;
    const width = Math.max(1e-8, highBound - lowBound);

    let touches = 0;
    let mitigationPercent = 0;
    let invalidatedAt: number | null = null;
    let lastTouchTime: number | null = null;
    let lastTouchPrice: number | undefined;

    for (let k = i + 2; k < candles.length; k++) {
      const f = candles[k];
      if (!f.isClosed) continue;

      if (kind === 'demand') {
        if (f.low <= highBound && f.high >= lowBound) {
          touches++;
          lastTouchTime = f.time;
          lastTouchPrice = f.low;
          const depth = Math.min(1, Math.max(0, (highBound - Math.max(lowBound, f.low)) / width));
          mitigationPercent = Math.max(mitigationPercent, Math.round(depth * 100));
        }
        if (f.close < lowBound) {
          invalidatedAt = f.time;
          break;
        }
      } else {
        if (f.high >= lowBound && f.low <= highBound) {
          touches++;
          lastTouchTime = f.time;
          lastTouchPrice = f.high;
          const depth = Math.min(1, Math.max(0, (Math.min(highBound, f.high) - lowBound) / width));
          mitigationPercent = Math.max(mitigationPercent, Math.round(depth * 100));
        }
        if (f.close > highBound) {
          invalidatedAt = f.time;
          break;
        }
      }
    }

    const freshness: SDZone['freshness'] =
      invalidatedAt !== null
        ? 'invalidated'
        : mitigationPercent >= 85
          ? 'fully_mitigated'
          : mitigationPercent >= 35
            ? 'partially_mitigated'
            : touches > 0
              ? 'tested'
              : 'fresh';

    const dist =
      currentPrice > highBound
        ? currentPrice - highBound
        : currentPrice < lowBound
          ? lowBound - currentPrice
          : 0;
    const distancePercent = Number(((dist / Math.max(1e-8, currentPrice)) * 100).toFixed(3));

    zones.push({
      id: `${symbol}:${timeframe}:sd:${kind}:${patternType}:${base.time}`,
      symbol,
      timeframe,
      kind,
      patternType,
      proximal: kind === 'demand' ? highBound : lowBound,
      distal: kind === 'demand' ? lowBound : highBound,
      midpoint,
      width,
      originCandleTime: base.time,
      departureStrength: Number(departureStrength.toFixed(2)),
      touches,
      mitigationPercent,
      freshness,
      htfAligned:
        (kind === 'demand' && htfTrend === 'bullish') ||
        (kind === 'supply' && htfTrend === 'bearish'),
      distancePercent,
      interactionState:
        freshness === 'invalidated'
          ? 'Invalidated'
          : freshness === 'fully_mitigated'
            ? 'Mitigated'
            : touches > 0
              ? 'Touched'
              : 'Far Away',
      lastTouchTime,
      lastTouchPrice,
      formationTime: base.time,
      confirmationTime: legOut.time,
      detectionTime: legOut.time,
      invalidationTime: invalidatedAt,
      confirmationStatus: invalidatedAt ? 'invalidated' : 'confirmed',
    });

    // Skip adjacent base bar to avoid duplicate stacked zones
    i += 2;
  }

  return zones.slice(-24);
}
