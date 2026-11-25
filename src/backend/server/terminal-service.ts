import { runBasketPortfolioBacktest } from '../../backtest/basket-engine.ts';
import {
  buildDefaultDiscoveryConfig,
  inspectDiscoveryCombinationDetail,
  runDiscoveryOptimizationScan,
} from '../../backtest/discovery/engine.ts';
import {
  buildDefaultBacktestConfig,
  resolveDefaultHtfTimeframe,
  runMultiStrategyBacktest,
} from '../../backtest/engine.ts';
import { BacktestSqliteStore } from '../../backtest/storage/sqlite.ts';
import {
  BACKTEST_STRATEGY_DEFINITIONS,
  evaluateStrategiesOnBar,
} from '../../backtest/strategies/index.ts';
import { runDeterministicAnalysis } from '../../analysis/engine.ts';
import {
  analyzeLiveMarketCondition,
  buildLiveMarketStrategyReport,
} from '../../analysis/live-market-strategy.ts';
import { buildMultiTimeframeSummary } from '../../analysis/multi-timeframe/index.ts';
import { evaluateMarketDataIntegrity } from '../../market-data/integrity/index.ts';
import { MarketDataManager } from '../../market-data/subscriptions/index.ts';
import { InMemoryAlertEngine } from '../../monitoring/alerts/index.ts';
import { InMemoryEventEngine } from '../../monitoring/event-engine/index.ts';
import { LiveZoneMonitor } from '../../monitoring/zone-monitor/index.ts';
import {
  DEFAULT_RISK_SETTINGS,
  DEFAULT_SIGNAL_SETTINGS,
  DEFAULT_TECHNICAL_SETTINGS,
  getInstrumentMeta,
  INSTRUMENT_CONTRACT_SPECS,
  INSTRUMENTS,
  TIMEFRAME_SECONDS,
  TIMEFRAMES,
} from '../../shared/constants/index.ts';
import { deriveProductionAudit } from '../../shared/production-audit.ts';
import type {
  AlertNotification,
  AlertRule,
  AnalysisSnapshot,
  BacktestConfig,
  BacktestRunResult,
  BacktestRunSummary,
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  BasketBacktestConfig,
  BasketBacktestResult,
  Candle,
  CombinationDetailResult,
  DiscoveryRunSummary,
  DiscoveryScanConfig,
  DiscoveryScanProgress,
  DiscoveryScanRun,
  InstrumentSymbol,
  LiveConditionFilterMode,
  LiveMarketStrategyReport,
  LiveQuote,
  LiveStrategyBasketConfig,
  LiveStrategyBasketSlot,
  LiveStrategyBasketStrategyRef,
  LiveStrategyFilterCriteria,
  LiveStrategyReadinessFilter,
  MarketRegimeType,
  MT5AccountTradeMode,
  MT5BridgeStatus,
  MT5ExecutionOverview,
  MT5ExecutionSettings,
  MT5ManagedTrade,
  MT5OpenPosition,
  MT5SymbolQuote,
  MT5TradeCommand,
  MultiTimeframeSummary,
  PaperOrder,
  PaperPosition,
  ProviderStatus,
  RiskAccountSnapshot,
  RiskSettings,
  SignalDeleteScope,
  SignalEvaluationDiagnostic,
  SignalNotification,
  SignalPerformanceStats,
  SignalSettings,
  TechnicalSettings,
  Timeframe,
  TradeJournalEntry,
  TradingSessionName,
  TradingSignal,
  ZoneInteractionEvent,
} from '../../shared/types/index.ts';
import { buildSnapshotsRecord, SignalEngine } from '../../signals/engine.ts';
import { SignalSqliteStore } from '../../signals/storage/sqlite.ts';

import { AuthService } from '../../auth/service.ts';
import { PlatformSqliteStore } from '../../storage/platform-db.ts';
import { CentralizedRiskEngine, type PersistedRiskState } from '../../risk/engine.ts';
import { ExecutionGateway } from '../../execution/gateway.ts';
import { MT5DemoTradeManager } from '../../execution/mt5-trade-bridge.ts';
import { TradeJournalService } from '../../journal/service.ts';

export interface TerminalBroadcastSink {
  isStreamSubscribed?: (symbol: InstrumentSymbol, timeframe: Timeframe) => boolean;
  onQuote: (quote: LiveQuote) => void;
  onCandle: (symbol: InstrumentSymbol, timeframe: Timeframe, candle: Candle) => void;
  onSnapshot: (snapshot: AnalysisSnapshot) => void;
  onZoneInteractions: (
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    interactions: ZoneInteractionEvent[]
  ) => void;
  onEvents: (events: ZoneInteractionEvent[]) => void;
  onAlert: (alert: AlertNotification) => void;
  onAlertRulesUpdated?: (rules: AlertRule[]) => void;
  onAlertEnabledUpdated?: (enabled: boolean) => void;
  onAlertHistoryCleared?: () => void;
  onProviderStatus: (status: ProviderStatus) => void;
  onSignalUpdated?: (signal: TradingSignal) => void;
  onSignalsDeleted?: (payload: { deletedIds: string[]; scope?: SignalDeleteScope }) => void;
  onSignalNotification?: (notification: SignalNotification) => void;
  onSignalDiagnostics?: (diagnostics: SignalEvaluationDiagnostic[]) => void;
  onSignalPerformance?: (performance: SignalPerformanceStats) => void;
  onSignalSettingsUpdated?: (settings: SignalSettings) => void;
  onStrategyBasketUpdated?: (basket: LiveStrategyBasketConfig | null) => void;
  onDiscoveryProgress?: (progress: DiscoveryScanProgress) => void;
  onJournalUpdated?: (entry: TradeJournalEntry) => void;
  onPaperUpdated?: (payload: {
    positions: PaperPosition[];
    orders: PaperOrder[];
    riskSnapshot: RiskAccountSnapshot;
  }) => void;
  onMt5StatusUpdated?: (status: MT5BridgeStatus) => void;
  onMt5ExecutionUpdated?: (overview: MT5ExecutionOverview) => void;
}

const SIGNAL_WATCHED_TFS = new Set<Timeframe>(['1m', '5m', '15m', '1H', '4H', '1D']);

/**
 * In-memory coordinator uniting MarketDataManager, incremental AnalysisEngine,
 * LiveZoneMonitor, EventEngine, AlertEngine, and the BUY/SELL SignalEngine.
 */
export class TerminalService {
  public readonly marketData = new MarketDataManager();
  private readonly zoneMonitor = new LiveZoneMonitor();
  private readonly eventEngine = new InMemoryEventEngine();
  private readonly alertEngine = new InMemoryAlertEngine();
  private readonly signalStore = new SignalSqliteStore();
  private readonly signalEngine = new SignalEngine(this.signalStore);
  private readonly backtestStore = new BacktestSqliteStore();
  private readonly platformStore = new PlatformSqliteStore();
  public readonly authService = new AuthService(this.platformStore);
  private readonly riskEngine = new CentralizedRiskEngine(DEFAULT_RISK_SETTINGS);
  private readonly executionGateway = new ExecutionGateway(this.riskEngine);
  private readonly mt5TradeManager = new MT5DemoTradeManager();
  private readonly tradeJournal = new TradeJournalService(this.platformStore);

  private readonly snapshots = new Map<string, AnalysisSnapshot>();
  private readonly pendingRecompute = new Set<string>();
  private readonly lastRecomputeAt = new Map<string, number>();
  private readonly dealingRangeLookbacks = new Map<string, number>();
  private readonly signalEvalInFlight = new Set<InstrumentSymbol>();

  private settings: TechnicalSettings = { ...DEFAULT_TECHNICAL_SETTINGS };
  private liveStrategyBasket: LiveStrategyBasketConfig | null = this.backtestStore.getLiveBasket();
  private sink: TerminalBroadcastSink | null = null;
  private throttledFlushTimer: NodeJS.Timeout | null = null;
  private signalWarmupTimer: NodeJS.Timeout | null = null;
  private signalScanTimer: NodeJS.Timeout | null = null;
  private readonly quoteBroadcastAt = new Map<InstrumentSymbol, number>();
  private readonly pendingQuoteBroadcast = new Map<InstrumentSymbol, LiveQuote>();
  private readonly quoteBroadcastTimers = new Map<InstrumentSymbol, NodeJS.Timeout>();
  private readonly tickEvalAt = new Map<InstrumentSymbol, number>();
  private readonly pendingTickEval = new Map<InstrumentSymbol, LiveQuote>();
  private readonly tickEvalTimers = new Map<InstrumentSymbol, NodeJS.Timeout>();
  private readonly zoneEvalAt = new Map<InstrumentSymbol, number>();
  private readonly pendingZoneEval = new Map<InstrumentSymbol, LiveQuote>();
  private readonly zoneEvalTimers = new Map<InstrumentSymbol, NodeJS.Timeout>();
  private stopped = false;
  private discoveryInFlight = false;
  private lastPaperBroadcastAt = 0;
  private lastMt5BroadcastAt = 0;
  private mt5TicksMap = new Map<string, MT5SymbolQuote>();
  private mt5Status: MT5BridgeStatus;
  private discoveryProgress: DiscoveryScanProgress = {
    jobId: 'idle',
    status: 'idle',
    completedSteps: 0,
    totalSteps: 0,
    message: 'Ready to scan historical markets',
    startedAt: null,
  };

  constructor() {
    this.riskEngine.hydrateState(this.platformStore.loadRiskEngineState<PersistedRiskState>());
    this.executionGateway.hydrate(
      this.platformStore.getAllPaperOrders(),
      this.platformStore.getAllPaperPositions()
    );
    const savedSigSettings = this.platformStore.loadSignalSettings();
    if (savedSigSettings) {
      this.signalEngine.updateSettings({
        ...DEFAULT_SIGNAL_SETTINGS,
        ...savedSigSettings,
        smcCriteria: {
          ...DEFAULT_SIGNAL_SETTINGS.smcCriteria,
          ...(savedSigSettings.smcCriteria ?? {}),
        },
        timeframes: {
          ...DEFAULT_SIGNAL_SETTINGS.timeframes,
          ...(savedSigSettings.timeframes ?? {}),
        },
        weights: {
          ...DEFAULT_SIGNAL_SETTINGS.weights,
          ...(savedSigSettings.weights ?? {}),
        },
      });
    }
    this.alertEngine.hydrate(
      this.platformStore.loadAlertRules(),
      this.platformStore.getAlertHistory(80),
      this.platformStore.getAlertSystemEnabled()
    );
    this.mt5TradeManager.hydrate(
      this.platformStore.loadMt5ExecutionSettings(),
      this.platformStore.getMt5TradeCommands(120),
      this.platformStore.getAllMt5ManagedTrades()
    );

    const savedMt5 = this.platformStore.loadMt5BridgeSnapshot();
    this.mt5Status = savedMt5
      ? {
          ...savedMt5,
          connected: false,
          statusLabel: savedMt5.lastHeartbeat > 0 ? 'STALE' : 'DISCONNECTED',
          paperMode: true,
          requiresApiToken: Boolean(process.env.TERMINAL_API_TOKEN),
          openPositions: Array.isArray(savedMt5.openPositions) ? savedMt5.openPositions : [],
          syncedTicks: Array.isArray(savedMt5.syncedTicks) ? savedMt5.syncedTicks : [],
        }
      : {
          connected: false,
          statusLabel: 'DISCONNECTED',
          latencyMs: 0,
          lastHeartbeat: 0,
          lastTickAt: null,
          messagesReceived: 0,
          paperMode: true,
          requiresApiToken: Boolean(process.env.TERMINAL_API_TOKEN),
          openPositions: [],
          syncedTicks: [],
          lastError: null,
        };
    for (const t of this.mt5Status.syncedTicks) {
      this.mt5TicksMap.set(t.rawSymbol, t);
    }
  }

