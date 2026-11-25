import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_ALERT_RULES,
  DEFAULT_CHART_VISIBILITY,
  DEFAULT_MT5_EXECUTION_SETTINGS,
  DEFAULT_SIGNAL_SETTINGS,
  DEFAULT_TECHNICAL_SETTINGS,
  SMC_VISIBILITY_KEYS,
} from '../../shared/constants/index.ts';
import type {
  AlertNotification,
  AlertRule,
  AnalysisSnapshot,
  BacktestStrategyId,
  Candle,
  ChartVisibilityConfig,
  DiscoveryScanProgress,
  InstrumentSymbol,
  LiveQuote,
  LiveStrategyBasketConfig,
  LiveStrategyBasketSlot,
  LiveStrategyFilterCriteria,
  MT5BridgeStatus,
  MT5ExecutionOverview,
  MT5ExecutionSettings,
  MT5ManagedTrade,
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
  TechnicalCategory,
  TechnicalSettings,
  Timeframe,
  TradeJournalEntry,
  TradingSignal,
  ZoneInteractionEvent,
} from '../../shared/types/index.ts';
import { useAlertAudio } from '../hooks/use-alert-audio.ts';
import { apiFetch } from './api-client.ts';
import { useAuth } from './auth-context.tsx';

export type ChartType = 'candlestick' | 'bar' | 'line';

export interface FocusRequest {
  id: string;
  startTime: number;
  endTime: number;
  nonce: number;
}

export interface InspectableObject {
  id: string;
  category: TechnicalCategory;
  title: string;
  subtitle: string;
  data: Record<string, unknown>;
}

