import { DEFAULT_ALERT_RULES, getInstrumentMeta, TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  AlertNotification,
  AlertRule,
  AlertType,
  AnalysisSnapshot,
  InstrumentSymbol,
  Timeframe,
  ZoneInteractionEvent,
} from '../../shared/types/index.ts';

function sanitizeAlertRules(rules: AlertRule[]): AlertRule[] {
  return rules
    .filter((r) => r && typeof r.id === 'string' && typeof r.type === 'string')
    .map((r) => {
      const dist = Number(r.distanceThresholdPercent);
      return {
        ...r,
        label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : r.type,
        enabled: Boolean(r.enabled),
        symbols: Array.isArray(r.symbols) ? r.symbols : [],
        timeframes: Array.isArray(r.timeframes) ? r.timeframes : [],
        distanceThresholdPercent:
          Number.isFinite(dist) && dist > 0 ? Math.min(5, Math.max(0.01, dist)) : 0.25,
        browserNotify: Boolean(r.browserNotify),
        soundEnabled: Boolean(r.soundEnabled),
      };
    });
}

/**
 * Real-Time Alert Engine.
 * Evaluates live zone interactions, structure breaks, sweeps, order blocks, FVGs,
 * trendline breaks, pattern confirmations, and HTF alignment against all configured rules.
 */
export class InMemoryAlertEngine {
  private rules: AlertRule[] = structuredClone(DEFAULT_ALERT_RULES);
  private readonly firedIds = new Set<string>();
  private history: AlertNotification[] = [];
  private enabled = false;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(next: boolean): boolean {
    this.enabled = Boolean(next);
    return this.enabled;
  }

  public hydrate(rules: AlertRule[] | null, history: AlertNotification[], enabled = false): void {
    this.enabled = Boolean(enabled);
    if (Array.isArray(rules) && rules.length > 0) {
      this.rules = sanitizeAlertRules(rules);
    }
    this.history = Array.isArray(history) ? [...history].slice(0, 100) : [];
    for (const item of this.history) {
      this.firedIds.add(item.id);
    }
  }

  public getRules(): AlertRule[] {
    return this.rules;
  }

  public updateRules(next: AlertRule[]): AlertRule[] {
    this.rules = sanitizeAlertRules(next);
    return this.rules;
  }

  public resetDefaultRules(): AlertRule[] {
    this.rules = structuredClone(DEFAULT_ALERT_RULES);
    return this.rules;
  }

  public getHistory(limit = 50): AlertNotification[] {
    return this.history.slice(0, limit);
  }

  public clearHistory(): void {
    this.history = [];
    this.firedIds.clear();
  }

  public triggerTestAlert(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    price: number,
    ruleId?: string
  ): AlertNotification {
    const matchedRule =
      (ruleId ? this.rules.find((r) => r.id === ruleId) : undefined) ??
      this.rules.find((r) => r.enabled) ??
      this.rules[0];
    const now = Date.now();
    const precision = getInstrumentMeta(symbol).pricePrecision;
    const alert: AlertNotification = {
      id: `alert:test:${symbol}:${timeframe}:${now}`,
      type: matchedRule?.type ?? 'approaching_support',
      symbol,
      timeframe,
      title: `TEST ALERT · ${matchedRule?.label ?? 'Live Alert Verification'}`,
      message: `${symbol} ${timeframe} @ ${price > 0 ? price.toFixed(precision) : 'Live Market'} — alert pipeline, sound & popup verified.`,
      direction: 'bullish',
      price,
      timestamp: now,
    };
    this.history.unshift(alert);
    if (this.history.length > 100) this.history.pop();
    return alert;
  }

