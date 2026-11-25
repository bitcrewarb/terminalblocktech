import { DEFAULT_SIGNAL_SETTINGS, INSTRUMENTS } from '../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  Candle,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  SignalDeleteScope,
  SignalDirection,
  SignalEvaluationDiagnostic,
  SignalNotification,
  SignalPerformanceStats,
  SignalSettings,
  Timeframe,
  TradingSignal,
} from '../shared/types/index.ts';
import { SignalLifecycleManager } from './lifecycle/index.ts';
import { computeSignalPerformance } from './performance/index.ts';
import {
  applyRiskRewardScore,
  evaluateDirectionalScore,
  extractHtfBiasSummary,
} from './scoring/index.ts';
import type { SignalSqliteStore } from './storage/sqlite.ts';
import { buildTradePlan } from './trade-plan/index.ts';
import type { DirectionalCandidate, SignalGenerationInput } from './types.ts';
import {
  evaluateSmcCriteriaGate,
  isInstrumentMarketClosed,
  validateDirectionalCandidate,
  validateMarketDataIntegrity,
} from './validation/index.ts';

export interface SignalEvaluationResult {
  diagnostic: SignalEvaluationDiagnostic;
  emittedSignals: TradingSignal[];
  notifications: SignalNotification[];
}

/**
 * Institutional BUY/SELL Signal Engine.
 * Consumes existing SMC & price-action AnalysisSnapshots across 1D, 4H, 1H, 15m, 5m (+ optional 1m)
 * without duplicating any indicator/SMC calculations.
 */
export class SignalEngine {
  private settings: SignalSettings = structuredClone(DEFAULT_SIGNAL_SETTINGS);
  private readonly lifecycle: SignalLifecycleManager;
  private readonly diagnostics = new Map<InstrumentSymbol, SignalEvaluationDiagnostic>();

  constructor(store?: SignalSqliteStore | null) {
    this.lifecycle = new SignalLifecycleManager(store);
  }

  public getSettings(): SignalSettings {
    return this.settings;
  }

  public updateSettings(next: Partial<SignalSettings>): SignalSettings {
    const nextSmc = next.smcCriteria
      ? {
          requireOrderBlock:
            typeof next.smcCriteria.requireOrderBlock === 'boolean'
              ? next.smcCriteria.requireOrderBlock
              : this.settings.smcCriteria.requireOrderBlock,
          requireFairValueGap:
            typeof next.smcCriteria.requireFairValueGap === 'boolean'
              ? next.smcCriteria.requireFairValueGap
              : this.settings.smcCriteria.requireFairValueGap,
          requireLiquiditySweep:
            typeof next.smcCriteria.requireLiquiditySweep === 'boolean'
              ? next.smcCriteria.requireLiquiditySweep
              : this.settings.smcCriteria.requireLiquiditySweep,
        }
      : this.settings.smcCriteria;

    this.settings = {
      ...this.settings,
      ...next,
      smcCriteria: {
        ...DEFAULT_SIGNAL_SETTINGS.smcCriteria,
        ...this.settings.smcCriteria,
        ...nextSmc,
      },
      timeframes: {
        ...this.settings.timeframes,
        ...(next.timeframes ?? {}),
      },
      weights: {
        ...this.settings.weights,
        ...(next.weights ?? {}),
      },
    };
    return this.settings;
  }

  public getSignals(symbol?: InstrumentSymbol): TradingSignal[] {
    return this.lifecycle.getAllSignals(symbol);
  }

  public getSignalById(id: string): TradingSignal | undefined {
    return this.lifecycle.getSignalById(id);
  }

  public getActiveSignals(symbol?: InstrumentSymbol): TradingSignal[] {
    return this.lifecycle.getActiveSignals(symbol);
  }

  public getNotifications(limit = 80): SignalNotification[] {
    return this.lifecycle.getNotifications(limit);
  }

  public getPerformance(): SignalPerformanceStats {
    return computeSignalPerformance(this.lifecycle.getAllSignals());
  }

  public getDiagnostics(): SignalEvaluationDiagnostic[] {
    return INSTRUMENTS.map((inst) => {
      const existing = this.diagnostics.get(inst.symbol);
      if (existing) return existing;
      return {
        symbol: inst.symbol,
        timeframe: this.settings.timeframes.entryTf,
        evaluatedAt: Date.now(),
        status: 'NO_TRADE',
        buyScore: 0,
        sellScore: 0,
        dominantDirection: 'NEUTRAL',
        rejectionReasons: ['Awaiting initial multi-timeframe candle synchronization'],
        htfBias: {
          d1: 'unavailable',
          h4: 'unavailable',
          h1: 'unavailable',
          m15: 'unavailable',
          m5: 'unavailable',
        },
      };
    });
  }

