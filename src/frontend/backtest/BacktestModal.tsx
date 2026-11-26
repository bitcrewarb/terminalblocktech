import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Database,
  Download,
  FlaskConical,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { getInstrumentMeta, INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  BacktestConfig,
  BacktestRunResult,
  BacktestRunSummary,
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  BacktestTradeRecord,
  InstrumentSymbol,
  Timeframe,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import { EquityCurveChart } from './EquityCurveChart.tsx';
import { PerformanceDashboard } from './PerformanceDashboard.tsx';

type BacktestTab = 'lab' | 'archive';
type TradeFilter = 'ALL' | 'BUY' | 'SELL' | 'WINS' | 'LOSSES';
type CategoryFilter = 'ALL' | BacktestStrategyCategory;

const STRATEGY_CATEGORIES: CategoryFilter[] = [
  'ALL',
  'SMC',
  'Price Action',
  'Chart Patterns',
  'Support & Resistance',
  'Hybrid SMC/PA',
];

const EXEC_TIMEFRAMES: Timeframe[] = ['5m', '15m', '30m', '1H', '4H'];
const HTF_TIMEFRAMES: Timeframe[] = ['1H', '4H', '1D', '1W'];
const BAR_PRESETS = [300, 500, 1000, 2500, 5000, 10000] as const;

function defaultHtfFor(tf: Timeframe): Timeframe {
  if (tf === '5m' || tf === '15m' || tf === '30m' || tf === '1H') return '4H';
  if (tf === '4H') return '1D';
  return '1W';
}

export function BacktestModal({ onClose }: { onClose: () => void }) {
  const { symbol, timezone, selectSymbol, selectTimeframe, focusChartObject } = useTerminal();

  const [tab, setTab] = useState<BacktestTab>('lab');
  const [strategyDefs, setStrategyDefs] = useState<BacktestStrategyDefinition[]>([]);
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<BacktestStrategyId[]>([]);
  const [showStrategyPicker, setShowStrategyPicker] = useState(false);

  const [btSymbol, setBtSymbol] = useState<InstrumentSymbol>(symbol);
  const [btTimeframe, setBtTimeframe] = useState<Timeframe>('15m');
  const [btHtf, setBtHtf] = useState<Timeframe>('4H');
  const [btBars, setBtBars] = useState<number>(500);
  const [initialCapital, setInitialCapital] = useState<number>(10000);
  const [riskPercent, setRiskPercent] = useState<number>(1.0);
  const [minRR, setMinRR] = useState<number>(1.5);
  const [commissionBps, setCommissionBps] = useState<number>(4);
  const [slippageBps, setSlippageBps] = useState<number>(2);
  const [breakevenAfterTp1, setBreakevenAfterTp1] = useState<boolean>(true);

  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<BacktestRunResult | null>(null);
  const [inspectedStrategyId, setInspectedStrategyId] = useState<BacktestStrategyId | null>(null);

  const [tradeFilter, setTradeFilter] = useState<TradeFilter>('ALL');
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);

  const [pickerCategory, setPickerCategory] = useState<CategoryFilter>('ALL');
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [pickerShowAll, setPickerShowAll] = useState<boolean>(false);
  const [leaderboardCategory, setLeaderboardCategory] = useState<CategoryFilter>('ALL');
  const [leaderboardQuery, setLeaderboardQuery] = useState<string>('');
  const [activeOnlyLeaderboard, setActiveOnlyLeaderboard] = useState<boolean>(false);
  const [leaderboardLimit, setLeaderboardLimit] = useState<number>(150);

  const [savedRuns, setSavedRuns] = useState<BacktestRunSummary[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(false);
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);

  const fetchStrategiesAndArchive = useCallback(async () => {
    setLoadingArchive(true);
    try {
      const [stratRes, runsRes] = await Promise.all([
        apiFetch('/api/backtest/strategies'),
        apiFetch('/api/backtest/runs'),
      ]);
      if (stratRes.ok) {
        const d = (await stratRes.json()) as { strategies: BacktestStrategyDefinition[] };
        setStrategyDefs(d.strategies);
        setSelectedStrategyIds((prev) =>
          prev.length > 0 ? prev : d.strategies.map((s) => s.id)
        );
      }
      if (runsRes.ok) {
        const r = (await runsRes.json()) as { runs: BacktestRunSummary[] };
        setSavedRuns(r.runs);
      }
    } finally {
      setLoadingArchive(false);
    }
  }, []);

  useEffect(() => {
    void fetchStrategiesAndArchive();
  }, [fetchStrategiesAndArchive]);

  const handleStartBacktest = async () => {
    setRunning(true);
    setErrorMsg(null);
    try {
      const allSelected =
        strategyDefs.length > 0 && selectedStrategyIds.length >= strategyDefs.length;
      const payload: Partial<BacktestConfig> = {
        symbol: btSymbol,
        timeframe: btTimeframe,
        htfTimeframe: btHtf,
        bars: btBars,
        initialCapital,
        riskPerTradePercent: riskPercent,
        minRiskReward: minRR,
        commissionBps,
        slippageBps,
        moveStopToBreakevenAfterTp1: breakevenAfterTp1,
        strategyIds:
          selectedStrategyIds.length > 0 && !allSelected
            ? selectedStrategyIds
            : undefined,
      };
      const res = await apiFetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Backtest request failed (${res.status})`);
      }
      const run = (await res.json()) as BacktestRunResult;
      setCurrentRun(run);
      setInspectedStrategyId(run.bestStrategyId ?? run.strategies[0]?.strategy.id ?? null);
      setExpandedTradeId(null);
      setTradeFilter('ALL');
      setLeaderboardLimit(150);
      setTab('lab');

      // Refresh SQLite archive list
      const runsRes = await apiFetch('/api/backtest/runs');
      if (runsRes.ok) {
        const r = (await runsRes.json()) as { runs: BacktestRunSummary[] };
        setSavedRuns(r.runs);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Backtest failed');
    } finally {
      setRunning(false);
    }
  };

  const handleLoadSavedRun = async (id: string) => {
    setLoadingArchive(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch(`/api/backtest/runs/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Unable to load saved backtest run');
      const run = (await res.json()) as BacktestRunResult;
      setCurrentRun(run);
      setInspectedStrategyId(run.bestStrategyId ?? run.strategies[0]?.strategy.id ?? null);
      setBtSymbol(run.config.symbol);
      setBtTimeframe(run.config.timeframe);
      setBtHtf(run.config.htfTimeframe);
      setExpandedTradeId(null);
      setTab('lab');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load run');
    } finally {
      setLoadingArchive(false);
    }
  };

  const handleDeleteSavedRun = async (id: string) => {
    const res = await apiFetch(`/api/backtest/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const d = (await res.json()) as { runs: BacktestRunSummary[] };
      setSavedRuns(d.runs);
      if (confirmDeleteRunId === id) setConfirmDeleteRunId(null);
      if (currentRun?.id === id) setCurrentRun(null);
    }
  };

  const toggleStrategyId = (id: BacktestStrategyId) => {
    setSelectedStrategyIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // keep at least 1 active
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  const pickerCategoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      ALL: strategyDefs.length,
      SMC: 0,
      'Price Action': 0,
      'Chart Patterns': 0,
      'Support & Resistance': 0,
      'Hybrid SMC/PA': 0,
    };
    for (const def of strategyDefs) {
      counts[def.category] = (counts[def.category] ?? 0) + 1;
    }
    return counts;
  }, [strategyDefs]);

  const filteredPickerDefs = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return strategyDefs.filter((def) => {
      if (pickerCategory !== 'ALL' && def.category !== pickerCategory) return false;
      if (
        q &&
        !def.name.toLowerCase().includes(q) &&
        !def.id.toLowerCase().includes(q) &&
        !def.summary.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [strategyDefs, pickerCategory, pickerQuery]);

  const selectAllStrategies = () => {
    setSelectedStrategyIds(strategyDefs.map((d) => d.id));
  };

  const selectOnlyPickerCategory = () => {
    const matching = (
      pickerCategory === 'ALL'
        ? strategyDefs
        : strategyDefs.filter((d) => d.category === pickerCategory)
    ).map((d) => d.id);
    if (matching.length > 0) {
      setSelectedStrategyIds(matching);
    }
  };

  const toggleVisiblePickerStrategies = () => {
    if (filteredPickerDefs.length === 0) return;
    const visibleIds = filteredPickerDefs.map((d) => d.id);
    const visibleSet = new Set(visibleIds);
    const allVisibleSelected = visibleIds.every((id) => selectedStrategyIds.includes(id));

    if (allVisibleSelected) {
      const remaining = selectedStrategyIds.filter((id) => !visibleSet.has(id));
      setSelectedStrategyIds(remaining.length > 0 ? remaining : [visibleIds[0]]);
    } else {
      const merged = new Set([...selectedStrategyIds, ...visibleIds]);
      setSelectedStrategyIds(Array.from(merged));
    }
  };

  const selectedResult = useMemo(() => {
    if (!currentRun) return null;
    return (
      currentRun.strategies.find((s) => s.strategy.id === inspectedStrategyId) ??
      currentRun.strategies[0] ??
      null
    );
  }, [currentRun, inspectedStrategyId]);

  const leaderboardCategoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      ALL: currentRun?.strategies.length ?? 0,
      SMC: 0,
      'Price Action': 0,
      'Chart Patterns': 0,
      'Support & Resistance': 0,
      'Hybrid SMC/PA': 0,
    };
    if (!currentRun) return counts;
    for (const res of currentRun.strategies) {
      if (activeOnlyLeaderboard && res.metrics.totalTrades === 0) continue;
      counts[res.strategy.category] = (counts[res.strategy.category] ?? 0) + 1;
    }
    if (activeOnlyLeaderboard) {
      counts.ALL = currentRun.strategies.filter((r) => r.metrics.totalTrades > 0).length;
    }
    return counts;
  }, [currentRun, activeOnlyLeaderboard]);

  const filteredLeaderboard = useMemo(() => {
    if (!currentRun) return [];
    const q = leaderboardQuery.trim().toLowerCase();
    return currentRun.strategies.filter((res) => {
      if (activeOnlyLeaderboard && res.metrics.totalTrades === 0) return false;
      if (leaderboardCategory !== 'ALL' && res.strategy.category !== leaderboardCategory) {
        return false;
      }
      if (
        q &&
        !res.strategy.name.toLowerCase().includes(q) &&
        !res.strategy.id.toLowerCase().includes(q) &&
        !res.strategy.category.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [currentRun, leaderboardCategory, leaderboardQuery, activeOnlyLeaderboard]);

  const filteredTrades = useMemo(() => {
    if (!selectedResult) return [];
    return selectedResult.trades.filter((t) => {
      if (tradeFilter === 'BUY' && t.direction !== 'BUY') return false;
      if (tradeFilter === 'SELL' && t.direction !== 'SELL') return false;
      if (tradeFilter === 'WINS' && t.netPnl <= 0.01) return false;
      if (tradeFilter === 'LOSSES' && t.netPnl >= -0.01) return false;
      return true;
    });
  }, [selectedResult, tradeFilter]);

  const precision = getInstrumentMeta(currentRun?.config.symbol ?? btSymbol).pricePrecision;

  const fmtTimeSec = (sec: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(sec * 1000));

  const fmtTimeMs = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));

  const handleFocusTradeOnChart = (trade: BacktestTradeRecord) => {
    if (!currentRun) return;
    if (currentRun.config.symbol !== symbol) {
      selectSymbol(currentRun.config.symbol);
    }
    selectTimeframe(currentRun.config.timeframe);
    focusChartObject(trade.id, trade.signalTime - 3600, trade.exitTime + 3600);
    onClose();
  };

  const exportCsv = () => {
    if (!currentRun || !selectedResult) return;
    const headers = [
      'Trade #',
      'Strategy',
      'Direction',
      'Entry Mode',
      'Signal Time (ISO)',
      'Entry Time (ISO)',
      'Exit Time (ISO)',
      'Bars Held',
      'Entry Price',
      'Initial SL',
      'Exit Price',
      'Exit Reason',
      'Units',
      'Risk $',
      'Gross PnL $',
      'Fees & Slippage $',
      'Net PnL $',
      'Realized R',
      'MFE R',
      'MAE R',
      'Equity After $',
      'Score',
      'Entry Rationale',
      'Exit Note',
    ];
    const rows = selectedResult.trades.map((t) => [
      t.tradeNumber,
      `"${selectedResult.strategy.name}"`,
      t.direction,
      t.entryMode,
      new Date(t.signalTime * 1000).toISOString(),
      new Date(t.entryTime * 1000).toISOString(),
      new Date(t.exitTime * 1000).toISOString(),
      t.barsHeld,
      t.entryPrice,
      t.initialStopLoss,
      t.exitPrice,
      t.exitReason,
      t.units,
      t.riskAmount,
      t.grossPnl,
      t.feesAndSlippage,
      t.netPnl,
      t.realizedR,
      t.mfeR,
      t.maeR,
      t.equityAfter,
      t.confluenceScore,
      `"${t.entryRationale.join(' | ').replace(/"/g, '""')}"`,
      `"${t.exitNote.replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentRun.config.symbol}_${currentRun.config.timeframe}_${selectedResult.strategy.id}_trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    if (!currentRun) return;
    const blob = new Blob([JSON.stringify(currentRun, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentRun.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4">
      <div className="flex h-[92vh] w-full max-w-[1440px] flex-col border border-[#222938] bg-[#12161F] text-[#E6EDF3] shadow-2xl">
        {/* Top Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] px-4 py-3">
          <div className="flex items-center gap-3">
            <FlaskConical className="h-4 w-4 text-[#38BDF8]" />
            <div>
              <h2 className="text-sm font-semibold text-[#E6EDF3]">
                SMC & Price Action Strategy Backtest Lab
              </h2>
              <p className="text-[11px] text-[#8B949E]">
                Causal zero-lookahead multi-strategy engine on live historical market data
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex border border-[#222938] bg-[#0B0E14] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTab('lab')}
                className={`px-3 py-1 cursor-pointer ${
                  tab === 'lab'
                    ? 'bg-[#1C2331] text-[#38BDF8] font-medium'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                Backtest & Leaderboard
              </button>
              <button
                type="button"
                onClick={() => setTab('archive')}
                className={`flex items-center gap-1.5 px-3 py-1 cursor-pointer ${
                  tab === 'archive'
                    ? 'bg-[#1C2331] text-[#38BDF8] font-medium'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                <Database className="h-3 w-3" />
                <span>Saved Runs ({savedRuns.length})</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleStartBacktest}
              disabled={running}
              className="flex items-center gap-1.5 border border-[#0ECB81] bg-[#0ECB81]/15 px-3.5 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-50 cursor-pointer"
            >
              {running ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
              <span>{running ? 'Running Strategies…' : 'Start Backtest'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
              aria-label="Close Backtest Lab"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {tab === 'lab' && (
            <>
              {/* Configuration Toolbar */}
              <div className="border border-[#222938] bg-[#0B0E14] p-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-2.5 text-xs">
                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Instrument
                    </span>
                    <select
                      value={btSymbol}
                      onChange={(e) => setBtSymbol(e.target.value as InstrumentSymbol)}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                    >
                      {INSTRUMENTS.map((i) => (
                        <option key={i.symbol} value={i.symbol}>
                          {i.symbol}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Exec TF
                    </span>
                    <select
                      value={btTimeframe}
                      onChange={(e) => {
                        const tf = e.target.value as Timeframe;
                        setBtTimeframe(tf);
                        setBtHtf(defaultHtfFor(tf));
                      }}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                    >
                      {EXEC_TIMEFRAMES.map((tf) => (
                        <option key={tf} value={tf}>
                          {tf}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      HTF Bias
                    </span>
                    <select
                      value={btHtf}
                      onChange={(e) => setBtHtf(e.target.value as Timeframe)}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                    >
                      {HTF_TIMEFRAMES.map((tf) => (
                        <option key={tf} value={tf}>
                          {tf}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      History Bars (Max 10,000)
                    </span>
                    <div className="flex gap-1">
                      <select
                        value={BAR_PRESETS.includes(btBars as (typeof BAR_PRESETS)[number]) ? btBars : 'custom'}
                        onChange={(e) => {
                          if (e.target.value !== 'custom') {
                            setBtBars(Number(e.target.value));
                          }
                        }}
                        aria-label="History Bars Preset"
                        className="w-1/2 border border-[#222938] bg-[#12161F] px-1.5 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                      >
                        {BAR_PRESETS.map((b) => (
                          <option key={b} value={b}>
                            {b.toLocaleString('en-US')}
                          </option>
                        ))}
                        {!BAR_PRESETS.includes(btBars as (typeof BAR_PRESETS)[number]) && (
                          <option value="custom">Custom</option>
                        )}
                      </select>
                      <input
                        type="number"
                        min={120}
                        max={10000}
                        step={100}
                        value={btBars}
                        onChange={(e) =>
                          setBtBars(
                            Math.min(10000, Math.max(120, Math.round(Number(e.target.value) || 500)))
                          )
                        }
                        aria-label="History Bars Count"
                        className="w-1/2 border border-[#222938] bg-[#12161F] px-1.5 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none focus:border-[#38BDF8]"
                      />
                    </div>
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Capital ($)
                    </span>
                    <input
                      type="number"
                      min={100}
                      step={500}
                      value={initialCapital}
                      onChange={(e) => setInitialCapital(Math.max(100, Number(e.target.value) || 10000))}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none focus:border-[#38BDF8]"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Risk / Trade %
                    </span>
                    <input
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.25}
                      value={riskPercent}
                      onChange={(e) => setRiskPercent(Math.min(10, Math.max(0.1, Number(e.target.value) || 1)))}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none focus:border-[#38BDF8]"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Min TP1 R:R
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={0.1}
                      value={minRR}
                      onChange={(e) => setMinRR(Math.min(5, Math.max(1, Number(e.target.value) || 1.5)))}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none focus:border-[#38BDF8]"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Fee / Slip (bps)
                    </span>
                    <div className="flex gap-1">
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={commissionBps}
                        onChange={(e) => setCommissionBps(Math.max(0, Number(e.target.value) || 0))}
                        title="Commission bps per leg"
                        className="w-1/2 border border-[#222938] bg-[#12161F] px-1.5 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none"
                      />
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={slippageBps}
                        onChange={(e) => setSlippageBps(Math.max(0, Number(e.target.value) || 0))}
                        title="Slippage bps per fill"
                        className="w-1/2 border border-[#222938] bg-[#12161F] px-1.5 py-1.5 font-mono text-xs text-[#E6EDF3] tabular-nums outline-none"
                      />
                    </div>
                  </label>

                  <div className="space-y-1">
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Protection
                    </span>
                    <button
                      type="button"
                      onClick={() => setBreakevenAfterTp1((v) => !v)}
                      className={`w-full border px-2 py-1.5 text-[11px] font-medium cursor-pointer ${
                        breakevenAfterTp1
                          ? 'border-[#0ECB81]/60 bg-[#0ECB81]/10 text-[#0ECB81]'
                          : 'border-[#222938] bg-[#12161F] text-[#8B949E]'
                      }`}
                    >
                      {breakevenAfterTp1 ? 'BE After TP1: ON' : 'BE After TP1: OFF'}
                    </button>
                  </div>
                </div>

                {/* Collapsible Multi-Strategy Selector */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1D2432] pt-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setShowStrategyPicker((v) => !v)}
                    className="flex items-center gap-1.5 text-[#C9D1D9] hover:text-[#38BDF8] cursor-pointer"
                  >
                    {showStrategyPicker ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    <span>
                      Strategies Included ({selectedStrategyIds.length}/{strategyDefs.length})
                    </span>
                  </button>
                  <span className="font-mono text-[#6E7681]">
                    Conservative SL-first intrabar fill · Scaling 40/35/25 across TP1–TP3
                  </span>
                </div>

                {showStrategyPicker && (
                  <div className="space-y-2.5 border-t border-[#1D2432] pt-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {STRATEGY_CATEGORIES.map((cat) => (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => setPickerCategory(cat)}
                            className={`border px-2 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                              pickerCategory === cat
                                ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-medium'
                                : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                            }`}
                          >
                            {cat} ({pickerCategoryCounts[cat] ?? 0})
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#6E7681]" />
                          <input
                            type="text"
                            value={pickerQuery}
                            onChange={(e) => setPickerQuery(e.target.value)}
                            placeholder="Filter strategies..."
                            className="w-44 border border-[#222938] bg-[#12161F] py-1 pl-6 pr-2 text-[11px] text-[#E6EDF3] placeholder:text-[#6E7681] outline-none focus:border-[#38BDF8]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={selectAllStrategies}
                          className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Select All ({strategyDefs.length})
                        </button>
                        {pickerCategory !== 'ALL' && (
                          <button
                            type="button"
                            onClick={selectOnlyPickerCategory}
                            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Only {pickerCategory}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={toggleVisiblePickerStrategies}
                          className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Toggle Visible ({filteredPickerDefs.length})
                        </button>
                      </div>
                    </div>

                    <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-4">
                      {(pickerShowAll ? filteredPickerDefs : filteredPickerDefs.slice(0, 120)).map((def) => {
                        const active = selectedStrategyIds.includes(def.id);
                        return (
                          <button
                            key={def.id}
                            type="button"
                            onClick={() => toggleStrategyId(def.id)}
                            className={`flex items-start gap-2 border p-2 text-left text-xs cursor-pointer ${
                              active
                                ? 'border-[#38BDF8]/70 bg-[#161B26]'
                                : 'border-[#222938] bg-[#12161F] opacity-65'
                            }`}
                          >
                            <div
                              className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                                active
                                  ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#38BDF8]'
                                  : 'border-[#484F58]'
                              }`}
                            >
                              {active && <Check className="h-2.5 w-2.5" />}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium text-[#E6EDF3] truncate">{def.name}</div>
                              <div className="text-[10px] text-[#8B949E]">{def.category}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {!pickerShowAll && filteredPickerDefs.length > 120 && (
                      <div className="flex justify-center pt-1">
                        <button
                          type="button"
                          onClick={() => setPickerShowAll(true)}
                          className="border border-[#222938] bg-[#12161F] px-3 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                        >
                          Show All {filteredPickerDefs.length} Matching Strategies
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {errorMsg && (
                <div className="border border-[#F6465D]/60 bg-[#F6465D]/10 px-3 py-2 text-xs text-[#F6465D]">
                  {errorMsg}
                </div>
              )}

              {/* Empty Welcome State */}
              {!currentRun && !running && (
                <div className="border border-[#222938] bg-[#0B0E14] p-8 text-center space-y-3">
                  <FlaskConical className="mx-auto h-8 w-8 text-[#38BDF8]" />
                  <h3 className="text-sm font-semibold text-[#E6EDF3]">
                    Ready to Generate & Backtest {strategyDefs.length || 3200}+ Institutional Strategies
                  </h3>
                  <p className="mx-auto max-w-2xl text-xs text-[#8B949E] leading-relaxed">
                    Click <strong className="text-[#0ECB81]">Start Backtest</strong> above to
                    accurately evaluate {strategyDefs.length || 3200} causal strategy combinations spanning
                    Smart Money &amp; ICT Concepts ({pickerCategoryCounts['SMC'] || 850}), Price Action &amp;
                    Candlestick Models ({pickerCategoryCounts['Price Action'] || 800}), W/M &amp; Chart
                    Patterns ({pickerCategoryCounts['Chart Patterns'] || 480}), Support &amp;
                    Resistance / Pivots ({pickerCategoryCounts['Support & Resistance'] || 600}), and
                    Dynamic Multi-Pillar Hybrids ({pickerCategoryCounts['Hybrid SMC/PA'] || 650}) against real
                    historical {btSymbol} {btTimeframe} bars with zero lookahead.
                  </p>
                </div>
              )}

              {/* Running Spinner State */}
              {running && (
                <div className="border border-[#38BDF8]/40 bg-[#0B0E14] p-8 text-center space-y-2">
                  <RefreshCw className="mx-auto h-7 w-7 animate-spin text-[#38BDF8]" />
                  <div className="text-sm font-medium text-[#E6EDF3]">
                    Replaying {btBars} historical {btSymbol} {btTimeframe} bars bar-by-bar…
                  </div>
                  <div className="text-xs text-[#8B949E]">
                    Computing causal {btHtf} + {btTimeframe} Smart Money & Price Action structures across{' '}
                    {selectedStrategyIds.length} strategies
                  </div>
                </div>
              )}

              {/* Completed Backtest Results */}
              {currentRun && !running && (
                <>
                  {/* Best Strategy Verdict & Run Metadata */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border border-[#0ECB81]/40 bg-[#0ECB81]/5 p-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Award className="mt-0.5 h-5 w-5 shrink-0 text-[#0ECB81]" />
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#E6EDF3]">
                          <span>Best Strategy Recommendation</span>
                          <span className="font-mono text-[11px] text-[#8B949E]">
                            {currentRun.config.symbol} · {currentRun.config.timeframe} (HTF{' '}
                            {currentRun.config.htfTimeframe})
                          </span>
                        </div>
                        <p className="text-xs text-[#C9D1D9]">{currentRun.bestStrategyReason}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[#8B949E] tabular-nums">
                      <span>
                        Window: {fmtTimeSec(currentRun.dataRange.startTime)} →{' '}
                        {fmtTimeSec(currentRun.dataRange.endTime)}
                      </span>
                      <span>
                        Bars: {currentRun.dataRange.evaluatedBars}/{currentRun.dataRange.totalBars}
                      </span>
                      <span>Engine: {currentRun.durationMs}ms</span>
                      <span>{currentRun.dataRange.provider}</span>
                    </div>
                  </div>

                  {/* High-Level Recharts Performance Dashboard (Profit, Win Rate & Drawdown) */}
                  <PerformanceDashboard
                    run={currentRun}
                    selectedStrategyId={selectedResult?.strategy.id ?? null}
                    onSelectStrategy={(id) => {
                      setInspectedStrategyId(id);
                      setExpandedTradeId(null);
                    }}
                    timezone={timezone}
                  />

                  {/* Multi-Strategy Comparison Leaderboard */}
                  <div className="border border-[#222938] bg-[#0B0E14]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-3 py-2">
                      <span className="text-xs font-semibold text-[#E6EDF3]">
                        Multi-Strategy Comparison Leaderboard ({filteredLeaderboard.length}/
                        {currentRun.strategies.length} · Click Row to Inspect)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={exportCsv}
                          disabled={!selectedResult}
                          className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                        >
                          <Download className="h-3 w-3" />
                          <span>Export CSV</span>
                        </button>
                        <button
                          type="button"
                          onClick={exportJson}
                          className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                        >
                          <Download className="h-3 w-3" />
                          <span>Export JSON</span>
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] bg-[#0E121A] px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {STRATEGY_CATEGORIES.map((cat) => (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => setLeaderboardCategory(cat)}
                            className={`border px-2 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                              leaderboardCategory === cat
                                ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-medium'
                                : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                            }`}
                          >
                            {cat} ({leaderboardCategoryCounts[cat] ?? 0})
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#6E7681]" />
                          <input
                            type="text"
                            value={leaderboardQuery}
                            onChange={(e) => setLeaderboardQuery(e.target.value)}
                            placeholder="Search strategy..."
                            className="w-44 border border-[#222938] bg-[#12161F] py-1 pl-6 pr-2 text-[11px] text-[#E6EDF3] placeholder:text-[#6E7681] outline-none focus:border-[#38BDF8]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setActiveOnlyLeaderboard((v) => !v)}
                          className={`border px-2.5 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                            activeOnlyLeaderboard
                              ? 'border-[#0ECB81] bg-[#0ECB81]/10 text-[#0ECB81] font-medium'
                              : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                          }`}
                        >
                          {activeOnlyLeaderboard ? 'Active Trades Only: ON' : 'Active Trades Only: OFF'}
                        </button>
                      </div>
                    </div>

                    <div className="max-h-[400px] overflow-auto">
                      <table className="w-full text-left font-mono text-xs tabular-nums">
                        <thead className="sticky top-0 z-10 border-b border-[#222938] bg-[#12161F] text-[10px] uppercase text-[#8B949E]">
                          <tr>
                            <th className="px-3 py-2">Rank</th>
                            <th className="px-3 py-2">Strategy</th>
                            <th className="px-3 py-2">Type</th>
                            <th className="px-3 py-2 text-right">Score</th>
                            <th className="px-3 py-2 text-right">Trades (W/L)</th>
                            <th className="px-3 py-2 text-right">Win %</th>
                            <th className="px-3 py-2 text-right">Net Profit</th>
                            <th className="px-3 py-2 text-right">Return %</th>
                            <th className="px-3 py-2 text-right">PF</th>
                            <th className="px-3 py-2 text-right">Expectancy</th>
                            <th className="px-3 py-2 text-right">Max DD</th>
                            <th className="px-3 py-2 text-right">Sharpe</th>
                            <th className="px-3 py-2">Verdict</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1D2432]">
                          {filteredLeaderboard.length === 0 ? (
                            <tr>
                              <td colSpan={13} className="px-3 py-6 text-center font-sans text-xs text-[#8B949E]">
                                No strategies match the current category or search filter.
                              </td>
                            </tr>
                          ) : (
                            filteredLeaderboard.slice(0, leaderboardLimit).map((res) => {
                              const isSelected = selectedResult?.strategy.id === res.strategy.id;
                              const m = res.metrics;
                              const pos = m.netProfit >= 0;
                              return (
                                <tr
                                  key={res.strategy.id}
                                  onClick={() => {
                                    setInspectedStrategyId(res.strategy.id);
                                    setExpandedTradeId(null);
                                  }}
                                  className={`cursor-pointer transition-colors ${
                                    isSelected ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                                  }`}
                                >
                                  <td className="px-3 py-2 font-semibold text-[#38BDF8]">
                                    #{res.rank}
                                  </td>
                                  <td className="px-3 py-2 font-sans font-medium text-[#E6EDF3]">
                                    {res.strategy.name}
                                  </td>
                                  <td className="px-3 py-2 text-[11px] text-[#8B949E] whitespace-nowrap">
                                    {res.strategy.category}
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold text-[#E6EDF3]">
                                    {m.compositeScore}/100
                                  </td>
                                  <td className="px-3 py-2 text-right text-[#C9D1D9]">
                                    {m.totalTrades}{' '}
                                    <span className="text-[10px] text-[#8B949E]">
                                      ({m.wins}/{m.losses})
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right text-[#E6EDF3]">
                                    {m.winRate}%
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right font-semibold ${
                                      pos ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {pos ? '+' : '-'}${Math.abs(m.netProfit).toFixed(2)}
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right font-semibold ${
                                      pos ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {pos ? '+' : ''}
                                    {m.netReturnPercent.toFixed(2)}%
                                  </td>
                                  <td className="px-3 py-2 text-right text-[#E6EDF3]">
                                    {m.profitFactor !== null ? m.profitFactor.toFixed(2) : '—'}
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right ${
                                      m.expectancyR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {m.expectancyR >= 0 ? '+' : ''}
                                    {m.expectancyR.toFixed(2)}R
                                  </td>
                                  <td className="px-3 py-2 text-right text-[#F6465D]">
                                    -{m.maxDrawdownPercent.toFixed(2)}%
                                  </td>
                                  <td className="px-3 py-2 text-right text-[#C9D1D9]">
                                    {m.sharpeRatio.toFixed(2)}
                                  </td>
                                  <td className="px-3 py-2 font-sans text-[11px] whitespace-nowrap">
                                    <span
                                      className={
                                        res.verdict === 'Profitable Edge'
                                          ? 'text-[#0ECB81]'
                                          : res.verdict === 'Marginal Positive'
                                            ? 'text-[#F59E0B]'
                                            : 'text-[#8B949E]'
                                      }
                                    >
                                      {res.verdict}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                      {filteredLeaderboard.length > leaderboardLimit && (
                        <div className="flex items-center justify-center gap-2 border-t border-[#1D2432] bg-[#0E121A] py-2">
                          <button
                            type="button"
                            onClick={() => setLeaderboardLimit((n) => n + 250)}
                            className="border border-[#222938] bg-[#12161F] px-3 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                          >
                            Load +250 More (Showing {Math.min(leaderboardLimit, filteredLeaderboard.length)} of {filteredLeaderboard.length})
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Selected Strategy Deep Dive */}
                  {selectedResult && (
                    <div className="space-y-4">
                      {/* Strategy Summary + Rules + Evaluation */}
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                        <div className="border border-[#222938] bg-[#0B0E14] p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-[#38BDF8]">
                              #{selectedResult.rank} {selectedResult.strategy.name}
                            </span>
                            <span className="font-mono text-[11px] text-[#8B949E]">
                              {selectedResult.strategy.category}
                            </span>
                          </div>
                          <p className="text-xs text-[#C9D1D9] leading-relaxed">
                            {selectedResult.strategy.summary}
                          </p>
                          <div className="border-t border-[#1D2432] pt-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase text-[#8B949E]">
                              Entry Conditions
                            </div>
                            <ul className="space-y-1 text-[11px] text-[#C9D1D9]">
                              {selectedResult.strategy.entryRules.map((r, idx) => (
                                <li key={idx}>• {r}</li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        <div className="border border-[#222938] bg-[#0B0E14] p-3 space-y-2">
                          <div className="text-[10px] font-semibold uppercase text-[#8B949E]">
                            Risk & Exit Logic
                          </div>
                          <ul className="space-y-1 text-[11px] text-[#C9D1D9]">
                            {selectedResult.strategy.riskRules.map((r, idx) => (
                              <li key={idx}>• {r}</li>
                            ))}
                          </ul>
                          <div className="grid grid-cols-2 gap-2 border-t border-[#1D2432] pt-2">
                            <div>
                              <div className="mb-1 text-[10px] font-semibold uppercase text-[#0ECB81]">
                                Strengths
                              </div>
                              {selectedResult.strengths.length > 0 ? (
                                <ul className="space-y-0.5 text-[11px] text-[#C9D1D9]">
                                  {selectedResult.strengths.map((s, idx) => (
                                    <li key={idx}>+ {s}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="text-[11px] text-[#6E7681]">None flagged</div>
                              )}
                            </div>
                            <div>
                              <div className="mb-1 text-[10px] font-semibold uppercase text-[#F59E0B]">
                                Weaknesses
                              </div>
                              {selectedResult.weaknesses.length > 0 ? (
                                <ul className="space-y-0.5 text-[11px] text-[#C9D1D9]">
                                  {selectedResult.weaknesses.map((w, idx) => (
                                    <li key={idx}>! {w}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="text-[11px] text-[#6E7681]">None flagged</div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Complete KPI Grid */}
                        <div className="border border-[#222938] bg-[#0B0E14] p-3">
                          <div className="mb-2 text-[10px] font-semibold uppercase text-[#8B949E]">
                            Complete Performance Metrics
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
                            <span className="text-[#8B949E]">Ending Equity</span>
                            <span className="text-right text-[#E6EDF3]">
                              ${selectedResult.metrics.endingEquity.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            </span>

                            <span className="text-[#8B949E]">Gross Profit / Loss</span>
                            <span className="text-right text-[#E6EDF3]">
                              <span className="text-[#0ECB81]">
                                +${selectedResult.metrics.grossProfit.toFixed(0)}
                              </span>{' '}
                              /{' '}
                              <span className="text-[#F6465D]">
                                -${selectedResult.metrics.grossLoss.toFixed(0)}
                              </span>
                            </span>

                            <span className="text-[#8B949E]">Longs (Win%)</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.longTrades} ({selectedResult.metrics.longWinRate}%)
                            </span>

                            <span className="text-[#8B949E]">Shorts (Win%)</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.shortTrades} ({selectedResult.metrics.shortWinRate}%)
                            </span>

                            <span className="text-[#8B949E]">Avg Win / Loss R</span>
                            <span className="text-right text-[#E6EDF3]">
                              <span className="text-[#0ECB81]">+{selectedResult.metrics.avgWinR}R</span>{' '}
                              / <span className="text-[#F6465D]">-{selectedResult.metrics.avgLossR}R</span>
                            </span>

                            <span className="text-[#8B949E]">Best / Worst Trade</span>
                            <span className="text-right text-[#E6EDF3]">
                              +{selectedResult.metrics.bestTradeR}R / {selectedResult.metrics.worstTradeR}R
                            </span>

                            <span className="text-[#8B949E]">Sortino / Recovery</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.sortinoRatio} /{' '}
                              {selectedResult.metrics.recoveryFactor ?? '—'}
                            </span>

                            <span className="text-[#8B949E]">Max Consec W / L</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.maxConsecutiveWins} /{' '}
                              {selectedResult.metrics.maxConsecutiveLosses}
                            </span>

                            <span className="text-[#8B949E]">TP1 / TP2 / TP3 Hit</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.tp1HitRate}% / {selectedResult.metrics.tp2HitRate}% /{' '}
                              {selectedResult.metrics.tp3HitRate}%
                            </span>

                            <span className="text-[#8B949E]">SL Hit / Avg Bars</span>
                            <span className="text-right text-[#E6EDF3]">
                              {selectedResult.metrics.slHitRate}% / {selectedResult.metrics.avgBarsHeld}b
                            </span>

                            <span className="text-[#8B949E]">Fees & Slippage</span>
                            <span className="text-right text-[#F59E0B]">
                              -${selectedResult.metrics.totalFeesAndSlippage.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Equity & Drawdown Chart */}
                      <EquityCurveChart
                        selectedResult={selectedResult}
                        allResults={currentRun.strategies}
                        initialCapital={currentRun.config.initialCapital}
                        timezone={timezone}
                      />

                      {/* Trade-by-Trade Execution Ledger */}
                      <div className="border border-[#222938] bg-[#0B0E14]">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-3 py-2">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-[#E6EDF3]">
                              Trade-by-Trade Ledger ({filteredTrades.length})
                            </span>
                            <span className="text-[11px] text-[#8B949E]">
                              Click row for Entry Rationale & Exit Analysis
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-[11px]">
                            {(['ALL', 'BUY', 'SELL', 'WINS', 'LOSSES'] as TradeFilter[]).map(
                              (f) => (
                                <button
                                  key={f}
                                  type="button"
                                  onClick={() => setTradeFilter(f)}
                                  className={`border px-2 py-0.5 cursor-pointer ${
                                    tradeFilter === f
                                      ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                                      : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                                  }`}
                                >
                                  {f}
                                </button>
                              )
                            )}
                          </div>
                        </div>

                        {filteredTrades.length === 0 ? (
                          <div className="p-6 text-center text-xs text-[#8B949E]">
                            No trades match the selected filter for this strategy.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left font-mono text-[11px] tabular-nums">
                              <thead className="border-b border-[#222938] bg-[#12161F] text-[10px] uppercase text-[#8B949E]">
                                <tr>
                                  <th className="px-2.5 py-2">#</th>
                                  <th className="px-2.5 py-2">Side</th>
                                  <th className="px-2.5 py-2">Entry Time</th>
                                  <th className="px-2.5 py-2">Exit Time</th>
                                  <th className="px-2.5 py-2 text-right">Bars</th>
                                  <th className="px-2.5 py-2 text-right">Entry</th>
                                  <th className="px-2.5 py-2 text-right">Initial SL</th>
                                  <th className="px-2.5 py-2 text-right">Exit</th>
                                  <th className="px-2.5 py-2">Targets</th>
                                  <th className="px-2.5 py-2">Exit Reason</th>
                                  <th className="px-2.5 py-2 text-right">Net PnL</th>
                                  <th className="px-2.5 py-2 text-right">R</th>
                                  <th className="px-2.5 py-2 text-right">MFE / MAE</th>
                                  <th className="px-2.5 py-2 text-right">Equity</th>
                                  <th className="px-2.5 py-2 text-right">Chart</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[#1D2432]">
                                {filteredTrades.map((t) => {
                                  const isWin = t.netPnl > 0.01;
                                  const isLoss = t.netPnl < -0.01;
                                  const expanded = expandedTradeId === t.id;
                                  return (
                                    <Fragment key={t.id}>
                                      <tr
                                        onClick={() =>
                                          setExpandedTradeId(expanded ? null : t.id)
                                        }
                                        className="cursor-pointer hover:bg-[#161B26]"
                                      >
                                        <td className="px-2.5 py-2 text-[#8B949E]">
                                          <span className="inline-flex items-center gap-1">
                                            {expanded ? (
                                              <ChevronDown className="h-3 w-3 text-[#38BDF8]" />
                                            ) : (
                                              <ChevronRight className="h-3 w-3 text-[#6E7681]" />
                                            )}
                                            {t.tradeNumber}
                                          </span>
                                        </td>
                                        <td className="px-2.5 py-2">
                                          <span
                                            className={`inline-flex items-center gap-0.5 font-semibold ${
                                              t.direction === 'BUY'
                                                ? 'text-[#0ECB81]'
                                                : 'text-[#F6465D]'
                                            }`}
                                          >
                                            {t.direction === 'BUY' ? (
                                              <ArrowUpRight className="h-3 w-3" />
                                            ) : (
                                              <ArrowDownRight className="h-3 w-3" />
                                            )}
                                            {t.direction}
                                          </span>
                                        </td>
                                        <td className="px-2.5 py-2 text-[#C9D1D9] whitespace-nowrap">
                                          {fmtTimeSec(t.entryTime)}
                                        </td>
                                        <td className="px-2.5 py-2 text-[#C9D1D9] whitespace-nowrap">
                                          {fmtTimeSec(t.exitTime)}
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#8B949E]">
                                          {t.barsHeld}
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#E6EDF3]">
                                          {t.entryPrice.toFixed(precision)}
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#F6465D]">
                                          {t.initialStopLoss.toFixed(precision)}
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#E6EDF3]">
                                          {t.exitPrice.toFixed(precision)}
                                        </td>
                                        <td className="px-2.5 py-2">
                                          <div className="flex items-center gap-1">
                                            {t.takeProfits.map((tp) => (
                                              <span
                                                key={tp.level}
                                                className={`border px-1 py-0.5 text-[9px] ${
                                                  tp.hit
                                                    ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81]'
                                                    : 'border-[#222938] text-[#6E7681]'
                                                }`}
                                              >
                                                TP{tp.level}
                                              </span>
                                            ))}
                                          </div>
                                        </td>
                                        <td className="px-2.5 py-2 font-sans text-[11px] text-[#C9D1D9]">
                                          {t.exitReason}
                                        </td>
                                        <td
                                          className={`px-2.5 py-2 text-right font-semibold ${
                                            isWin
                                              ? 'text-[#0ECB81]'
                                              : isLoss
                                                ? 'text-[#F6465D]'
                                                : 'text-[#8B949E]'
                                          }`}
                                        >
                                          {t.netPnl >= 0 ? '+' : '-'}${Math.abs(t.netPnl).toFixed(2)}
                                        </td>
                                        <td
                                          className={`px-2.5 py-2 text-right font-semibold ${
                                            t.realizedR > 0
                                              ? 'text-[#0ECB81]'
                                              : t.realizedR < 0
                                                ? 'text-[#F6465D]'
                                                : 'text-[#8B949E]'
                                          }`}
                                        >
                                          {t.realizedR >= 0 ? '+' : ''}
                                          {t.realizedR.toFixed(2)}R
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#8B949E]">
                                          +{t.mfeR.toFixed(1)} / -{t.maeR.toFixed(1)}
                                        </td>
                                        <td className="px-2.5 py-2 text-right text-[#E6EDF3]">
                                          ${t.equityAfter.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                        </td>
                                        <td
                                          className="px-2.5 py-2 text-right"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <button
                                            type="button"
                                            onClick={() => handleFocusTradeOnChart(t)}
                                            title="Focus Trade Window on Terminal Chart"
                                            className="border border-[#222938] bg-[#12161F] p-1 text-[#8B949E] hover:border-[#38BDF8] hover:text-[#38BDF8] cursor-pointer"
                                          >
                                            <Crosshair className="h-3 w-3" />
                                          </button>
                                        </td>
                                      </tr>
                                      {expanded && (
                                        <tr className="bg-[#12161F]">
                                          <td colSpan={15} className="px-4 py-3 font-sans">
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                                              <div>
                                                <div className="mb-1 text-[10px] font-semibold uppercase text-[#0ECB81]">
                                                  Entry Rationale (Score {t.confluenceScore}/100 ·{' '}
                                                  {t.entryMode})
                                                </div>
                                                <ul className="space-y-0.5 text-[#C9D1D9]">
                                                  {t.entryRationale.map((r, i) => (
                                                    <li key={i}>• {r}</li>
                                                  ))}
                                                </ul>
                                              </div>
                                              <div>
                                                <div className="mb-1 text-[10px] font-semibold uppercase text-[#38BDF8]">
                                                  Exit & Outcome Analysis
                                                </div>
                                                <p className="text-[#C9D1D9]">{t.exitNote}</p>
                                                <div className="mt-1.5 font-mono text-[11px] text-[#8B949E]">
                                                  TP Targets:{' '}
                                                  {t.takeProfits
                                                    .map(
                                                      (tp) =>
                                                        `TP${tp.level} ${tp.price.toFixed(precision)} (${tp.riskReward}R)`
                                                    )
                                                    .join(' · ')}
                                                </div>
                                              </div>
                                              <div className="font-mono text-[11px] text-[#8B949E] space-y-1 tabular-nums">
                                                <div>
                                                  Size: <span className="text-[#E6EDF3]">{t.units} units</span> ·
                                                  Risk <span className="text-[#E6EDF3]">${t.riskAmount.toFixed(2)}</span>
                                                </div>
                                                <div>
                                                  Gross PnL:{' '}
                                                  <span className="text-[#E6EDF3]">
                                                    {t.grossPnl >= 0 ? '+' : '-'}${Math.abs(t.grossPnl).toFixed(2)}
                                                  </span>{' '}
                                                  · Fees/Slip:{' '}
                                                  <span className="text-[#F59E0B]">
                                                    -${t.feesAndSlippage.toFixed(2)}
                                                  </span>
                                                </div>
                                                <div>
                                                  Invalidation Level:{' '}
                                                  <span className="text-[#E6EDF3]">
                                                    {t.invalidationLevel.toFixed(precision)}
                                                  </span>
                                                </div>
                                              </div>
                                            </div>
                                          </td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Saved Runs SQLite Archive Tab */}
          {tab === 'archive' && (
            <div className="border border-[#222938] bg-[#0B0E14]">
              <div className="flex items-center justify-between border-b border-[#222938] px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <Database className="h-3.5 w-3.5 text-[#38BDF8]" />
                  <span className="font-semibold text-[#E6EDF3]">
                    SQLite Backtest History Archive
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchStrategiesAndArchive()}
                  disabled={loadingArchive}
                  className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                >
                  <RefreshCw className={`h-3 w-3 ${loadingArchive ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {savedRuns.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#8B949E]">
                  No backtests saved yet. Click <strong className="text-[#0ECB81]">Start Backtest</strong>{' '}
                  to run and persist your first multi-strategy evaluation.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs tabular-nums">
                    <thead className="border-b border-[#222938] bg-[#12161F] text-[10px] uppercase text-[#8B949E]">
                      <tr>
                        <th className="px-3 py-2">Run Time</th>
                        <th className="px-3 py-2">Asset / TF</th>
                        <th className="px-3 py-2 text-right">Bars</th>
                        <th className="px-3 py-2">Top Strategy</th>
                        <th className="px-3 py-2 text-right">Best Return</th>
                        <th className="px-3 py-2 text-right">Win %</th>
                        <th className="px-3 py-2 text-right">PF</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1D2432]">
                      {savedRuns.map((run) => {
                        const pos = (run.bestNetReturnPercent ?? 0) >= 0;
                        const confirming = confirmDeleteRunId === run.id;
                        return (
                          <tr key={run.id} className="hover:bg-[#161B26]">
                            <td className="px-3 py-2 text-[#C9D1D9]">
                              {fmtTimeMs(run.createdAt)}
                            </td>
                            <td className="px-3 py-2 font-semibold text-[#E6EDF3]">
                              {run.symbol} · {run.timeframe}
                            </td>
                            <td className="px-3 py-2 text-right text-[#8B949E]">{run.bars}</td>
                            <td className="px-3 py-2 font-sans text-[#C9D1D9]">
                              {run.bestStrategyName ?? '—'}
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-semibold ${
                                pos ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                              }`}
                            >
                              {run.bestNetReturnPercent !== null
                                ? `${pos ? '+' : ''}${run.bestNetReturnPercent.toFixed(2)}%`
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-[#E6EDF3]">
                              {run.bestWinRate !== null ? `${run.bestWinRate}%` : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-[#E6EDF3]">
                              {run.bestProfitFactor !== null
                                ? run.bestProfitFactor.toFixed(2)
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void handleLoadSavedRun(run.id)}
                                  className="border border-[#38BDF8]/60 bg-[#38BDF8]/10 px-2 py-0.5 font-sans text-[11px] text-[#38BDF8] hover:bg-[#38BDF8]/20 cursor-pointer"
                                >
                                  Load Report
                                </button>
                                {confirming ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteSavedRun(run.id)}
                                      className="border border-[#F6465D] bg-[#F6465D]/20 px-2 py-0.5 font-sans text-[11px] text-[#F6465D] cursor-pointer"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteRunId(null)}
                                      className="border border-[#222938] bg-[#12161F] px-2 py-0.5 font-sans text-[11px] text-[#8B949E] cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteRunId(run.id)}
                                    title="Delete Saved Backtest Run"
                                    className="border border-[#222938] bg-[#12161F] p-1 text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
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
    </div>
  );
}
