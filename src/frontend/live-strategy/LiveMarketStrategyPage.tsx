import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clock,
  Compass,
  Database,
  Filter,
  Flame,
  Layers,
  PauseCircle,
  Play,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Target,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getInstrumentMeta, INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  BacktestStrategyCategory,
  InstrumentSymbol,
  LiveConditionFilterMode,
  LiveMarketStrategyReport,
  StrategyMatchItem,
  StrategyRecommendationStatus,
  Timeframe,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';

const SUPPORTED_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];

function statusBadgeStyle(status: StrategyRecommendationStatus): string {
  switch (status) {
    case 'BEST MATCH':
      return 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81]';
    case 'GOOD MATCH':
      return 'border-[#38BDF8]/60 bg-[#38BDF8]/15 text-[#38BDF8]';
    case 'MODERATE MATCH':
      return 'border-[#F59E0B]/60 bg-[#F59E0B]/15 text-[#F59E0B]';
    case 'POOR MATCH':
      return 'border-[#F6465D]/60 bg-[#F6465D]/15 text-[#F6465D]';
    case 'INSUFFICIENT DATA':
    default:
      return 'border-[#30363D] bg-[#1C2331] text-[#8B949E]';
  }
}

function directionColor(direction: string): string {
  if (direction.includes('Uptrend') || direction === 'Bullish') return 'text-[#0ECB81]';
  if (direction.includes('Downtrend') || direction === 'Bearish') return 'text-[#F6465D]';
  return 'text-[#F59E0B]';
}

function volatilityColor(vol: string): string {
  switch (vol) {
    case 'Extreme':
      return 'text-[#F6465D]';
    case 'High':
      return 'text-[#F59E0B]';
    case 'Normal':
      return 'text-[#0ECB81]';
    case 'Low':
      return 'text-[#38BDF8]';
    default:
      return 'text-[#8B949E]';
  }
}

function readinessBadge(readiness?: string): string {
  switch (readiness) {
    case 'Production Ready':
      return 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]';
    case 'Verify Paper':
      return 'border-[#38BDF8]/50 bg-[#38BDF8]/10 text-[#38BDF8]';
    case 'Overfit / Decayed':
      return 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]';
    default:
      return 'border-[#30363D] bg-[#0B0E14] text-[#8B949E]';
  }
}