  public evaluate(input: SignalGenerationInput): SignalEvaluationResult {
    const nowMs = input.nowMs ?? Date.now();
    const { symbol, snapshots, quote, providerStatus } = input;
    const activeSettings = input.settings ?? this.settings;
    const entryTf = activeSettings.timeframes.entryTf;
    const htfBias = extractHtfBiasSummary(snapshots);
    const emittedSignals: TradingSignal[] = [];
    const notifications: SignalNotification[] = [];

    // 1. Validate market data integrity & required timeframes
    const integrity = validateMarketDataIntegrity(
      symbol,
      snapshots,
      quote,
      providerStatus,
      activeSettings,
      nowMs
    );

    if (!integrity.ok) {
      const diag: SignalEvaluationDiagnostic = {
        symbol,
        timeframe: entryTf,
        evaluatedAt: nowMs,
        status: 'NO_TRADE',
        buyScore: 0,
        sellScore: 0,
        dominantDirection: 'NEUTRAL',
        rejectionReasons: integrity.reasons,
        htfBias,
      };
      this.diagnostics.set(symbol, diag);
      return { diagnostic: diag, emittedSignals, notifications };
    }

    // 2. First update any open signals against latest price/candle
    const entrySnap = snapshots[entryTf];
    const latestCandle = entrySnap?.candles[entrySnap.candles.length - 1] ?? null;
    const priceUpdate = this.lifecycle.processPriceUpdate(
      symbol,
      integrity.currentPrice,
      latestCandle,
      activeSettings,
      nowMs
    );
    emittedSignals.push(...priceUpdate.updatedSignals);
    notifications.push(...priceUpdate.notifications);

    // 3. Evaluate BUY and SELL candidates independently
    const buildCandidate = (direction: SignalDirection): DirectionalCandidate => {
      const factors = evaluateDirectionalScore(
        direction,
        snapshots,
        activeSettings,
        integrity.currentPrice
      );
      const tradePlan = buildTradePlan(
        symbol,
        direction,
        snapshots,
        integrity.currentPrice,
        activeSettings
      );
      const finalScoreBreakdown = tradePlan.valid
        ? applyRiskRewardScore(
            factors.scoreBreakdown,
            tradePlan.primaryRR,
            activeSettings.minTp1RiskReward,
            activeSettings.weights.riskRewardQuality
          )
        : factors.scoreBreakdown;

      const confluenceReasons = [...factors.confluenceReasons, ...tradePlan.planNotes];

      return {
        direction,
        preRiskScoreBreakdown: factors.scoreBreakdown,
        finalScoreBreakdown,
        tradePlan,
        hasLiquiditySweep: factors.hasLiquiditySweep,
        hasStructuralConfirmation: factors.hasStructuralConfirmation,
        hasClosedCandleConfirmation: factors.hasClosedCandleConfirmation,
        hasConfluenceZone: factors.hasConfluenceZone,
        hasStrongConflict: factors.hasStrongConflict,
        conflictReasons: factors.conflictReasons,
        confluenceReasons,
        anchorCandleTime: factors.anchorCandleTime,
        htfBias,
      };
    };

    const buyCandidate = buildCandidate('BUY');
    const sellCandidate = buildCandidate('SELL');

    const buyScore = buyCandidate.finalScoreBreakdown.totalScore;
    const sellScore = sellCandidate.finalScoreBreakdown.totalScore;

    const activeForSymbol = this.lifecycle.getActiveSignals(symbol);
    const buyValidation = validateDirectionalCandidate(
      buyCandidate,
      activeForSymbol,
      activeSettings,
      snapshots
    );
    const sellValidation = validateDirectionalCandidate(
      sellCandidate,
      activeForSymbol,
      activeSettings,
      snapshots
    );

    // Pick strongest valid candidate if both somehow pass (prevent simultaneous opposing noise)
    const candidatesToTry: Array<{
      candidate: DirectionalCandidate;
      validation: ReturnType<typeof validateDirectionalCandidate>;
    }> = [
      { candidate: buyCandidate, validation: buyValidation },
      { candidate: sellCandidate, validation: sellValidation },
    ].sort(
      (a, b) =>
        b.candidate.finalScoreBreakdown.totalScore - a.candidate.finalScoreBreakdown.totalScore
    );

    let generatedSignal: TradingSignal | null = null;
    let status: SignalEvaluationDiagnostic['status'] = 'NO_TRADE';

    for (const item of candidatesToTry) {
      if (!item.validation.accepted) continue;
      const upsert = this.lifecycle.upsertCandidate(
        symbol,
        item.candidate,
        item.validation.provisionalOnly,
        activeSettings,
        nowMs
      );
      generatedSignal = upsert.signal;
      status = item.validation.provisionalOnly ? 'WATCHING_CANDIDATE' : 'SIGNAL_GENERATED';
      if (upsert.changed) {
        emittedSignals.push(upsert.signal);
      }
      notifications.push(...upsert.notifications);
      break;
    }

    const existingOpenSignal =
      generatedSignal ??
      this.lifecycle.getActiveSignals(symbol).find((s) => s.state !== 'WATCHING') ??
      this.lifecycle.getActiveSignals(symbol)[0] ??
      null;

    if (!generatedSignal && existingOpenSignal) {
      status =
        existingOpenSignal.state === 'WATCHING' ? 'WATCHING_CANDIDATE' : 'SIGNAL_GENERATED';
    }

    const dominantDirection: SignalEvaluationDiagnostic['dominantDirection'] =
      buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'NEUTRAL';

    const dominantValidation =
      dominantDirection === 'BUY'
        ? buyValidation
        : dominantDirection === 'SELL'
          ? sellValidation
          : buyValidation;

    const diag: SignalEvaluationDiagnostic = {
      symbol,
      timeframe: entryTf,
      evaluatedAt: nowMs,
      status,
      buyScore,
      sellScore,
      dominantDirection,
      rejectionReasons: generatedSignal
        ? dominantValidation.rejectionReasons
        : Array.from(
            new Set([
              ...dominantValidation.rejectionReasons,
              ...buyValidation.rejectionReasons.slice(0, 2),
              ...sellValidation.rejectionReasons.slice(0, 2),
            ])
          ).slice(0, 5),
      htfBias,
      signalId: existingOpenSignal?.id,
    };

    this.diagnostics.set(symbol, diag);
    return { diagnostic: diag, emittedSignals, notifications };
  }

