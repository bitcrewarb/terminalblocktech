import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Award,
  BookOpen,
  Check,
  Clock,
  Compass,
  Download,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  BacktestStrategyCategory,
  BacktestStrategyId,
  CombinationDetailResult,
  DiscoveryRunSummary,
  DiscoveryScanProgress,
  DiscoveryScanRun,
  DiscoveryStrategyScope,
  InstrumentSymbol,
  LiveStrategyBasketSlot,
  MarketRegimeType,
  ProductionReadinessStatus,
  StrategyDiscoveryCombination,
  Timeframe,
  ValidationStatus,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import { CombinationDetailModal } from './CombinationDetailModal.tsx';
import {
  deriveProductionAudit,
  DISCOVERY_GLOSSARY,
  formatRiskRewardRatio,
  HintBadge,
  SimpleValidationLabel,
} from './HintBadge.tsx';
import { PerformanceHeatmapD3 } from './PerformanceHeatmapD3.tsx';

type DiscoveryViewTab = 'playbook' | 'overall' | 'instrument' | 'timeframe' | 'regime';
type ReadinessFilter = 'ALL' | 'HIDE_OVERFIT' | ProductionReadinessStatus;
type SortField =
  | 'rank'
  | 'oosScore'
  | 'oosReturn'
  | 'oosPf'
  | 'oosExpectancy'
  | 'oosWinRate'
  | 'oosDd'
  | 'oosTrades'
  | 'wfConsistency'
  | 'holdoutReturn';

const ALL_SYMBOLS: InstrumentSymbol[] = INSTRUMENTS.map((i) => i.symbol);
const DISCOVERY_TIMEFRAMES: Timeframe[] = ['5m', '15m', '30m', '1H', '4H', '1D'];
const CATEGORIES: Array<'ALL' | BacktestStrategyCategory> = [
  'ALL',
  'SMC',
  'Price Action',
  'Chart Patterns',
  'Support & Resistance',
  'Hybrid SMC/PA',
];
const REGIMES: Array<'ALL' | MarketRegimeType> = [
  'ALL',
  'Trending',
  'Ranging',
  'High Volatility',
  'Low Volatility',
  'Transitional',
];
const VALIDATION_FILTERS: Array<'ALL' | ValidationStatus> = [
  'ALL',
  'Validated',
  'Preliminary Candidate',
  'Insufficient Evidence',
  'Failed Validation',
];

function validationDot(status: ValidationStatus): string {
  switch (status) {
    case 'Validated':
      return 'bg-[#0ECB81]';
    case 'Preliminary Candidate':
      return 'bg-[#F59E0B]';
    case 'Insufficient Evidence':
      return 'bg-[#8B949E]';
    case 'Failed Validation':
      return 'bg-[#F6465D]';
  }
}

function validationText(status: ValidationStatus): string {
  switch (status) {
    case 'Validated':
      return 'text-[#0ECB81]';
    case 'Preliminary Candidate':
      return 'text-[#F59E0B]';
    case 'Insufficient Evidence':
      return 'text-[#8B949E]';
    case 'Failed Validation':
      return 'text-[#F6465D]';
  }
}

function readinessDot(readiness: ProductionReadinessStatus): string {
  switch (readiness) {
    case 'Production Ready':
      return 'bg-[#0ECB81]';
    case 'Verify Paper':
      return 'bg-[#F59E0B]';
    case 'Overfit / Decayed':
      return 'bg-[#F6465D]';
    case 'Not Ready':
      return 'bg-[#6E7681]';
  }
}

function readinessText(readiness: ProductionReadinessStatus): string {
  switch (readiness) {
    case 'Production Ready':
      return 'text-[#0ECB81]';
    case 'Verify Paper':
      return 'text-[#F59E0B]';
    case 'Overfit / Decayed':
      return 'text-[#F6465D]';
    case 'Not Ready':
      return 'text-[#8B949E]';
  }
}

