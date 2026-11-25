import {
  Activity,
  ArrowDownUp,
  BarChart3,
  CandlestickChart,
  ChevronDown,
  ChevronRight,
  Filter,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { deriveProductionAudit } from '../../shared/production-audit.ts';
import type {
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  DiscoveryRunSummary,
  DiscoveryScanRun,
  InstrumentSymbol,
  LiveStrategyBasketSlot,
  LiveStrategyBasketStrategyRef,
  MarketRegimeType,
  ProductionReadinessStatus,
  StrategyDiscoveryCombination,
  Timeframe,
  TradingSessionName,
  TradingSignal,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';

type ArmingState = 'FIRING' | 'MONITORING' | 'PAUSED' | 'UNARMED';
type StatusFilter = 'ALL' | 'FIRING' | 'MONITORING' | 'PAUSED' | 'UNARMED';
type SortField = 'oosScore' | 'winRate' | 'profitFactor' | 'expectancyR' | 'liveSignals' | 'name';

const TERMINAL_STATES = new Set(['TP3_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'CANCELLED']);
const WIN_STATES = new Set(['TP1_HIT', 'TP2_HIT', 'TP3_HIT']);

interface UnarmedCacheItem {
  key: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  strategy: LiveStrategyBasketStrategyRef;
  slotMeta?: Partial<LiveStrategyBasketSlot>;
}

interface StrategyManagerRow {
  rowKey: string;
  slotIndex: number;
  slotKey: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  strategy: LiveStrategyBasketStrategyRef;
  catalogDef: BacktestStrategyDefinition | null;
  armingState: ArmingState;
  isArmed: boolean;
  basketEnabled: boolean;
  // Discovery / Backtest metrics (exact combo if found, else slot average if flagged)
  metricsSource: 'discovery_combo' | 'slot_aggregate' | 'none';
  readiness: ProductionReadinessStatus | null;
  oosWinRate: number | null;
  oosProfitFactor: number | null;
  oosExpectancyR: number | null;
  oosNetReturnPercent: number | null;
  oosMaxDrawdownPercent: number | null;
  oosTrades: number | null;
  oosScore: number | null;
  wfConsistencyPercent: number | null;
  wfProfitableFolds: number | null;
  wfActiveFolds: number | null;
  isWinRate: number | null;
  isExpectancyR: number | null;
  holdoutWinRate: number | null;
  holdoutExpectancyR: number | null;
  bestRegime: MarketRegimeType | null;
  poorRegimes: MarketRegimeType[];
  bestSession: TradingSessionName | null;
  avoidSessions: TradingSessionName[];
  strengths: string[];
  weaknesses: string[];
  // Live signal execution stats from actual emitted signals
  liveMatchedSignals: TradingSignal[];
  liveOpenSignals: TradingSignal[];
  liveWatchingCount: number;
  liveClosedCount: number;
  liveWins: number;
  liveLosses: number;
  liveWinRate: number | null;
  liveAvgR: number | null;
  latestSignal: TradingSignal | null;
}

function formatReadinessColor(readiness: ProductionReadinessStatus | null): string {
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

function formatArmingBadge(state: ArmingState): {
  label: string;
  className: string;
} {
  switch (state) {
    case 'FIRING':
      return {
        label: 'ARMED · SIGNAL ACTIVE',
        className: 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81]',
      };
    case 'MONITORING':
      return {
        label: 'ARMED · SCANNING',
        className: 'border-[#38BDF8]/60 bg-[#38BDF8]/10 text-[#38BDF8]',
      };
    case 'PAUSED':
      return {
        label: 'ARMED · PAUSED',
        className: 'border-[#F59E0B]/60 bg-[#F59E0B]/10 text-[#F59E0B]',
      };
    case 'UNARMED':
      return {
        label: 'UNARMED',
        className: 'border-[#222938] bg-[#12161F] text-[#8B949E]',
      };
  }
}

export function StrategyManagerDashboard({
  variant = 'page',
  onBackToDesk,
  onOpenFilterStrategies,
  onOpenMainSignals,
  onOpenDiscovery,
  onOpenLiveStrategy,
  onSwitchToChart,
}: {
  variant?: 'page' | 'modal' | 'embedded';
  onBackToDesk?: () => void;
  onOpenFilterStrategies?: () => void;
  onOpenMainSignals?: () => void;
  onOpenDiscovery?: () => void;
  onOpenLiveStrategy?: () => void;
  onSwitchToChart?: (sym: InstrumentSymbol, tf: Timeframe) => void;
}) {
  const {
    signals,
    signalSettings,
    liveStrategyBasket,
    updateLiveStrategyBasket,
    removeBasketItem,
    armBestStrategies,
    clearLiveStrategyBasket,
    evaluateSignals,
    evaluatingSignals,
    discoveryProgress,
    selectSymbol,
    selectTimeframe,
    focusChartObject,
  } = useTerminal();

  const [catalogMap, setCatalogMap] = useState<Map<string, BacktestStrategyDefinition>>(new Map());
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryScanRun[]>([]);
  const [loadingMetrics, setLoadingMetrics] = useState<boolean>(false);
  const [unarmedCache, setUnarmedCache] = useState<UnarmedCacheItem[]>([]);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | BacktestStrategyCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortField>('oosScore');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [armingBest, setArmingBest] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [collapsedEmbedded, setCollapsedEmbedded] = useState<boolean>(false);

  // Load strategy catalog definitions
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/backtest/strategies');
        if (!res.ok || !active) return;
        const data = (await res.json()) as { strategies?: BacktestStrategyDefinition[] };
        if (Array.isArray(data.strategies) && active) {
          const next = new Map<string, BacktestStrategyDefinition>();
          for (const item of data.strategies) {
            next.set(item.id, item);
          }
          setCatalogMap(next);
        }
      } catch {
        // ignore network errors
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Load discovery runs referenced by basket + recent runs for OOS/IS metrics
  const loadDiscoveryMetrics = useCallback(async () => {
    setLoadingMetrics(true);
    try {
      const res = await apiFetch('/api/discovery/runs');
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: DiscoveryRunSummary[] };
      const summaries = Array.isArray(data.runs) ? data.runs : [];

      const runIdsToFetch = new Set<string>();
      if (liveStrategyBasket?.sourceRunId) {
        runIdsToFetch.add(liveStrategyBasket.sourceRunId);
      }
      for (const slot of liveStrategyBasket?.assignments ?? []) {
        if (slot.sourceRunId) runIdsToFetch.add(slot.sourceRunId);
      }
      for (const summary of summaries.slice(0, 3)) {
        runIdsToFetch.add(summary.id);
      }

      const fetchedRuns: DiscoveryScanRun[] = [];
      for (const runId of runIdsToFetch) {
        const detailRes = await apiFetch(`/api/discovery/runs/${encodeURIComponent(runId)}`);
        if (detailRes.ok) {
          const runObj = (await detailRes.json()) as DiscoveryScanRun;
          if (runObj && Array.isArray(runObj.combinations)) {
            fetchedRuns.push(runObj);
          }
        }
      }
      setDiscoveryRuns(fetchedRuns);
    } finally {
      setLoadingMetrics(false);
    }
  }, [liveStrategyBasket?.sourceRunId, liveStrategyBasket?.assignments]);

  useEffect(() => {
    void loadDiscoveryMetrics();
  }, [loadDiscoveryMetrics]);

  useEffect(() => {
    if (discoveryProgress.status === 'completed' && discoveryProgress.runId) {
      void loadDiscoveryMetrics();
    }
  }, [discoveryProgress.status, discoveryProgress.runId, loadDiscoveryMetrics]);

  // Normalized list of armed slots
  const armedSlots = useMemo<LiveStrategyBasketSlot[]>(() => {
    if (!liveStrategyBasket) return [];
    if (liveStrategyBasket.assignments && liveStrategyBasket.assignments.length > 0) {
      return liveStrategyBasket.assignments;
    }
    if (liveStrategyBasket.strategies.length === 0) return [];
    return [
      {
        symbol: liveStrategyBasket.symbol,
        timeframe: liveStrategyBasket.timeframe,
        htfTimeframe: liveStrategyBasket.htfTimeframe,
        strategies: liveStrategyBasket.strategies,
        sourceRunId: liveStrategyBasket.sourceRunId,
        lastClosedBarTime: liveStrategyBasket.lastClosedBarTime,
      },
    ];
  }, [liveStrategyBasket]);

  // Index discovery combinations by (symbol, timeframe, strategyId) and fallback by (strategyId)
  const comboLookup = useMemo(() => {
    const exactMap = new Map<string, StrategyDiscoveryCombination>();
    const byStrategyMap = new Map<string, StrategyDiscoveryCombination>();
    for (const run of discoveryRuns) {
      for (const combo of run.combinations) {
        const exactKey = `${combo.symbol}:${combo.timeframe}:${combo.strategy.id}`;
        const prevExact = exactMap.get(exactKey);
        if (!prevExact || combo.oosScore > prevExact.oosScore) {
          exactMap.set(exactKey, combo);
        }
        const prevAny = byStrategyMap.get(combo.strategy.id);
        if (!prevAny || combo.oosScore > prevAny.oosScore) {
          byStrategyMap.set(combo.strategy.id, combo);
        }
      }
    }
    return { exactMap, byStrategyMap };
  }, [discoveryRuns]);

  // Clean out cached unarmed items if they got re-armed externally
  const activeArmedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const slot of armedSlots) {
      for (const strat of slot.strategies) {
        set.add(`${slot.symbol}:${slot.timeframe}:${strat.id}`);
      }
    }
    return set;
  }, [armedSlots]);

  const effectiveUnarmed = useMemo(
    () => unarmedCache.filter((item) => !activeArmedKeys.has(item.key)),
    [unarmedCache, activeArmedKeys]
  );

  // Build unified rows for all armed + recently unarmed strategies
  const allRows = useMemo<StrategyManagerRow[]>(() => {
    const basketEnabled = liveStrategyBasket?.enabled ?? false;
    const rows: StrategyManagerRow[] = [];

    const buildRow = (
      symbol: InstrumentSymbol,
      timeframe: Timeframe,
      htfTimeframe: Timeframe,
      strategy: LiveStrategyBasketStrategyRef,
      slotIndex: number,
      isArmed: boolean,
      slotMeta?: Partial<LiveStrategyBasketSlot>
    ): StrategyManagerRow => {
      const slotKey = `${symbol}:${timeframe}`;
      const rowKey = `${slotKey}:${strategy.id}`;
      const exactCombo =
        comboLookup.exactMap.get(rowKey) ?? comboLookup.byStrategyMap.get(strategy.id) ?? null;
      const catalogDef = catalogMap.get(strategy.id) ?? exactCombo?.strategy ?? null;

      // Match live emitted signals from this strategy
      const matchedSignals = signals
        .filter(
          (s) =>
            s.strategyId === strategy.id &&
            ((s.symbol === symbol && s.entryTimeframe === timeframe) || !s.entryTimeframe)
        )
        .sort((a, b) => b.createdAt - a.createdAt);

      const openSignals = matchedSignals.filter((s) => !TERMINAL_STATES.has(s.state));
      const watchingCount = openSignals.filter((s) => s.state === 'WATCHING').length;
      const closedSignals = matchedSignals.filter((s) => TERMINAL_STATES.has(s.state));
      const wins = closedSignals.filter((s) => WIN_STATES.has(s.state)).length;
      const losses = closedSignals.filter((s) => s.state === 'STOPPED').length;
      const decided = wins + losses;
      const liveWinRate = decided > 0 ? (wins / decided) * 100 : null;
      const realizedValues = closedSignals
        .map((s) => s.realizedR)
        .filter((r): r is number => r !== null && Number.isFinite(r));
      const liveAvgR =
        realizedValues.length > 0
          ? realizedValues.reduce((sum, r) => sum + r, 0) / realizedValues.length
          : null;

      const armingState: ArmingState = !isArmed
        ? 'UNARMED'
        : !basketEnabled
          ? 'PAUSED'
          : openSignals.length > 0
            ? 'FIRING'
            : 'MONITORING';

      const audit = exactCombo ? deriveProductionAudit(exactCombo) : null;
      const hasSlotMetrics =
        slotMeta?.oosWinRate !== undefined ||
        slotMeta?.oosProfitFactor !== undefined ||
        slotMeta?.oosScore !== undefined;

      return {
        rowKey,
        slotIndex,
        slotKey,
        symbol,
        timeframe,
        htfTimeframe,
        strategy,
        catalogDef,
        armingState,
        isArmed,
        basketEnabled,
        metricsSource: exactCombo
          ? 'discovery_combo'
          : hasSlotMetrics
            ? 'slot_aggregate'
            : 'none',
        readiness: audit?.readiness ?? slotMeta?.readiness ?? null,
        oosWinRate: exactCombo?.oosMetrics.winRate ?? slotMeta?.oosWinRate ?? null,
        oosProfitFactor:
          exactCombo?.oosMetrics.profitFactor ?? slotMeta?.oosProfitFactor ?? null,
        oosExpectancyR:
          exactCombo?.oosMetrics.expectancyR ?? slotMeta?.oosExpectancyR ?? null,
        oosNetReturnPercent: exactCombo?.oosMetrics.netReturnPercent ?? null,
        oosMaxDrawdownPercent: exactCombo?.oosMetrics.maxDrawdownPercent ?? null,
        oosTrades: exactCombo?.oosMetrics.trades ?? null,
        oosScore: exactCombo?.oosScore ?? slotMeta?.oosScore ?? null,
        wfConsistencyPercent: exactCombo?.wfConsistencyPercent ?? null,
        wfProfitableFolds: exactCombo?.wfProfitableFolds ?? null,
        wfActiveFolds: exactCombo?.wfActiveFolds ?? null,
        isWinRate: exactCombo?.isMetrics.winRate ?? null,
        isExpectancyR: exactCombo?.isMetrics.expectancyR ?? null,
        holdoutWinRate: exactCombo?.holdoutMetrics.winRate ?? null,
        holdoutExpectancyR: exactCombo?.holdoutMetrics.expectancyR ?? null,
        bestRegime: exactCombo?.regime ?? slotMeta?.bestRegime ?? null,
        poorRegimes:
          exactCombo?.poorRegimes.map((p) => p.regime) ?? slotMeta?.poorRegimes ?? [],
        bestSession: exactCombo?.bestSession ?? null,
        avoidSessions: exactCombo?.avoidSessions ?? slotMeta?.avoidSessions ?? [],
        strengths: exactCombo?.strengths ?? [],
        weaknesses: exactCombo?.weaknesses ?? [],
        liveMatchedSignals: matchedSignals,
        liveOpenSignals: openSignals,
        liveWatchingCount: watchingCount,
        liveClosedCount: closedSignals.length,
        liveWins: wins,
        liveLosses: losses,
        liveWinRate,
        liveAvgR,
        latestSignal: matchedSignals[0] ?? null,
      };
    };

    armedSlots.forEach((slot, idx) => {
      slot.strategies.forEach((strat) => {
        rows.push(buildRow(slot.symbol, slot.timeframe, slot.htfTimeframe, strat, idx, true, slot));
      });
    });

    effectiveUnarmed.forEach((u) => {
      rows.push(
        buildRow(
          u.symbol,
          u.timeframe,
          u.htfTimeframe,
          u.strategy,
          99,
          false,
          u.slotMeta
        )
      );
    });

    return rows;
  }, [armedSlots, effectiveUnarmed, liveStrategyBasket?.enabled, comboLookup, catalogMap, signals]);

  const armedRows = useMemo(() => allRows.filter((r) => r.isArmed), [allRows]);

  // Aggregate summary KPIs across armed strategies
  const summaryStats = useMemo(() => {
    const firingCount = armedRows.filter((r) => r.armingState === 'FIRING').length;
    const totalLiveOpen = armedRows.reduce((sum, r) => sum + r.liveOpenSignals.length, 0);
    const totalLiveEmitted = armedRows.reduce((sum, r) => sum + r.liveMatchedSignals.length, 0);
    const totalWins = armedRows.reduce((sum, r) => sum + r.liveWins, 0);
    const totalLosses = armedRows.reduce((sum, r) => sum + r.liveLosses, 0);
    const decided = totalWins + totalLosses;
    const liveWinRate = decided > 0 ? (totalWins / decided) * 100 : null;

    const winRates = armedRows
      .map((r) => r.oosWinRate)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const avgOosWinRate =
      winRates.length > 0 ? winRates.reduce((s, v) => s + v, 0) / winRates.length : null;

    const pfs = armedRows
      .map((r) => r.oosProfitFactor)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const avgOosPf = pfs.length > 0 ? pfs.reduce((s, v) => s + v, 0) / pfs.length : null;

    const scores = armedRows
      .map((r) => r.oosScore)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const avgOosScore =
      scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;

    return {
      armedCount: armedRows.length,
      slotCount: armedSlots.length,
      firingCount,
      totalLiveOpen,
      totalLiveEmitted,
      totalWins,
      totalLosses,
      liveWinRate,
      avgOosWinRate,
      avgOosPf,
      avgOosScore,
    };
  }, [armedRows, armedSlots.length]);

  // Filtered and sorted rows for display
  const displayedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = allRows.filter((r) => {
      if (selectedSlotKey !== 'ALL' && r.slotKey !== selectedSlotKey) return false;
      if (statusFilter === 'ALL' && !r.isArmed && effectiveUnarmed.length === 0) return false;
      if (statusFilter === 'FIRING' && r.armingState !== 'FIRING') return false;
      if (statusFilter === 'MONITORING' && r.armingState !== 'MONITORING') return false;
      if (statusFilter === 'PAUSED' && r.armingState !== 'PAUSED') return false;
      if (statusFilter === 'UNARMED' && r.armingState !== 'UNARMED') return false;
      if (categoryFilter !== 'ALL' && r.strategy.category !== categoryFilter) return false;
      if (
        q &&
        !r.strategy.name.toLowerCase().includes(q) &&
        !r.strategy.id.toLowerCase().includes(q) &&
        !r.strategy.category.toLowerCase().includes(q) &&
        !r.symbol.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    const dir = sortDir === 'desc' ? -1 : 1;
    return filtered.sort((a, b) => {
      // Keep armed strategies ahead of unarmed unless specifically sorting
      if (a.isArmed !== b.isArmed) return a.isArmed ? -1 : 1;
      switch (sortBy) {
        case 'winRate':
          return ((a.oosWinRate ?? -1) - (b.oosWinRate ?? -1)) * dir;
        case 'profitFactor':
          return ((a.oosProfitFactor ?? -1) - (b.oosProfitFactor ?? -1)) * dir;
        case 'expectancyR':
          return ((a.oosExpectancyR ?? -99) - (b.oosExpectancyR ?? -99)) * dir;
        case 'liveSignals':
          return (
            (a.liveOpenSignals.length * 100 +
              a.liveMatchedSignals.length -
              (b.liveOpenSignals.length * 100 + b.liveMatchedSignals.length)) *
            dir
          );
        case 'name':
          return a.strategy.name.localeCompare(b.strategy.name) * dir;
        case 'oosScore':
        default:
          return ((a.oosScore ?? -1) - (b.oosScore ?? -1)) * dir;
      }
    });
  }, [
    allRows,
    selectedSlotKey,
    statusFilter,
    categoryFilter,
    searchQuery,
    sortBy,
    sortDir,
    effectiveUnarmed.length,
  ]);

  const handleToggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDir(field === 'name' ? 'asc' : 'desc');
    }
  };

  const handleToggleBasketEnabled = async () => {
    if (!liveStrategyBasket) return;
    setBusyKey('basket-toggle');
    setFeedback(null);
    try {
      const nextEnabled = !liveStrategyBasket.enabled;
      await updateLiveStrategyBasket({
        enabled: nextEnabled,
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
      });
      setFeedback({
        type: 'success',
        text: nextEnabled
          ? `Resumed scanning across all ${summaryStats.armedCount} armed strategies.`
          : `Paused signal scanning for all ${summaryStats.armedCount} armed strategies.`,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleUnarmStrategy = async (row: StrategyManagerRow) => {
    setBusyKey(row.rowKey);
    setFeedback(null);
    try {
      setUnarmedCache((prev) => {
        const filtered = prev.filter((item) => item.key !== row.rowKey);
        return [
          {
            key: row.rowKey,
            symbol: row.symbol,
            timeframe: row.timeframe,
            htfTimeframe: row.htfTimeframe,
            strategy: row.strategy,
            slotMeta: {
              readiness: row.readiness ?? undefined,
              bestRegime: row.bestRegime ?? undefined,
              poorRegimes: row.poorRegimes,
              avoidSessions: row.avoidSessions,
              oosWinRate: row.oosWinRate ?? undefined,
              oosProfitFactor: row.oosProfitFactor ?? undefined,
              oosExpectancyR: row.oosExpectancyR ?? undefined,
              oosScore: row.oosScore ?? undefined,
            },
          },
          ...filtered,
        ].slice(0, 20);
      });
      await removeBasketItem(row.symbol, row.timeframe, row.strategy.id);
      setFeedback({
        type: 'success',
        text: `Unarmed "${row.strategy.name}" from ${row.symbol} ${row.timeframe}. You can re-arm it anytime below.`,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleRearmStrategy = async (row: StrategyManagerRow) => {
    setBusyKey(row.rowKey);
    setFeedback(null);
    try {
      const slotAssignment: LiveStrategyBasketSlot = {
        symbol: row.symbol,
        timeframe: row.timeframe,
        htfTimeframe: row.htfTimeframe,
        strategies: [row.strategy],
        readiness: row.readiness ?? undefined,
        bestRegime: row.bestRegime ?? undefined,
        poorRegimes: row.poorRegimes,
        avoidSessions: row.avoidSessions,
        oosWinRate: row.oosWinRate ?? undefined,
        oosProfitFactor: row.oosProfitFactor ?? undefined,
        oosExpectancyR: row.oosExpectancyR ?? undefined,
        oosScore: row.oosScore ?? undefined,
      };
      await updateLiveStrategyBasket({
        mode: 'merge',
        enabled: true,
        symbol: row.symbol,
        timeframe: row.timeframe,
        htfTimeframe: row.htfTimeframe,
        strategyIds: [row.strategy.id],
        assignments: [slotAssignment],
        maxConcurrentPositions: liveStrategyBasket?.maxConcurrentPositions ?? 6,
        minRiskReward: liveStrategyBasket?.minRiskReward ?? 1.5,
      });
      setUnarmedCache((prev) => prev.filter((item) => item.key !== row.rowKey));
      setFeedback({
        type: 'success',
        text: `Re-armed "${row.strategy.name}" on ${row.symbol} ${row.timeframe}.`,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleAutoArmBest = async () => {
    setArmingBest(true);
    setFeedback(null);
    try {
      const res = await armBestStrategies({
        readinessMode: 'INCLUDE_VERIFY_PAPER',
        avoidPoorRegimes: true,
        requireHtfAlignment: true,
        autoScanIfEmpty: true,
      });
      setFeedback({
        type: res.ok ? 'success' : 'error',
        text: res.message,
      });
    } finally {
      setArmingBest(false);
    }
  };

  const maxChartWinRate = 100;
  const comparativeBars = useMemo(
    () =>
      [...armedRows]
        .sort((a, b) => (b.oosScore ?? b.oosWinRate ?? 0) - (a.oosScore ?? a.oosWinRate ?? 0))
        .slice(0, 10),
    [armedRows]
  );

  const containerClass =
    variant === 'page'
      ? 'flex-1 overflow-y-auto bg-[#0B0E14] px-4 py-4 sm:px-6'
      : variant === 'embedded'
        ? 'border border-[#222938] bg-[#12161F] p-4'
        : 'space-y-4';

  const innerWrapClass = variant === 'page' ? 'mx-auto max-w-[1440px] space-y-4' : 'space-y-4';

  return (
    <div className={containerClass}>
      <div className={innerWrapClass}>
        {/* Top Header & Global Basket Actions */}
        <section className="border border-[#222938] bg-[#12161F] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-base font-semibold text-[#E6EDF3]">Strategy Manager</h1>
                <span className="font-mono text-xs text-[#8B949E] tabular-nums">
                  {summaryStats.armedCount} Armed · {summaryStats.slotCount} Slot
                  {summaryStats.slotCount === 1 ? '' : 's'}
                  {liveStrategyBasket
                    ? liveStrategyBasket.enabled
                      ? ' · Scanning Active'
                      : ' · Scanning Paused'
                    : ' · Basket Empty'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-[#8B949E]">
                Monitor every armed signal strategy, live BUY/SELL firing state, out-of-sample win rate, profit factor, and per-strategy rules.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {variant === 'embedded' && (
                <button
                  type="button"
                  onClick={() => setCollapsedEmbedded((c) => !c)}
                  className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#8B949E] hover:border-[#38BDF8] hover:text-[#E6EDF3] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {collapsedEmbedded ? 'Expand Matrix' : 'Compact View'}
                </button>
              )}
              {onBackToDesk && variant === 'page' && (
                <button
                  type="button"
                  onClick={onBackToDesk}
                  className="border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Back to Desk
                </button>
              )}
              {onOpenFilterStrategies && (
                <button
                  type="button"
                  onClick={onOpenFilterStrategies}
                  className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Filter className="h-3.5 w-3.5" />
                  <span>Filter &amp; Add Strategies</span>
                </button>
              )}
              <button
                type="button"
                disabled={evaluatingSignals}
                onClick={() => void evaluateSignals()}
                className="flex items-center gap-1.5 border border-[#2B3548] bg-[#0B0E14] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${evaluatingSignals ? 'animate-spin' : ''}`} />
                <span>{evaluatingSignals ? 'Scanning...' : 'Scan Markets'}</span>
              </button>
              {liveStrategyBasket && (
                <button
                  type="button"
                  disabled={busyKey === 'basket-toggle'}
                  onClick={() => void handleToggleBasketEnabled()}
                  className={`flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                    liveStrategyBasket.enabled
                      ? 'border-[#F59E0B]/60 bg-[#F59E0B]/10 text-[#F59E0B] hover:bg-[#F59E0B]/20'
                      : 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81] hover:bg-[#0ECB81]/25'
                  }`}
                >
                  {liveStrategyBasket.enabled ? (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause All</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      <span>Resume All</span>
                    </>
                  )}
                </button>
              )}
              {onOpenMainSignals && (
                <button
                  type="button"
                  onClick={onOpenMainSignals}
                  className="flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/10 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/20 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Activity className="h-3.5 w-3.5" />
                  <span>Main Signals ({summaryStats.totalLiveOpen})</span>
                </button>
              )}
            </div>
          </div>

          {/* 4-Column Real Performance & Arming KPI Strip */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="border border-[#1D2432] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                <span>Arming Status</span>
                <ShieldCheck
                  className={`h-3.5 w-3.5 ${
                    summaryStats.armedCount > 0 && liveStrategyBasket?.enabled
                      ? 'text-[#0ECB81]'
                      : 'text-[#F59E0B]'
                  }`}
                />
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#E6EDF3] tabular-nums">
                {summaryStats.armedCount} Strateg{summaryStats.armedCount === 1 ? 'y' : 'ies'} Armed
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                {summaryStats.slotCount} Slot(s) ·{' '}
                {liveStrategyBasket?.enabled
                  ? 'Active Scanning'
                  : liveStrategyBasket
                    ? 'Paused'
                    : 'No Slot Armed'}
              </div>
            </div>

            <div className="border border-[#1D2432] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                <span>Live Signal Activity</span>
                <Activity className="h-3.5 w-3.5 text-[#38BDF8]" />
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#E6EDF3] tabular-nums">
                {summaryStats.firingCount} Firing · {summaryStats.totalLiveOpen} Open
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                {summaryStats.totalLiveEmitted} Total Signal{summaryStats.totalLiveEmitted === 1 ? '' : 's'} Emitted
              </div>
            </div>

            <div className="border border-[#1D2432] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                <span>Validated OOS Benchmark</span>
                <BarChart3 className="h-3.5 w-3.5 text-[#0ECB81]" />
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#E6EDF3] tabular-nums">
                {summaryStats.avgOosWinRate !== null
                  ? `${summaryStats.avgOosWinRate.toFixed(1)}% Avg Win`
                  : loadingMetrics
                    ? 'Loading OOS...'
                    : 'No Discovery Stats'}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                Avg PF {summaryStats.avgOosPf !== null ? summaryStats.avgOosPf.toFixed(2) : '—'} ·
                OOS Score {summaryStats.avgOosScore !== null ? summaryStats.avgOosScore.toFixed(0) : '—'}
              </div>
            </div>

            <div className="border border-[#1D2432] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                <span>Live Signal Outcomes</span>
                <CandlestickChart className="h-3.5 w-3.5 text-[#38BDF8]" />
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#E6EDF3] tabular-nums">
                {summaryStats.liveWinRate !== null
                  ? `${summaryStats.liveWinRate.toFixed(1)}% Live Win`
                  : 'Awaiting Closed Trades'}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                {summaryStats.totalWins} TP Hits · {summaryStats.totalLosses} SL ·{' '}
                {signalSettings.requireRegimeCompatibility ? 'Regime Filter ON' : 'All Regimes'}
              </div>
            </div>
          </div>

          {feedback && (
            <div
              className={`flex items-center justify-between border px-3 py-2 text-xs ${
                feedback.type === 'error'
                  ? 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  : 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
              }`}
            >
              <span>{feedback.text}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="underline text-[11px] cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}
        </section>

        {!(variant === 'embedded' && collapsedEmbedded) && (
          <>
            {/* Empty State when no strategies armed or cached */}
            {allRows.length === 0 ? (
              <section className="border border-[#222938] bg-[#12161F] p-8 text-center">
                <ShieldAlert className="mx-auto h-8 w-8 text-[#F59E0B]" />
                <h2 className="mt-2 text-sm font-semibold text-[#E6EDF3]">
                  No Signal Strategies Currently Armed
                </h2>
                <p className="mx-auto mt-1 max-w-lg text-xs text-[#8B949E]">
                  Filter and add up to 10 strategies per market/timeframe slot to visualize their arming state, live signal triggers, and validated OOS performance metrics here.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {onOpenFilterStrategies && (
                    <button
                      type="button"
                      onClick={onOpenFilterStrategies}
                      className="flex items-center gap-1.5 border border-[#38BDF8] bg-[#38BDF8]/15 px-3.5 py-2 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                    >
                      <Filter className="h-3.5 w-3.5" />
                      <span>Filter &amp; Add Strategies</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={armingBest}
                    onClick={() => void handleAutoArmBest()}
                    className="flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3.5 py-2 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>{armingBest ? 'Arming Best...' : 'Auto-Arm Best Strategies'}</span>
                  </button>
                  {onOpenDiscovery && (
                    <button
                      type="button"
                      onClick={onOpenDiscovery}
                      className="border border-[#222938] bg-[#0B0E14] px-3.5 py-2 text-xs text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                    >
                      Open Discovery Scanner
                    </button>
                  )}
                </div>
              </section>
            ) : (
              <>
                {/* Visual Side-by-Side Performance Comparison across Armed Strategies */}
                {comparativeBars.length > 0 && (
                  <section className="border border-[#222938] bg-[#12161F] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2">
                      <div>
                        <h2 className="text-xs font-semibold text-[#E6EDF3]">
                          Armed Strategy Performance Comparison ({comparativeBars.length})
                        </h2>
                        <p className="text-[11px] text-[#8B949E]">
                          Ranked by OOS validation score &amp; win rate. Click any bar row to inspect strategy rules and live signals.
                        </p>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[10px] text-[#8B949E]">
                        <span>Bar = OOS Win %</span>
                        <span>·</span>
                        <span>Right = PF / Expectancy / OOS Score</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {comparativeBars.map((row, idx) => {
                        const pct = Math.max(0, Math.min(maxChartWinRate, row.oosWinRate ?? 0));
                        const isFiring = row.armingState === 'FIRING';
                        return (
                          <button
                            key={`bar-${row.rowKey}`}
                            type="button"
                            onClick={() =>
                              setExpandedKey((k) => (k === row.rowKey ? null : row.rowKey))
                            }
                            className={`flex flex-col gap-1.5 border px-3 py-2 text-left transition-colors cursor-pointer ${
                              expandedKey === row.rowKey
                                ? 'border-[#38BDF8] bg-[#161B26]'
                                : 'border-[#1D2432] bg-[#0B0E14] hover:border-[#2B3548]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono text-[10px] text-[#8B949E] tabular-nums">
                                  {String(idx + 1).padStart(2, '0')}.
                                </span>
                                <span className="truncate font-medium text-[#E6EDF3]">
                                  {row.strategy.name}
                                </span>
                              </div>
                              <span
                                className={`font-mono text-[10px] whitespace-nowrap shrink-0 ${
                                  isFiring
                                    ? 'font-semibold text-[#0ECB81]'
                                    : row.armingState === 'PAUSED'
                                      ? 'text-[#F59E0B]'
                                      : 'text-[#38BDF8]'
                                }`}
                              >
                                {row.symbol} {row.timeframe}
                                {isFiring ? ` · ${row.liveOpenSignals.length} LIVE` : ''}
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 bg-[#161B26] overflow-hidden">
                                <div
                                  className={`h-full ${
                                    isFiring
                                      ? 'bg-[#0ECB81]'
                                      : (row.oosWinRate ?? 0) >= 55
                                        ? 'bg-[#38BDF8]'
                                        : (row.oosWinRate ?? 0) >= 45
                                          ? 'bg-[#F59E0B]'
                                          : 'bg-[#6E7681]'
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <div className="flex items-center gap-2 font-mono text-[10px] text-[#C9D1D9] tabular-nums shrink-0">
                                <span>
                                  {row.oosWinRate !== null ? `${row.oosWinRate.toFixed(1)}%` : '—'}
                                </span>
                                <span className="text-[#4B5563]">·</span>
                                <span>
                                  PF{' '}
                                  {row.oosProfitFactor !== null
                                    ? row.oosProfitFactor.toFixed(2)
                                    : '—'}
                                </span>
                                <span className="text-[#4B5563]">·</span>
                                <span className="text-[#8B949E]">
                                  {row.oosScore !== null ? `Score ${row.oosScore.toFixed(0)}` : 'Catalog'}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Filter Controls & Full Strategy Matrix */}
                <section className="border border-[#222938] bg-[#12161F] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedSlotKey('ALL')}
                        className={`border px-2.5 py-1 font-mono text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                          selectedSlotKey === 'ALL'
                            ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-semibold'
                            : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                        }`}
                      >
                        All Slots ({armedRows.length})
                      </button>
                      {armedSlots.map((slot) => {
                        const key = `${slot.symbol}:${slot.timeframe}`;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedSlotKey(key)}
                            className={`border px-2.5 py-1 font-mono text-[11px] whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                              selectedSlotKey === key
                                ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-semibold'
                                : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                            }`}
                          >
                            {slot.symbol} {slot.timeframe} ({slot.strategies.length}/10)
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B949E]" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search strategy..."
                          className="w-44 border border-[#222938] bg-[#0B0E14] pl-7 pr-2 py-1 text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                        />
                      </div>

                      <select
                        aria-label="Filter by arming status"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                        className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none cursor-pointer"
                      >
                        <option value="ALL">All Statuses</option>
                        <option value="FIRING">Signal Active Now ({summaryStats.firingCount})</option>
                        <option value="MONITORING">Armed &amp; Scanning</option>
                        <option value="PAUSED">Paused</option>
                        {effectiveUnarmed.length > 0 && (
                          <option value="UNARMED">
                            Recently Unarmed ({effectiveUnarmed.length})
                          </option>
                        )}
                      </select>

                      <select
                        aria-label="Filter by category"
                        value={categoryFilter}
                        onChange={(e) =>
                          setCategoryFilter(e.target.value as 'ALL' | BacktestStrategyCategory)
                        }
                        className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none cursor-pointer"
                      >
                        <option value="ALL">All Categories</option>
                        <option value="SMC">SMC</option>
                        <option value="Price Action">Price Action</option>
                        <option value="Chart Patterns">Chart Patterns</option>
                        <option value="Support & Resistance">Support &amp; Resistance</option>
                        <option value="Hybrid SMC/PA">Hybrid SMC/PA</option>
                      </select>

                      {liveStrategyBasket && (
                        <button
                          type="button"
                          onClick={() => void clearLiveStrategyBasket()}
                          className="flex items-center gap-1 border border-[#F6465D]/40 bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#F6465D] hover:bg-[#F6465D]/10 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Clear Basket</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* High-Density Strategy Matrix Table */}
                  <div className="overflow-x-auto border border-[#222938] bg-[#0B0E14]">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-[#222938] bg-[#161B26] text-[11px] text-[#8B949E]">
                        <tr>
                          <th className="px-3 py-2 font-medium">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('name')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>Strategy</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-2.5 py-2 font-medium">Slot &amp; HTF</th>
                          <th className="px-2.5 py-2 font-medium">Arming Status</th>
                          <th className="px-2.5 py-2 font-medium">Readiness</th>
                          <th className="px-2.5 py-2 font-medium text-right">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('winRate')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>OOS Win %</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-2.5 py-2 font-medium text-right">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('profitFactor')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>PF</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-2.5 py-2 font-medium text-right">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('expectancyR')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>Exp (R)</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-2.5 py-2 font-medium text-right">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('oosScore')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>Score</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-2.5 py-2 font-medium text-right">
                            <button
                              type="button"
                              onClick={() => handleToggleSort('liveSignals')}
                              className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
                            >
                              <span>Live Signals</span>
                              <ArrowDownUp className="h-3 w-3" />
                            </button>
                          </th>
                          <th className="px-3 py-2 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432]">
                        {displayedRows.length === 0 ? (
                          <tr>
                            <td colSpan={10} className="px-4 py-8 text-center text-xs text-[#8B949E]">
                              No strategies match your current filters.
                            </td>
                          </tr>
                        ) : (
                          displayedRows.map((row, idx) => {
                            const badge = formatArmingBadge(row.armingState);
                            const isExpanded = expandedKey === row.rowKey;
                            const busy = busyKey === row.rowKey;

                            return (
                              <Fragment key={row.rowKey}>
                                <tr className="hover:bg-[#161B26]/65 transition-colors">
                                  <td className="px-3 py-2.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedKey((k) =>
                                          k === row.rowKey ? null : row.rowKey
                                        )
                                      }
                                      className="flex items-start gap-1.5 text-left cursor-pointer group"
                                    >
                                      {isExpanded ? (
                                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#38BDF8]" />
                                      ) : (
                                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8B949E] group-hover:text-[#38BDF8]" />
                                      )}
                                      <div>
                                        <div className="font-medium text-[#E6EDF3] group-hover:text-[#38BDF8]">
                                          <span className="mr-1.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                                            {String(idx + 1).padStart(2, '0')}
                                          </span>
                                          {row.strategy.name}
                                        </div>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[#8B949E]">
                                          <span>{row.strategy.category}</span>
                                          <span aria-hidden="true">·</span>
                                          <span className="font-mono">{row.strategy.id}</span>
                                          {row.metricsSource === 'slot_aggregate' && (
                                            <>
                                              <span aria-hidden="true">·</span>
                                              <span className="text-[#F59E0B]">Slot Avg</span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </button>
                                  </td>

                                  <td className="px-2.5 py-2.5 font-mono text-[11px] tabular-nums whitespace-nowrap">
                                    <div className="font-semibold text-[#E6EDF3]">{row.symbol}</div>
                                    <div className="text-[10px] text-[#8B949E]">
                                      {row.timeframe} → {row.htfTimeframe}
                                    </div>
                                  </td>

                                  <td className="px-2.5 py-2.5 whitespace-nowrap">
                                    <span
                                      className={`inline-block border px-2 py-0.5 font-mono text-[10px] font-semibold ${badge.className}`}
                                    >
                                      {badge.label}
                                    </span>
                                  </td>

                                  <td className="px-2.5 py-2.5 font-mono text-[11px] whitespace-nowrap">
                                    <span className={formatReadinessColor(row.readiness)}>
                                      {row.readiness ?? 'Catalog'}
                                    </span>
                                  </td>

                                  <td className="px-2.5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                                    <div
                                      className={
                                        (row.oosWinRate ?? 0) >= 55
                                          ? 'font-semibold text-[#0ECB81]'
                                          : (row.oosWinRate ?? 0) >= 45
                                            ? 'text-[#E6EDF3]'
                                            : 'text-[#8B949E]'
                                      }
                                    >
                                      {row.oosWinRate !== null
                                        ? `${row.oosWinRate.toFixed(1)}%`
                                        : '—'}
                                    </div>
                                    {row.oosTrades !== null && (
                                      <div className="text-[10px] text-[#8B949E]">
                                        {row.oosTrades} trades
                                      </div>
                                    )}
                                  </td>

                                  <td className="px-2.5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                                    <span
                                      className={
                                        (row.oosProfitFactor ?? 0) >= 1.5
                                          ? 'font-semibold text-[#0ECB81]'
                                          : (row.oosProfitFactor ?? 0) >= 1.15
                                            ? 'text-[#E6EDF3]'
                                            : 'text-[#8B949E]'
                                      }
                                    >
                                      {row.oosProfitFactor !== null
                                        ? row.oosProfitFactor.toFixed(2)
                                        : '—'}
                                    </span>
                                  </td>

                                  <td className="px-2.5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                                    <span
                                      className={
                                        (row.oosExpectancyR ?? 0) > 0
                                          ? 'text-[#0ECB81]'
                                          : row.oosExpectancyR !== null
                                            ? 'text-[#F6465D]'
                                            : 'text-[#8B949E]'
                                      }
                                    >
                                      {row.oosExpectancyR !== null
                                        ? `${row.oosExpectancyR >= 0 ? '+' : ''}${row.oosExpectancyR.toFixed(2)}R`
                                        : '—'}
                                    </span>
                                  </td>

                                  <td className="px-2.5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap text-[#38BDF8]">
                                    {row.oosScore !== null ? row.oosScore.toFixed(1) : '—'}
                                  </td>

                                  <td className="px-2.5 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                                    {row.liveOpenSignals.length > 0 ? (
                                      <div className="text-[#0ECB81] font-semibold">
                                        {row.liveOpenSignals.length} Open (
                                        {row.liveOpenSignals[0].direction})
                                      </div>
                                    ) : (
                                      <div className="text-[#8B949E]">
                                        {row.liveMatchedSignals.length} Emitted
                                      </div>
                                    )}
                                    <div className="text-[10px] text-[#8B949E]">
                                      {row.liveWinRate !== null
                                        ? `${row.liveWinRate.toFixed(0)}% Win (${row.liveWins}W/${row.liveLosses}L)`
                                        : row.liveWatchingCount > 0
                                          ? `${row.liveWatchingCount} Watching`
                                          : 'Awaiting setup'}
                                    </div>
                                  </td>

                                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                    <div className="inline-flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          selectSymbol(row.symbol);
                                          selectTimeframe(row.timeframe);
                                          onSwitchToChart?.(row.symbol, row.timeframe);
                                        }}
                                        className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[10px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                                      >
                                        Chart
                                      </button>
                                      {row.isArmed ? (
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => void handleUnarmStrategy(row)}
                                          className="border border-[#F6465D]/40 bg-[#12161F] px-2 py-1 text-[10px] text-[#F6465D] hover:bg-[#F6465D]/15 cursor-pointer disabled:opacity-50"
                                        >
                                          Unarm
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => void handleRearmStrategy(row)}
                                          className="flex items-center gap-1 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2 py-1 text-[10px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                                        >
                                          <Plus className="h-3 w-3" />
                                          <span>Re-arm</span>
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                </tr>

                                {isExpanded && (
                                  <tr className="bg-[#12161F]">
                                    <td colSpan={10} className="px-4 py-3 border-t border-[#1D2432]">
                                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                                        {/* Rules & Summary */}
                                        <div className="space-y-2 text-xs">
                                          <div className="font-semibold text-[#E6EDF3]">
                                            Strategy Logic &amp; Rules
                                          </div>
                                          {row.catalogDef?.summary && (
                                            <p className="text-[11px] text-[#C9D1D9]">
                                              {row.catalogDef.summary}
                                            </p>
                                          )}
                                          {row.catalogDef?.entryRules &&
                                            row.catalogDef.entryRules.length > 0 && (
                                              <div>
                                                <div className="text-[10px] font-semibold text-[#38BDF8]">
                                                  Entry Rules
                                                </div>
                                                <ul className="mt-1 space-y-0.5 text-[11px] text-[#8B949E]">
                                                  {row.catalogDef.entryRules.map((rule, rIdx) => (
                                                    <li key={rIdx}>• {rule}</li>
                                                  ))}
                                                </ul>
                                              </div>
                                            )}
                                          {row.catalogDef?.riskRules &&
                                            row.catalogDef.riskRules.length > 0 && (
                                              <div>
                                                <div className="text-[10px] font-semibold text-[#0ECB81]">
                                                  Risk &amp; Exit Rules
                                                </div>
                                                <ul className="mt-1 space-y-0.5 text-[11px] text-[#8B949E]">
                                                  {row.catalogDef.riskRules.map((rule, rIdx) => (
                                                    <li key={rIdx}>• {rule}</li>
                                                  ))}
                                                </ul>
                                              </div>
                                            )}
                                        </div>

                                        {/* Backtest & Validation Telemetry */}
                                        <div className="space-y-2 text-xs font-mono tabular-nums">
                                          <div className="font-sans font-semibold text-[#E6EDF3]">
                                            Out-of-Sample &amp; Regime Diagnostics
                                          </div>
                                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] border border-[#222938] bg-[#0B0E14] p-2.5">
                                            <div className="text-[#8B949E]">OOS Return</div>
                                            <div className="text-right text-[#E6EDF3]">
                                              {row.oosNetReturnPercent !== null
                                                ? `${row.oosNetReturnPercent >= 0 ? '+' : ''}${row.oosNetReturnPercent.toFixed(1)}%`
                                                : '—'}
                                            </div>
                                            <div className="text-[#8B949E]">Max Drawdown</div>
                                            <div className="text-right text-[#F6465D]">
                                              {row.oosMaxDrawdownPercent !== null
                                                ? `-${row.oosMaxDrawdownPercent.toFixed(1)}%`
                                                : '—'}
                                            </div>
                                            <div className="text-[#8B949E]">Walk-Forward</div>
                                            <div className="text-right text-[#C9D1D9]">
                                              {row.wfConsistencyPercent !== null
                                                ? `${row.wfConsistencyPercent.toFixed(0)}% (${row.wfProfitableFolds}/${row.wfActiveFolds})`
                                                : '—'}
                                            </div>
                                            <div className="text-[#8B949E]">IS vs OOS Exp</div>
                                            <div className="text-right text-[#C9D1D9]">
                                              {row.isExpectancyR !== null &&
                                              row.oosExpectancyR !== null
                                                ? `${row.isExpectancyR.toFixed(2)}R / ${row.oosExpectancyR.toFixed(2)}R`
                                                : '—'}
                                            </div>
                                            <div className="text-[#8B949E]">Holdout Win %</div>
                                            <div className="text-right text-[#C9D1D9]">
                                              {row.holdoutWinRate !== null
                                                ? `${row.holdoutWinRate.toFixed(1)}%`
                                                : '—'}
                                            </div>
                                            <div className="text-[#8B949E]">Best Regime</div>
                                            <div className="text-right text-[#0ECB81]">
                                              {row.bestRegime ?? '—'}
                                            </div>
                                            <div className="text-[#8B949E]">Poor Regimes</div>
                                            <div className="text-right text-[#F59E0B]">
                                              {row.poorRegimes.length > 0
                                                ? row.poorRegimes.join(', ')
                                                : 'None'}
                                            </div>
                                            <div className="text-[#8B949E]">Avoid Sessions</div>
                                            <div className="text-right text-[#C9D1D9]">
                                              {row.avoidSessions.length > 0
                                                ? row.avoidSessions.join(', ')
                                                : 'None'}
                                            </div>
                                          </div>
                                          {row.metricsSource === 'none' && onOpenDiscovery && (
                                            <button
                                              type="button"
                                              onClick={onOpenDiscovery}
                                              className="w-full border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2.5 py-1.5 font-sans text-[11px] font-medium text-[#38BDF8] hover:bg-[#38BDF8]/20 cursor-pointer"
                                            >
                                              Run Discovery Scan to Compute OOS Stats
                                            </button>
                                          )}
                                        </div>

                                        {/* Emitted Live Signals */}
                                        <div className="space-y-2 text-xs">
                                          <div className="flex items-center justify-between">
                                            <span className="font-semibold text-[#E6EDF3]">
                                              Recent Signals by This Strategy (
                                              {row.liveMatchedSignals.length})
                                            </span>
                                            {row.liveAvgR !== null && (
                                              <span className="font-mono text-[11px] text-[#0ECB81] tabular-nums">
                                                Live Avg {row.liveAvgR >= 0 ? '+' : ''}
                                                {row.liveAvgR.toFixed(2)}R
                                              </span>
                                            )}
                                          </div>

                                          {row.liveMatchedSignals.length === 0 ? (
                                            <div className="border border-[#222938] bg-[#0B0E14] p-3 text-[11px] text-[#8B949E]">
                                              No live BUY/SELL signals triggered by this strategy yet. It is{' '}
                                              {row.armingState === 'PAUSED'
                                                ? 'currently paused.'
                                                : 'actively watching closed candles for a valid setup.'}
                                            </div>
                                          ) : (
                                            <div className="space-y-1.5">
                                              {row.liveMatchedSignals.slice(0, 4).map((sig) => (
                                                <div
                                                  key={sig.id}
                                                  className="flex items-center justify-between gap-2 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 font-mono text-[11px] tabular-nums"
                                                >
                                                  <div>
                                                    <span
                                                      className={
                                                        sig.direction === 'BUY'
                                                          ? 'font-semibold text-[#0ECB81]'
                                                          : 'font-semibold text-[#F6465D]'
                                                      }
                                                    >
                                                      {sig.direction}
                                                    </span>{' '}
                                                    <span className="text-[#E6EDF3]">{sig.symbol}</span>{' '}
                                                    <span className="text-[#8B949E]">
                                                      {sig.entryTimeframe} · {sig.state}
                                                    </span>
                                                  </div>
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-[#C9D1D9]">
                                                      Score {sig.score}
                                                    </span>
                                                    <button
                                                      type="button"
                                                      onClick={() => {
                                                        selectSymbol(sig.symbol);
                                                        selectTimeframe(sig.entryTimeframe);
                                                        const nowSec = Math.floor(Date.now() / 1000);
                                                        focusChartObject(
                                                          sig.id,
                                                          sig.candleTime - 3600,
                                                          Math.max(sig.candleTime + 1800, nowSec)
                                                        );
                                                        onSwitchToChart?.(
                                                          sig.symbol,
                                                          sig.entryTimeframe
                                                        );
                                                      }}
                                                      className="text-[#38BDF8] hover:underline cursor-pointer"
                                                    >
                                                      Focus
                                                    </button>
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          )}

                                          {onOpenLiveStrategy && (
                                            <button
                                              type="button"
                                              onClick={onOpenLiveStrategy}
                                              className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                                            >
                                              Compare Against Live Market Regime
                                            </button>
                                          )}
                                        </div>
                                      </div>
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
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