  public evaluate(
    snapshot: AnalysisSnapshot,
    newInteractions: ZoneInteractionEvent[],
    htfAligned: boolean
  ): AlertNotification[] {
    if (!this.enabled) {
      return [];
    }
    const emitted: AlertNotification[] = [];
    const precision = getInstrumentMeta(snapshot.symbol).pricePrecision;
    const price =
      snapshot.quote?.price ?? snapshot.candles[snapshot.candles.length - 1]?.close ?? 0;
    const lastCandleTime = snapshot.candles[snapshot.candles.length - 1]?.time ?? 0;
    const tfSeconds = TIMEFRAME_SECONDS[snapshot.timeframe] ?? 900;

    const rulesByType = (t: AlertType): AlertRule[] =>
      this.rules.filter((r) => r.type === t && r.enabled);

    const pushForRule = (
      rule: AlertRule,
      dedupeBase: string,
      title: string,
      message: string,
      direction: AlertNotification['direction'],
      objectId?: string
    ) => {
      if (!rule.enabled) return;
      if (!rule.symbols.includes(snapshot.symbol)) return;
      if (!rule.timeframes.includes(snapshot.timeframe)) return;

      const dedupeKey = `${dedupeBase}:${rule.id}`;
      if (this.firedIds.has(dedupeKey)) return;

      this.firedIds.add(dedupeKey);
      const alert: AlertNotification = {
        id: dedupeKey,
        type: rule.type,
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        title,
        message,
        direction,
        price,
        objectId,
        timestamp: Date.now(),
      };
      this.history.unshift(alert);
      if (this.history.length > 100) this.history.pop();
      emitted.push(alert);
    };

    const srKindMap = new Map(snapshot.supportResistance.map((sr) => [sr.id, sr.kind]));

    // 1. Live Zone Interaction Alerts (S/R, S/D, Order Blocks, FVGs, Liquidity, Trendlines)
    for (const ev of newInteractions) {
      if (ev.objectCategory === 'support_resistance') {
        const srKind = srKindMap.get(ev.objectId);
        const dirHint: AlertNotification['direction'] =
          srKind === 'support' ? 'bullish' : srKind === 'resistance' ? 'bearish' : 'neutral';

        if (ev.status === 'Approaching' || ev.status === 'Near') {
          for (const rule of rulesByType('approaching_support')) {
            if (ev.distancePercent <= rule.distanceThresholdPercent) {
              pushForRule(
                rule,
                `alert:${ev.id}`,
                `${snapshot.symbol} ${ev.status} ${ev.objectLabel}`,
                `${snapshot.timeframe} price ${price.toFixed(precision)} is ${ev.distancePercent}% from ${ev.objectLabel}`,
                dirHint,
                ev.objectId
              );
            }
          }
        }

        if (
          ev.status === 'Touched' ||
          ev.status === 'Rejected' ||
          ev.status === 'Breaking' ||
          ev.status === 'Confirmed Breakout'
        ) {
          for (const rule of rulesByType('touching_resistance')) {
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} ${ev.status} ${ev.objectLabel}`,
              `${snapshot.timeframe} price @ ${price.toFixed(precision)} [${ev.lowerBound.toFixed(precision)}–${ev.upperBound.toFixed(precision)}]`,
              dirHint,
              ev.objectId
            );
          }
        }
      }

      if (ev.objectCategory === 'supply_demand') {
        const isDemand = /demand/i.test(ev.objectLabel);
        const ruleType: AlertType = isDemand ? 'demand_entry' : 'supply_entry';
        const isTouchOrEntry =
          ev.status === 'Entered Zone' || ev.status === 'Touched' || ev.status === 'Rejected';
        const isApproach = ev.status === 'Approaching' || ev.status === 'Near';

        if (isTouchOrEntry || isApproach) {
          for (const rule of rulesByType(ruleType)) {
            if (isApproach && ev.distancePercent > rule.distanceThresholdPercent) continue;
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} ${isDemand ? 'Demand' : 'Supply'} ${ev.status}`,
              `${snapshot.timeframe} price ${price.toFixed(precision)} (${ev.objectLabel})`,
              isDemand ? 'bullish' : 'bearish',
              ev.objectId
            );
          }
        }
      }

