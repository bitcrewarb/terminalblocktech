import type {
  Candle,
  InstrumentSymbol,
  LiquidityPool,
  SessionAnchors,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Detects Buy-Side Liquidity, Sell-Side Liquidity, Equal Highs/Lows,
 * Internal/External Liquidity, Inducement, PDH/PDL/PWH/PWL, and Sweeps / Stop Hunts / Runs.
 */
export function detectLiquidityPools(
  candles: Candle[],
  swings: SwingPoint[],
  anchors: SessionAnchors,
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): LiquidityPool[] {
  if (candles.length < 15) return [];

  const tol = Math.max(1e-8, atr * settings.liquidityToleranceAtr);
  const pools: LiquidityPool[] = [];
  const confirmedHighs = swings.filter(
    (s) => s.kind === 'high' && s.confirmationStatus === 'confirmed'
  );
  const confirmedLows = swings.filter(
    (s) => s.kind === 'low' && s.confirmationStatus === 'confirmed'
  );

  const inspectSweep = (
    price: number,
    upper: number,
    lower: number,
    afterTime: number,
    side: 'high' | 'low'
  ): {
    swept: boolean;
    sweepTime: number | null;
    sweepType: LiquidityPool['sweepType'];
  } => {
    for (const c of candles) {
      if (c.time <= afterTime) continue;
      if (side === 'high') {
        if (c.high > upper) {
          const sweptAndReversed = c.close <= price;
          return {
            swept: true,
            sweepTime: c.time,
            sweepType: sweptAndReversed ? 'stop_hunt' : c.close > upper ? 'liquidity_run' : 'sweep',
          };
        }
      } else {
        if (c.low < lower) {
          const sweptAndReversed = c.close >= price;
          return {
            swept: true,
            sweepTime: c.time,
            sweepType: sweptAndReversed ? 'stop_hunt' : c.close < lower ? 'liquidity_run' : 'sweep',
          };
        }
      }
    }
    return { swept: false, sweepTime: null, sweepType: null };
  };

  // 1. Equal Highs (EQH) & Equal Lows (EQL)
  for (let i = 0; i < confirmedHighs.length; i++) {
    const a = confirmedHighs[i];
    for (let j = i + 1; j < confirmedHighs.length; j++) {
      const b = confirmedHighs[j];
      if (Math.abs(a.price - b.price) <= tol && b.candleIndex - a.candleIndex >= 3) {
        const level = (a.price + b.price) / 2;
        const upper = Math.max(a.price, b.price) + tol * 0.2;
        const lower = Math.min(a.price, b.price) - tol * 0.2;
        const sweep = inspectSweep(level, upper, lower, b.candleTime, 'high');
        pools.push({
          id: `${symbol}:${timeframe}:liq:eqh:${a.candleTime}:${b.candleTime}`,
          symbol,
          timeframe,
          kind: 'equal_highs',
          label: 'EQH (Buy-Side)',
          price: level,
          upper,
          lower,
          originTimes: [a.candleTime, b.candleTime],
          swept: sweep.swept,
          sweepTime: sweep.sweepTime,
          sweepType: sweep.sweepType,
          interactionState: sweep.swept ? 'Mitigated' : 'Far Away',
          formationTime: a.candleTime,
          confirmationTime: b.confirmationTime,
          detectionTime: b.detectionTime,
          invalidationTime: sweep.sweepTime,
          confirmationStatus: 'confirmed',
        });
        break;
      }
    }
  }

  for (let i = 0; i < confirmedLows.length; i++) {
    const a = confirmedLows[i];
    for (let j = i + 1; j < confirmedLows.length; j++) {
      const b = confirmedLows[j];
      if (Math.abs(a.price - b.price) <= tol && b.candleIndex - a.candleIndex >= 3) {
        const level = (a.price + b.price) / 2;
        const upper = Math.max(a.price, b.price) + tol * 0.2;
        const lower = Math.min(a.price, b.price) - tol * 0.2;
        const sweep = inspectSweep(level, upper, lower, b.candleTime, 'low');
        pools.push({
          id: `${symbol}:${timeframe}:liq:eql:${a.candleTime}:${b.candleTime}`,
          symbol,
          timeframe,
          kind: 'equal_lows',
          label: 'EQL (Sell-Side)',
          price: level,
          upper,
          lower,
          originTimes: [a.candleTime, b.candleTime],
          swept: sweep.swept,
          sweepTime: sweep.sweepTime,
          sweepType: sweep.sweepType,
          interactionState: sweep.swept ? 'Mitigated' : 'Far Away',
          formationTime: a.candleTime,
          confirmationTime: b.confirmationTime,
          detectionTime: b.detectionTime,
          invalidationTime: sweep.sweepTime,
          confirmationStatus: 'confirmed',
        });
        break;
      }
    }
  }

  // 2. External & Internal Buy-Side / Sell-Side Swings + Inducement
  const recentHighs = confirmedHighs.slice(-6);
  for (const h of recentHighs) {
    const isExternal = h.scope === 'external';
    const sweep = inspectSweep(h.price, h.price + tol * 0.15, h.price - tol * 0.15, h.candleTime, 'high');
    const kind: LiquidityPool['kind'] = isExternal
      ? 'buy_side'
      : h.structureLabel === 'LH'
        ? 'inducement'
        : 'internal';
    pools.push({
      id: `${symbol}:${timeframe}:liq:${kind}:${h.candleTime}`,
      symbol,
      timeframe,
      kind,
      label:
        kind === 'buy_side'
          ? 'BSL (External)'
          : kind === 'inducement'
            ? 'IDM High'
            : 'Internal BSL',
      price: h.price,
      upper: h.price + tol * 0.15,
      lower: h.price - tol * 0.15,
      originTimes: [h.candleTime],
      swept: sweep.swept,
      sweepTime: sweep.sweepTime,
      sweepType: sweep.sweepType,
      interactionState: sweep.swept ? 'Mitigated' : 'Far Away',
      formationTime: h.candleTime,
      confirmationTime: h.confirmationTime,
      detectionTime: h.detectionTime,
      invalidationTime: sweep.sweepTime,
      confirmationStatus: 'confirmed',
    });
  }

  const recentLows = confirmedLows.slice(-6);
  for (const l of recentLows) {
    const isExternal = l.scope === 'external';
    const sweep = inspectSweep(l.price, l.price + tol * 0.15, l.price - tol * 0.15, l.candleTime, 'low');
    const kind: LiquidityPool['kind'] = isExternal
      ? 'sell_side'
      : l.structureLabel === 'HL'
        ? 'inducement'
        : 'internal';
    pools.push({
      id: `${symbol}:${timeframe}:liq:${kind}:${l.candleTime}`,
      symbol,
      timeframe,
      kind,
      label:
        kind === 'sell_side'
          ? 'SSL (External)'
          : kind === 'inducement'
            ? 'IDM Low'
            : 'Internal SSL',
      price: l.price,
      upper: l.price + tol * 0.15,
      lower: l.price - tol * 0.15,
      originTimes: [l.candleTime],
      swept: sweep.swept,
      sweepTime: sweep.sweepTime,
      sweepType: sweep.sweepType,
      interactionState: sweep.swept ? 'Mitigated' : 'Far Away',
      formationTime: l.candleTime,
      confirmationTime: l.confirmationTime,
      detectionTime: l.detectionTime,
      invalidationTime: sweep.sweepTime,
      confirmationStatus: 'confirmed',
    });
  }

  // 3. Previous Day / Previous Week Liquidity
  const latestTime = candles[candles.length - 1].time;
  const firstTime = candles[0].time;
  const addAnchor = (
    price: number | null,
    kind: 'pdh' | 'pdl' | 'pwh' | 'pwl',
    label: string,
    side: 'high' | 'low'
  ) => {
    if (price === null || !Number.isFinite(price)) return;
    const sweep = inspectSweep(price, price + tol * 0.15, price - tol * 0.15, firstTime, side);
    pools.push({
      id: `${symbol}:${timeframe}:liq:${kind}`,
      symbol,
      timeframe,
      kind,
      label,
      price,
      upper: price + tol * 0.15,
      lower: price - tol * 0.15,
      originTimes: [firstTime],
      swept: sweep.swept,
      sweepTime: sweep.sweepTime,
      sweepType: sweep.sweepType,
      interactionState: sweep.swept ? 'Mitigated' : 'Far Away',
      formationTime: firstTime,
      confirmationTime: firstTime,
      detectionTime: latestTime,
      invalidationTime: sweep.sweepTime,
      confirmationStatus: 'confirmed',
    });
  };

  addAnchor(anchors.prevDayHigh, 'pdh', 'PDH Liquidity', 'high');
  addAnchor(anchors.prevDayLow, 'pdl', 'PDL Liquidity', 'low');
  addAnchor(anchors.prevWeekHigh, 'pwh', 'PWH Liquidity', 'high');
  addAnchor(anchors.prevWeekLow, 'pwl', 'PWL Liquidity', 'low');

  return pools;
}
