import { Activity, BarChart3, ShieldAlert, Target, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type {
  BacktestRunResult,
  BacktestStrategyCategory,
  BacktestStrategyId,
  BacktestStrategyResult,
} from '../../shared/types/index.ts';
import { BasketPortfolioPanel } from './BasketPortfolioPanel.tsx';
import { CorrelationAnalysisPanel } from './CorrelationAnalysisPanel.tsx';

type DashboardCategory = 'ALL' | BacktestStrategyCategory;
type DashboardViewMode = 'all' | 'charts' | 'correlation' | 'basket';

const CATEGORIES: DashboardCategory[] = [
  'ALL',
  'SMC',
  'Price Action',
  'Chart Patterns',
  'Support & Resistance',
  'Hybrid SMC/PA',
];

const SHORT_CATEGORY: Record<BacktestStrategyCategory, string> = {
  SMC: 'SMC',
  'Price Action': 'Price Action',
  'Chart Patterns': 'Chart Pat.',
  'Support & Resistance': 'S/R Zones',
  'Hybrid SMC/PA': 'Hybrid',
};

interface PerformanceDashboardProps {
  run: BacktestRunResult;
  selectedStrategyId: BacktestStrategyId | null;
  onSelectStrategy: (id: BacktestStrategyId) => void;
  timezone: string;
}

interface TopBarRow {
  id: string;
  rank: number;
  shortLabel: string;
  fullName: string;
  category: BacktestStrategyCategory;
  netProfit: number;
  netReturnPercent: number;
  winRate: number;
  maxDrawdownPercent: number;
  profitFactor: number | null;
  totalTrades: number;
  compositeScore: number;
}

interface ScatterRow {
  id: string;
  rank: number;
  fullName: string;
  category: BacktestStrategyCategory;
  winRate: number;
  netProfit: number;
  netReturnPercent: number;
  maxDrawdownPercent: number;
  totalTrades: number;
  compositeScore: number;
  isSelected: boolean;
}

interface CategorySummaryRow {
  category: BacktestStrategyCategory;
  shortName: string;
  totalCount: number;
  activeCount: number;
  profitableCount: number;
  profitablePct: number;
  avgWinRate: number;
  avgMaxDd: number;
  avgReturnPct: number;
  topProfit: number;
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function truncateLabel(text: string, maxLen = 18): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function TopProfitTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TopBarRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl">
      <div className="font-semibold text-[#E6EDF3]">
        #{d.rank} · {d.fullName}
      </div>
      <div className="mb-1.5 text-[10px] text-[#8B949E]">
        {d.category} · Score {d.compositeScore}/100 · {d.totalTrades} Trades
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums">
        <span className="text-[#8B949E]">Net Profit:</span>
        <span className={d.netProfit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
          {fmtUsd(d.netProfit)} ({d.netReturnPercent >= 0 ? '+' : ''}
          {d.netReturnPercent.toFixed(2)}%)
        </span>
        <span className="text-[#8B949E]">Win Rate:</span>
        <span className="text-[#38BDF8]">{d.winRate.toFixed(1)}%</span>
        <span className="text-[#8B949E]">Max Drawdown:</span>
        <span className="text-[#F59E0B]">{d.maxDrawdownPercent.toFixed(2)}%</span>
        <span className="text-[#8B949E]">Profit Factor:</span>
        <span>{d.profitFactor !== null ? d.profitFactor.toFixed(2) : '—'}</span>
      </div>
    </div>
  );
}

function ScatterStrategyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl">
      <div className="font-semibold text-[#E6EDF3]">
        #{d.rank} · {d.fullName}
      </div>
      <div className="mb-1.5 text-[10px] text-[#8B949E]">
        {d.category} · {d.totalTrades} Trades · Click dot to inspect
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums">
        <span className="text-[#8B949E]">Total Profit:</span>
        <span className={d.netProfit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
          {fmtUsd(d.netProfit)}
        </span>
        <span className="text-[#8B949E]">Win Rate:</span>
        <span className="text-[#38BDF8]">{d.winRate.toFixed(1)}%</span>
        <span className="text-[#8B949E]">Max Drawdown:</span>
        <span className="text-[#F59E0B]">{d.maxDrawdownPercent.toFixed(2)}%</span>
        <span className="text-[#8B949E]">Score:</span>
        <span>{d.compositeScore}/100</span>
      </div>
    </div>
  );
}

function CategoryTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: CategorySummaryRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl">
      <div className="mb-1 font-semibold text-[#E6EDF3]">
        {d.category} ({d.activeCount}/{d.totalCount} active)
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums">
        <span className="text-[#8B949E]">Profitable Share:</span>
        <span className="text-[#0ECB81]">
          {d.profitablePct.toFixed(1)}% ({d.profitableCount}/{d.activeCount})
        </span>
        <span className="text-[#8B949E]">Avg Win Rate:</span>
        <span className="text-[#38BDF8]">{d.avgWinRate.toFixed(1)}%</span>
        <span className="text-[#8B949E]">Avg Max DD:</span>
        <span className="text-[#F59E0B]">{d.avgMaxDd.toFixed(2)}%</span>
        <span className="text-[#8B949E]">Avg Return:</span>
        <span className={d.avgReturnPct >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
          {d.avgReturnPct >= 0 ? '+' : ''}
          {d.avgReturnPct.toFixed(2)}%
        </span>
        <span className="text-[#8B949E]">Top Strategy Profit:</span>
        <span className={d.topProfit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
          {fmtUsd(d.topProfit)}
        </span>
      </div>
    </div>
  );
}

function CurveTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; equity: number; drawdownPercent: number } }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2 text-[11px] text-[#E6EDF3] shadow-xl font-mono tabular-nums">
      <div className="mb-1 text-[10px] text-[#8B949E]">{d.label}</div>
      <div className="flex justify-between gap-4">
        <span className="text-[#8B949E]">Equity:</span>
        <span className="text-[#0ECB81]">${d.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[#8B949E]">Drawdown:</span>
        <span className="text-[#F59E0B]">-{d.drawdownPercent.toFixed(2)}%</span>
      </div>
    </div>
  );
}

export function PerformanceDashboard({
  run,
  selectedStrategyId,
  onSelectStrategy,
  timezone,
}: PerformanceDashboardProps) {
  const [catFilter, setCatFilter] = useState<DashboardCategory>('ALL');
  const [viewMode, setViewMode] = useState<DashboardViewMode>('all');

  const scopedStrategies = useMemo(() => {
    if (catFilter === 'ALL') return run.strategies;
    return run.strategies.filter((s) => s.strategy.category === catFilter);
  }, [run.strategies, catFilter]);

  const activeStrategies = useMemo(
    () => scopedStrategies.filter((s) => s.metrics.totalTrades > 0),
    [scopedStrategies]
  );

  const summary = useMemo(() => {
    const total = scopedStrategies.length;
    const active = activeStrategies.length;
    const profitable = activeStrategies.filter((s) => s.metrics.netProfit > 0);
    const totalTrades = activeStrategies.reduce((acc, s) => acc + s.metrics.totalTrades, 0);

    const avgProfit =
      active > 0
        ? activeStrategies.reduce((acc, s) => acc + s.metrics.netProfit, 0) / active
        : 0;
    const avgWinRate =
      active > 0
        ? activeStrategies.reduce((acc, s) => acc + s.metrics.winRate, 0) / active
        : 0;
    const avgMaxDd =
      active > 0
        ? activeStrategies.reduce((acc, s) => acc + s.metrics.maxDrawdownPercent, 0) / active
        : 0;

    let bestProfitStrat: BacktestStrategyResult | null = null;
    let bestWinRate = 0;
    let worstMaxDd = 0;
    for (const s of activeStrategies) {
      if (!bestProfitStrat || s.metrics.netProfit > bestProfitStrat.metrics.netProfit) {
        bestProfitStrat = s;
      }
      if (s.metrics.winRate > bestWinRate) bestWinRate = s.metrics.winRate;
      if (s.metrics.maxDrawdownPercent > worstMaxDd) worstMaxDd = s.metrics.maxDrawdownPercent;
    }

    return {
      total,
      active,
      activePct: total > 0 ? (active / total) * 100 : 0,
      profitableCount: profitable.length,
      profitablePct: active > 0 ? (profitable.length / active) * 100 : 0,
      avgProfit,
      avgWinRate,
      bestWinRate,
      avgMaxDd,
      worstMaxDd,
      totalTrades,
      bestProfitStrat,
    };
  }, [scopedStrategies, activeStrategies]);

  const top15ProfitData = useMemo<TopBarRow[]>(() => {
    const sorted = [...activeStrategies]
      .sort((a, b) => b.metrics.netProfit - a.metrics.netProfit)
      .slice(0, 15);
    return sorted.map((s) => ({
      id: s.strategy.id,
      rank: s.rank,
      shortLabel: `#${s.rank}`,
      fullName: s.strategy.name,
      category: s.strategy.category,
      netProfit: s.metrics.netProfit,
      netReturnPercent: s.metrics.netReturnPercent,
      winRate: s.metrics.winRate,
      maxDrawdownPercent: s.metrics.maxDrawdownPercent,
      profitFactor: s.metrics.profitFactor,
      totalTrades: s.metrics.totalTrades,
      compositeScore: s.metrics.compositeScore,
    }));
  }, [activeStrategies]);

  const scatterData = useMemo<ScatterRow[]>(() => {
    // Cap plotted SVG nodes to top 320 by |netProfit| + selected strategy for crisp responsiveness
    const rankedByImpact = [...activeStrategies].sort(
      (a, b) => Math.abs(b.metrics.netProfit) - Math.abs(a.metrics.netProfit)
    );
    const chosen = rankedByImpact.slice(0, 320);
    if (selectedStrategyId && !chosen.some((s) => s.strategy.id === selectedStrategyId)) {
      const sel = activeStrategies.find((s) => s.strategy.id === selectedStrategyId);
      if (sel) chosen.push(sel);
    }
    return chosen.map((s) => ({
      id: s.strategy.id,
      rank: s.rank,
      fullName: s.strategy.name,
      category: s.strategy.category,
      winRate: s.metrics.winRate,
      netProfit: s.metrics.netProfit,
      netReturnPercent: s.metrics.netReturnPercent,
      maxDrawdownPercent: s.metrics.maxDrawdownPercent,
      totalTrades: s.metrics.totalTrades,
      compositeScore: s.metrics.compositeScore,
      isSelected: s.strategy.id === selectedStrategyId,
    }));
  }, [activeStrategies, selectedStrategyId]);

  const categoryBreakdown = useMemo<CategorySummaryRow[]>(() => {
    const cats: BacktestStrategyCategory[] = [
      'SMC',
      'Price Action',
      'Chart Patterns',
      'Support & Resistance',
      'Hybrid SMC/PA',
    ];
    return cats.map((category) => {
      const all = run.strategies.filter((s) => s.strategy.category === category);
      const act = all.filter((s) => s.metrics.totalTrades > 0);
      const prof = act.filter((s) => s.metrics.netProfit > 0);
      const n = act.length;
      return {
        category,
        shortName: SHORT_CATEGORY[category],
        totalCount: all.length,
        activeCount: n,
        profitableCount: prof.length,
        profitablePct: n > 0 ? Number(((prof.length / n) * 100).toFixed(1)) : 0,
        avgWinRate:
          n > 0 ? Number((act.reduce((a, b) => a + b.metrics.winRate, 0) / n).toFixed(1)) : 0,
        avgMaxDd:
          n > 0
            ? Number(
                (act.reduce((a, b) => a + b.metrics.maxDrawdownPercent, 0) / n).toFixed(2)
              )
            : 0,
        avgReturnPct:
          n > 0
            ? Number((act.reduce((a, b) => a + b.metrics.netReturnPercent, 0) / n).toFixed(2))
            : 0,
        topProfit:
          n > 0 ? Math.max(...act.map((s) => s.metrics.netProfit)) : 0,
      };
    });
  }, [run.strategies]);

  const inspectedStrategy = useMemo(() => {
    return (
      run.strategies.find((s) => s.strategy.id === selectedStrategyId) ??
      summary.bestProfitStrat ??
      run.strategies[0] ??
      null
    );
  }, [run.strategies, selectedStrategyId, summary.bestProfitStrat]);

  const inspectedCurveData = useMemo(() => {
    if (!inspectedStrategy) return [];
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return inspectedStrategy.equityCurve.map((pt) => ({
      label: fmt.format(new Date(pt.time * 1000)),
      equity: pt.equity,
      drawdownPercent: pt.drawdownPercent,
    }));
  }, [inspectedStrategy, timezone]);

  const inspectedPositive = (inspectedStrategy?.metrics.netProfit ?? 0) >= 0;

  return (
    <section className="space-y-3 border border-[#222938] bg-[#0B0E14] p-3">
      {/* Header & Category Scope Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2.5">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-[#38BDF8]" />
          <div>
            <h3 className="text-xs font-semibold text-[#E6EDF3]">
              Executive Multi-Strategy Performance Dashboard ({scopedStrategies.length} Strategies)
            </h3>
            <p className="text-[11px] text-[#8B949E]">
              Portfolio profit, win-rate distribution, drawdown exposure &amp; category edge across live historical replay
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 border border-[#222938] bg-[#12161F] p-0.5">
            {(
              [
                ['all', 'All Analytics'],
                ['charts', 'Profit & Drawdown'],
                ['correlation', 'Correlation Tool'],
                ['basket', 'Portfolio & Auto-Run'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`px-2 py-0.5 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === mode
                    ? 'bg-[#1C2331] text-[#38BDF8] font-medium'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCatFilter(cat)}
                className={`border px-2 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                  catFilter === cat
                    ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-medium'
                    : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#8B949E]">
            <span>Active Strategies</span>
            <Activity className="h-3.5 w-3.5 text-[#38BDF8]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#E6EDF3] tabular-nums">
            {summary.active.toLocaleString('en-US')}{' '}
            <span className="text-xs font-normal text-[#8B949E]">
              / {summary.total.toLocaleString('en-US')}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            {summary.activePct.toFixed(1)}% generated signals · {summary.totalTrades.toLocaleString('en-US')} trades
          </div>
        </div>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#8B949E]">
            <span>Profitable Edge</span>
            <TrendingUp className="h-3.5 w-3.5 text-[#0ECB81]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#0ECB81] tabular-nums">
            {summary.profitableCount.toLocaleString('en-US')}{' '}
            <span className="text-xs font-normal text-[#8B949E]">
              ({summary.profitablePct.toFixed(1)}%)
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Avg Active Net:{' '}
            <span className={summary.avgProfit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
              {fmtUsd(summary.avgProfit)}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (summary.bestProfitStrat) {
              onSelectStrategy(summary.bestProfitStrat.strategy.id);
            }
          }}
          className="border border-[#222938] bg-[#12161F] p-2.5 text-left hover:border-[#0ECB81]/60 cursor-pointer"
        >
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#8B949E]">
            <span>Top Total Profit</span>
            <TrendingUp className="h-3.5 w-3.5 text-[#0ECB81]" />
          </div>
          <div
            className={`mt-1 font-mono text-base font-semibold tabular-nums ${
              (summary.bestProfitStrat?.metrics.netProfit ?? 0) >= 0
                ? 'text-[#0ECB81]'
                : 'text-[#F6465D]'
            }`}
          >
            {summary.bestProfitStrat ? fmtUsd(summary.bestProfitStrat.metrics.netProfit) : '$0.00'}
          </div>
          <div className="mt-0.5 truncate font-sans text-[10px] text-[#C9D1D9]">
            {summary.bestProfitStrat
              ? `#${summary.bestProfitStrat.rank} ${summary.bestProfitStrat.strategy.name}`
              : 'No active trades'}
          </div>
        </button>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#8B949E]">
            <span>Win Rate Profile</span>
            <Target className="h-3.5 w-3.5 text-[#38BDF8]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#38BDF8] tabular-nums">
            {summary.avgWinRate.toFixed(1)}%{' '}
            <span className="text-xs font-normal text-[#8B949E]">avg</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Peak Active Win Rate: <span className="text-[#E6EDF3]">{summary.bestWinRate.toFixed(1)}%</span>
          </div>
        </div>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#8B949E]">
            <span>Drawdown Exposure</span>
            <ShieldAlert className="h-3.5 w-3.5 text-[#F59E0B]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#F59E0B] tabular-nums">
            {summary.avgMaxDd.toFixed(2)}%{' '}
            <span className="text-xs font-normal text-[#8B949E]">avg DD</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Worst Strategy DD: <span className="text-[#F6465D]">{summary.worstMaxDd.toFixed(2)}%</span>
          </div>
        </div>
      </div>

      {/* Primary Charts Grid */}
      {viewMode !== 'correlation' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* Chart 1: Top 15 Strategies Total Profit ($) vs Max Drawdown (%) */}
        <div className="lg:col-span-7 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold text-[#E6EDF3]">
                Top 15 Strategies — Total Profit ($) vs Max Drawdown (%)
              </h4>
              <p className="text-[10px] text-[#8B949E]">
                Click any bar to inspect full trade ledger · Sorted by highest Net Profit
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] text-[#8B949E]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#0ECB81]" /> Net Profit ($)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#F59E0B]" /> Max DD (%)
              </span>
            </div>
          </div>

          {top15ProfitData.length === 0 ? (
            <div className="flex h-[250px] items-center justify-center text-xs text-[#8B949E]">
              No executed trades in selected category.
            </div>
          ) : (
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={top15ProfitData}
                  margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
                  onClick={(state) => {
                    const idx = state?.activeTooltipIndex;
                    if (typeof idx === 'number' && top15ProfitData[idx]) {
                      onSelectStrategy(top15ProfitData[idx].id);
                    }
                  }}
                >
                  <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="shortLabel"
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={{ stroke: '#222938' }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="profit"
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v}`}
                    width={54}
                  />
                  <YAxis
                    yAxisId="dd"
                    orientation="right"
                    tick={{ fill: '#F59E0B', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                    width={42}
                  />
                  <Tooltip content={<TopProfitTooltip />} cursor={{ fill: '#1C2331', opacity: 0.5 }} />
                  <ReferenceLine yAxisId="profit" y={0} stroke="#30363D" />
                  <Bar yAxisId="profit" dataKey="netProfit" maxBarSize={28} className="cursor-pointer">
                    {top15ProfitData.map((entry) => (
                      <Cell
                        key={entry.id}
                        fill={entry.netProfit >= 0 ? '#0ECB81' : '#F6465D'}
                        fillOpacity={entry.id === selectedStrategyId ? 1 : 0.78}
                        stroke={entry.id === selectedStrategyId ? '#38BDF8' : 'none'}
                        strokeWidth={entry.id === selectedStrategyId ? 1.5 : 0}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="dd"
                    type="monotone"
                    dataKey="maxDrawdownPercent"
                    stroke="#F59E0B"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#F59E0B', strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#F59E0B' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Chart 2: Win Rate (%) vs Total Profit ($) Scatter */}
        <div className="lg:col-span-5 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold text-[#E6EDF3]">
                Win Rate (%) vs Total Profit ($) Matrix
              </h4>
              <p className="text-[10px] text-[#8B949E]">
                {scatterData.length} active strategies plotted · Dot size reflects Drawdown %
              </p>
            </div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-[#8B949E]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#0ECB81]" /> Profit
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#F6465D]" /> Loss
              </span>
            </div>
          </div>

          {scatterData.length === 0 ? (
            <div className="flex h-[250px] items-center justify-center text-xs text-[#8B949E]">
              No active strategy distribution available.
            </div>
          ) : (
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                  <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="winRate"
                    name="Win Rate"
                    domain={[0, 100]}
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={{ stroke: '#222938' }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <YAxis
                    type="number"
                    dataKey="netProfit"
                    name="Net Profit"
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v}`}
                    width={54}
                  />
                  <ZAxis type="number" dataKey="maxDrawdownPercent" range={[28, 180]} />
                  <Tooltip content={<ScatterStrategyTooltip />} cursor={{ stroke: '#38BDF8', strokeDasharray: '3 3' }} />
                  <ReferenceLine y={0} stroke="#30363D" />
                  <ReferenceLine x={50} stroke="#30363D" strokeDasharray="3 3" />
                  <Scatter
                    data={scatterData}
                    className="cursor-pointer"
                    onClick={(node: unknown) => {
                      const pt = (node as { payload?: ScatterRow })?.payload;
                      if (pt?.id) onSelectStrategy(pt.id);
                    }}
                  >
                    {scatterData.map((entry) => (
                      <Cell
                        key={entry.id}
                        fill={
                          entry.isSelected
                            ? '#38BDF8'
                            : entry.netProfit >= 0
                              ? '#0ECB81'
                              : '#F6465D'
                        }
                        fillOpacity={entry.isSelected ? 1 : 0.72}
                        stroke={entry.isSelected ? '#FFFFFF' : 'none'}
                        strokeWidth={entry.isSelected ? 1.5 : 0}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Chart 3: Strategy Family Comparison (Win Rate %, Profitable %, Avg Max DD %) */}
        <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold text-[#E6EDF3]">
                Category Edge — Profitable Share, Win Rate &amp; Drawdown
              </h4>
              <p className="text-[10px] text-[#8B949E]">
                Click category bar to filter dashboard scope across all 5 strategy families
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] text-[#8B949E]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#0ECB81]" /> Profitable %
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#38BDF8]" /> Win Rate %
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#F59E0B]" /> Avg DD %
              </span>
            </div>
          </div>

          <div className="h-[205px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={categoryBreakdown}
                margin={{ top: 8, right: 8, left: 0, bottom: 2 }}
                onClick={(state) => {
                  const idx = state?.activeTooltipIndex;
                  if (typeof idx === 'number' && categoryBreakdown[idx]) {
                    const clicked = categoryBreakdown[idx].category;
                    setCatFilter((prev) => (prev === clicked ? 'ALL' : clicked));
                  }
                }}
              >
                <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="shortName"
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={{ stroke: '#222938' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={40}
                />
                <Tooltip content={<CategoryTooltip />} cursor={{ fill: '#1C2331', opacity: 0.45 }} />
                <Bar dataKey="profitablePct" fill="#0ECB81" maxBarSize={20} className="cursor-pointer" />
                <Bar dataKey="avgWinRate" fill="#38BDF8" maxBarSize={20} className="cursor-pointer" />
                <Bar dataKey="avgMaxDd" fill="#F59E0B" maxBarSize={20} className="cursor-pointer" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 4: Inspected Strategy Equity & Drawdown Progression */}
        <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h4 className="truncate text-xs font-semibold text-[#E6EDF3]">
                {inspectedStrategy
                  ? `#${inspectedStrategy.rank} ${truncateLabel(inspectedStrategy.strategy.name, 42)} — Equity & Drawdown`
                  : 'Equity & Drawdown Curve'}
              </h4>
              <p className="font-mono text-[10px] text-[#8B949E] tabular-nums">
                {inspectedStrategy
                  ? `Net ${fmtUsd(inspectedStrategy.metrics.netProfit)} · Win ${inspectedStrategy.metrics.winRate}% · Max DD ${inspectedStrategy.metrics.maxDrawdownPercent}%`
                  : 'Select a strategy row to plot progression'}
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] text-[#8B949E]">
              <span className="flex items-center gap-1">
                <span
                  className={`inline-block h-2 w-2 ${
                    inspectedPositive ? 'bg-[#0ECB81]' : 'bg-[#F6465D]'
                  }`}
                />{' '}
                Equity ($)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 bg-[#F59E0B]" /> DD (%)
              </span>
            </div>
          </div>

          {inspectedCurveData.length === 0 ? (
            <div className="flex h-[205px] items-center justify-center text-xs text-[#8B949E]">
              No equity curve data available.
            </div>
          ) : (
            <div className="h-[205px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={inspectedCurveData}
                  margin={{ top: 8, right: 12, left: 4, bottom: 2 }}
                >
                  <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    minTickGap={32}
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={{ stroke: '#222938' }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="eq"
                    domain={['auto', 'auto']}
                    tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${Math.round(v)}`}
                    width={54}
                  />
                  <YAxis
                    yAxisId="dd"
                    orientation="right"
                    reversed
                    domain={[0, 'auto']}
                    tick={{ fill: '#F59E0B', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `-${v}%`}
                    width={42}
                  />
                  <Tooltip content={<CurveTooltip />} />
                  <ReferenceLine
                    yAxisId="eq"
                    y={run.config.initialCapital}
                    stroke="#30363D"
                    strokeDasharray="3 3"
                  />
                  <Area
                    yAxisId="eq"
                    type="monotone"
                    dataKey="equity"
                    stroke={inspectedPositive ? '#0ECB81' : '#F6465D'}
                    strokeWidth={2}
                    fill={inspectedPositive ? '#0ECB81' : '#F6465D'}
                    fillOpacity={0.14}
                  />
                  <Line
                    yAxisId="dd"
                    type="monotone"
                    dataKey="drawdownPercent"
                    stroke="#F59E0B"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Strategy Correlation & Risk Overlap Analysis Tool */}
      {(viewMode === 'all' || viewMode === 'correlation') && (
        <CorrelationAnalysisPanel
          run={run}
          selectedStrategyId={selectedStrategyId}
          onSelectStrategy={onSelectStrategy}
          timezone={timezone}
        />
      )}

      {/* Shared-Capital Uncorrelated Basket Portfolio Simulator & Live Auto-Run */}
      {viewMode !== 'charts' && (
        <BasketPortfolioPanel
          run={run}
          onSelectStrategy={onSelectStrategy}
          timezone={timezone}
        />
      )}
    </section>
  );
}