function formatTs(ms: number | null | undefined, timezone: string): string {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

function formatReturn(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

function formatExpectancy(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}R`;
}

export function LiveMarketStrategyPage({
  onBackToTerminal,
  onOpenDiscovery,
  onOpenSimulator,
  onOpenBacktest,
}: {
  onBackToTerminal: () => void;
  onOpenDiscovery: () => void;
  onOpenSimulator: () => void;
  onOpenBacktest: () => void;
}) {
  const {
    symbol: terminalSymbol,
    timeframe: terminalTimeframe,
    selectSymbol,
    selectTimeframe,
    quotes,
    snapshot,
    timezone,
    socketConnected,
    liveStrategyBasket,
    updateLiveStrategyBasket,
    removeBasketItem,
  } = useTerminal();

  const initialTf: Timeframe = SUPPORTED_TIMEFRAMES.includes(terminalTimeframe)
    ? terminalTimeframe
    : '15m';

  const [selectedSymbol, setSelectedSymbol] = useState<InstrumentSymbol>(terminalSymbol);
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(initialTf);
  const [conditionFilterMode, setConditionFilterMode] = useState<LiveConditionFilterMode>('all');
  const [statusFilter, setStatusFilter] = useState<'ALL' | StrategyRecommendationStatus>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | BacktestStrategyCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [requireVolMatch, setRequireVolMatch] = useState(false);
  const [requireTrendMatch, setRequireTrendMatch] = useState(false);
  const [requireRegimeMatch, setRequireRegimeMatch] = useState(false);
  const [visibleCardCap, setVisibleCardCap] = useState<number>(12);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [report, setReport] = useState<LiveMarketStrategyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedChartRank, setSelectedChartRank] = useState<number>(1);
  const [armingId, setArmingId] = useState<string | null>(null);
  const [armNotice, setArmNotice] = useState<string | null>(null);

  const fetchSeqRef = useRef(0);
  const lastFetchedBarRef = useRef<string>('');

  // Keep market data WS feed subscribed to the inspected instrument & timeframe
  useEffect(() => {
    if (terminalSymbol !== selectedSymbol) {
      selectSymbol(selectedSymbol);
    }
  }, [selectedSymbol, terminalSymbol, selectSymbol]);

  useEffect(() => {
    if (terminalTimeframe !== selectedTimeframe) {
      selectTimeframe(selectedTimeframe);
    }
  }, [selectedTimeframe, terminalTimeframe, selectTimeframe]);

  const fetchReport = useCallback(
    async (
      sym: InstrumentSymbol,
      tf: Timeframe,
      filterMode: LiveConditionFilterMode,
      background = false
    ) => {
      const seq = ++fetchSeqRef.current;
      if (!background) setLoading(true);
      else setRefreshing(true);

      try {
        const res = await apiFetch(
          `/api/live-market-strategy/${encodeURIComponent(sym)}/${encodeURIComponent(tf)}?filter=${encodeURIComponent(filterMode)}&limit=50`
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `Failed to analyze live market (${res.status})`);
        }
        const data = (await res.json()) as LiveMarketStrategyReport;
        if (seq !== fetchSeqRef.current) return;
        setReport(data);
        setErrorMsg(null);
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setErrorMsg(err instanceof Error ? err.message : 'Unable to fetch live market analysis');
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    []
  );

  // Initial & selection change fetch
  useEffect(() => {
    void fetchReport(selectedSymbol, selectedTimeframe, conditionFilterMode, false);
  }, [selectedSymbol, selectedTimeframe, conditionFilterMode, fetchReport]);

  // Automatic real-time refresh whenever the live snapshot updates on matching symbol/timeframe
  const latestCandleTime = snapshot?.candles[snapshot.candles.length - 1]?.time ?? 0;
  const latestAnalyzedAt = snapshot?.lastAnalyzedAt ?? 0;
  useEffect(() => {
    if (!autoRefresh) return;
    if (!snapshot) return;
    if (snapshot.symbol !== selectedSymbol || snapshot.timeframe !== selectedTimeframe) return;
    const key = `${snapshot.symbol}:${snapshot.timeframe}:${conditionFilterMode}:${latestCandleTime}:${latestAnalyzedAt}`;
    if (lastFetchedBarRef.current === key) return;
    lastFetchedBarRef.current = key;
    void fetchReport(selectedSymbol, selectedTimeframe, conditionFilterMode, true);
  }, [
    autoRefresh,
    snapshot,
    selectedSymbol,
    selectedTimeframe,
    conditionFilterMode,
    latestCandleTime,
    latestAnalyzedAt,
    fetchReport,
  ]);

  // Periodic background quote/session sync (reuses cached historical DB & candle memory, zero re-backtesting)
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void fetchReport(selectedSymbol, selectedTimeframe, conditionFilterMode, true);
    }, 12000);
    return () => clearInterval(timer);
  }, [autoRefresh, selectedSymbol, selectedTimeframe, conditionFilterMode, fetchReport]);

  const isSlotStrategyArmed = useCallback(
    (sym: InstrumentSymbol, tf: Timeframe, strategyId: string): boolean => {
      if (!liveStrategyBasket) return false;
      if (Array.isArray(liveStrategyBasket.assignments) && liveStrategyBasket.assignments.length > 0) {
        return liveStrategyBasket.assignments.some(
          (slot) =>
            slot.symbol === sym &&
            slot.timeframe === tf &&
            slot.strategies.some((s) => s.id === strategyId)
        );
      }
      return (
        liveStrategyBasket.symbol === sym &&
        liveStrategyBasket.timeframe === tf &&
        liveStrategyBasket.strategies.some((s) => s.id === strategyId)
      );
    },
    [liveStrategyBasket]
  );

  const handleArmStrategy = async (item: StrategyMatchItem) => {
    setArmingId(item.strategy.id);
    setArmNotice(null);
    try {
      if (isSlotStrategyArmed(selectedSymbol, item.matchedTimeframe, item.strategy.id)) {
        await removeBasketItem(selectedSymbol, item.matchedTimeframe, item.strategy.id);
        setArmNotice(
          `Removed "${item.strategy.name}" (${selectedSymbol} ${item.matchedTimeframe}) from Main Signals.`
        );
        return;
      }
      const htfTf: Timeframe =
        item.matchedTimeframe === '1m' || item.matchedTimeframe === '5m'
          ? '1H'
          : item.matchedTimeframe === '15m' || item.matchedTimeframe === '30m'
            ? '1H'
            : item.matchedTimeframe === '1H'
              ? '4H'
              : '1D';
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: selectedSymbol,
        timeframe: item.matchedTimeframe,
        htfTimeframe: htfTf,
        strategyIds: [item.strategy.id],
        assignments: [
          {
            symbol: selectedSymbol,
            timeframe: item.matchedTimeframe,
            htfTimeframe: htfTf,
            strategies: [
              {
                id: item.strategy.id,
                name: item.strategy.name,
                category: item.strategy.category,
              },
            ],
            bestRegime: item.bestRegime,
            avoidSessions: item.avoidSessions,
            oosWinRate: item.recentOosPerformance.winRate,
            oosProfitFactor: item.recentOosPerformance.profitFactor,
            oosExpectancyR: item.recentOosPerformance.expectancyR,
            oosScore: item.matchingScore,
            sourceRunId: item.sourceRunId,
          },
        ],
        selectionLabel: `${selectedSymbol} ${item.matchedTimeframe} — ${item.strategy.name}`,
        maxConcurrentPositions: 4,
        minRiskReward: 1.5,
        sourceRunId: item.sourceRunId,
        mode: 'merge',
      });
      setArmNotice(
        `Added "${item.strategy.name}" on ${selectedSymbol} (${item.matchedTimeframe}) to Main Signals (${basket?.strategies.length ?? 1} total armed).`
      );
    } catch (err) {
      setArmNotice(err instanceof Error ? err.message : 'Failed to update Main Signals');
    } finally {
      setArmingId(null);
    }
  };

  const handleArmFilteredTop = async (mode: 'merge' | 'replace' = 'merge') => {
    const candidates = filteredTopStrategies
      .filter((s) => s.status !== 'POOR MATCH' && s.strategy.id)
      .slice(0, 10);
    if (candidates.length === 0) {
      setArmNotice('No filtered compatible strategies available to add right now.');
      return;
    }
    setArmingId('filtered_batch');
    setArmNotice(null);
    try {
      const slotMap = new Map<
        string,
        {
          symbol: InstrumentSymbol;
          timeframe: Timeframe;
          htfTimeframe: Timeframe;
          strategies: Array<{ id: string; name: string; category: BacktestStrategyCategory }>;
          bestRegime: StrategyMatchItem['bestRegime'];
          avoidSessions: StrategyMatchItem['avoidSessions'];
          oosWinRate: number;
          oosProfitFactor: number | null;
          oosExpectancyR: number;
          oosScore: number;
          sourceRunId?: string;
        }
      >();
      for (const c of candidates) {
        const tf = c.matchedTimeframe;
        const htfTf: Timeframe =
          tf === '1m' || tf === '5m' || tf === '15m' || tf === '30m'
            ? '1H'
            : tf === '1H'
              ? '4H'
              : '1D';
        const key = `${selectedSymbol}__${tf}`;
        const existing = slotMap.get(key);
        const ref = { id: c.strategy.id, name: c.strategy.name, category: c.strategy.category };
        if (!existing) {
          slotMap.set(key, {
            symbol: selectedSymbol,
            timeframe: tf,
            htfTimeframe: htfTf,
            strategies: [ref],
            bestRegime: c.bestRegime,
            avoidSessions: c.avoidSessions,
            oosWinRate: c.recentOosPerformance.winRate,
            oosProfitFactor: c.recentOosPerformance.profitFactor,
            oosExpectancyR: c.recentOosPerformance.expectancyR,
            oosScore: c.matchingScore,
            sourceRunId: c.sourceRunId,
          });
        } else if (
          !existing.strategies.some((s) => s.id === c.strategy.id) &&
          existing.strategies.length < 10
        ) {
          existing.strategies.push(ref);
        }
      }
      const assignments = Array.from(slotMap.values());
      const lead = assignments[0];
      const strategyIds = Array.from(
        new Set(assignments.flatMap((slot) => slot.strategies.map((s) => s.id)))
      );
      const basket = await updateLiveStrategyBasket({
        enabled: true,
        symbol: lead.symbol,
        timeframe: lead.timeframe,
        htfTimeframe: lead.htfTimeframe,
        strategyIds,
        assignments,
        selectionLabel: `Filtered ${selectedSymbol} (${strategyIds.length} Strategies)`,
        maxConcurrentPositions: Math.min(8, Math.max(2, strategyIds.length)),
        minRiskReward: 1.5,
        sourceRunId: lead.sourceRunId,
        mode,
      });
      setArmNotice(
        `${mode === 'merge' ? 'Added' : 'Replaced'} ${strategyIds.length} filtered strategies on ${selectedSymbol} into Main Signals (${basket?.strategies.length ?? strategyIds.length} total armed).`
      );
    } catch (err) {
      setArmNotice(err instanceof Error ? err.message : 'Failed to add filtered strategies');
    } finally {
      setArmingId(null);
    }
  };

  const liveQuote = quotes[selectedSymbol];
  const meta = getInstrumentMeta(selectedSymbol);
  const cond = report?.condition;
  const decision = report?.decision;
  const coverage = report?.databaseCoverage;

  const livePrice =
    (liveQuote?.price && liveQuote.price > 0 ? liveQuote.price : undefined) ?? cond?.price ?? 0;
  const liveChangePct = liveQuote?.changePercent24h ?? cond?.changePercent24h ?? 0;

  const topStrategies = decision?.topStrategies ?? [];
  const filteredTopStrategies = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return topStrategies.filter((item) => {
      if (statusFilter !== 'ALL' && item.status !== statusFilter) return false;
      if (categoryFilter !== 'ALL' && item.strategy.category !== categoryFilter) return false;
      if (requireVolMatch && !item.conditionMatches.volatilityMatch) return false;
      if (requireTrendMatch && !item.conditionMatches.trendMatch) return false;
      if (requireRegimeMatch && !item.conditionMatches.regimeMatch) return false;
      if (q.length > 0) {
        const hay = `${item.strategy.name} ${item.strategy.category} ${item.bestRegime} ${item.bestTimeframe}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    topStrategies,
    statusFilter,
    categoryFilter,
    requireVolMatch,
    requireTrendMatch,
    requireRegimeMatch,
    searchQuery,
  ]);

  const activeChartItem =
    filteredTopStrategies.find((s) => s.rank === selectedChartRank) ??
    topStrategies.find((s) => s.rank === selectedChartRank) ??
    filteredTopStrategies[0] ??
    topStrategies[0] ??
    null;

  const comparisonChartData = useMemo(
    () =>
      filteredTopStrategies.slice(0, 10).map((s) => ({
        name:
          s.strategy.name.length > 16 ? `${s.strategy.name.slice(0, 15)}…` : s.strategy.name,
        fullName: s.strategy.name,
        matchingScore: s.matchingScore,
        expectancyR: Number(s.expectancyR.toFixed(2)),
        oosReturn: Number(s.recentOosPerformance.netReturnPercent.toFixed(1)),
        winRate: Number(s.winRate.toFixed(1)),
        status: s.status,
      })),
    [filteredTopStrategies]
  );

  const stageChartData = useMemo(() => {
    if (!activeChartItem) return [];
    return activeChartItem.performanceSeries.map((pt) => ({
      stage: pt.label,
      returnPercent: pt.returnPercent,
      expectancyR: pt.expectancyR,
      trades: pt.trades,
    }));
  }, [activeChartItem]);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-[#0B0E14] text-[#E6EDF3]">
      {/* Sticky Top Control Bar */}
      <div className="sticky top-0 z-20 border-b border-[#222938] bg-[#12161F]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          {/* Left: Back & Title */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onBackToTerminal}
              className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Chart Terminal</span>
            </button>

            <div>
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-[#0ECB81]" />
                <h1 className="text-sm font-bold tracking-wide text-[#E6EDF3]">
                  LIVE MARKET Strategy
                </h1>
                <span className="border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#38BDF8]">
                  DETERMINISTIC ENGINE
                </span>
              </div>
              <p className="text-[11px] text-[#8B949E]">
                Real-time technical regime &amp; structure matched strictly against cached SQLite backtest/discovery evidence.
              </p>
            </div>
          </div>

          {/* Center: Instrument & Timeframe Selectors */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center border border-[#222938] bg-[#0B0E14] p-0.5">
              {INSTRUMENTS.map((inst) => (
                <button
                  key={inst.symbol}
                  type="button"
                  onClick={() => setSelectedSymbol(inst.symbol)}
                  className={`px-2.5 py-1 font-mono text-xs font-semibold transition-colors cursor-pointer ${
                    selectedSymbol === inst.symbol
                      ? 'bg-[#1C2331] text-[#38BDF8] border border-[#38BDF8]/40'
                      : 'text-[#8B949E] hover:text-[#E6EDF3]'
                  }`}
                >
                  {inst.symbol}
                </button>
              ))}
            </div>

            <div className="flex items-center border border-[#222938] bg-[#0B0E14] p-0.5">
              {SUPPORTED_TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setSelectedTimeframe(tf)}
                  className={`px-2 py-1 font-mono text-xs transition-colors cursor-pointer ${
                    selectedTimeframe === tf
                      ? 'bg-[#1C2331] text-[#0ECB81] border border-[#0ECB81]/40 font-semibold'
                      : 'text-[#8B949E] hover:text-[#E6EDF3]'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Auto-Refresh & Navigation */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`flex items-center gap-1.5 border px-2.5 py-1.5 text-xs cursor-pointer ${
                autoRefresh
                  ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                  : 'border-[#222938] bg-[#0B0E14] text-[#8B949E]'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  autoRefresh && socketConnected ? 'bg-[#0ECB81]' : 'bg-[#8B949E]'
                }`}
              />
              <span>Auto Live: {autoRefresh ? 'ON' : 'OFF'}</span>
            </button>

            <button
              type="button"
              disabled={refreshing}
              onClick={() =>
                void fetchReport(selectedSymbol, selectedTimeframe, conditionFilterMode, true)
              }
              className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-[#38BDF8]' : ''}`} />
              <span>Analyze Now</span>
            </button>

            <button
              type="button"
              onClick={onOpenDiscovery}
              className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
            >
              <Compass className="h-3.5 w-3.5" />
              <span>Discovery DB</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
        {errorMsg && (
          <div className="flex items-center justify-between border border-[#F6465D]/50 bg-[#F6465D]/10 px-4 py-3 text-xs text-[#F6465D]">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                void fetchReport(selectedSymbol, selectedTimeframe, conditionFilterMode, false)
              }
              className="border border-[#F6465D]/50 px-2 py-1 text-xs hover:bg-[#F6465D]/20 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {armNotice && (
          <div className="flex items-center justify-between border border-[#0ECB81]/50 bg-[#0ECB81]/10 px-4 py-2.5 text-xs text-[#0ECB81]">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{armNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setArmNotice(null)}
              className="text-[#8B949E] hover:text-white cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading && !report ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-36 animate-pulse border border-[#222938] bg-[#12161F] p-4"
              />
            ))}
          </div>
        ) : cond && decision && coverage ? (
          <>
            {/* ROW 1: Live Price Strip + Timestamp + DB Coverage */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
              {/* Instrument & Live Price */}
              <div className="border border-[#222938] bg-[#12161F] p-3.5 lg:col-span-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-lg font-bold text-[#E6EDF3]">
                        {cond.symbol}
                      </span>
                      <span className="border border-[#222938] bg-[#0B0E14] px-2 py-0.5 font-mono text-xs text-[#38BDF8]">
                        {cond.timeframe} (HTF {cond.htfTimeframe})
                      </span>
                      <span
                        className={`border px-1.5 py-0.5 font-mono text-[10px] ${
                          cond.marketOpen
                            ? 'border-[#0ECB81]/40 bg-[#0ECB81]/10 text-[#0ECB81]'
                            : 'border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]'
                        }`}
                      >
                        {cond.marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#8B949E]">
                      {meta.name} · Feed: <span className="text-[#C9D1D9]">{cond.providerName}</span> ({cond.connectionStatus})
                    </div>
                  </div>

                  <div className="text-right font-mono tabular-nums">
                    <div className="text-xl font-bold text-[#E6EDF3]">
                      {livePrice > 0 ? livePrice.toFixed(meta.pricePrecision) : '—'}
                    </div>
                    <div
                      className={`text-xs font-medium ${
                        liveChangePct >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                      }`}
                    >
                      {liveChangePct >= 0 ? '+' : ''}
                      {liveChangePct.toFixed(2)}% (24h)
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#222938] pt-2.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                  <span>
                    Bid:{' '}
                    <span className="text-[#C9D1D9]">
                      {(liveQuote?.bid ?? cond.bid) !== undefined
                        ? (liveQuote?.bid ?? cond.bid)!.toFixed(meta.pricePrecision)
                        : '—'}
                    </span>{' '}
                    / Ask:{' '}
                    <span className="text-[#C9D1D9]">
                      {(liveQuote?.ask ?? cond.ask) !== undefined
                        ? (liveQuote?.ask ?? cond.ask)!.toFixed(meta.pricePrecision)
                        : '—'}
                    </span>
                  </span>
                  <span>
                    Session:{' '}
                    <span className="text-[#38BDF8] font-semibold">{cond.session}</span>
                  </span>
                </div>
              </div>

              {/* Actionable Decision & Market Suitability Banner */}
              <div
                className={`border p-3.5 lg:col-span-4 ${
                  decision.actionVerdict === 'TRADE NOW'
                    ? 'border-[#0ECB81]/60 bg-[#0ECB81]/5'
                    : decision.actionVerdict === 'SELECTIVE SETUP'
                      ? 'border-[#F59E0B]/60 bg-[#F59E0B]/5'
                      : 'border-[#F6465D]/50 bg-[#12161F]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8B949E]">
                    Live Market Verdict
                  </span>
                  <span
                    className={`flex items-center gap-1 border px-2 py-0.5 font-mono text-xs font-bold ${
                      decision.actionVerdict === 'TRADE NOW'
                        ? 'border-[#0ECB81] bg-[#0ECB81]/20 text-[#0ECB81]'
                        : decision.actionVerdict === 'SELECTIVE SETUP'
                          ? 'border-[#F59E0B] bg-[#F59E0B]/20 text-[#F59E0B]'
                          : 'border-[#F6465D] bg-[#F6465D]/20 text-[#F6465D]'
                    }`}
                  >
                    {decision.actionVerdict === 'TRADE NOW' ? (
                      <Play className="h-3 w-3" />
                    ) : decision.actionVerdict === 'SELECTIVE SETUP' ? (
                      <Target className="h-3 w-3" />
                    ) : (
                      <PauseCircle className="h-3 w-3" />
                    )}
                    {decision.actionVerdict}
                  </span>
                </div>

                <div className="mt-1.5 text-sm font-semibold text-[#E6EDF3]">
                  Market Suitability:{' '}
                  <span
                    className={
                      decision.marketSuitability === 'TRADEABLE'
                        ? 'text-[#0ECB81]'
                        : decision.marketSuitability === 'SELECTIVE'
                          ? 'text-[#F59E0B]'
                          : 'text-[#F6465D]'
                    }
                  >
                    {decision.marketSuitability === 'TRADEABLE'
                      ? 'Favorable — Validated Edge Active'
                      : decision.marketSuitability === 'SELECTIVE'
                        ? 'Selective — Wait for Trigger / Confirmation'
                        : 'Unfavorable or Unproven — Better to Wait'}
                  </span>
                </div>

                <ul className="mt-2 space-y-1 text-[11px] text-[#C9D1D9]">
                  {decision.verdictReasons.slice(0, 2).map((reason, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#38BDF8]" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Cached DB Coverage & Timestamp */}
              <div className="border border-[#222938] bg-[#12161F] p-3.5 lg:col-span-3">
                <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                  <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider">
                    <Database className="h-3.5 w-3.5 text-[#38BDF8]" />
                    Cached Strategy DB
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[10px]">
                    <Clock className="h-3 w-3" />
                    {formatTs(cond.analyzedAt, timezone)}
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2 font-mono text-xs tabular-nums">
                  <div className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#8B949E]">Discovery Scans</div>
                    <div className="font-semibold text-[#E6EDF3]">{coverage.discoveryRunsCount}</div>
                  </div>
                  <div className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#8B949E]">Backtest Runs</div>
                    <div className="font-semibold text-[#E6EDF3]">{coverage.backtestRunsCount}</div>
                  </div>
                  <div className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#8B949E]">Tested ({cond.symbol})</div>
                    <div className="font-semibold text-[#38BDF8]">
                      {coverage.uniqueStrategiesTested} strategies
                    </div>
                  </div>
                  <div className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#8B949E]">Evaluated Candles</div>
                    <div className="font-semibold text-[#C9D1D9]">
                      {formatTs(cond.latestCandleTime * 1000, timezone)}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ROW 2: Live Market Condition Analysis Dashboard */}
            <div className="border border-[#222938] bg-[#12161F] p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] pb-2.5">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-[#38BDF8]" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-[#E6EDF3]">
                    Live Market Condition Analysis ({cond.symbol} · {cond.timeframe})
                  </h2>
                </div>
                <span className="font-mono text-[11px] text-[#8B949E]">
                  Mapped Historical Regime:{' '}
                  <span className="text-[#38BDF8] font-semibold">{cond.discoveryRegimeMapping}</span>
                </span>
              </div>

              {/* Primary Indicators Grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[10px] uppercase text-[#8B949E]">Market Regime</div>
                  <div className="mt-1 text-sm font-bold text-[#38BDF8]">{cond.regime}</div>
                  <div className="mt-1 font-mono text-[10px] text-[#8B949E]">
                    ER {cond.efficiencyRatio.toFixed(2)} · EMA Sep {cond.emaSeparationAtr.toFixed(2)} ATR
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[10px] uppercase text-[#8B949E]">Market Direction</div>
                  <div className={`mt-1 text-sm font-bold ${directionColor(cond.direction)}`}>
                    {cond.direction}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[#8B949E]">
                    EMA20 {cond.ema20.toFixed(meta.pricePrecision)} / EMA50 {cond.ema50.toFixed(meta.pricePrecision)}
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[10px] uppercase text-[#8B949E]">Volatility (ATR)</div>
                  <div className={`mt-1 text-sm font-bold ${volatilityColor(cond.volatility)}`}>
                    {cond.volatility} ({cond.atrPercentile.toFixed(0)}th pct)
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[#8B949E]">
                    ATR {cond.atr.toFixed(meta.pricePrecision)} ({cond.atrPercent.toFixed(2)}%)
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#8B949E]">
                    <span>Trend Strength</span>
                    <span className="font-mono text-[#E6EDF3]">{cond.trendStrengthScore}/100</span>
                  </div>
                  <div className="mt-1 text-sm font-bold text-[#E6EDF3]">
                    {cond.trendStrengthLabel} (ADX {cond.adx.toFixed(1)})
                  </div>
                  <div className="mt-1.5 h-1.5 w-full bg-[#1C2331]">
                    <div
                      className="h-full bg-[#38BDF8]"
                      style={{ width: `${Math.min(100, cond.trendStrengthScore)}%` }}
                    />
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#8B949E]">
                    <span>Momentum</span>
                    <span className="font-mono text-[#E6EDF3]">{cond.momentumStrengthScore}/100</span>
                  </div>
                  <div className={`mt-1 text-sm font-bold ${directionColor(cond.momentumDirection)}`}>
                    {cond.momentumDirection} ({cond.momentumAtr >= 0 ? '+' : ''}
                    {cond.momentumAtr.toFixed(2)} ATR)
                  </div>
                  <div className="mt-1.5 h-1.5 w-full bg-[#1C2331]">
                    <div
                      className={`h-full ${
                        cond.momentumDirection === 'Bullish'
                          ? 'bg-[#0ECB81]'
                          : cond.momentumDirection === 'Bearish'
                            ? 'bg-[#F6465D]'
                            : 'bg-[#F59E0B]'
                      }`}
                      style={{ width: `${Math.min(100, cond.momentumStrengthScore)}%` }}
                    />
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[10px] uppercase text-[#8B949E]">Volume Activity</div>
                  <div
                    className={`mt-1 text-sm font-bold ${
                      cond.unusualVolume ? 'text-[#F59E0B]' : 'text-[#C9D1D9]'
                    }`}
                  >
                    {cond.volumeStrength} ({cond.relativeVolume.toFixed(2)}x)
                  </div>
                  <div className="mt-1 text-[10px] text-[#8B949E] truncate" title={cond.volumeNote}>
                    {cond.unusualVolume ? 'Unusual Volume Spike Detected' : cond.volumeNote}
                  </div>
                </div>
              </div>

              {/* Secondary Detail Panels: Structure, S/R, Liquidity, Breakout, Reversal */}
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {/* Market Structure & ADX/ATR */}
                <div className="border border-[#222938] bg-[#0B0E14] p-3 text-xs">
                  <div className="flex items-center justify-between font-semibold text-[#E6EDF3]">
                    <span className="flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5 text-[#38BDF8]" />
                      Market Structure
                    </span>
                    <span className={`font-mono ${directionColor(cond.marketStructure)}`}>
                      {cond.marketStructure} (HTF: {cond.htfStructure})
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-[#C9D1D9]">
                    Sequence: <span className="text-[#38BDF8]">{cond.structureSequence}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-[#8B949E] leading-relaxed">
                    {cond.structureDetail}
                  </p>
                  <div className="mt-2 border-t border-[#222938] pt-2 text-[11px] text-[#8B949E]">
                    <div>ADX: {cond.adxCondition}</div>
                    <div className="mt-0.5">ATR: {cond.atrCondition}</div>
                  </div>
                </div>

                {/* Support & Resistance Levels */}
                <div className="border border-[#222938] bg-[#0B0E14] p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-[#E6EDF3]">
                    <Target className="h-3.5 w-3.5 text-[#0ECB81]" />
                    Key Support &amp; Resistance
                  </div>
                  <div className="mt-2 space-y-1.5 font-mono text-[11px] tabular-nums">
                    <div>
                      <div className="text-[10px] uppercase text-[#F6465D]">Nearest Resistance</div>
                      {cond.resistanceLevels.length === 0 ? (
                        <div className="text-[#8B949E]">No overhead resistance zones</div>
                      ) : (
                        cond.resistanceLevels.map((lvl, i) => (
                          <div key={i} className="flex items-center justify-between text-[#C9D1D9]">
                            <span className="truncate pr-2">{lvl.label}</span>
                            <span>
                              {lvl.price.toFixed(meta.pricePrecision)}{' '}
                              <span className="text-[#8B949E]">(+{lvl.distancePercent.toFixed(2)}%)</span>
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="border-t border-[#222938] pt-1.5">
                      <div className="text-[10px] uppercase text-[#0ECB81]">Nearest Support</div>
                      {cond.supportLevels.length === 0 ? (
                        <div className="text-[#8B949E]">No active support zones below</div>
                      ) : (
                        cond.supportLevels.map((lvl, i) => (
                          <div key={i} className="flex items-center justify-between text-[#C9D1D9]">
                            <span className="truncate pr-2">{lvl.label}</span>
                            <span>
                              {lvl.price.toFixed(meta.pricePrecision)}{' '}
                              <span className="text-[#8B949E]">(-{lvl.distancePercent.toFixed(2)}%)</span>
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* Liquidity & Breakout State */}
                <div className="border border-[#222938] bg-[#0B0E14] p-3 text-xs">
                  <div className="flex items-center justify-between font-semibold text-[#E6EDF3]">
                    <span className="flex items-center gap-1.5">
                      <Flame className="h-3.5 w-3.5 text-[#F59E0B]" />
                      Liquidity &amp; Breakouts
                    </span>
                    <span className="border border-[#222938] bg-[#161B26] px-1.5 py-0.5 font-mono text-[10px] text-[#38BDF8]">
                      {cond.breakoutCondition.state}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#C9D1D9] leading-relaxed">
                    {cond.breakoutCondition.detail}
                  </p>
                  <div className="mt-2 border-t border-[#222938] pt-2 text-[11px] text-[#8B949E]">
                    <div className="text-[#C9D1D9]">{cond.liquidityCondition.summary}</div>
                    <div className="mt-1 font-mono text-[10px]">
                      BSL Pool:{' '}
                      {cond.liquidityCondition.nearestBuySide
                        ? `${cond.liquidityCondition.nearestBuySide.price.toFixed(meta.pricePrecision)} (+${cond.liquidityCondition.nearestBuySide.distancePercent}%)`
                        : '—'}{' '}
                      · SSL Pool:{' '}
                      {cond.liquidityCondition.nearestSellSide
                        ? `${cond.liquidityCondition.nearestSellSide.price.toFixed(meta.pricePrecision)} (-${cond.liquidityCondition.nearestSellSide.distancePercent}%)`
                        : '—'}
                    </div>
                  </div>
                </div>

                {/* Reversal Risk & Live Summary */}
                <div className="border border-[#222938] bg-[#0B0E14] p-3 text-xs">
                  <div className="flex items-center justify-between font-semibold text-[#E6EDF3]">
                    <span className="flex items-center gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 text-[#F59E0B]" />
                      Reversal Conditions
                    </span>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        cond.reversalCondition.riskLevel === 'High'
                          ? 'text-[#F6465D]'
                          : cond.reversalCondition.riskLevel === 'Elevated'
                            ? 'text-[#F59E0B]'
                            : 'text-[#0ECB81]'
                      }`}
                    >
                      {cond.reversalCondition.riskLevel.toUpperCase()} RISK
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#C9D1D9]">
                    {cond.reversalCondition.summary}
                  </p>
                  {cond.reversalCondition.signals.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-[11px] text-[#8B949E]">
                      {cond.reversalCondition.signals.map((sig, idx) => (
                        <li key={idx}>• {sig}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 border-t border-[#222938] pt-2 text-[11px] text-[#C9D1D9]">
                    {cond.conditionSummary}
                  </div>
                </div>
              </div>
            </div>

            {/* ROW 3: Best Strategy Right Now / Second-Best / Agreement Panel */}
            {!decision.hasReliableMatch ? (
              <div className="border border-[#F59E0B]/60 bg-[#12161F] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#F59E0B]">
                      <AlertTriangle className="h-5 w-5" />
                      <span>NO RELIABLE STRATEGY MATCH</span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-[#C9D1D9]">
                      {coverage.matchingSymbolRecords === 0
                        ? `No backtested or discovery records exist in the database for ${cond.symbol}. To keep recommendations strictly evidence-based with zero fabricated statistics, no strategy is endorsed yet.`
                        : `Tested strategies for ${cond.symbol} currently lack sufficient validated unseen (OOS) evidence or have negative expectancy under ${cond.regime} (${cond.discoveryRegimeMapping}) conditions. Wait for market regime clarity or run deeper discovery history.`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onOpenDiscovery}
                      className="border border-[#38BDF8] bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                    >
                      Run Strategy Discovery
                    </button>
                    <button
                      type="button"
                      onClick={onOpenBacktest}
                      className="border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                    >
                      Open Backtest Lab
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {/* Best Strategy Right Now */}
                {decision.bestStrategy && (
                  <div className="border border-[#0ECB81]/60 bg-[#12161F] p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#0ECB81]">
                        <ShieldCheck className="h-4 w-4" />
                        Best Strategy Right Now
                      </span>
                      <span
                        className={`border px-2 py-0.5 font-mono text-[10px] font-bold ${statusBadgeStyle(
                          decision.bestStrategy.status
                        )}`}
                      >
                        {decision.bestStrategy.status} · {decision.bestStrategy.matchingScore}% Fit
                      </span>
                    </div>
                    <div className="mt-2 text-base font-bold text-[#E6EDF3]">
                      {decision.bestStrategy.strategy.name}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[#8B949E]">
                      {decision.bestStrategy.strategy.category} · Best TF{' '}
                      <span className="text-[#38BDF8]">{decision.bestStrategy.bestTimeframe}</span> ·
                      Best Regime{' '}
                      <span className="text-[#C9D1D9]">{decision.bestStrategy.bestRegime}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[#222938] pt-2.5 font-mono text-xs tabular-nums">
                      <div>
                        <div className="text-[10px] text-[#8B949E]">Win Rate</div>
                        <div className="font-semibold text-[#E6EDF3]">
                          {decision.bestStrategy.winRate.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-[#8B949E]">PF</div>
                        <div className="font-semibold text-[#0ECB81]">
                          {decision.bestStrategy.profitFactor?.toFixed(2) ?? '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-[#8B949E]">Expectancy</div>
                        <div className="font-semibold text-[#0ECB81]">
                          {formatExpectancy(decision.bestStrategy.expectancyR)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-[#8B949E]">OOS Trades</div>
                        <div className="font-semibold text-[#C9D1D9]">
                          {decision.bestStrategy.unseenTestTrades}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Second-Best Alternative */}
                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#38BDF8]">
                      <Zap className="h-4 w-4" />
                      Second-Best Alternative
                    </span>
                    {decision.secondBestStrategy && (
                      <span
                        className={`border px-2 py-0.5 font-mono text-[10px] font-bold ${statusBadgeStyle(
                          decision.secondBestStrategy.status
                        )}`}
                      >
                        {decision.secondBestStrategy.status} ·{' '}
                        {decision.secondBestStrategy.matchingScore}% Fit
                      </span>
                    )}
                  </div>
                  {decision.secondBestStrategy ? (
                    <>
                      <div className="mt-2 text-base font-bold text-[#E6EDF3]">
                        {decision.secondBestStrategy.strategy.name}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#8B949E]">
                        {decision.secondBestStrategy.strategy.category} · Best TF{' '}
                        <span className="text-[#38BDF8]">
                          {decision.secondBestStrategy.bestTimeframe}
                        </span>{' '}
                        · Best Regime{' '}
                        <span className="text-[#C9D1D9]">
                          {decision.secondBestStrategy.bestRegime}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[#222938] pt-2.5 font-mono text-xs tabular-nums">
                        <div>
                          <div className="text-[10px] text-[#8B949E]">Win Rate</div>
                          <div className="font-semibold text-[#E6EDF3]">
                            {decision.secondBestStrategy.winRate.toFixed(1)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#8B949E]">PF</div>
                          <div className="font-semibold text-[#38BDF8]">
                            {decision.secondBestStrategy.profitFactor?.toFixed(2) ?? '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#8B949E]">Expectancy</div>
                          <div className="font-semibold text-[#38BDF8]">
                            {formatExpectancy(decision.secondBestStrategy.expectancyR)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#8B949E]">OOS Trades</div>
                          <div className="font-semibold text-[#C9D1D9]">
                            {decision.secondBestStrategy.unseenTestTrades}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="mt-3 text-xs text-[#8B949E]">
                      Only one qualifying strategy found for {cond.symbol} in current database runs.
                    </div>
                  )}
                </div>

                {/* Multi-Strategy Agreement & Discipline Disclaimer */}
                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#C9D1D9]">
                      Strategy Confluence &amp; Discipline
                    </span>
                    <span
                      className={`border px-2 py-0.5 font-mono text-[10px] font-bold ${
                        decision.strategiesAgree
                          ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                          : 'border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B]'
                      }`}
                    >
                      {decision.strategiesAgree ? 'STRATEGIES AGREE' : 'MIXED / SINGLE'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[#C9D1D9] leading-relaxed">
                    {decision.agreementSummary}
                  </p>
                  <div className="mt-3 border-t border-[#222938] pt-2 text-[11px] text-[#8B949E]">
                    <span className="font-semibold text-[#F59E0B]">Score Notice:</span> Matching Score (0–100%) measures how closely live market structure/regime matches historical unseen OOS validation — it is <strong className="text-[#C9D1D9]">not</strong> a win probability.
                  </div>
                </div>
              </div>
            )}

            {/* ROW 4: Top 50 Condition-Filtered Strategy Recommendations */}
            {(topStrategies.length > 0 || decision.allEvaluatedCount > 0) && (
              <div className="border border-[#222938] bg-[#12161F] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] pb-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xs font-bold uppercase tracking-wider text-[#E6EDF3]">
                        Top 50 Strategy Recommendations ({filteredTopStrategies.length} shown ·{' '}
                        {decision.allEvaluatedCount} tested on {cond.symbol})
                      </h2>
                      <span className="border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-2 py-0.5 font-mono text-[10px] text-[#38BDF8]">
                        Vol: {cond.volatility} · Trend: {cond.direction} · Regime: {cond.regime}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      Filters existing SQLite backtest/discovery entries against live Volatility, Trend &amp; Regime and ranks by unseen OOS validation + matching score.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center border border-[#222938] bg-[#0B0E14] p-0.5 font-mono text-[11px]">
                      <button
                        type="button"
                        onClick={() => setConditionFilterMode('all')}
                        className={`px-2.5 py-1 cursor-pointer ${
                          conditionFilterMode === 'all'
                            ? 'bg-[#1C2331] text-[#38BDF8] font-semibold'
                            : 'text-[#8B949E] hover:text-white'
                        }`}
                      >
                        Top 50 All ({decision.filterCounts.totalEvaluated})
                      </button>
                      <button
                        type="button"
                        onClick={() => setConditionFilterMode('matched_conditions')}
                        className={`px-2.5 py-1 cursor-pointer ${
                          conditionFilterMode === 'matched_conditions'
                            ? 'bg-[#1C2331] text-[#0ECB81] font-semibold'
                            : 'text-[#8B949E] hover:text-white'
                        }`}
                      >
                        Live Condition Match
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={onOpenSimulator}
                      className="border border-[#0ECB81]/40 bg-[#0ECB81]/10 px-2.5 py-1 text-xs text-[#0ECB81] hover:bg-[#0ECB81]/20 cursor-pointer"
                    >
                      Simulate Sizing
                    </button>
                  </div>
                </div>

                {/* Live Condition Filter Bar (Volatility, Trend, Regime, Status, Category, Search) */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-[#222938] bg-[#0B0E14] p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-[#8B949E]">
                      <Filter className="h-3.5 w-3.5 text-[#38BDF8]" />
                      Live Filters:
                    </span>
                    <button
                      type="button"
                      onClick={() => setRequireRegimeMatch((v) => !v)}
                      className={`border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        requireRegimeMatch
                          ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                          : 'border-[#222938] bg-[#12161F] text-[#C9D1D9] hover:border-[#38BDF8]'
                      }`}
                    >
                      Regime Match ({decision.filterCounts.regimeMatchedCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRequireTrendMatch((v) => !v)}
                      className={`border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        requireTrendMatch
                          ? 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81]'
                          : 'border-[#222938] bg-[#12161F] text-[#C9D1D9] hover:border-[#0ECB81]'
                      }`}
                    >
                      Trend Match ({decision.filterCounts.trendMatchedCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRequireVolMatch((v) => !v)}
                      className={`border px-2 py-1 font-mono text-[11px] cursor-pointer ${
                        requireVolMatch
                          ? 'border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B]'
                          : 'border-[#222938] bg-[#12161F] text-[#C9D1D9] hover:border-[#F59E0B]'
                      }`}
                    >
                      Volatility Match ({decision.filterCounts.volatilityMatchedCount})
                    </button>

                    <select
                      aria-label="Filter by Status"
                      value={statusFilter}
                      onChange={(e) =>
                        setStatusFilter(e.target.value as 'ALL' | StrategyRecommendationStatus)
                      }
                      className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#E6EDF3] outline-none cursor-pointer"
                    >
                      <option value="ALL">All Statuses</option>
                      <option value="BEST MATCH">
                        BEST MATCH ({decision.filterCounts.bestMatchCount})
                      </option>
                      <option value="GOOD MATCH">
                        GOOD MATCH ({decision.filterCounts.goodMatchCount})
                      </option>
                      <option value="MODERATE MATCH">
                        MODERATE MATCH ({decision.filterCounts.moderateMatchCount})
                      </option>
                      <option value="INSUFFICIENT DATA">INSUFFICIENT DATA</option>
                      <option value="POOR MATCH">POOR MATCH</option>
                    </select>

                    <select
                      aria-label="Filter by Category"
                      value={categoryFilter}
                      onChange={(e) =>
                        setCategoryFilter(e.target.value as 'ALL' | BacktestStrategyCategory)
                      }
                      className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#E6EDF3] outline-none cursor-pointer"
                    >
                      <option value="ALL">All Categories</option>
                      <option value="SMC">SMC</option>
                      <option value="Price Action">Price Action</option>
                      <option value="Chart Patterns">Chart Patterns</option>
                      <option value="Support & Resistance">Support &amp; Resistance</option>
                      <option value="Hybrid SMC/PA">Hybrid SMC/PA</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={
                        armingId === 'filtered_batch' ||
                        filteredTopStrategies.filter((s) => s.status !== 'POOR MATCH').length === 0
                      }
                      onClick={() => void handleArmFilteredTop('merge')}
                      className="border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2.5 py-1 text-[11px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-40 cursor-pointer"
                    >
                      {armingId === 'filtered_batch'
                        ? 'Adding...'
                        : `+ Add Filtered to Main Signals (${Math.min(
                            10,
                            filteredTopStrategies.filter((s) => s.status !== 'POOR MATCH').length
                          )})`}
                    </button>

                    <div className="flex items-center gap-1.5 border border-[#222938] bg-[#12161F] px-2 py-1">
                      <Search className="h-3.5 w-3.5 text-[#8B949E]" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search Top 50..."
                        className="w-36 bg-transparent text-[11px] text-[#E6EDF3] placeholder-[#8B949E] outline-none"
                      />
                    </div>

                    <div className="flex items-center border border-[#222938] bg-[#12161F] font-mono text-[11px]">
                      {[12, 25, 50].map((cap) => (
                        <button
                          key={cap}
                          type="button"
                          onClick={() => setVisibleCardCap(cap)}
                          className={`px-2 py-1 cursor-pointer ${
                            visibleCardCap === cap
                              ? 'bg-[#1C2331] text-[#38BDF8] font-semibold'
                              : 'text-[#8B949E] hover:text-white'
                          }`}
                        >
                          {cap === 50 ? 'All 50' : `Show ${cap}`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {filteredTopStrategies.length === 0 ? (
                  <div className="border border-[#222938] bg-[#0B0E14] p-6 text-center text-xs text-[#8B949E]">
                    No strategies in the Top 50 match your active filter toggles. Clear a filter above to inspect all ranked candidates.
                  </div>
                ) : (
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {filteredTopStrategies.slice(0, visibleCardCap).map((item) => {
                    const isArmed = isSlotStrategyArmed(
                      selectedSymbol,
                      item.matchedTimeframe,
                      item.strategy.id
                    );

                    return (
                      <div
                        key={`${item.strategy.id}:${item.sourceRunId}`}
                        onClick={() => setSelectedChartRank(item.rank)}
                        className={`border p-3.5 transition-colors cursor-pointer ${
                          selectedChartRank === item.rank
                            ? 'border-[#38BDF8] bg-[#161B26]'
                            : 'border-[#222938] bg-[#0B0E14] hover:border-[#30363D]'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-bold text-[#38BDF8]">
                                #{item.rank}
                              </span>
                              <span className="text-sm font-bold text-[#E6EDF3]">
                                {item.strategy.name}
                              </span>
                              <span
                                className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold ${statusBadgeStyle(
                                  item.status
                                )}`}
                              >
                                {item.status}
                              </span>
                              {item.productionReadiness && (
                                <span
                                  className={`border px-1.5 py-0.5 font-mono text-[10px] ${readinessBadge(
                                    item.productionReadiness
                                  )}`}
                                >
                                  {item.productionReadiness}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#8B949E]">
                              <span>{item.strategy.category}</span>
                              <span>·</span>
                              <span>
                                Best TF: <strong className="text-[#C9D1D9]">{item.bestTimeframe}</strong>
                              </span>
                              <span>·</span>
                              <span
                                className={`font-mono text-[10px] ${
                                  item.conditionMatches.regimeMatch ? 'text-[#38BDF8]' : 'text-[#8B949E]'
                                }`}
                              >
                                Regime {item.conditionMatches.regimeMatch ? '✓' : '×'}
                              </span>
                              <span
                                className={`font-mono text-[10px] ${
                                  item.conditionMatches.trendMatch ? 'text-[#0ECB81]' : 'text-[#8B949E]'
                                }`}
                              >
                                Trend {item.conditionMatches.trendMatch ? '✓' : '×'}
                              </span>
                              <span
                                className={`font-mono text-[10px] ${
                                  item.conditionMatches.volatilityMatch
                                    ? 'text-[#F59E0B]'
                                    : 'text-[#8B949E]'
                                }`}
                              >
                                Vol {item.conditionMatches.volatilityMatch ? '✓' : '×'}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <div className="text-right font-mono">
                              <div className="text-[10px] uppercase text-[#8B949E]">
                                Condition Fit
                              </div>
                              <div className="text-base font-bold text-[#38BDF8]">
                                {item.matchingScore}%
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={armingId === item.strategy.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleArmStrategy(item);
                              }}
                              className={`border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                                isArmed
                                  ? 'border-[#0ECB81] bg-[#0ECB81]/20 text-[#0ECB81] hover:border-[#F6465D] hover:text-[#F6465D]'
                                  : 'border-[#222938] bg-[#12161F] text-[#38BDF8] hover:border-[#0ECB81] hover:text-[#0ECB81]'
                              }`}
                            >
                              {armingId === item.strategy.id
                                ? 'Saving...'
                                : isArmed
                                  ? 'Added ✓ (Remove)'
                                  : '+ Add to Signals'}
                            </button>
                          </div>
                        </div>

                        {/* Metrics Strip */}
                        <div className="mt-3 grid grid-cols-4 gap-2 border-y border-[#222938] py-2 font-mono text-xs tabular-nums sm:grid-cols-7">
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Win Rate</div>
                            <div className="font-semibold text-[#E6EDF3]">
                              {item.winRate.toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Profit Factor</div>
                            <div
                              className={`font-semibold ${
                                (item.profitFactor ?? 0) >= 1.25
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {item.profitFactor?.toFixed(2) ?? '—'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Avg R</div>
                            <div className="font-semibold text-[#C9D1D9]">
                              {formatExpectancy(item.avgRMultiple)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Expectancy</div>
                            <div
                              className={`font-semibold ${
                                item.expectancyR > 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                              }`}
                            >
                              {formatExpectancy(item.expectancyR)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Max DD</div>
                            <div className="font-semibold text-[#F59E0B]">
                              {item.maxDrawdownPercent.toFixed(1)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">OOS Ret</div>
                            <div
                              className={`font-semibold ${
                                item.recentOosPerformance.netReturnPercent >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {formatReturn(item.recentOosPerformance.netReturnPercent)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#8B949E]">Tested (OOS)</div>
                            <div className="font-semibold text-[#C9D1D9]">
                              {item.tradesTested} ({item.unseenTestTrades})
                            </div>
                          </div>
                        </div>

                        {/* Why it matches + Cautions */}
                        <div className="mt-2.5 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
                          <div>
                            <div className="font-semibold text-[#0ECB81]">
                              Why it matches live conditions:
                            </div>
                            <ul className="mt-1 space-y-0.5 text-[#C9D1D9]">
                              {item.matchReasons.map((r, i) => (
                                <li key={i}>• {r}</li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="font-semibold text-[#F59E0B]">
                              Validation &amp; Risk Notes:
                            </div>
                            <ul className="mt-1 space-y-0.5 text-[#8B949E]">
                              {item.cautionNotes.length > 0 ? (
                                item.cautionNotes.map((c, i) => <li key={i}>• {c}</li>)
                              ) : (
                                <li>
                                  • Holdout:{' '}
                                  {formatReturn(item.recentOosPerformance.holdoutReturnPercent)} ·
                                  WF Consistency:{' '}
                                  {item.recentOosPerformance.wfConsistencyPercent !== null
                                    ? `${item.recentOosPerformance.wfConsistencyPercent.toFixed(0)}%`
                                    : 'N/A'}
                                </li>
                              )}
                            </ul>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
                {filteredTopStrategies.length > visibleCardCap && (
                  <div className="mt-3 flex items-center justify-center">
                    <button
                      type="button"
                      onClick={() => setVisibleCardCap(50)}
                      className="border border-[#222938] bg-[#0B0E14] px-4 py-1.5 text-xs text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                    >
                      Expand All {filteredTopStrategies.length} Strategy Cards
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ROW 5: Strategy Comparison Table + Historical Performance Charts */}
            {topStrategies.length > 0 && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* Historical Performance Charts */}
                <div className="border border-[#222938] bg-[#12161F] p-4 xl:col-span-5">
                  <div className="mb-3 flex items-center justify-between gap-2 border-b border-[#222938] pb-2">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-[#38BDF8]" />
                      <h3 className="text-xs font-bold uppercase tracking-wider text-[#E6EDF3]">
                        Historical Validation Stages
                      </h3>
                    </div>
                    {activeChartItem && (
                      <span className="font-mono text-[11px] text-[#38BDF8]">
                        #{activeChartItem.rank} {activeChartItem.strategy.name}
                      </span>
                    )}
                  </div>

                  {/* Stage Performance Chart */}
                  <div className="h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stageChartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid stroke="#222938" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="stage"
                          tick={{ fill: '#8B949E', fontSize: 10 }}
                          axisLine={{ stroke: '#222938' }}
                        />
                        <YAxis
                          tick={{ fill: '#8B949E', fontSize: 10 }}
                          axisLine={{ stroke: '#222938' }}
                          tickFormatter={(v) => `${v}%`}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#0B0E14',
                            borderColor: '#30363D',
                            fontSize: 11,
                          }}
                          formatter={(val: unknown, name: unknown) => [
                            name === 'returnPercent'
                              ? `${Number(val).toFixed(1)}%`
                              : `${Number(val).toFixed(2)}R`,
                            name === 'returnPercent' ? 'Net Return %' : 'Expectancy',
                          ]}
                        />
                        <ReferenceLine y={0} stroke="#30363D" />
                        <Bar dataKey="returnPercent" name="returnPercent" radius={[2, 2, 0, 0]}>
                          {stageChartData.map((entry, idx) => (
                            <Cell
                              key={idx}
                              fill={entry.returnPercent >= 0 ? '#0ECB81' : '#F6465D'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Top 10 Matching Score Comparison */}
                  <div className="mt-4 border-t border-[#222938] pt-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#8B949E]">
                      Top 10 Matching Score vs. Unseen OOS Return %
                    </div>
                    <div className="h-44 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={comparisonChartData}
                          margin={{ top: 6, right: 12, left: -12, bottom: 0 }}
                        >
                          <CartesianGrid stroke="#222938" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="name"
                            tick={{ fill: '#8B949E', fontSize: 9 }}
                            axisLine={{ stroke: '#222938' }}
                          />
                          <YAxis
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            axisLine={{ stroke: '#222938' }}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0B0E14',
                              borderColor: '#30363D',
                              fontSize: 11,
                            }}
                          />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Bar dataKey="matchingScore" name="Match Score" fill="#38BDF8" />
                          <Bar dataKey="oosReturn" name="OOS Return %" fill="#0ECB81" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Top 50 Strategy Comparison Matrix */}
                <div className="border border-[#222938] bg-[#12161F] p-4 xl:col-span-7">
                  <div className="mb-3 flex items-center justify-between border-b border-[#222938] pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#E6EDF3]">
                      Top {filteredTopStrategies.length} Historical Backtest Comparison Matrix
                    </h3>
                    <span className="font-mono text-[10px] text-[#8B949E]">
                      Click any row to inspect historical stage chart
                    </span>
                  </div>

                  <div className="max-h-[540px] overflow-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 z-10 bg-[#12161F]">
                        <tr className="border-b border-[#222938] text-[10px] uppercase text-[#8B949E]">
                          <th className="py-2 pr-2">#</th>
                          <th className="py-2 pr-3">Strategy</th>
                          <th className="py-2 pr-2">Status</th>
                          <th className="py-2 pr-2 text-center">V / T / R</th>
                          <th className="py-2 pr-2 text-right">Fit %</th>
                          <th className="py-2 pr-2">Best TF</th>
                          <th className="py-2 pr-2 text-right">Win %</th>
                          <th className="py-2 pr-2 text-right">PF</th>
                          <th className="py-2 pr-2 text-right">Exp (R)</th>
                          <th className="py-2 pr-2 text-right">OOS %</th>
                          <th className="py-2 pr-2 text-right">Holdout %</th>
                          <th className="py-2 pr-2 text-right">Max DD</th>
                          <th className="py-2 text-right">OOS Trades</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#222938]/70 font-mono text-[11px] tabular-nums">
                        {filteredTopStrategies.map((item) => (
                          <tr
                            key={`row-${item.strategy.id}`}
                            onClick={() => setSelectedChartRank(item.rank)}
                            className={`cursor-pointer transition-colors ${
                              selectedChartRank === item.rank
                                ? 'bg-[#1C2331]'
                                : 'hover:bg-[#161B26]'
                            }`}
                          >
                            <td className="py-2.5 pr-2 font-bold text-[#38BDF8]">{item.rank}</td>
                            <td className="py-2.5 pr-3 font-sans">
                              <div className="font-semibold text-[#E6EDF3]">
                                {item.strategy.name}
                              </div>
                              <div className="text-[10px] text-[#8B949E]">
                                {item.validationStatus} · {item.bestRegime}
                              </div>
                            </td>
                            <td className="py-2.5 pr-2">
                              <span
                                className={`inline-block border px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap ${statusBadgeStyle(
                                  item.status
                                )}`}
                              >
                                {item.status}
                              </span>
                            </td>
                            <td className="py-2.5 pr-2 text-center whitespace-nowrap">
                              <span
                                title="Volatility Match"
                                className={
                                  item.conditionMatches.volatilityMatch
                                    ? 'text-[#F59E0B]'
                                    : 'text-[#30363D]'
                                }
                              >
                                V
                              </span>
                              <span className="text-[#30363D]">/</span>
                              <span
                                title="Trend Match"
                                className={
                                  item.conditionMatches.trendMatch
                                    ? 'text-[#0ECB81]'
                                    : 'text-[#30363D]'
                                }
                              >
                                T
                              </span>
                              <span className="text-[#30363D]">/</span>
                              <span
                                title="Regime Match"
                                className={
                                  item.conditionMatches.regimeMatch
                                    ? 'text-[#38BDF8]'
                                    : 'text-[#30363D]'
                                }
                              >
                                R
                              </span>
                            </td>
                            <td className="py-2.5 pr-2 text-right font-bold text-[#38BDF8]">
                              {item.matchingScore}%
                            </td>
                            <td className="py-2.5 pr-2 text-[#C9D1D9]">{item.bestTimeframe}</td>
                            <td className="py-2.5 pr-2 text-right text-[#E6EDF3]">
                              {item.winRate.toFixed(1)}%
                            </td>
                            <td
                              className={`py-2.5 pr-2 text-right ${
                                (item.profitFactor ?? 0) >= 1.25
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {item.profitFactor?.toFixed(2) ?? '—'}
                            </td>
                            <td
                              className={`py-2.5 pr-2 text-right ${
                                item.expectancyR > 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                              }`}
                            >
                              {formatExpectancy(item.expectancyR)}
                            </td>
                            <td
                              className={`py-2.5 pr-2 text-right ${
                                item.recentOosPerformance.netReturnPercent >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {formatReturn(item.recentOosPerformance.netReturnPercent)}
                            </td>
                            <td
                              className={`py-2.5 pr-2 text-right ${
                                (item.recentOosPerformance.holdoutReturnPercent ?? 0) >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }`}
                            >
                              {formatReturn(item.recentOosPerformance.holdoutReturnPercent)}
                            </td>
                            <td className="py-2.5 pr-2 text-right text-[#F59E0B]">
                              {item.maxDrawdownPercent.toFixed(1)}%
                            </td>
                            <td className="py-2.5 text-right text-[#C9D1D9]">
                              {item.unseenTestTrades} / {item.tradesTested}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