export function StrategyDiscoveryPage({
  onBackToTerminal,
  onOpenSignals,
}: {
  onBackToTerminal: () => void;
  onOpenSignals?: () => void;
}) {
  const {
    timezone,
    discoveryProgress: ctxProgress,
    selectSymbol,
    selectTimeframe,
    focusChartObject,
    liveStrategyBasket,
    updateLiveStrategyBasket,
    removeBasketItem,
  } = useTerminal();

  // Scan configurator state
  const [selectedSymbols, setSelectedSymbols] = useState<InstrumentSymbol[]>([
    'XAUUSD',
    'XAGUSD',
    'BTCUSDT',
    'ETHUSDT',
  ]);
  const [selectedTimeframes, setSelectedTimeframes] = useState<Timeframe[]>([
    '15m',
    '1H',
    '4H',
  ]);
  const [barsPerTf, setBarsPerTf] = useState<number>(900);
  const [strategyScope, setStrategyScope] = useState<DiscoveryStrategyScope>('core');
  const [scopeCategory, setScopeCategory] = useState<BacktestStrategyCategory>('SMC');
  const [commissionBps, setCommissionBps] = useState<number>(4);
  const [slippageBps, setSlippageBps] = useState<number>(2);
  const [minRiskReward, setMinRiskReward] = useState<number>(1.5);
  const [minOosTrades, setMinOosTrades] = useState<number>(4);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [catalogStrategyCount, setCatalogStrategyCount] = useState<number>(3300);

  // Saved runs & current loaded run
  const [runs, setRuns] = useState<DiscoveryRunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<DiscoveryScanRun | null>(null);
  const [progress, setProgress] = useState<DiscoveryScanProgress>(ctxProgress);
  const [loadingRun, setLoadingRun] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Views & Filters
  const [viewTab, setViewTab] = useState<DiscoveryViewTab>('playbook');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterSymbol, setFilterSymbol] = useState<'ALL' | InstrumentSymbol>('ALL');
  const [filterTimeframe, setFilterTimeframe] = useState<'ALL' | Timeframe>('ALL');
  const [filterCategory, setFilterCategory] = useState<'ALL' | BacktestStrategyCategory>('ALL');
  const [filterRegime, setFilterRegime] = useState<'ALL' | MarketRegimeType>('ALL');
  const [filterStatus, setFilterStatus] = useState<'ALL' | ValidationStatus>('ALL');
  const [filterReadiness, setFilterReadiness] = useState<ReadinessFilter>('ALL');
  const [includeVerifyPaper, setIncludeVerifyPaper] = useState<boolean>(false);
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDesc, setSortDesc] = useState<boolean>(false);
  const [visibleLimit, setVisibleLimit] = useState<number>(60);
  const [showGlossaryGuide, setShowGlossaryGuide] = useState<boolean>(false);
  const [showAccuracyGuide, setShowAccuracyGuide] = useState<boolean>(false);
  const [basketFeedback, setBasketFeedback] = useState<string | null>(null);
  const [activatingBasketKey, setActivatingBasketKey] = useState<string | null>(null);

  // Combination Detail Modal
  const [inspectedCombo, setInspectedCombo] = useState<StrategyDiscoveryCombination | null>(null);
  const [detailData, setDetailData] = useState<CombinationDetailResult | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadRunById = useCallback(async (runId: string) => {
    setLoadingRun(true);
    try {
      const res = await apiFetch(`/api/discovery/runs/${encodeURIComponent(runId)}`);
      if (res.ok) {
        const data = (await res.json()) as DiscoveryScanRun;
        setActiveRun(data);
      }
    } finally {
      setLoadingRun(false);
    }
  }, []);

  const refreshArchive = useCallback(
    async (autoLoadLatest = false) => {
      const [runsRes, statusRes] = await Promise.all([
        apiFetch('/api/discovery/runs'),
        apiFetch('/api/discovery/status'),
      ]);
      if (statusRes.ok) {
        const st = (await statusRes.json()) as { progress: DiscoveryScanProgress };
        setProgress(st.progress);
      }
      if (runsRes.ok) {
        const d = (await runsRes.json()) as { runs: DiscoveryRunSummary[] };
        setRuns(d.runs);
        if (autoLoadLatest && d.runs.length > 0) {
          await loadRunById(d.runs[0].id);
        }
      }
    },
    [loadRunById]
  );

  useEffect(() => {
    void refreshArchive(true);
    void apiFetch('/api/backtest/strategies')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { strategies?: unknown[] } | null) => {
        if (d?.strategies && d.strategies.length > 0) {
          setCatalogStrategyCount(d.strategies.length);
        }
      })
      .catch(() => {});
  }, [refreshArchive]);

  // Sync WebSocket progress updates from context
  useEffect(() => {
    setProgress(ctxProgress);
    if (ctxProgress.status === 'completed' && ctxProgress.runId) {
      void refreshArchive(false);
      void loadRunById(ctxProgress.runId);
    }
  }, [ctxProgress, refreshArchive, loadRunById]);

  // Fallback polling while scan is active in case WebSocket packet was missed
  useEffect(() => {
    if (progress.status !== 'running') return;
    const timer = setInterval(() => {
      void apiFetch('/api/discovery/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { progress?: DiscoveryScanProgress } | null) => {
          if (!d?.progress) return;
          setProgress(d.progress);
          if (d.progress.status === 'completed' && d.progress.runId) {
            void refreshArchive(false);
            void loadRunById(d.progress.runId);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [progress.status, refreshArchive, loadRunById]);

  const handleToggleSymbol = (sym: InstrumentSymbol) => {
    setSelectedSymbols((prev) =>
      prev.includes(sym)
        ? prev.length > 1
          ? prev.filter((s) => s !== sym)
          : prev
        : [...prev, sym]
    );
  };

  const handleToggleTimeframe = (tf: Timeframe) => {
    setSelectedTimeframes((prev) =>
      prev.includes(tf)
        ? prev.length > 1
          ? prev.filter((t) => t !== tf)
          : prev
        : [...prev, tf]
    );
  };

  const handleApplyMaxAccuracyPreset = () => {
    setSelectedSymbols(['XAUUSD', 'XAGUSD', 'BTCUSDT', 'ETHUSDT']);
    setSelectedTimeframes(['15m', '30m', '1H', '4H']);
    setBarsPerTf(20000);
    setStrategyScope('all');
    setCommissionBps(4);
    setSlippageBps(2);
    setMinRiskReward(1.5);
    setMinOosTrades(8);
    setPresetNotice(
      `Max-Accuracy settings applied (4 Assets × 4 Timeframes · up to 20,000 candles · All ${catalogStrategyCount.toLocaleString()} strategies · Min 8 unseen test trades). Click "Run Discovery Scan" to start.`
    );
  };

  const handleLaunchScan = async () => {
    setScanError(null);
    try {
      const res = await apiFetch('/api/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          timeframes: selectedTimeframes,
          barsPerTimeframe: barsPerTf,
          strategyScope,
          categories: strategyScope === 'category' ? [scopeCategory] : undefined,
          commissionBps,
          slippageBps,
          minRiskReward,
          minOosTradesForValidation: minOosTrades,
          minTotalSampleForValidation: Math.max(8, minOosTrades * 2 + 2),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to start scan (${res.status})`);
      }
      const data = (await res.json()) as { progress: DiscoveryScanProgress };
      setProgress(data.progress);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Unable to start discovery scan');
    }
  };

  const handleDeleteRun = async (id: string) => {
    const res = await apiFetch(`/api/discovery/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const d = (await res.json()) as { runs: DiscoveryRunSummary[] };
      setRuns(d.runs);
      if (activeRun?.id === id) {
        if (d.runs.length > 0) {
          void loadRunById(d.runs[0].id);
        } else {
          setActiveRun(null);
        }
      }
    }
  };

  const handleOpenCombination = async (combo: StrategyDiscoveryCombination) => {
    if (!activeRun) return;
    setInspectedCombo(combo);
    setDetailData(null);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const res = await apiFetch(
        `/api/discovery/runs/${encodeURIComponent(activeRun.id)}/combinations/${encodeURIComponent(combo.comboKey)}`
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to load combination detail (${res.status})`);
      }
      const d = (await res.json()) as CombinationDetailResult;
      setDetailData(d);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Unable to inspect combination');
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleJumpToChart = (
    sym: InstrumentSymbol,
    tf: Timeframe,
    signalTime: number,
    exitTime: number,
    tradeId: string
  ) => {
    selectSymbol(sym);
    selectTimeframe(tf);
    focusChartObject(tradeId, signalTime, exitTime);
    setInspectedCombo(null);
    onBackToTerminal();
  };

  const auditStats = useMemo(() => {
    if (!activeRun) {
      return { productionReadyCount: 0, verifyPaperCount: 0, overfitCount: 0 };
    }
    let productionReadyCount = 0;
    let verifyPaperCount = 0;
    let overfitCount = 0;
    for (const c of activeRun.combinations) {
      const a = deriveProductionAudit(c);
      if (a.readiness === 'Production Ready') productionReadyCount += 1;
      else if (a.readiness === 'Verify Paper') verifyPaperCount += 1;
      else if (a.readiness === 'Overfit / Decayed') overfitCount += 1;
    }
    return { productionReadyCount, verifyPaperCount, overfitCount };
  }, [activeRun]);

  const filteredCombinations = useMemo(() => {
    if (!activeRun) return [];
    const q = searchQuery.trim().toLowerCase();

    const matches = activeRun.combinations.filter((c) => {
      const audit = deriveProductionAudit(c);
      if (filterSymbol !== 'ALL' && c.symbol !== filterSymbol) return false;
      if (filterTimeframe !== 'ALL' && c.timeframe !== filterTimeframe) return false;
      if (filterCategory !== 'ALL' && c.strategy.category !== filterCategory) return false;
      if (filterRegime !== 'ALL' && c.regime !== filterRegime) return false;
      if (filterStatus !== 'ALL' && c.validationStatus !== filterStatus) return false;
      if (filterReadiness === 'HIDE_OVERFIT') {
        if (audit.readiness === 'Overfit / Decayed' || audit.readiness === 'Not Ready') {
          return false;
        }
      } else if (filterReadiness !== 'ALL' && audit.readiness !== filterReadiness) {
        return false;
      }
      if (
        q &&
        !c.strategy.name.toLowerCase().includes(q) &&
        !c.strategy.id.toLowerCase().includes(q) &&
        !c.symbol.toLowerCase().includes(q) &&
        !c.regime.toLowerCase().includes(q) &&
        !(c.bestSession ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    const sorted = [...matches].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'rank':
          cmp = a.rank - b.rank;
          break;
        case 'oosScore':
          cmp = a.oosScore - b.oosScore;
          break;
        case 'oosReturn':
          cmp = a.oosMetrics.netReturnPercent - b.oosMetrics.netReturnPercent;
          break;
        case 'oosPf':
          cmp = (a.oosMetrics.profitFactor ?? 0) - (b.oosMetrics.profitFactor ?? 0);
          break;
        case 'oosExpectancy':
          cmp = a.oosMetrics.expectancyR - b.oosMetrics.expectancyR;
          break;
        case 'oosWinRate':
          cmp = a.oosMetrics.winRate - b.oosMetrics.winRate;
          break;
        case 'oosDd':
          cmp = a.oosMetrics.maxDrawdownPercent - b.oosMetrics.maxDrawdownPercent;
          break;
        case 'oosTrades':
          cmp = a.oosMetrics.trades - b.oosMetrics.trades;
          break;
        case 'wfConsistency':
          cmp = a.wfConsistencyPercent - b.wfConsistencyPercent;
          break;
        case 'holdoutReturn':
          cmp = a.holdoutMetrics.netReturnPercent - b.holdoutMetrics.netReturnPercent;
          break;
      }
      return sortDesc ? -cmp : cmp;
    });

    return sorted;
  }, [
    activeRun,
    searchQuery,
    filterSymbol,
    filterTimeframe,
    filterCategory,
    filterRegime,
    filterStatus,
    filterReadiness,
    sortField,
    sortDesc,
  ]);

  const playbookEntries = useMemo(() => {
    if (!activeRun) return [];
    const q = searchQuery.trim().toLowerCase();
    const list = activeRun.combinations
      .map((c) => ({ combo: c, audit: deriveProductionAudit(c) }))
      .filter(({ combo, audit }) => {
        if (filterSymbol !== 'ALL' && combo.symbol !== filterSymbol) return false;
        if (filterTimeframe !== 'ALL' && combo.timeframe !== filterTimeframe) return false;
        if (filterCategory !== 'ALL' && combo.strategy.category !== filterCategory) return false;
        if (filterRegime !== 'ALL' && combo.regime !== filterRegime) return false;
        if (
          q &&
          !combo.strategy.name.toLowerCase().includes(q) &&
          !combo.strategy.id.toLowerCase().includes(q) &&
          !combo.symbol.toLowerCase().includes(q) &&
          !combo.regime.toLowerCase().includes(q) &&
          !(combo.bestSession ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
        if (audit.readiness === 'Production Ready') return true;
        if (includeVerifyPaper && audit.readiness === 'Verify Paper') return true;
        return false;
      });

    return list.sort((a, b) => {
      const aReady = a.audit.readiness === 'Production Ready' ? 1 : 0;
      const bReady = b.audit.readiness === 'Production Ready' ? 1 : 0;
      if (bReady !== aReady) return bReady - aReady;
      if (b.combo.oosScore !== a.combo.oosScore) return b.combo.oosScore - a.combo.oosScore;
      return b.combo.oosMetrics.expectancyR - a.combo.oosMetrics.expectancyR;
    });
  }, [
    activeRun,
    searchQuery,
    filterSymbol,
    filterTimeframe,
    filterCategory,
    filterRegime,
    includeVerifyPaper,
  ]);

  const playbookBlueprintGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        symbol: InstrumentSymbol;
        timeframe: Timeframe;
        htfTimeframe: Timeframe;
        top: (typeof playbookEntries)[number];
        strategyIds: BacktestStrategyId[];
      }
    >();
    for (const entry of playbookEntries) {
      const key = `${entry.combo.symbol}__${entry.combo.timeframe}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          symbol: entry.combo.symbol,
          timeframe: entry.combo.timeframe,
          htfTimeframe: entry.combo.htfTimeframe,
          top: entry,
          strategyIds: [entry.combo.strategy.id],
        });
      } else if (
        !existing.strategyIds.includes(entry.combo.strategy.id) &&
        existing.strategyIds.length < 4
      ) {
        existing.strategyIds.push(entry.combo.strategy.id);
      }
    }
    return Array.from(map.values());
  }, [playbookEntries]);

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

  const isComboArmed = useCallback(
    (sym: InstrumentSymbol, tf: Timeframe, strategyId: BacktestStrategyId): boolean =>
      armedSlots.some(
        (slot) =>
          slot.symbol === sym &&
          slot.timeframe === tf &&
          slot.strategies.some((s) => s.id === strategyId)
      ),
    [armedSlots]
  );

  const buildSlotsFromCombinations = useCallback(
    (combos: StrategyDiscoveryCombination[]): LiveStrategyBasketSlot[] => {
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
            sourceRunId: activeRun?.id,
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
      return Array.from(slotMap.values()).slice(0, 12);
    },
    [activeRun?.id]
  );

  const activeScreenCombos = useMemo<StrategyDiscoveryCombination[]>(() => {
    if (viewTab === 'playbook') {
      return playbookEntries.map((e) => e.combo);
    }
    if (filterReadiness === 'Overfit / Decayed') {
      return filteredCombinations;
    }
    return filteredCombinations.filter(
      (c) => deriveProductionAudit(c).readiness !== 'Overfit / Decayed'
    );
  }, [viewTab, playbookEntries, filteredCombinations, filterReadiness]);

  const activeScreenSlots = useMemo(
    () => buildSlotsFromCombinations(activeScreenCombos),
    [buildSlotsFromCombinations, activeScreenCombos]
  );

  const handleToggleComboInSignals = async (combo: StrategyDiscoveryCombination) => {
    setActivatingBasketKey(combo.comboKey);
    setBasketFeedback(null);
    try {
      if (isComboArmed(combo.symbol, combo.timeframe, combo.strategy.id)) {
        await removeBasketItem(combo.symbol, combo.timeframe, combo.strategy.id);
        setBasketFeedback(
          `Removed "${combo.strategy.name}" (${combo.symbol} ${combo.timeframe}) from Main Signals.`
        );
        return;
      }
      const slots = buildSlotsFromCombinations([combo]);
      const lead = slots[0];
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: lead.symbol,
        timeframe: lead.timeframe,
        htfTimeframe: lead.htfTimeframe,
        strategyIds: [combo.strategy.id],
        assignments: slots,
        selectionLabel: `${combo.symbol} ${combo.timeframe} — ${combo.strategy.name}`,
        maxConcurrentPositions: 4,
        minRiskReward: activeRun?.config.minRiskReward ?? 1.5,
        sourceRunId: activeRun?.id,
        mode: 'merge',
      });
      setBasketFeedback(
        `Added "${combo.strategy.name}" (${combo.symbol} ${combo.timeframe}) to Main Signals (${basket?.strategies.length ?? 1} total armed).`
      );
    } catch (err) {
      setBasketFeedback(
        err instanceof Error ? err.message : 'Unable to update Main Signals basket'
      );
    } finally {
      setActivatingBasketKey(null);
    }
  };

  const handleActivateBasket = async (group: (typeof playbookBlueprintGroups)[number]) => {
    setActivatingBasketKey(group.key);
    setBasketFeedback(null);
    try {
      const slotCombos = playbookEntries
        .filter((e) => e.combo.symbol === group.symbol && e.combo.timeframe === group.timeframe)
        .map((e) => e.combo);
      const assignments = buildSlotsFromCombinations(slotCombos);
      const strategyIds = Array.from(
        new Set(assignments.flatMap((slot) => slot.strategies.map((s) => s.id)))
      );
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: group.symbol,
        timeframe: group.timeframe,
        htfTimeframe: group.htfTimeframe,
        strategyIds,
        assignments,
        selectionLabel: `${group.symbol} ${group.timeframe} (${group.top.audit.readiness})`,
        maxConcurrentPositions: Math.min(8, Math.max(2, assignments.length)),
        minRiskReward: activeRun?.config.minRiskReward ?? 1.5,
        sourceRunId: activeRun?.id,
        mode: 'merge',
      });
      setBasketFeedback(
        `Added ${group.symbol} ${group.timeframe} (${group.strategyIds.length} strateg${group.strategyIds.length === 1 ? 'y' : 'ies'}) to Main Signals (${basket?.assignments?.length ?? 1} total slot(s) active).`
      );
    } catch (err) {
      setBasketFeedback(
        err instanceof Error ? err.message : 'Unable to add slot to Main Signals'
      );
    } finally {
      setActivatingBasketKey(null);
    }
  };

  const handleArmAllFiltered = async (mode: 'merge' | 'replace' = 'merge') => {
    if (!activeRun || activeScreenCombos.length === 0) {
      setBasketFeedback('No filtered strategies available to add under current filters.');
      return;
    }
    const actionKey = mode === 'merge' ? 'all_filtered_merge' : 'all_filtered_replace';
    setActivatingBasketKey(actionKey);
    setBasketFeedback(null);
    try {
      const assignments = activeScreenSlots;
      if (assignments.length === 0) {
        setBasketFeedback('No valid filtered strategies found to add.');
        return;
      }
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
        filters: {
          source: 'discovery_filtered',
          runId: activeRun.id,
          symbols: filterSymbol !== 'ALL' ? [filterSymbol] : undefined,
          timeframes: filterTimeframe !== 'ALL' ? [filterTimeframe] : undefined,
          categories: filterCategory !== 'ALL' ? [filterCategory] : undefined,
          readinessMode: includeVerifyPaper ? 'INCLUDE_VERIFY_PAPER' : 'PRODUCTION_READY_ONLY',
          avoidPoorRegimes: true,
          requireHtfAlignment: true,
          minRiskReward: activeRun.config.minRiskReward ?? 1.5,
        },
        selectionLabel:
          assignments.length > 1
            ? `${assignments.length} Filtered Slots · ${strategyIds.length} Strategies`
            : `${lead.symbol} ${lead.timeframe} · ${strategyIds.length} Strategies`,
        maxConcurrentPositions: Math.min(8, Math.max(2, assignments.length)),
        minRiskReward: activeRun.config.minRiskReward ?? 1.5,
        sourceRunId: activeRun.id,
        mode,
      });
      setBasketFeedback(
        `${mode === 'merge' ? 'Added' : 'Replaced'} Main Signals with ${strategyIds.length} filtered strateg${strategyIds.length === 1 ? 'y' : 'ies'} across ${assignments.length} slot(s). Total armed: ${basket?.strategies.length ?? strategyIds.length} across ${basket?.assignments?.length ?? assignments.length} slot(s).`
      );
    } catch (err) {
      setBasketFeedback(
        err instanceof Error ? err.message : 'Unable to add filtered Discovery strategies'
      );
    } finally {
      setActivatingBasketKey(null);
    }
  };

  const handleExportPlaybookCsv = () => {
    if (playbookEntries.length === 0) return;
    const escapeCsv = (val: string | number) => {
      const str = String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };
    const headers = [
      'Rank',
      'Readiness',
      'Strategy',
      'Category',
      'Asset',
      'Timeframe',
      'HTF',
      'Best Market Condition',
      'Weak Market Conditions to Avoid',
      'Best Trading Session (UTC)',
      'Sessions to Avoid',
      'OOS Score',
      'OOS Risk:Reward',
      'OOS Expectancy (R)',
      'OOS Return %',
      'OOS Win %',
      'OOS MaxDD %',
      'WF Consistency %',
      'Holdout Trades',
      'Holdout Return %',
      'Edge Confidence %',
    ];
    const rows = playbookEntries.map(({ combo, audit }) => [
      combo.rank,
      audit.readiness,
      combo.strategy.name,
      combo.strategy.category,
      combo.symbol,
      combo.timeframe,
      combo.htfTimeframe,
      combo.regime,
      combo.poorRegimes.map((p) => p.regime).join(' | ') || 'None',
      combo.bestSession ?? 'Inspect Modal',
      combo.avoidSessions?.join(' | ') || 'None',
      combo.oosScore,
      formatRiskRewardRatio(combo.oosMetrics).ratioText,
      combo.oosMetrics.expectancyR,
      combo.oosMetrics.netReturnPercent,
      combo.oosMetrics.winRate,
      combo.oosMetrics.maxDrawdownPercent,
      combo.wfConsistencyPercent,
      combo.holdoutMetrics.trades,
      combo.holdoutMetrics.netReturnPercent,
      audit.edgeConfidencePercent,
    ]);
    const csv = [headers, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `production-playbook-${activeRun?.id ?? 'scan'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const heatmapCombinations = useMemo(() => {
    if (!activeRun) return [];
    const q = searchQuery.trim().toLowerCase();
    return activeRun.combinations.filter((c) => {
      const audit = deriveProductionAudit(c);
      if (filterCategory !== 'ALL' && c.strategy.category !== filterCategory) return false;
      if (filterStatus !== 'ALL' && c.validationStatus !== filterStatus) return false;
      if (filterReadiness === 'HIDE_OVERFIT') {
        if (audit.readiness === 'Overfit / Decayed' || audit.readiness === 'Not Ready') {
          return false;
        }
      } else if (filterReadiness !== 'ALL' && audit.readiness !== filterReadiness) {
        return false;
      }
      if (
        q &&
        !c.strategy.name.toLowerCase().includes(q) &&
        !c.strategy.id.toLowerCase().includes(q) &&
        !c.symbol.toLowerCase().includes(q) &&
        !c.regime.toLowerCase().includes(q) &&
        !(c.bestSession ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [activeRun, searchQuery, filterCategory, filterStatus, filterReadiness]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDesc((prev) => !prev);
    } else {
      setSortField(field);
      setSortDesc(field !== 'rank' && field !== 'oosDd');
    }
  };

  // Grouping helpers for Dedicated Views 2, 3, 4
  const byInstrumentGroups = useMemo(() => {
    const syms = activeRun?.config.symbols ?? ALL_SYMBOLS;
    return syms.map((sym) => ({
      symbol: sym,
      topCombos: filteredCombinations.filter((c) => c.symbol === sym).slice(0, 6),
    }));
  }, [activeRun, filteredCombinations]);

  const byTimeframeGroups = useMemo(() => {
    const tfs = activeRun?.config.timeframes ?? ['15m', '1H', '4H'];
    return tfs.map((tf) => ({
      timeframe: tf,
      topCombos: filteredCombinations.filter((c) => c.timeframe === tf).slice(0, 6),
    }));
  }, [activeRun, filteredCombinations]);

  const byRegimeGroups = useMemo(() => {
    const regimes: MarketRegimeType[] = [
      'Trending',
      'Ranging',
      'High Volatility',
      'Low Volatility',
      'Transitional',
    ];
    return regimes.map((regime) => ({
      regime,
      topCombos: filteredCombinations.filter((c) => c.regime === regime).slice(0, 6),
    }));
  }, [filteredCombinations]);

  const timeframeBarChartData = useMemo(() => {
    return byTimeframeGroups.map((g) => {
      const top = g.topCombos[0];
      return {
        timeframe: g.timeframe,
        oosScore: top?.oosScore ?? 0,
        oosExpectancy: top?.oosMetrics.expectancyR ?? 0,
        label: top ? `${top.strategy.name} (${top.symbol} · ${top.regime})` : 'No sample',
      };
    });
  }, [byTimeframeGroups]);

  const progressPct =
    progress.totalSteps > 0
      ? Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100))
      : 0;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-[#0B0E14] text-[#E6EDF3]">
      {/* Page Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] bg-[#12161F] px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-[#38BDF8]" />
            <h1 className="text-sm font-bold tracking-tight text-[#E6EDF3]">
              Best Strategy Discovery & Optimization Scanner
            </h1>
            <span className="text-[#30363D]">·</span>
            <span className="text-[11px] text-[#8B949E]">
              Real History Backtester · Tests Unseen Data & Time Consistency (Zero AI · Honest Results)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {runs.length > 0 && (
            <div className="flex items-center gap-1">
              <select
                value={activeRun?.id ?? ''}
                onChange={(e) => {
                  if (e.target.value) void loadRunById(e.target.value);
                }}
                className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1 font-mono text-[11px] text-[#C9D1D9] outline-none"
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString('en-GB', {
                      month: 'short',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {r.validatedCount} Verified / {r.preliminaryCount} Promising ({r.strategiesEvaluatedCount} strats)
                  </option>
                ))}
              </select>
              {activeRun && (
                <button
                  type="button"
                  onClick={() => void handleDeleteRun(activeRun.id)}
                  title="Delete selected scan"
                  className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowGlossaryGuide((v) => !v)}
            className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
              showGlossaryGuide
                ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                : 'border-[#222938] bg-[#0B0E14] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>Simple Words Guide</span>
          </button>

          <button
            type="button"
            onClick={onBackToTerminal}
            className="border border-[#222938] bg-[#0B0E14] px-3 py-1 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Back to Live Terminal
          </button>
        </div>
      </div>

      {/* Collapsible Simple Words Guide */}
      {showGlossaryGuide && (
        <div className="border-b border-[#38BDF8]/40 bg-[#0F141D] px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#38BDF8]">
              <BookOpen className="h-4 w-4" />
              <span>Simple Words Guide — What Every Term Means</span>
            </div>
            <button
              type="button"
              onClick={() => setShowGlossaryGuide(false)}
              className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2.5">
            {Object.values(DISCOVERY_GLOSSARY).map((item) => (
              <div key={item.term} className="border border-[#222938] bg-[#12161F] p-2.5">
                <div className="text-[11px] font-semibold text-[#E6EDF3]">{item.term}</div>
                <div className="text-[10px] font-medium text-[#38BDF8] mt-0.5">{item.simpleName}</div>
                <p className="mt-1 text-[11px] leading-snug text-[#8B949E]">{item.explanation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scanner Launcher Configuration Strip */}
      <div className="border-b border-[#222938] bg-[#12161F]/70 px-5 py-3 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* Instruments */}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                Assets (Coins & Metals)
              </div>
              <div className="flex items-center gap-1">
                {ALL_SYMBOLS.map((sym) => {
                  const active = selectedSymbols.includes(sym);
                  return (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleToggleSymbol(sym)}
                      className={`border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        active
                          ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                          : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                      }`}
                    >
                      {sym}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Timeframes */}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                Chart Timeframes
              </div>
              <div className="flex items-center gap-1">
                {DISCOVERY_TIMEFRAMES.map((tf) => {
                  const active = selectedTimeframes.includes(tf);
                  return (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => handleToggleTimeframe(tf)}
                      className={`border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        active
                          ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                          : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                      }`}
                    >
                      {tf}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Strategy Scope */}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                Strategies to Test
              </div>
              <div className="flex items-center gap-1">
                <select
                  value={strategyScope}
                  onChange={(e) => setStrategyScope(e.target.value as DiscoveryStrategyScope)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                >
                  <option value="core">Best Core Suite (~125)</option>
                  <option value="category">Single Category Sweep</option>
                  <option value="all">All {catalogStrategyCount.toLocaleString()} Strategies</option>
                </select>
                {strategyScope === 'category' && (
                  <select
                    value={scopeCategory}
                    onChange={(e) =>
                      setScopeCategory(e.target.value as BacktestStrategyCategory)
                    }
                    className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
                  >
                    {CATEGORIES.filter((c) => c !== 'ALL').map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Bars / Costs / Min OOS Sample */}
            <div className="flex flex-wrap items-end gap-2.5">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                  Past Candles
                </div>
                <select
                  value={barsPerTf}
                  onChange={(e) => setBarsPerTf(Number(e.target.value))}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none"
                >
                  <option value={500}>500</option>
                  <option value={1500}>1,500</option>
                  <option value={4000}>4,000</option>
                  <option value={10000}>10,000</option>
                  <option value={15000}>15,000</option>
                  <option value={20000}>20,000 (Max)</option>
                </select>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                  <span>Fees / Slippage</span>
                  <HintBadge termKey="costs" />
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={commissionBps}
                    onChange={(e) => setCommissionBps(Number(e.target.value) || 0)}
                    className="w-12 border border-[#222938] bg-[#0B0E14] px-1.5 py-1 font-mono text-xs text-[#E6EDF3] outline-none tabular-nums"
                  />
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={slippageBps}
                    onChange={(e) => setSlippageBps(Number(e.target.value) || 0)}
                    className="w-12 border border-[#222938] bg-[#0B0E14] px-1.5 py-1 font-mono text-xs text-[#E6EDF3] outline-none tabular-nums"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                  <span>Min R:R / Min Test Trades</span>
                  <HintBadge termKey="minRrSample" align="right" />
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step={0.1}
                    min={1}
                    max={5}
                    value={minRiskReward}
                    onChange={(e) => setMinRiskReward(Number(e.target.value) || 1.5)}
                    className="w-14 border border-[#222938] bg-[#0B0E14] px-1.5 py-1 font-mono text-xs text-[#E6EDF3] outline-none tabular-nums"
                  />
                  <input
                    type="number"
                    min={2}
                    max={30}
                    value={minOosTrades}
                    onChange={(e) => setMinOosTrades(Number(e.target.value) || 4)}
                    className="w-12 border border-[#222938] bg-[#0B0E14] px-1.5 py-1 font-mono text-xs text-[#E6EDF3] outline-none tabular-nums"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleApplyMaxAccuracyPreset}
              className="inline-flex items-center gap-1.5 border border-[#38BDF8]/50 bg-[#161B26] px-3 py-1.5 text-xs font-medium text-[#38BDF8] hover:border-[#38BDF8] hover:text-white whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Max-Accuracy Preset</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAccuracyGuide((v) => !v)}
              className={`inline-flex items-center gap-1 border px-2.5 py-1.5 text-xs whitespace-nowrap cursor-pointer ${
                showAccuracyGuide
                  ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                  : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Accuracy Guide</span>
            </button>

            <button
              type="button"
              disabled={progress.status === 'running'}
              onClick={() => void handleLaunchScan()}
              className={`flex items-center gap-2 border px-4 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                progress.status === 'running'
                  ? 'border-[#38BDF8]/50 bg-[#161B26] text-[#38BDF8] opacity-80'
                  : 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81] hover:bg-[#0ECB81]/25'
              }`}
            >
              {progress.status === 'running' ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Scanning ({progressPct}%)</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  <span>Run Discovery Scan</span>
                </>
              )}
            </button>
          </div>
        </div>

        {presetNotice && (
          <div className="flex items-center justify-between gap-2 border border-[#38BDF8]/40 bg-[#0B0E14] px-3 py-1.5 text-[11px] text-[#38BDF8]">
            <span>{presetNotice}</span>
            <button
              type="button"
              onClick={() => setPresetNotice(null)}
              className="text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {showAccuracyGuide && (
          <div className="border border-[#222938] bg-[#0B0E14] p-3 text-[11px] text-[#C9D1D9] grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <div className="font-semibold text-[#0ECB81]">1. Use Up to 20,000 Candles + Min 8 Test Trades</div>
              <div className="mt-0.5 text-[#8B949E]">
                Short 900-candle scans produce 4–6 trades where lucky winners rank high. 20,000 candles gives dozens of trades per split (crypto loads full 20,000 bars; metals load max broker bars).
              </div>
            </div>
            <div>
              <div className="font-semibold text-[#38BDF8]">2. Strict Limit Retest Fills</div>
              <div className="mt-0.5 text-[#8B949E]">
                Limit orders now require price to touch exact entryPrice (no phantom zone-edge fills) and subtract fees + slippage.
              </div>
            </div>
            <div>
              <div className="font-semibold text-[#F59E0B]">3. Watch Overfit / Decayed</div>
              <div className="mt-0.5 text-[#8B949E]">
                Strategies that pass Unseen Test (OOS) but lose in the untouched Final Check are automatically flagged as Overfit / Decayed.
              </div>
            </div>
            <div>
              <div className="font-semibold text-[#E6EDF3]">4. Trade Only Best Session + Mood</div>
              <div className="mt-0.5 text-[#8B949E]">
                Each winner lists its Best Market Condition AND Best UTC Trading Time — avoid weak sessions & conditions shown.
              </div>
            </div>
          </div>
        )}

        {/* Live Scan Progress Bar */}
        {progress.status === 'running' && (
          <div className="border border-[#222938] bg-[#0B0E14] px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#38BDF8] font-medium">{progress.message}</span>
              <span className="font-mono tabular-nums text-[#8B949E]">
                Step {progress.completedSteps}/{progress.totalSteps} ({progressPct}%)
              </span>
            </div>
            <div className="h-1.5 w-full bg-[#161B26] overflow-hidden">
              <div
                className="h-full bg-[#38BDF8] transition-all duration-300"
                style={{ width: `${Math.max(4, progressPct)}%` }}
              />
            </div>
          </div>
        )}

        {(scanError || progress.status === 'failed') && (
          <div className="border border-[#F6465D]/50 bg-[#0B0E14] px-3 py-2 text-xs text-[#F6465D]">
            {scanError ?? progress.error ?? 'Scan failed'}
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-5 space-y-4">
        {loadingRun && (
          <div className="border border-[#222938] bg-[#12161F] p-10 text-center text-xs text-[#8B949E]">
            Loading persisted optimization results...
          </div>
        )}

        {!loadingRun && !activeRun && (
          <div className="border border-[#222938] bg-[#12161F] p-8 max-w-4xl mx-auto space-y-4">
            <div className="flex items-center gap-2.5 text-sm font-semibold text-[#E6EDF3]">
              <ShieldCheck className="h-5 w-5 text-[#0ECB81]" />
              <span>How the Strategy Discovery Scanner Finds Real Winners</span>
            </div>
            <p className="text-xs leading-relaxed text-[#C9D1D9]">
              This tool tests real SMC, Price Action, Chart Pattern, Support/Resistance, and Hybrid
              strategies on real past candles for each coin/metal and timeframe. It checks which
              market condition (Trending, Ranging, High/Low Volatility, or Shifting) each setup
              actually wins in — using pure math with zero future peeking.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-[11px]">
              <div className="border border-[#222938] bg-[#0B0E14] p-3">
                <div className="font-mono text-[#38BDF8] font-semibold">1 · TRAINING (50%)</div>
                <div className="mt-1 text-[#8B949E]">
                  Older half of price history. Shows how the strategy starts out on baseline data.
                </div>
              </div>
              <div className="border border-[#222938] bg-[#0B0E14] p-3">
                <div className="font-mono text-[#0ECB81] font-semibold">2 · UNSEEN TEST (25%)</div>
                <div className="mt-1 text-[#8B949E]">
                  Fresh middle data kept separate. Setups are ranked here so lucky past fits do not win.
                </div>
              </div>
              <div className="border border-[#222938] bg-[#0B0E14] p-3">
                <div className="font-mono text-[#F59E0B] font-semibold">3 · 4 TIME WINDOWS</div>
                <div className="mt-1 text-[#8B949E]">
                  Checks 4 rolling periods across time to confirm steady profits, not one lucky week.
                </div>
              </div>
              <div className="border border-[#222938] bg-[#0B0E14] p-3">
                <div className="font-mono text-[#C9D1D9] font-semibold">4 · FINAL CHECK (25%)</div>
                <div className="mt-1 text-[#8B949E]">
                  Most recent candles locked until the end for an honest check — never used to pick winners.
                </div>
              </div>
            </div>
            <div>
              <button
                type="button"
                disabled={progress.status === 'running'}
                onClick={() => void handleLaunchScan()}
                className="inline-flex items-center gap-2 border border-[#0ECB81] bg-[#0ECB81]/15 px-4 py-2 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" />
                <span>Start Discovery Scan</span>
              </button>
            </div>
          </div>
        )}

        {!loadingRun && activeRun && (
          <>
            {/* Summary Metrics Strip */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
              <div className="border border-[#0ECB81]/40 bg-[#12161F] px-3.5 py-2.5">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#0ECB81]">
                  <span>Production Ready</span>
                  <HintBadge termKey="productionReadiness" align="left" />
                </div>
                <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#0ECB81]">
                  {auditStats.productionReadyCount}
                </div>
                <div className="text-[10px] text-[#8B949E]">
                  Passed Test + WF + Final Check
                </div>
              </div>

              <div className="border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#F59E0B]">
                  <span>Verify Paper</span>
                  <HintBadge termKey="productionReadiness" />
                </div>
                <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#F59E0B]">
                  {auditStats.verifyPaperCount}
                </div>
                <div className="text-[10px] text-[#8B949E]">Strong OOS · Few Final trades</div>
              </div>

              <div className="border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#F6465D]">
                  <span>Overfit / Decayed</span>
                  <HintBadge termKey="holdout" />
                </div>
                <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#F6465D]">
                  {auditStats.overfitCount}
                </div>
                <div className="text-[10px] text-[#8B949E]">Failed Final Check — Skip</div>
              </div>

              <div className="border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                  <span>Top Setup (Unseen Test)</span>
                  <HintBadge termKey="oos" />
                </div>
                <div className="mt-1 truncate font-mono text-xs font-semibold text-[#38BDF8]">
                  {activeRun.combinations[0]
                    ? `${activeRun.combinations[0].symbol} ${activeRun.combinations[0].timeframe} · ${activeRun.combinations[0].regime}`
                    : 'None'}
                </div>
                <div className="truncate text-[11px] text-[#C9D1D9]">
                  {activeRun.combinations[0]?.strategy.name ?? 'No qualifying setups'}
                </div>
              </div>

              <div className="border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
                <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                  Scanned Coverage
                </div>
                <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#E6EDF3]">
                  {activeRun.summaryStats.instrumentsScanned.length}×
                  {activeRun.summaryStats.timeframesScanned.length}
                </div>
                <div className="text-[10px] text-[#8B949E]">
                  {activeRun.strategiesEvaluatedCount} strats · {activeRun.config.barsPerTimeframe} bars
                </div>
              </div>

              <div className="border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                  <span>Data Split & Time</span>
                  <HintBadge termKey="holdout" align="right" />
                </div>
                <div className="mt-1 font-mono text-xs font-semibold tabular-nums text-[#38BDF8]">
                  50% Train · 25% Test · 25% Final
                </div>
                <div className="text-[10px] text-[#8B949E]">
                  Finished in {(activeRun.durationMs / 1000).toFixed(1)}s · Min{' '}
                  {activeRun.config.minOosTradesForValidation} OOS
                </div>
              </div>
            </div>

            {/* Interactive D3.js Asset × Timeframe Performance Heatmap */}
            <PerformanceHeatmapD3
              combinations={heatmapCombinations}
              scannedSymbols={activeRun.config.symbols}
              scannedTimeframes={activeRun.config.timeframes}
              onSelectCombination={(combo) => void handleOpenCombination(combo)}
            />

            {/* Dedicated 5-View Tabs + Multi-Dimensional Filters */}
            <div className="flex flex-wrap items-center justify-between gap-3 border border-[#222938] bg-[#12161F] px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    ['playbook', '0 · Final Production Playbook'],
                    ['overall', '1 · Best Overall Setups'],
                    ['instrument', '2 · Best per Asset'],
                    ['timeframe', '3 · Best per Timeframe'],
                    ['regime', '4 · Best per Market Condition'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setViewTab(key)}
                    className={`border px-2.5 py-1 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      viewTab === key
                        ? key === 'playbook'
                          ? 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81]'
                          : 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B949E]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search strategy, coin, session..."
                    className="w-48 border border-[#222938] bg-[#0B0E14] pl-7 pr-2 py-1 text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                  />
                </div>

                <select
                  value={filterSymbol}
                  onChange={(e) => setFilterSymbol(e.target.value as 'ALL' | InstrumentSymbol)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  <option value="ALL">All Assets</option>
                  {ALL_SYMBOLS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                <select
                  value={filterTimeframe}
                  onChange={(e) => setFilterTimeframe(e.target.value as 'ALL' | Timeframe)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  <option value="ALL">All Timeframes</option>
                  {DISCOVERY_TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>

                <select
                  value={filterCategory}
                  onChange={(e) =>
                    setFilterCategory(e.target.value as 'ALL' | BacktestStrategyCategory)
                  }
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c === 'ALL' ? 'All Categories' : c}
                    </option>
                  ))}
                </select>

                <select
                  value={filterRegime}
                  onChange={(e) => setFilterRegime(e.target.value as 'ALL' | MarketRegimeType)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  {REGIMES.map((r) => (
                    <option key={r} value={r}>
                      {r === 'ALL' ? 'All Market Conditions' : r}
                    </option>
                  ))}
                </select>

                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as 'ALL' | ValidationStatus)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  {VALIDATION_FILTERS.map((st) => (
                    <option key={st} value={st}>
                      {st === 'ALL' ? 'All Trust Levels' : SimpleValidationLabel(st)}
                    </option>
                  ))}
                </select>

                <select
                  value={filterReadiness}
                  onChange={(e) => setFilterReadiness(e.target.value as ReadinessFilter)}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#C9D1D9] outline-none"
                >
                  <option value="ALL">All Readiness</option>
                  <option value="Production Ready">Production Ready Only</option>
                  <option value="HIDE_OVERFIT">Hide Overfit & Not Ready</option>
                  <option value="Verify Paper">Verify Paper</option>
                  <option value="Overfit / Decayed">Overfit / Decayed</option>
                </select>
              </div>
            </div>

            {/* Persistent Add-Filtered-Strategies-to-Main-Signals Action Bar (Works Across All 5 Tabs) */}
            <div className="flex flex-wrap items-center justify-between gap-2 border border-[#222938] bg-[#12161F] px-3.5 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-[#C9D1D9]">
                <Radio className="h-3.5 w-3.5 text-[#0ECB81]" />
                <span>
                  <strong className="font-mono text-[#E6EDF3] tabular-nums">
                    {activeScreenCombos.length}
                  </strong>{' '}
                  filtered setup{activeScreenCombos.length === 1 ? '' : 's'} across{' '}
                  <strong className="font-mono text-[#38BDF8] tabular-nums">
                    {activeScreenSlots.length}
                  </strong>{' '}
                  Asset/TF slot{activeScreenSlots.length === 1 ? '' : 's'}
                </span>
                {liveStrategyBasket && (
                  <span className="font-mono text-[11px] text-[#0ECB81] tabular-nums">
                    · Main Signals Armed: {liveStrategyBasket.strategies.length} strats ({armedSlots.length} slots)
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={activeScreenSlots.length === 0 || activatingBasketKey !== null}
                  onClick={() => void handleArmAllFiltered('merge')}
                  className="inline-flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-40 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>
                    {activatingBasketKey === 'all_filtered_merge'
                      ? 'Adding...'
                      : `Add Filtered to Main Signals (${activeScreenSlots.length} Slots)`}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={activeScreenSlots.length === 0 || activatingBasketKey !== null}
                  onClick={() => void handleArmAllFiltered('replace')}
                  className="border border-[#2B3548] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#F59E0B] hover:text-[#F59E0B] disabled:opacity-40 cursor-pointer"
                >
                  {activatingBasketKey === 'all_filtered_replace'
                    ? 'Replacing...'
                    : 'Replace Main Signals'}
                </button>
                {onOpenSignals && (
                  <button
                    type="button"
                    onClick={onOpenSignals}
                    className="border border-[#38BDF8]/60 bg-[#161B26] px-2.5 py-1 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                  >
                    Open Main Signals →
                  </button>
                )}
              </div>
            </div>

            {basketFeedback && viewTab !== 'playbook' && (
              <div className="border border-[#0ECB81]/50 bg-[#0B0E14] px-3.5 py-2 text-xs text-[#0ECB81] flex flex-wrap items-center justify-between gap-2">
                <span>{basketFeedback}</span>
                <div className="flex items-center gap-3">
                  {onOpenSignals && (
                    <button
                      type="button"
                      onClick={onOpenSignals}
                      className="font-semibold underline hover:text-white cursor-pointer"
                    >
                      Open Main Signals
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onBackToTerminal}
                    className="font-semibold underline hover:text-white cursor-pointer"
                  >
                    Open Live Terminal
                  </button>
                </div>
              </div>
            )}

            {/* Market Coverage Errors if any provider failed */}
            {activeRun.marketCoverage.some((m) => m.error) && (
              <div className="border border-[#F59E0B]/40 bg-[#12161F] px-3.5 py-2 text-[11px] text-[#F59E0B] flex flex-wrap items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>Partial feed warning:</span>
                {activeRun.marketCoverage
                  .filter((m) => m.error)
                  .map((m) => (
                    <span key={`${m.symbol}-${m.timeframe}`} className="font-mono">
                      {m.symbol} {m.timeframe} ({m.error})
                    </span>
                  ))}
              </div>
            )}

            {/* VIEW 0: FINAL PRODUCTION PLAYBOOK (Strategy + Asset + Timeframe + Market Condition + Time/Session) */}
            {viewTab === 'playbook' && (
              <div className="space-y-4">
                <div className="border border-[#0ECB81]/40 bg-[#12161F] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-[#E6EDF3]">
                        <Award className="h-4 w-4 text-[#0ECB81]" />
                        <span>
                          Final Production Playbook — Strategy × Asset × Timeframe × Market × Trading Time
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-[#8B949E]">
                        Shows only setups that passed Training, Unseen Test, Walk-Forward Consistency AND stayed profitable in the untouched Final Check (Holdout). Overfit setups are excluded automatically.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#C9D1D9] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeVerifyPaper}
                          onChange={(e) => setIncludeVerifyPaper(e.target.checked)}
                          className="accent-[#F59E0B]"
                        />
                        <span>Include Verify Paper ({auditStats.verifyPaperCount})</span>
                      </label>

                      <button
                        type="button"
                        disabled={playbookEntries.length === 0 || activatingBasketKey !== null}
                        onClick={() => void handleArmAllFiltered('merge')}
                        className="inline-flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2.5 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-40 cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>
                          {activatingBasketKey === 'all_filtered_merge'
                            ? 'Adding...'
                            : `Add Filtered (${playbookBlueprintGroups.length} Slots)`}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={playbookEntries.length === 0}
                        onClick={handleExportPlaybookCsv}
                        className="inline-flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white disabled:opacity-40 cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Export CSV ({playbookEntries.length})</span>
                      </button>
                    </div>
                  </div>

                  {basketFeedback && (
                    <div className="border border-[#0ECB81]/50 bg-[#0B0E14] px-3 py-2 text-xs text-[#0ECB81] flex items-center justify-between">
                      <span>{basketFeedback}</span>
                      <button
                        type="button"
                        onClick={onBackToTerminal}
                        className="font-semibold underline hover:text-white cursor-pointer"
                      >
                        Open Live Terminal
                      </button>
                    </div>
                  )}

                  {activeRun.config.barsPerTimeframe < 4000 && (
                    <div className="border border-[#F59E0B]/40 bg-[#0B0E14] px-3 py-2 text-[11px] text-[#F59E0B] flex flex-wrap items-center justify-between gap-2">
                      <span>
                        Current scan used only <strong>{activeRun.config.barsPerTimeframe.toLocaleString()} candles</strong> and Min{' '}
                        <strong>{activeRun.config.minOosTradesForValidation} test trades</strong>. For highest statistical accuracy, click <strong>Max-Accuracy Preset</strong> above (up to 20,000 candles · All 1,169+ strategies · Min 8 unseen test trades) and run a new scan.
                      </span>
                      <button
                        type="button"
                        onClick={handleApplyMaxAccuracyPreset}
                        className="border border-[#F59E0B]/60 bg-[#161B26] px-2 py-0.5 font-semibold text-[#F59E0B] hover:text-white cursor-pointer"
                      >
                        Load Max-Accuracy Preset
                      </button>
                    </div>
                  )}

                  {/* Per Asset × Timeframe Blueprint Summary + Live Auto-Run */}
                  {playbookBlueprintGroups.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5 pt-1">
                      {playbookBlueprintGroups.map((grp) => {
                        const isLiveActive =
                          liveStrategyBasket?.enabled &&
                          liveStrategyBasket.symbol === grp.symbol &&
                          liveStrategyBasket.timeframe === grp.timeframe;
                        return (
                          <div
                            key={grp.key}
                            className="border border-[#222938] bg-[#0B0E14] p-3 flex flex-col justify-between gap-2"
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-xs font-bold text-[#E6EDF3]">
                                  {grp.symbol}{' '}
                                  <span className="text-[#38BDF8]">{grp.timeframe}</span>
                                </span>
                                <span
                                  className={`font-mono text-[10px] font-semibold ${readinessText(grp.top.audit.readiness)}`}
                                >
                                  {grp.top.audit.readiness}
                                </span>
                              </div>
                              <div className="mt-1 truncate text-xs font-medium text-[#E6EDF3]">
                                {grp.top.combo.strategy.name}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[#8B949E]">
                                <span>
                                  Mood:{' '}
                                  <strong className="text-[#C9D1D9]">
                                    {grp.top.combo.regime}
                                  </strong>
                                </span>
                                <span>·</span>
                                <span>
                                  Time:{' '}
                                  <strong className="text-[#38BDF8]">
                                    {grp.top.combo.bestSession ?? 'Check Modal'}
                                  </strong>
                                </span>
                              </div>
                              <div className="mt-1 font-mono text-[11px] tabular-nums text-[#38BDF8]">
                                R:R {formatRiskRewardRatio(grp.top.combo.oosMetrics).ratioText} ·{' '}
                                <span className="text-[#C9D1D9]">
                                  {grp.top.combo.oosMetrics.winRate.toFixed(0)}% Win
                                </span>
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#0ECB81]">
                                Test {grp.top.combo.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                                {grp.top.combo.oosMetrics.netReturnPercent.toFixed(1)}% · Final{' '}
                                {grp.top.combo.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}
                                {grp.top.combo.holdoutMetrics.netReturnPercent.toFixed(1)}%
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1B2230]">
                              <button
                                type="button"
                                onClick={() => void handleOpenCombination(grp.top.combo)}
                                className="text-[11px] text-[#8B949E] hover:text-white cursor-pointer"
                              >
                                Full Backtest →
                              </button>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    disabled={activatingBasketKey === grp.key}
                                    onClick={() => void handleActivateBasket(grp)}
                                    className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
                                      isLiveActive
                                        ? 'border-[#0ECB81] bg-[#0ECB81]/20 text-[#0ECB81]'
                                        : 'border-[#38BDF8]/50 bg-[#161B26] text-[#38BDF8] hover:border-[#38BDF8]'
                                    }`}
                                  >
                                    {isLiveActive ? (
                                      <Check className="h-3 w-3" />
                                    ) : (
                                      <Plus className="h-3 w-3" />
                                    )}
                                    <span>
                                      {activatingBasketKey === grp.key
                                        ? 'Saving...'
                                        : isLiveActive
                                          ? `Added (${grp.strategyIds.length})`
                                          : `Add Top ${grp.strategyIds.length}`}
                                    </span>
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                      })}
                    </div>
                  )}
                </div>

                {/* Final Winners Blueprint Table */}
                <div className="border border-[#222938] bg-[#12161F]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2 text-[11px] text-[#8B949E]">
                    <span>
                      Showing <strong className="font-mono text-[#E6EDF3]">{playbookEntries.length}</strong>{' '}
                      {includeVerifyPaper
                        ? 'Production Ready + Verify Paper'
                        : '100% Production Ready'}{' '}
                      combinations · Click any row for full Equity Curve, 5-Session Breakdown & Trade Logs
                    </span>
                    <span className="font-mono text-[10px] text-[#0ECB81]">
                      Zero Holdout Leakage · Real Fees & Slippage Deducted
                    </span>
                  </div>

                  {playbookEntries.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                            <th className="px-3 py-2">Readiness</th>
                            <th className="px-3 py-2">Asset</th>
                            <th className="px-3 py-2">TF</th>
                            <th className="px-3 py-2">Strategy</th>
                            <th className="px-3 py-2">Best Market Condition</th>
                            <th className="px-3 py-2">
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3 text-[#38BDF8]" />
                                <span>Best Time / Session</span>
                                <HintBadge termKey="sessionTime" />
                              </span>
                            </th>
                            <th className="px-3 py-2 text-right">Test Profit %</th>
                            <th className="px-3 py-2 text-right">
                              <span className="inline-flex items-center justify-end gap-1">
                                <span>Risk : Reward</span>
                                <HintBadge termKey="riskReward" />
                              </span>
                            </th>
                            <th className="px-3 py-2 text-right">Final Proof</th>
                            <th className="px-3 py-2 text-right">
                              <span className="inline-flex items-center gap-1">
                                <span>Confidence</span>
                                <HintBadge termKey="edgeConfidence" align="right" />
                              </span>
                            </th>
                            <th className="px-3 py-2 text-right">Inspect</th>
                          </tr>
                        </thead>
                        <tbody>
                          {playbookEntries.map(({ combo, audit }) => {
                            const rr = formatRiskRewardRatio(combo.oosMetrics);
                            return (
                              <tr
                                key={combo.comboKey}
                                onClick={() => void handleOpenCombination(combo)}
                                className="border-b border-[#1B2230] text-xs hover:bg-[#161B26] cursor-pointer"
                              >
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold">
                                    <span
                                      className={`h-2 w-2 rounded-full ${readinessDot(audit.readiness)}`}
                                    />
                                    <span className={readinessText(audit.readiness)}>
                                      {audit.readiness}
                                    </span>
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-mono font-bold text-[#E6EDF3]">
                                  {combo.symbol}
                                </td>
                                <td className="px-3 py-2 font-mono text-[#38BDF8]">
                                  {combo.timeframe}
                                </td>
                                <td className="px-3 py-2 max-w-[230px]">
                                  <div className="truncate font-medium text-[#E6EDF3]">
                                    {combo.strategy.name}
                                  </div>
                                  <div className="text-[10px] text-[#8B949E]">
                                    #{combo.rank} · {combo.strategy.category} · HTF {combo.htfTimeframe}
                                  </div>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="font-medium text-[#E6EDF3]">{combo.regime}</div>
                                  {combo.poorRegimes.length > 0 && (
                                    <div className="text-[10px] text-[#F59E0B]">
                                      Avoid: {combo.poorRegimes[0].regime}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <div className="font-mono text-[11px] text-[#38BDF8]">
                                    {combo.bestSession ?? 'Click to inspect'}
                                  </div>
                                  {combo.avoidSessions && combo.avoidSessions.length > 0 && (
                                    <div className="text-[10px] text-[#8B949E]">
                                      Skip: {combo.avoidSessions[0].split(' (')[0]}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#0ECB81]">
                                  +{combo.oosMetrics.netReturnPercent.toFixed(1)}%
                                  <div className="text-[10px] font-normal text-[#8B949E]">
                                    {combo.oosMetrics.winRate.toFixed(0)}% win ({combo.oosMetrics.wins}W/{combo.oosMetrics.losses}L)
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#38BDF8]">
                                  {rr.ratioText}
                                  <div
                                    className={`text-[10px] font-normal ${
                                      combo.oosMetrics.expectancyR >= 0
                                        ? 'text-[#0ECB81]'
                                        : 'text-[#F6465D]'
                                    }`}
                                  >
                                    Avg {combo.oosMetrics.expectancyR >= 0 ? '+' : ''}
                                    {combo.oosMetrics.expectancyR.toFixed(2)}R / trade
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">
                                  <span
                                    className={
                                      combo.holdoutMetrics.netReturnPercent >= 0
                                        ? 'text-[#0ECB81] font-semibold'
                                        : 'text-[#F6465D]'
                                    }
                                  >
                                    {combo.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}
                                    {combo.holdoutMetrics.netReturnPercent.toFixed(1)}%
                                  </span>
                                  <div className="text-[10px] text-[#8B949E]">
                                    {combo.holdoutMetrics.trades} trades · R:R{' '}
                                    {formatRiskRewardRatio(combo.holdoutMetrics).ratioText}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#E6EDF3]">
                                  {audit.edgeConfidencePercent.toFixed(0)}%
                                  <div className="text-[10px] font-normal text-[#8B949E]">
                                    Steady {combo.wfConsistencyPercent.toFixed(0)}%
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center justify-end gap-1">
                                    <button
                                      type="button"
                                      disabled={activatingBasketKey === combo.comboKey}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleToggleComboInSignals(combo);
                                      }}
                                      className={`inline-flex items-center gap-1 border px-2 py-1 text-[10px] font-semibold cursor-pointer ${
                                        isComboArmed(combo.symbol, combo.timeframe, combo.strategy.id)
                                          ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81]'
                                          : 'border-[#222938] bg-[#0B0E14] text-[#38BDF8] hover:border-[#38BDF8]'
                                      }`}
                                    >
                                      {isComboArmed(combo.symbol, combo.timeframe, combo.strategy.id) ? (
                                        <>
                                          <Check className="h-3 w-3" />
                                          <span>Added</span>
                                        </>
                                      ) : (
                                        <>
                                          <Plus className="h-3 w-3" />
                                          <span>Add</span>
                                        </>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleOpenCombination(combo);
                                      }}
                                      className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[10px] text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                                    >
                                      Open
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-8 text-center space-y-3">
                      <div className="text-sm font-semibold text-[#E6EDF3]">
                        No 100% Production Ready setups found in this scan yet
                      </div>
                      <p className="text-xs text-[#8B949E] max-w-2xl mx-auto">
                        {auditStats.verifyPaperCount > 0
                          ? `There are ${auditStats.verifyPaperCount} Verify Paper setups (profitable in Unseen Test, fewer than 3 Final Check trades). Toggle "Include Verify Paper" above to inspect them, or run a 20,000-candle Max-Accuracy scan for a larger sample.`
                          : `This usually happens when candle history is short or strict filters hide matches. Run the Max-Accuracy Preset (up to 20,000 candles · All 1,169+ strategies · Min 8 unseen test trades) to discover verified winners with enough Final Check proof.`}
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        {auditStats.verifyPaperCount > 0 && !includeVerifyPaper && (
                          <button
                            type="button"
                            onClick={() => setIncludeVerifyPaper(true)}
                            className="border border-[#F59E0B]/60 bg-[#F59E0B]/15 px-3 py-1.5 text-xs font-semibold text-[#F59E0B] cursor-pointer"
                          >
                            Show {auditStats.verifyPaperCount} Verify Paper Setups
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleApplyMaxAccuracyPreset}
                          className="border border-[#38BDF8]/60 bg-[#161B26] px-3 py-1.5 text-xs font-semibold text-[#38BDF8] cursor-pointer"
                        >
                          Load Max-Accuracy Preset (20,000 Candles · All Strategies)
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* VIEW 1: OVERALL BEST COMBINATIONS (Sortable Table) */}
            {viewTab === 'overall' && (
              <div className="border border-[#222938] bg-[#12161F]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2 text-[11px] text-[#8B949E]">
                  <span>
                    Showing {Math.min(visibleLimit, filteredCombinations.length)} of{' '}
                    <strong className="font-mono text-[#E6EDF3]">
                      {filteredCombinations.length}
                    </strong>{' '}
                    matching setups · Click any row to open full test report & trades (hover{' '}
                    <span className="text-[#38BDF8]">?</span> for word meanings)
                  </span>
                  <span className="font-mono text-[10px] text-[#38BDF8]">
                    Ranked by Trust Level + Unseen Test Score + Consistency Over Time
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                        <SortableHeader
                          label="Rank"
                          field="rank"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                        />
                        <th className="px-3 py-2">Strategy</th>
                        <th className="px-3 py-2">Asset</th>
                        <th className="px-3 py-2">TF</th>
                        <th className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <span>Condition</span>
                            <HintBadge termKey="regime" align="left" />
                          </span>
                        </th>
                        <th className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <span>Best Time</span>
                            <HintBadge termKey="sessionTime" align="left" />
                          </span>
                        </th>
                        <th className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <span>Trust / Readiness</span>
                            <HintBadge termKey="productionReadiness" align="left" />
                          </span>
                        </th>
                        <SortableHeader
                          label="Test Score"
                          field="oosScore"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="oosScore" />}
                        />
                        <SortableHeader
                          label="Risk : Reward"
                          field="oosExpectancy"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="riskReward" />}
                        />
                        <SortableHeader
                          label="Profit Factor"
                          field="oosPf"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="oosPf" />}
                        />
                        <SortableHeader
                          label="Test Profit %"
                          field="oosReturn"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="oosRet" />}
                        />
                        <SortableHeader
                          label="Win %"
                          field="oosWinRate"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="winRate" />}
                        />
                        <SortableHeader
                          label="Max Drop %"
                          field="oosDd"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="maxDd" />}
                        />
                        <SortableHeader
                          label="Trades (Train/Test)"
                          field="oosTrades"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="tradesCount" align="right" />}
                        />
                        <SortableHeader
                          label="Consistency"
                          field="wfConsistency"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="wfCons" align="right" />}
                        />
                        <SortableHeader
                          label="Final Proof"
                          field="holdoutReturn"
                          activeField={sortField}
                          desc={sortDesc}
                          onSort={toggleSort}
                          alignRight
                          hint={<HintBadge termKey="holdout" align="right" />}
                        />
                        <th className="px-3 py-2 text-right">Signals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCombinations.slice(0, visibleLimit).map((c) => {
                        const audit = deriveProductionAudit(c);
                        const rr = formatRiskRewardRatio(c.oosMetrics);
                        const armed = isComboArmed(c.symbol, c.timeframe, c.strategy.id);
                        return (
                          <tr
                            key={c.comboKey}
                            onClick={() => void handleOpenCombination(c)}
                            className="border-b border-[#1B2230] text-xs hover:bg-[#161B26] cursor-pointer"
                          >
                            <td className="px-3 py-2 font-mono tabular-nums text-[#8B949E]">
                              #{c.rank}
                            </td>
                            <td className="px-3 py-2 max-w-[230px]">
                              <div className="truncate font-medium text-[#E6EDF3]">
                                {c.strategy.name}
                              </div>
                              <div className="text-[10px] text-[#8B949E]">
                                {c.strategy.category}
                                {c.poorRegimes.length > 0 && (
                                  <span className="text-[#F59E0B]">
                                    {' '}
                                    · Avoid: {c.poorRegimes[0].regime}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 font-mono font-semibold text-[#E6EDF3]">
                              {c.symbol}
                            </td>
                            <td className="px-3 py-2 font-mono text-[#38BDF8]">{c.timeframe}</td>
                            <td className="px-3 py-2 text-[#C9D1D9]">{c.regime}</td>
                            <td className="px-3 py-2 whitespace-nowrap font-mono text-[10px] text-[#38BDF8]">
                              {c.bestSession ? c.bestSession.split(' (')[0] : 'Inspect'}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${validationDot(c.validationStatus)}`}
                                />
                                <span className={validationText(c.validationStatus)}>
                                  {SimpleValidationLabel(c.validationStatus)}
                                </span>
                              </div>
                              <div className={`text-[10px] font-mono ${readinessText(audit.readiness)}`}>
                                {audit.readiness}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#E6EDF3]">
                              {c.oosScore.toFixed(1)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#38BDF8]">
                              <div>{rr.ratioText}</div>
                              <div
                                className={`text-[10px] font-normal ${
                                  c.oosMetrics.expectancyR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                Avg {c.oosMetrics.expectancyR >= 0 ? '+' : ''}
                                {c.oosMetrics.expectancyR.toFixed(2)}R
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                              {c.oosMetrics.profitFactor !== null
                                ? `${c.oosMetrics.profitFactor.toFixed(2)}×`
                                : '—'}
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                                c.oosMetrics.netReturnPercent >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {c.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                              {c.oosMetrics.netReturnPercent.toFixed(2)}%
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                              <div>{c.oosMetrics.winRate.toFixed(1)}%</div>
                              <div className="text-[10px] text-[#8B949E]">
                                {c.oosMetrics.wins}W / {c.oosMetrics.losses}L
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#F6465D]">
                              -{c.oosMetrics.maxDrawdownPercent.toFixed(2)}%
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                              {c.isMetrics.trades} / <strong className="text-[#E6EDF3]">{c.oosMetrics.trades}</strong>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                              {c.wfConsistencyPercent.toFixed(0)}%{' '}
                              <span className="text-[10px] text-[#8B949E]">
                                ({c.wfProfitableFolds}/{c.wfActiveFolds})
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                              {c.holdoutMetrics.trades > 0 ? (
                                <span
                                  className={
                                    c.holdoutMetrics.netReturnPercent >= 0
                                      ? 'text-[#38BDF8]'
                                      : 'text-[#F6465D]'
                                  }
                                >
                                  {c.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}
                                  {c.holdoutMetrics.netReturnPercent.toFixed(1)}% ({c.holdoutMetrics.trades}t)
                                </span>
                              ) : (
                                '0t'
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <button
                                type="button"
                                disabled={activatingBasketKey === c.comboKey}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleToggleComboInSignals(c);
                                }}
                                className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
                                  armed
                                    ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81]'
                                    : 'border-[#222938] bg-[#0B0E14] text-[#38BDF8] hover:border-[#38BDF8]'
                                }`}
                              >
                                {armed ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                                <span>{armed ? 'Added' : 'Add'}</span>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {filteredCombinations.length === 0 && (
                        <tr>
                          <td colSpan={17} className="px-4 py-8 text-center text-xs text-[#8B949E]">
                            No combinations match the selected filters. Try broadening status or regime filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {filteredCombinations.length > visibleLimit && (
                  <div className="border-t border-[#222938] px-4 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => setVisibleLimit((v) => v + 60)}
                      className="border border-[#222938] bg-[#0B0E14] px-3 py-1 text-xs text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                    >
                      Show More ({filteredCombinations.length - visibleLimit} remaining)
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* VIEW 2: BEST STRATEGY PER INSTRUMENT */}
            {viewTab === 'instrument' && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {byInstrumentGroups.map((group) => (
                  <div key={group.symbol} className="border border-[#222938] bg-[#12161F]">
                    <div className="flex items-center justify-between border-b border-[#222938] px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-[#E6EDF3]">
                          {group.symbol}
                        </span>
                        <span className="text-xs text-[#8B949E]">
                          Best Strategy + Timeframe + Market Condition
                        </span>
                      </div>
                      <Activity className="h-3.5 w-3.5 text-[#38BDF8]" />
                    </div>
                    <GroupRankingTable
                      combos={group.topCombos}
                      onSelect={handleOpenCombination}
                      primaryCol="timeframe"
                      isArmed={(c) => isComboArmed(c.symbol, c.timeframe, c.strategy.id)}
                      onToggleSignals={(c) => void handleToggleComboInSignals(c)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* VIEW 3: BEST STRATEGY PER TIMEFRAME */}
            {viewTab === 'timeframe' && (
              <div className="space-y-4">
                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[#E6EDF3]">
                    <span>Best Test Score by Timeframe (Top Setup on Each Chart Timeframe)</span>
                    <HintBadge termKey="oosScore" align="left" />
                  </div>
                  <div className="h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={timeframeBarChartData}>
                        <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                        <XAxis dataKey="timeframe" tick={{ fill: '#E6EDF3', fontSize: 11 }} />
                        <YAxis domain={[0, 100]} tick={{ fill: '#8B949E', fontSize: 10 }} width={36} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#12161F',
                            borderColor: '#222938',
                            fontSize: '11px',
                          }}
                          formatter={(val: unknown, _name: unknown, p: { payload?: { label?: string } }) => [
                            `${Number(val).toFixed(1)} / 100`,
                            p?.payload?.label ?? 'Top Setup',
                          ]}
                        />
                        <Bar dataKey="oosScore">
                          {timeframeBarChartData.map((d, i) => (
                            <Cell
                              key={i}
                              fill={d.oosScore >= 55 ? '#0ECB81' : d.oosScore >= 35 ? '#38BDF8' : '#8B949E'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {byTimeframeGroups.map((group) => (
                    <div key={group.timeframe} className="border border-[#222938] bg-[#12161F]">
                      <div className="flex items-center justify-between border-b border-[#222938] px-4 py-2.5">
                        <div>
                          <span className="font-mono text-sm font-bold text-[#38BDF8]">
                            {group.timeframe}
                          </span>
                          <span className="ml-2 text-xs text-[#8B949E]">
                            Best Strategy + Asset + Condition on {group.timeframe}
                          </span>
                        </div>
                      </div>
                      <GroupRankingTable
                        combos={group.topCombos}
                        onSelect={handleOpenCombination}
                        primaryCol="symbol"
                        isArmed={(c) => isComboArmed(c.symbol, c.timeframe, c.strategy.id)}
                        onToggleSignals={(c) => void handleToggleComboInSignals(c)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* VIEW 4: BEST STRATEGY PER MARKET CONDITION */}
            {viewTab === 'regime' && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {byRegimeGroups.map((group) => (
                  <div key={group.regime} className="border border-[#222938] bg-[#12161F]">
                    <div className="flex items-center justify-between border-b border-[#222938] px-4 py-2.5">
                      <div>
                        <span className="text-sm font-bold text-[#E6EDF3]">
                          {group.regime} Market Condition
                        </span>
                        <span className="ml-2 text-xs text-[#8B949E]">
                          Top setups during {group.regime} markets
                        </span>
                      </div>
                    </div>
                    <GroupRankingTable
                      combos={group.topCombos}
                      onSelect={handleOpenCombination}
                      primaryCol="symbol_tf"
                      isArmed={(c) => isComboArmed(c.symbol, c.timeframe, c.strategy.id)}
                      onToggleSignals={(c) => void handleToggleComboInSignals(c)}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Drill-Down Detail Modal */}
      {inspectedCombo && (
        <CombinationDetailModal
          combination={inspectedCombo}
          detail={detailData}
          loading={loadingDetail}
          error={detailError}
          timezone={timezone}
          onClose={() => {
            setInspectedCombo(null);
            setDetailData(null);
          }}
          onJumpToChart={handleJumpToChart}
        />
      )}
    </div>
  );
}

function SortableHeader({
  label,
  field,
  activeField,
  desc,
  onSort,
  alignRight = false,
  hint,
}: {
  label: string;
  field: SortField;
  activeField: SortField;
  desc: boolean;
  onSort: (field: SortField) => void;
  alignRight?: boolean;
  hint?: ReactNode;
}) {
  const isActive = activeField === field;
  return (
    <th className={`px-3 py-2 ${alignRight ? 'text-right' : 'text-left'}`}>
      <div className={`inline-flex items-center gap-1 ${alignRight ? 'justify-end' : ''}`}>
        <button
          type="button"
          onClick={() => onSort(field)}
          className={`inline-flex items-center gap-1 cursor-pointer hover:text-white ${
            isActive ? 'text-[#38BDF8]' : ''
          }`}
        >
          <span>{label}</span>
          {isActive ? (
            desc ? (
              <ArrowDown className="h-3 w-3" />
            ) : (
              <ArrowUp className="h-3 w-3" />
            )
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-40" />
          )}
        </button>
        {hint}
      </div>
    </th>
  );
}

function GroupRankingTable({
  combos,
  onSelect,
  primaryCol,
  isArmed,
  onToggleSignals,
}: {
  combos: StrategyDiscoveryCombination[];
  onSelect: (combo: StrategyDiscoveryCombination) => void;
  primaryCol: 'timeframe' | 'symbol' | 'symbol_tf';
  isArmed: (combo: StrategyDiscoveryCombination) => boolean;
  onToggleSignals: (combo: StrategyDiscoveryCombination) => void;
}) {
  if (combos.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-[#8B949E]">
        No matching setups in this group under current filters.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
            <th className="px-3 py-1.5">Strategy</th>
            <th className="px-3 py-1.5">
              {primaryCol === 'timeframe'
                ? 'TF · Condition'
                : primaryCol === 'symbol'
                  ? 'Asset · Condition'
                  : 'Asset · TF'}
            </th>
            <th className="px-3 py-1.5">Trust Level</th>
            <th className="px-3 py-1.5 text-right">
              <span className="inline-flex items-center justify-end gap-1">
                <span>Risk : Reward</span>
                <HintBadge termKey="riskReward" />
              </span>
            </th>
            <th className="px-3 py-1.5 text-right">
              <span className="inline-flex items-center justify-end gap-1">
                <span>Win %</span>
                <HintBadge termKey="winRate" />
              </span>
            </th>
            <th className="px-3 py-1.5 text-right">
              <span className="inline-flex items-center justify-end gap-1">
                <span>Test Profit</span>
                <HintBadge termKey="oosRet" align="right" />
              </span>
            </th>
            <th className="px-3 py-1.5 text-right">
              <span className="inline-flex items-center justify-end gap-1">
                <span>Consistency</span>
                <HintBadge termKey="wfCons" align="right" />
              </span>
            </th>
            <th className="px-3 py-1.5 text-right">Signals</th>
          </tr>
        </thead>
        <tbody>
          {combos.map((c) => {
            const rr = formatRiskRewardRatio(c.oosMetrics);
            const armed = isArmed(c);
            return (
              <tr
                key={c.comboKey}
                onClick={() => void onSelect(c)}
                className="border-b border-[#1B2230] text-xs hover:bg-[#161B26] cursor-pointer"
              >
                <td className="px-3 py-2 max-w-[200px]">
                  <div className="truncate font-medium text-[#E6EDF3]">{c.strategy.name}</div>
                  <div className="text-[10px] text-[#8B949E]">{c.strategy.category}</div>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-[#C9D1D9] whitespace-nowrap">
                  {primaryCol === 'timeframe'
                    ? `${c.timeframe} · ${c.regime}`
                    : primaryCol === 'symbol'
                      ? `${c.symbol} · ${c.regime}`
                      : `${c.symbol} ${c.timeframe}`}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1 text-[10px]">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${validationDot(c.validationStatus)}`}
                    />
                    <span className={validationText(c.validationStatus)}>
                      {SimpleValidationLabel(c.validationStatus)}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#38BDF8]">
                  <div>{rr.ratioText}</div>
                  <div
                    className={`text-[10px] font-normal ${
                      c.oosMetrics.expectancyR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    Avg {c.oosMetrics.expectancyR >= 0 ? '+' : ''}
                    {c.oosMetrics.expectancyR.toFixed(2)}R
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                  <div>{c.oosMetrics.winRate.toFixed(0)}%</div>
                  <div className="text-[10px] text-[#8B949E]">
                    {c.oosMetrics.wins}W / {c.oosMetrics.losses}L
                  </div>
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono tabular-nums ${
                    c.oosMetrics.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                  }`}
                >
                  {c.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                  {c.oosMetrics.netReturnPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                  {c.wfConsistencyPercent.toFixed(0)}%
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSignals(c);
                    }}
                    className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
                      armed
                        ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#38BDF8] hover:border-[#38BDF8]'
                    }`}
                  >
                    {armed ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                    <span>{armed ? 'Added' : 'Add'}</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
