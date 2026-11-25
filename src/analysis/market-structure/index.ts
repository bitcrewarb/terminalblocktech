import type {
  InstrumentSymbol,
  MarketStructureState,
  StructureBreak,
  SwingPoint,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Labels swing highs and lows as HH, HL, LH, LL chronologically (non-repainting).
 */
export function labelSwingStructure(
  swings: SwingPoint[],
  symbol: InstrumentSymbol,
  timeframe: Timeframe
): {
  labeledSwings: SwingPoint[];
  externalTrend: 'bullish' | 'bearish' | 'consolidation';
  internalTrend: 'bullish' | 'bearish' | 'consolidation';
  lastExternalLabel: MarketStructureState['lastExternalLabel'];
  lastInternalLabel: MarketStructureState['lastInternalLabel'];
} {
  const processScope = (scope: 'external' | 'internal') => {
    const scoped = swings.filter((s) => s.scope === scope);
    let prevHigh: number | null = null;
    let prevLow: number | null = null;
    let lastHighLabel: 'HH' | 'LH' | null = null;
    let lastLowLabel: 'HL' | 'LL' | null = null;
    let lastLabel: MarketStructureState['lastExternalLabel'] = 'NONE';

    const out: SwingPoint[] = scoped.map((s) => {
      let label = s.structureLabel;
      if (s.kind === 'high') {
        if (prevHigh !== null) {
          label = s.price > prevHigh ? 'HH' : 'LH';
          lastHighLabel = label;
          lastLabel = label;
        }
        prevHigh = s.price;
      } else {
        if (prevLow !== null) {
          label = s.price > prevLow ? 'HL' : 'LL';
          lastLowLabel = label;
          lastLabel = label;
        }
        prevLow = s.price;
      }
      return { ...s, structureLabel: label };
    });

    let trend: 'bullish' | 'bearish' | 'consolidation' = 'consolidation';
    if (lastHighLabel === 'HH' && lastLowLabel === 'HL') trend = 'bullish';
    else if (lastHighLabel === 'LH' && lastLowLabel === 'LL') trend = 'bearish';
    else if (lastHighLabel === 'HH' && prevLow !== null) trend = 'bullish';
    else if (lastLowLabel === 'LL' && prevHigh !== null) trend = 'bearish';

    return { out, trend, lastLabel };
  };

  const ext = processScope('external');
  const int = processScope('internal');

  const combined = [...ext.out, ...int.out].sort((a, b) => a.candleIndex - b.candleIndex);
  return {
    labeledSwings: combined,
    externalTrend: ext.trend,
    internalTrend: int.trend === 'consolidation' ? ext.trend : int.trend,
    lastExternalLabel: ext.lastLabel,
    lastInternalLabel: int.lastLabel,
  };
}

export function buildMarketStructureState(
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  swings: SwingPoint[],
  breaks: StructureBreak[]
): MarketStructureState {
  const { labeledSwings, externalTrend, internalTrend, lastExternalLabel, lastInternalLabel } =
    labelSwingStructure(swings, symbol, timeframe);

  const extHighs = labeledSwings.filter(
    (s) => s.scope === 'external' && s.kind === 'high' && s.confirmationStatus === 'confirmed'
  );
  const extLows = labeledSwings.filter(
    (s) => s.scope === 'external' && s.kind === 'low' && s.confirmationStatus === 'confirmed'
  );

  // Use latest confirmed structure breaks to refine active trend
  const latestExtBreak = [...breaks].reverse().find((b) => b.scope === 'external');
  const refinedTrend = latestExtBreak ? latestExtBreak.direction : externalTrend;

  const latestIntBreak = [...breaks].reverse().find((b) => b.scope === 'internal');
  const refinedInternal = latestIntBreak ? latestIntBreak.direction : internalTrend;

  return {
    symbol,
    timeframe,
    trend: refinedTrend,
    internalTrend: refinedInternal,
    lastExternalLabel,
    lastInternalLabel,
    swings: labeledSwings,
    breaks,
    currentRangeHigh: extHighs.length > 0 ? extHighs[extHighs.length - 1].price : null,
    currentRangeLow: extLows.length > 0 ? extLows[extLows.length - 1].price : null,
  };
}
