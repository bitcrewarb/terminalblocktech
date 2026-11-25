import type {
  BacktestStrategyDefinition,
  Candle,
  InstrumentSymbol,
  LiveQuote,
  SignalClassification,
  SignalDeleteScope,
  SignalHtfBiasSummary,
  SignalLifecycleState,
  SignalNotification,
  SignalNotificationType,
  SignalScoreBreakdown,
  SignalSettings,
  TradingSignal,
} from '../../shared/types/index.ts';
import type { StrategySignalCandidate } from '../../backtest/strategies/index.ts';
import type { SignalSqliteStore } from '../storage/sqlite.ts';
import type { DirectionalCandidate } from '../types.ts';

const TERMINAL_STATES = new Set<SignalLifecycleState>([
  'TP3_HIT',
  'STOPPED',
  'INVALIDATED',
  'EXPIRED',
  'CANCELLED',
]);

const OPEN_TRACKING_STATES = new Set<SignalLifecycleState>([
  'CONFIRMED',
  'ACTIVE',
  'PARTIAL',
  'TP1_HIT',
  'TP2_HIT',
]);

export function isTerminalSignalState(state: SignalLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isLiveActionableState(state: SignalLifecycleState): boolean {
  return OPEN_TRACKING_STATES.has(state);
}

function buildGenerationSummary(
  symbol: InstrumentSymbol,
  entryTf: string,
  candidate: DirectionalCandidate
): string {
  const score = candidate.finalScoreBreakdown.totalScore;
  const cls = candidate.finalScoreBreakdown.classification;
  const reasons = candidate.confluenceReasons.slice(0, 4).join(' · ');
  return `${candidate.direction} ${symbol} (${entryTf}, ${score}/100 ${cls})${reasons ? `: ${reasons}` : ''}`;
}

function auditWeakEntryFactors(sig: TradingSignal): string[] {
  const sb = sig.scoreBreakdown;
  if (!sb || !sb.htfAlignment) return [];
  const weak: string[] = [];
  if (!sb.htfAlignment.met) weak.push(`HTF Alignment partial (${sb.htfAlignment.detail})`);
  if (!sb.liquiditySweep.met) weak.push('No prior liquidity sweep');
  if (!sb.obFvgConfluence.met) weak.push('No OB/FVG/SD zone confluence');
  if (!sb.premiumDiscount.met) weak.push(`Unfavorable P/D (${sb.premiumDiscount.detail})`);
  if (!sb.volumeMomentum.met) weak.push(`Weak momentum/volume (${sb.volumeMomentum.detail})`);

  const opposing = sig.direction === 'BUY' ? 'bearish' : 'bullish';
  const counterTfs: string[] = [];
  if (sig.htfBias?.d1 === opposing) counterTfs.push(`1D ${opposing}`);
  if (sig.htfBias?.h4 === opposing) counterTfs.push(`4H ${opposing}`);
  if (sig.htfBias?.h1 === opposing) counterTfs.push(`1H ${opposing}`);
  if (counterTfs.length > 0) {
    weak.push(`Counter-trend HTF context (${counterTfs.join(', ')})`);
  }
  return weak;
}

function buildFailureDetails(
  sig: TradingSignal,
  reasonKind: 'STOPPED' | 'INVALIDATED' | 'EXPIRED' | 'CANCELLED',
  details: {
    triggerExtreme: number;
    elapsedMin: number;
    hitTpLevels?: number[];
    wasWatching?: boolean;
  }
): { outcomeSummary: string; failureReasons: string[] } {
  const isBuy = sig.direction === 'BUY';
  const weakFactors = auditWeakEntryFactors(sig);
  const reasons: string[] = [];

  if (reasonKind === 'STOPPED') {
    reasons.push(
      `Price ${isBuy ? 'dropped to' : 'rallied to'} ${details.triggerExtreme} and breached Stop Loss ${sig.stopLoss} (structural invalidation ${sig.invalidationLevel} failed).`
    );
    reasons.push(
      `Active duration: ${details.elapsedMin}m · Excursion: +${sig.highestFavorableR.toFixed(2)}R favorable / -${sig.maxAdverseR.toFixed(2)}R adverse.`
    );
    if (details.hitTpLevels && details.hitTpLevels.length > 0) {
      reasons.push(
        `Secured TP${details.hitTpLevels.join(', TP')} prior to reversal; remaining position stopped out (Net Realized ${sig.realizedR}R).`
      );
    } else {
      reasons.push(
        `Reversed before reaching TP1 (${sig.takeProfits[0]?.price ?? '—'}), closing at ${sig.realizedR ?? -1}R.`
      );
    }
    if (weakFactors.length > 0) {
      reasons.push(`Entry factor audit: ${weakFactors.join('; ')}.`);
    }
    return {
      outcomeSummary: `Stopped out @ ${sig.stopLoss} (${sig.realizedR}R) after breaking invalidation ${sig.invalidationLevel}.`,
      failureReasons: reasons,
    };
  }

  if (reasonKind === 'INVALIDATED') {
    const phase = details.wasWatching
      ? 'closed-candle confirmation'
      : `entry zone [${sig.entryZone.lower} – ${sig.entryZone.upper}] fill`;
    reasons.push(
      `Price ${isBuy ? 'fell to' : 'rose to'} ${details.triggerExtreme} and breached invalidation/SL ${sig.stopLoss} before ${phase}.`
    );
    reasons.push(`Invalidated ${details.elapsedMin}m after detection with 0R position exposure.`);
    if (weakFactors.length > 0) {
      reasons.push(`Entry factor audit: ${weakFactors.join('; ')}.`);
    }
    return {
      outcomeSummary: `Setup invalidated @ ${sig.stopLoss} prior to ${details.wasWatching ? 'confirmation' : 'entry fill'} (0R).`,
      failureReasons: reasons,
    };
  }

  if (reasonKind === 'EXPIRED') {
    if (details.wasWatching) {
      reasons.push(
        `Provisional intrabar candidate expired after ${details.elapsedMin}m without closed-candle structural confirmation or minimum score.`
      );
    } else {
      reasons.push(
        `Confirmed setup expired after ${details.elapsedMin}m because price did not retrace into entry zone [${sig.entryZone.lower} – ${sig.entryZone.upper}].`
      );
    }
    return {
      outcomeSummary: `Expired after ${details.elapsedMin}m without ${details.wasWatching ? 'confirmation' : 'entry fill'}.`,
      failureReasons: reasons,
    };
  }

  reasons.push(
    `Manually cancelled from terminal after ${details.elapsedMin}m at reference price ${sig.entryPrice}.`
  );
  return {
    outcomeSummary: 'Signal manually cancelled from terminal.',
    failureReasons: reasons,
  };
}

/**
 * Manages real-time signal lifecycle transitions:
 * WATCHING -> CONFIRMED -> ACTIVE -> PARTIAL -> TP1_HIT -> TP2_HIT -> TP3_HIT / STOPPED / INVALIDATED / EXPIRED / CANCELLED
 */
export class SignalLifecycleManager {
  private readonly signals = new Map<string, TradingSignal>();
  private readonly notifications: SignalNotification[] = [];
  private readonly maxSignals = 2000;
  private readonly maxNotifications = 200;
  private readonly store: SignalSqliteStore | null;

  constructor(store?: SignalSqliteStore | null) {
    this.store = store ?? null;
    if (this.store) {
      for (const sig of this.store.getAllSignals({ limit: this.maxSignals })) {
        this.signals.set(sig.id, sig);
      }
      for (const notif of this.store.getNotifications(this.maxNotifications)) {
        this.notifications.push(notif);
      }
    }
  }

  public getAllSignals(symbol?: InstrumentSymbol): TradingSignal[] {
    const list = Array.from(this.signals.values());
    const filtered = symbol ? list.filter((s) => s.symbol === symbol) : list;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  public getActiveSignals(symbol?: InstrumentSymbol): TradingSignal[] {
    return this.getAllSignals(symbol).filter((s) => !isTerminalSignalState(s.state));
  }

  public getSignalById(id: string): TradingSignal | undefined {
    return this.signals.get(id);
  }

  public getNotifications(limit = 80): SignalNotification[] {
    return this.notifications.slice(0, limit);
  }

  private emitNotification(
    signal: TradingSignal,
    type: SignalNotificationType,
    title: string,
    message: string,
    price: number,
    timestamp: number
  ): SignalNotification {
    const notif: SignalNotification = {
      id: `signotif:${signal.id}:${type}:${signal.state}:${timestamp}`,
      type,
      signalId: signal.id,
      symbol: signal.symbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      state: signal.state,
      title,
      message,
      price,
      score: signal.score,
      timestamp,
    };
    this.notifications.unshift(notif);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.pop();
    }
    this.store?.upsertNotification(notif);
    return notif;
  }

  private pruneOldTerminalSignals(): void {
    if (this.signals.size <= this.maxSignals) return;
    const all = this.getAllSignals();
    for (let i = all.length - 1; i >= 0 && this.signals.size > this.maxSignals; i--) {
      if (isTerminalSignalState(all[i].state)) {
        this.signals.delete(all[i].id);
      }
    }
  }

  /**
   * Registers a new WATCHING or CONFIRMED signal, or promotes an existing WATCHING signal to CONFIRMED.
   */
  public upsertCandidate(
    symbol: InstrumentSymbol,
    candidate: DirectionalCandidate,
    provisionalOnly: boolean,
    settings: SignalSettings,
    nowMs: number
  ): {
    signal: TradingSignal;
    changed: boolean;
    notifications: SignalNotification[];
  } {
    const notifications: SignalNotification[] = [];
    const tfs = settings.timeframes;

    // Look for an existing WATCHING signal for the same symbol + direction
    const existingWatching = Array.from(this.signals.values()).find(
      (s) =>
        s.symbol === symbol &&
        s.direction === candidate.direction &&
        s.entryTimeframe === tfs.entryTf &&
        s.state === 'WATCHING'
    );

    const timeframeSummary = `1D:${candidate.htfBias.d1} | 4H:${candidate.htfBias.h4} | 1H:${candidate.htfBias.h1} | 15m:${candidate.htfBias.m15} | 5m:${candidate.htfBias.m5}`;

    if (existingWatching) {
      if (provisionalOnly) {
        // Update provisional candidate metrics cleanly without creating duplicates
        const prevScore = existingWatching.score;
        existingWatching.score = candidate.finalScoreBreakdown.totalScore;
        existingWatching.classification = candidate.finalScoreBreakdown.classification;
        existingWatching.scoreBreakdown = candidate.finalScoreBreakdown;
        existingWatching.htfBias = candidate.htfBias;
        existingWatching.entryPrice = candidate.tradePlan.entryPrice;
        existingWatching.entryZone = candidate.tradePlan.entryZone;
        existingWatching.stopLoss = candidate.tradePlan.stopLoss;
        existingWatching.invalidationLevel = candidate.tradePlan.invalidationLevel;
        existingWatching.atrBuffer = candidate.tradePlan.atrBuffer;
        existingWatching.takeProfits = candidate.tradePlan.takeProfits;
        existingWatching.primaryRR = candidate.tradePlan.primaryRR;
        existingWatching.maxRR = candidate.tradePlan.maxRR;
        existingWatching.confluenceReasons = candidate.confluenceReasons;
        existingWatching.generationSummary = buildGenerationSummary(symbol, tfs.entryTf, candidate);
        existingWatching.timeframeSummary = timeframeSummary;
        existingWatching.timeline = existingWatching.timeline ?? [];
        existingWatching.candleTime = candidate.anchorCandleTime;
        const changed = prevScore !== existingWatching.score;
        if (changed) {
          this.store?.upsertSignal(existingWatching);
        }
        return {
          signal: existingWatching,
          changed,
          notifications,
        };
      }

      // Promote WATCHING -> CONFIRMED
      existingWatching.state = 'CONFIRMED';
      existingWatching.provisional = false;
      existingWatching.confirmedAt = nowMs;
      existingWatching.score = candidate.finalScoreBreakdown.totalScore;
      existingWatching.classification = candidate.finalScoreBreakdown.classification;
      existingWatching.scoreBreakdown = candidate.finalScoreBreakdown;
      existingWatching.htfBias = candidate.htfBias;
      existingWatching.entryPrice = candidate.tradePlan.entryPrice;
      existingWatching.entryZone = candidate.tradePlan.entryZone;
      existingWatching.stopLoss = candidate.tradePlan.stopLoss;
      existingWatching.invalidationLevel = candidate.tradePlan.invalidationLevel;
      existingWatching.atrBuffer = candidate.tradePlan.atrBuffer;
      existingWatching.takeProfits = candidate.tradePlan.takeProfits;
      existingWatching.primaryRR = candidate.tradePlan.primaryRR;
      existingWatching.maxRR = candidate.tradePlan.maxRR;
      existingWatching.confluenceReasons = candidate.confluenceReasons;
      existingWatching.generationSummary = buildGenerationSummary(symbol, tfs.entryTf, candidate);
      existingWatching.timeframeSummary = timeframeSummary;
      existingWatching.candleTime = candidate.anchorCandleTime;
      existingWatching.timeline.push({
        state: 'CONFIRMED',
        timestamp: nowMs,
        price: existingWatching.entryPrice,
        note: `Closed-candle confirmed (${existingWatching.score}/100 ${existingWatching.classification})`,
      });

      notifications.push(
        this.emitNotification(
          existingWatching,
          existingWatching.direction === 'BUY' ? 'signal_buy_new' : 'signal_sell_new',
          `${existingWatching.direction} SIGNAL · ${symbol}`,
          `${existingWatching.classification} (${existingWatching.score}/100) @ ${existingWatching.entryPrice} · SL ${existingWatching.stopLoss} · TP1 ${existingWatching.takeProfits[0]?.price}`,
          existingWatching.entryPrice,
          nowMs
        ),
        this.emitNotification(
          existingWatching,
          'signal_confirmed',
          `SIGNAL CONFIRMED · ${symbol} ${existingWatching.direction}`,
          `Closed-candle confirmation on ${tfs.entryTf} (1:${existingWatching.primaryRR} R:R)`,
          existingWatching.entryPrice,
          nowMs
        )
      );

      this.store?.upsertSignal(existingWatching);
      return { signal: existingWatching, changed: true, notifications };
    }

    // Prevent duplicate active or watching signal for the same candle/direction
    const duplicate = Array.from(this.signals.values()).find(
      (s) =>
        s.symbol === symbol &&
        s.direction === candidate.direction &&
        s.entryTimeframe === tfs.entryTf &&
        !isTerminalSignalState(s.state)
    );
    if (duplicate) {
      return { signal: duplicate, changed: false, notifications };
    }

    const initialState: SignalLifecycleState = provisionalOnly ? 'WATCHING' : 'CONFIRMED';
    const id = `sig:${symbol}:${tfs.entryTf}:${candidate.direction}:${candidate.anchorCandleTime}:${nowMs}`;

    const signal: TradingSignal = {
      id,
      symbol,
      entryTimeframe: tfs.entryTf,
      setupTimeframe: tfs.setupTf,
      direction: candidate.direction,
      state: initialState,
      provisional: provisionalOnly,
      score: candidate.finalScoreBreakdown.totalScore,
      classification: candidate.finalScoreBreakdown.classification,
      scoreBreakdown: candidate.finalScoreBreakdown,
      htfBias: candidate.htfBias,
      entryPrice: candidate.tradePlan.entryPrice,
      entryZone: candidate.tradePlan.entryZone,
      stopLoss: candidate.tradePlan.stopLoss,
      invalidationLevel: candidate.tradePlan.invalidationLevel,
      atrBuffer: candidate.tradePlan.atrBuffer,
      takeProfits: candidate.tradePlan.takeProfits,
      primaryRR: candidate.tradePlan.primaryRR,
      maxRR: candidate.tradePlan.maxRR,
      confluenceReasons: candidate.confluenceReasons,
      generationSummary: buildGenerationSummary(symbol, tfs.entryTf, candidate),
      timeframeSummary,
      createdAt: nowMs,
      confirmedAt: provisionalOnly ? null : nowMs,
      activatedAt: null,
      closedAt: null,
      candleTime: candidate.anchorCandleTime,
      realizedR: null,
      highestFavorableR: 0,
      maxAdverseR: 0,
      timeline: [
        {
          state: initialState,
          timestamp: nowMs,
          price: candidate.tradePlan.entryPrice,
          note: provisionalOnly
            ? `Intrabar candidate (${candidate.finalScoreBreakdown.totalScore}/100) awaiting closed-candle confirmation`
            : `Confirmed ${candidate.direction} setup (${candidate.finalScoreBreakdown.totalScore}/100 ${candidate.finalScoreBreakdown.classification})`,
        },
      ],
    };

    this.signals.set(signal.id, signal);
    this.store?.upsertSignal(signal);
    this.pruneOldTerminalSignals();

    if (!provisionalOnly) {
      notifications.push(
        this.emitNotification(
          signal,
          signal.direction === 'BUY' ? 'signal_buy_new' : 'signal_sell_new',
          `${signal.direction} SIGNAL · ${symbol}`,
          `${signal.classification} (${signal.score}/100) @ ${signal.entryPrice} · SL ${signal.stopLoss} · TP1 ${signal.takeProfits[0]?.price}`,
          signal.entryPrice,
          nowMs
        ),
        this.emitNotification(
          signal,
          'signal_confirmed',
          `SIGNAL CONFIRMED · ${symbol} ${signal.direction}`,
          `Closed-candle confirmation on ${tfs.entryTf} (1:${signal.primaryRR} R:R)`,
          signal.entryPrice,
          nowMs
        )
      );
    }

    return { signal, changed: true, notifications };
  }

  /**
   * Registers a closed-candle signal produced by an auto-running Strategy Basket strategy,
   * enforcing basket concurrent position limits and strategy-level deduplication.
   */
  public upsertStrategyCandidate(params: {
    symbol: InstrumentSymbol;
    entryTimeframe: TradingSignal['entryTimeframe'];
    setupTimeframe: TradingSignal['setupTimeframe'];
    strategy: Pick<BacktestStrategyDefinition, 'id' | 'name' | 'category'>;
    candidate: StrategySignalCandidate;
    atrBuffer: number;
    htfBias: SignalHtfBiasSummary;
    maxConcurrentPositions: number;
    candleTime: number;
    nowMs: number;
    marketRegime?: string;
  }): {
    signal: TradingSignal | null;
    emitted: boolean;
    skippedReason?: string;
    notifications: SignalNotification[];
  } {
    const {
      symbol,
      entryTimeframe,
      setupTimeframe,
      strategy,
      candidate,
      atrBuffer,
      htfBias,
      maxConcurrentPositions,
      candleTime,
      nowMs,
      marketRegime,
    } = params;
    const notifications: SignalNotification[] = [];

    // 1. Prevent duplicate for same strategy + symbol + direction while open, or same closed bar
    const duplicate = Array.from(this.signals.values()).find(
      (s) =>
        s.symbol === symbol &&
        s.entryTimeframe === entryTimeframe &&
        s.strategyId === strategy.id &&
        ((!isTerminalSignalState(s.state) && s.direction === candidate.direction) ||
          s.candleTime === candleTime)
    );
    if (duplicate) {
      return {
        signal: duplicate,
        emitted: false,
        skippedReason: 'duplicate_strategy_signal',
        notifications,
      };
    }

    // 2. Enforce basket max concurrent open signals cap
    const activeBasketCount = Array.from(this.signals.values()).filter(
      (s) => s.source === 'strategy_basket' && !isTerminalSignalState(s.state)
    ).length;
    if (activeBasketCount >= maxConcurrentPositions) {
      return {
        signal: null,
        emitted: false,
        skippedReason: 'max_concurrent_cap',
        notifications,
      };
    }

    const score = Math.min(100, Math.max(0, Math.round(candidate.confluenceScore)));
    const classification: SignalClassification =
      score >= 85 ? 'Excellent' : score >= 75 ? 'Strong' : 'Moderate';

    const primaryRR = candidate.takeProfits[0]?.riskReward ?? 1.5;
    const maxRR = candidate.takeProfits[candidate.takeProfits.length - 1]?.riskReward ?? primaryRR;

    const scoreBreakdown: SignalScoreBreakdown = {
      htfAlignment: {
        score: htfBias.h4 !== 'consolidation' ? 18 : 10,
        maxScore: 20,
        met: htfBias.h4 !== 'consolidation',
        detail: `1D:${htfBias.d1} / 4H:${htfBias.h4}`,
      },
      liquiditySweep: {
        score: candidate.entryRationale.some((r) => /sweep|raid|liq/i.test(r)) ? 14 : 8,
        maxScore: 15,
        met: candidate.entryRationale.some((r) => /sweep|raid|liq/i.test(r)),
        detail: strategy.category,
      },
      structureConfirmation: {
        score: 18,
        maxScore: 20,
        met: true,
        detail: candidate.entryRationale[0] ?? strategy.name,
      },
      obFvgConfluence: {
        score: 12,
        maxScore: 15,
        met: true,
        detail: candidate.entryRationale[1] ?? strategy.category,
      },
      premiumDiscount: {
        score: 8,
        maxScore: 10,
        met: true,
        detail: `Entry ${candidate.entryMode === 'limit_retest' ? 'Retest' : 'Close'}`,
      },
      volumeMomentum: {
        score: 8,
        maxScore: 10,
        met: true,
        detail: 'Closed-candle strategy trigger',
      },
      riskRewardQuality: {
        score: primaryRR >= 2.0 ? 10 : 7,
        maxScore: 10,
        met: primaryRR >= 1.5,
        detail: `TP1 1:${primaryRR.toFixed(2)}`,
      },
      totalScore: score,
      classification,
    };

    const timeframeSummary = `Basket: ${strategy.name} (${strategy.category}) | 1D:${htfBias.d1} | 4H:${htfBias.h4} | 15m:${htfBias.m15} | 5m:${htfBias.m5}`;
    const generationSummary = `[Basket: ${strategy.name}] ${candidate.direction} ${symbol} (${entryTimeframe}, ${score}/100): ${candidate.entryRationale.slice(0, 3).join(' · ')}`;
    const id = `sig:basket:${symbol}:${entryTimeframe}:${strategy.id}:${candidate.direction}:${candleTime}`;

    const signal: TradingSignal = {
      id,
      symbol,
      entryTimeframe,
      setupTimeframe,
      direction: candidate.direction,
      state: 'CONFIRMED',
      provisional: false,
      score,
      classification,
      scoreBreakdown,
      htfBias,
      entryPrice: candidate.entryPrice,
      entryZone: candidate.entryZone,
      stopLoss: candidate.stopLoss,
      invalidationLevel: candidate.invalidationLevel,
      atrBuffer,
      takeProfits: candidate.takeProfits.map((tp) => ({
        level: tp.level,
        price: tp.price,
        riskReward: tp.riskReward,
        sourceLabel: tp.sourceLabel,
        hit: false,
        hitTime: null,
      })),
      primaryRR,
      maxRR,
      confluenceReasons: [
        `Strategy: ${strategy.name} (${strategy.category})`,
        ...candidate.entryRationale,
      ],
      generationSummary,
      timeframeSummary,
      source: 'strategy_basket',
      strategyId: strategy.id,
      strategyName: strategy.name,
      strategyCategory: strategy.category,
      marketRegime,
      createdAt: nowMs,
      confirmedAt: nowMs,
      activatedAt: null,
      closedAt: null,
      candleTime,
      realizedR: null,
      highestFavorableR: 0,
      maxAdverseR: 0,
      timeline: [
        {
          state: 'CONFIRMED',
          timestamp: nowMs,
          price: candidate.entryPrice,
          note: `Auto-basket [${strategy.name}] confirmed on ${entryTimeframe} close (${score}/100)`,
        },
      ],
    };

    this.signals.set(signal.id, signal);
    this.store?.upsertSignal(signal);
    this.pruneOldTerminalSignals();

    notifications.push(
      this.emitNotification(
        signal,
        signal.direction === 'BUY' ? 'signal_buy_new' : 'signal_sell_new',
        `${signal.direction} BASKET · ${symbol}`,
        `[${strategy.name}] ${score}/100 @ ${signal.entryPrice} · SL ${signal.stopLoss} · TP1 ${signal.takeProfits[0]?.price}`,
        signal.entryPrice,
        nowMs
      ),
      this.emitNotification(
        signal,
        'signal_confirmed',
        `BASKET SIGNAL · ${symbol} ${signal.direction}`,
        `${strategy.name} on ${entryTimeframe} (1:${signal.primaryRR} R:R)`,
        signal.entryPrice,
        nowMs
      )
    );

    return { signal, emitted: true, notifications };
  }

  /**
   * Evaluates live price or candle extremes against all open signals for a symbol.
   */
  public processPriceUpdate(
    symbol: InstrumentSymbol,
    price: number,
    candle: Candle | null,
    settings: SignalSettings,
    nowMs = Date.now()
  ): {
    updatedSignals: TradingSignal[];
    notifications: SignalNotification[];
  } {
    const updatedSignals: TradingSignal[] = [];
    const notifications: SignalNotification[] = [];
    if (!Number.isFinite(price) || price <= 0) {
      return { updatedSignals, notifications };
    }

    const high = candle ? Math.max(price, candle.high) : price;
    const low = candle ? Math.min(price, candle.low) : price;

    for (const sig of this.signals.values()) {
      if (sig.symbol !== symbol || isTerminalSignalState(sig.state)) continue;

      let changed = false;
      const isBuy = sig.direction === 'BUY';
      const risk = Math.abs(sig.entryPrice - sig.stopLoss);

      // Expiry checks for non-activated signals
      if (sig.state === 'WATCHING') {
        const ageMin = (nowMs - sig.createdAt) / 60000;
        if (ageMin > settings.maxWatchingMinutes) {
          sig.state = 'EXPIRED';
          sig.closedAt = nowMs;
          const fail = buildFailureDetails(sig, 'EXPIRED', {
            triggerExtreme: isBuy ? low : high,
            elapsedMin: Math.max(1, Math.round(ageMin)),
            wasWatching: true,
          });
          sig.outcomeSummary = fail.outcomeSummary;
          sig.failureReasons = fail.failureReasons;
          sig.timeline.push({
            state: 'EXPIRED',
            timestamp: nowMs,
            price,
            note: `Watching candidate expired after ${Math.round(ageMin)}m without confirmation`,
          });
          updatedSignals.push(sig);
          continue;
        }
        // Check invalidation before confirmation
        const invalidated = isBuy ? low <= sig.stopLoss : high >= sig.stopLoss;
        if (invalidated) {
          sig.state = 'INVALIDATED';
          sig.closedAt = nowMs;
          const fail = buildFailureDetails(sig, 'INVALIDATED', {
            triggerExtreme: isBuy ? low : high,
            elapsedMin: Math.max(0, Math.round(ageMin)),
            wasWatching: true,
          });
          sig.outcomeSummary = fail.outcomeSummary;
          sig.failureReasons = fail.failureReasons;
          sig.timeline.push({
            state: 'INVALIDATED',
            timestamp: nowMs,
            price,
            note: `Structural invalidation hit @ ${sig.stopLoss} prior to confirmation`,
          });
          updatedSignals.push(sig);
          continue;
        }
      }

      if (sig.state === 'CONFIRMED') {
        const ageMin = (nowMs - (sig.confirmedAt ?? sig.createdAt)) / 60000;
        if (ageMin > settings.maxPendingConfirmedMinutes) {
          sig.state = 'EXPIRED';
          sig.closedAt = nowMs;
          const fail = buildFailureDetails(sig, 'EXPIRED', {
            triggerExtreme: isBuy ? low : high,
            elapsedMin: Math.max(1, Math.round(ageMin)),
            wasWatching: false,
          });
          sig.outcomeSummary = fail.outcomeSummary;
          sig.failureReasons = fail.failureReasons;
          sig.timeline.push({
            state: 'EXPIRED',
            timestamp: nowMs,
            price,
            note: `Pending entry expired after ${Math.round(ageMin)}m without fill`,
          });
          updatedSignals.push(sig);
          continue;
        }

        // Did price invalidate before entry was reached?
        const invalidatedBeforeEntry = isBuy ? low <= sig.stopLoss : high >= sig.stopLoss;
        if (invalidatedBeforeEntry) {
          sig.state = 'INVALIDATED';
          sig.closedAt = nowMs;
          const fail = buildFailureDetails(sig, 'INVALIDATED', {
            triggerExtreme: isBuy ? low : high,
            elapsedMin: Math.max(0, Math.round(ageMin)),
            wasWatching: false,
          });
          sig.outcomeSummary = fail.outcomeSummary;
          sig.failureReasons = fail.failureReasons;
          sig.timeline.push({
            state: 'INVALIDATED',
            timestamp: nowMs,
            price,
            note: `Price breached SL/invalidation (${sig.stopLoss}) before entry zone fill`,
          });
          notifications.push(
            this.emitNotification(
              sig,
              'signal_invalidated',
              `SIGNAL INVALIDATED · ${symbol} ${sig.direction}`,
              `Invalidation level ${sig.stopLoss} breached prior to entry`,
              price,
              nowMs
            )
          );
          updatedSignals.push(sig);
          continue;
        }

        // Did price enter the entry zone?
        const enteredZone =
          (low <= sig.entryZone.upper && high >= sig.entryZone.lower) ||
          (isBuy ? price <= sig.entryZone.upper : price >= sig.entryZone.lower);

        if (enteredZone) {
          sig.state = 'ACTIVE';
          sig.activatedAt = nowMs;
          changed = true;
          sig.timeline.push({
            state: 'ACTIVE',
            timestamp: nowMs,
            price,
            note: `Entry reached inside [${sig.entryZone.lower} – ${sig.entryZone.upper}]`,
          });
          notifications.push(
            this.emitNotification(
              sig,
              'signal_entry_reached',
              `ENTRY REACHED · ${symbol} ${sig.direction}`,
              `Price ${price} entered execution zone [${sig.entryZone.lower} – ${sig.entryZone.upper}]`,
              price,
              nowMs
            )
          );
        }
      }

      // Active / Partial / TP tracking
      if (
        sig.state === 'ACTIVE' ||
        sig.state === 'PARTIAL' ||
        sig.state === 'TP1_HIT' ||
        sig.state === 'TP2_HIT'
      ) {
        if (risk > 0) {
          const favMove = isBuy ? high - sig.entryPrice : sig.entryPrice - low;
          const advMove = isBuy ? sig.entryPrice - low : high - sig.entryPrice;
          sig.highestFavorableR = Math.max(sig.highestFavorableR, Number((favMove / risk).toFixed(2)));
          sig.maxAdverseR = Math.max(sig.maxAdverseR, Number((advMove / risk).toFixed(2)));
        }

        // Check Stop Loss first (conservative ordering)
        const slHit = isBuy ? low <= sig.stopLoss : high >= sig.stopLoss;
        if (slHit) {
          const hitTps = sig.takeProfits.filter((t) => t.hit);
          if (hitTps.length === 0) {
            sig.realizedR = -1;
          } else {
            // Partial profits already secured before remaining position stopped
            const n = sig.takeProfits.length;
            const realizedParts = hitTps.reduce((s, t) => s + t.riskReward / n, 0);
            const remainingShare = (n - hitTps.length) / n;
            sig.realizedR = Number((realizedParts - remainingShare * 1.0).toFixed(2));
          }
          sig.state = 'STOPPED';
          sig.closedAt = nowMs;
          changed = true;
          const activeElapsedMin = Math.max(
            0,
            Math.round((nowMs - (sig.activatedAt ?? sig.confirmedAt ?? sig.createdAt)) / 60000)
          );
          const fail = buildFailureDetails(sig, 'STOPPED', {
            triggerExtreme: isBuy ? low : high,
            elapsedMin: activeElapsedMin,
            hitTpLevels: hitTps.map((t) => t.level),
          });
          sig.outcomeSummary = fail.outcomeSummary;
          sig.failureReasons = fail.failureReasons;
          sig.timeline.push({
            state: 'STOPPED',
            timestamp: nowMs,
            price: sig.stopLoss,
            note: `Stop Loss hit @ ${sig.stopLoss} (Realized ${sig.realizedR}R)`,
          });
          notifications.push(
            this.emitNotification(
              sig,
              'signal_sl_hit',
              `SL HIT · ${symbol} ${sig.direction}`,
              `Stop Loss @ ${sig.stopLoss} reached (Realized ${sig.realizedR}R)`,
              sig.stopLoss,
              nowMs
            )
          );
          updatedSignals.push(sig);
          continue;
        }

        // Check Take Profits sequentially
        for (const tp of sig.takeProfits) {
          if (tp.hit) continue;
          const reached = isBuy ? high >= tp.price : low <= tp.price;
          if (!reached) break;

          tp.hit = true;
          tp.hitTime = nowMs;
          changed = true;

          const isFinalTp = tp.level === sig.takeProfits.length;
          const tpState: SignalLifecycleState =
            tp.level === 1 ? 'TP1_HIT' : tp.level === 2 ? 'TP2_HIT' : 'TP3_HIT';

          if (!isFinalTp) {
            sig.timeline.push({
              state: 'PARTIAL',
              timestamp: nowMs,
              price: tp.price,
              note: `TP${tp.level} reached @ ${tp.price} (1:${tp.riskReward}R) — partial profit`,
            });
          }

          sig.state = tpState;
          sig.timeline.push({
            state: tpState,
            timestamp: nowMs,
            price: tp.price,
            note: `TP${tp.level} hit @ ${tp.price} (+${tp.riskReward}R · ${tp.sourceLabel})`,
          });

          if (isFinalTp) {
            const totalR =
              sig.takeProfits.reduce((acc, t) => acc + t.riskReward, 0) /
              sig.takeProfits.length;
            sig.realizedR = Number(totalR.toFixed(2));
            sig.closedAt = nowMs;
            sig.outcomeSummary = `All ${sig.takeProfits.length} structural target(s) hit (+${sig.realizedR}R realized, max +${sig.highestFavorableR.toFixed(2)}R).`;
          } else {
            // Update running realized R if closed early later
            const n = sig.takeProfits.length;
            const hitSum = sig.takeProfits
              .filter((t) => t.hit)
              .reduce((acc, t) => acc + t.riskReward / n, 0);
            sig.realizedR = Number(hitSum.toFixed(2));
          }

          notifications.push(
            this.emitNotification(
              sig,
              'signal_tp_hit',
              `TP${tp.level} HIT · ${symbol} ${sig.direction}`,
              `Target ${tp.level} (${tp.price}) reached for +${tp.riskReward}R`,
              tp.price,
              nowMs
            )
          );
        }
      }

      if (changed) {
        this.store?.upsertSignal(sig);
        updatedSignals.push(sig);
      }
    }

    for (const u of updatedSignals) {
      this.store?.upsertSignal(u);
    }

    return { updatedSignals, notifications };
  }

  public cancelSignal(signalId: string, nowMs = Date.now()): TradingSignal | null {
    const sig = this.signals.get(signalId);
    if (!sig || isTerminalSignalState(sig.state)) return null;
    sig.state = 'CANCELLED';
    sig.closedAt = nowMs;
    const fail = buildFailureDetails(sig, 'CANCELLED', {
      triggerExtreme: sig.entryPrice,
      elapsedMin: Math.max(0, Math.round((nowMs - sig.createdAt) / 60000)),
    });
    sig.outcomeSummary = fail.outcomeSummary;
    sig.failureReasons = fail.failureReasons;
    sig.timeline.push({
      state: 'CANCELLED',
      timestamp: nowMs,
      price: sig.entryPrice,
      note: 'Signal cancelled manually from terminal',
    });
    this.store?.upsertSignal(sig);
    return sig;
  }

  public deleteSignal(signalId: string): boolean {
    const existedInMemory = this.signals.delete(signalId);
    const deletedInStore = this.store ? this.store.deleteSignalById(signalId) : false;
    if (existedInMemory || deletedInStore) {
      for (let i = this.notifications.length - 1; i >= 0; i--) {
        if (this.notifications[i].signalId === signalId) {
          this.notifications.splice(i, 1);
        }
      }
      return true;
    }
    return false;
  }

  public deleteSignals(signalIds: string[]): string[] {
    const targetSet = new Set(signalIds.filter((id) => typeof id === 'string' && id.length > 0));
    if (targetSet.size === 0) return [];

    const deletedIds = new Set<string>();
    for (const id of targetSet) {
      if (this.signals.delete(id)) {
        deletedIds.add(id);
      }
    }
    if (this.store) {
      for (const id of this.store.deleteSignalsByIds(Array.from(targetSet))) {
        deletedIds.add(id);
      }
    }

    if (deletedIds.size > 0) {
      for (let i = this.notifications.length - 1; i >= 0; i--) {
        if (deletedIds.has(this.notifications[i].signalId)) {
          this.notifications.splice(i, 1);
        }
      }
    }
    return Array.from(deletedIds);
  }

  public clearSignals(scope: SignalDeleteScope = 'all'): string[] {
    const idsToDelete: string[] = [];
    for (const sig of this.signals.values()) {
      if (
        scope === 'all' ||
        (scope === 'watching' && sig.state === 'WATCHING') ||
        (scope === 'closed' && isTerminalSignalState(sig.state))
      ) {
        idsToDelete.push(sig.id);
      }
    }
    const deletedSet = new Set(idsToDelete);
    for (const id of deletedSet) {
      this.signals.delete(id);
    }
    if (this.store) {
      for (const id of this.store.deleteAllSignals(scope)) {
        deletedSet.add(id);
      }
    }
    if (deletedSet.size > 0) {
      for (let i = this.notifications.length - 1; i >= 0; i--) {
        if (deletedSet.has(this.notifications[i].signalId)) {
          this.notifications.splice(i, 1);
        }
      }
    }
    return Array.from(deletedSet);
  }

  public onQuote(quote: LiveQuote, settings: SignalSettings): {
    updatedSignals: TradingSignal[];
    notifications: SignalNotification[];
  } {
    return this.processPriceUpdate(quote.symbol, quote.price, null, settings, quote.lastUpdateTime || Date.now());
  }
}
