import type {
  Candle,
  InstrumentSymbol,
  OrderBlock,
  StructureBreak,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Detects Bullish Order Blocks, Bearish Order Blocks, Breaker Blocks, and Mitigation Blocks
 * from impulsive displacement / structure break moves, tracking mitigation and invalidation.
 */
export function detectOrderBlocks(
  candles: Candle[],
  breaks: StructureBreak[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): OrderBlock[] {
  if (candles.length < 10) return [];

  const blocks: OrderBlock[] = [];
  const seenKeys = new Set<string>();
  const timeToIndex = new Map<number, number>();
  candles.forEach((c, idx) => timeToIndex.set(c.time, idx));

  const minDisp = settings.obRequireDisplacement ? atr * settings.obMinDisplacementAtr : 0;

  // Inspect confirmed structure breaks to anchor high-probability order blocks
  for (const br of breaks) {
    if (br.confirmationStatus !== 'confirmed') continue;
    const breakIdx = timeToIndex.get(br.breakTime);
    if (breakIdx === undefined || breakIdx < 2) continue;

    // Search backwards from breakIdx (up to 15 bars) for the last opposite-colored candle
    const searchStart = Math.max(0, breakIdx - 15);
    let originIdx = -1;
    for (let j = breakIdx - 1; j >= searchStart; j--) {
      const c = candles[j];
      if (br.direction === 'bullish' && c.close < c.open) {
        originIdx = j;
        break;
      }
      if (br.direction === 'bearish' && c.close > c.open) {
        originIdx = j;
        break;
      }
    }

    if (originIdx === -1) continue;

    const obCandle = candles[originIdx];
    const dispMove =
      br.direction === 'bullish'
        ? candles[breakIdx].high - obCandle.low
        : obCandle.high - candles[breakIdx].low;
    const dispAtr = dispMove / Math.max(1e-8, atr);

    if (dispMove < minDisp) continue;

    const upper = obCandle.high;
    const lower = obCandle.low;
    const midpoint = (upper + lower) / 2;
    const key = `${br.direction}:${obCandle.time}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Track touches, mitigation, and invalidation forward from breakIdx + 1
    let touches = 0;
    let mitigationPercent = 0;
    let invalidatedAt: number | null = null;
    let wasTouchedBeforeBreak = false;

    for (let k = breakIdx + 1; k < candles.length; k++) {
      const f = candles[k];
      if (!f.isClosed) continue;

      if (br.direction === 'bullish') {
        if (f.low <= upper && f.high >= lower) {
          touches++;
          wasTouchedBeforeBreak = true;
          const depth = Math.min(1, Math.max(0, (upper - Math.max(lower, f.low)) / Math.max(1e-8, upper - lower)));
          mitigationPercent = Math.max(mitigationPercent, Math.round(depth * 100));
        }
        if (f.close < lower) {
          invalidatedAt = f.time;
          break;
        }
      } else {
        if (f.high >= lower && f.low <= upper) {
          touches++;
          wasTouchedBeforeBreak = true;
          const depth = Math.min(1, Math.max(0, (Math.min(upper, f.high) - lower) / Math.max(1e-8, upper - lower)));
          mitigationPercent = Math.max(mitigationPercent, Math.round(depth * 100));
        }
        if (f.close > upper) {
          invalidatedAt = f.time;
          break;
        }
      }
    }

    const baseKind: OrderBlock['kind'] =
      br.direction === 'bullish' ? 'bullish_ob' : 'bearish_ob';

    blocks.push({
      id: `${symbol}:${timeframe}:ob:${baseKind}:${obCandle.time}`,
      symbol,
      timeframe,
      kind: baseKind,
      upper,
      lower,
      midpoint,
      originTime: obCandle.time,
      displacementAtr: Number(dispAtr.toFixed(2)),
      valid: invalidatedAt === null,
      mitigated: mitigationPercent >= 50,
      mitigationPercent,
      touches,
      interactionState:
        invalidatedAt !== null
          ? 'Invalidated'
          : mitigationPercent >= 80
            ? 'Mitigated'
            : touches > 0
              ? 'Touched'
              : 'Far Away',
      formationTime: obCandle.time,
      confirmationTime: br.confirmationTime,
      detectionTime: br.detectionTime,
      invalidationTime: invalidatedAt,
      confirmationStatus: invalidatedAt ? 'invalidated' : 'confirmed',
    });

    // If invalidated after a sweep/break, emit Breaker Block or Mitigation Block
    if (invalidatedAt !== null) {
      const flippedKind: OrderBlock['kind'] = wasTouchedBeforeBreak
        ? 'mitigation_block'
        : 'breaker_block';

      let flippedInvalidated: number | null = null;
      let flippedTouches = 0;
      const invIdx = timeToIndex.get(invalidatedAt) ?? candles.length - 1;
      for (let k = invIdx + 1; k < candles.length; k++) {
        const f = candles[k];
        if (!f.isClosed) continue;
        if (f.low <= upper && f.high >= lower) flippedTouches++;
        if (br.direction === 'bullish' && f.close > upper) {
          flippedInvalidated = f.time;
          break;
        }
        if (br.direction === 'bearish' && f.close < lower) {
          flippedInvalidated = f.time;
          break;
        }
      }

      blocks.push({
        id: `${symbol}:${timeframe}:ob:${flippedKind}:${obCandle.time}`,
        symbol,
        timeframe,
        kind: flippedKind,
        upper,
        lower,
        midpoint,
        originTime: invalidatedAt,
        displacementAtr: Number(dispAtr.toFixed(2)),
        valid: flippedInvalidated === null,
        mitigated: flippedTouches > 0,
        mitigationPercent: flippedTouches > 0 ? 50 : 0,
        touches: flippedTouches,
        interactionState:
          flippedInvalidated !== null
            ? 'Invalidated'
            : flippedTouches > 0
              ? 'Retesting'
              : 'Far Away',
        formationTime: invalidatedAt,
        confirmationTime: invalidatedAt,
        detectionTime: invalidatedAt,
        invalidationTime: flippedInvalidated,
        confirmationStatus: flippedInvalidated ? 'invalidated' : 'confirmed',
      });
    }
  }

  return blocks.slice(-24);
}