interface TerminalContextValue {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  chartType: ChartType;
  timezone: string;
  visibility: ChartVisibilityConfig;
  quotes: Record<InstrumentSymbol, LiveQuote | undefined>;
  providers: Record<InstrumentSymbol, ProviderStatus | undefined>;
  snapshot: AnalysisSnapshot | null;
  loadingSnapshot: boolean;
  mtfSummary: MultiTimeframeSummary | null;
  loadingMtf: boolean;
  events: ZoneInteractionEvent[];
  alerts: AlertNotification[];
  alertRules: AlertRule[];
  alertsEnabled: boolean;
  settings: TechnicalSettings;
  soundEnabled: boolean;
  browserAlertsEnabled: boolean;
  hoveredObjectId: string | null;
  selectedObjectId: string | null;
  focusRequest: FocusRequest | null;
  socketConnected: boolean;
  selectSymbol: (sym: InstrumentSymbol) => void;
  selectTimeframe: (tf: Timeframe) => void;
  setChartType: (t: ChartType) => void;
  setTimezone: (tz: string) => void;
  toggleVisibility: (key: keyof ChartVisibilityConfig) => void;
  setLayerVisibility: (partial: Partial<ChartVisibilityConfig>) => void;
  toggleSmcOverlays: () => void;
  setAllVisibility: (visible: boolean) => void;
  setHoveredObjectId: (id: string | null) => void;
  setSelectedObjectId: (id: string | null) => void;
  focusChartObject: (id: string, startTime: number, endTime: number) => void;
  refreshSnapshot: () => Promise<void>;
  refreshMtf: () => Promise<void>;
  updateSettings: (partial: Partial<TechnicalSettings>) => Promise<void>;
  refreshAlerts: () => Promise<void>;
  setAlertsEnabled: (enabled: boolean) => Promise<void>;
  updateAlertRules: (rules: AlertRule[]) => Promise<{ ok: boolean; error?: string }>;
  resetAlertRules: () => Promise<void>;
  clearAlertHistory: () => Promise<void>;
  triggerTestAlert: (ruleId?: string) => Promise<{ ok: boolean; error?: string }>;
  setSoundEnabled: (v: boolean) => void;
  setBrowserAlertsEnabled: (v: boolean) => void;
  setDealingRangeLookback: (lookback?: number) => Promise<void>;
  signals: TradingSignal[];
  signalDiagnostics: SignalEvaluationDiagnostic[];
  signalPerformance: SignalPerformanceStats | null;
  signalSettings: SignalSettings;
  signalNotifications: SignalNotification[];
  evaluatingSignals: boolean;
  evaluateSignals: (sym?: InstrumentSymbol) => Promise<void>;
  refreshSignals: () => Promise<void>;
  cancelSignal: (signalId: string) => Promise<void>;
  deleteSignal: (signalId: string) => Promise<void>;
  deleteSignalsBulk: (signalIds: string[]) => Promise<void>;
  clearSignals: (scope: SignalDeleteScope) => Promise<void>;
  updateSignalSettings: (partial: Partial<SignalSettings>) => Promise<void>;
  liveStrategyBasket: LiveStrategyBasketConfig | null;
  updateLiveStrategyBasket: (input: {
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
  }) => Promise<LiveStrategyBasketConfig | null>;
  removeBasketItem: (
    symbol: InstrumentSymbol,
    timeframe: Timeframe,
    strategyId?: BacktestStrategyId
  ) => Promise<LiveStrategyBasketConfig | null>;
  armBestStrategies: (
    criteria?: LiveStrategyFilterCriteria & { autoScanIfEmpty?: boolean }
  ) => Promise<{
    ok: boolean;
    basket: LiveStrategyBasketConfig | null;
    matchedCombos: number;
    message: string;
  }>;
  clearLiveStrategyBasket: () => Promise<void>;
  discoveryProgress: DiscoveryScanProgress;
  journalEntries: TradeJournalEntry[];
  paperPositions: PaperPosition[];
  paperOrders: PaperOrder[];
  riskSnapshot: RiskAccountSnapshot | null;
  mt5Status: MT5BridgeStatus | null;
  mt5ExecutionSettings: MT5ExecutionSettings;
  mt5ManagedTrades: MT5ManagedTrade[];
  mt5Commands: MT5TradeCommand[];
  refreshJournal: () => Promise<void>;
  refreshMt5Status: () => Promise<void>;
  refreshMt5Execution: () => Promise<void>;
  updateMt5ExecutionSettings: (
    partial: Partial<MT5ExecutionSettings>
  ) => Promise<{ ok: boolean; error?: string }>;
  executeMt5Trade: (signalId: string) => Promise<{ success: boolean; error?: string }>;
  moveMt5TradeToBreakeven: (tradeId: string) => Promise<{ success: boolean; error?: string }>;
  trailMt5TradeToTp1: (tradeId: string) => Promise<{ success: boolean; error?: string }>;
  closeMt5Trade: (tradeId: string) => Promise<{ success: boolean; error?: string }>;
  closeAllMt5Trades: () => Promise<void>;
  cancelMt5Command: (commandId: string) => Promise<void>;
  refreshPaperState: () => Promise<void>;
  executePaperTrade: (signalId: string) => Promise<{ success: boolean; error?: string }>;
  closePaperPosition: (positionId: string) => Promise<{ success: boolean; error?: string }>;
  resetPaperAccount: (startingEquity?: number) => Promise<void>;
  updateRiskSettings: (partial: Partial<RiskSettings>) => Promise<void>;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

function normalizeSignalSettings(incoming?: Partial<SignalSettings> | null): SignalSettings {
  return {
    ...DEFAULT_SIGNAL_SETTINGS,
    ...(incoming ?? {}),
    smcCriteria: {
      ...DEFAULT_SIGNAL_SETTINGS.smcCriteria,
      ...(incoming?.smcCriteria ?? {}),
    },
    timeframes: {
      ...DEFAULT_SIGNAL_SETTINGS.timeframes,
      ...(incoming?.timeframes ?? {}),
    },
    weights: {
      ...DEFAULT_SIGNAL_SETTINGS.weights,
      ...(incoming?.weights ?? {}),
    },
  };
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [symbol, setSymbol] = useState<InstrumentSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [timezone, setTimezone] = useState<string>('UTC');
  const [visibility, setVisibility] = useState<ChartVisibilityConfig>(DEFAULT_CHART_VISIBILITY);

  const [quotes, setQuotes] = useState<Record<InstrumentSymbol, LiveQuote | undefined>>({
    XAUUSD: undefined,
    XAGUSD: undefined,
    BTCUSDT: undefined,
    ETHUSDT: undefined,
  });
  const [providers, setProviders] = useState<Record<InstrumentSymbol, ProviderStatus | undefined>>({
    XAUUSD: undefined,
    XAGUSD: undefined,
    BTCUSDT: undefined,
    ETHUSDT: undefined,
  });

  const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState<boolean>(true);
  const [mtfSummary, setMtfSummary] = useState<MultiTimeframeSummary | null>(null);
  const [loadingMtf, setLoadingMtf] = useState<boolean>(false);
  const [events, setEvents] = useState<ZoneInteractionEvent[]>([]);
  const [alerts, setAlerts] = useState<AlertNotification[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRule[]>(DEFAULT_ALERT_RULES);
  const [alertsEnabled, setAlertsEnabledState] = useState<boolean>(false);
  const [settings, setSettings] = useState<TechnicalSettings>(DEFAULT_TECHNICAL_SETTINGS);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(false);
  const [browserAlertsEnabled, setBrowserAlertsEnabled] = useState<boolean>(false);
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [signals, setSignals] = useState<TradingSignal[]>([]);
  const [signalDiagnostics, setSignalDiagnostics] = useState<SignalEvaluationDiagnostic[]>([]);
  const [signalPerformance, setSignalPerformance] = useState<SignalPerformanceStats | null>(null);
  const [signalSettings, setSignalSettings] = useState<SignalSettings>(DEFAULT_SIGNAL_SETTINGS);
  const [signalNotifications, setSignalNotifications] = useState<SignalNotification[]>([]);
  const [evaluatingSignals, setEvaluatingSignals] = useState<boolean>(false);
  const [liveStrategyBasket, setLiveStrategyBasket] = useState<LiveStrategyBasketConfig | null>(
    null
  );
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryScanProgress>({
    jobId: 'idle',
    status: 'idle',
    completedSteps: 0,
    totalSteps: 0,
    message: 'Ready to scan historical markets',
    startedAt: null,
  });

  const socketRef = useRef<Socket | null>(null);
  const activeRef = useRef({ symbol, timeframe });
  activeRef.current = { symbol, timeframe };
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const browserRef = useRef(browserAlertsEnabled);
  browserRef.current = browserAlertsEnabled;
  const alertsEnabledRef = useRef(alertsEnabled);
  alertsEnabledRef.current = alertsEnabled;
  const alertRulesRef = useRef(alertRules);
  alertRulesRef.current = alertRules;
  const focusNonceRef = useRef(0);
  const pendingQuotesRef = useRef<Partial<Record<InstrumentSymbol, LiveQuote>>>({});
  const quoteFlushTimerRef = useRef<number | null>(null);
  const { playChime } = useAlertAudio();
  const { token } = useAuth();

  useEffect(() => {
    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      withCredentials: true,
      auth: token ? { token } : undefined,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      socket.emit('subscribe:chart', {
        symbol: activeRef.current.symbol,
        timeframe: activeRef.current.timeframe,
      });
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('terminal:overview', (data: {
      quotes: LiveQuote[];
      providers: ProviderStatus[];
      settings: TechnicalSettings;
      alertsEnabled?: boolean;
      alertRules: AlertRule[];
      alertHistory: AlertNotification[];
      events: ZoneInteractionEvent[];
      signals?: TradingSignal[];
      signalDiagnostics?: SignalEvaluationDiagnostic[];
      signalPerformance?: SignalPerformanceStats;
      signalSettings?: SignalSettings;
      signalNotifications?: SignalNotification[];
      liveStrategyBasket?: LiveStrategyBasketConfig | null;
      journalEntries?: TradeJournalEntry[];
      paperPositions?: PaperPosition[];
      paperOrders?: PaperOrder[];
      riskSnapshot?: RiskAccountSnapshot;
      mt5Status?: MT5BridgeStatus;
      mt5Execution?: MT5ExecutionOverview;
    }) => {
      if (Array.isArray(data.quotes)) {
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of data.quotes) next[q.symbol] = q;
          return next;
        });
      }
      if (Array.isArray(data.providers)) {
        setProviders((prev) => {
          const next = { ...prev };
          for (const p of data.providers) next[p.symbol] = p;
          return next;
        });
      }
      if (data.settings) setSettings(data.settings);
      if (typeof data.alertsEnabled === 'boolean') setAlertsEnabledState(data.alertsEnabled);
      if (Array.isArray(data.alertRules)) setAlertRules(data.alertRules);
      if (Array.isArray(data.alertHistory)) setAlerts(data.alertHistory);
      if (Array.isArray(data.events)) {
        setEvents(
          [...data.events].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
        );
      }
      if (Array.isArray(data.signals)) {
        setSignals([...data.signals].sort((a, b) => b.createdAt - a.createdAt));
      }
      if (Array.isArray(data.signalDiagnostics)) {
        setSignalDiagnostics(data.signalDiagnostics);
      }
      if (data.signalPerformance) {
        setSignalPerformance(data.signalPerformance);
      }
      if (data.signalSettings) {
        setSignalSettings(normalizeSignalSettings(data.signalSettings));
      }
      if (Array.isArray(data.signalNotifications)) {
        setSignalNotifications(data.signalNotifications);
      }
      if (data.liveStrategyBasket !== undefined) {
        setLiveStrategyBasket(data.liveStrategyBasket ?? null);
      }
      if (Array.isArray(data.journalEntries)) {
        setJournalEntries(data.journalEntries);
      }
      if (Array.isArray(data.paperPositions)) {
        setPaperPositions(data.paperPositions);
      }
      if (Array.isArray(data.paperOrders)) {
        setPaperOrders(data.paperOrders);
      }
      if (data.riskSnapshot) {
        setRiskSnapshot(data.riskSnapshot);
      }
      if (data.mt5Status) {
        setMt5Status(data.mt5Status);
      }
      if (data.mt5Execution) {
        setMt5ExecutionSettings(data.mt5Execution.settings);
        setMt5ManagedTrades(data.mt5Execution.managedTrades ?? []);
        setMt5Commands(data.mt5Execution.commands ?? []);
      }
    });

    socket.on('market:quote', (q: LiveQuote) => {
      pendingQuotesRef.current[q.symbol] = q;
      if (quoteFlushTimerRef.current === null) {
        quoteFlushTimerRef.current = window.setTimeout(() => {
          quoteFlushTimerRef.current = null;
          const batch = pendingQuotesRef.current;
          pendingQuotesRef.current = {};
          const keys = Object.keys(batch) as InstrumentSymbol[];
          if (keys.length === 0) return;
          setQuotes((prev) => {
            const next = { ...prev };
            for (const k of keys) {
              if (batch[k]) next[k] = batch[k];
            }
            return next;
          });
        }, 150);
      }
    });

    socket.on('provider:status', (p: ProviderStatus) => {
      setProviders((prev) => ({ ...prev, [p.symbol]: p }));
    });

    socket.on(
      'market:candle',
      (payload: { symbol: InstrumentSymbol; timeframe: Timeframe; candle: Candle }) => {
        if (
          payload.symbol !== activeRef.current.symbol ||
          payload.timeframe !== activeRef.current.timeframe
        ) {
          return;
        }
        setSnapshot((prev) => {
          if (!prev || prev.symbol !== payload.symbol || prev.timeframe !== payload.timeframe) {
            return prev;
          }
          const candles = [...prev.candles];
          const last = candles[candles.length - 1];
          if (last && last.time === payload.candle.time) {
            candles[candles.length - 1] = payload.candle;
          } else if (!last || payload.candle.time > last.time) {
            if (last && !last.isClosed) {
              candles[candles.length - 1] = { ...last, isClosed: true };
            }
            candles.push(payload.candle);
          }
          return { ...prev, candles };
        });
      }
    );

    socket.on('analysis:snapshot', (snap: AnalysisSnapshot) => {
      if (
        snap.symbol !== activeRef.current.symbol ||
        snap.timeframe !== activeRef.current.timeframe
      ) {
        return;
      }
      setSnapshot(snap);
      setLoadingSnapshot(false);
    });

    socket.on(
      'monitor:zones',
      (payload: {
        symbol: InstrumentSymbol;
        timeframe: Timeframe;
        interactions: ZoneInteractionEvent[];
      }) => {
        if (
          payload.symbol !== activeRef.current.symbol ||
          payload.timeframe !== activeRef.current.timeframe
        ) {
          return;
        }
        setSnapshot((prev) => {
          if (!prev || prev.symbol !== payload.symbol) return prev;
          return { ...prev, zoneInteractions: payload.interactions };
        });
      }
    );

    socket.on('monitor:events', (incoming: ZoneInteractionEvent[]) => {
      if (!Array.isArray(incoming) || incoming.length === 0) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const unseen = incoming.filter((i) => !seen.has(i.id));
        if (unseen.length === 0) return prev;
        return [...unseen, ...prev]
          .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
          .slice(0, 120);
      });
    });

    socket.on('alert:triggered', (alert: AlertNotification) => {
      if (!alertsEnabledRef.current && !alert.id.startsWith('alert:test:')) {
        return;
      }
      setAlerts((prev) => [alert, ...prev.filter((a) => a.id !== alert.id)].slice(0, 80));
      const matchedRule =
        alertRulesRef.current.find((r) => r.type === alert.type && r.enabled) ??
        alertRulesRef.current.find((r) => r.type === alert.type);
      if (soundRef.current && (matchedRule?.soundEnabled ?? true)) {
        playChime(alert.direction);
      }
      if (
        browserRef.current &&
        (matchedRule?.browserNotify ?? true) &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification(alert.title, { body: alert.message });
      }
    });

    socket.on('alert:enabled', (payload: { enabled?: boolean }) => {
      if (typeof payload?.enabled === 'boolean') {
        setAlertsEnabledState(payload.enabled);
      }
    });

    socket.on('alert:rules', (rules: AlertRule[]) => {
      if (Array.isArray(rules)) setAlertRules(rules);
    });

    socket.on('alert:cleared', () => {
      setAlerts([]);
    });

    socket.on('signal:updated', (sig: TradingSignal) => {
      setSignals((prev) =>
        [sig, ...prev.filter((s) => s.id !== sig.id)].sort((a, b) => b.createdAt - a.createdAt)
      );
    });

    socket.on(
      'signal:deleted',
      (payload: { deletedIds?: string[]; scope?: SignalDeleteScope }) => {
        const deletedSet = new Set(payload?.deletedIds ?? []);
        if (deletedSet.size === 0) return;
        setSignals((prev) => prev.filter((s) => !deletedSet.has(s.id)));
        setSignalNotifications((prev) => prev.filter((n) => !deletedSet.has(n.signalId)));
      }
    );

    socket.on('signal:diagnostics', (diags: SignalEvaluationDiagnostic[]) => {
      if (Array.isArray(diags)) {
        setSignalDiagnostics(diags);
      }
    });

    socket.on('signal:performance', (perf: SignalPerformanceStats) => {
      if (perf) setSignalPerformance(perf);
    });

    socket.on('signal:settings', (nextSettings: SignalSettings) => {
      if (nextSettings) setSignalSettings(normalizeSignalSettings(nextSettings));
    });

    socket.on('signal:basket', (basket: LiveStrategyBasketConfig | null) => {
      setLiveStrategyBasket(basket ?? null);
    });

    socket.on('discovery:progress', (progress: DiscoveryScanProgress) => {
      if (progress) setDiscoveryProgress(progress);
    });

    socket.on('mt5:status', (status: MT5BridgeStatus) => {
      if (status) setMt5Status(status);
    });

    socket.on('mt5:execution', (overview: MT5ExecutionOverview) => {
      if (!overview) return;
      if (overview.settings) setMt5ExecutionSettings(overview.settings);
      if (Array.isArray(overview.managedTrades)) setMt5ManagedTrades(overview.managedTrades);
      if (Array.isArray(overview.commands)) setMt5Commands(overview.commands);
      if (overview.mt5Status) setMt5Status(overview.mt5Status);
    });

    socket.on(
      'paper:updated',
      (payload: {
        positions?: PaperPosition[];
        orders?: PaperOrder[];
        riskSnapshot?: RiskAccountSnapshot;
      }) => {
        if (Array.isArray(payload.positions)) setPaperPositions(payload.positions);
        if (Array.isArray(payload.orders)) setPaperOrders(payload.orders);
        if (payload.riskSnapshot) setRiskSnapshot(payload.riskSnapshot);
      }
    );

    socket.on('journal:updated', (entry: TradeJournalEntry) => {
      if (!entry) return;
      setJournalEntries((prev) =>
        [entry, ...prev.filter((j) => j.id !== entry.id)].sort(
          (a, b) => b.executedAt - a.executedAt
        )
      );
    });

    socket.on('signal:notification', (notif: SignalNotification) => {
      setSignalNotifications((prev) =>
        [notif, ...prev.filter((n) => n.id !== notif.id)].slice(0, 120)
      );
      if (soundRef.current) {
        playChime(notif.direction === 'BUY' ? 'bullish' : 'bearish');
      }
      if (
        browserRef.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification(notif.title, { body: notif.message });
      }
    });

    return () => {
      if (quoteFlushTimerRef.current !== null) {
        window.clearTimeout(quoteFlushTimerRef.current);
        quoteFlushTimerRef.current = null;
      }
      pendingQuotesRef.current = {};
      socket.disconnect();
      socketRef.current = null;
    };
  }, [playChime, token]);

  const fetchSnapshotHttp = useCallback(async (sym: InstrumentSymbol, tf: Timeframe, force = false) => {
    setLoadingSnapshot(true);
    try {
      const res = await apiFetch(`/api/snapshot/${sym}/${tf}${force ? '?force=1' : ''}`);
      if (res.ok) {
        const data = (await res.json()) as AnalysisSnapshot;
        if (activeRef.current.symbol === sym && activeRef.current.timeframe === tf) {
          setSnapshot(data);
        }
      }
    } finally {
      if (activeRef.current.symbol === sym && activeRef.current.timeframe === tf) {
        setLoadingSnapshot(false);
      }
    }
  }, []);

  const refreshMtf = useCallback(async () => {
    const sym = activeRef.current.symbol;
    setLoadingMtf(true);
    try {
      const res = await apiFetch(`/api/mtf/${sym}`);
      if (res.ok) {
        const data = (await res.json()) as MultiTimeframeSummary;
        if (activeRef.current.symbol === sym) {
          setMtfSummary(data);
        }
      }
    } finally {
      setLoadingMtf(false);
    }
  }, []);

  useEffect(() => {
    setSelectedObjectId(null);
    setHoveredObjectId(null);
    setFocusRequest(null);
    void fetchSnapshotHttp(symbol, timeframe);
    socketRef.current?.emit('subscribe:chart', { symbol, timeframe });
  }, [symbol, timeframe, fetchSnapshotHttp]);

  const selectSymbol = useCallback((sym: InstrumentSymbol) => {
    setSymbol(sym);
  }, []);

  const selectTimeframe = useCallback((tf: Timeframe) => {
    setTimeframe(tf);
  }, []);

  const toggleVisibility = useCallback((key: keyof ChartVisibilityConfig) => {
    setVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setLayerVisibility = useCallback((partial: Partial<ChartVisibilityConfig>) => {
    setVisibility((prev) => ({ ...prev, ...partial }));
  }, []);

  const toggleSmcOverlays = useCallback(() => {
    setVisibility((prev) => {
      const allOn = SMC_VISIBILITY_KEYS.every((k) => prev[k]);
      const nextVal = !allOn;
      return {
        ...prev,
        orderBlocks: nextVal,
        fairValueGaps: nextVal,
        liquiditySweeps: nextVal,
      };
    });
  }, []);

  const setAllVisibility = useCallback((visible: boolean) => {
    setVisibility({
      candlestickPatterns: visible,
      chartPatterns: visible,
      supportResistance: visible,
      supplyDemand: visible,
      marketStructure: visible,
      orderBlocks: visible,
      fairValueGaps: visible,
      liquidity: visible,
      liquiditySweeps: visible,
      trendlines: visible,
      premiumDiscount: visible,
      sessions: visible,
      volume: visible,
      provisional: visible,
      signals: visible,
    });
  }, []);

  const focusChartObject = useCallback((id: string, startTime: number, endTime: number) => {
    setSelectedObjectId(id);
    focusNonceRef.current += 1;
    setFocusRequest({
      id,
      startTime,
      endTime,
      nonce: focusNonceRef.current,
    });
  }, []);

  const refreshSnapshot = useCallback(async () => {
    await fetchSnapshotHttp(activeRef.current.symbol, activeRef.current.timeframe, true);
  }, [fetchSnapshotHttp]);

  const updateSettings = useCallback(async (partial: Partial<TechnicalSettings>) => {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (res.ok) {
      const updated = (await res.json()) as TechnicalSettings;
      setSettings(updated);
      await fetchSnapshotHttp(activeRef.current.symbol, activeRef.current.timeframe, false);
    }
  }, [fetchSnapshotHttp]);

  const refreshAlerts = useCallback(async () => {
    const res = await apiFetch('/api/alerts');
    if (res.ok) {
      const data = (await res.json()) as {
        enabled?: boolean;
        rules?: AlertRule[];
        history?: AlertNotification[];
      };
      if (typeof data.enabled === 'boolean') setAlertsEnabledState(data.enabled);
      if (Array.isArray(data.rules)) setAlertRules(data.rules);
      if (Array.isArray(data.history)) setAlerts(data.history);
    }
  }, []);

  const setAlertsEnabled = useCallback(async (enabled: boolean) => {
    setAlertsEnabledState(enabled);
    const res = await apiFetch('/api/alerts/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = (await res.json()) as { enabled?: boolean };
      if (typeof data.enabled === 'boolean') setAlertsEnabledState(data.enabled);
    }
  }, []);

  const updateAlertRules = useCallback(async (rules: AlertRule[]) => {
    const res = await apiFetch('/api/alerts/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error || `Failed to save rules (${res.status})` };
    }
    const data = (await res.json()) as { rules: AlertRule[] };
    if (Array.isArray(data.rules)) setAlertRules(data.rules);
    return { ok: true };
  }, []);

  const resetAlertRules = useCallback(async () => {
    const res = await apiFetch('/api/alerts/rules/reset', {
      method: 'POST',
    });
    if (res.ok) {
      const data = (await res.json()) as { rules: AlertRule[] };
      if (Array.isArray(data.rules)) setAlertRules(data.rules);
    }
  }, []);

  const clearAlertHistory = useCallback(async () => {
    const res = await apiFetch('/api/alerts/history', {
      method: 'DELETE',
    });
    if (res.ok) {
      setAlerts([]);
    }
  }, []);

  const triggerTestAlert = useCallback(async (ruleId?: string) => {
    const res = await apiFetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: activeRef.current.symbol,
        timeframe: activeRef.current.timeframe,
        ruleId,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error || `Failed to send test alert (${res.status})` };
    }
    const data = (await res.json()) as { ok?: boolean; alert?: AlertNotification };
    if (data.alert) {
      setAlerts((prev) => [data.alert!, ...prev.filter((a) => a.id !== data.alert!.id)].slice(0, 80));
    }
    return { ok: true };
  }, []);

  const setDealingRangeLookback = useCallback(async (lookback?: number) => {
    await apiFetch(`/api/dealing-range/${activeRef.current.symbol}/${activeRef.current.timeframe}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookback }),
    });
    await fetchSnapshotHttp(activeRef.current.symbol, activeRef.current.timeframe, false);
  }, [fetchSnapshotHttp]);

  const evaluateSignals = useCallback(async (sym?: InstrumentSymbol) => {
    setEvaluatingSignals(true);
    try {
      const res = await apiFetch('/api/signals/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sym ? { symbol: sym } : {}),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          signals?: TradingSignal[];
          diagnostics?: SignalEvaluationDiagnostic[];
          performance?: SignalPerformanceStats;
        };
        if (Array.isArray(data.signals)) {
          setSignals((prev) => {
            const byId = new Map(prev.map((s) => [s.id, s]));
            for (const s of data.signals!) byId.set(s.id, s);
            return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
          });
        }
        if (Array.isArray(data.diagnostics)) setSignalDiagnostics(data.diagnostics);
        if (data.performance) setSignalPerformance(data.performance);
      }
    } finally {
      setEvaluatingSignals(false);
    }
  }, []);

  const refreshSignals = useCallback(async () => {
    const res = await apiFetch('/api/signals');
    if (res.ok) {
      const data = (await res.json()) as {
        signals?: TradingSignal[];
        diagnostics?: SignalEvaluationDiagnostic[];
        performance?: SignalPerformanceStats;
        settings?: SignalSettings;
        notifications?: SignalNotification[];
        liveStrategyBasket?: LiveStrategyBasketConfig | null;
      };
      if (Array.isArray(data.signals)) {
        setSignals([...data.signals].sort((a, b) => b.createdAt - a.createdAt));
      }
      if (Array.isArray(data.diagnostics)) setSignalDiagnostics(data.diagnostics);
      if (data.performance) setSignalPerformance(data.performance);
      if (data.settings) setSignalSettings(normalizeSignalSettings(data.settings));
      if (Array.isArray(data.notifications)) setSignalNotifications(data.notifications);
      if (data.liveStrategyBasket !== undefined) {
        setLiveStrategyBasket(data.liveStrategyBasket ?? null);
      }
    }
  }, []);

  const cancelSignal = useCallback(async (signalId: string) => {
    const res = await apiFetch(`/api/signals/${encodeURIComponent(signalId)}/cancel`, {
      method: 'POST',
    });
    if (res.ok) {
      const data = (await res.json()) as {
        signal: TradingSignal;
        performance?: SignalPerformanceStats;
      };
      setSignals((prev) =>
        [data.signal, ...prev.filter((s) => s.id !== data.signal.id)].sort(
          (a, b) => b.createdAt - a.createdAt
        )
      );
      if (data.performance) setSignalPerformance(data.performance);
    }
  }, []);

  const deleteSignal = useCallback(async (signalId: string) => {
    const res = await apiFetch(`/api/signals/${encodeURIComponent(signalId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = (await res.json()) as {
        signals?: TradingSignal[];
        performance?: SignalPerformanceStats;
        diagnostics?: SignalEvaluationDiagnostic[];
        notifications?: SignalNotification[];
      };
      if (Array.isArray(data.signals)) {
        setSignals([...data.signals].sort((a, b) => b.createdAt - a.createdAt));
      } else {
        setSignals((prev) => prev.filter((s) => s.id !== signalId));
      }
      if (data.performance) setSignalPerformance(data.performance);
      if (Array.isArray(data.diagnostics)) setSignalDiagnostics(data.diagnostics);
      if (Array.isArray(data.notifications)) setSignalNotifications(data.notifications);
    }
  }, []);

  const deleteSignalsBulk = useCallback(async (signalIds: string[]) => {
    if (signalIds.length === 0) return;
    const res = await apiFetch('/api/signals/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: signalIds }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        signals?: TradingSignal[];
        performance?: SignalPerformanceStats;
        diagnostics?: SignalEvaluationDiagnostic[];
        notifications?: SignalNotification[];
      };
      if (Array.isArray(data.signals)) {
        setSignals([...data.signals].sort((a, b) => b.createdAt - a.createdAt));
      } else {
        const delSet = new Set(signalIds);
        setSignals((prev) => prev.filter((s) => !delSet.has(s.id)));
      }
      if (data.performance) setSignalPerformance(data.performance);
      if (Array.isArray(data.diagnostics)) setSignalDiagnostics(data.diagnostics);
      if (Array.isArray(data.notifications)) setSignalNotifications(data.notifications);
    }
  }, []);

  const clearSignals = useCallback(async (scope: SignalDeleteScope) => {
    const res = await apiFetch(`/api/signals?scope=${encodeURIComponent(scope)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = (await res.json()) as {
        signals?: TradingSignal[];
        performance?: SignalPerformanceStats;
        diagnostics?: SignalEvaluationDiagnostic[];
        notifications?: SignalNotification[];
      };
      if (Array.isArray(data.signals)) {
        setSignals([...data.signals].sort((a, b) => b.createdAt - a.createdAt));
      }
      if (data.performance) setSignalPerformance(data.performance);
      if (Array.isArray(data.diagnostics)) setSignalDiagnostics(data.diagnostics);
      if (Array.isArray(data.notifications)) setSignalNotifications(data.notifications);
    }
  }, []);

  const updateSignalSettings = useCallback(async (partial: Partial<SignalSettings>) => {
    const res = await apiFetch('/api/signals/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `Failed to save signal settings (${res.status})`);
    }
    const updated = (await res.json()) as SignalSettings;
    setSignalSettings(normalizeSignalSettings(updated));
  }, []);

  const updateLiveStrategyBasket = useCallback(
    async (input: {
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
    }) => {
      const res = await apiFetch('/api/signals/basket', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to save live basket (${res.status})`);
      }
      const data = (await res.json()) as { basket: LiveStrategyBasketConfig | null };
      setLiveStrategyBasket(data.basket ?? null);
      return data.basket ?? null;
    },
    []
  );

  const removeBasketItem = useCallback(
    async (symbol: InstrumentSymbol, timeframe: Timeframe, strategyId?: BacktestStrategyId) => {
      const res = await apiFetch('/api/signals/basket/remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, timeframe, strategyId }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to remove strategy from basket (${res.status})`);
      }
      const data = (await res.json()) as { basket: LiveStrategyBasketConfig | null };
      setLiveStrategyBasket(data.basket ?? null);
      return data.basket ?? null;
    },
    []
  );

  const armBestStrategies = useCallback(
    async (criteria?: LiveStrategyFilterCriteria & { autoScanIfEmpty?: boolean }) => {
      const res = await apiFetch('/api/signals/basket/arm-best', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(criteria ?? {}),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          basket: null,
          matchedCombos: 0,
          message: err.error || `Failed to load best strategies (${res.status})`,
        };
      }
      const data = (await res.json()) as {
        ok: boolean;
        basket: LiveStrategyBasketConfig | null;
        matchedCombos: number;
        message: string;
      };
      if (data.basket !== undefined) {
        setLiveStrategyBasket(data.basket ?? null);
      }
      await refreshSignals();
      return data;
    },
    [refreshSignals]
  );

  const clearLiveStrategyBasket = useCallback(async () => {
    const res = await apiFetch('/api/signals/basket', { method: 'DELETE' });
    if (res.ok) {
      setLiveStrategyBasket(null);
    }
  }, []);

  const [journalEntries, setJournalEntries] = useState<TradeJournalEntry[]>([]);
  const [paperPositions, setPaperPositions] = useState<PaperPosition[]>([]);
  const [paperOrders, setPaperOrders] = useState<PaperOrder[]>([]);
  const [riskSnapshot, setRiskSnapshot] = useState<RiskAccountSnapshot | null>(null);
  const [mt5Status, setMt5Status] = useState<MT5BridgeStatus | null>(null);
  const [mt5ExecutionSettings, setMt5ExecutionSettings] = useState<MT5ExecutionSettings>(
    DEFAULT_MT5_EXECUTION_SETTINGS
  );
  const [mt5ManagedTrades, setMt5ManagedTrades] = useState<MT5ManagedTrade[]>([]);
  const [mt5Commands, setMt5Commands] = useState<MT5TradeCommand[]>([]);

  const applyMt5Overview = useCallback((overview?: MT5ExecutionOverview) => {
    if (!overview) return;
    if (overview.settings) setMt5ExecutionSettings(overview.settings);
    if (Array.isArray(overview.managedTrades)) setMt5ManagedTrades(overview.managedTrades);
    if (Array.isArray(overview.commands)) setMt5Commands(overview.commands);
    if (overview.mt5Status) setMt5Status(overview.mt5Status);
  }, []);

  const refreshJournal = useCallback(async () => {
    const res = await apiFetch('/api/journal');
    if (res.ok) {
      const data = (await res.json()) as { entries: TradeJournalEntry[] };
      if (Array.isArray(data.entries)) setJournalEntries(data.entries);
    }
  }, []);

  const refreshMt5Status = useCallback(async () => {
    const res = await apiFetch('/api/mt5/status');
    if (res.ok) {
      const data = (await res.json()) as MT5BridgeStatus;
      setMt5Status(data);
    }
  }, []);

  const refreshMt5Execution = useCallback(async () => {
    const res = await apiFetch('/api/mt5/execution');
    if (res.ok) {
      const data = (await res.json()) as MT5ExecutionOverview;
      applyMt5Overview(data);
    }
  }, [applyMt5Overview]);

  const updateMt5ExecutionSettings = useCallback(
    async (partial: Partial<MT5ExecutionSettings>) => {
      const res = await apiFetch('/api/mt5/execution/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || `Failed to save MT5 settings (${res.status})` };
      }
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
      return { ok: true };
    },
    [applyMt5Overview]
  );

  const executeMt5Trade = useCallback(
    async (signalId: string) => {
      const res = await apiFetch(`/api/mt5/execution/execute/${encodeURIComponent(signalId)}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'MT5 execution rejected' };
      }
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
      return { success: true };
    },
    [applyMt5Overview]
  );

  const moveMt5TradeToBreakeven = useCallback(
    async (tradeId: string) => {
      const res = await apiFetch(`/api/mt5/execution/trades/${encodeURIComponent(tradeId)}/breakeven`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'Failed to move SL to breakeven' };
      }
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
      return { success: true };
    },
    [applyMt5Overview]
  );

  const trailMt5TradeToTp1 = useCallback(
    async (tradeId: string) => {
      const res = await apiFetch(`/api/mt5/execution/trades/${encodeURIComponent(tradeId)}/trail-tp1`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'Failed to trail SL to TP1' };
      }
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
      return { success: true };
    },
    [applyMt5Overview]
  );

  const closeMt5Trade = useCallback(
    async (tradeId: string) => {
      const res = await apiFetch(`/api/mt5/execution/trades/${encodeURIComponent(tradeId)}/close`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'Failed to close MT5 trade' };
      }
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
      return { success: true };
    },
    [applyMt5Overview]
  );

  const closeAllMt5Trades = useCallback(async () => {
    const res = await apiFetch('/api/mt5/execution/trades/close-all', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { overview?: MT5ExecutionOverview };
      applyMt5Overview(data.overview);
    }
  }, [applyMt5Overview]);

  const cancelMt5Command = useCallback(
    async (commandId: string) => {
      const res = await apiFetch(`/api/mt5/execution/commands/${encodeURIComponent(commandId)}/cancel`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = (await res.json()) as { overview?: MT5ExecutionOverview };
        applyMt5Overview(data.overview);
      }
    },
    [applyMt5Overview]
  );

  const refreshPaperState = useCallback(async () => {
    const [riskRes, posRes, ordRes] = await Promise.all([
      apiFetch('/api/risk/snapshot'),
      apiFetch('/api/paper/positions'),
      apiFetch('/api/paper/orders'),
    ]);
    if (riskRes.ok) {
      setRiskSnapshot((await riskRes.json()) as RiskAccountSnapshot);
    }
    if (posRes.ok) {
      const data = (await posRes.json()) as { positions?: PaperPosition[] };
      if (Array.isArray(data.positions)) setPaperPositions(data.positions);
    }
    if (ordRes.ok) {
      const data = (await ordRes.json()) as { orders?: PaperOrder[] };
      if (Array.isArray(data.orders)) setPaperOrders(data.orders);
    }
  }, []);

  const executePaperTrade = useCallback(
    async (signalId: string) => {
      const res = await apiFetch(`/api/paper/execute/${encodeURIComponent(signalId)}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'Paper execution rejected' };
      }
      const data = (await res.json()) as {
        positions?: PaperPosition[];
        orders?: PaperOrder[];
        riskSnapshot?: RiskAccountSnapshot;
      };
      if (Array.isArray(data.positions)) setPaperPositions(data.positions);
      if (Array.isArray(data.orders)) setPaperOrders(data.orders);
      if (data.riskSnapshot) setRiskSnapshot(data.riskSnapshot);
      await refreshJournal();
      return { success: true };
    },
    [refreshJournal]
  );

  const closePaperPosition = useCallback(
    async (positionId: string) => {
      const res = await apiFetch(`/api/paper/positions/${encodeURIComponent(positionId)}/close`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: err.error || 'Unable to close paper position' };
      }
      const data = (await res.json()) as {
        positions?: PaperPosition[];
        orders?: PaperOrder[];
        riskSnapshot?: RiskAccountSnapshot;
      };
      if (Array.isArray(data.positions)) setPaperPositions(data.positions);
      if (Array.isArray(data.orders)) setPaperOrders(data.orders);
      if (data.riskSnapshot) setRiskSnapshot(data.riskSnapshot);
      await refreshJournal();
      return { success: true };
    },
    [refreshJournal]
  );

  const resetPaperAccount = useCallback(
    async (startingEquity?: number) => {
      const res = await apiFetch('/api/paper/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          startingEquity !== undefined ? { startingEquity } : {}
        ),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          positions?: PaperPosition[];
          orders?: PaperOrder[];
          riskSnapshot?: RiskAccountSnapshot;
        };
        if (Array.isArray(data.positions)) setPaperPositions(data.positions);
        if (Array.isArray(data.orders)) setPaperOrders(data.orders);
        if (data.riskSnapshot) setRiskSnapshot(data.riskSnapshot);
      }
    },
    []
  );

  const updateRiskSettings = useCallback(async (partial: Partial<RiskSettings>) => {
    const res = await apiFetch('/api/risk/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (res.ok) {
      const data = (await res.json()) as { riskSnapshot?: RiskAccountSnapshot };
      if (data.riskSnapshot) setRiskSnapshot(data.riskSnapshot);
    }
  }, []);

  useEffect(() => {
    void refreshAlerts();
    void refreshJournal();
    void refreshMt5Execution();
    void refreshPaperState();
    const mt5Timer = setInterval(() => {
      void refreshMt5Execution();
    }, 20000);
    return () => clearInterval(mt5Timer);
  }, [refreshAlerts, refreshJournal, refreshMt5Execution, refreshPaperState]);

  const contextValue = useMemo<TerminalContextValue>(
    () => ({
      symbol,
      timeframe,
      chartType,
      timezone,
      visibility,
      quotes,
      providers,
      snapshot,
      loadingSnapshot,
      mtfSummary,
      loadingMtf,
      events,
      alerts,
      alertRules,
      alertsEnabled,
      settings,
      soundEnabled,
      browserAlertsEnabled,
      hoveredObjectId,
      selectedObjectId,
      focusRequest,
      socketConnected,
      selectSymbol,
      selectTimeframe,
      setChartType,
      setTimezone,
      toggleVisibility,
      setLayerVisibility,
      toggleSmcOverlays,
      setAllVisibility,
      setHoveredObjectId,
      setSelectedObjectId,
      focusChartObject,
      refreshSnapshot,
      refreshMtf,
      updateSettings,
      refreshAlerts,
      setAlertsEnabled,
      updateAlertRules,
      resetAlertRules,
      clearAlertHistory,
      triggerTestAlert,
      setSoundEnabled,
      setBrowserAlertsEnabled,
      setDealingRangeLookback,
      signals,
      signalDiagnostics,
      signalPerformance,
      signalSettings,
      signalNotifications,
      evaluatingSignals,
      evaluateSignals,
      refreshSignals,
      cancelSignal,
      deleteSignal,
      deleteSignalsBulk,
      clearSignals,
      updateSignalSettings,
      liveStrategyBasket,
      updateLiveStrategyBasket,
      removeBasketItem,
      armBestStrategies,
      clearLiveStrategyBasket,
      discoveryProgress,
      journalEntries,
      paperPositions,
      paperOrders,
      riskSnapshot,
      mt5Status,
      mt5ExecutionSettings,
      mt5ManagedTrades,
      mt5Commands,
      refreshJournal,
      refreshMt5Status,
      refreshMt5Execution,
      updateMt5ExecutionSettings,
      executeMt5Trade,
      moveMt5TradeToBreakeven,
      trailMt5TradeToTp1,
      closeMt5Trade,
      closeAllMt5Trades,
      cancelMt5Command,
      refreshPaperState,
      executePaperTrade,
      closePaperPosition,
      resetPaperAccount,
      updateRiskSettings,
    }),
    [
      symbol,
      timeframe,
      chartType,
      timezone,
      visibility,
      quotes,
      providers,
      snapshot,
      loadingSnapshot,
      mtfSummary,
      loadingMtf,
      events,
      alerts,
      alertRules,
      alertsEnabled,
      settings,
      soundEnabled,
      browserAlertsEnabled,
      hoveredObjectId,
      selectedObjectId,
      focusRequest,
      socketConnected,
      selectSymbol,
      selectTimeframe,
      toggleVisibility,
      setLayerVisibility,
      toggleSmcOverlays,
      setAllVisibility,
      focusChartObject,
      refreshSnapshot,
      refreshMtf,
      updateSettings,
      refreshAlerts,
      setAlertsEnabled,
      updateAlertRules,
      resetAlertRules,
      clearAlertHistory,
      triggerTestAlert,
      setDealingRangeLookback,
      signals,
      signalDiagnostics,
      signalPerformance,
      signalSettings,
      signalNotifications,
      evaluatingSignals,
      evaluateSignals,
      refreshSignals,
      cancelSignal,
      deleteSignal,
      deleteSignalsBulk,
      clearSignals,
      updateSignalSettings,
      liveStrategyBasket,
      updateLiveStrategyBasket,
      removeBasketItem,
      armBestStrategies,
      clearLiveStrategyBasket,
      discoveryProgress,
      journalEntries,
      paperPositions,
      paperOrders,
      riskSnapshot,
      mt5Status,
      mt5ExecutionSettings,
      mt5ManagedTrades,
      mt5Commands,
      refreshJournal,
      refreshMt5Status,
      refreshMt5Execution,
      updateMt5ExecutionSettings,
      executeMt5Trade,
      moveMt5TradeToBreakeven,
      trailMt5TradeToTp1,
      closeMt5Trade,
      closeAllMt5Trades,
      cancelMt5Command,
      refreshPaperState,
      executePaperTrade,
      closePaperPosition,
      resetPaperAccount,
      updateRiskSettings,
    ]
  );

  return <TerminalContext.Provider value={contextValue}>{children}</TerminalContext.Provider>;
}

export function useTerminal() {
  const ctx = useContext(TerminalContext);
  if (!ctx) throw new Error('useTerminal must be used inside TerminalProvider');
  return ctx;
}