  public setBroadcastSink(sink: TerminalBroadcastSink): void {
    this.sink = sink;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.marketData.subscribe({
      onQuote: (quote) => {
        this.scheduleQuoteBroadcast(quote);
        this.scheduleTickLifecycleEval(quote);
        this.scheduleZoneEval(quote);
      },
      onCandle: (symbol, timeframe, _candles, updated, closedPrev) => {
        if (!this.sink?.isStreamSubscribed || this.sink.isStreamSubscribed(symbol, timeframe)) {
          this.sink?.onCandle(symbol, timeframe, updated);
        }
        this.processPaperPriceUpdate(symbol, {
          price: updated.close,
          high: updated.high,
          low: updated.low,
        });
        const isEntryTf = timeframe === this.signalEngine.getSettings().timeframes.entryTf;
        const isBasketTf = this.getBasketSlotsForSymbol(symbol).some(
          (slot) => slot.timeframe === timeframe
        );
        if (isEntryTf || isBasketTf) {
          const sigRes = this.signalEngine.processCandleUpdate(
            symbol,
            updated,
            this.marketData.getQuote(symbol),
            this.marketData.getProviderStatus(symbol)
          );
          this.broadcastSignalUpdates(sigRes.updatedSignals, sigRes.notifications, false);
        }
        const key = `${symbol}:${timeframe}`;
        // Immediately recompute on candle close; throttle mid-bar recomputation
        if (closedPrev || updated.isClosed) {
          void this.recomputeSnapshot(symbol, timeframe).then(() => {
            if (SIGNAL_WATCHED_TFS.has(timeframe) || isBasketTf) {
              void this.evaluateSignalsForSymbol(symbol);
            }
          });
        } else {
          this.pendingRecompute.add(key);
        }
      },
      onStatus: (status) => {
        this.sink?.onProviderStatus(status);
      },
    });

    await this.marketData.startAll();

    // Flush throttled active-bar analysis updates every 5 seconds max
    this.throttledFlushTimer = setInterval(() => {
      if (this.pendingRecompute.size === 0) return;
      const keys = Array.from(this.pendingRecompute);
      this.pendingRecompute.clear();
      const allowDefaultSignals = this.signalEngine.getSettings().allowDefaultSignals;
      const symbolsToEvaluate = new Set<InstrumentSymbol>();
      const now = Date.now();
      for (const k of keys) {
        const [sym, tf] = k.split(':') as [InstrumentSymbol, Timeframe];
        const last = this.lastRecomputeAt.get(k) ?? 0;
        if (now - last >= 4500) {
          void this.recomputeSnapshot(sym, tf);
          if (allowDefaultSignals && SIGNAL_WATCHED_TFS.has(tf)) {
            symbolsToEvaluate.add(sym);
          }
        }
      }
      for (const sym of symbolsToEvaluate) {
        void this.evaluateSignalsForSymbol(sym);
      }
    }, 5000);

    // Initial multi-timeframe signal scan after core preload finishes
    this.signalWarmupTimer = setTimeout(() => {
      void this.evaluateAllInstrumentSignals();
    }, 4500);

    // Periodic multi-timeframe signal refresh across all 4 instruments
    this.signalScanTimer = setInterval(() => {
      void this.evaluateAllInstrumentSignals();
    }, 20000);
  }

  private scheduleQuoteBroadcast(quote: LiveQuote): void {
    const now = Date.now();
    const last = this.quoteBroadcastAt.get(quote.symbol) ?? 0;
    if (now - last >= 200) {
      this.quoteBroadcastAt.set(quote.symbol, now);
      this.pendingQuoteBroadcast.delete(quote.symbol);
      const t = this.quoteBroadcastTimers.get(quote.symbol);
      if (t) {
        clearTimeout(t);
        this.quoteBroadcastTimers.delete(quote.symbol);
      }
      this.sink?.onQuote(quote);
      return;
    }

    this.pendingQuoteBroadcast.set(quote.symbol, quote);
    if (!this.quoteBroadcastTimers.has(quote.symbol)) {
      const timer = setTimeout(() => {
        this.quoteBroadcastTimers.delete(quote.symbol);
        if (this.stopped) return;
        const latest = this.pendingQuoteBroadcast.get(quote.symbol);
        this.pendingQuoteBroadcast.delete(quote.symbol);
        if (latest) {
          this.quoteBroadcastAt.set(quote.symbol, Date.now());
          this.sink?.onQuote(latest);
        }
      }, 200);
      this.quoteBroadcastTimers.set(quote.symbol, timer);
    }
  }

  private runTickLifecycleEval(quote: LiveQuote): void {
    this.processPaperPriceUpdate(quote.symbol, {
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
    });
    this.evaluateMt5TradeManagement(quote.symbol, {
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
    });
    const sigRes = this.signalEngine.processLiveQuote(quote);
    this.broadcastSignalUpdates(sigRes.updatedSignals, sigRes.notifications, false);
  }

  private scheduleTickLifecycleEval(quote: LiveQuote): void {
    const now = Date.now();
    const last = this.tickEvalAt.get(quote.symbol) ?? 0;
    if (now - last >= 250) {
      this.tickEvalAt.set(quote.symbol, now);
      this.pendingTickEval.delete(quote.symbol);
      const t = this.tickEvalTimers.get(quote.symbol);
      if (t) {
        clearTimeout(t);
        this.tickEvalTimers.delete(quote.symbol);
      }
      this.runTickLifecycleEval(quote);
      return;
    }

    this.pendingTickEval.set(quote.symbol, quote);
    if (!this.tickEvalTimers.has(quote.symbol)) {
      const timer = setTimeout(() => {
        this.tickEvalTimers.delete(quote.symbol);
        if (this.stopped) return;
        const latest = this.pendingTickEval.get(quote.symbol);
        this.pendingTickEval.delete(quote.symbol);
        if (latest) {
          this.tickEvalAt.set(quote.symbol, Date.now());
          this.runTickLifecycleEval(latest);
        }
      }, 250);
      this.tickEvalTimers.set(quote.symbol, timer);
    }
  }

  private scheduleZoneEval(quote: LiveQuote): void {
    const now = Date.now();
    const last = this.zoneEvalAt.get(quote.symbol) ?? 0;
    if (now - last >= 1000) {
      this.zoneEvalAt.set(quote.symbol, now);
      this.pendingZoneEval.delete(quote.symbol);
      const t = this.zoneEvalTimers.get(quote.symbol);
      if (t) {
        clearTimeout(t);
        this.zoneEvalTimers.delete(quote.symbol);
      }
      this.evaluateLivePriceAgainstCachedSnapshots(quote);
      return;
    }

    this.pendingZoneEval.set(quote.symbol, quote);
    if (!this.zoneEvalTimers.has(quote.symbol)) {
      const timer = setTimeout(() => {
        this.zoneEvalTimers.delete(quote.symbol);
        if (this.stopped) return;
        const latest = this.pendingZoneEval.get(quote.symbol);
        this.pendingZoneEval.delete(quote.symbol);
        if (latest) {
          this.zoneEvalAt.set(quote.symbol, Date.now());
          this.evaluateLivePriceAgainstCachedSnapshots(latest);
        }
      }, 1000);
      this.zoneEvalTimers.set(quote.symbol, timer);
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.throttledFlushTimer) {
      clearInterval(this.throttledFlushTimer);
      this.throttledFlushTimer = null;
    }
    if (this.signalWarmupTimer) {
      clearTimeout(this.signalWarmupTimer);
      this.signalWarmupTimer = null;
    }
    if (this.signalScanTimer) {
      clearInterval(this.signalScanTimer);
      this.signalScanTimer = null;
    }
    for (const t of this.quoteBroadcastTimers.values()) clearTimeout(t);
    this.quoteBroadcastTimers.clear();
    this.pendingQuoteBroadcast.clear();
    for (const t of this.tickEvalTimers.values()) clearTimeout(t);
    this.tickEvalTimers.clear();
    this.pendingTickEval.clear();
    for (const t of this.zoneEvalTimers.values()) clearTimeout(t);
    this.zoneEvalTimers.clear();
    this.pendingZoneEval.clear();
    this.marketData.stopAll();
    this.signalStore.close();
    this.backtestStore.close();
  }

  public getSettings(): TechnicalSettings {
    return this.settings;
  }

  public updateSettings(next: Partial<TechnicalSettings>): TechnicalSettings {
    this.settings = { ...this.settings, ...next };
    // Recompute all cached snapshots immediately with updated parameters
    for (const key of this.snapshots.keys()) {
      const [sym, tf] = key.split(':') as [InstrumentSymbol, Timeframe];
      void this.recomputeSnapshot(sym, tf);
    }
    return this.settings;
  }

  public setDealingRangeLookback(symbol: InstrumentSymbol, timeframe: Timeframe, lookback?: number): void {
    const key = `${symbol}:${timeframe}`;
    if (lookback === undefined) {
      this.dealingRangeLookbacks.delete(key);
    } else {
      this.dealingRangeLookbacks.set(key, lookback);
    }
    void this.recomputeSnapshot(symbol, timeframe);
  }

  public getAlertSystemEnabled(): boolean {
    return this.alertEngine.isEnabled();
  }

  public setAlertSystemEnabled(enabled: boolean): boolean {
    const next = this.alertEngine.setEnabled(enabled);
    this.platformStore.setAlertSystemEnabled(next);
    this.sink?.onAlertEnabledUpdated?.(next);
    return next;
  }

  public getAlertRules(): AlertRule[] {
    return this.alertEngine.getRules();
  }

  public updateAlertRules(rules: AlertRule[]): AlertRule[] {
    const updated = this.alertEngine.updateRules(rules);
    this.platformStore.saveAlertRules(updated);
    this.sink?.onAlertRulesUpdated?.(updated);
    return updated;
  }

  public resetAlertRules(): AlertRule[] {
    const updated = this.alertEngine.resetDefaultRules();
    this.platformStore.saveAlertRules(updated);
    this.sink?.onAlertRulesUpdated?.(updated);
    return updated;
  }

  public getAlertHistory(): AlertNotification[] {
    return this.alertEngine.getHistory();
  }

  public clearAlertHistory(): void {
    this.alertEngine.clearHistory();
    this.platformStore.clearAlertHistory();
    this.sink?.onAlertHistoryCleared?.();
  }

  public triggerTestAlert(
    symbol: InstrumentSymbol = 'XAUUSD',
    timeframe: Timeframe = '15m',
    ruleId?: string
  ): AlertNotification {
    const quote = this.marketData.getQuote(symbol);
    const candles = this.marketData.getCachedCandles(symbol, timeframe);
    const price = quote?.price ?? candles[candles.length - 1]?.close ?? 0;
    const alert = this.alertEngine.triggerTestAlert(symbol, timeframe, price, ruleId);
    this.platformStore.saveAlertNotification(alert);
    this.sink?.onAlert(alert);
    return alert;
  }

  public getLiveEvents(symbol?: InstrumentSymbol): ZoneInteractionEvent[] {
    return this.eventEngine.getEvents(symbol);
  }

  // ==========================================================================
  // Signal System Accessors & Evaluators
  // ==========================================================================

  public getSignals(symbol?: InstrumentSymbol): TradingSignal[] {
    const all = this.signalEngine.getSignals(symbol);
    if (this.signalEngine.getSettings().allowDefaultSignals) {
      return all;
    }
    return all.filter((s) => s.source === 'strategy_basket');
  }

  public getSignalSettings(): SignalSettings {
    return this.signalEngine.getSettings();
  }

  public updateSignalSettings(next: Partial<SignalSettings>): SignalSettings {
    const prev = this.signalEngine.getSettings();
    const smcChanged =
      Boolean(next.smcCriteria) &&
      (Boolean(next.smcCriteria?.requireOrderBlock) !== prev.smcCriteria.requireOrderBlock ||
        Boolean(next.smcCriteria?.requireFairValueGap) !== prev.smcCriteria.requireFairValueGap ||
        Boolean(next.smcCriteria?.requireLiquiditySweep) !== prev.smcCriteria.requireLiquiditySweep);

    const updated = this.signalEngine.updateSettings(next);
    this.platformStore.saveSignalSettings(updated);
    if (smcChanged && this.liveStrategyBasket) {
      this.liveStrategyBasket.lastClosedBarTime = null;
      for (const slot of this.liveStrategyBasket.assignments ?? []) {
        slot.lastClosedBarTime = null;
      }
    }
    this.sink?.onSignalSettingsUpdated?.(updated);
    void this.evaluateAllInstrumentSignals();
    return updated;
  }

  public getSignalPerformance(): SignalPerformanceStats {
    return this.signalEngine.getPerformance();
  }

  public getSignalDiagnostics(): SignalEvaluationDiagnostic[] {
    return this.signalEngine.getDiagnostics();
  }

  public getSignalNotifications(): SignalNotification[] {
    return this.signalEngine.getNotifications();
  }

  public cancelSignal(signalId: string): TradingSignal | null {
    const cancelled = this.signalEngine.cancelSignal(signalId);
    if (cancelled) {
      this.broadcastSignalUpdates([cancelled], [], true);
    }
    return cancelled;
  }

  public deleteSignal(signalId: string): boolean {
    const deleted = this.signalEngine.deleteSignal(signalId);
    if (deleted) {
      this.sink?.onSignalsDeleted?.({ deletedIds: [signalId] });
      this.sink?.onSignalPerformance?.(this.signalEngine.getPerformance());
      this.sink?.onSignalDiagnostics?.(this.signalEngine.getDiagnostics());
    }
    return deleted;
  }

  public deleteSignals(signalIds: string[]): string[] {
    const deletedIds = this.signalEngine.deleteSignals(signalIds);
    if (deletedIds.length > 0) {
      this.sink?.onSignalsDeleted?.({ deletedIds });
      this.sink?.onSignalPerformance?.(this.signalEngine.getPerformance());
      this.sink?.onSignalDiagnostics?.(this.signalEngine.getDiagnostics());
    }
    return deletedIds;
  }

  public clearSignals(scope: SignalDeleteScope = 'all'): string[] {
    const deletedIds = this.signalEngine.clearSignals(scope);
    if (deletedIds.length > 0) {
      this.sink?.onSignalsDeleted?.({ deletedIds, scope });
      this.sink?.onSignalPerformance?.(this.signalEngine.getPerformance());
      this.sink?.onSignalDiagnostics?.(this.signalEngine.getDiagnostics());
    }
    return deletedIds;
  }

  // ==========================================================================
  // Multi-Strategy SMC & Price Action Backtesting
  // ==========================================================================

  public getBacktestStrategies(): BacktestStrategyDefinition[] {
    return BACKTEST_STRATEGY_DEFINITIONS;
  }

