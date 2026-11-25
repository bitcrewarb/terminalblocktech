import type {
  AnalysisSnapshot,
  TechnicalSettings,
  ZoneInteractionEvent,
  ZoneLifecycleState,
} from '../../shared/types/index.ts';

interface TrackedZoneState {
  lastStatus: ZoneLifecycleState;
  lastEmittedStatus: ZoneLifecycleState | null;
  lastEmittedAt: number;
}

/**
 * Real-time Live Zone Interaction Engine.
 * Compares live market price against all active technical objects (S/R, S/D, OB, FVG, Liquidity, Trendlines, Chart Patterns)
 * using configurable ATR thresholds, hysteresis, and duplicate suppression.
 */
export class LiveZoneMonitor {
  private readonly stateCache = new Map<string, TrackedZoneState>();
  private readonly cooldownMs = 45000;

  public evaluate(
    snapshot: AnalysisSnapshot,
    livePrice: number,
    settings: TechnicalSettings
  ): {
    allZoneInteractions: ZoneInteractionEvent[];
    newlyTriggeredEvents: ZoneInteractionEvent[];
  } {
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      return { allZoneInteractions: [], newlyTriggeredEvents: [] };
    }

    if (this.stateCache.size > 20000) {
      this.stateCache.clear();
    }

    const now = Date.now();
    const atr = Math.max(1e-8, snapshot.atr);
    const nearDist = atr * settings.zoneTouchToleranceAtr;
    const approachDist = atr * settings.zoneTouchToleranceAtr * 2.8;
    const latestCandle = snapshot.candles[snapshot.candles.length - 1];

    const interactions: ZoneInteractionEvent[] = [];
    const newlyTriggered: ZoneInteractionEvent[] = [];

    const classifyAndRecord = (
      objectId: string,
      category: ZoneInteractionEvent['objectCategory'],
      label: string,
      upper: number,
      lower: number,
      directionHint: 'support_like' | 'resistance_like',
      alreadyMitigated: boolean,
      alreadyInvalidated: boolean
    ): ZoneLifecycleState => {
      const dist =
        livePrice > upper ? livePrice - upper : livePrice < lower ? lower - livePrice : 0;
      const distPct = Math.round((dist / livePrice) * 100000) / 1000;
      const prev = this.stateCache.get(objectId);

      let status: ZoneLifecycleState = 'Far Away';
      let touchMethod: 'wick' | 'close' | undefined;

      if (alreadyInvalidated) {
        status = 'Invalidated';
      } else if (alreadyMitigated) {
        status = 'Mitigated';
      } else if (dist === 0) {
        // Price is inside zone boundaries
        const zoneHeight = Math.max(0, upper - lower);
        const deepInside =
          zoneHeight > 0 &&
          livePrice > lower + zoneHeight * 0.25 &&
          livePrice < upper - zoneHeight * 0.25;

        if (latestCandle) {
          const closedThrough =
            directionHint === 'support_like'
              ? latestCandle.close < lower
              : latestCandle.close > upper;
          const closedRejection =
            directionHint === 'support_like'
              ? latestCandle.close > upper && latestCandle.low <= upper
              : latestCandle.close < lower && latestCandle.high >= lower;

          touchMethod =
            latestCandle.open >= lower && latestCandle.open <= upper ? 'close' : 'wick';

          if (closedThrough) {
            status = latestCandle.isClosed ? 'Confirmed Breakout' : 'Breaking';
          } else if (closedRejection) {
            status = 'Rejected';
          } else if (deepInside) {
            status = 'Entered Zone';
          } else {
            status = 'Touched';
          }
        } else {
          status = deepInside ? 'Entered Zone' : 'Touched';
        }
      } else if (prev?.lastStatus === 'Confirmed Breakout' && dist <= nearDist) {
        status = 'Retesting';
      } else if (dist <= nearDist) {
        status = 'Near';
      } else if (dist <= approachDist) {
        status = 'Approaching';
      }

      // Hysteresis: prevent flicker between adjacent states on micro-ticks
      if (prev && prev.lastStatus === 'Near' && status === 'Approaching' && dist < nearDist * 1.35) {
        status = 'Near';
      }
      if (
        prev &&
        (prev.lastStatus === 'Touched' || prev.lastStatus === 'Entered Zone') &&
        status === 'Near' &&
        dist < nearDist * 0.35
      ) {
        status = prev.lastStatus;
      }

      const event: ZoneInteractionEvent = {
        id: `${objectId}:interaction`,
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        objectId,
        objectCategory: category,
        objectLabel: label,
        currentPrice: livePrice,
        upperBound: upper,
        lowerBound: lower,
        distancePercent: distPct,
        status,
        touchMethod,
        timestamp: now,
      };
      interactions.push(event);

      if (!prev) {
        // Initial evaluation of a newly loaded snapshot:
        // Do NOT flood the live event ledger with historical Invalidated/Mitigated or passive Approaching zones.
        const activeImmediate =
          status === 'Touched' ||
          status === 'Entered Zone' ||
          status === 'Breaking' ||
          status === 'Rejected' ||
          status === 'Confirmed Breakout';

        if (activeImmediate) {
          newlyTriggered.push({
            ...event,
            id: `${objectId}:${status}:${now}`,
          });
          this.stateCache.set(objectId, {
            lastStatus: status,
            lastEmittedStatus: status,
            lastEmittedAt: now,
          });
        } else {
          this.stateCache.set(objectId, {
            lastStatus: status,
            lastEmittedStatus: status,
            lastEmittedAt: 0,
          });
        }
        return status;
      }

      const statusDiffersFromEmitted = prev.lastEmittedStatus !== status;
      const significant = status !== 'Far Away';
      const cooledDown = now - prev.lastEmittedAt >= this.cooldownMs;

      if (significant && statusDiffersFromEmitted && cooledDown) {
        newlyTriggered.push({
          ...event,
          id: `${objectId}:${status}:${now}`,
        });
        this.stateCache.set(objectId, {
          lastStatus: status,
          lastEmittedStatus: status,
          lastEmittedAt: now,
        });
      } else {
        this.stateCache.set(objectId, {
          lastStatus: status,
          lastEmittedStatus: prev.lastEmittedStatus,
          lastEmittedAt: prev.lastEmittedAt,
        });
      }

      return status;
    };