      if (ev.objectCategory === 'order_block') {
        const isTouchOrNear =
          ev.status === 'Entered Zone' ||
          ev.status === 'Touched' ||
          ev.status === 'Rejected' ||
          ev.status === 'Near';
        if (isTouchOrNear) {
          const isBull = /bullish/i.test(ev.objectLabel);
          for (const rule of rulesByType('ob_formation')) {
            if (ev.status === 'Near' && ev.distancePercent > rule.distanceThresholdPercent) continue;
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} Order Block ${ev.status}`,
              `${snapshot.timeframe} ${ev.objectLabel} @ ${price.toFixed(precision)}`,
              isBull ? 'bullish' : 'bearish',
              ev.objectId
            );
          }
        }
      }

      if (ev.objectCategory === 'fvg') {
        const isTouchOrNear =
          ev.status === 'Entered Zone' ||
          ev.status === 'Touched' ||
          ev.status === 'Rejected' ||
          ev.status === 'Near';
        if (isTouchOrNear) {
          const isBull = /bullish/i.test(ev.objectLabel);
          for (const rule of rulesByType('fvg_formation')) {
            if (ev.status === 'Near' && ev.distancePercent > rule.distanceThresholdPercent) continue;
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} FVG ${ev.status}`,
              `${snapshot.timeframe} ${ev.objectLabel} @ ${price.toFixed(precision)}`,
              isBull ? 'bullish' : 'bearish',
              ev.objectId
            );
          }
        }
      }

      if (ev.objectCategory === 'liquidity') {
        if (ev.status === 'Touched' || ev.status === 'Entered Zone' || ev.status === 'Rejected') {
          const isSellSide = /sell|low|pdl|pwl/i.test(ev.objectLabel);
          for (const rule of rulesByType('liquidity_sweep')) {
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} Liquidity Test (${ev.objectLabel})`,
              `${snapshot.timeframe} price ${ev.status.toLowerCase()} ${ev.objectLabel} @ ${price.toFixed(precision)}`,
              isSellSide ? 'bullish' : 'bearish',
              ev.objectId
            );
          }
        }
      }

      if (ev.objectCategory === 'trendline') {
        if (
          ev.status === 'Touched' ||
          ev.status === 'Breaking' ||
          ev.status === 'Confirmed Breakout' ||
          ev.status === 'Retesting'
        ) {
          const isBull = /bullish/i.test(ev.objectLabel);
          for (const rule of rulesByType('trendline_breakout')) {
            pushForRule(
              rule,
              `alert:${ev.id}`,
              `${snapshot.symbol} Trendline ${ev.status}`,
              `${snapshot.timeframe} ${ev.objectLabel} @ ${price.toFixed(precision)}`,
              isBull ? 'bullish' : 'bearish',
              ev.objectId
            );
          }
        }
      }
    }

    // 2. Structure Breaks (BOS / CHoCH / MSS within last 6 hours)
    for (const br of snapshot.marketStructure.breaks.slice(-4)) {
      if (lastCandleTime > 0 && lastCandleTime - br.breakTime > 3600 * 6) continue;
      if (br.type === 'BOS') {
        const type: AlertType = br.direction === 'bullish' ? 'bullish_bos' : 'bearish_bos';
        for (const rule of rulesByType(type)) {
          pushForRule(
            rule,
            `alert:${br.id}`,
            `${snapshot.symbol} ${br.direction === 'bullish' ? 'Bullish' : 'Bearish'} BOS`,
            `${snapshot.timeframe} ${br.scope} Break of Structure @ ${br.levelPrice.toFixed(precision)}`,
            br.direction,
            br.id
          );
        }
      } else if (br.type === 'CHoCH' || br.type === 'MSS') {
        const type: AlertType = br.direction === 'bullish' ? 'bullish_choch' : 'bearish_choch';
        for (const rule of rulesByType(type)) {
          pushForRule(
            rule,
            `alert:${br.id}`,
            `${snapshot.symbol} ${br.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${br.type}`,
            `${snapshot.timeframe} ${br.type} @ ${br.levelPrice.toFixed(precision)}`,
            br.direction,
            br.id
          );
        }
      }
    }

    // 3. Swept Liquidity Pools (within last 6 hours)
    for (const liq of snapshot.liquidityPools.filter((l) => l.swept && l.sweepTime).slice(-4)) {
      if (lastCandleTime > 0 && lastCandleTime - (liq.sweepTime ?? 0) > 3600 * 6) continue;
      const isBullSweep =
        liq.kind === 'sell_side' || liq.kind === 'equal_lows' || liq.kind === 'pdl' || liq.kind === 'pwl';
      for (const rule of rulesByType('liquidity_sweep')) {
        pushForRule(
          rule,
          `alert:${liq.id}:sweep:${liq.sweepTime}`,
          `${snapshot.symbol} ${liq.label} ${liq.sweepType === 'stop_hunt' ? 'Stop Hunt' : 'Sweep'}`,
          `${snapshot.timeframe} swept @ ${liq.price.toFixed(precision)}`,
          isBullSweep ? 'bullish' : 'bearish',
          liq.id
        );
      }
    }

    // 4. Freshly Formed Order Blocks & FVGs (within last 4 bars of current timeframe)
    for (const ob of snapshot.orderBlocks.filter((o) => o.valid && !o.mitigated).slice(-3)) {
      if (lastCandleTime > 0 && lastCandleTime - ob.originTime > tfSeconds * 4) continue;
      const isBull = ob.kind === 'bullish_ob' || ob.kind === 'breaker_block';
      for (const rule of rulesByType('ob_formation')) {
        pushForRule(
          rule,
          `alert:${ob.id}:formed`,
          `${snapshot.symbol} New ${ob.kind.replace('_', ' ').toUpperCase()}`,
          `${snapshot.timeframe} zone [${ob.lower.toFixed(precision)}–${ob.upper.toFixed(precision)}] (${ob.displacementAtr.toFixed(1)}x ATR)`,
          isBull ? 'bullish' : 'bearish',
          ob.id
        );
      }
    }

    for (const fvg of snapshot.fairValueGaps.filter((f) => f.status === 'unfilled').slice(-3)) {
      if (lastCandleTime > 0 && lastCandleTime - fvg.originTime > tfSeconds * 4) continue;
      const isBull = fvg.kind === 'bullish_fvg';
      for (const rule of rulesByType('fvg_formation')) {
        pushForRule(
          rule,
          `alert:${fvg.id}:formed`,
          `${snapshot.symbol} New ${fvg.kind.replace('_', ' ').toUpperCase()}`,
          `${snapshot.timeframe} imbalance [${fvg.lower.toFixed(precision)}–${fvg.upper.toFixed(precision)}]`,
          isBull ? 'bullish' : 'bearish',
          fvg.id
        );
      }
    }

    // 5. Recent Candlestick & Chart Pattern Confirmations
    for (const cp of snapshot.candlestickPatterns.slice(-3)) {
      if (
        cp.confirmationStatus === 'confirmed' &&
        (lastCandleTime === 0 || lastCandleTime - cp.detectionTime <= tfSeconds * 2)
      ) {
        for (const rule of rulesByType('pattern_confirmation')) {
          pushForRule(
            rule,
            `alert:${cp.id}`,
            `${snapshot.symbol} ${cp.name}`,
            `${snapshot.timeframe} ${cp.direction} candle pattern @ ${cp.formationPrice.toFixed(precision)}`,
            cp.direction,
            cp.id
          );
        }
      }
    }

    for (const chartPat of snapshot.chartPatterns.filter(
      (p) => p.status === 'Confirmed' || p.status === 'Breakout' || p.status === 'Retest'
    )) {
      const eventTs = chartPat.retestTime ?? chartPat.breakoutTime ?? chartPat.detectionTime;
      if (lastCandleTime > 0 && lastCandleTime - eventTs > 3600 * 6) continue;
      for (const rule of rulesByType('pattern_confirmation')) {
        pushForRule(
          rule,
          `alert:${chartPat.id}:${chartPat.status}`,
          `${snapshot.symbol} ${chartPat.name} (${chartPat.status})`,
          `${snapshot.timeframe} breakout level ${chartPat.breakoutLevel.toFixed(precision)}`,
          chartPat.direction,
          chartPat.id
        );
      }
    }

    // 6. Broken / Retested Trendlines
    for (const tl of snapshot.trendlines.filter(
      (t) => t.status === 'broken' || t.status === 'retested'
    )) {
      const evTs = tl.retestTime ?? tl.breakoutTime ?? tl.detectionTime;
      if (lastCandleTime > 0 && lastCandleTime - evTs > 3600 * 6) continue;
      for (const rule of rulesByType('trendline_breakout')) {
        pushForRule(
          rule,
          `alert:${tl.id}:${tl.status}`,
          `${snapshot.symbol} Trendline ${tl.status === 'retested' ? 'Retest' : 'Breakout'}`,
          `${snapshot.timeframe} ${tl.kind.replace('_', ' ')} @ ${tl.currentProjectedPrice.toFixed(precision)}`,
          tl.kind === 'bullish_support' ? 'bearish' : 'bullish',
          tl.id
        );
      }
    }

    // 7. Higher Timeframe Alignment
    if (htfAligned) {
      for (const rule of rulesByType('htf_alignment')) {
        pushForRule(
          rule,
          `alert:htf:${snapshot.symbol}:${snapshot.timeframe}:${snapshot.marketStructure.trend}:${lastCandleTime}`,
          `${snapshot.symbol} HTF Alignment (${snapshot.marketStructure.trend.toUpperCase()})`,
          `${snapshot.timeframe} structure aligned with Higher Timeframe bias`,
          snapshot.marketStructure.trend === 'bullish' ? 'bullish' : 'bearish'
        );
      }
    }

    return emitted;
  }
}