  public getBacktestRuns(limit = 40): BacktestRunSummary[] {
    return this.backtestStore.listRuns(limit);
  }

  public getBacktestRunById(id: string): BacktestRunResult | null {
    return this.backtestStore.getRunById(id);
  }

  public deleteBacktestRun(id: string): boolean {
    return this.backtestStore.deleteRun(id);
  }

  public async runBacktest(
    partial: Partial<BacktestConfig> = {},
    options: { persist?: boolean } = {}
  ): Promise<BacktestRunResult> {
    const config = buildDefaultBacktestConfig({
      ...partial,
      htfTimeframe:
        partial.htfTimeframe ??
        resolveDefaultHtfTimeframe(partial.timeframe ?? '15m'),
    });

    const providerStatus = this.marketData.getProviderStatus(config.symbol);
    const providerName = providerStatus?.providerName ?? 'Historical Feed';

    const execSec = TIMEFRAME_SECONDS[config.timeframe];
    const htfSec = TIMEFRAME_SECONDS[config.htfTimeframe];
    const tfRatio = Math.max(1, Math.round(htfSec / Math.max(60, execSec)));
    const htfFetchBars = Math.max(180, Math.min(10000, Math.ceil(config.bars / tfRatio) + 120));
    const dailyFetchBars = Math.max(
      180,
      Math.min(4000, Math.ceil((config.bars * execSec) / 86400) + 90)
    );
    const [execCandles, htfCandles, dailyCandles] = await Promise.all([
      this.marketData.fetchRawHistory(config.symbol, config.timeframe, config.bars),
      this.marketData.fetchRawHistory(config.symbol, config.htfTimeframe, htfFetchBars),
      this.marketData.fetchRawHistory(config.symbol, '1D', dailyFetchBars).catch(() => [] as Candle[]),
    ]);

    const result = runMultiStrategyBacktest({
      config,
      execCandles,
      htfCandles,
      dailyCandles,
      providerName,
      technicalSettings: this.settings,
    });

    if (options.persist !== false) {
      this.backtestStore.saveRun(result);
    }
    return result;
  }

  public async runBasketBacktest(
    partial: Partial<BasketBacktestConfig> & { strategyIds: BacktestStrategyId[] }
  ): Promise<BasketBacktestResult> {
    const config = buildDefaultBacktestConfig({
      ...partial,
      htfTimeframe:
        partial.htfTimeframe ??
        resolveDefaultHtfTimeframe(partial.timeframe ?? '15m'),
    });

    const providerStatus = this.marketData.getProviderStatus(config.symbol);
    const providerName = providerStatus?.providerName ?? 'Historical Feed';

    const execSec = TIMEFRAME_SECONDS[config.timeframe];
    const htfSec = TIMEFRAME_SECONDS[config.htfTimeframe];
    const tfRatio = Math.max(1, Math.round(htfSec / Math.max(60, execSec)));
    const htfFetchBars = Math.max(180, Math.min(10000, Math.ceil(config.bars / tfRatio) + 120));
    const dailyFetchBars = Math.max(
      180,
      Math.min(4000, Math.ceil((config.bars * execSec) / 86400) + 90)
    );
    const [execCandles, htfCandles, dailyCandles] = await Promise.all([
      this.marketData.fetchRawHistory(config.symbol, config.timeframe, config.bars),
      this.marketData.fetchRawHistory(config.symbol, config.htfTimeframe, htfFetchBars),
      this.marketData.fetchRawHistory(config.symbol, '1D', dailyFetchBars).catch(() => [] as Candle[]),
    ]);

    return runBasketPortfolioBacktest({
      config: {
        ...config,
        strategyIds: partial.strategyIds,
        maxConcurrentPositions: partial.maxConcurrentPositions ?? 4,
        maxPortfolioHeatPercent: partial.maxPortfolioHeatPercent ?? 4.0,
      },
      execCandles,
      htfCandles,
      dailyCandles,
      providerName,
      technicalSettings: this.settings,
    });
  }

  public getLiveStrategyBasket(): LiveStrategyBasketConfig | null {
    return this.liveStrategyBasket;
  }

  // ==========================================================================
  // Best Strategy Discovery & Optimization Scanner
  // ==========================================================================

  public getDiscoveryProgress(): DiscoveryScanProgress {
    return this.discoveryProgress;
  }

  public getDiscoveryRuns(limit = 25): DiscoveryRunSummary[] {
    return this.backtestStore.listDiscoveryRuns(limit);
  }

  public getDiscoveryRunById(id: string): DiscoveryScanRun | null {
    return this.backtestStore.getDiscoveryRunById(id);
  }

  public deleteDiscoveryRun(id: string): boolean {
    return this.backtestStore.deleteDiscoveryRun(id);
  }

