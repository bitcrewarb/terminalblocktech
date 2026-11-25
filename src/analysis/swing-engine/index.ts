import type {
  Candle,
  InstrumentSymbol,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Computes Wilder-smoothed or simple ATR series and latest ATR value.
 */
export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) {
    return candles[0] ? Math.max(1e-8, candles[0].high - candles[0].low) : 1;
  }
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
  return Math.max(1e-8, avg);
}

export function computeAverageVolume(candles: Candle[], period = 20): number {
  if (candles.length === 0) return 0;
  const slice = candles.slice(-period);
  return slice.reduce((acc, c) => acc + c.volume, 0) / slice.length;
}

/**
 * Non-repainting swing high/low detector.
 * A swing at index `i` is ONLY confirmed when `rightBars` closed candles exist after `i`
 * (i.e. i + rightBars <= lastClosedIndex). If fewer closed bars exist (but >= 1),
 * it may be emitted as `provisional` when settings.showProvisional is true.
 */
export function detectSwingPoints(
  candles: Candle[],
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): SwingPoint[] {
  const closedCount = candles.filter((c) => c.isClosed).length;
  const left = Math.max(2, settings.swingSensitivity);
  const rightConfirm = Math.max(1, settings.pivotConfirmationCandles);
  const internalLeft = Math.max(2, Math.floor(left / 2));

  const swings: SwingPoint[] = [];

  const scan = (lookbackLeft: number, scope: 'external' | 'internal') => {
    for (let i = lookbackLeft; i < candles.length; i++) {
      const candidate = candles[i];
      const closedRightBars = Math.max(0, closedCount - 1 - i);
      const maxCheckRight = Math.min(lookbackLeft, candles.length - 1 - i);

      if (maxCheckRight < 1) continue;

      let isHigh = true;
      let isLow = true;

      for (let j = i - lookbackLeft; j < i; j++) {
        if (candles[j].high >= candidate.high) isHigh = false;
        if (candles[j].low <= candidate.low) isLow = false;
      }

      for (let j = i + 1; j <= i + maxCheckRight; j++) {
        if (candles[j].high > candidate.high) isHigh = false;
        if (candles[j].low < candidate.low) isLow = false;
      }

      if (!isHigh && !isLow) continue;

      const isConfirmed = closedRightBars >= rightConfirm && maxCheckRight >= rightConfirm;
      if (!isConfirmed && !settings.showProvisional) continue;

      const confirmationCandleIdx = Math.min(candles.length - 1, i + rightConfirm);
      const confirmationTime = isConfirmed ? candles[confirmationCandleIdx].time : null;
      const detectionTime = confirmationTime ?? candles[candles.length - 1].time;

      if (isHigh) {
        swings.push({
          id: `${symbol}:${timeframe}:swing:${scope}:high:${candidate.time}`,
          symbol,
          timeframe,
          kind: 'high',
          structureLabel: 'SH',
          scope,
          price: candidate.high,
          candleTime: candidate.time,
          candleIndex: i,
          formationTime: candidate.time,
          confirmationTime,
          detectionTime,
          invalidationTime: null,
          confirmationStatus: isConfirmed ? 'confirmed' : 'provisional',
        });
      }

      if (isLow) {
        swings.push({
          id: `${symbol}:${timeframe}:swing:${scope}:low:${candidate.time}`,
          symbol,
          timeframe,
          kind: 'low',
          structureLabel: 'SL',
          scope,
          price: candidate.low,
          candleTime: candidate.time,
          candleIndex: i,
          formationTime: candidate.time,
          confirmationTime,
          detectionTime,
          invalidationTime: null,
          confirmationStatus: isConfirmed ? 'confirmed' : 'provisional',
        });
      }
    }
  };

  scan(left, 'external');
  if (internalLeft < left) {
    scan(internalLeft, 'internal');
  }

  return swings.sort((a, b) => a.candleIndex - b.candleIndex);
}