  public processLiveQuote(quote: LiveQuote): {
    updatedSignals: TradingSignal[];
    notifications: SignalNotification[];
  } {
    if (isInstrumentMarketClosed(quote.symbol, quote, null, quote.lastUpdateTime || Date.now())) {
      return { updatedSignals: [], notifications: [] };
    }
    return this.lifecycle.onQuote(quote, this.settings);
  }

  public processCandleUpdate(
    symbol: InstrumentSymbol,
    candle: Candle,
    quote: LiveQuote | null = null,
    providerStatus: ProviderStatus | null = null,
    nowMs = Date.now()
  ): {
    updatedSignals: TradingSignal[];
    notifications: SignalNotification[];
  } {
    if (isInstrumentMarketClosed(symbol, quote, providerStatus, nowMs)) {
      return { updatedSignals: [], notifications: [] };
    }
    return this.lifecycle.processPriceUpdate(symbol, candle.close, candle, this.settings, nowMs);
  }

  public cancelSignal(signalId: string): TradingSignal | null {
    return this.lifecycle.cancelSignal(signalId);
  }

  public deleteSignal(signalId: string): boolean {
    return this.lifecycle.deleteSignal(signalId);
  }

  public deleteSignals(signalIds: string[]): string[] {
    return this.lifecycle.deleteSignals(signalIds);
  }

  public clearSignals(scope: SignalDeleteScope = 'all'): string[] {
    return this.lifecycle.clearSignals(scope);
  }

  public recordStrategyOnlyDiagnostic(
    symbol: InstrumentSymbol,
    entryTimeframe: Timeframe,
    snapshots: Partial<Record<Timeframe, AnalysisSnapshot | null>>,
    hasArmedStrategies: boolean,
    note?: string,
    nowMs = Date.now()
  ): SignalEvaluationDiagnostic {
    const htfBias = extractHtfBiasSummary(snapshots);
    const openStrategySignals = this.lifecycle
      .getActiveSignals(symbol)
      .filter((s) => s.source === 'strategy_basket');
    const openSig =
      openStrategySignals.find((s) => s.state !== 'WATCHING') ?? openStrategySignals[0] ?? null;

    const status: SignalEvaluationDiagnostic['status'] = openSig
      ? openSig.state === 'WATCHING'
        ? 'WATCHING_CANDIDATE'
        : 'SIGNAL_GENERATED'
      : 'NO_TRADE';

    const defaultNote = hasArmedStrategies
      ? 'Default generic signals disabled — monitoring armed Best & Filtered Strategies on closed candles'
      : 'Default generic signals disabled — click "Load Best Strategies" or arm Filtered Strategies to scan for trades';

    const diag: SignalEvaluationDiagnostic = {
      symbol,
      timeframe: entryTimeframe,
      evaluatedAt: nowMs,
      status,
      buyScore: 0,
      sellScore: 0,
      dominantDirection: openSig?.direction ?? 'NEUTRAL',
      rejectionReasons: [note ?? defaultNote],
      htfBias,
      signalId: openSig?.id,
    };

    this.diagnostics.set(symbol, diag);
    return diag;
  }

