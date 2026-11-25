import {
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Database,
  Filter,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SIGNAL_SETTINGS,
  getInstrumentMeta,
  INSTRUMENTS,
} from '../../shared/constants/index.ts';
import { deriveProductionAudit } from '../../shared/production-audit.ts';
import type {
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  DiscoveryRunSummary,
  DiscoveryScanRun,
  InstrumentSymbol,
  LiveStrategyBasketSlot,
  MarketRegimeType,
  ProductionReadinessStatus,
  SignalDeleteScope,
  SignalSettings,
  StrategyDiscoveryCombination,
  Timeframe,
  TradingSignal,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import { SignalCard } from './SignalCard.tsx';
import { StrategyManagerDashboard } from './StrategyManagerDashboard.tsx';

export type SignalCenterTab =
  | 'active'
  | 'manager'
  | 'strategies'
  | 'scanner'
  | 'history'
  | 'performance'
  | 'settings';
type HistoryStateFilter = 'ALL' | 'OPEN' | 'TP_HIT' | 'STOPPED' | 'CLOSED_OTHER' | 'WATCHING';
type StrategyBrowserSource = 'discovery' | 'catalog';
type BuilderReadinessFilter = 'ALL' | 'HIDE_OVERFIT' | ProductionReadinessStatus;

const TERMINAL_STATES = new Set(['TP3_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'CANCELLED']);
const TP_STATES = new Set(['TP1_HIT', 'TP2_HIT', 'TP3_HIT']);
const OTHER_CLOSED_STATES = new Set(['INVALIDATED', 'EXPIRED', 'CANCELLED']);
const BUILDER_TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '30m', '1H', '4H', '1D'];
const BUILDER_CATEGORIES: Array<'ALL' | BacktestStrategyCategory> = [
  'ALL',
  'SMC',
  'Price Action',
  'Chart Patterns',
  'Support & Resistance',
  'Hybrid SMC/PA',
];
const BUILDER_REGIMES: Array<'ALL' | MarketRegimeType> = [
  'ALL',
  'Trending',
  'Ranging',
  'High Volatility',
  'Low Volatility',
  'Transitional',
];

function resolveHtfForTf(tf: Timeframe): Timeframe {
  if (tf === '1m' || tf === '5m' || tf === '15m' || tf === '30m') return '1H';
  if (tf === '1H') return '4H';
  return '1D';
}

function readinessColorClass(readiness: ProductionReadinessStatus): string {
  switch (readiness) {
    case 'Production Ready':
      return 'text-[#0ECB81]';
    case 'Verify Paper':
      return 'text-[#F59E0B]';
    case 'Overfit / Decayed':
      return 'text-[#F6465D]';
    default:
      return 'text-[#8B949E]';
  }
}

export function SignalCenterModal({
  onClose,
  initialTab = 'active',
}: {
  onClose: () => void;
  initialTab?: SignalCenterTab;
}) {
  const {
    symbol,
    timeframe,
    signals,
    signalDiagnostics,
    signalPerformance,
    signalSettings,
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
    selectSymbol,
    selectTimeframe,
    focusChartObject,
    timezone,
  } = useTerminal();

  const [tab, setTab] = useState<SignalCenterTab>(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const [filterSymbol, setFilterSymbol] = useState<'ALL' | InstrumentSymbol>('ALL');
  const [filterDirection, setFilterDirection] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [historyStateFilter, setHistoryStateFilter] = useState<HistoryStateFilter>('ALL');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmRowDeleteId, setConfirmRowDeleteId] = useState<string | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<
    null | { kind: 'selected' } | { kind: 'scope'; scope: SignalDeleteScope }
  >(null);
  const [deletingDb, setDeletingDb] = useState(false);
  const [draftSettings, setDraftSettings] = useState<SignalSettings>(() =>
    structuredClone(signalSettings)
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [armingBest, setArmingBest] = useState(false);
  const [basketFeedback, setBasketFeedback] = useState<string | null>(null);

  // Strategy Filters tab state
  const [browserSource, setBrowserSource] = useState<StrategyBrowserSource>('discovery');
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeDiscoveryRun, setActiveDiscoveryRun] = useState<DiscoveryScanRun | null>(null);
  const [loadingDiscoveryData, setLoadingDiscoveryData] = useState(false);
  const [catalogStrategies, setCatalogStrategies] = useState<BacktestStrategyDefinition[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const [stratFilterSymbol, setStratFilterSymbol] = useState<'ALL' | InstrumentSymbol>('ALL');
  const [stratFilterTf, setStratFilterTf] = useState<'ALL' | Timeframe>('ALL');
  const [stratFilterCategory, setStratFilterCategory] = useState<'ALL' | BacktestStrategyCategory>(
    'ALL'
  );
  const [stratFilterRegime, setStratFilterRegime] = useState<'ALL' | MarketRegimeType>('ALL');
  const [stratFilterReadiness, setStratFilterReadiness] =
    useState<BuilderReadinessFilter>('HIDE_OVERFIT');
  const [stratMinWinRate, setStratMinWinRate] = useState<number>(0);
  const [stratMinPf, setStratMinPf] = useState<number>(0);
  const [stratMinOosScore, setStratMinOosScore] = useState<number>(0);
  const [stratSearch, setStratSearch] = useState<string>('');
  const [selectedComboKeys, setSelectedComboKeys] = useState<string[]>([]);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<BacktestStrategyId[]>([]);
  const [catalogTargetSymbols, setCatalogTargetSymbols] = useState<InstrumentSymbol[]>([symbol]);
  const [catalogTargetTfs, setCatalogTargetTfs] = useState<Timeframe[]>([
    BUILDER_TIMEFRAMES.includes(timeframe) ? timeframe : '15m',
  ]);
  const [visibleBuilderLimit, setVisibleBuilderLimit] = useState<number>(50);
  const [savingBasketAction, setSavingBasketAction] = useState<string | null>(null);
  const [togglingGate, setTogglingGate] = useState<string | null>(null);

  useEffect(() => {
    setDraftSettings(structuredClone(signalSettings));
  }, [signalSettings]);

  const loadDiscoveryRuns = useCallback(async (preferredRunId?: string) => {
    setLoadingDiscoveryData(true);
    try {
      const res = await apiFetch('/api/discovery/runs');
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: DiscoveryRunSummary[] };
      const runs = Array.isArray(data.runs) ? data.runs : [];
      setDiscoveryRuns(runs);
      const targetId =
        preferredRunId && runs.some((r) => r.id === preferredRunId)
          ? preferredRunId
          : runs[0]?.id ?? null;
      setSelectedRunId(targetId);
      if (targetId) {
        const detailRes = await apiFetch(`/api/discovery/runs/${encodeURIComponent(targetId)}`);
        if (detailRes.ok) {
          const runData = (await detailRes.json()) as DiscoveryScanRun;
          setActiveDiscoveryRun(runData);
        }
      } else {
        setActiveDiscoveryRun(null);
      }
    } finally {
      setLoadingDiscoveryData(false);
    }
  }, []);

  const loadCatalogStrategies = useCallback(async () => {
    if (catalogStrategies.length > 0) return;
    setLoadingCatalog(true);
    try {
      const res = await apiFetch('/api/backtest/strategies');
      if (res.ok) {
        const data = (await res.json()) as { strategies?: BacktestStrategyDefinition[] };
        if (Array.isArray(data.strategies)) {
          setCatalogStrategies(data.strategies);
        }
      }
    } finally {
      setLoadingCatalog(false);
    }
  }, [catalogStrategies.length]);

  useEffect(() => {
    if (tab !== 'strategies') return;
    void loadDiscoveryRuns(selectedRunId ?? undefined);
    void loadCatalogStrategies();
  }, [tab, loadDiscoveryRuns, loadCatalogStrategies, selectedRunId]);

  useEffect(() => {
    if (tab === 'strategies' && discoveryProgress.status === 'completed' && discoveryProgress.runId) {
      void loadDiscoveryRuns(discoveryProgress.runId);
    }
  }, [tab, discoveryProgress.status, discoveryProgress.runId, loadDiscoveryRuns]);

  const handleSelectDiscoveryRun = async (runId: string) => {
    setSelectedRunId(runId);
    setSelectedComboKeys([]);
    setLoadingDiscoveryData(true);
    try {
      const res = await apiFetch(`/api/discovery/runs/${encodeURIComponent(runId)}`);
      if (res.ok) {
        const runData = (await res.json()) as DiscoveryScanRun;
        setActiveDiscoveryRun(runData);
      }
    } finally {
      setLoadingDiscoveryData(false);
    }
  };

  const armedSlots = useMemo<LiveStrategyBasketSlot[]>(() => {
    if (!liveStrategyBasket) return [];
    if (Array.isArray(liveStrategyBasket.assignments) && liveStrategyBasket.assignments.length > 0) {
      return liveStrategyBasket.assignments;
    }
    if (liveStrategyBasket.strategies.length > 0) {
      return [
        {
          symbol: liveStrategyBasket.symbol,
          timeframe: liveStrategyBasket.timeframe,
          htfTimeframe: liveStrategyBasket.htfTimeframe,
          strategies: liveStrategyBasket.strategies,
          sourceRunId: liveStrategyBasket.sourceRunId,
        },
      ];
    }
    return [];
  }, [liveStrategyBasket]);

  const isStrategyArmed = useCallback(
    (sym: InstrumentSymbol, tf: Timeframe, strategyId: BacktestStrategyId): boolean => {
      return armedSlots.some(
        (slot) =>
          slot.symbol === sym &&
          slot.timeframe === tf &&
          slot.strategies.some((s) => s.id === strategyId)
      );
    },
    [armedSlots]
  );

  const filteredDiscoveryItems = useMemo(() => {
    if (!activeDiscoveryRun) return [];
    const q = stratSearch.trim().toLowerCase();
    return activeDiscoveryRun.combinations
      .map((combo) => ({
        combo,
        audit: deriveProductionAudit(combo),
      }))
      .filter(({ combo, audit }) => {
        if (stratFilterSymbol !== 'ALL' && combo.symbol !== stratFilterSymbol) return false;
        if (stratFilterTf !== 'ALL' && combo.timeframe !== stratFilterTf) return false;
        if (stratFilterCategory !== 'ALL' && combo.strategy.category !== stratFilterCategory)
          return false;
        if (stratFilterRegime !== 'ALL' && combo.regime !== stratFilterRegime) return false;
        if (stratFilterReadiness === 'HIDE_OVERFIT') {
          if (audit.readiness === 'Overfit / Decayed' || audit.readiness === 'Not Ready') {
            return false;
          }
        } else if (stratFilterReadiness !== 'ALL' && audit.readiness !== stratFilterReadiness) {
          return false;
        }
        if (combo.oosMetrics.winRate < stratMinWinRate) return false;
        if (stratMinPf > 0 && (combo.oosMetrics.profitFactor ?? 0) < stratMinPf) return false;
        if (combo.oosScore < stratMinOosScore) return false;
        if (q.length > 0) {
          const hay =
            `${combo.strategy.name} ${combo.strategy.id} ${combo.strategy.category} ${combo.symbol} ${combo.timeframe} ${combo.regime}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const readinessRank = (r: ProductionReadinessStatus) =>
          r === 'Production Ready' ? 3 : r === 'Verify Paper' ? 2 : r === 'Not Ready' ? 1 : 0;
        const diff = readinessRank(b.audit.readiness) - readinessRank(a.audit.readiness);
        if (diff !== 0) return diff;
        if (b.combo.oosScore !== a.combo.oosScore) return b.combo.oosScore - a.combo.oosScore;
        return b.combo.oosMetrics.expectancyR - a.combo.oosMetrics.expectancyR;
      });
  }, [
    activeDiscoveryRun,
    stratSearch,
    stratFilterSymbol,
    stratFilterTf,
    stratFilterCategory,
    stratFilterRegime,
    stratFilterReadiness,
    stratMinWinRate,
    stratMinPf,
    stratMinOosScore,
  ]);

  const filteredCatalogItems = useMemo(() => {
    const q = stratSearch.trim().toLowerCase();
    return catalogStrategies.filter((s) => {
      if (stratFilterCategory !== 'ALL' && s.category !== stratFilterCategory) return false;
      if (q.length > 0) {
        const hay = `${s.name} ${s.id} ${s.category} ${s.summary}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [catalogStrategies, stratFilterCategory, stratSearch]);

  const addDiscoveryCombosToSignals = async (
    combos: StrategyDiscoveryCombination[],
    mode: 'merge' | 'replace',
    actionKey: string
  ) => {
    if (combos.length === 0) {
      setBasketFeedback('No matching strategies selected to add.');
      return;
    }
    setSavingBasketAction(actionKey);
    setBasketFeedback(null);
    try {
      const slotMap = new Map<string, LiveStrategyBasketSlot>();
      for (const c of combos) {
        const key = `${c.symbol}__${c.timeframe}`;
        const existing = slotMap.get(key);
        const ref = { id: c.strategy.id, name: c.strategy.name, category: c.strategy.category };
        if (!existing) {
          slotMap.set(key, {
            symbol: c.symbol,
            timeframe: c.timeframe,
            htfTimeframe: c.htfTimeframe,
            strategies: [ref],
            sourceRunId: activeDiscoveryRun?.id,
            bestRegime: c.regime,
            poorRegimes: (c.poorRegimes ?? []).map((p) => p.regime),
            avoidSessions: c.avoidSessions,
            oosWinRate: c.oosMetrics.winRate,
            oosProfitFactor: c.oosMetrics.profitFactor,
            oosExpectancyR: c.oosMetrics.expectancyR,
            oosScore: c.oosScore,
          });
        } else if (
          !existing.strategies.some((s) => s.id === c.strategy.id) &&
          existing.strategies.length < 10
        ) {
          existing.strategies.push(ref);
        }
      }
      const assignments = Array.from(slotMap.values()).slice(0, 12);
      const strategyIds = Array.from(
        new Set(assignments.flatMap((slot) => slot.strategies.map((s) => s.id)))
      );
      const lead = assignments[0];
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: lead.symbol,
        timeframe: lead.timeframe,
        htfTimeframe: lead.htfTimeframe,
        strategyIds,
        assignments,
        selectionLabel:
          assignments.length > 1
            ? `${assignments.length} Filtered Slots · ${strategyIds.length} Strategies`
            : `${lead.symbol} ${lead.timeframe} · ${strategyIds.length} Strateg${strategyIds.length === 1 ? 'y' : 'ies'}`,
        maxConcurrentPositions: Math.min(8, Math.max(2, assignments.length)),
        minRiskReward: activeDiscoveryRun?.config.minRiskReward ?? signalSettings.minTp1RiskReward,
        sourceRunId: activeDiscoveryRun?.id,
        mode,
      });
      setSelectedComboKeys([]);
      setBasketFeedback(
        `${mode === 'merge' ? 'Added to' : 'Replaced'} Main Signals: ${basket?.strategies.length ?? strategyIds.length} strategies active across ${basket?.assignments?.length ?? assignments.length} Asset/TF slot(s).`
      );
    } catch (err) {
      setBasketFeedback(err instanceof Error ? err.message : 'Unable to update Main Signals basket');
    } finally {
      setSavingBasketAction(null);
    }
  };

  const addCatalogToSignals = async (
    strategiesToAdd: BacktestStrategyDefinition[],
    mode: 'merge' | 'replace',
    actionKey: string
  ) => {
    if (strategiesToAdd.length === 0) {
      setBasketFeedback('Select at least one strategy to add.');
      return;
    }
    if (catalogTargetSymbols.length === 0 || catalogTargetTfs.length === 0) {
      setBasketFeedback('Pick at least one target Asset and Timeframe.');
      return;
    }
    setSavingBasketAction(actionKey);
    setBasketFeedback(null);
    try {
      const refs = strategiesToAdd.slice(0, 10).map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
      }));
      const assignments: LiveStrategyBasketSlot[] = [];
      for (const sym of catalogTargetSymbols) {
        for (const tf of catalogTargetTfs) {
          if (assignments.length >= 12) break;
          assignments.push({
            symbol: sym,
            timeframe: tf,
            htfTimeframe: resolveHtfForTf(tf),
            strategies: refs,
          });
        }
      }
      const lead = assignments[0];
      const strategyIds = refs.map((r) => r.id);
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: lead.symbol,
        timeframe: lead.timeframe,
        htfTimeframe: lead.htfTimeframe,
        strategyIds,
        assignments,
        selectionLabel: `${assignments.length} Slot(s) · ${refs.length} Catalog Strateg${refs.length === 1 ? 'y' : 'ies'}`,
        maxConcurrentPositions: Math.min(8, Math.max(2, assignments.length)),
        minRiskReward: signalSettings.minTp1RiskReward,
        mode,
      });
      setSelectedCatalogIds([]);
      setBasketFeedback(
        `${mode === 'merge' ? 'Added to' : 'Replaced'} Main Signals: ${basket?.strategies.length ?? refs.length} strategies armed across ${basket?.assignments?.length ?? assignments.length} slot(s).`
      );
    } catch (err) {
      setBasketFeedback(err instanceof Error ? err.message : 'Unable to add catalog strategies');
    } finally {
      setSavingBasketAction(null);
    }
  };

  const handleLaunchQuickDiscovery = async () => {
    setSavingBasketAction('quick_scan');
    setBasketFeedback(null);
    try {
      const res = await apiFetch('/api/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: ['XAUUSD', 'XAGUSD', 'BTCUSDT', 'ETHUSDT'],
          timeframes: ['15m', '1H', '4H'],
          barsPerTimeframe: 600,
          strategyScope: 'core',
          minOosTradesForValidation: 3,
          minTotalSampleForValidation: 8,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setBasketFeedback(err.error || 'Unable to start Discovery scan');
      } else {
        setBasketFeedback('Discovery scan started — results will load automatically as soon as it finishes.');
      }
    } finally {
      setSavingBasketAction(null);
    }
  };

  const handleQuickSettingToggle = async (
    key: 'allowDefaultSignals' | 'requireRegimeCompatibility' | 'requireHtfAlignmentForStrategy' | 'requireOrderBlock' | 'requireFairValueGap' | 'requireLiquiditySweep'
  ) => {
    setTogglingGate(key);
    try {
      if (key === 'allowDefaultSignals') {
        await updateSignalSettings({ allowDefaultSignals: !signalSettings.allowDefaultSignals });
      } else if (key === 'requireRegimeCompatibility') {
        await updateSignalSettings({
          requireRegimeCompatibility: !signalSettings.requireRegimeCompatibility,
        });
      } else if (key === 'requireHtfAlignmentForStrategy') {
        await updateSignalSettings({
          requireHtfAlignmentForStrategy: !signalSettings.requireHtfAlignmentForStrategy,
        });
      } else {
        const current = signalSettings.smcCriteria ?? DEFAULT_SIGNAL_SETTINGS.smcCriteria;
        await updateSignalSettings({
          smcCriteria: {
            ...current,
            [key]: !current[key],
          },
        });
      }
    } catch (err) {
      setBasketFeedback(err instanceof Error ? err.message : 'Failed to update signal filter rule');
    } finally {
      setTogglingGate(null);
    }
  };

  const activeSignals = useMemo(
    () =>
      signals.filter((s) => {
        if (!signalSettings.allowDefaultSignals && s.source !== 'strategy_basket') return false;
        if (TERMINAL_STATES.has(s.state)) return false;
        if (filterSymbol !== 'ALL' && s.symbol !== filterSymbol) return false;
        if (filterDirection !== 'ALL' && s.direction !== filterDirection) return false;
        return true;
      }),
    [signals, signalSettings.allowDefaultSignals, filterSymbol, filterDirection]
  );

  const historicalSignals = useMemo(
    () =>
      signals.filter((s) => {
        if (!signalSettings.allowDefaultSignals && s.source !== 'strategy_basket') return false;
        if (filterSymbol !== 'ALL' && s.symbol !== filterSymbol) return false;
        if (filterDirection !== 'ALL' && s.direction !== filterDirection) return false;
        if (historyStateFilter === 'OPEN' && (TERMINAL_STATES.has(s.state) || s.state === 'WATCHING')) {
          return false;
        }
        if (historyStateFilter === 'TP_HIT' && !TP_STATES.has(s.state)) {
          return false;
        }
        if (historyStateFilter === 'STOPPED' && s.state !== 'STOPPED') {
          return false;
        }
        if (historyStateFilter === 'CLOSED_OTHER' && !OTHER_CLOSED_STATES.has(s.state)) {
          return false;
        }
        if (historyStateFilter === 'WATCHING' && s.state !== 'WATCHING') {
          return false;
        }
        return true;
      }),
    [
      signals,
      signalSettings.allowDefaultSignals,
      filterSymbol,
      filterDirection,
      historyStateFilter,
    ]
  );

  const visibleIds = useMemo(() => historicalSignals.map((s) => s.id), [historicalSignals]);
  const selectedVisibleCount = useMemo(
    () => selectedIds.filter((id) => visibleIds.includes(id)).length,
    [selectedIds, visibleIds]
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSingleDelete = async (id: string) => {
    setDeletingDb(true);
    try {
      await deleteSignal(id);
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      if (expandedId === id) setExpandedId(null);
      if (confirmRowDeleteId === id) setConfirmRowDeleteId(null);
    } finally {
      setDeletingDb(false);
    }
  };

  const handleExecutePendingDelete = async () => {
    if (!pendingBulkAction) return;
    setDeletingDb(true);
    try {
      if (pendingBulkAction.kind === 'selected') {
        const targets = selectedIds.filter((id) => visibleIds.includes(id));
        await deleteSignalsBulk(targets);
        setSelectedIds((prev) => prev.filter((id) => !targets.includes(id)));
      } else {
        await clearSignals(pendingBulkAction.scope);
        setSelectedIds([]);
      }
      setExpandedId(null);
      setPendingBulkAction(null);
    } finally {
      setDeletingDb(false);
    }
  };

  const handleFocusOnChart = (sig: TradingSignal) => {
    if (sig.symbol !== symbol) {
      selectSymbol(sig.symbol);
    }
    selectTimeframe(sig.entryTimeframe);
    const nowSec = Math.floor(Date.now() / 1000);
    focusChartObject(sig.id, sig.candleTime - 3600, Math.max(sig.candleTime + 1800, nowSec));
    onClose();
  };

  const fmtTime = (ms: number | null) => {
    if (!ms) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  };

  const weightTotal =
    draftSettings.weights.htfAlignment +
    draftSettings.weights.liquiditySweep +
    draftSettings.weights.structureConfirmation +
    draftSettings.weights.obFvgConfluence +
    draftSettings.weights.premiumDiscount +
    draftSettings.weights.volumeMomentum +
    draftSettings.weights.riskRewardQuality;

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await updateSignalSettings(draftSettings);
    } finally {
      setSavingSettings(false);
    }
  };

  const tabs: Array<{ id: SignalCenterTab; label: string }> = [
    { id: 'active', label: `Active Signals (${activeSignals.length})` },
    { id: 'manager', label: `Strategy Manager (${liveStrategyBasket?.strategies.length ?? 0})` },
    { id: 'strategies', label: 'Filter & Add Strategies' },
    { id: 'scanner', label: 'Scanner & Rejections (4)' },
    { id: 'history', label: `Saved Signals (${historicalSignals.length})` },
    { id: 'performance', label: 'Performance' },
    { id: 'settings', label: 'Signal Settings' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col border border-[#2B3548] bg-[#12161F]">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#E6EDF3]">
              Institutional BUY / SELL Signal Center
            </h2>
            <p className="text-xs text-[#8B949E]">
              Multi-timeframe SMC scoring (1D · 4H · 1H · 15m · 5m) · Closed-candle confirmation · Zero simulated outcomes
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void evaluateSignals()}
              disabled={evaluatingSignals}
              className="flex items-center gap-1.5 border border-[#2B3548] bg-[#161B26] px-3 py-1.5 text-xs font-medium text-[#38BDF8] hover:border-[#38BDF8] hover:bg-[#1C2331] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${evaluatingSignals ? 'animate-spin' : ''}`} />
              <span>{evaluatingSignals ? 'Scanning...' : 'Scan All 4 Instruments'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Signal Center"
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Navigation & Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] bg-[#0B0E14] px-4 py-2">
          <div className="flex items-center gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  tab === t.id
                    ? 'bg-[#1C2331] text-[#38BDF8]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {(tab === 'active' || tab === 'history') && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {tab === 'history' && (
                <select
                  aria-label="Filter signal state"
                  value={historyStateFilter}
                  onChange={(e) => setHistoryStateFilter(e.target.value as HistoryStateFilter)}
                  className="border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none cursor-pointer"
                >
                  <option value="ALL">All States ({signals.length})</option>
                  <option value="OPEN">Open / Confirmed / Active</option>
                  <option value="TP_HIT">Targets Hit (TP1–TP3)</option>
                  <option value="STOPPED">Stopped Out</option>
                  <option value="CLOSED_OTHER">Cancelled / Expired / Invalid</option>
                  <option value="WATCHING">Provisional Watching</option>
                </select>
              )}
              <select
                aria-label="Filter signal symbol"
                value={filterSymbol}
                onChange={(e) => setFilterSymbol(e.target.value as 'ALL' | InstrumentSymbol)}
                className="border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none cursor-pointer"
              >
                <option value="ALL">All Instruments</option>
                {INSTRUMENTS.map((i) => (
                  <option key={i.symbol} value={i.symbol}>
                    {i.symbol}
                  </option>
                ))}
              </select>
              <div className="flex items-center border border-[#222938] bg-[#12161F]">
                {(['ALL', 'BUY', 'SELL'] as const).map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => setFilterDirection(dir)}
                    className={`px-2.5 py-1 font-mono text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                      filterDirection === dir
                        ? 'bg-[#1C2331] text-[#38BDF8]'
                        : 'text-[#8B949E] hover:text-[#E6EDF3]'
                    }`}
                  >
                    {dir}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Main Content Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {(tab === 'active' || tab === 'scanner') && liveStrategyBasket && (
            <div
              className={`mb-3 flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs ${
                liveStrategyBasket.enabled
                  ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10'
                  : 'border-[#F59E0B]/50 bg-[#F59E0B]/10'
              }`}
            >
              <div className="flex items-start gap-2 min-w-0">
                <Radio
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                    liveStrategyBasket.enabled ? 'text-[#0ECB81]' : 'text-[#F59E0B]'
                  }`}
                />
                <div className="min-w-0">
                  <div className="font-mono text-[11px] font-semibold text-[#E6EDF3] tabular-nums">
                    Auto-Running Strategy Basket ({liveStrategyBasket.enabled ? 'ACTIVE' : 'PAUSED'}) ·{' '}
                    {liveStrategyBasket.assignments && liveStrategyBasket.assignments.length > 1
                      ? `${liveStrategyBasket.assignments.length} Asset/TF Slots`
                      : `${liveStrategyBasket.symbol} ${liveStrategyBasket.timeframe}`}{' '}
                    · {liveStrategyBasket.strategies.length} Uncorrelated Strategies · Cap{' '}
                    {liveStrategyBasket.maxConcurrentPositions} Open ·{' '}
                    {liveStrategyBasket.emittedSignalCount} Emitted
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[#C9D1D9]">
                    {liveStrategyBasket.selectionLabel
                      ? `${liveStrategyBasket.selectionLabel} — `
                      : ''}
                    {liveStrategyBasket.strategies.map((s) => s.name).join(' · ')}
                  </div>
                  {liveStrategyBasket.lastStatusNote && (
                    <div className="mt-0.5 font-mono text-[10px] text-[#8B949E]">
                      {liveStrategyBasket.lastStatusNote}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    void updateLiveStrategyBasket({
                      enabled: !liveStrategyBasket.enabled,
                      symbol: liveStrategyBasket.symbol,
                      timeframe: liveStrategyBasket.timeframe,
                      htfTimeframe: liveStrategyBasket.htfTimeframe,
                      strategyIds: liveStrategyBasket.strategies.map((s) => s.id),
                      assignments: liveStrategyBasket.assignments,
                      filters: liveStrategyBasket.filters,
                      selectionLabel: liveStrategyBasket.selectionLabel,
                      maxConcurrentPositions: liveStrategyBasket.maxConcurrentPositions,
                      minRiskReward: liveStrategyBasket.minRiskReward,
                      sourceRunId: liveStrategyBasket.sourceRunId,
                    })
                  }
                  className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#E6EDF3] hover:border-[#38BDF8] cursor-pointer"
                >
                  {liveStrategyBasket.enabled ? (
                    <>
                      <Pause className="h-3 w-3 text-[#F59E0B]" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3 text-[#0ECB81]" />
                      <span>Resume</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setTab('strategies')}
                  className="flex items-center gap-1 border border-[#38BDF8]/60 bg-[#161B26] px-2.5 py-1 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                >
                  <Filter className="h-3 w-3" />
                  <span>Filter & Add</span>
                </button>
                <button
                  type="button"
                  onClick={() => void clearLiveStrategyBasket()}
                  className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              </div>
            </div>
          )}

          {basketFeedback && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-[#38BDF8]/50 bg-[#0B0E14] px-3 py-2 text-xs text-[#C9D1D9]">
              <span>{basketFeedback}</span>
              <div className="flex items-center gap-3">
                {tab === 'strategies' && (
                  <button
                    type="button"
                    onClick={() => setTab('active')}
                    className="font-semibold text-[#0ECB81] hover:underline cursor-pointer"
                  >
                    View Active Signals ({activeSignals.length}) →
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setBasketFeedback(null)}
                  className="text-[11px] underline text-[#8B949E] hover:text-white cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {tab === 'active' && (
            <div className="space-y-3">
              {activeSignals.length === 0 ? (
                <div className="border border-[#222938] bg-[#0B0E14] p-6 text-center">
                  <div className="text-sm font-medium text-[#E6EDF3]">
                    {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals
                      ? 'Strategy-Only Mode Active — No Strategies Armed Yet'
                      : 'No Active BUY / SELL Signals (NO TRADE)'}
                  </div>
                  <p className="mt-1 text-xs text-[#8B949E]">
                    {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals
                      ? 'Filter and add validated strategies to Main Signals, or load best-performing strategies automatically.'
                      : `Strict accuracy filters active: closed candles, market regime compatibility, Confluence ≥ ${signalSettings.minStrategyConfluenceScore}, and minimum 1:${signalSettings.minTp1RiskReward} R:R.`}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTab('strategies')}
                      className="flex items-center gap-1.5 border border-[#38BDF8] bg-[#38BDF8]/15 px-3.5 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                    >
                      <Filter className="h-3.5 w-3.5" />
                      <span>Filter &amp; Add Strategies</span>
                    </button>
                    {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals && (
                      <button
                        type="button"
                        disabled={armingBest}
                        onClick={async () => {
                          setArmingBest(true);
                          try {
                            const res = await armBestStrategies({
                              readinessMode: 'INCLUDE_VERIFY_PAPER',
                              avoidPoorRegimes: true,
                              requireHtfAlignment: true,
                              autoScanIfEmpty: true,
                            });
                            setBasketFeedback(res.message);
                          } finally {
                            setArmingBest(false);
                          }
                        }}
                        className="border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                      >
                        {armingBest ? 'Arming Best...' : 'Auto-Arm Best Strategies'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTab('scanner')}
                      className="border border-[#2B3548] bg-[#161B26] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                    >
                      Inspect Rejections
                    </button>
                    <button
                      type="button"
                      onClick={() => void evaluateSignals()}
                      className="bg-[#38BDF8] px-3 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#7DD3FC] cursor-pointer"
                    >
                      Scan Now
                    </button>
                  </div>
                </div>
              ) : (
                activeSignals.map((sig) => (
                  <SignalCard
                    key={sig.id}
                    signal={sig}
                    timezone={timezone}
                    onFocusOnChart={handleFocusOnChart}
                    onCancel={(id) => void cancelSignal(id)}
                    onDelete={(id) => void handleSingleDelete(id)}
                  />
                ))
              )}
            </div>
          )}

          {tab === 'manager' && (
            <StrategyManagerDashboard
              variant="modal"
              onOpenFilterStrategies={() => setTab('strategies')}
              onOpenMainSignals={() => setTab('active')}
              onSwitchToChart={() => onClose()}
            />
          )}

          {tab === 'strategies' && (
            <div className="space-y-4">
              {/* 1. Currently Armed Slots & Live Signal Rules */}
              <div className="border border-[#222938] bg-[#0B0E14] p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2.5">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#E6EDF3]">
                      <ShieldCheck className="h-3.5 w-3.5 text-[#0ECB81]" />
                      <span>
                        Main Signals Strategy Basket (
                        {armedSlots.length === 0
                          ? 'Empty'
                          : liveStrategyBasket?.enabled
                            ? 'ACTIVE'
                            : 'PAUSED'}
                        )
                      </span>
                      {armedSlots.length > 0 && (
                        <span className="font-mono text-[11px] text-[#38BDF8] tabular-nums">
                          · {armedSlots.length} Slot{armedSlots.length === 1 ? '' : 's'} ·{' '}
                          {liveStrategyBasket?.strategies.length ?? 0} Unique Strategies
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      Add filtered strategies from one or multiple assets/timeframes below. Added strategies merge cleanly without erasing existing slots.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={armingBest}
                      onClick={async () => {
                        setArmingBest(true);
                        try {
                          const res = await armBestStrategies({
                            readinessMode: 'INCLUDE_VERIFY_PAPER',
                            avoidPoorRegimes: true,
                            requireHtfAlignment: true,
                            autoScanIfEmpty: true,
                          });
                          setBasketFeedback(res.message);
                        } finally {
                          setArmingBest(false);
                        }
                      }}
                      className="flex items-center gap-1 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2.5 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                    >
                      <ShieldCheck className="h-3 w-3" />
                      <span>{armingBest ? 'Loading Best...' : 'Auto-Arm Best'}</span>
                    </button>
                    {liveStrategyBasket && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void updateLiveStrategyBasket({
                              enabled: !liveStrategyBasket.enabled,
                              symbol: liveStrategyBasket.symbol,
                              timeframe: liveStrategyBasket.timeframe,
                              htfTimeframe: liveStrategyBasket.htfTimeframe,
                              strategyIds: liveStrategyBasket.strategies.map((s) => s.id),
                              assignments: liveStrategyBasket.assignments,
                              filters: liveStrategyBasket.filters,
                              selectionLabel: liveStrategyBasket.selectionLabel,
                              maxConcurrentPositions: liveStrategyBasket.maxConcurrentPositions,
                              minRiskReward: liveStrategyBasket.minRiskReward,
                              sourceRunId: liveStrategyBasket.sourceRunId,
                            })
                          }
                          className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#E6EDF3] hover:border-[#38BDF8] cursor-pointer"
                        >
                          {liveStrategyBasket.enabled ? (
                            <>
                              <Pause className="h-3 w-3 text-[#F59E0B]" />
                              <span>Pause</span>
                            </>
                          ) : (
                            <>
                              <Play className="h-3 w-3 text-[#0ECB81]" />
                              <span>Resume</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void clearLiveStrategyBasket()}
                          className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Clear All</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Quick Signal Source & SMC Gate Toggles */}
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-[#8B949E] mr-1">Signal Gates:</span>
                  <button
                    type="button"
                    disabled={togglingGate === 'allowDefaultSignals'}
                    onClick={() => void handleQuickSettingToggle('allowDefaultSignals')}
                    className={`border px-2.5 py-1 font-mono cursor-pointer ${
                      signalSettings.allowDefaultSignals
                        ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                        : 'border-[#0ECB81]/60 bg-[#0ECB81]/10 text-[#0ECB81]'
                    }`}
                  >
                    {signalSettings.allowDefaultSignals
                      ? 'Source: Strategies + Core SMC Scanner'
                      : 'Source: Armed Strategies Only'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingGate === 'requireRegimeCompatibility'}
                    onClick={() => void handleQuickSettingToggle('requireRegimeCompatibility')}
                    className={`border px-2 py-1 font-mono cursor-pointer ${
                      signalSettings.requireRegimeCompatibility
                        ? 'border-[#0ECB81]/60 bg-[#0ECB81]/10 text-[#0ECB81]'
                        : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                    }`}
                  >
                    Regime Match {signalSettings.requireRegimeCompatibility ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingGate === 'requireHtfAlignmentForStrategy'}
                    onClick={() => void handleQuickSettingToggle('requireHtfAlignmentForStrategy')}
                    className={`border px-2 py-1 font-mono cursor-pointer ${
                      signalSettings.requireHtfAlignmentForStrategy
                        ? 'border-[#0ECB81]/60 bg-[#0ECB81]/10 text-[#0ECB81]'
                        : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                    }`}
                  >
                    HTF Align {signalSettings.requireHtfAlignmentForStrategy ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingGate === 'requireOrderBlock'}
                    onClick={() => void handleQuickSettingToggle('requireOrderBlock')}
                    className={`border px-2 py-1 font-mono cursor-pointer ${
                      signalSettings.smcCriteria?.requireOrderBlock
                        ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                        : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                    }`}
                  >
                    OB Gate {signalSettings.smcCriteria?.requireOrderBlock ? 'REQ' : 'OPT'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingGate === 'requireFairValueGap'}
                    onClick={() => void handleQuickSettingToggle('requireFairValueGap')}
                    className={`border px-2 py-1 font-mono cursor-pointer ${
                      signalSettings.smcCriteria?.requireFairValueGap
                        ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                        : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                    }`}
                  >
                    FVG Gate {signalSettings.smcCriteria?.requireFairValueGap ? 'REQ' : 'OPT'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingGate === 'requireLiquiditySweep'}
                    onClick={() => void handleQuickSettingToggle('requireLiquiditySweep')}
                    className={`border px-2 py-1 font-mono cursor-pointer ${
                      signalSettings.smcCriteria?.requireLiquiditySweep
                        ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                        : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                    }`}
                  >
                    Sweep Gate {signalSettings.smcCriteria?.requireLiquiditySweep ? 'REQ' : 'OPT'}
                  </button>
                </div>

                {/* Armed Slots Grid */}
                {armedSlots.length === 0 ? (
                  <div className="border border-dashed border-[#2B3548] bg-[#12161F] px-4 py-4 text-center text-xs text-[#8B949E]">
                    No strategies are currently armed in Main Signals. Use the filters below to select and add strategies.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {armedSlots.map((slot) => (
                      <div
                        key={`${slot.symbol}_${slot.timeframe}`}
                        className="border border-[#222938] bg-[#12161F] p-2.5 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 border-b border-[#1D2432] pb-1.5">
                          <div className="font-mono text-xs font-semibold text-[#E6EDF3] tabular-nums">
                            {slot.symbol} <span className="text-[#38BDF8]">{slot.timeframe}</span>
                            <span className="ml-2 text-[10px] font-normal text-[#8B949E]">
                              HTF {slot.htfTimeframe}
                              {slot.oosWinRate !== undefined ? ` · ${slot.oosWinRate.toFixed(0)}% Win` : ''}
                              {slot.oosScore !== undefined ? ` · Score ${slot.oosScore.toFixed(0)}` : ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => void removeBasketItem(slot.symbol, slot.timeframe)}
                            className="text-[10px] text-[#8B949E] hover:text-[#F6465D] cursor-pointer"
                          >
                            Remove Slot
                          </button>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {slot.strategies.map((strat) => (
                            <div
                              key={strat.id}
                              className="inline-flex items-center gap-1.5 border border-[#2B3548] bg-[#0B0E14] px-2 py-1 text-[11px] text-[#C9D1D9]"
                            >
                              <span className="truncate max-w-[200px]">{strat.name}</span>
                              <button
                                type="button"
                                aria-label={`Remove ${strat.name}`}
                                onClick={() =>
                                  void removeBasketItem(slot.symbol, slot.timeframe, strat.id)
                                }
                                className="text-[#8B949E] hover:text-[#F6465D] cursor-pointer"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 2. Strategy Filter & Add Builder */}
              <div className="border border-[#222938] bg-[#0B0E14] p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[#E6EDF3]">
                      Filter &amp; Add Strategies to Main Signals
                    </span>
                    <div className="flex items-center border border-[#222938] bg-[#12161F]">
                      <button
                        type="button"
                        onClick={() => setBrowserSource('discovery')}
                        className={`px-2.5 py-1 text-[11px] cursor-pointer ${
                          browserSource === 'discovery'
                            ? 'bg-[#1C2331] font-semibold text-[#38BDF8]'
                            : 'text-[#8B949E] hover:text-white'
                        }`}
                      >
                        Validated Discovery ({activeDiscoveryRun?.combinations.length ?? 0})
                      </button>
                      <button
                        type="button"
                        onClick={() => setBrowserSource('catalog')}
                        className={`px-2.5 py-1 text-[11px] cursor-pointer ${
                          browserSource === 'catalog'
                            ? 'bg-[#1C2331] font-semibold text-[#38BDF8]'
                            : 'text-[#8B949E] hover:text-white'
                        }`}
                      >
                        Full Catalog ({catalogStrategies.length})
                      </button>
                    </div>
                  </div>

                  {browserSource === 'discovery' && discoveryRuns.length > 0 && (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[#8B949E]">Discovery Run:</span>
                      <select
                        value={selectedRunId ?? ''}
                        onChange={(e) => void handleSelectDiscoveryRun(e.target.value)}
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[11px] text-[#E6EDF3] outline-none"
                      >
                        {discoveryRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            {new Date(r.createdAt).toLocaleDateString()} · {r.validatedCount} Valid ·{' '}
                            {r.topComboLabel ?? `${r.totalCombinations} combos`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {discoveryProgress.status === 'running' && (
                  <div className="border border-[#38BDF8]/40 bg-[#12161F] px-3 py-2 text-xs">
                    <div className="flex items-center justify-between text-[#38BDF8]">
                      <span>{discoveryProgress.message}</span>
                      <span className="font-mono tabular-nums">
                        {discoveryProgress.completedSteps}/{discoveryProgress.totalSteps}
                      </span>
                    </div>
                  </div>
                )}

                {/* Filter Controls Bar */}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B949E]" />
                    <input
                      type="text"
                      value={stratSearch}
                      onChange={(e) => setStratSearch(e.target.value)}
                      placeholder="Search strategy name..."
                      className="w-44 border border-[#222938] bg-[#12161F] pl-7 pr-2 py-1 text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                    />
                  </div>

                  <select
                    aria-label="Filter strategy category"
                    value={stratFilterCategory}
                    onChange={(e) =>
                      setStratFilterCategory(e.target.value as 'ALL' | BacktestStrategyCategory)
                    }
                    className="border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                  >
                    {BUILDER_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c === 'ALL' ? 'All Categories' : c}
                      </option>
                    ))}
                  </select>

                  {browserSource === 'discovery' && (
                    <>
                      <select
                        aria-label="Filter strategy asset"
                        value={stratFilterSymbol}
                        onChange={(e) =>
                          setStratFilterSymbol(e.target.value as 'ALL' | InstrumentSymbol)
                        }
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                      >
                        <option value="ALL">All Assets</option>
                        {INSTRUMENTS.map((i) => (
                          <option key={i.symbol} value={i.symbol}>
                            {i.symbol}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Filter strategy timeframe"
                        value={stratFilterTf}
                        onChange={(e) => setStratFilterTf(e.target.value as 'ALL' | Timeframe)}
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                      >
                        <option value="ALL">All Timeframes</option>
                        {BUILDER_TIMEFRAMES.map((tf) => (
                          <option key={tf} value={tf}>
                            {tf}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Filter market condition"
                        value={stratFilterRegime}
                        onChange={(e) =>
                          setStratFilterRegime(e.target.value as 'ALL' | MarketRegimeType)
                        }
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                      >
                        {BUILDER_REGIMES.map((r) => (
                          <option key={r} value={r}>
                            {r === 'ALL' ? 'All Conditions' : r}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Filter readiness"
                        value={stratFilterReadiness}
                        onChange={(e) =>
                          setStratFilterReadiness(e.target.value as BuilderReadinessFilter)
                        }
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                      >
                        <option value="HIDE_OVERFIT">Verified &amp; Paper Only</option>
                        <option value="Production Ready">Production Ready Only</option>
                        <option value="Verify Paper">Verify Paper</option>
                        <option value="ALL">All Readiness</option>
                      </select>

                      <label className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E]">
                        <span>Win ≥</span>
                        <input
                          type="number"
                          min={0}
                          max={95}
                          value={stratMinWinRate}
                          onChange={(e) => setStratMinWinRate(Number(e.target.value) || 0)}
                          className="w-11 bg-transparent text-right font-mono text-[#E6EDF3] outline-none"
                        />
                        <span>%</span>
                      </label>

                      <label className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E]">
                        <span>PF ≥</span>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.1}
                          value={stratMinPf}
                          onChange={(e) => setStratMinPf(Number(e.target.value) || 0)}
                          className="w-11 bg-transparent text-right font-mono text-[#E6EDF3] outline-none"
                        />
                      </label>

                      <label className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E]">
                        <span>Score ≥</span>
                        <input
                          type="number"
                          min={0}
                          max={95}
                          value={stratMinOosScore}
                          onChange={(e) => setStratMinOosScore(Number(e.target.value) || 0)}
                          className="w-11 bg-transparent text-right font-mono text-[#E6EDF3] outline-none"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => {
                          setStratFilterSymbol('ALL');
                          setStratFilterTf('ALL');
                          setStratFilterCategory('ALL');
                          setStratFilterRegime('ALL');
                          setStratFilterReadiness('HIDE_OVERFIT');
                          setStratMinWinRate(0);
                          setStratMinPf(0);
                          setStratMinOosScore(0);
                          setStratSearch('');
                        }}
                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E] hover:text-white cursor-pointer"
                      >
                        Reset
                      </button>
                    </>
                  )}
                </div>

                {browserSource === 'discovery' ? (
                  loadingDiscoveryData ? (
                    <div className="py-8 text-center text-xs text-[#8B949E]">
                      Loading validated Discovery strategies...
                    </div>
                  ) : !activeDiscoveryRun ? (
                    <div className="border border-[#222938] bg-[#12161F] p-5 text-center space-y-2.5">
                      <div className="text-xs font-semibold text-[#E6EDF3]">
                        No Discovery Scan Saved Yet
                      </div>
                      <p className="text-[11px] text-[#8B949E] max-w-lg mx-auto">
                        Run a quick historical scan across all 4 instruments to filter tested strategies by Win %, Profit Factor, and Market Condition—or switch to Full Catalog to pick any strategy directly.
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          disabled={
                            savingBasketAction === 'quick_scan' ||
                            discoveryProgress.status === 'running'
                          }
                          onClick={() => void handleLaunchQuickDiscovery()}
                          className="border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                        >
                          {discoveryProgress.status === 'running'
                            ? 'Scanning Historical Data...'
                            : 'Run Quick Discovery Scan'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setBrowserSource('catalog')}
                          className="border border-[#2B3548] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                        >
                          Browse Full Catalog ({catalogStrategies.length})
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Action Bar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border border-[#1D2432] bg-[#12161F] px-3 py-2 text-xs">
                        <div className="font-mono text-[11px] text-[#C9D1D9] tabular-nums">
                          {filteredDiscoveryItems.length} matching strategies
                          {selectedComboKeys.length > 0 && (
                            <span className="ml-2 text-[#38BDF8]">
                              · {selectedComboKeys.length} selected
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {selectedComboKeys.length > 0 && (
                            <button
                              type="button"
                              disabled={savingBasketAction !== null}
                              onClick={() =>
                                void addDiscoveryCombosToSignals(
                                  filteredDiscoveryItems
                                    .filter((x) => selectedComboKeys.includes(x.combo.comboKey))
                                    .map((x) => x.combo),
                                  'merge',
                                  'add_selected_discovery'
                                )
                              }
                              className="flex items-center gap-1 border border-[#0ECB81] bg-[#0ECB81]/15 px-2.5 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                            >
                              <Plus className="h-3 w-3" />
                              <span>Add Selected ({selectedComboKeys.length})</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={
                              filteredDiscoveryItems.length === 0 || savingBasketAction !== null
                            }
                            onClick={() =>
                              void addDiscoveryCombosToSignals(
                                filteredDiscoveryItems.map((x) => x.combo),
                                'merge',
                                'add_filtered_discovery'
                              )
                            }
                            className="flex items-center gap-1 border border-[#38BDF8] bg-[#38BDF8]/15 px-2.5 py-1 text-[11px] font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer disabled:opacity-40"
                          >
                            <Plus className="h-3 w-3" />
                            <span>
                              {savingBasketAction === 'add_filtered_discovery'
                                ? 'Adding...'
                                : 'Add All Filtered to Main Signals'}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={
                              filteredDiscoveryItems.length === 0 || savingBasketAction !== null
                            }
                            onClick={() =>
                              void addDiscoveryCombosToSignals(
                                selectedComboKeys.length > 0
                                  ? filteredDiscoveryItems
                                      .filter((x) => selectedComboKeys.includes(x.combo.comboKey))
                                      .map((x) => x.combo)
                                  : filteredDiscoveryItems.map((x) => x.combo),
                                'replace',
                                'replace_discovery'
                              )
                            }
                            className="border border-[#2B3548] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#F59E0B] hover:text-[#F59E0B] cursor-pointer disabled:opacity-40"
                          >
                            Replace Main Signals
                          </button>
                        </div>
                      </div>

                      <div className="max-h-72 overflow-y-auto border border-[#222938]">
                        <table className="w-full text-left font-mono text-xs tabular-nums">
                          <thead className="sticky top-0 bg-[#161B26] text-[10px] uppercase text-[#8B949E]">
                            <tr>
                              <th className="w-8 px-2.5 py-2">
                                <input
                                  type="checkbox"
                                  aria-label="Select visible strategies"
                                  checked={
                                    filteredDiscoveryItems.length > 0 &&
                                    filteredDiscoveryItems
                                      .slice(0, visibleBuilderLimit)
                                      .every((x) => selectedComboKeys.includes(x.combo.comboKey))
                                  }
                                  onChange={(e) => {
                                    const visKeys = filteredDiscoveryItems
                                      .slice(0, visibleBuilderLimit)
                                      .map((x) => x.combo.comboKey);
                                    setSelectedComboKeys(e.target.checked ? visKeys : []);
                                  }}
                                  className="accent-[#38BDF8] cursor-pointer"
                                />
                              </th>
                              <th className="px-2.5 py-2 font-medium">Strategy</th>
                              <th className="px-2.5 py-2 font-medium">Asset / TF</th>
                              <th className="px-2.5 py-2 font-medium">Condition</th>
                              <th className="px-2.5 py-2 font-medium">Readiness</th>
                              <th className="px-2.5 py-2 font-medium text-right">Win %</th>
                              <th className="px-2.5 py-2 font-medium text-right">PF</th>
                              <th className="px-2.5 py-2 font-medium text-right">Score</th>
                              <th className="px-2.5 py-2 font-medium text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#1D2432] bg-[#0B0E14]">
                            {filteredDiscoveryItems.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={9}
                                  className="px-4 py-6 text-center font-sans text-xs text-[#8B949E]"
                                >
                                  No Discovery strategies match the current filters.
                                </td>
                              </tr>
                            ) : (
                              filteredDiscoveryItems
                                .slice(0, visibleBuilderLimit)
                                .map(({ combo, audit }) => {
                                  const armed = isStrategyArmed(
                                    combo.symbol,
                                    combo.timeframe,
                                    combo.strategy.id
                                  );
                                  const checked = selectedComboKeys.includes(combo.comboKey);
                                  return (
                                    <tr key={combo.comboKey} className="hover:bg-[#12161F]">
                                      <td className="px-2.5 py-2">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() =>
                                            setSelectedComboKeys((prev) =>
                                              prev.includes(combo.comboKey)
                                                ? prev.filter((k) => k !== combo.comboKey)
                                                : [...prev, combo.comboKey]
                                            )
                                          }
                                          className="accent-[#38BDF8] cursor-pointer"
                                        />
                                      </td>
                                      <td className="max-w-[220px] px-2.5 py-2 font-sans">
                                        <div className="truncate font-medium text-[#E6EDF3]">
                                          {combo.strategy.name}
                                        </div>
                                        <div className="text-[10px] text-[#8B949E]">
                                          {combo.strategy.category}
                                        </div>
                                      </td>
                                      <td className="px-2.5 py-2 whitespace-nowrap">
                                        <span className="font-semibold text-[#E6EDF3]">
                                          {combo.symbol}
                                        </span>{' '}
                                        <span className="text-[#38BDF8]">{combo.timeframe}</span>
                                      </td>
                                      <td className="px-2.5 py-2 font-sans text-[11px] text-[#C9D1D9]">
                                        {combo.regime}
                                      </td>
                                      <td
                                        className={`px-2.5 py-2 font-sans text-[11px] font-medium ${readinessColorClass(
                                          audit.readiness
                                        )}`}
                                      >
                                        {audit.readiness}
                                      </td>
                                      <td className="px-2.5 py-2 text-right text-[#E6EDF3]">
                                        {combo.oosMetrics.winRate.toFixed(0)}%
                                      </td>
                                      <td className="px-2.5 py-2 text-right text-[#C9D1D9]">
                                        {combo.oosMetrics.profitFactor !== null
                                          ? combo.oosMetrics.profitFactor.toFixed(2)
                                          : '—'}
                                      </td>
                                      <td className="px-2.5 py-2 text-right text-[#38BDF8]">
                                        {combo.oosScore.toFixed(0)}
                                      </td>
                                      <td className="px-2.5 py-2 text-right">
                                        {armed ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void removeBasketItem(
                                                combo.symbol,
                                                combo.timeframe,
                                                combo.strategy.id
                                              )
                                            }
                                            className="inline-flex items-center gap-1 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2 py-0.5 text-[10px] font-semibold text-[#0ECB81] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                                          >
                                            <Check className="h-3 w-3" />
                                            <span>Added</span>
                                          </button>
                                        ) : (
                                          <button
                                            type="button"
                                            disabled={savingBasketAction !== null}
                                            onClick={() =>
                                              void addDiscoveryCombosToSignals(
                                                [combo],
                                                'merge',
                                                `row_${combo.comboKey}`
                                              )
                                            }
                                            className="inline-flex items-center gap-1 border border-[#2B3548] bg-[#12161F] px-2 py-0.5 text-[10px] font-semibold text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer disabled:opacity-40"
                                          >
                                            <Plus className="h-3 w-3" />
                                            <span>Add</span>
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })
                            )}
                          </tbody>
                        </table>
                      </div>

                      {filteredDiscoveryItems.length > visibleBuilderLimit && (
                        <div className="text-center">
                          <button
                            type="button"
                            onClick={() => setVisibleBuilderLimit((n) => n + 50)}
                            className="border border-[#222938] bg-[#12161F] px-3 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                          >
                            Show More ({filteredDiscoveryItems.length - visibleBuilderLimit} remaining)
                          </button>
                        </div>
                      )}
                    </>
                  )
                ) : (
                  /* Full Catalog Picker */
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3 border border-[#1D2432] bg-[#12161F] px-3 py-2 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[#8B949E]">Assign to Assets:</span>
                        {INSTRUMENTS.map((inst) => {
                          const active = catalogTargetSymbols.includes(inst.symbol);
                          return (
                            <button
                              key={inst.symbol}
                              type="button"
                              onClick={() =>
                                setCatalogTargetSymbols((prev) =>
                                  prev.includes(inst.symbol)
                                    ? prev.length > 1
                                      ? prev.filter((s) => s !== inst.symbol)
                                      : prev
                                    : [...prev, inst.symbol]
                                )
                              }
                              className={`border px-2 py-0.5 font-mono cursor-pointer ${
                                active
                                  ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                                  : 'border-[#222938] bg-[#0B0E14] text-[#8B949E]'
                              }`}
                            >
                              {inst.symbol}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-[#8B949E]">Timeframes:</span>
                        {BUILDER_TIMEFRAMES.map((tf) => {
                          const active = catalogTargetTfs.includes(tf);
                          return (
                            <button
                              key={tf}
                              type="button"
                              onClick={() =>
                                setCatalogTargetTfs((prev) =>
                                  prev.includes(tf)
                                    ? prev.length > 1
                                      ? prev.filter((t) => t !== tf)
                                      : prev
                                    : [...prev, tf]
                                )
                              }
                              className={`border px-2 py-0.5 font-mono cursor-pointer ${
                                active
                                  ? 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81]'
                                  : 'border-[#222938] bg-[#0B0E14] text-[#8B949E]'
                              }`}
                            >
                              {tf}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border border-[#1D2432] bg-[#12161F] px-3 py-2 text-xs">
                      <span className="font-mono text-[11px] text-[#C9D1D9]">
                        {filteredCatalogItems.length} strategies · {selectedCatalogIds.length} selected
                        {' → '}
                        {catalogTargetSymbols.join(', ')} ({catalogTargetTfs.join(', ')})
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={
                            selectedCatalogIds.length === 0 || savingBasketAction !== null
                          }
                          onClick={() =>
                            void addCatalogToSignals(
                              catalogStrategies.filter((s) => selectedCatalogIds.includes(s.id)),
                              'merge',
                              'add_selected_catalog'
                            )
                          }
                          className="flex items-center gap-1 border border-[#0ECB81] bg-[#0ECB81]/15 px-2.5 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" />
                          <span>Add Selected ({selectedCatalogIds.length})</span>
                        </button>
                        <button
                          type="button"
                          disabled={
                            selectedCatalogIds.length === 0 || savingBasketAction !== null
                          }
                          onClick={() =>
                            void addCatalogToSignals(
                              catalogStrategies.filter((s) => selectedCatalogIds.includes(s.id)),
                              'replace',
                              'replace_catalog'
                            )
                          }
                          className="border border-[#2B3548] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#F59E0B] hover:text-[#F59E0B] cursor-pointer disabled:opacity-40"
                        >
                          Replace Main Signals
                        </button>
                      </div>
                    </div>

                    {loadingCatalog ? (
                      <div className="py-6 text-center text-xs text-[#8B949E]">
                        Loading strategy catalog...
                      </div>
                    ) : (
                      <div className="max-h-72 overflow-y-auto border border-[#222938]">
                        <table className="w-full text-left text-xs">
                          <thead className="sticky top-0 bg-[#161B26] font-mono text-[10px] uppercase text-[#8B949E]">
                            <tr>
                              <th className="w-8 px-2.5 py-2" />
                              <th className="px-2.5 py-2 font-medium">Strategy</th>
                              <th className="px-2.5 py-2 font-medium">Category</th>
                              <th className="px-2.5 py-2 font-medium">Summary</th>
                              <th className="px-2.5 py-2 font-medium text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#1D2432] bg-[#0B0E14]">
                            {filteredCatalogItems.slice(0, 80).map((strat) => {
                              const checked = selectedCatalogIds.includes(strat.id);
                              return (
                                <tr key={strat.id} className="hover:bg-[#12161F]">
                                  <td className="px-2.5 py-2">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() =>
                                        setSelectedCatalogIds((prev) =>
                                          prev.includes(strat.id)
                                            ? prev.filter((id) => id !== strat.id)
                                            : [...prev, strat.id]
                                        )
                                      }
                                      className="accent-[#38BDF8] cursor-pointer"
                                    />
                                  </td>
                                  <td className="px-2.5 py-2 font-medium text-[#E6EDF3]">
                                    {strat.name}
                                  </td>
                                  <td className="px-2.5 py-2 font-mono text-[11px] text-[#38BDF8] whitespace-nowrap">
                                    {strat.category}
                                  </td>
                                  <td className="max-w-[280px] truncate px-2.5 py-2 text-[11px] text-[#8B949E]">
                                    {strat.summary}
                                  </td>
                                  <td className="px-2.5 py-2 text-right">
                                    <button
                                      type="button"
                                      disabled={savingBasketAction !== null}
                                      onClick={() =>
                                        void addCatalogToSignals(
                                          [strat],
                                          'merge',
                                          `cat_${strat.id}`
                                        )
                                      }
                                      className="inline-flex items-center gap-1 border border-[#2B3548] bg-[#12161F] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer disabled:opacity-40"
                                    >
                                      <Plus className="h-3 w-3" />
                                      <span>Add</span>
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'scanner' && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {INSTRUMENTS.map((inst) => {
                const diag = signalDiagnostics.find((d) => d.symbol === inst.symbol);
                return (
                  <div key={inst.symbol} className="border border-[#222938] bg-[#0B0E14] p-3.5">
                    <div className="flex items-center justify-between border-b border-[#1D2432] pb-2">
                      <div>
                        <span className="font-mono text-sm font-semibold text-[#E6EDF3]">
                          {inst.symbol}
                        </span>
                        <span className="ml-2 text-xs text-[#8B949E]">{inst.name}</span>
                      </div>
                      <span
                        className={`font-mono text-xs font-semibold ${
                          diag?.status === 'SIGNAL_GENERATED'
                            ? 'text-[#0ECB81]'
                            : diag?.status === 'WATCHING_CANDIDATE'
                              ? 'text-[#F59E0B]'
                              : 'text-[#8B949E]'
                        }`}
                      >
                        {diag?.status ?? 'NO_TRADE'}
                      </span>
                    </div>

                    <div className="mt-2.5 grid grid-cols-2 gap-3 font-mono text-xs tabular-nums">
                      <div className="border border-[#1D2432] bg-[#12161F] p-2">
                        <div className="text-[11px] text-[#8B949E]">BUY Score</div>
                        <div className="mt-0.5 text-base font-semibold text-[#0ECB81]">
                          {diag?.buyScore ?? 0} / 100
                        </div>
                      </div>
                      <div className="border border-[#1D2432] bg-[#12161F] p-2">
                        <div className="text-[11px] text-[#8B949E]">SELL Score</div>
                        <div className="mt-0.5 text-base font-semibold text-[#F6465D]">
                          {diag?.sellScore ?? 0} / 100
                        </div>
                      </div>
                    </div>

                    {diag && (
                      <>
                        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[#8B949E] tabular-nums">
                          <span>1D: {diag.htfBias.d1}</span>
                          <span>4H: {diag.htfBias.h4}</span>
                          <span>1H: {diag.htfBias.h1}</span>
                          <span>15m: {diag.htfBias.m15}</span>
                          <span>5m: {diag.htfBias.m5}</span>
                        </div>
                        <div className="mt-2.5 border-t border-[#1D2432] pt-2">
                          <div className="text-[11px] font-semibold text-[#8B949E]">
                            Evaluation Notes / Rejection Reasons
                          </div>
                          {diag.rejectionReasons.length === 0 ? (
                            <div className="mt-1 text-xs text-[#0ECB81]">
                              All institutional criteria satisfied.
                            </div>
                          ) : (
                            <ul className="mt-1 space-y-0.5 text-[11px] text-[#C9D1D9]">
                              {diag.rejectionReasons.map((r, i) => (
                                <li key={i}>• {r}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              {/* SQLite Storage Toolbar & Bulk Delete Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-[#222938] bg-[#0B0E14] px-3 py-2.5 text-xs">
                <div className="flex items-center gap-2 font-mono tabular-nums text-[#C9D1D9]">
                  <Database className="h-3.5 w-3.5 text-[#38BDF8] shrink-0" />
                  <span>
                    SQLite Archive: {signals.length} saved · {historicalSignals.length} matching filter
                  </span>
                  {selectedVisibleCount > 0 && (
                    <span className="text-[#38BDF8]">· {selectedVisibleCount} selected</span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void refreshSignals()}
                    className="flex items-center gap-1.5 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Reload DB</span>
                  </button>

                  {selectedVisibleCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setPendingBulkAction({ kind: 'selected' })}
                      className="flex items-center gap-1.5 border border-[#F6465D]/60 bg-[#F6465D]/10 px-2.5 py-1 text-xs font-medium text-[#F6465D] hover:bg-[#F6465D]/20 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>Delete Selected ({selectedVisibleCount})</span>
                    </button>
                  )}

                  {signals.some((s) => TERMINAL_STATES.has(s.state)) && (
                    <button
                      type="button"
                      onClick={() => setPendingBulkAction({ kind: 'scope', scope: 'closed' })}
                      className="border border-[#222938] bg-[#12161F] px-2.5 py-1 text-xs text-[#8B949E] hover:border-[#F59E0B]/60 hover:text-[#F59E0B] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Delete Closed Entries
                    </button>
                  )}

                  {signals.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPendingBulkAction({ kind: 'scope', scope: 'all' })}
                      className="border border-[#222938] bg-[#12161F] px-2.5 py-1 text-xs text-[#8B949E] hover:border-[#F6465D]/60 hover:text-[#F6465D] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Clear All DB
                    </button>
                  )}
                </div>
              </div>

              {pendingBulkAction && (
                <div className="flex flex-wrap items-center justify-between gap-3 border border-[#F6465D]/60 bg-[#F6465D]/10 px-3 py-2 text-xs">
                  <span className="text-[#E6EDF3]">
                    {pendingBulkAction.kind === 'selected'
                      ? `Permanently delete ${selectedVisibleCount} selected signal entry(ies) from SQLite?`
                      : pendingBulkAction.scope === 'all'
                        ? `Permanently delete all ${signals.length} signal entries from SQLite?`
                        : 'Permanently delete all closed/stopped/cancelled/expired signal entries from SQLite?'}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={deletingDb}
                      onClick={() => void handleExecutePendingDelete()}
                      className="bg-[#F6465D] px-3 py-1 font-semibold text-white hover:bg-[#F6465D]/90 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                    >
                      {deletingDb ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                    <button
                      type="button"
                      disabled={deletingDb}
                      onClick={() => setPendingBulkAction(null)}
                      className="border border-[#2B3548] bg-[#12161F] px-3 py-1 text-[#C9D1D9] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto border border-[#222938]">
                <table className="w-full text-left font-mono text-xs tabular-nums">
                  <thead className="bg-[#161B26] text-[#8B949E]">
                    <tr>
                      <th className="w-8 px-2.5 py-2">
                        <input
                          type="checkbox"
                          aria-label="Select all visible signals"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          className="accent-[#38BDF8] cursor-pointer"
                        />
                      </th>
                      <th className="px-2.5 py-2 font-medium">Instrument</th>
                      <th className="px-2.5 py-2 font-medium">Side</th>
                      <th className="px-2.5 py-2 font-medium">State</th>
                      <th className="px-2.5 py-2 font-medium text-right">Score</th>
                      <th className="px-2.5 py-2 font-medium text-right">Entry Zone</th>
                      <th className="px-2.5 py-2 font-medium text-right">Stop Loss</th>
                      <th className="px-2.5 py-2 font-medium">Targets (TP1 / TP2 / TP3)</th>
                      <th className="px-2.5 py-2 font-medium">Why Issued / Outcome</th>
                      <th className="px-2.5 py-2 font-medium text-right">Result</th>
                      <th className="px-2.5 py-2 font-medium text-right">Saved At</th>
                      <th className="px-2.5 py-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2432] bg-[#0B0E14]">
                    {historicalSignals.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="px-4 py-10 text-center font-sans text-xs text-[#8B949E]">
                          {signals.length === 0
                            ? 'No signals saved in SQLite database yet. Run a scan or wait for confirmed institutional setups.'
                            : 'No saved signals match the active symbol, direction, or state filter.'}
                        </td>
                      </tr>
                    ) : (
                      historicalSignals.map((sig) => {
                        const p = getInstrumentMeta(sig.symbol).pricePrecision;
                        const isSelected = selectedIds.includes(sig.id);
                        const isExpanded = expandedId === sig.id;
                        const isConfirmingDel = confirmRowDeleteId === sig.id;
                        const stateColor = TP_STATES.has(sig.state)
                          ? 'text-[#0ECB81]'
                          : sig.state === 'STOPPED' || sig.state === 'INVALIDATED'
                            ? 'text-[#F6465D]'
                            : sig.state === 'WATCHING'
                              ? 'text-[#F59E0B]'
                              : sig.state === 'ACTIVE' || sig.state === 'CONFIRMED' || sig.state === 'PARTIAL'
                                ? 'text-[#38BDF8]'
                                : 'text-[#8B949E]';

                        const entrySummaryText =
                          sig.generationSummary ??
                          sig.confluenceReasons.slice(0, 2).join(' · ') ??
                          '—';
                        const outcomeSummaryText =
                          sig.outcomeSummary ??
                          sig.failureReasons?.[0] ??
                          (TERMINAL_STATES.has(sig.state) && sig.timeline.length > 0
                            ? sig.timeline[sig.timeline.length - 1].note
                            : null);

                        return (
                          <Fragment key={sig.id}>
                            <tr
                              className={`transition-colors ${
                                isSelected ? 'bg-[#161B26]' : 'hover:bg-[#12161F]'
                              }`}
                            >
                              <td className="px-2.5 py-2.5 align-top">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${sig.symbol} ${sig.direction} signal`}
                                  checked={isSelected}
                                  onChange={() => toggleSelectRow(sig.id)}
                                  className="mt-0.5 accent-[#38BDF8] cursor-pointer"
                                />
                              </td>
                              <td className="px-2.5 py-2.5 align-top">
                                <div className="font-semibold text-[#E6EDF3]">{sig.symbol}</div>
                                <div className="text-[10px] text-[#8B949E]">
                                  {sig.entryTimeframe} · Setup {sig.setupTimeframe}
                                </div>
                              </td>
                              <td
                                className={`px-2.5 py-2.5 align-top font-semibold ${
                                  sig.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {sig.direction}
                              </td>
                              <td className="px-2.5 py-2.5 align-top">
                                <div className={`font-semibold ${stateColor}`}>{sig.state}</div>
                                <div className="text-[10px] text-[#6E7681]">
                                  {sig.provisional ? 'Provisional' : 'Confirmed'}
                                </div>
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right">
                                <div className="text-[#E6EDF3]">{sig.score}/100</div>
                                <div className="text-[10px] text-[#8B949E]">{sig.classification}</div>
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right">
                                <div className="text-[#E6EDF3]">{sig.entryPrice.toFixed(p)}</div>
                                <div className="text-[10px] text-[#8B949E]">
                                  {sig.entryZone.lower.toFixed(p)}–{sig.entryZone.upper.toFixed(p)}
                                </div>
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right">
                                <div className="text-[#F6465D]">{sig.stopLoss.toFixed(p)}</div>
                                <div className="text-[10px] text-[#8B949E]">
                                  Inv {sig.invalidationLevel.toFixed(p)}
                                </div>
                              </td>
                              <td className="px-2.5 py-2.5 align-top">
                                <div className="space-y-0.5 text-[11px]">
                                  {sig.takeProfits.map((tp) => (
                                    <div key={tp.level} className="flex items-center gap-1.5 whitespace-nowrap">
                                      <span className={tp.hit ? 'font-semibold text-[#38BDF8]' : 'text-[#0ECB81]'}>
                                        TP{tp.level} {tp.price.toFixed(p)}
                                      </span>
                                      <span className="text-[#8B949E]">
                                        1:{tp.riskReward.toFixed(2)}
                                        {tp.hit ? ' · HIT' : ''}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                              <td className="max-w-[260px] px-2.5 py-2.5 align-top font-sans">
                                <div className="truncate text-[11px] text-[#C9D1D9]" title={entrySummaryText}>
                                  {entrySummaryText}
                                </div>
                                {outcomeSummaryText && (
                                  <div
                                    className={`mt-0.5 truncate text-[10px] ${
                                      sig.state === 'STOPPED' || sig.state === 'INVALIDATED'
                                        ? 'text-[#F6465D]'
                                        : sig.state === 'TP3_HIT'
                                          ? 'text-[#0ECB81]'
                                          : 'text-[#F59E0B]'
                                    }`}
                                    title={outcomeSummaryText}
                                  >
                                    {outcomeSummaryText}
                                  </div>
                                )}
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right">
                                <div
                                  className={
                                    (sig.realizedR ?? 0) > 0
                                      ? 'text-[#0ECB81]'
                                      : (sig.realizedR ?? 0) < 0
                                        ? 'text-[#F6465D]'
                                        : 'text-[#C9D1D9]'
                                  }
                                >
                                  {sig.realizedR !== null
                                    ? `${sig.realizedR > 0 ? '+' : ''}${sig.realizedR}R`
                                    : 'Open'}
                                </div>
                                <div className="text-[10px] text-[#8B949E]">
                                  +{sig.highestFavorableR.toFixed(2)} / -{sig.maxAdverseR.toFixed(2)}R
                                </div>
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right text-[#8B949E]">
                                <div>{fmtTime(sig.createdAt)}</div>
                                {sig.closedAt && (
                                  <div className="text-[10px] text-[#6E7681]">
                                    Cls {fmtTime(sig.closedAt)}
                                  </div>
                                )}
                              </td>
                              <td className="px-2.5 py-2.5 align-top text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedId(isExpanded ? null : sig.id)}
                                    title="Inspect full signal breakdown & failure analysis"
                                    className="flex items-center gap-0.5 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    {isExpanded ? (
                                      <ChevronDown className="h-3 w-3" />
                                    ) : (
                                      <ChevronRight className="h-3 w-3" />
                                    )}
                                    <span>Details</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleFocusOnChart(sig)}
                                    title="Show on chart"
                                    className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    <Crosshair className="h-3 w-3" />
                                    <span>Chart</span>
                                  </button>
                                  {!isConfirmingDel ? (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmRowDeleteId(sig.id)}
                                      title="Delete signal entry from SQLite"
                                      className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E] hover:border-[#F6465D]/60 hover:text-[#F6465D] whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      <span>Delete</span>
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        disabled={deletingDb}
                                        onClick={() => void handleSingleDelete(sig.id)}
                                        className="border border-[#F6465D] bg-[#F6465D]/15 px-2 py-1 text-[11px] font-semibold text-[#F6465D] hover:bg-[#F6465D]/25 whitespace-nowrap shrink-0 cursor-pointer"
                                      >
                                        Confirm
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmRowDeleteId(null)}
                                        className="border border-[#222938] bg-[#12161F] px-1.5 py-1 text-[11px] text-[#8B949E] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                                      >
                                        No
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-[#12161F]">
                                <td colSpan={12} className="p-3">
                                  <SignalCard
                                    signal={sig}
                                    timezone={timezone}
                                    onFocusOnChart={handleFocusOnChart}
                                    onCancel={(id) => void cancelSignal(id)}
                                    onDelete={(id) => void handleSingleDelete(id)}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'performance' && (
            <div className="space-y-4">
              {!signalPerformance || signalPerformance.totalSignals === 0 ? (
                <div className="border border-[#222938] bg-[#0B0E14] p-6 text-center">
                  <div className="text-sm font-medium text-[#E6EDF3]">
                    No Executed Signal Outcomes Recorded Yet
                  </div>
                  <p className="mt-1 text-xs text-[#8B949E]">
                    Performance tracking records genuine live session signals only. Metrics will populate automatically as confirmed signals enter and resolve.
                  </p>
                </div>
              ) : null}

              {signalPerformance && (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 font-mono tabular-nums">
                    {[
                      { label: 'Total Signals', value: String(signalPerformance.totalSignals) },
                      {
                        label: 'BUY / SELL',
                        value: `${signalPerformance.buyCount} / ${signalPerformance.sellCount}`,
                      },
                      {
                        label: 'Win / Loss',
                        value: `${signalPerformance.winningSignals} / ${signalPerformance.losingSignals}`,
                      },
                      { label: 'Win Rate', value: `${signalPerformance.winRate}%` },
                      {
                        label: 'Avg R-Multiple',
                        value: `${signalPerformance.avgRMultiple >= 0 ? '+' : ''}${signalPerformance.avgRMultiple}R`,
                      },
                      {
                        label: 'Profit Factor',
                        value:
                          signalPerformance.profitFactor !== null
                            ? String(signalPerformance.profitFactor)
                            : '—',
                      },
                      { label: 'TP1 Hit Rate', value: `${signalPerformance.tp1HitRate}%` },
                      { label: 'TP2 Hit Rate', value: `${signalPerformance.tp2HitRate}%` },
                      { label: 'TP3 Hit Rate', value: `${signalPerformance.tp3HitRate}%` },
                      { label: 'SL Hit Rate', value: `${signalPerformance.slHitRate}%` },
                      { label: 'Max Drawdown', value: `${signalPerformance.maxDrawdownR}R` },
                      { label: 'Active / Watching', value: `${signalPerformance.activeCount} / ${signalPerformance.watchingCount}` },
                    ].map((stat) => (
                      <div key={stat.label} className="border border-[#222938] bg-[#0B0E14] p-3">
                        <div className="font-sans text-[11px] text-[#8B949E]">{stat.label}</div>
                        <div className="mt-1 text-sm font-semibold text-[#E6EDF3]">{stat.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="border border-[#222938] bg-[#0B0E14]">
                      <div className="border-b border-[#222938] bg-[#161B26] px-3 py-2 text-xs font-semibold text-[#E6EDF3]">
                        Performance by Instrument
                      </div>
                      <table className="w-full text-left font-mono text-xs tabular-nums">
                        <thead className="border-b border-[#1D2432] text-[#8B949E]">
                          <tr>
                            <th className="px-3 py-1.5 font-medium">Symbol</th>
                            <th className="px-3 py-1.5 font-medium text-right">Total</th>
                            <th className="px-3 py-1.5 font-medium text-right">B/S</th>
                            <th className="px-3 py-1.5 font-medium text-right">W/L</th>
                            <th className="px-3 py-1.5 font-medium text-right">Win %</th>
                            <th className="px-3 py-1.5 font-medium text-right">Avg R</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1D2432]">
                          {INSTRUMENTS.map((inst) => {
                            const row = signalPerformance.byInstrument[inst.symbol];
                            return (
                              <tr key={inst.symbol}>
                                <td className="px-3 py-1.5 text-[#E6EDF3]">{inst.symbol}</td>
                                <td className="px-3 py-1.5 text-right text-[#C9D1D9]">{row?.total ?? 0}</td>
                                <td className="px-3 py-1.5 text-right text-[#8B949E]">
                                  {row?.buy ?? 0}/{row?.sell ?? 0}
                                </td>
                                <td className="px-3 py-1.5 text-right text-[#C9D1D9]">
                                  {row?.wins ?? 0}/{row?.losses ?? 0}
                                </td>
                                <td className="px-3 py-1.5 text-right text-[#0ECB81]">{row?.winRate ?? 0}%</td>
                                <td className="px-3 py-1.5 text-right text-[#E6EDF3]">{row?.avgR ?? 0}R</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="border border-[#222938] bg-[#0B0E14]">
                      <div className="border-b border-[#222938] bg-[#161B26] px-3 py-2 text-xs font-semibold text-[#E6EDF3]">
                        Performance by Timeframe
                      </div>
                      <table className="w-full text-left font-mono text-xs tabular-nums">
                        <thead className="border-b border-[#1D2432] text-[#8B949E]">
                          <tr>
                            <th className="px-3 py-1.5 font-medium">Timeframe</th>
                            <th className="px-3 py-1.5 font-medium text-right">Total</th>
                            <th className="px-3 py-1.5 font-medium text-right">Wins</th>
                            <th className="px-3 py-1.5 font-medium text-right">Losses</th>
                            <th className="px-3 py-1.5 font-medium text-right">Win %</th>
                            <th className="px-3 py-1.5 font-medium text-right">Avg R</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1D2432]">
                          {Object.keys(signalPerformance.byTimeframe).length === 0 ? (
                            <tr>
                              <td colSpan={6} className="px-3 py-4 text-center font-sans text-[#8B949E]">
                                No timeframe statistics recorded yet.
                              </td>
                            </tr>
                          ) : (
                            Object.entries(signalPerformance.byTimeframe).map(([tf, row]) => (
                              <tr key={tf}>
                                <td className="px-3 py-1.5 text-[#E6EDF3]">{tf}</td>
                                <td className="px-3 py-1.5 text-right text-[#C9D1D9]">{row.total}</td>
                                <td className="px-3 py-1.5 text-right text-[#0ECB81]">{row.wins}</td>
                                <td className="px-3 py-1.5 text-right text-[#F6465D]">{row.losses}</td>
                                <td className="px-3 py-1.5 text-right text-[#E6EDF3]">{row.winRate}%</td>
                                <td className="px-3 py-1.5 text-right text-[#E6EDF3]">{row.avgR}R</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2 text-xs">
                  <div className="border-b border-[#1D2432] pb-2 font-semibold text-[#E6EDF3]">
                    Thresholds & Validation Rules
                  </div>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Enable Signal Engine</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.enabled}
                      onChange={(e) =>
                        setDraftSettings((d) => ({ ...d, enabled: e.target.checked }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5">
                    <span className="text-[#C9D1D9]">Min Confirmed Score (default 75)</span>
                    <input
                      type="number"
                      min={50}
                      max={95}
                      value={draftSettings.minConfirmedScore}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          minConfirmedScore: Number(e.target.value),
                        }))
                      }
                      className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5">
                    <span className="text-[#C9D1D9]">Min Watching Score (default 65)</span>
                    <input
                      type="number"
                      min={40}
                      max={90}
                      value={draftSettings.minWatchingScore}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          minWatchingScore: Number(e.target.value),
                        }))
                      }
                      className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5">
                    <span className="text-[#C9D1D9]">Min TP1 Risk/Reward (default 1.5)</span>
                    <input
                      type="number"
                      min={1.0}
                      max={5.0}
                      step={0.1}
                      value={draftSettings.minTp1RiskReward}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          minTp1RiskReward: Number(e.target.value),
                        }))
                      }
                      className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5">
                    <span className="text-[#C9D1D9]">ATR Stop Buffer Multiplier</span>
                    <input
                      type="number"
                      min={0.1}
                      max={1.5}
                      step={0.05}
                      value={draftSettings.atrStopBufferMultiplier}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          atrStopBufferMultiplier: Number(e.target.value),
                        }))
                      }
                      className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Allow Intrabar WATCHING Candidates</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.allowIntrabarWatching}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          allowIntrabarWatching: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require Strict 1H Alignment</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.require1HAlignment}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          require1HAlignment: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require 1m Entry Refinement</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.require1MRefinement}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          require1MRefinement: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <div className="border-t border-[#1D2432] pt-2 mt-2 font-semibold text-[#E6EDF3]">
                    Strategy-Only &amp; Auto-Trade Accuracy Gates
                  </div>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Allow Default Generic Signals (100-pt Scanner)</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.allowDefaultSignals}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          allowDefaultSignals: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require Market Regime Match (Skip Poor Regimes)</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.requireRegimeCompatibility}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          requireRegimeCompatibility: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require HTF Alignment on Strategy Signals</span>
                    <input
                      type="checkbox"
                      checked={draftSettings.requireHtfAlignmentForStrategy}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          requireHtfAlignmentForStrategy: e.target.checked,
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5">
                    <span className="text-[#C9D1D9]">Min Strategy Confluence Score (default 75)</span>
                    <input
                      type="number"
                      min={50}
                      max={95}
                      value={draftSettings.minStrategyConfluenceScore}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          minStrategyConfluenceScore: Number(e.target.value),
                        }))
                      }
                      className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                    />
                  </label>

                  <div className="border-t border-[#1D2432] pt-2 mt-2 font-semibold text-[#E6EDF3]">
                    SMC Pre-Trigger Criteria (Required Before Trigger)
                  </div>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require Order Blocks (Valid Unmitigated OB)</span>
                    <input
                      type="checkbox"
                      checked={Boolean(draftSettings.smcCriteria?.requireOrderBlock)}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          smcCriteria: {
                            ...(d.smcCriteria ?? DEFAULT_SIGNAL_SETTINGS.smcCriteria),
                            requireOrderBlock: e.target.checked,
                          },
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require Fair Value Gaps (Active Unfilled FVG)</span>
                    <input
                      type="checkbox"
                      checked={Boolean(draftSettings.smcCriteria?.requireFairValueGap)}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          smcCriteria: {
                            ...(d.smcCriteria ?? DEFAULT_SIGNAL_SETTINGS.smcCriteria),
                            requireFairValueGap: e.target.checked,
                          },
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>

                  <label className="flex items-center justify-between py-1.5 cursor-pointer">
                    <span className="text-[#C9D1D9]">Require Liquidity Sweeps (Opposing SSL/BSL Sweep)</span>
                    <input
                      type="checkbox"
                      checked={Boolean(draftSettings.smcCriteria?.requireLiquiditySweep)}
                      onChange={(e) =>
                        setDraftSettings((d) => ({
                          ...d,
                          smcCriteria: {
                            ...(d.smcCriteria ?? DEFAULT_SIGNAL_SETTINGS.smcCriteria),
                            requireLiquiditySweep: e.target.checked,
                          },
                        }))
                      }
                      className="accent-[#38BDF8]"
                    />
                  </label>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2 text-xs">
                  <div className="flex items-center justify-between border-b border-[#1D2432] pb-2">
                    <span className="font-semibold text-[#E6EDF3]">
                      100-Point Scoring Weights
                    </span>
                    <span
                      className={`font-mono ${
                        weightTotal === 100 ? 'text-[#0ECB81]' : 'text-[#F59E0B]'
                      }`}
                    >
                      Sum: {weightTotal} / 100
                    </span>
                  </div>

                  {(
                    [
                      ['htfAlignment', 'Higher-Timeframe Alignment'],
                      ['liquiditySweep', 'Liquidity Sweep'],
                      ['structureConfirmation', 'Market Structure Confirmation'],
                      ['obFvgConfluence', 'Order Block / FVG Confluence'],
                      ['premiumDiscount', 'Premium / Discount Positioning'],
                      ['volumeMomentum', 'Volume & Momentum'],
                      ['riskRewardQuality', 'Risk / Reward Quality'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between py-1.5">
                      <span className="text-[#C9D1D9]">{label}</span>
                      <input
                        type="number"
                        min={0}
                        max={40}
                        value={draftSettings.weights[key]}
                        onChange={(e) =>
                          setDraftSettings((d) => ({
                            ...d,
                            weights: { ...d.weights, [key]: Number(e.target.value) },
                          }))
                        }
                        className="w-20 border border-[#222938] bg-[#12161F] px-2 py-1 text-right font-mono text-[#E6EDF3]"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-[#222938] pt-3">
                <button
                  type="button"
                  onClick={() => setDraftSettings(structuredClone(DEFAULT_SIGNAL_SETTINGS))}
                  className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#8B949E] hover:text-white cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset Signal Defaults</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveSettings()}
                  disabled={savingSettings}
                  className="bg-[#38BDF8] px-4 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#7DD3FC] cursor-pointer"
                >
                  {savingSettings ? 'Saving & Re-scanning...' : 'Save Signal Settings'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
