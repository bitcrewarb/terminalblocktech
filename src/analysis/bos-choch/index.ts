import type {
  Candle,
  InstrumentSymbol,
  StructureBreak,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Detects BOS (Break of Structure), CHoCH (Change of Character), and MSS (Market Structure Shift)
 * chronologically without future lookahead.
 */
export function detectBosChoch(
  candles: Candle[],
  swings: SwingPoint[],
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  const method = settings.breakoutConfirmation;

  const processScope = (scope: 'external' | 'internal') => {
    const confirmedSwings = swings.filter(
      (s) => s.scope === scope && s.confirmationStatus === 'confirmed'
    );
    if (confirmedSwings.length === 0) return;

    let activeHigh: SwingPoint | null = null;
    let activeLow: SwingPoint | null = null;
    let currentBias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let swingIdx = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c.isClosed && method === 'close') continue;

      // Only make swings visible AFTER their confirmationTime has elapsed (non-repainting!)
      while (
        swingIdx < confirmedSwings.length &&
        (confirmedSwings[swingIdx].confirmationTime ?? Infinity) <= c.time
      ) {
        const s = confirmedSwings[swingIdx];
        if (s.kind === 'high') activeHigh = s;
        else activeLow = s;
        swingIdx++;
      }

      if (activeHigh) {
        const breached = method === 'close' ? c.close > activeHigh.price : c.high > activeHigh.price;
        if (breached) {
          const isReversal = currentBias === 'bearish';
          const type: StructureBreak['type'] = isReversal
            ? scope === 'external'
              ? 'MSS'
              : 'CHoCH'
            : 'BOS';
          breaks.push({
            id: `${symbol}:${timeframe}:break:${scope}:${type}:bullish:${c.time}`,
            symbol,
            timeframe,
            type,
            direction: 'bullish',
            scope,
            levelPrice: activeHigh.price,
            originTime: activeHigh.candleTime,
            breakTime: c.time,
            breakMethod: method,
            swingPointId: activeHigh.id,
            formationTime: activeHigh.candleTime,
            confirmationTime: c.isClosed ? c.time : null,
            detectionTime: c.time,
            invalidationTime: null,
            confirmationStatus: c.isClosed ? 'confirmed' : 'provisional',
          });
          if (isReversal && scope === 'external') {
            // Also record explicit CHoCH tag if external reversal
            breaks.push({
              id: `${symbol}:${timeframe}:break:${scope}:CHoCH:bullish:${c.time}`,
              symbol,
              timeframe,
              type: 'CHoCH',
              direction: 'bullish',
              scope,
              levelPrice: activeHigh.price,
              originTime: activeHigh.candleTime,
              breakTime: c.time,
              breakMethod: method,
              swingPointId: activeHigh.id,
              formationTime: activeHigh.candleTime,
              confirmationTime: c.isClosed ? c.time : null,
              detectionTime: c.time,
              invalidationTime: null,
              confirmationStatus: c.isClosed ? 'confirmed' : 'provisional',
            });
          }
          currentBias = 'bullish';
          activeHigh = null;
        }
      }

      if (activeLow) {
        const breached = method === 'close' ? c.close < activeLow.price : c.low < activeLow.price;
        if (breached) {
          const isReversal = currentBias === 'bullish';
          const type: StructureBreak['type'] = isReversal
            ? scope === 'external'
              ? 'MSS'
              : 'CHoCH'
            : 'BOS';
          breaks.push({
            id: `${symbol}:${timeframe}:break:${scope}:${type}:bearish:${c.time}`,
            symbol,
            timeframe,
            type,
            direction: 'bearish',
            scope,
            levelPrice: activeLow.price,
            originTime: activeLow.candleTime,
            breakTime: c.time,
            breakMethod: method,
            swingPointId: activeLow.id,
            formationTime: activeLow.candleTime,
            confirmationTime: c.isClosed ? c.time : null,
            detectionTime: c.time,
            invalidationTime: null,
            confirmationStatus: c.isClosed ? 'confirmed' : 'provisional',
          });
          if (isReversal && scope === 'external') {
            breaks.push({
              id: `${symbol}:${timeframe}:break:${scope}:CHoCH:bearish:${c.time}`,
              symbol,
              timeframe,
              type: 'CHoCH',
              direction: 'bearish',
              scope,
              levelPrice: activeLow.price,
              originTime: activeLow.candleTime,
              breakTime: c.time,
              breakMethod: method,
              swingPointId: activeLow.id,
              formationTime: activeLow.candleTime,
              confirmationTime: c.isClosed ? c.time : null,
              detectionTime: c.time,
              invalidationTime: null,
              confirmationStatus: c.isClosed ? 'confirmed' : 'provisional',
            });
          }
          currentBias = 'bearish';
          activeLow = null;
        }
      }
    }
  };

  processScope('external');
  processScope('internal');

  return breaks.sort((a, b) => a.breakTime - b.breakTime);
}