  public evaluateBasketCandidates(params: {
    symbol: InstrumentSymbol;
    entryTimeframe: Timeframe;
    setupTimeframe: Timeframe;
    closedCandleTime: number;
    atrBuffer: number;
    snapshots: Partial<Record<Timeframe, AnalysisSnapshot | null>>;
    quote: LiveQuote | null;
    providerStatus: ProviderStatus | null;
    maxConcurrentPositions: number;
    minConfluenceScore?: number;
    minRiskReward?: number;
    requireHtfAlignment?: boolean;
    marketRegime?: string;
    candidates: Array<{
      strategy: Pick<import('../shared/types/index.ts').BacktestStrategyDefinition, 'id' | 'name' | 'category'>;
      candidate: import('../backtest/strategies/index.ts').StrategySignalCandidate;
    }>;
    nowMs?: number;
  }): {
    emittedSignals: TradingSignal[];
    notifications: SignalNotification[];
    blockedReason?: string;
    smcFilteredReasons?: string[];
  } {
    const nowMs = params.nowMs ?? Date.now();
    if (isInstrumentMarketClosed(params.symbol, params.quote, params.providerStatus, nowMs)) {
      return {
        emittedSignals: [],
        notifications: [],
        blockedReason: `Market closed for ${params.symbol}`,
      };
    }
    if (params.quote?.stale) {
      return {
        emittedSignals: [],
        notifications: [],
        blockedReason: `Live feed stale for ${params.symbol}`,
      };
    }

    const htfBias = extractHtfBiasSummary(params.snapshots);
    const minScore = params.minConfluenceScore ?? this.settings.minStrategyConfluenceScore;
    const minRR = params.minRiskReward ?? this.settings.minTp1RiskReward;
    const htfTrend = params.snapshots[params.setupTimeframe]?.marketStructure.trend;
    const emittedSignals: TradingSignal[] = [];
    const notifications: SignalNotification[] = [];
    const smcFilteredReasons: string[] = [];

    const filteredCandidates = params.candidates.filter((item) => {
      if (item.candidate.confluenceScore < minScore) return false;
      const primaryRR = item.candidate.takeProfits[0]?.riskReward ?? 0;
      if (primaryRR < minRR) return false;
      if (params.requireHtfAlignment && (htfTrend === 'bullish' || htfTrend === 'bearish')) {
        if (htfTrend === 'bullish' && item.candidate.direction === 'SELL') return false;
        if (htfTrend === 'bearish' && item.candidate.direction === 'BUY') return false;
      }
      const smcGate = evaluateSmcCriteriaGate(
        item.candidate.direction,
        params.snapshots,
        params.entryTimeframe,
        params.setupTimeframe,
        this.settings.smcCriteria
      );
      if (!smcGate.passed) {
        if (smcGate.rejectionReason) {
          smcFilteredReasons.push(`${item.strategy.name}: ${smcGate.rejectionReason}`);
        }
        return false;
      }
      return true;
    });

    const sorted = [...filteredCandidates].sort(
      (a, b) => b.candidate.confluenceScore - a.candidate.confluenceScore
    );

    for (const item of sorted) {
      const res = this.lifecycle.upsertStrategyCandidate({
        symbol: params.symbol,
        entryTimeframe: params.entryTimeframe,
        setupTimeframe: params.setupTimeframe,
        strategy: item.strategy,
        candidate: item.candidate,
        atrBuffer: params.atrBuffer,
        htfBias,
        maxConcurrentPositions: params.maxConcurrentPositions,
        candleTime: params.closedCandleTime,
        nowMs,
        marketRegime: params.marketRegime,
      });
      if (res.emitted && res.signal) {
        emittedSignals.push(res.signal);
        notifications.push(...res.notifications);
      }
    }

    return {
      emittedSignals,
      notifications,
      ...(smcFilteredReasons.length > 0 ? { smcFilteredReasons } : {}),
    };
  }
}

export function buildSnapshotsRecord(
  pairs: Array<[Timeframe, AnalysisSnapshot | null | undefined]>
): Partial<Record<Timeframe, AnalysisSnapshot | null>> {
  const out: Partial<Record<Timeframe, AnalysisSnapshot | null>> = {};
  for (const [tf, snap] of pairs) {
    out[tf] = snap ?? null;
  }
  return out;
}