    // 1. Support & Resistance
    for (const sr of snapshot.supportResistance) {
      const state = classifyAndRecord(
        sr.id,
        'support_resistance',
        sr.label,
        sr.upper,
        sr.lower,
        sr.kind === 'support' ? 'support_like' : 'resistance_like',
        false,
        sr.status === 'Invalidated'
      );
      sr.interactionState = state;
      sr.distancePercent =
        Math.round(
          ((livePrice > sr.upper ? livePrice - sr.upper : livePrice < sr.lower ? sr.lower - livePrice : 0) /
            livePrice) *
            100000
        ) / 1000;
      if (state === 'Touched' || state === 'Entered Zone') {
        sr.status = 'Touched';
        sr.lastTest = Math.floor(now / 1000);
        sr.lastTouchPrice = livePrice;
      } else if (state === 'Rejected') {
        sr.status = 'Rejected';
      } else if (state === 'Breaking') {
        sr.status = 'Breaking';
      } else if (state === 'Confirmed Breakout') {
        sr.status = 'Broken';
      } else if (state === 'Retesting') {
        sr.status = 'Retesting';
      } else if (state === 'Near') {
        sr.status = 'Near';
      } else if (state === 'Approaching') {
        sr.status = 'Approaching';
      }
    }

    // 2. Supply & Demand
    for (const sd of snapshot.supplyDemand) {
      const upper = Math.max(sd.proximal, sd.distal);
      const lower = Math.min(sd.proximal, sd.distal);
      const state = classifyAndRecord(
        sd.id,
        'supply_demand',
        `${sd.patternType} ${sd.kind.toUpperCase()}`,
        upper,
        lower,
        sd.kind === 'demand' ? 'support_like' : 'resistance_like',
        sd.freshness === 'fully_mitigated',
        sd.freshness === 'invalidated'
      );
      sd.interactionState = state;
      sd.distancePercent =
        Math.round(
          ((livePrice > upper ? livePrice - upper : livePrice < lower ? lower - livePrice : 0) /
            livePrice) *
            100000
        ) / 1000;
    }

    // 3. Order Blocks
    for (const ob of snapshot.orderBlocks) {
      const state = classifyAndRecord(
        ob.id,
        'order_block',
        ob.kind.replace('_', ' ').toUpperCase(),
        ob.upper,
        ob.lower,
        ob.kind === 'bullish_ob' ? 'support_like' : 'resistance_like',
        ob.mitigationPercent >= 85,
        !ob.valid
      );
      ob.interactionState = state;
    }

    // 4. Fair Value Gaps
    for (const fvg of snapshot.fairValueGaps) {
      const state = classifyAndRecord(
        fvg.id,
        'fvg',
        fvg.kind.replace('_', ' ').toUpperCase(),
        fvg.upper,
        fvg.lower,
        fvg.kind === 'bullish_fvg' ? 'support_like' : 'resistance_like',
        fvg.status === 'fully_filled',
        fvg.status === 'inverted'
      );
      fvg.interactionState = state;
    }

    // 5. Liquidity Pools
    for (const liq of snapshot.liquidityPools) {
      const state = classifyAndRecord(
        liq.id,
        'liquidity',
        liq.label,
        liq.upper,
        liq.lower,
        liq.kind === 'sell_side' || liq.kind === 'equal_lows' || liq.kind === 'pdl' || liq.kind === 'pwl'
          ? 'support_like'
          : 'resistance_like',
        liq.swept,
        false
      );
      liq.interactionState = state;
    }

    // 6. Trendlines
    for (const tl of snapshot.trendlines) {
      const band = atr * 0.15;
      classifyAndRecord(
        tl.id,
        'trendline',
        tl.kind.replace('_', ' '),
        tl.currentProjectedPrice + band,
        tl.currentProjectedPrice - band,
        tl.kind === 'bullish_support' ? 'support_like' : 'resistance_like',
        false,
        tl.status === 'invalidated'
      );
    }

    // 7. Chart Patterns (breakout level monitoring)
    for (const cp of snapshot.chartPatterns) {
      const band = atr * 0.2;
      classifyAndRecord(
        cp.id,
        'chart_pattern',
        `${cp.name} Breakout`,
        cp.breakoutLevel + band,
        cp.breakoutLevel - band,
        cp.direction === 'bearish' ? 'support_like' : 'resistance_like',
        false,
        cp.status === 'Invalidated'
      );
    }

    return {
      allZoneInteractions: interactions.sort(
        (a, b) =>
          a.distancePercent - b.distancePercent ||
          (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0)
      ),
      newlyTriggeredEvents: newlyTriggered,
    };
  }
}
