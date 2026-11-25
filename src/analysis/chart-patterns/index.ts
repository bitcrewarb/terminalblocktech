import type {
  Candle,
  ChartPattern,
  ChartPatternPoint,
  ChartPatternStatus,
  InstrumentSymbol,
  SwingPoint,
  TechnicalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Deterministic Classical Chart Pattern Recognition Engine covering all 19 formations:
 * - Head and Shoulders / Inverse Head and Shoulders
 * - Double Top / Double Bottom / Triple Top / Triple Bottom
 * - Ascending / Descending / Symmetrical Triangles
 * - Rising / Falling Wedges
 * - Bullish / Bearish Flags & Pennants
 * - Rectangle
 * - Cup and Handle
 * - Rounding Bottom / Rounding Top
 *
 * Strictly enforces Forming -> Confirmed -> Breakout -> Retest -> Invalidated lifecycle.
 */
export function detectChartPatterns(
  candles: Candle[],
  swings: SwingPoint[],
  atr: number,
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  settings: TechnicalSettings
): ChartPattern[] {
  if (candles.length < Math.max(25, settings.minChartPatternBars)) return [];

  const patterns: ChartPattern[] = [];
  const tol = Math.max(1e-8, atr * settings.liquidityToleranceAtr * 1.4);
  const confirmedHighs = swings.filter((s) => s.kind === 'high' && s.confirmationStatus === 'confirmed');
  const confirmedLows = swings.filter((s) => s.kind === 'low' && s.confirmationStatus === 'confirmed');
  const lastCandle = candles[candles.length - 1];

  const evaluateBreakoutState = (
    breakoutLevel: number,
    invalidationLevel: number,
    direction: 'bullish' | 'bearish',
    endTime: number,
    hasConfirmedPivotEnd: boolean
  ): {
    status: ChartPatternStatus;
    breakoutTime: number | null;
    retestTime: number | null;
    invalidationTime: number | null;
  } => {
    let breakoutTime: number | null = null;
    let retestTime: number | null = null;
    let invalidationTime: number | null = null;

    for (const c of candles) {
      if (c.time <= endTime || !c.isClosed) continue;
      if (!breakoutTime) {
        if (direction === 'bullish' && c.close > breakoutLevel) {
          breakoutTime = c.time;
        } else if (direction === 'bearish' && c.close < breakoutLevel) {
          breakoutTime = c.time;
        } else if (direction === 'bullish' && c.close < invalidationLevel) {
          invalidationTime = c.time;
          break;
        } else if (direction === 'bearish' && c.close > invalidationLevel) {
          invalidationTime = c.time;
          break;
        }
      } else {
        if (!retestTime && c.low <= breakoutLevel + tol && c.high >= breakoutLevel - tol) {
          retestTime = c.time;
        }
        if (direction === 'bullish' && c.close < invalidationLevel) {
          invalidationTime = c.time;
          break;
        }
        if (direction === 'bearish' && c.close > invalidationLevel) {
          invalidationTime = c.time;
          break;
        }
      }
    }

    if (invalidationTime) {
      return { status: 'Invalidated', breakoutTime, retestTime, invalidationTime };
    }
    if (retestTime) {
      return { status: 'Retest', breakoutTime, retestTime, invalidationTime: null };
    }
    if (breakoutTime) {
      return { status: 'Breakout', breakoutTime, retestTime: null, invalidationTime: null };
    }
    return {
      status: hasConfirmedPivotEnd ? 'Confirmed' : 'Forming',
      breakoutTime: null,
      retestTime: null,
      invalidationTime: null,
    };
  };

  // 1. Head & Shoulders / Inverse Head & Shoulders (using external or internal confirmed highs/lows)
  const extHighs = confirmedHighs.filter((s) => s.scope === 'external');
  const extLows = confirmedLows.filter((s) => s.scope === 'external');

  if (extHighs.length >= 3) {
    for (let i = 0; i <= extHighs.length - 3; i++) {
      const ls = extHighs[i];
      const head = extHighs[i + 1];
      const rs = extHighs[i + 2];
      if (
        head.price > ls.price + atr * 0.4 &&
        head.price > rs.price + atr * 0.4 &&
        Math.abs(ls.price - rs.price) <= atr * 1.4
      ) {
        const trough1 = candles
          .slice(ls.candleIndex, head.candleIndex + 1)
          .reduce((m, c) => (c.low < m.low ? c : m), candles[ls.candleIndex]);
        const trough2 = candles
          .slice(head.candleIndex, rs.candleIndex + 1)
          .reduce((m, c) => (c.low < m.low ? c : m), candles[head.candleIndex]);
        const necklinePrice = (trough1.low + trough2.low) / 2;
        const height = head.price - necklinePrice;
        const state = evaluateBreakoutState(necklinePrice, head.price, 'bearish', rs.candleTime, true);
        patterns.push({
          id: `${symbol}:${timeframe}:chart:hs:${ls.candleTime}:${rs.candleTime}`,
          symbol,
          timeframe,
          name: 'Head and Shoulders',
          direction: 'bearish',
          status: state.status,
          startTime: ls.candleTime,
          endTime: rs.candleTime,
          upperBoundary: [
            { time: ls.candleTime, price: ls.price, label: 'LS' },
            { time: head.candleTime, price: head.price, label: 'H' },
            { time: rs.candleTime, price: rs.price, label: 'RS' },
          ],
          lowerBoundary: [
            { time: trough1.time, price: trough1.low },
            { time: trough2.time, price: trough2.low },
          ],
          neckline: [
            { time: trough1.time, price: trough1.low },
            { time: lastCandle.time, price: trough2.low },
          ],
          breakoutLevel: necklinePrice,
          breakoutTime: state.breakoutTime,
          retestTime: state.retestTime,
          invalidationLevel: head.price,
          measuredTarget: necklinePrice - height,
          keyPoints: [
            { time: ls.candleTime, price: ls.price, label: 'LS' },
            { time: trough1.time, price: trough1.low },
            { time: head.candleTime, price: head.price, label: 'Head' },
            { time: trough2.time, price: trough2.low },
            { time: rs.candleTime, price: rs.price, label: 'RS' },
          ],
          qualityScore: 84,
          formationTime: ls.candleTime,
          confirmationTime: rs.confirmationTime,
          detectionTime: rs.detectionTime,
          invalidationTime: state.invalidationTime,
          confirmationStatus:
            state.status === 'Invalidated'
              ? 'invalidated'
              : state.status === 'Forming'
                ? 'provisional'
                : 'confirmed',
        });
      }
    }
  }

  if (extLows.length >= 3) {
    for (let i = 0; i <= extLows.length - 3; i++) {
      const ls = extLows[i];
      const head = extLows[i + 1];
      const rs = extLows[i + 2];
      if (
        head.price < ls.price - atr * 0.4 &&
        head.price < rs.price - atr * 0.4 &&
        Math.abs(ls.price - rs.price) <= atr * 1.4
      ) {
        const peak1 = candles
          .slice(ls.candleIndex, head.candleIndex + 1)
          .reduce((m, c) => (c.high > m.high ? c : m), candles[ls.candleIndex]);
        const peak2 = candles
          .slice(head.candleIndex, rs.candleIndex + 1)
          .reduce((m, c) => (c.high > m.high ? c : m), candles[head.candleIndex]);
        const necklinePrice = (peak1.high + peak2.high) / 2;
        const height = necklinePrice - head.price;
        const state = evaluateBreakoutState(necklinePrice, head.price, 'bullish', rs.candleTime, true);
        patterns.push({
          id: `${symbol}:${timeframe}:chart:ihs:${ls.candleTime}:${rs.candleTime}`,
          symbol,
          timeframe,
          name: 'Inverse Head and Shoulders',
          direction: 'bullish',
          status: state.status,
          startTime: ls.candleTime,
          endTime: rs.candleTime,
          upperBoundary: [
            { time: peak1.time, price: peak1.high },
            { time: peak2.time, price: peak2.high },
          ],
          lowerBoundary: [
            { time: ls.candleTime, price: ls.price, label: 'LS' },
            { time: head.candleTime, price: head.price, label: 'H' },
            { time: rs.candleTime, price: rs.price, label: 'RS' },
          ],
          neckline: [
            { time: peak1.time, price: peak1.high },
            { time: lastCandle.time, price: peak2.high },
          ],
          breakoutLevel: necklinePrice,
          breakoutTime: state.breakoutTime,
          retestTime: state.retestTime,
          invalidationLevel: head.price,
          measuredTarget: necklinePrice + height,
          keyPoints: [
            { time: ls.candleTime, price: ls.price, label: 'LS' },
            { time: peak1.time, price: peak1.high },
            { time: head.candleTime, price: head.price, label: 'Head' },
            { time: peak2.time, price: peak2.high },
            { time: rs.candleTime, price: rs.price, label: 'RS' },
          ],
          qualityScore: 84,
          formationTime: ls.candleTime,
          confirmationTime: rs.confirmationTime,
          detectionTime: rs.detectionTime,
          invalidationTime: state.invalidationTime,
          confirmationStatus:
            state.status === 'Invalidated'
              ? 'invalidated'
              : state.status === 'Forming'
                ? 'provisional'
                : 'confirmed',
        });
      }
    }
  }

  // 2. Double Top / Triple Top & Double Bottom / Triple Bottom
  for (let i = 0; i < extHighs.length - 1; i++) {
    const p1 = extHighs[i];
    const p2 = extHighs[i + 1];
    if (Math.abs(p1.price - p2.price) <= tol && p2.candleIndex - p1.candleIndex >= 6) {
      const p3 = extHighs[i + 2];
      const isTriple =
        p3 && Math.abs(p3.price - p1.price) <= tol && p3.candleIndex - p2.candleIndex >= 5;
      const endSwing = isTriple ? p3 : p2;
      const trough = candles
        .slice(p1.candleIndex, endSwing.candleIndex + 1)
        .reduce((m, c) => (c.low < m.low ? c : m), candles[p1.candleIndex]);
      const height = Math.max(p1.price, endSwing.price) - trough.low;
      if (height < atr * 0.8) continue;

      const state = evaluateBreakoutState(
        trough.low,
        Math.max(p1.price, endSwing.price) + atr * 0.3,
        'bearish',
        endSwing.candleTime,
        true
      );
      patterns.push({
        id: `${symbol}:${timeframe}:chart:${isTriple ? 'tt' : 'dt'}:${p1.candleTime}:${endSwing.candleTime}`,
        symbol,
        timeframe,
        name: isTriple ? 'Triple Top' : 'Double Top',
        direction: 'bearish',
        status: state.status,
        startTime: p1.candleTime,
        endTime: endSwing.candleTime,
        upperBoundary: isTriple
          ? [
              { time: p1.candleTime, price: p1.price, label: 'T1' },
              { time: p2.candleTime, price: p2.price, label: 'T2' },
              { time: p3.candleTime, price: p3.price, label: 'T3' },
            ]
          : [
              { time: p1.candleTime, price: p1.price, label: 'T1' },
              { time: p2.candleTime, price: p2.price, label: 'T2' },
            ],
        lowerBoundary: [
          { time: p1.candleTime, price: trough.low },
          { time: endSwing.candleTime, price: trough.low },
        ],
        neckline: [
          { time: trough.time, price: trough.low },
          { time: lastCandle.time, price: trough.low },
        ],
        breakoutLevel: trough.low,
        breakoutTime: state.breakoutTime,
        retestTime: state.retestTime,
        invalidationLevel: Math.max(p1.price, endSwing.price),
        measuredTarget: trough.low - height,
        keyPoints: [
          { time: p1.candleTime, price: p1.price, label: 'T1' },
          { time: trough.time, price: trough.low, label: 'NL' },
          { time: p2.candleTime, price: p2.price, label: 'T2' },
        ],
        qualityScore: isTriple ? 86 : 80,
        formationTime: p1.candleTime,
        confirmationTime: endSwing.confirmationTime,
        detectionTime: endSwing.detectionTime,
        invalidationTime: state.invalidationTime,
        confirmationStatus: state.status === 'Invalidated' ? 'invalidated' : 'confirmed',
      });
      if (isTriple) i++;
    }
  }

  for (let i = 0; i < extLows.length - 1; i++) {
    const p1 = extLows[i];
    const p2 = extLows[i + 1];
    if (Math.abs(p1.price - p2.price) <= tol && p2.candleIndex - p1.candleIndex >= 6) {
      const p3 = extLows[i + 2];
      const isTriple =
        p3 && Math.abs(p3.price - p1.price) <= tol && p3.candleIndex - p2.candleIndex >= 5;
      const endSwing = isTriple ? p3 : p2;
      const peak = candles
        .slice(p1.candleIndex, endSwing.candleIndex + 1)
        .reduce((m, c) => (c.high > m.high ? c : m), candles[p1.candleIndex]);
      const height = peak.high - Math.min(p1.price, endSwing.price);
      if (height < atr * 0.8) continue;

      const state = evaluateBreakoutState(
        peak.high,
        Math.min(p1.price, endSwing.price) - atr * 0.3,
        'bullish',
        endSwing.candleTime,
        true
      );
      patterns.push({
        id: `${symbol}:${timeframe}:chart:${isTriple ? 'tb' : 'db'}:${p1.candleTime}:${endSwing.candleTime}`,
        symbol,
        timeframe,
        name: isTriple ? 'Triple Bottom' : 'Double Bottom',
        direction: 'bullish',
        status: state.status,
        startTime: p1.candleTime,
        endTime: endSwing.candleTime,
        upperBoundary: [
          { time: p1.candleTime, price: peak.high },
          { time: endSwing.candleTime, price: peak.high },
        ],
        lowerBoundary: isTriple
          ? [
              { time: p1.candleTime, price: p1.price, label: 'B1' },
              { time: p2.candleTime, price: p2.price, label: 'B2' },
              { time: p3.candleTime, price: p3.price, label: 'B3' },
            ]
          : [
              { time: p1.candleTime, price: p1.price, label: 'B1' },
              { time: p2.candleTime, price: p2.price, label: 'B2' },
            ],
        neckline: [
          { time: peak.time, price: peak.high },
          { time: lastCandle.time, price: peak.high },
        ],
        breakoutLevel: peak.high,
        breakoutTime: state.breakoutTime,
        retestTime: state.retestTime,
        invalidationLevel: Math.min(p1.price, endSwing.price),
        measuredTarget: peak.high + height,
        keyPoints: [
          { time: p1.candleTime, price: p1.price, label: 'B1' },
          { time: peak.time, price: peak.high, label: 'NL' },
          { time: p2.candleTime, price: p2.price, label: 'B2' },
        ],
        qualityScore: isTriple ? 86 : 80,
        formationTime: p1.candleTime,
        confirmationTime: endSwing.confirmationTime,
        detectionTime: endSwing.detectionTime,
        invalidationTime: state.invalidationTime,
        confirmationStatus: state.status === 'Invalidated' ? 'invalidated' : 'confirmed',
      });
      if (isTriple) i++;
    }
  }

  // 3. Triangles, Wedges, Rectangles from recent regression of confirmed highs & lows
  const recentHighs = confirmedHighs.slice(-4);
  const recentLows = confirmedLows.slice(-4);
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const startIdx = Math.min(recentHighs[0].candleIndex, recentLows[0].candleIndex);
    const endIdx = Math.max(
      recentHighs[recentHighs.length - 1].candleIndex,
      recentLows[recentLows.length - 1].candleIndex
    );
    const spanBars = endIdx - startIdx;
    if (spanBars >= settings.minChartPatternBars) {
      const upperReg = linearRegression(
        recentHighs.map((h) => ({ x: h.candleIndex, y: h.price }))
      );
      const lowerReg = linearRegression(
        recentLows.map((l) => ({ x: l.candleIndex, y: l.price }))
      );

      const uSlopeNorm = upperReg.slope / Math.max(1e-8, atr);
      const lSlopeNorm = lowerReg.slope / Math.max(1e-8, atr);
      const flatThresh = 0.03;

      let geomName: ChartPattern['name'] | null = null;
      let direction: ChartPattern['direction'] = 'neutral';

      if (Math.abs(uSlopeNorm) < flatThresh && Math.abs(lSlopeNorm) < flatThresh) {
        geomName = 'Rectangle';
        direction = 'neutral';
      } else if (Math.abs(uSlopeNorm) < flatThresh && lSlopeNorm > flatThresh) {
        geomName = 'Ascending Triangle';
        direction = 'bullish';
      } else if (uSlopeNorm < -flatThresh && Math.abs(lSlopeNorm) < flatThresh) {
        geomName = 'Descending Triangle';
        direction = 'bearish';
      } else if (uSlopeNorm < -flatThresh && lSlopeNorm > flatThresh) {
        geomName = spanBars < 24 ? 'Bullish Pennant' : 'Symmetrical Triangle';
        direction = candles[startIdx].close > candles[Math.max(0, startIdx - 10)].close ? 'bullish' : 'bearish';
        if (geomName === 'Bullish Pennant' && direction === 'bearish') {
          geomName = 'Bearish Pennant';
        }
      } else if (uSlopeNorm > flatThresh && lSlopeNorm > uSlopeNorm * 1.15) {
        geomName = 'Rising Wedge';
        direction = 'bearish';
      } else if (lSlopeNorm < -flatThresh && uSlopeNorm < lSlopeNorm * 1.15) {
        geomName = 'Falling Wedge';
        direction = 'bullish';
      } else if (uSlopeNorm < -flatThresh && lSlopeNorm < -flatThresh && candles[startIdx].close > candles[Math.max(0, startIdx - 12)].close + atr * 2) {
        geomName = 'Bullish Flag';
        direction = 'bullish';
      } else if (uSlopeNorm > flatThresh && lSlopeNorm > flatThresh && candles[startIdx].close < candles[Math.max(0, startIdx - 12)].close - atr * 2) {
        geomName = 'Bearish Flag';
        direction = 'bearish';
      }

      if (geomName) {
        const tStart = candles[startIdx].time;
        const tEnd = candles[endIdx].time;
        const uStart = upperReg.intercept + upperReg.slope * startIdx;
        const uEnd = upperReg.intercept + upperReg.slope * endIdx;
        const lStart = lowerReg.intercept + lowerReg.slope * startIdx;
        const lEnd = lowerReg.intercept + lowerReg.slope * endIdx;

        if (uEnd > lEnd) {
          const breakoutLvl = direction === 'bearish' ? lEnd : uEnd;
          const invLvl = direction === 'bearish' ? uEnd : lEnd;
          const height = Math.abs(uStart - lStart);
          const state = evaluateBreakoutState(
            breakoutLvl,
            invLvl,
            direction === 'neutral' ? 'bullish' : direction,
            tEnd,
            true
          );

          patterns.push({
            id: `${symbol}:${timeframe}:chart:${geomName.replace(/\s+/g, '_')}:${tStart}`,
            symbol,
            timeframe,
            name: geomName,
            direction,
            status: state.status,
            startTime: tStart,
            endTime: tEnd,
            upperBoundary: [
              { time: tStart, price: uStart },
              { time: tEnd, price: uEnd },
            ],
            lowerBoundary: [
              { time: tStart, price: lStart },
              { time: tEnd, price: lEnd },
            ],
            breakoutLevel: breakoutLvl,
            breakoutTime: state.breakoutTime,
            retestTime: state.retestTime,
            invalidationLevel: invLvl,
            measuredTarget:
              direction === 'bearish' ? breakoutLvl - height : breakoutLvl + height,
            keyPoints: [
              ...recentHighs.map((h) => ({ time: h.candleTime, price: h.price })),
              ...recentLows.map((l) => ({ time: l.candleTime, price: l.price })),
            ],
            qualityScore: 79,
            formationTime: tStart,
            confirmationTime: candles[Math.min(candles.length - 1, endIdx)].time,
            detectionTime: candles[Math.min(candles.length - 1, endIdx)].time,
            invalidationTime: state.invalidationTime,
            confirmationStatus: state.status === 'Invalidated' ? 'invalidated' : 'confirmed',
          });
        }
      }
    }
  }

  // 4. Rounding Bottom / Rounding Top / Cup and Handle on macro window (last 60..140 bars)
  if (candles.length >= 65) {
    const win = candles.slice(-80);
    const q1 = win.slice(0, 20);
    const mid = win.slice(25, 55);
    const q3 = win.slice(60);
    const leftHigh = Math.max(...q1.map((c) => c.high));
    const rightHigh = Math.max(...q3.map((c) => c.high));
    const midLow = Math.min(...mid.map((c) => c.low));
    const leftLow = Math.min(...q1.map((c) => c.low));
    const rightLow = Math.min(...q3.map((c) => c.low));
    const midHigh = Math.max(...mid.map((c) => c.high));

    if (
      Math.abs(leftHigh - rightHigh) <= atr * 1.6 &&
      leftHigh - midLow >= atr * 3.0 &&
      midLow < leftLow &&
      midLow < rightLow
    ) {
      const hasHandle = win[win.length - 1].close < rightHigh && win[win.length - 1].close > (rightHigh + midLow) / 2;
      const name: ChartPattern['name'] = hasHandle ? 'Cup and Handle' : 'Rounding Bottom';
      const rim = Math.max(leftHigh, rightHigh);
      const state = evaluateBreakoutState(rim, midLow, 'bullish', win[win.length - 1].time, false);
      const curvePts: ChartPatternPoint[] = [
        { time: q1[0].time, price: leftHigh },
        { time: mid[Math.floor(mid.length / 2)].time, price: midLow },
        { time: q3[q3.length - 1].time, price: rightHigh },
      ];
      patterns.push({
        id: `${symbol}:${timeframe}:chart:${name.replace(/\s+/g, '_')}:${win[0].time}`,
        symbol,
        timeframe,
        name,
        direction: 'bullish',
        status: state.status,
        startTime: win[0].time,
        endTime: win[win.length - 1].time,
        upperBoundary: [
          { time: win[0].time, price: rim },
          { time: win[win.length - 1].time, price: rim },
        ],
        lowerBoundary: curvePts,
        neckline: [
          { time: win[0].time, price: rim },
          { time: win[win.length - 1].time, price: rim },
        ],
        breakoutLevel: rim,
        breakoutTime: state.breakoutTime,
        retestTime: state.retestTime,
        invalidationLevel: midLow,
        measuredTarget: rim + (rim - midLow),
        keyPoints: curvePts,
        qualityScore: 76,
        formationTime: win[0].time,
        confirmationTime: state.breakoutTime,
        detectionTime: win[win.length - 1].time,
        invalidationTime: state.invalidationTime,
        confirmationStatus: state.breakoutTime ? 'confirmed' : 'provisional',
      });
    } else if (
      Math.abs(leftLow - rightLow) <= atr * 1.6 &&
      midHigh - leftLow >= atr * 3.0 &&
      midHigh > leftHigh &&
      midHigh > rightHigh
    ) {
      const rim = Math.min(leftLow, rightLow);
      const state = evaluateBreakoutState(rim, midHigh, 'bearish', win[win.length - 1].time, false);
      const curvePts: ChartPatternPoint[] = [
        { time: q1[0].time, price: leftLow },
        { time: mid[Math.floor(mid.length / 2)].time, price: midHigh },
        { time: q3[q3.length - 1].time, price: rightLow },
      ];
      patterns.push({
        id: `${symbol}:${timeframe}:chart:Rounding_Top:${win[0].time}`,
        symbol,
        timeframe,
        name: 'Rounding Top',
        direction: 'bearish',
        status: state.status,
        startTime: win[0].time,
        endTime: win[win.length - 1].time,
        upperBoundary: curvePts,
        lowerBoundary: [
          { time: win[0].time, price: rim },
          { time: win[win.length - 1].time, price: rim },
        ],
        neckline: [
          { time: win[0].time, price: rim },
          { time: win[win.length - 1].time, price: rim },
        ],
        breakoutLevel: rim,
        breakoutTime: state.breakoutTime,
        retestTime: state.retestTime,
        invalidationLevel: midHigh,
        measuredTarget: rim - (midHigh - rim),
        keyPoints: curvePts,
        qualityScore: 74,
        formationTime: win[0].time,
        confirmationTime: state.breakoutTime,
        detectionTime: win[win.length - 1].time,
        invalidationTime: state.invalidationTime,
        confirmationStatus: state.breakoutTime ? 'confirmed' : 'provisional',
      });
    }
  }

  return patterns.slice(-12);
}