  public startDiscoveryScan(partial: Partial<DiscoveryScanConfig> = {}): DiscoveryScanProgress {
    if (this.discoveryInFlight) {
      return this.discoveryProgress;
    }

    const config = buildDefaultDiscoveryConfig(partial);
    const jobId = `DJOB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const totalSteps = config.symbols.length * config.timeframes.length + 1;

    this.discoveryInFlight = true;
    this.discoveryProgress = {
      jobId,
      status: 'running',
      completedSteps: 0,
      totalSteps,
      currentSymbol: config.symbols[0],
      currentTimeframe: config.timeframes[0],
      message: `Starting optimization discovery across ${config.symbols.length} instruments × ${config.timeframes.length} timeframes...`,
      startedAt: Date.now(),
    };
    this.sink?.onDiscoveryProgress?.(this.discoveryProgress);

    void (async () => {
      try {
        const run = await runDiscoveryOptimizationScan({
          config,
          technicalSettings: this.settings,
          fetchHistory: async (symbol, timeframe, bars) => {
            const candles = await this.marketData.fetchRawHistory(symbol, timeframe, bars);
            const provider =
              this.marketData.getProviderStatus(symbol)?.providerName ?? 'Historical Feed';
            return { candles, provider };
          },
          onProgress: (info) => {
            this.discoveryProgress = {
              ...this.discoveryProgress,
              completedSteps: info.completedSteps,
              totalSteps: info.totalSteps,
              currentSymbol: info.currentSymbol,
              currentTimeframe: info.currentTimeframe,
              message: info.message,
            };
            this.sink?.onDiscoveryProgress?.(this.discoveryProgress);
          },
        });

        this.backtestStore.saveDiscoveryRun(run);
        this.discoveryProgress = {
          ...this.discoveryProgress,
          status: 'completed',
          completedSteps: totalSteps,
          totalSteps,
          runId: run.id,
          message: `Completed in ${(run.durationMs / 1000).toFixed(1)}s — ${run.summaryStats.validatedCount} validated & ${run.summaryStats.preliminaryCount} preliminary combinations`,
        };
        this.sink?.onDiscoveryProgress?.(this.discoveryProgress);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Discovery optimization scan failed';
        this.discoveryProgress = {
          ...this.discoveryProgress,
          status: 'failed',
          error: msg,
          message: msg,
        };
        this.sink?.onDiscoveryProgress?.(this.discoveryProgress);
      } finally {
        this.discoveryInFlight = false;
      }
    })();

    return this.discoveryProgress;
  }

  public async inspectDiscoveryCombination(
    runId: string,
    comboKey: string
  ): Promise<CombinationDetailResult> {
    const run = this.backtestStore.getDiscoveryRunById(runId);
    if (!run) {
      throw new Error('Discovery scan run not found');
    }
    const combo = run.combinations.find((c) => c.comboKey === comboKey);
    if (!combo) {
      throw new Error('Combination not found in discovery run');
    }

    return inspectDiscoveryCombinationDetail({
      combination: combo,
      config: run.config,
      technicalSettings: this.settings,
      fetchHistory: async (symbol, timeframe, bars) => {
        const candles = await this.marketData.fetchRawHistory(symbol, timeframe, bars);
        const provider =
          this.marketData.getProviderStatus(symbol)?.providerName ?? 'Historical Feed';
        return { candles, provider };
      },
    });
  }

  private getBasketSlotsForSymbol(symbol: InstrumentSymbol): LiveStrategyBasketSlot[] {
    const basket = this.liveStrategyBasket;
    if (!basket || !basket.enabled) return [];
    if (Array.isArray(basket.assignments) && basket.assignments.length > 0) {
      return basket.assignments.filter((a) => a.symbol === symbol && a.strategies.length > 0);
    }
    if (basket.symbol === symbol && basket.strategies.length > 0) {
      return [
        {
          symbol: basket.symbol,
          timeframe: basket.timeframe,
          htfTimeframe: basket.htfTimeframe,
          strategies: basket.strategies,
          lastClosedBarTime: basket.lastClosedBarTime,
        },
      ];
    }
    return [];
  }

  public setLiveStrategyBasket(input: {
    enabled?: boolean;
    symbol: InstrumentSymbol;
    timeframe: Timeframe;
    htfTimeframe?: Timeframe;
    strategyIds: BacktestStrategyId[];
    assignments?: LiveStrategyBasketSlot[];
    filters?: LiveStrategyFilterCriteria;
    selectionLabel?: string;
    maxConcurrentPositions?: number;
    minRiskReward?: number;
    sourceRunId?: string;
    mode?: 'replace' | 'merge';
  }): LiveStrategyBasketConfig {
    const defMap = new Map(BACKTEST_STRATEGY_DEFINITIONS.map((d) => [d.id, d]));
    const mode = input.mode ?? 'replace';

    let incomingAssignments: LiveStrategyBasketSlot[] = [];
    if (Array.isArray(input.assignments) && input.assignments.length > 0) {
      for (const slot of input.assignments) {
        const validStrats: LiveStrategyBasketStrategyRef[] = Array.from(
          new Map(
            slot.strategies
              .map((s) => defMap.get(s.id))
              .filter((d): d is BacktestStrategyDefinition => Boolean(d))
              .map((d) => [d.id, { id: d.id, name: d.name, category: d.category }])
          ).values()
        ).slice(0, 10);
        if (validStrats.length === 0) continue;
        incomingAssignments.push({
          symbol: slot.symbol,
          timeframe: slot.timeframe,
          htfTimeframe: slot.htfTimeframe ?? resolveDefaultHtfTimeframe(slot.timeframe),
          strategies: validStrats,
          sourceRunId: slot.sourceRunId ?? input.sourceRunId,
          readiness: slot.readiness,
          bestRegime: slot.bestRegime,
          poorRegimes: slot.poorRegimes,
          avoidSessions: slot.avoidSessions,
          oosWinRate: slot.oosWinRate,
          oosProfitFactor: slot.oosProfitFactor,
          oosExpectancyR: slot.oosExpectancyR,
          oosScore: slot.oosScore,
          lastClosedBarTime: null,
        });
      }
    } else {
      const validStrats: LiveStrategyBasketStrategyRef[] = Array.from(
        new Map(
          input.strategyIds
            .map((id) => defMap.get(id))
            .filter((d): d is BacktestStrategyDefinition => Boolean(d))
            .map((d) => [d.id, { id: d.id, name: d.name, category: d.category }])
        ).values()
      ).slice(0, 10);
      if (validStrats.length > 0) {
        incomingAssignments.push({
          symbol: input.symbol,
          timeframe: input.timeframe,
          htfTimeframe: input.htfTimeframe ?? resolveDefaultHtfTimeframe(input.timeframe),
          strategies: validStrats,
          sourceRunId: input.sourceRunId,
          lastClosedBarTime: null,
        });
      }
    }

    let normalizedAssignments: LiveStrategyBasketSlot[] | undefined;
    if (mode === 'merge' && this.liveStrategyBasket) {
      const existingSlots: LiveStrategyBasketSlot[] =
        Array.isArray(this.liveStrategyBasket.assignments) &&
        this.liveStrategyBasket.assignments.length > 0
          ? this.liveStrategyBasket.assignments
          : this.liveStrategyBasket.strategies.length > 0
            ? [
                {
                  symbol: this.liveStrategyBasket.symbol,
                  timeframe: this.liveStrategyBasket.timeframe,
                  htfTimeframe: this.liveStrategyBasket.htfTimeframe,
                  strategies: this.liveStrategyBasket.strategies,
                  sourceRunId: this.liveStrategyBasket.sourceRunId,
                  lastClosedBarTime: this.liveStrategyBasket.lastClosedBarTime,
                },
              ]
            : [];

      const slotMap = new Map<string, LiveStrategyBasketSlot>();
      for (const slot of existingSlots) {
        slotMap.set(`${slot.symbol}__${slot.timeframe}`, {
          ...slot,
          strategies: [...slot.strategies],
        });
      }
      for (const slot of incomingAssignments) {
        const key = `${slot.symbol}__${slot.timeframe}`;
        const prev = slotMap.get(key);
        if (!prev) {
          slotMap.set(key, slot);
        } else {
          const mergedStrats = Array.from(
            new Map(
              [...prev.strategies, ...slot.strategies].map((s) => [s.id, s])
            ).values()
          ).slice(0, 10);
          slotMap.set(key, {
            ...prev,
            htfTimeframe: slot.htfTimeframe ?? prev.htfTimeframe,
            strategies: mergedStrats,
            poorRegimes: slot.poorRegimes ?? prev.poorRegimes,
            avoidSessions: slot.avoidSessions ?? prev.avoidSessions,
            oosWinRate: slot.oosWinRate ?? prev.oosWinRate,
            oosProfitFactor: slot.oosProfitFactor ?? prev.oosProfitFactor,
            oosExpectancyR: slot.oosExpectancyR ?? prev.oosExpectancyR,
            oosScore: slot.oosScore ?? prev.oosScore,
            sourceRunId: slot.sourceRunId ?? prev.sourceRunId,
            lastClosedBarTime: null,
          });
        }
      }
      normalizedAssignments = Array.from(slotMap.values()).slice(0, 12);
    } else if (incomingAssignments.length > 0) {
      normalizedAssignments = incomingAssignments.slice(0, 12);
    }

    const combinedIds =
      normalizedAssignments && normalizedAssignments.length > 0
        ? Array.from(
            new Set(normalizedAssignments.flatMap((slot) => slot.strategies.map((s) => s.id)))
          ).slice(0, 32)
        : Array.from(new Set(input.strategyIds)).slice(0, 32);

    const strategies: LiveStrategyBasketStrategyRef[] = combinedIds
      .map((id) => defMap.get(id))
      .filter((d): d is BacktestStrategyDefinition => Boolean(d))
      .map((d) => ({ id: d.id, name: d.name, category: d.category }));

    if (strategies.length === 0) {
      throw new Error('At least one valid strategy must be selected for Live Basket auto-run');
    }

    const primarySlot = normalizedAssignments?.[0];
    const primarySymbol = primarySlot?.symbol ?? input.symbol;
    const primaryTimeframe = primarySlot?.timeframe ?? input.timeframe;
    const htfTimeframe =
      primarySlot?.htfTimeframe ??
      input.htfTimeframe ??
      resolveDefaultHtfTimeframe(primaryTimeframe);

    const slotCount = normalizedAssignments?.length ?? 1;
    const enabled = input.enabled ?? true;
    const resolvedLabel =
      mode === 'merge' && slotCount > 1
        ? `${slotCount} Asset/TF Slots · ${strategies.length} Filtered Strategies`
        : input.selectionLabel ??
          (slotCount > 1
            ? `${slotCount} Asset/TF Slots · ${strategies.length} Strategies`
            : `${primarySymbol} ${primaryTimeframe} · ${strategies.length} Strateg${strategies.length === 1 ? 'y' : 'ies'}`);

    const basket: LiveStrategyBasketConfig = {
      enabled,
      symbol: primarySymbol,
      timeframe: primaryTimeframe,
      htfTimeframe,
      strategies,
      assignments: normalizedAssignments,
      filters: input.filters ?? (mode === 'merge' ? this.liveStrategyBasket?.filters : undefined),
      selectionLabel: resolvedLabel,
      maxConcurrentPositions: Math.max(
        1,
        Math.min(
          20,
          Math.round(
            input.maxConcurrentPositions ??
              (mode === 'merge'
                ? Math.max(this.liveStrategyBasket?.maxConcurrentPositions ?? 4, slotCount)
                : 4)
          )
        )
      ),
      minRiskReward: Math.max(1.0, Math.min(5.0, Number(input.minRiskReward ?? 1.5))),
      sourceRunId: input.sourceRunId,
      updatedAt: Date.now(),
      lastEvaluatedAt: null,
      lastClosedBarTime: null,
      emittedSignalCount:
        mode === 'merge' && this.liveStrategyBasket
          ? this.liveStrategyBasket.emittedSignalCount
          : this.liveStrategyBasket &&
              this.liveStrategyBasket.symbol === primarySymbol &&
              this.liveStrategyBasket.timeframe === primaryTimeframe
            ? this.liveStrategyBasket.emittedSignalCount
            : 0,
      lastStatusNote: enabled
        ? slotCount > 1
          ? `Armed ${strategies.length} strategies across ${slotCount} asset/timeframe slots (${resolvedLabel})`
          : `Armed ${strategies.length} strategies on ${primarySymbol} ${primaryTimeframe}`
        : `Paused ${strategies.length} strategies on ${primarySymbol} ${primaryTimeframe}`,
    };

    this.liveStrategyBasket = basket;
    this.backtestStore.saveLiveBasket(basket);
    this.sink?.onStrategyBasketUpdated?.(basket);

    if (basket.enabled) {
      const targetSymbols = Array.from(
        new Set(
          normalizedAssignments && normalizedAssignments.length > 0
            ? normalizedAssignments.map((s) => s.symbol)
            : [basket.symbol]
        )
      );
      for (const sym of targetSymbols) {
        void this.evaluateSignalsForSymbol(sym);
      }
    }

    return basket;
  }

  public removeLiveStrategyBasketItem(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    strategyId?: BacktestStrategyId
  ): LiveStrategyBasketConfig | null {
    const current = this.liveStrategyBasket;
    if (!current) return null;

    const currentSlots: LiveStrategyBasketSlot[] =
      Array.isArray(current.assignments) && current.assignments.length > 0
        ? current.assignments.map((s) => ({ ...s, strategies: [...s.strategies] }))
        : current.strategies.length > 0
          ? [
              {
                symbol: current.symbol,
                timeframe: current.timeframe,
                htfTimeframe: current.htfTimeframe,
                strategies: [...current.strategies],
                sourceRunId: current.sourceRunId,
                lastClosedBarTime: current.lastClosedBarTime,
              },
            ]
          : [];

    const nextSlots: LiveStrategyBasketSlot[] = [];
    for (const slot of currentSlots) {
      if (slot.symbol !== symbol || slot.timeframe !== timeframe) {
        nextSlots.push(slot);
        continue;
      }
      if (!strategyId) {
        continue;
      }
      const remaining = slot.strategies.filter((s) => s.id !== strategyId);
      if (remaining.length > 0) {
        nextSlots.push({ ...slot, strategies: remaining });
      }
    }

    if (nextSlots.length === 0) {
      this.clearLiveStrategyBasket();
      return null;
    }

    const allStrategies = Array.from(
      new Map(
        nextSlots.flatMap((slot) => slot.strategies).map((s) => [s.id, s])
      ).values()
    );
    const primary = nextSlots[0];
    const updated: LiveStrategyBasketConfig = {
      ...current,
      symbol: primary.symbol,
      timeframe: primary.timeframe,
      htfTimeframe: primary.htfTimeframe,
      strategies: allStrategies,
      assignments: nextSlots,
      selectionLabel:
        nextSlots.length > 1
          ? `${nextSlots.length} Asset/TF Slots · ${allStrategies.length} Strategies`
          : `${primary.symbol} ${primary.timeframe} · ${allStrategies.length} Strateg${allStrategies.length === 1 ? 'y' : 'ies'}`,
      updatedAt: Date.now(),
      lastStatusNote: `Updated armed basket: ${allStrategies.length} strategies across ${nextSlots.length} slot(s)`,
    };

    this.liveStrategyBasket = updated;
    this.backtestStore.saveLiveBasket(updated);
    this.sink?.onStrategyBasketUpdated?.(updated);
    return updated;
  }

  public async armBestFilteredStrategies(
    criteria: LiveStrategyFilterCriteria & { autoScanIfEmpty?: boolean } = {}
  ): Promise<{
    ok: boolean;
    basket: LiveStrategyBasketConfig | null;
    matchedCombos: number;
    message: string;
  }> {
    let discoveryRuns = this.backtestStore.getCachedDiscoveryRuns(10);
    let backtestRuns = this.backtestStore.getCachedBacktestRuns(25);

    if (
      discoveryRuns.length === 0 &&
      backtestRuns.length === 0 &&
      criteria.autoScanIfEmpty !== false
    ) {
      try {
        const quickConfig = buildDefaultDiscoveryConfig({
          symbols: criteria.symbols && criteria.symbols.length > 0 ? criteria.symbols : ['XAUUSD', 'BTCUSDT'],
          timeframes: criteria.timeframes && criteria.timeframes.length > 0 ? criteria.timeframes : ['15m', '1H'],
          barsPerTimeframe: 480,
          strategyScope: 'core',
          minOosTradesForValidation: 3,
          minTotalSampleForValidation: 8,
        });
        const quickRun = await runDiscoveryOptimizationScan({
          config: quickConfig,
          technicalSettings: this.settings,
          fetchHistory: async (symbol, timeframe, bars) => {
            const candles = await this.marketData.fetchRawHistory(symbol, timeframe, bars);
            const provider =
              this.marketData.getProviderStatus(symbol)?.providerName ?? 'Historical Feed';
            return { candles, provider };
          },
        });
        this.backtestStore.saveDiscoveryRun(quickRun);
        discoveryRuns = this.backtestStore.getCachedDiscoveryRuns(10);
      } catch {
        // Ignore auto-scan errors and report cleanly below
      }
    }

    const readinessMode: LiveStrategyReadinessFilter =
      criteria.readinessMode ?? 'INCLUDE_VERIFY_PAPER';
    const minWinRate = Math.max(0, criteria.minWinRate ?? 45);
    const minPf = Math.max(0.5, criteria.minProfitFactor ?? 1.15);
    const minExpR = criteria.minExpectancyR ?? 0.05;
    const minOosScore = criteria.minOosScore ?? 55;
    const maxPerSlot = Math.max(1, Math.min(5, criteria.maxStrategiesPerSlot ?? 3));
    const symFilter =
      criteria.symbols && criteria.symbols.length > 0 ? new Set(criteria.symbols) : null;
    const tfFilter =
      criteria.timeframes && criteria.timeframes.length > 0 ? new Set(criteria.timeframes) : null;
    const catFilter =
      criteria.categories && criteria.categories.length > 0 ? new Set(criteria.categories) : null;

    const targetRuns = criteria.runId
      ? discoveryRuns.filter((r) => r.id === criteria.runId)
      : discoveryRuns;

    interface CandidateSlotEntry {
      symbol: InstrumentSymbol;
      timeframe: Timeframe;
      htfTimeframe: Timeframe;
      strategy: LiveStrategyBasketStrategyRef;
      readinessRank: number;
      oosScore: number;
      expectancyR: number;
      winRate: number;
      profitFactor: number;
      poorRegimes: MarketRegimeType[];
      avoidSessions: TradingSessionName[];
      runId: string;
    }

    const collected: CandidateSlotEntry[] = [];
    const seenKey = new Set<string>();

    for (const run of targetRuns) {
      for (const combo of run.combinations) {
        if (symFilter && !symFilter.has(combo.symbol)) continue;
        if (tfFilter && !tfFilter.has(combo.timeframe)) continue;
        if (catFilter && !catFilter.has(combo.strategy.category)) continue;

        const audit = deriveProductionAudit(combo);

        const isProdReady = audit.readiness === 'Production Ready';
        const isVerifyPaper = audit.readiness === 'Verify Paper';
        if (readinessMode === 'PRODUCTION_READY_ONLY' && !isProdReady) continue;
        if (readinessMode === 'INCLUDE_VERIFY_PAPER' && !isProdReady && !isVerifyPaper) continue;
        if (
          readinessMode === 'VALIDATED_OR_PRELIM' &&
          !isProdReady &&
          !isVerifyPaper &&
          (combo.validationStatus === 'Insufficient Evidence' ||
            combo.validationStatus === 'Failed Validation' ||
            combo.oosMetrics.expectancyR <= 0 ||
            combo.oosScore < minOosScore)
        ) {
          continue;
        }

        const pf = combo.oosMetrics.profitFactor ?? 0;
        if (combo.oosMetrics.winRate < minWinRate) continue;
        if (pf > 0 && pf < minPf) continue;
        if (combo.oosMetrics.expectancyR < minExpR) continue;
        if (combo.oosScore < minOosScore) continue;

        const dedupeKey = `${combo.symbol}:${combo.timeframe}:${combo.strategy.id}`;
        if (seenKey.has(dedupeKey)) continue;
        seenKey.add(dedupeKey);

        collected.push({
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          htfTimeframe: combo.htfTimeframe,
          strategy: {
            id: combo.strategy.id,
            name: combo.strategy.name,
            category: combo.strategy.category,
          },
          readinessRank: isProdReady ? 3 : isVerifyPaper ? 2 : 1,
          oosScore: combo.oosScore,
          expectancyR: combo.oosMetrics.expectancyR,
          winRate: combo.oosMetrics.winRate,
          profitFactor: pf,
          poorRegimes: (combo.poorRegimes ?? []).map((p) => p.regime),
          avoidSessions: combo.avoidSessions ?? [],
          runId: run.id,
        });
      }
    }

    // Fallback to validated individual Backtest runs when Discovery yields nothing
    if (collected.length === 0) {
      for (const btRun of backtestRuns) {
        if (symFilter && !symFilter.has(btRun.config.symbol)) continue;
        if (tfFilter && !tfFilter.has(btRun.config.timeframe)) continue;
        for (const stratRes of btRun.strategies) {
          if (catFilter && !catFilter.has(stratRes.strategy.category)) continue;
          const m = stratRes.metrics;
          const pf = m.profitFactor ?? 0;
          if (
            m.totalTrades < 5 ||
            m.winRate < minWinRate ||
            m.expectancyR < minExpR ||
            pf < minPf
          ) {
            continue;
          }
          const dedupeKey = `${btRun.config.symbol}:${btRun.config.timeframe}:${stratRes.strategy.id}`;
          if (seenKey.has(dedupeKey)) continue;
          seenKey.add(dedupeKey);
          collected.push({
            symbol: btRun.config.symbol,
            timeframe: btRun.config.timeframe,
            htfTimeframe: btRun.config.htfTimeframe,
            strategy: {
              id: stratRes.strategy.id,
              name: stratRes.strategy.name,
              category: stratRes.strategy.category,
            },
            readinessRank: 1,
            oosScore: Math.round(Math.min(100, 50 + m.expectancyR * 25)),
            expectancyR: m.expectancyR,
            winRate: m.winRate,
            profitFactor: pf,
            poorRegimes: [],
            avoidSessions: [],
            runId: btRun.id,
          });
        }
      }
    }

    if (collected.length === 0) {
      return {
        ok: false,
        basket: null,
        matchedCombos: 0,
        message:
          'No validated Best or Filtered Strategies match these accuracy filters yet. Run Strategy Discovery or Backtest Engine first.',
      };
    }

    collected.sort(
      (a, b) =>
        b.readinessRank - a.readinessRank ||
        b.oosScore - a.oosScore ||
        b.expectancyR - a.expectancyR
    );

    const grouped = new Map<string, LiveStrategyBasketSlot>();
    for (const item of collected) {
      const slotKey = `${item.symbol}__${item.timeframe}`;
      const existing = grouped.get(slotKey);
      if (!existing) {
        grouped.set(slotKey, {
          symbol: item.symbol,
          timeframe: item.timeframe,
          htfTimeframe: item.htfTimeframe,
          strategies: [item.strategy],
          poorRegimes: item.poorRegimes,
          avoidSessions: item.avoidSessions,
          oosWinRate: Number(item.winRate.toFixed(1)),
          oosProfitFactor: Number(item.profitFactor.toFixed(2)),
          oosExpectancyR: Number(item.expectancyR.toFixed(2)),
          oosScore: Number(item.oosScore.toFixed(1)),
        });
      } else if (existing.strategies.length < maxPerSlot) {
        existing.strategies.push(item.strategy);
      }
    }

    // Keep top 4 slots, prioritizing best distinct instruments
    const sortedSlots = Array.from(grouped.values()).sort(
      (a, b) => (b.oosScore ?? 0) - (a.oosScore ?? 0)
    );
    const chosenSlots: LiveStrategyBasketSlot[] = [];
    const seenSymbols = new Set<InstrumentSymbol>();
    for (const sl of sortedSlots) {
      if (!seenSymbols.has(sl.symbol) && chosenSlots.length < 4) {
        chosenSlots.push(sl);
        seenSymbols.add(sl.symbol);
      }
    }
    for (const sl of sortedSlots) {
      if (chosenSlots.length >= 4) break;
      if (!chosenSlots.includes(sl)) {
        chosenSlots.push(sl);
      }
    }

    const totalStrats = chosenSlots.reduce((acc, s) => acc + s.strategies.length, 0);
    const prodReadyUsed = collected.some((c) => c.readinessRank === 3);
    const label = prodReadyUsed
      ? 'Production Ready + Best Filtered Strategies'
      : 'Filtered Validated Strategies';

    const sigSettings = this.signalEngine.getSettings();
    const basket = this.setLiveStrategyBasket({
      enabled: true,
      symbol: chosenSlots[0].symbol,
      timeframe: chosenSlots[0].timeframe,
      htfTimeframe: chosenSlots[0].htfTimeframe,
      strategyIds: Array.from(new Set(chosenSlots.flatMap((s) => s.strategies.map((st) => st.id)))),
      assignments: chosenSlots,
      filters: {
        ...criteria,
        avoidPoorRegimes: criteria.avoidPoorRegimes ?? true,
        avoidWeakSessions: criteria.avoidWeakSessions ?? false,
        requireHtfAlignment:
          criteria.requireHtfAlignment ?? sigSettings.requireHtfAlignmentForStrategy,
      },
      selectionLabel: label,
      maxConcurrentPositions: Math.min(4, Math.max(1, chosenSlots.length)),
      minRiskReward: Math.max(1.5, sigSettings.minTp1RiskReward),
      sourceRunId: collected[0]?.runId,
    });

    return {
      ok: true,
      basket,
      matchedCombos: collected.length,
      message: `Armed ${totalStrats} validated strategies across ${chosenSlots.length} asset/timeframe slot(s) (${label}).`,
    };
  }

  public clearLiveStrategyBasket(): void {
    this.liveStrategyBasket = null;
    this.backtestStore.clearLiveBasket();
    this.sink?.onStrategyBasketUpdated?.(null);
  }

  public async evaluateAllInstrumentSignals(): Promise<SignalEvaluationDiagnostic[]> {
    await Promise.allSettled(
      INSTRUMENTS.map((inst) => this.evaluateSignalsForSymbol(inst.symbol))
    );
    return this.signalEngine.getDiagnostics();
  }

  public async evaluateSignalsForSymbol(symbol: InstrumentSymbol): Promise<SignalEvaluationDiagnostic> {
    if (this.signalEvalInFlight.has(symbol)) {
      return (
        this.signalEngine.getDiagnostics().find((d) => d.symbol === symbol) ??
        this.signalEngine.getDiagnostics()[0]
      );
    }
    this.signalEvalInFlight.add(symbol);
    try {
      const sigSettings = this.signalEngine.getSettings();
      const tfs = sigSettings.timeframes;
      const requiredTfs: Timeframe[] = [
        tfs.majorDirectionTf,
        tfs.primaryBiasTf,
        tfs.secondaryConfirmTf,
        tfs.setupTf,
        tfs.entryTf,
      ];
      if (sigSettings.require1MRefinement) {
        requiredTfs.push(tfs.refinementTf);
      }

      // Ensure 1D and 4H first so HTF bias is populated on LTF snapshots
      await Promise.allSettled([
        this.getSnapshot(symbol, tfs.majorDirectionTf),
        this.getSnapshot(symbol, tfs.primaryBiasTf),
      ]);
      await Promise.allSettled(
        requiredTfs
          .filter((tf) => tf !== tfs.majorDirectionTf && tf !== tfs.primaryBiasTf)
          .map((tf) => this.getSnapshot(symbol, tf))
      );

      const pairs: Array<[Timeframe, AnalysisSnapshot | null]> = requiredTfs.map((tf) => [
        tf,
        this.snapshots.get(`${symbol}:${tf}`) ?? null,
      ]);
      const optional1m = this.snapshots.get(`${symbol}:${tfs.refinementTf}`);
      if (optional1m && !requiredTfs.includes(tfs.refinementTf)) {
        pairs.push([tfs.refinementTf, optional1m]);
      }
      const snapshotsRecord = buildSnapshotsRecord(pairs);
      const quote = this.marketData.getQuote(symbol);
      const providerStatus = this.marketData.getProviderStatus(symbol);
      const symbolSlots = this.getBasketSlotsForSymbol(symbol);

      if (!sigSettings.allowDefaultSignals) {
        // Keep open strategy signals' SL/TP lifecycle up-to-date on closed entry candles
        const entrySnap = snapshotsRecord[tfs.entryTf];
        const latestCandle = entrySnap?.candles[entrySnap.candles.length - 1] ?? null;
        if (latestCandle) {
          const priceUpdate = this.signalEngine.processCandleUpdate(
            symbol,
            latestCandle,
            quote,
            providerStatus
          );
          this.broadcastSignalUpdates(priceUpdate.updatedSignals, priceUpdate.notifications, false);
        }

        let basketNote: string | undefined;
        if (symbolSlots.length > 0) {
          basketNote = await this.evaluateLiveStrategyBasketForSymbol(symbol, pairs);
        }

        const hasAnyArmed = Boolean(
          this.liveStrategyBasket?.enabled &&
            ((this.liveStrategyBasket.assignments?.length ?? 0) > 0 ||
              this.liveStrategyBasket.strategies.length > 0)
        );
        const diag = this.signalEngine.recordStrategyOnlyDiagnostic(
          symbol,
          tfs.entryTf,
          snapshotsRecord,
          hasAnyArmed,
          basketNote ??
            (symbolSlots.length > 0
              ? this.liveStrategyBasket?.lastStatusNote
              : hasAnyArmed
                ? `Default signals disabled — active strategies armed on ${this.liveStrategyBasket?.symbol ?? 'other instruments'}`
                : 'Default generic signals disabled — click "Load Best Strategies" or arm Filtered Strategies to auto-trade')
        );
        this.sink?.onSignalDiagnostics?.(this.signalEngine.getDiagnostics());
        return diag;
      }

      const result = this.signalEngine.evaluate({
        symbol,
        snapshots: snapshotsRecord,
        quote,
        providerStatus,
        settings: sigSettings,
      });

      this.broadcastSignalUpdates(result.emittedSignals, result.notifications, true);

      if (symbolSlots.length > 0) {
        await this.evaluateLiveStrategyBasketForSymbol(symbol, pairs);
      }

      return result.diagnostic;
    } finally {
      this.signalEvalInFlight.delete(symbol);
    }
  }

  private async evaluateLiveStrategyBasketForSymbol(
    symbol: InstrumentSymbol,
    basePairs: Array<[Timeframe, AnalysisSnapshot | null]>
  ): Promise<string | undefined> {
    const basket = this.liveStrategyBasket;
    if (!basket || !basket.enabled) return undefined;

    const slots = this.getBasketSlotsForSymbol(symbol);
    if (slots.length === 0) return undefined;

    const sigSettings = this.signalEngine.getSettings();
    const quote = this.marketData.getQuote(symbol);
    const providerStatus = this.marketData.getProviderStatus(symbol);
    const assetClass = getInstrumentMeta(symbol).assetClass;
    let latestSlotNote: string | undefined;
    let basketModified = false;

    for (const slot of slots) {
      // Fast pre-check against cached candles before touching snapshot fetches
      const cachedCandles = this.marketData.getCachedCandles(symbol, slot.timeframe);
      if (cachedCandles.length >= 40) {
        let cachedClosedIdx = cachedCandles.length - 1;
        while (cachedClosedIdx >= 0 && !cachedCandles[cachedClosedIdx].isClosed) {
          cachedClosedIdx -= 1;
        }
        if (
          cachedClosedIdx >= 30 &&
          slot.lastClosedBarTime === cachedCandles[cachedClosedIdx].time &&
          this.snapshots.has(`${symbol}:${slot.timeframe}`)
        ) {
          continue;
        }
      }

      await Promise.allSettled([
        this.getSnapshot(symbol, slot.timeframe),
        this.getSnapshot(symbol, slot.htfTimeframe),
      ]);

      const execSnap = this.snapshots.get(`${symbol}:${slot.timeframe}`);
      const htfSnap = this.snapshots.get(`${symbol}:${slot.htfTimeframe}`) ?? null;
      if (!execSnap || execSnap.candles.length < 40) continue;

      let closedIdx = execSnap.candles.length - 1;
      while (closedIdx >= 0 && !execSnap.candles[closedIdx].isClosed) {
        closedIdx -= 1;
      }
      if (closedIdx < 30) continue;

      const closedBar = execSnap.candles[closedIdx];
      if (slot.lastClosedBarTime === closedBar.time) {
        continue;
      }
      basketModified = true;

      let closedExecSnap = execSnap;
      if (closedIdx < execSnap.candles.length - 1) {
        const sliceCandles = execSnap.candles.slice(Math.max(0, closedIdx - 160), closedIdx + 1);
        const dailyCandles = this.marketData.getCachedCandles(symbol, '1D');
        closedExecSnap = runDeterministicAnalysis({
          symbol,
          timeframe: slot.timeframe,
          candles: sliceCandles,
          dailyCandles,
          htfTrend: htfSnap?.marketStructure.trend ?? 'consolidation',
          quote,
          providerStatus: providerStatus ?? {
            symbol,
            assetClass,
            providerName: 'Live Feed',
            hasHistoricalCredentials: true,
            hasStreamingFeed: true,
            connectionStatus: 'CONNECTED',
            lastUpdateTime: Date.now(),
            feedDelaySeconds: 0,
          },
          settings: this.settings,
        });
      }

      // Live market condition & regime compatibility accuracy gate
      const nowMs = Date.now();
      const liveCond = analyzeLiveMarketCondition({
        snapshot: closedExecSnap,
        htfSnapshot: htfSnap,
        quote,
        nowMs,
      });

      const checkRegime =
        sigSettings.requireRegimeCompatibility && basket.filters?.avoidPoorRegimes !== false;
      const isPoorRegime =
        checkRegime &&
        Array.isArray(slot.poorRegimes) &&
        slot.poorRegimes.includes(liveCond.discoveryRegimeMapping);

      const checkSession = Boolean(basket.filters?.avoidWeakSessions);
      const isAvoidedSession =
        checkSession &&
        Array.isArray(slot.avoidSessions) &&
        slot.avoidSessions.some(
          (s) => s.startsWith(liveCond.session) || liveCond.session.startsWith(s.split(' (')[0])
        );

      basket.lastEvaluatedAt = nowMs;

      if (isPoorRegime) {
        slot.lastClosedBarTime = closedBar.time;
        latestSlotNote = `Filtered ${symbol} ${slot.timeframe}: live ${liveCond.discoveryRegimeMapping} regime is in strategy avoid-list`;
        basket.lastStatusNote = latestSlotNote;
        continue;
      }

      if (isAvoidedSession) {
        slot.lastClosedBarTime = closedBar.time;
        latestSlotNote = `Filtered ${symbol} ${slot.timeframe}: ${liveCond.sessionShort} session is weak for this strategy`;
        basket.lastStatusNote = latestSlotNote;
        continue;
      }

      const effectiveMinRR = Math.max(basket.minRiskReward, sigSettings.minTp1RiskReward);
      const btConfig = buildDefaultBacktestConfig({
        symbol,
        timeframe: slot.timeframe,
        htfTimeframe: slot.htfTimeframe,
        minRiskReward: effectiveMinRR,
      });

      const stratMap = new Map(slot.strategies.map((s) => [s.id, s]));
      const enabledSet = new Set<BacktestStrategyId>(slot.strategies.map((s) => s.id));
      const rawCandidates = evaluateStrategiesOnBar(
        enabledSet,
        closedExecSnap,
        htfSnap,
        closedBar,
        btConfig
      );

      const paired = rawCandidates
        .map((c) => {
          const s = stratMap.get(c.strategyId);
          return s ? { strategy: s, candidate: c } : null;
        })
        .filter(
          (
            x
          ): x is {
            strategy: LiveStrategyBasketStrategyRef;
            candidate: (typeof rawCandidates)[number];
          } => x !== null
        );

      const allPairs = [...basePairs];
      if (!allPairs.some(([tf]) => tf === slot.timeframe)) {
        allPairs.push([slot.timeframe, closedExecSnap]);
      }
      if (htfSnap && !allPairs.some(([tf]) => tf === slot.htfTimeframe)) {
        allPairs.push([slot.htfTimeframe, htfSnap]);
      }

      const evalRes = this.signalEngine.evaluateBasketCandidates({
        symbol,
        entryTimeframe: slot.timeframe,
        setupTimeframe: slot.htfTimeframe,
        closedCandleTime: closedBar.time,
        atrBuffer: closedExecSnap.atr * 0.45,
        snapshots: buildSnapshotsRecord(allPairs),
        quote,
        providerStatus,
        maxConcurrentPositions: basket.maxConcurrentPositions,
        minConfluenceScore: sigSettings.minStrategyConfluenceScore,
        minRiskReward: effectiveMinRR,
        requireHtfAlignment:
          sigSettings.requireHtfAlignmentForStrategy || Boolean(basket.filters?.requireHtfAlignment),
        marketRegime: `${liveCond.discoveryRegimeMapping} (${liveCond.direction})`,
        candidates: paired,
        nowMs,
      });

      if (evalRes.blockedReason) {
        latestSlotNote = `Paused (${evalRes.blockedReason})`;
        basket.lastStatusNote = latestSlotNote;
      } else {
        slot.lastClosedBarTime = closedBar.time;
        if (basket.symbol === symbol && basket.timeframe === slot.timeframe) {
          basket.lastClosedBarTime = closedBar.time;
        }
        basket.emittedSignalCount += evalRes.emittedSignals.length;
        const smcNote =
          evalRes.smcFilteredReasons && evalRes.smcFilteredReasons.length > 0
            ? ` · Blocked by SMC filter (${evalRes.smcFilteredReasons.length})`
            : '';
        latestSlotNote =
          evalRes.emittedSignals.length > 0
            ? `Emitted ${evalRes.emittedSignals.length} verified signal(s) on ${symbol} ${slot.timeframe} (${liveCond.discoveryRegimeMapping})`
            : `Scanned closed ${symbol} ${slot.timeframe} bar (${liveCond.discoveryRegimeMapping} · ${paired.length} candidate(s))${smcNote}`;
        basket.lastStatusNote = latestSlotNote;
      }

      this.broadcastSignalUpdates(evalRes.emittedSignals, evalRes.notifications, false);
    }

    if (basketModified) {
      this.backtestStore.saveLiveBasket(basket);
      this.sink?.onStrategyBasketUpdated?.(basket);
    }
    return latestSlotNote ?? basket.lastStatusNote;
  }

  private broadcastSignalUpdates(
    signals: TradingSignal[],
    notifications: SignalNotification[],
    includeDiagnostics: boolean
  ): void {
    const allowDefault = this.signalEngine.getSettings().allowDefaultSignals;
    const visibleSignals = allowDefault
      ? signals
      : signals.filter((s) => s.source === 'strategy_basket');
    const visibleIds = new Set(visibleSignals.map((s) => s.id));
    const visibleNotifs = allowDefault
      ? notifications
      : notifications.filter((n) => visibleIds.has(n.signalId));

    for (const sig of visibleSignals) {
      this.sink?.onSignalUpdated?.(sig);
    }
    for (const n of visibleNotifs) {
      this.sink?.onSignalNotification?.(n);
    }
    if (visibleSignals.length > 0 || visibleNotifs.length > 0) {
      this.sink?.onSignalPerformance?.(this.signalEngine.getPerformance());
    }
    if (includeDiagnostics) {
      this.sink?.onSignalDiagnostics?.(this.signalEngine.getDiagnostics());
    }

    if (this.riskEngine.getSettings().autoExecuteConfirmedSignals) {
      for (const sig of visibleSignals) {
        if (
          (sig.state === 'CONFIRMED' || sig.state === 'ACTIVE') &&
          !this.executionGateway.hasExecutedSignal(sig.id)
        ) {
          this.executeSignalPaper(sig.id);
        }
      }
    }

    const mt5ExecSettings = this.mt5TradeManager.getSettings();
    if (mt5ExecSettings.enabled && mt5ExecSettings.autoExecuteSignals && this.getMt5Status().connected) {
      for (const sig of visibleSignals) {
        const eligibleState =
          sig.state === 'CONFIRMED' ||
          sig.state === 'ACTIVE' ||
          (mt5ExecSettings.allowWatchingSignals && sig.state === 'WATCHING');
        if (eligibleState && !this.mt5TradeManager.hasActiveOrExecutedSignal(sig.id)) {
          this.executeSignalMt5(sig.id, true);
        }
      }
    }
  }

  public async getSnapshot(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    forceReload = false
  ): Promise<AnalysisSnapshot> {
    const key = `${symbol}:${timeframe}`;
    const existing = this.snapshots.get(key);
    if (existing && !forceReload && existing.candles.length > 0) {
      return existing;
    }

    const providerStatus = this.marketData.getProviderStatus(symbol)!;
    const quote = this.marketData.getQuote(symbol);

    try {
      await this.marketData.ensureHistory(symbol, timeframe, forceReload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Historical data unavailable';
      const emptySnap = runDeterministicAnalysis({
        symbol,
        timeframe,
        candles: [],
        dailyCandles: [],
        htfTrend: 'consolidation',
        quote,
        providerStatus: {
          ...providerStatus,
          errorMessage: msg,
        },
        settings: this.settings,
      });
      return emptySnap;
    }

    return this.recomputeSnapshot(symbol, timeframe);
  }

  private async recomputeSnapshot(
    symbol: InstrumentSymbol,
    timeframe: Timeframe
  ): Promise<AnalysisSnapshot> {
    const key = `${symbol}:${timeframe}`;
    const candles = this.marketData.getCachedCandles(symbol, timeframe);
    let dailyCandles = this.marketData.getCachedCandles(symbol, '1D');
    if (dailyCandles.length === 0 && timeframe !== '1D') {
      try {
        dailyCandles = await this.marketData.ensureHistory(symbol, '1D');
      } catch {
        dailyCandles = [];
      }
    }

    const h4Snap = this.snapshots.get(`${symbol}:4H`);
    const htfTrend = h4Snap?.marketStructure.trend ?? 'consolidation';
    const quote = this.marketData.getQuote(symbol);
    const providerStatus = this.marketData.getProviderStatus(symbol)!;

    const snapshot = runDeterministicAnalysis({
      symbol,
      timeframe,
      candles,
      dailyCandles,
      htfTrend,
      quote,
      providerStatus,
      settings: this.settings,
      dealingRangeLookback: this.dealingRangeLookbacks.get(key),
    });

    const livePrice = quote?.price ?? candles[candles.length - 1]?.close ?? 0;
    const monitored = this.zoneMonitor.evaluate(snapshot, livePrice, this.settings);
    snapshot.zoneInteractions = monitored.allZoneInteractions;

    const addedEvents = this.eventEngine.ingestSnapshotEvents(snapshot);
    const addedZoneEvents = this.eventEngine.pushEvents(monitored.newlyTriggeredEvents);
    snapshot.liveEvents = this.eventEngine.getEvents(symbol, 50);

    const htfAligned = htfTrend !== 'consolidation' && snapshot.marketStructure.trend === htfTrend;
    const alerts = this.alertEngine.isEnabled()
      ? this.alertEngine.evaluate(snapshot, monitored.newlyTriggeredEvents, htfAligned)
      : [];

    this.snapshots.set(key, snapshot);
    this.lastRecomputeAt.set(key, Date.now());

    if (!this.sink?.isStreamSubscribed || this.sink.isStreamSubscribed(symbol, timeframe)) {
      this.sink?.onSnapshot(snapshot);
    }
    if (addedEvents.length > 0 || addedZoneEvents.length > 0) {
      this.sink?.onEvents([...addedZoneEvents, ...addedEvents]);
    }
    for (const a of alerts) {
      this.platformStore.saveAlertNotification(a);
      this.sink?.onAlert(a);
    }

    return snapshot;
  }

  private evaluateLivePriceAgainstCachedSnapshots(quote: LiveQuote): void {
    const checkSubscribed = this.sink?.isStreamSubscribed;
    for (const tf of TIMEFRAMES) {
      const subscribed = checkSubscribed ? checkSubscribed(quote.symbol, tf) : false;
      if (!subscribed && !SIGNAL_WATCHED_TFS.has(tf)) continue;

      const key = `${quote.symbol}:${tf}`;
      const snap = this.snapshots.get(key);
      if (!snap || snap.candles.length === 0) continue;

      snap.quote = quote;
      const monitored = this.zoneMonitor.evaluate(snap, quote.price, this.settings);
      snap.zoneInteractions = monitored.allZoneInteractions;

      if (monitored.newlyTriggeredEvents.length > 0) {
        const pushed = this.eventEngine.pushEvents(monitored.newlyTriggeredEvents);
        snap.liveEvents = this.eventEngine.getEvents(quote.symbol, 50);
        if (pushed.length > 0) {
          this.sink?.onEvents(pushed);
        }
        if (this.alertEngine.isEnabled()) {
          const htfTrend =
            this.snapshots.get(`${quote.symbol}:4H`)?.marketStructure.trend ?? 'consolidation';
          const alerts = this.alertEngine.evaluate(
            snap,
            monitored.newlyTriggeredEvents,
            htfTrend !== 'consolidation' && snap.marketStructure.trend === htfTrend
          );
          for (const a of alerts) {
            this.platformStore.saveAlertNotification(a);
            this.sink?.onAlert(a);
          }
        }
      }

      if (!checkSubscribed || subscribed) {
        this.sink?.onZoneInteractions(quote.symbol, tf, monitored.allZoneInteractions);
      }
    }
  }

  public async getMultiTimeframeSummary(symbol: InstrumentSymbol): Promise<MultiTimeframeSummary> {
    const providerStatus = this.marketData.getProviderStatus(symbol);
    const map = new Map<Timeframe, AnalysisSnapshot | null>();

    if (providerStatus?.hasHistoricalCredentials) {
      // Load key timeframes concurrently for MTF matrix without hammering REST limits
      const priority: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'];
      await Promise.allSettled(
        priority.map(async (tf) => {
          const snap = await this.getSnapshot(symbol, tf);
          map.set(tf, snap);
        })
      );
      for (const tf of TIMEFRAMES) {
        if (!map.has(tf)) {
          const cached = this.snapshots.get(`${symbol}:${tf}`) ?? null;
          map.set(tf, cached);
        }
      }
    } else {
      for (const tf of TIMEFRAMES) {
        map.set(tf, null);
      }
    }

    return buildMultiTimeframeSummary(symbol, map);
  }

  public async getLiveMarketStrategyReport(
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    options?: {
      conditionFilter?: LiveConditionFilterMode;
      maxRecommendations?: number;
    }
  ): Promise<LiveMarketStrategyReport> {
    const snapshot = await this.getSnapshot(symbol, timeframe);
    const htfTimeframe = resolveDefaultHtfTimeframe(timeframe);
    const htfSnapshot =
      htfTimeframe === timeframe
        ? snapshot
        : await this.getSnapshot(symbol, htfTimeframe).catch(() => null);

    const cachedMap = new Map<Timeframe, AnalysisSnapshot | null>();
    for (const tf of TIMEFRAMES) {
      cachedMap.set(tf, this.snapshots.get(`${symbol}:${tf}`) ?? null);
    }
    if (!cachedMap.get(timeframe)) {
      cachedMap.set(timeframe, snapshot);
    }
    if (htfSnapshot && !cachedMap.get(htfTimeframe)) {
      cachedMap.set(htfTimeframe, htfSnapshot);
    }

    const mtfSummary = buildMultiTimeframeSummary(symbol, cachedMap);
    const quote = this.marketData.getQuote(symbol);
    const discoveryRuns = this.backtestStore.getCachedDiscoveryRuns(10);
    const backtestRuns = this.backtestStore.getCachedBacktestRuns(25);

    return buildLiveMarketStrategyReport({
      snapshot,
      htfSnapshot,
      mtfSummary,
      quote,
      discoveryRuns,
      backtestRuns,
      conditionFilter: options?.conditionFilter ?? 'all',
      maxRecommendations: options?.maxRecommendations ?? 50,
      nowMs: Date.now(),
    });
  }

  private processPaperPriceUpdate(
    symbol: InstrumentSymbol,
    priceInfo: {
      price: number;
      bid?: number;
      ask?: number;
      high?: number;
      low?: number;
    }
  ): void {
    const res = this.executionGateway.processPriceUpdate(symbol, priceInfo, Date.now());
    if (res.updatedPositions.length === 0) return;

    for (const pos of res.updatedPositions) {
      this.platformStore.upsertPaperPosition(pos);
      const synced = this.tradeJournal.syncPositionToJournal(pos);
      if (synced) {
        this.sink?.onJournalUpdated?.(synced);
      }
    }

    if (res.closedPositions.length > 0) {
      this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
      for (const closed of res.closedPositions) {
        this.platformStore.logAudit({
          id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          category: 'EXECUTION',
          action: 'PAPER_TRADE_CLOSED',
          actor: 'PaperExecutionEngine',
          details: `Closed paper ${closed.symbol} ${closed.direction} via ${closed.exitReason} @ ${closed.exitPrice} | Net ${closed.realizedPnlUsd >= 0 ? '+' : ''}$${closed.realizedPnlUsd} (${closed.realizedR}R)`,
          severity: 'info',
          timestamp: Date.now(),
        });
      }
    }

    const now = Date.now();
    if (res.closedPositions.length > 0 || now - this.lastPaperBroadcastAt >= 1000) {
      this.lastPaperBroadcastAt = now;
      this.broadcastPaperState();
    }
  }

  private broadcastPaperState(): void {
    this.sink?.onPaperUpdated?.({
      positions: this.getPaperPositions(),
      orders: this.getPaperOrders(),
      riskSnapshot: this.getRiskSnapshot(),
    });
  }

  public executeSignalPaper(signalId: string): {
    success: boolean;
    order?: PaperOrder;
    position?: PaperPosition | null;
    journalEntry?: TradeJournalEntry;
    rejectionReason?: string;
  } {
    const signal = this.signalEngine.getSignalById(signalId);
    if (!signal) {
      return { success: false, rejectionReason: 'Signal not found' };
    }
    if (!this.signalEngine.getSettings().allowDefaultSignals && signal.source !== 'strategy_basket') {
      return {
        success: false,
        rejectionReason:
          'Default generic signals are disabled. Only Best & Filtered Strategy signals are permitted for execution.',
      };
    }
    if (signal.state === 'WATCHING') {
      return { success: false, rejectionReason: 'WATCHING signal is not confirmed/executable yet' };
    }

    const candles = this.marketData.getCachedCandles(signal.symbol, signal.entryTimeframe);
    const quote = this.marketData.getQuote(signal.symbol);
    const provider = this.marketData.getProviderStatus(signal.symbol);
    const integrity = evaluateMarketDataIntegrity(
      signal.symbol,
      signal.entryTimeframe,
      candles,
      quote,
      provider,
      this.signalEngine.getSettings(),
      Date.now()
    );

    if (integrity.blocked) {
      const reasons = integrity.anomalies
        .filter((a) => a.severity === 'critical')
        .map((a) => a.message)
        .join('; ');
      this.platformStore.logAudit({
        id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
        category: 'INTEGRITY',
        action: 'PAPER_TRADE_BLOCKED_INTEGRITY',
        actor: 'DataIntegrityGuard',
        details: `Blocked paper execution for ${signal.symbol}: ${reasons}`,
        severity: 'warning',
        timestamp: Date.now(),
      });
      return { success: false, rejectionReason: `Market data integrity blocked execution: ${reasons}` };
    }

    const isBuy = signal.direction === 'BUY';
    const lastCandleClose = candles.length > 0 ? candles[candles.length - 1].close : undefined;
    const currentPrice =
      (isBuy ? quote?.ask : quote?.bid) ??
      quote?.price ??
      lastCandleClose ??
      signal.entryPrice;

    const res = this.executionGateway.executeSignal(signal, currentPrice, 'PAPER');
    if (!res.success || !res.position || !res.order) {
      return { success: false, rejectionReason: res.rejectionReason ?? 'Execution rejected' };
    }

    this.platformStore.upsertPaperOrder(res.order);
    this.platformStore.upsertPaperPosition(res.position);
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());

    const journalEntry = this.tradeJournal.createEntryFromPosition(signal, res.position);
    this.sink?.onJournalUpdated?.(journalEntry);
    this.broadcastPaperState();

    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'EXECUTION',
      action: 'PAPER_TRADE_EXECUTED',
      actor: 'TerminalTrader',
      details: `Executed paper trade for signal ${signal.id} (${signal.symbol} ${signal.direction} @ ${res.position.entryPrice})`,
      severity: 'info',
      timestamp: Date.now(),
    });

    return {
      success: true,
      order: res.order,
      position: res.position,
      journalEntry,
    };
  }

  public closePaperPosition(positionId: string): {
    success: boolean;
    position?: PaperPosition;
    journalEntry?: TradeJournalEntry | null;
    error?: string;
  } {
    const pos = this.executionGateway.getAllPositions().find((p) => p.id === positionId);
    if (!pos) {
      return { success: false, error: 'Paper position not found' };
    }
    if (pos.status !== 'OPEN' && pos.status !== 'PARTIAL') {
      return { success: false, error: `Position is already ${pos.status}` };
    }

    const quote = this.marketData.getQuote(pos.symbol);
    const candles = this.marketData.getCachedCandles(pos.symbol, pos.timeframe);
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : pos.currentPrice;
    const isBuy = pos.direction === 'BUY';
    const exitPrice =
      (isBuy ? quote?.bid : quote?.ask) ?? quote?.price ?? lastClose ?? pos.currentPrice;

    const closed = this.executionGateway.closePositionManually(positionId, exitPrice, Date.now());
    if (!closed) {
      return { success: false, error: 'Unable to close paper position' };
    }

    this.platformStore.upsertPaperPosition(closed);
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
    const journalEntry = this.tradeJournal.syncPositionToJournal(closed);
    if (journalEntry) {
      this.sink?.onJournalUpdated?.(journalEntry);
    }
    this.broadcastPaperState();

    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'EXECUTION',
      action: 'PAPER_TRADE_MANUAL_CLOSE',
      actor: 'TerminalOperator',
      details: `Manually closed ${closed.symbol} ${closed.direction} @ ${closed.exitPrice} (${closed.realizedPnlUsd >= 0 ? '+' : ''}$${closed.realizedPnlUsd})`,
      severity: 'info',
      timestamp: Date.now(),
    });

    return { success: true, position: closed, journalEntry };
  }

  public resetPaperAccount(startingEquity?: number): {
    positions: PaperPosition[];
    orders: PaperOrder[];
    riskSnapshot: RiskAccountSnapshot;
  } {
    this.executionGateway.clearPaperState();
    this.platformStore.clearPaperOrdersAndPositions();
    this.riskEngine.resetAccount(startingEquity);
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
    this.broadcastPaperState();

    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'RISK',
      action: 'PAPER_ACCOUNT_RESET',
      actor: 'TerminalOperator',
      details: `Paper trading account reset to $${this.riskEngine.getCurrentEquity()}`,
      severity: 'warning',
      timestamp: Date.now(),
    });

    return {
      positions: [],
      orders: [],
      riskSnapshot: this.getRiskSnapshot(),
    };
  }

  public updateRiskSettings(next: Partial<RiskSettings>): RiskAccountSnapshot {
    this.riskEngine.updateSettings(next);
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
    this.broadcastPaperState();
    return this.getRiskSnapshot();
  }

  public getPaperPositions(): PaperPosition[] {
    return this.executionGateway.getAllPositions();
  }

  public getPaperOrders(): PaperOrder[] {
    return this.executionGateway.getOrders();
  }

  public engageKillSwitch(reason: string) {
    this.riskEngine.engageKillSwitch(reason);
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
    this.broadcastPaperState();
    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'RISK',
      action: 'KILL_SWITCH_ENGAGED',
      actor: 'TerminalOperator',
      details: reason,
      severity: 'critical',
      timestamp: Date.now(),
    });
    return this.getRiskSnapshot();
  }

  public disengageKillSwitch() {
    this.riskEngine.disengageKillSwitch();
    this.platformStore.saveRiskEngineState(this.riskEngine.exportState());
    this.broadcastPaperState();
    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'RISK',
      action: 'KILL_SWITCH_DISENGAGED',
      actor: 'TerminalOperator',
      details: 'Kill switch manually released',
      severity: 'warning',
      timestamp: Date.now(),
    });
    return this.getRiskSnapshot();
  }

  public getJournalEntries() {
    return this.tradeJournal.getAllEntries();
  }

  public updateJournalEntry(
    id: string,
    updates: { reflectionNotes?: string; lessonsLearned?: string; tags?: string[]; rating?: number | null }
  ) {
    return this.tradeJournal.updateEntry(id, updates);
  }

  public deleteJournalEntry(id: string) {
    return this.tradeJournal.deleteEntry(id);
  }

  public clearJournalEntries() {
    return this.tradeJournal.deleteAllEntries();
  }

  public getRiskSnapshot(): RiskAccountSnapshot {
    const openPositions = this.executionGateway.getOpenPositions();
    const totalRiskUsd = openPositions.reduce((acc, p) => acc + p.riskAmountUsd, 0);
    const equity = this.riskEngine.getCurrentEquity();
    const totalRiskPct = equity > 0 ? (totalRiskUsd / equity) * 100 : 0;
    return this.riskEngine.getAccountSnapshot(openPositions.length, totalRiskPct);
  }

  // ==========================================================================
  // MetaTrader 5 Bridge State & Ingestion
  // ==========================================================================

  private normalizeMt5Symbol(raw: string): InstrumentSymbol | null {
    const clean = raw.trim().toUpperCase();
    for (const [sym, spec] of Object.entries(INSTRUMENT_CONTRACT_SPECS) as Array<
      [InstrumentSymbol, typeof INSTRUMENT_CONTRACT_SPECS[InstrumentSymbol]]
    >) {
      if (clean === sym || spec.defaultBrokerAliases.some((a) => a.toUpperCase() === clean)) {
        return sym;
      }
      if (clean.startsWith(sym)) return sym;
    }
    if (clean.includes('XAU') || clean.includes('GOLD')) return 'XAUUSD';
    if (clean.includes('XAG') || clean.includes('SILVER')) return 'XAGUSD';
    if (clean.includes('BTC')) return 'BTCUSDT';
    if (clean.includes('ETH')) return 'ETHUSDT';
    return null;
  }

  public handleMt5Ingest(payload: Record<string, unknown>): MT5BridgeStatus {
    const now = Date.now();
    const type = typeof payload.type === 'string' ? payload.type : 'heartbeat';

    this.mt5Status.lastHeartbeat = now;
    this.mt5Status.connected = true;
    this.mt5Status.statusLabel = 'CONNECTED';
    this.mt5Status.messagesReceived += 1;
    this.mt5Status.paperMode = true;
    this.mt5Status.requiresApiToken = Boolean(process.env.TERMINAL_API_TOKEN);
    this.mt5Status.lastError = null;

    if (typeof payload.terminalVersion === 'string' && payload.terminalVersion.trim()) {
      this.mt5Status.terminalVersion = payload.terminalVersion.trim();
    }
    if (typeof payload.login === 'number' && Number.isFinite(payload.login) && payload.login > 0) {
      this.mt5Status.accountNumber = payload.login;
    }
    if (typeof payload.company === 'string' && payload.company.trim()) {
      this.mt5Status.broker = payload.company.trim();
    } else if (typeof payload.broker === 'string' && payload.broker.trim()) {
      this.mt5Status.broker = payload.broker.trim();
    }
    if (typeof payload.server === 'string' && payload.server.trim()) {
      this.mt5Status.server = payload.server.trim();
    }
    if (typeof payload.tradeMode === 'string') {
      const tm = payload.tradeMode.trim().toUpperCase();
      if (tm === 'DEMO' || tm === 'CONTEST' || tm === 'REAL') {
        this.mt5Status.tradeMode = tm as MT5AccountTradeMode;
      } else {
        this.mt5Status.tradeMode = 'UNKNOWN';
      }
    }
    if (typeof payload.currency === 'string' && payload.currency.trim()) {
      this.mt5Status.currency = payload.currency.trim();
    }
    if (typeof payload.leverage === 'number' && Number.isFinite(payload.leverage)) {
      this.mt5Status.leverage = payload.leverage;
    }
    if (typeof payload.balance === 'number' && Number.isFinite(payload.balance)) {
      this.mt5Status.balance = payload.balance;
    }
    if (typeof payload.equity === 'number' && Number.isFinite(payload.equity)) {
      this.mt5Status.equity = payload.equity;
    }
    if (typeof payload.margin === 'number' && Number.isFinite(payload.margin)) {
      this.mt5Status.margin = payload.margin;
    }
    if (typeof payload.freeMargin === 'number' && Number.isFinite(payload.freeMargin)) {
      this.mt5Status.freeMargin = payload.freeMargin;
    }

    if (type === 'tick' && typeof payload.symbol === 'string') {
      const bid = Number(payload.bid ?? 0);
      const ask = Number(payload.ask ?? 0);
      const last = Number(payload.last ?? (bid && ask ? (bid + ask) / 2 : bid || ask));
      const tickTime = Number(payload.time ?? now);
      // Guard against broker server timezone offsets in tick.time_msc
      const diffMs = Math.abs(now - tickTime);
      if (diffMs < 60_000) {
        this.mt5Status.latencyMs = Math.max(0, now - tickTime);
      }
      this.mt5Status.lastTickAt = now;

      const normalizedSymbol = this.normalizeMt5Symbol(payload.symbol);
      const quoteEntry: MT5SymbolQuote = {
        rawSymbol: payload.symbol,
        normalizedSymbol,
        bid,
        ask,
        last,
        time: tickTime,
        receivedAt: now,
      };
      this.mt5TicksMap.set(payload.symbol, quoteEntry);
      this.mt5Status.syncedTicks = Array.from(this.mt5TicksMap.values());

      if (normalizedSymbol) {
        this.evaluateMt5TradeManagement(normalizedSymbol, { price: last, bid, ask });
      }
    }

    if (type === 'positions' && Array.isArray(payload.positions)) {
      const parsed: MT5OpenPosition[] = [];
      for (const p of payload.positions) {
        if (!p || typeof p !== 'object') continue;
        const row = p as Record<string, unknown>;
        parsed.push({
          ticket: String(row.ticket ?? ''),
          symbol: String(row.symbol ?? ''),
          type: row.type === 'SELL' ? 'SELL' : 'BUY',
          volume: Number(row.volume ?? 0),
          openPrice: Number(row.openPrice ?? 0),
          currentPrice: Number(row.currentPrice ?? 0),
          sl: Number(row.sl ?? 0),
          tp: Number(row.tp ?? 0),
          profit: Number(row.profit ?? 0),
          magic: typeof row.magic === 'number' ? row.magic : undefined,
          comment: typeof row.comment === 'string' ? row.comment : undefined,
        });
      }
      this.mt5Status.openPositions = parsed;
      const reconciled = this.mt5TradeManager.reconcileBrokerPositions(parsed, now);
      if (reconciled.length > 0) {
        for (const t of reconciled) {
          this.platformStore.upsertMt5ManagedTrade(t);
        }
        this.broadcastMt5Execution();
      }
    }

    if (type === 'command_ack' && typeof payload.commandId === 'string') {
      const ackRes = this.mt5TradeManager.processCommandAck(
        {
          commandId: payload.commandId,
          success: Boolean(payload.success),
          ticket: payload.ticket !== undefined ? String(payload.ticket) : undefined,
          executedPrice:
            typeof payload.executedPrice === 'number' ? payload.executedPrice : undefined,
          executedVolume:
            typeof payload.executedVolume === 'number' ? payload.executedVolume : undefined,
          retcode: typeof payload.retcode === 'number' ? payload.retcode : undefined,
          errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined,
        },
        now
      );
      if (ackRes.command) {
        this.platformStore.upsertMt5TradeCommand(ackRes.command);
      }
      if (ackRes.trade) {
        this.platformStore.upsertMt5ManagedTrade(ackRes.trade);
      }
      this.platformStore.logAudit({
        id: `audit:${now}:${Math.random().toString(36).slice(2, 6)}`,
        category: 'MT5_EXECUTION',
        action: ackRes.command?.status === 'EXECUTED' ? 'MT5_CMD_EXECUTED' : 'MT5_CMD_FAILED',
        actor: 'MT5BridgeEA',
        details: `${ackRes.command?.type ?? 'CMD'} ${ackRes.command?.brokerSymbol ?? ''}: ${ackRes.command?.status ?? 'ACK'} ${ackRes.command?.errorMessage ?? ''}`.trim(),
        severity: ackRes.command?.status === 'FAILED' ? 'warning' : 'info',
        timestamp: now,
      });
      this.broadcastMt5Execution();
    }

    const snapshot = this.getMt5Status();
    if (type !== 'tick' || now - this.lastMt5BroadcastAt >= 1000) {
      this.lastMt5BroadcastAt = now;
      this.platformStore.saveMt5BridgeSnapshot(snapshot);
      this.sink?.onMt5StatusUpdated?.(snapshot);
    }

    return snapshot;
  }

  public collectPendingMt5Commands(): MT5TradeCommand[] {
    const res = this.mt5TradeManager.collectPendingCommands(Date.now());
    for (const cmd of res.commandsToSend) {
      this.platformStore.upsertMt5TradeCommand(cmd);
    }
    for (const cmd of res.expiredCommands) {
      this.platformStore.upsertMt5TradeCommand(cmd);
    }
    for (const tr of res.updatedTrades) {
      this.platformStore.upsertMt5ManagedTrade(tr);
    }
    if (
      res.commandsToSend.length > 0 ||
      res.expiredCommands.length > 0 ||
      res.updatedTrades.length > 0
    ) {
      this.broadcastMt5Execution();
    }
    return res.commandsToSend;
  }

  private evaluateMt5TradeManagement(
    symbol: InstrumentSymbol,
    priceInfo: { price: number; bid?: number; ask?: number }
  ): void {
    const snap =
      this.snapshots.get(`${symbol}:15m`) ??
      this.snapshots.get(`${symbol}:5m`) ??
      this.snapshots.get(`${symbol}:1H`);
    const atr = snap?.atr ?? 0;
    const res = this.mt5TradeManager.evaluatePriceUpdate(symbol, priceInfo, atr, Date.now());
    if (res.updatedTrades.length === 0 && res.createdCommands.length === 0) return;

    for (const tr of res.updatedTrades) {
      this.platformStore.upsertMt5ManagedTrade(tr);
    }
    for (const cmd of res.createdCommands) {
      this.platformStore.upsertMt5TradeCommand(cmd);
      this.platformStore.logAudit({
        id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
        category: 'MT5_MANAGEMENT',
        action: `MT5_${cmd.type}`,
        actor: 'MT5TradeManager',
        details: `${cmd.symbol} (#${cmd.mt5Ticket ?? ''}): ${cmd.reason}`,
        severity: 'info',
        timestamp: Date.now(),
      });
    }
    this.broadcastMt5Execution();
  }

  private broadcastMt5Execution(): void {
    this.sink?.onMt5ExecutionUpdated?.(this.getMt5ExecutionOverview());
  }

  public getMt5ExecutionOverview(): MT5ExecutionOverview {
    return {
      settings: this.mt5TradeManager.getSettings(),
      managedTrades: this.mt5TradeManager.getManagedTrades(),
      commands: this.mt5TradeManager.getCommands(100),
      mt5Status: this.getMt5Status(),
    };
  }

  public updateMt5ExecutionSettings(patch: Partial<MT5ExecutionSettings>): MT5ExecutionSettings {
    const updated = this.mt5TradeManager.updateSettings(patch);
    this.platformStore.saveMt5ExecutionSettings(updated);
    this.broadcastMt5Execution();
    return updated;
  }

  public executeSignalMt5(
    signalId: string,
    isAuto = false
  ): {
    success: boolean;
    trade?: MT5ManagedTrade;
    command?: MT5TradeCommand;
    rejectionReason?: string;
  } {
    const signal = this.signalEngine.getSignalById(signalId);
    if (!signal) {
      return { success: false, rejectionReason: 'Signal not found' };
    }
    if (!this.signalEngine.getSettings().allowDefaultSignals && signal.source !== 'strategy_basket') {
      return {
        success: false,
        rejectionReason:
          'Default generic signals are disabled. Only Best & Filtered Strategy signals can trade on MT5.',
      };
    }

    const mt5Status = this.getMt5Status();
    const mt5Quote = mt5Status.syncedTicks.find((t) => t.normalizedSymbol === signal.symbol);
    const providerQuote = this.marketData.getQuote(signal.symbol);
    const candles = this.marketData.getCachedCandles(signal.symbol, signal.entryTimeframe);
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : undefined;
    const isBuy = signal.direction === 'BUY';

    const currentPrice =
      (isBuy ? mt5Quote?.ask ?? providerQuote?.ask : mt5Quote?.bid ?? providerQuote?.bid) ??
      mt5Quote?.last ??
      providerQuote?.price ??
      lastClose ??
      signal.entryPrice;

    const res = this.mt5TradeManager.dispatchSignalTrade({
      signal,
      mt5Status,
      currentPrice,
      isAuto,
      now: Date.now(),
    });

    if (!res.success || !res.trade || !res.command) {
      return { success: false, rejectionReason: res.rejectionReason ?? 'MT5 execution rejected' };
    }

    this.platformStore.upsertMt5ManagedTrade(res.trade);
    this.platformStore.upsertMt5TradeCommand(res.command);
    this.platformStore.logAudit({
      id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      category: 'MT5_EXECUTION',
      action: isAuto ? 'MT5_SIGNAL_AUTO_QUEUED' : 'MT5_SIGNAL_MANUAL_QUEUED',
      actor: isAuto ? 'MT5AutoTrader' : 'TerminalOperator',
      details: `Queued ${res.command.side} ${res.command.brokerSymbol} (${res.command.volume} lot) for signal ${signal.id}`,
      severity: 'info',
      timestamp: Date.now(),
    });
    this.broadcastMt5Execution();
    return res;
  }

  public moveMt5TradeToBreakeven(tradeId: string) {
    const res = this.mt5TradeManager.moveTradeToBreakevenManual(tradeId, Date.now());
    if (res.success) {
      if (res.trade) this.platformStore.upsertMt5ManagedTrade(res.trade);
      if (res.command) this.platformStore.upsertMt5TradeCommand(res.command);
      this.broadcastMt5Execution();
    }
    return res;
  }

  public trailMt5TradeToTp1(tradeId: string) {
    const res = this.mt5TradeManager.trailTradeToTp1Manual(tradeId, Date.now());
    if (res.success) {
      if (res.trade) this.platformStore.upsertMt5ManagedTrade(res.trade);
      if (res.command) this.platformStore.upsertMt5TradeCommand(res.command);
      this.broadcastMt5Execution();
    }
    return res;
  }

  public closeMt5Trade(tradeId: string) {
    const res = this.mt5TradeManager.closeTradeManual(tradeId, Date.now());
    if (res.success) {
      if (res.trade) this.platformStore.upsertMt5ManagedTrade(res.trade);
      if (res.command) this.platformStore.upsertMt5TradeCommand(res.command);
      this.broadcastMt5Execution();
    }
    return res;
  }

  public closeAllMt5Trades() {
    const res = this.mt5TradeManager.closeAllTrades(Date.now());
    for (const tr of res.closedTrades) this.platformStore.upsertMt5ManagedTrade(tr);
    for (const cmd of res.createdCommands) this.platformStore.upsertMt5TradeCommand(cmd);
    this.broadcastMt5Execution();
    return res;
  }

  public cancelMt5Command(commandId: string) {
    const cmd = this.mt5TradeManager.cancelPendingCommand(commandId, Date.now());
    if (cmd) {
      this.platformStore.upsertMt5TradeCommand(cmd);
      if (cmd.managedTradeId) {
        const trade = this.mt5TradeManager
          .getManagedTrades()
          .find((t) => t.id === cmd.managedTradeId);
        if (trade) this.platformStore.upsertMt5ManagedTrade(trade);
      }
      this.broadcastMt5Execution();
    }
    return cmd;
  }

  public getMt5Status(): MT5BridgeStatus {
    const now = Date.now();
    const ageMs = this.mt5Status.lastHeartbeat > 0 ? now - this.mt5Status.lastHeartbeat : Infinity;
    const connected = ageMs <= 20_000;
    const statusLabel: MT5BridgeStatus['statusLabel'] = connected
      ? 'CONNECTED'
      : this.mt5Status.lastHeartbeat > 0
        ? 'STALE'
        : 'DISCONNECTED';

    return {
      ...this.mt5Status,
      connected,
      statusLabel,
      paperMode: true,
      requiresApiToken: Boolean(process.env.TERMINAL_API_TOKEN),
      openPositions: [...this.mt5Status.openPositions],
      syncedTicks: [...this.mt5Status.syncedTicks],
    };
  }

  public getOverview() {
    return {
      instruments: INSTRUMENTS,
      quotes: this.marketData.getAllQuotes(),
      providers: this.marketData.getAllProviderStatuses(),
      settings: this.settings,
      alertsEnabled: this.alertEngine.isEnabled(),
      alertRules: this.alertEngine.getRules(),
      alertHistory: this.alertEngine.getHistory(),
      events: this.eventEngine.getEvents(undefined, 60),
      signals: this.getSignals(),
      signalDiagnostics: this.signalEngine.getDiagnostics(),
      signalPerformance: this.signalEngine.getPerformance(),
      signalSettings: this.signalEngine.getSettings(),
      signalNotifications: this.signalEngine.getNotifications(),
      liveStrategyBasket: this.liveStrategyBasket,
      journalEntries: this.getJournalEntries(),
      paperPositions: this.getPaperPositions(),
      paperOrders: this.getPaperOrders(),
      riskSnapshot: this.getRiskSnapshot(),
      mt5Status: this.getMt5Status(),
      mt5Execution: this.getMt5ExecutionOverview(),
    };
  }
}

