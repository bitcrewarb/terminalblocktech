import { BarChart3, LineChart as LineChartIcon, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  BacktestRunResult,
  BacktestStrategyResult,
  BacktestTradeRecord,
  InstrumentSymbol,
  LiveStrategyBasketSlot,
  Timeframe,
  TradingSignal,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';

type ChartMode = 'trend' | 'compare';
type DataSourceMode = 'historical' | 'live';

const STRATEGY_PALETTE = [
  '#0ECB81',
  '#38BDF8',
  '#F59E0B',
  '#A78BFA',
  '#FB7185',
  '#2DD4BF',
  '#60A5FA',
  '#FBBF24',
  '#C084FC',
  '#34D399',
  '#F97316',
  '#22D3EE',
];

const WIN_SIGNAL_STATES = new Set(['TP1_HIT', 'TP2_HIT', 'TP3_HIT']);
const LOSS_SIGNAL_STATES = new Set(['STOPPED']);

interface StrategySeriesMeta {
  rowKey: string;
  dataKey: string;
  slotKey: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  strategyId: string;
  strategyName: string;
  shortName: string;
  color: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  profitFactor: number | null;
  netReturnPercent: number | null;
  expectancyR: number | null;
}

interface DayTradeMeta {
  wins: number;
  losses: number;
  trades: number;
  dayWins: number;
  dayTrades: number;
}

interface TrendPoint {
  dateKey: string;
  label: string;
  [key: string]: string | number | null | DayTradeMeta;
}

interface BarCompareDatum {
  rowKey: string;
  label: string;
  fullName: string;
  slotLabel: string;
  winRate: number;
  wins: number;
  losses: number;
  trades: number;
  profitFactor: number | null;
  netReturnPercent: number | null;
  color: string;
}

interface StrategyWinRateHistoryChartProps {
  armedSlots: LiveStrategyBasketSlot[];
  signals: TradingSignal[];
  timezone: string;
  selectedRowKey?: string | null;
  onSelectStrategyRow?: (rowKey: string) => void;
  onOpenDiscovery?: () => void;
}

function getSlotKey(slot: LiveStrategyBasketSlot): string {
  return `${slot.symbol}:${slot.timeframe}:${slot.htfTimeframe}`;
}

function getSlotSignature(slot: LiveStrategyBasketSlot): string {
  const ids = [...slot.strategies]
    .map((s) => s.id)
    .sort()
    .join(',');
  return `${slot.symbol}:${slot.timeframe}:${slot.htfTimeframe}:${ids}`;
}

function formatDateKeyInTz(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  }
}

function formatShortDateInTz(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      month: 'short',
      day: '2-digit',
    }).format(new Date(epochMs));
  }
}

function buildLast30DayBuckets(timezone: string, nowMs: number): Array<{ dateKey: string; label: string }> {
  const buckets: Array<{ dateKey: string; label: string }> = [];
  const seen = new Set<string>();
  for (let offset = 29; offset >= 0; offset--) {
    const ts = nowMs - offset * 86_400_000;
    const dateKey = formatDateKeyInTz(ts, timezone);
    if (!seen.has(dateKey)) {
      seen.add(dateKey);
      buckets.push({
        dateKey,
        label: formatShortDateInTz(ts, timezone),
      });
    }
  }
  return buckets;
}

function shortenStrategyName(name: string, maxLen = 22): string {
  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen - 1)}…`;
}

function isTradeWin(trade: BacktestTradeRecord): boolean {
  return trade.netPnl > 0.01;
}

function isTradeLoss(trade: BacktestTradeRecord): boolean {
  return trade.netPnl < -0.01;
}

export function StrategyWinRateHistoryChart({
  armedSlots,
  signals,
  timezone,
  selectedRowKey,
  onSelectStrategyRow,
  onOpenDiscovery,
}: StrategyWinRateHistoryChartProps) {
  const [chartMode, setChartMode] = useState<ChartMode>('trend');
  const [dataSource, setDataSource] = useState<DataSourceMode>('historical');
  const [slotFilter, setSlotFilter] = useState<string>('ALL');
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [slotResults, setSlotResults] = useState<Record<string, BacktestRunResult>>({});

  const cacheRef = useRef<Map<string, BacktestRunResult>>(new Map());
  const requestSeqRef = useRef<number>(0);

  const slotSignatures = useMemo(
    () =>
      armedSlots.map((slot) => ({
        slot,
        slotKey: getSlotKey(slot),
        signature: getSlotSignature(slot),
      })),
    [armedSlots]
  );

  // Reset slotFilter if selected slot disappears
  useEffect(() => {
    if (slotFilter !== 'ALL' && !slotSignatures.some((s) => s.slotKey === slotFilter)) {
      setSlotFilter('ALL');
    }
  }, [slotFilter, slotSignatures]);

  const fetchHistorical30d = useCallback(
    async (forceRefresh = false) => {
      if (slotSignatures.length === 0) {
        setSlotResults({});
        setError(null);
        setLoading(false);
        return;
      }

      const seq = ++requestSeqRef.current;
      const nextResults: Record<string, BacktestRunResult> = {};
      const missing: typeof slotSignatures = [];

      for (const entry of slotSignatures) {
        if (!forceRefresh) {
          const cached = cacheRef.current.get(entry.signature);
          if (cached) {
            nextResults[entry.slotKey] = cached;
            continue;
          }
        }
        if (entry.slot.strategies.length > 0) {
          missing.push(entry);
        }
      }

      if (Object.keys(nextResults).length > 0) {
        setSlotResults((prev) => ({ ...prev, ...nextResults }));
      }

      if (missing.length === 0) {
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        for (const entry of missing) {
          if (requestSeqRef.current !== seq) return;
          const tfSeconds = Math.max(60, TIMEFRAME_SECONDS[entry.slot.timeframe] ?? 900);
          const barsPerDay = Math.ceil(86400 / tfSeconds);
          const bars = Math.min(9500, Math.max(360, barsPerDay * 34));

          const res = await apiFetch('/api/backtest/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: entry.slot.symbol,
              timeframe: entry.slot.timeframe,
              htfTimeframe: entry.slot.htfTimeframe,
              bars,
              strategyIds: entry.slot.strategies.map((s) => s.id),
              saveToArchive: false,
            }),
          });

          if (!res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(
              payload.error || `Failed to load 30d history for ${entry.slot.symbol} ${entry.slot.timeframe}`
            );
          }

          const run = (await res.json()) as BacktestRunResult;
          if (requestSeqRef.current !== seq) return;
          cacheRef.current.set(entry.signature, run);
          setSlotResults((prev) => ({
            ...prev,
            [entry.slotKey]: run,
          }));
        }
      } catch (err) {
        if (requestSeqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : 'Unable to fetch 30-day historical backtest');
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
        }
      }
    },
    [slotSignatures]
  );

  useEffect(() => {
    void fetchHistorical30d(false);
  }, [fetchHistorical30d]);

  const activeSlots = useMemo(
    () =>
      slotFilter === 'ALL'
        ? slotSignatures
        : slotSignatures.filter((entry) => entry.slotKey === slotFilter),
    [slotSignatures, slotFilter]
  );

  // Build 30-day calendar buckets, cumulative line data, and strategy summary series
  const { dayBuckets, strategySeries, trendData, barData, coverageNote } = useMemo(() => {
    const nowMs = Date.now();
    const buckets = buildLast30DayBuckets(timezone, nowMs);
    const windowStartKey = buckets[0]?.dateKey ?? formatDateKeyInTz(nowMs - 29 * 86_400_000, timezone);
    const windowStartSec = Math.floor((nowMs - 30 * 86_400_000) / 1000);

    const series: StrategySeriesMeta[] = [];
    const seriesByRowKey = new Map<string, StrategySeriesMeta>();

    // Per-strategy per-day counts: Map<rowKey, Map<dateKey, { wins, losses, trades }>>
    const dailyStats = new Map<string, Map<string, { wins: number; losses: number; trades: number }>>();

    let minCoverageDays: number | null = null;
    let minCoverageLabel = '';

    let colorIdx = 0;
    for (const entry of activeSlots) {
      const { slot, slotKey } = entry;
      const run = slotResults[slotKey];

      if (run?.dataRange?.startTime && run?.dataRange?.endTime) {
        const spanDays = (run.dataRange.endTime - run.dataRange.startTime) / 86400;
        if (spanDays < 29.5 && (minCoverageDays === null || spanDays < minCoverageDays)) {
          minCoverageDays = spanDays;
          minCoverageLabel = `${slot.symbol} ${slot.timeframe} covers ${spanDays.toFixed(1)}d`;
        }
      }

      const resultByStrategy = new Map<string, BacktestStrategyResult>();
      if (run?.strategies) {
        for (const r of run.strategies) {
          resultByStrategy.set(r.strategy.id, r);
        }
      }

      for (const strat of slot.strategies) {
        const rowKey = `${slot.symbol}:${slot.timeframe}:${strat.id}`;
        if (seriesByRowKey.has(rowKey)) continue;

        const dataKey = `s_${series.length}`;
        const color = STRATEGY_PALETTE[colorIdx % STRATEGY_PALETTE.length];
        colorIdx += 1;

        const perDay = new Map<string, { wins: number; losses: number; trades: number }>();
        let wins = 0;
        let losses = 0;
        let breakevens = 0;
        let totalTrades = 0;
        let profitFactor: number | null = null;
        let netReturnPercent: number | null = null;
        let expectancyR: number | null = null;

        if (dataSource === 'historical') {
          const stratRes = resultByStrategy.get(strat.id);
          if (stratRes) {
            profitFactor = stratRes.metrics.profitFactor;
            netReturnPercent = stratRes.metrics.netReturnPercent;
            expectancyR = stratRes.metrics.expectancyR;

            const windowTrades = stratRes.trades.filter((t) => {
              const refSec = t.exitTime || t.entryTime || t.signalTime;
              return refSec >= windowStartSec;
            });

            for (const trade of windowTrades) {
              const refMs = (trade.exitTime || trade.entryTime || trade.signalTime) * 1000;
              const dateKey = formatDateKeyInTz(refMs, timezone);
              if (dateKey < windowStartKey) continue;

              const cell = perDay.get(dateKey) ?? { wins: 0, losses: 0, trades: 0 };
              cell.trades += 1;
              totalTrades += 1;
              if (isTradeWin(trade)) {
                cell.wins += 1;
                wins += 1;
              } else if (isTradeLoss(trade)) {
                cell.losses += 1;
                losses += 1;
              } else {
                breakevens += 1;
              }
              perDay.set(dateKey, cell);
            }
          }
        } else {
          // Live signals emitted & decided within the last 30 days
          const matched = signals.filter(
            (sig) =>
              sig.symbol === slot.symbol &&
              sig.entryTimeframe === slot.timeframe &&
              sig.strategyId === strat.id
          );

          let netR = 0;
          let grossWinR = 0;
          let grossLossR = 0;
          for (const sig of matched) {
            const isWin = WIN_SIGNAL_STATES.has(sig.state);
            const isLoss = LOSS_SIGNAL_STATES.has(sig.state);
            if (!isWin && !isLoss) continue;
            const tsMs = sig.closedAt ?? sig.createdAt;
            if (tsMs < nowMs - 30 * 86_400_000) continue;
            const dateKey = formatDateKeyInTz(tsMs, timezone);
            if (dateKey < windowStartKey) continue;

            const cell = perDay.get(dateKey) ?? { wins: 0, losses: 0, trades: 0 };
            cell.trades += 1;
            totalTrades += 1;
            if (isWin) {
              cell.wins += 1;
              wins += 1;
              grossWinR += Math.max(0.5, sig.realizedR ?? 1);
            } else {
              cell.losses += 1;
              losses += 1;
              grossLossR += Math.abs(sig.realizedR ?? -1);
            }
            netR += sig.realizedR ?? (isWin ? 1 : -1);
            perDay.set(dateKey, cell);
          }

          if (totalTrades > 0) {
            expectancyR = Number((netR / totalTrades).toFixed(2));
            profitFactor =
              grossLossR > 0
                ? Number((grossWinR / grossLossR).toFixed(2))
                : grossWinR > 0
                  ? 99.9
                  : null;
          }
        }

        const meta: StrategySeriesMeta = {
          rowKey,
          dataKey,
          slotKey,
          symbol: slot.symbol,
          timeframe: slot.timeframe,
          strategyId: strat.id,
          strategyName: strat.name,
          shortName: shortenStrategyName(strat.name, 20),
          color,
          totalTrades,
          wins,
          losses,
          breakevens,
          winRate: totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : null,
          profitFactor,
          netReturnPercent,
          expectancyR,
        };

        series.push(meta);
        seriesByRowKey.set(rowKey, meta);
        dailyStats.set(rowKey, perDay);
      }
    }

    // Build 30-day cumulative trend points
    const running = new Map<string, { wins: number; losses: number; trades: number }>();
    for (const s of series) {
      running.set(s.rowKey, { wins: 0, losses: 0, trades: 0 });
    }

    const points: TrendPoint[] = buckets.map((bucket) => {
      const point: TrendPoint = {
        dateKey: bucket.dateKey,
        label: bucket.label,
      };
      for (const s of series) {
        const dayCell = dailyStats.get(s.rowKey)?.get(bucket.dateKey);
        const acc = running.get(s.rowKey)!;
        if (dayCell) {
          acc.wins += dayCell.wins;
          acc.losses += dayCell.losses;
          acc.trades += dayCell.trades;
        }
        point[s.dataKey] =
          acc.trades > 0 ? Number(((acc.wins / acc.trades) * 100).toFixed(1)) : null;
        point[`${s.dataKey}__meta`] = {
          wins: acc.wins,
          losses: acc.losses,
          trades: acc.trades,
          dayWins: dayCell?.wins ?? 0,
          dayTrades: dayCell?.trades ?? 0,
        };
      }
      return point;
    });

    const bars: BarCompareDatum[] = [...series]
      .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.totalTrades - a.totalTrades)
      .map((s) => ({
        rowKey: s.rowKey,
        label:
          activeSlots.length > 1
            ? `${shortenStrategyName(s.strategyName, 16)} (${s.symbol})`
            : shortenStrategyName(s.strategyName, 18),
        fullName: s.strategyName,
        slotLabel: `${s.symbol} ${s.timeframe}`,
        winRate: s.winRate ?? 0,
        wins: s.wins,
        losses: s.losses,
        trades: s.totalTrades,
        profitFactor: s.profitFactor,
        netReturnPercent: s.netReturnPercent,
        color: s.color,
      }));

    return {
      dayBuckets: buckets,
      strategySeries: series,
      trendData: points,
      barData: bars,
      coverageNote: minCoverageLabel,
    };
  }, [activeSlots, slotResults, dataSource, signals, timezone]);

  const activeHighlightKey = focusedRowKey ?? selectedRowKey ?? null;
  const anyTradesIn30d = useMemo(
    () => strategySeries.some((s) => s.totalTrades > 0),
    [strategySeries]
  );

  const avg30dWinRate = useMemo(() => {
    const valid = strategySeries.filter((s) => s.winRate !== null);
    if (valid.length === 0) return null;
    const sum = valid.reduce((acc, s) => acc + (s.winRate ?? 0), 0);
    return Number((sum / valid.length).toFixed(1));
  }, [strategySeries]);

  const total30dTrades = useMemo(
    () => strategySeries.reduce((acc, s) => acc + s.totalTrades, 0),
    [strategySeries]
  );

  if (armedSlots.length === 0) {
    return null;
  }

  return (
    <section className="border border-[#222938] bg-[#12161F] p-4 space-y-3">
      {/* Header + Mode / Source / Slot Controls */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1D2432] pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-xs font-semibold text-[#E6EDF3]">
              30-Day Historical Win Rate Performance ({strategySeries.length}{' '}
              {strategySeries.length === 1 ? 'Strategy' : 'Strategies'})
            </h2>
            <span className="font-mono text-[11px] text-[#8B949E] tabular-nums">
              {dayBuckets[0]?.label} – {dayBuckets[dayBuckets.length - 1]?.label}
              {avg30dWinRate !== null ? ` · Avg ${avg30dWinRate}%` : ''}
              {total30dTrades > 0 ? ` · ${total30dTrades} Trades` : ''}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[#8B949E]">
            {chartMode === 'trend'
              ? 'Cumulative 30-day win rate trajectory per armed strategy. Click any legend entry to isolate its curve and inspect rules.'
              : 'Side-by-side 30-day win rate comparison across armed strategies. Click any bar to inspect the strategy below.'}
            {dataSource === 'historical' && coverageNote ? ` (${coverageNote} max bar window)` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {slotSignatures.length > 1 && (
            <select
              value={slotFilter}
              onChange={(e) => setSlotFilter(e.target.value)}
              aria-label="Filter 30-day chart by slot"
              className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] font-mono text-[#E6EDF3] focus:border-[#38BDF8] focus:outline-none whitespace-nowrap shrink-0"
            >
              <option value="ALL">All Slots ({slotSignatures.length})</option>
              {slotSignatures.map((entry) => (
                <option key={entry.slotKey} value={entry.slotKey}>
                  {entry.slot.symbol} {entry.slot.timeframe} ({entry.slot.strategies.length})
                </option>
              ))}
            </select>
          )}

          {/* Chart Mode Switch */}
          <div className="flex border border-[#222938] bg-[#0B0E14]">
            <button
              type="button"
              onClick={() => setChartMode('trend')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                chartMode === 'trend'
                  ? 'bg-[#1D2432] text-[#38BDF8]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              <LineChartIcon className="h-3 w-3" />
              <span>30d Trend</span>
            </button>
            <button
              type="button"
              onClick={() => setChartMode('compare')}
              className={`flex items-center gap-1 border-l border-[#222938] px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                chartMode === 'compare'
                  ? 'bg-[#1D2432] text-[#38BDF8]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              <BarChart3 className="h-3 w-3" />
              <span>Win Rate Bars</span>
            </button>
          </div>

          {/* Data Source Switch */}
          <div className="flex border border-[#222938] bg-[#0B0E14]">
            <button
              type="button"
              onClick={() => setDataSource('historical')}
              className={`px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                dataSource === 'historical'
                  ? 'bg-[#1D2432] text-[#0ECB81]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              Historical Backtest
            </button>
            <button
              type="button"
              onClick={() => setDataSource('live')}
              className={`border-l border-[#222938] px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                dataSource === 'live'
                  ? 'bg-[#1D2432] text-[#0ECB81]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              Live Emitted
            </button>
          </div>

          {dataSource === 'historical' && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void fetchHistorical30d(true)}
              className="flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Loading 30d...' : 'Refresh 30d'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Interactive Strategy Legend Strip */}
      {strategySeries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {focusedRowKey && (
            <button
              type="button"
              onClick={() => setFocusedRowKey(null)}
              className="border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2 py-1 text-[10px] font-medium text-[#38BDF8] hover:bg-[#38BDF8]/20 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Show All ({strategySeries.length})
            </button>
          )}
          {strategySeries.map((s) => {
            const isHighlighted = activeHighlightKey === s.rowKey;
            const isDimmed = activeHighlightKey !== null && !isHighlighted;
            return (
              <button
                key={s.rowKey}
                type="button"
                onClick={() => {
                  setFocusedRowKey((prev) => (prev === s.rowKey ? null : s.rowKey));
                  onSelectStrategyRow?.(s.rowKey);
                }}
                className={`flex items-center gap-1.5 border px-2 py-1 text-[10px] font-mono transition-opacity whitespace-nowrap shrink-0 cursor-pointer ${
                  isHighlighted
                    ? 'border-[#38BDF8] bg-[#161B26] text-[#E6EDF3]'
                    : 'border-[#1D2432] bg-[#0B0E14] text-[#C9D1D9] hover:border-[#2B3548]'
                } ${isDimmed ? 'opacity-45' : 'opacity-100'}`}
                title={`${s.strategyName} (${s.symbol} ${s.timeframe}) · ${s.wins}W / ${s.losses}L across ${s.totalTrades} trades`}
              >
                <span
                  className="inline-block h-2 w-2 shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                <span className="max-w-[140px] truncate">{s.strategyName}</span>
                {activeSlots.length > 1 && (
                  <span className="text-[#8B949E]">{s.symbol}</span>
                )}
                <span className="text-[#E6EDF3] tabular-nums font-semibold">
                  {s.winRate !== null ? `${s.winRate.toFixed(1)}%` : '—'}
                </span>
                <span className="text-[#8B949E] tabular-nums">({s.totalTrades})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Recharts Canvas Area */}
      <div className="border border-[#1D2432] bg-[#0B0E14] p-3">
        {loading && !anyTradesIn30d ? (
          <div className="flex h-[285px] flex-col items-center justify-center gap-2 text-center">
            <RefreshCw className="h-5 w-5 animate-spin text-[#38BDF8]" />
            <div className="font-mono text-xs text-[#C9D1D9]">
              Evaluating 30-day historical OHLCV trades across armed strategies...
            </div>
            <div className="text-[11px] text-[#8B949E]">
              Computing real daily cumulative win rates without altering saved backtest archives.
            </div>
          </div>
        ) : error && !anyTradesIn30d ? (
          <div className="flex h-[285px] flex-col items-center justify-center gap-2 text-center">
            <div className="text-xs font-semibold text-[#F6465D]">{error}</div>
            <button
              type="button"
              onClick={() => void fetchHistorical30d(true)}
              className="border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-medium text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
            >
              Retry 30d Evaluation
            </button>
          </div>
        ) : !anyTradesIn30d ? (
          <div className="flex h-[285px] flex-col items-center justify-center gap-2 text-center px-4">
            <div className="text-xs font-semibold text-[#E6EDF3]">
              {dataSource === 'live'
                ? 'No Closed Live Signals in the Last 30 Days'
                : 'No Historical Setups Triggered in the 30-Day Window'}
            </div>
            <p className="max-w-md text-[11px] text-[#8B949E]">
              {dataSource === 'live'
                ? 'Live emitted signals appear here once armed strategies trigger and reach TP or SL. Switch to Historical Backtest to inspect 30-day simulated performance.'
                : 'The armed strategies did not fire closed trades in the last 30 days on this timeframe. Try switching to another slot or discovering higher-frequency combinations.'}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {dataSource === 'live' && (
                <button
                  type="button"
                  onClick={() => setDataSource('historical')}
                  className="border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-medium text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer"
                >
                  View 30d Historical Backtest
                </button>
              )}
              {onOpenDiscovery && (
                <button
                  type="button"
                  onClick={onOpenDiscovery}
                  className="border border-[#222938] bg-[#12161F] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                >
                  Open Discovery Scanner
                </button>
              )}
            </div>
          </div>
        ) : chartMode === 'trend' ? (
          <div className="h-[290px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 10, right: 16, left: -12, bottom: 4 }}>
                <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#8B949E"
                  tick={{ fontSize: 10, fill: '#8B949E', fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={{ stroke: '#1D2432' }}
                  minTickGap={22}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  stroke="#8B949E"
                  tick={{ fontSize: 10, fill: '#8B949E', fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={{ stroke: '#1D2432' }}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <ReferenceLine
                  y={50}
                  stroke="#2B3548"
                  strokeDasharray="4 4"
                  label={{
                    value: '50%',
                    position: 'insideTopRight',
                    fill: '#6E7681',
                    fontSize: 10,
                    fontFamily: 'JetBrains Mono',
                  }}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const row = payload[0]?.payload as TrendPoint | undefined;
                    if (!row) return null;

                    const items = strategySeries
                      .map((s) => {
                        const val = row[s.dataKey];
                        const meta = row[`${s.dataKey}__meta`] as DayTradeMeta | undefined;
                        return {
                          metaSeries: s,
                          winRate: typeof val === 'number' ? val : null,
                          tradeMeta: meta,
                        };
                      })
                      .filter((item) => item.winRate !== null)
                      .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

                    if (items.length === 0) return null;

                    return (
                      <div className="min-w-[240px] max-w-[320px] border border-[#222938] bg-[#12161F] px-3 py-2 shadow-xl">
                        <div className="mb-1.5 flex items-center justify-between border-b border-[#1D2432] pb-1 font-mono text-[10px] text-[#8B949E]">
                          <span className="font-semibold text-[#E6EDF3]">{row.dateKey}</span>
                          <span>Cumulative 30d Win %</span>
                        </div>
                        <div className="space-y-1">
                          {items.map(({ metaSeries, winRate, tradeMeta }) => (
                            <div
                              key={metaSeries.rowKey}
                              className="flex items-center justify-between gap-3 font-mono text-[10px] tabular-nums"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                  className="inline-block h-2 w-2 shrink-0"
                                  style={{ backgroundColor: metaSeries.color }}
                                />
                                <span className="truncate text-[#C9D1D9]">
                                  {metaSeries.shortName}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-semibold text-[#E6EDF3]">
                                  {winRate?.toFixed(1)}%
                                </span>
                                <span className="text-[#8B949E]">
                                  {tradeMeta
                                    ? `${tradeMeta.wins}W/${tradeMeta.losses}L`
                                    : ''}
                                  {tradeMeta && tradeMeta.dayTrades > 0
                                    ? ` (+${tradeMeta.dayTrades})`
                                    : ''}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }}
                />
                {strategySeries.map((s) => {
                  const isHighlighted = activeHighlightKey === s.rowKey;
                  const isDimmed = activeHighlightKey !== null && !isHighlighted;
                  return (
                    <Line
                      key={s.rowKey}
                      type="monotone"
                      dataKey={s.dataKey}
                      name={s.strategyName}
                      stroke={s.color}
                      strokeWidth={isHighlighted ? 2.6 : 1.75}
                      strokeOpacity={isDimmed ? 0.18 : 0.95}
                      dot={false}
                      activeDot={{ r: 3.5, strokeWidth: 0, fill: s.color }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[290px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={barData}
                margin={{ top: 10, right: 16, left: -12, bottom: 26 }}
              >
                <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#8B949E"
                  tick={{ fontSize: 10, fill: '#8B949E', fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={{ stroke: '#1D2432' }}
                  interval={0}
                  angle={-18}
                  textAnchor="end"
                  height={48}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  stroke="#8B949E"
                  tick={{ fontSize: 10, fill: '#8B949E', fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={{ stroke: '#1D2432' }}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <ReferenceLine y={50} stroke="#2B3548" strokeDasharray="4 4" />
                <Tooltip
                  cursor={{ fill: '#161B26' }}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const datum = payload[0]?.payload as BarCompareDatum | undefined;
                    if (!datum) return null;
                    return (
                      <div className="border border-[#222938] bg-[#12161F] px-3 py-2 font-mono text-[11px] shadow-xl tabular-nums">
                        <div className="font-semibold text-[#E6EDF3]">{datum.fullName}</div>
                        <div className="text-[10px] text-[#8B949E] mb-1.5">{datum.slotLabel} · Last 30 Days</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                          <span className="text-[#8B949E]">30d Win Rate</span>
                          <span className="text-right font-semibold text-[#0ECB81]">
                            {datum.trades > 0 ? `${datum.winRate.toFixed(1)}%` : '—'}
                          </span>
                          <span className="text-[#8B949E]">Record</span>
                          <span className="text-right text-[#E6EDF3]">
                            {datum.wins}W / {datum.losses}L ({datum.trades}T)
                          </span>
                          <span className="text-[#8B949E]">Profit Factor</span>
                          <span className="text-right text-[#C9D1D9]">
                            {datum.profitFactor !== null ? datum.profitFactor.toFixed(2) : '—'}
                          </span>
                          {datum.netReturnPercent !== null && (
                            <>
                              <span className="text-[#8B949E]">Return</span>
                              <span
                                className={`text-right ${
                                  datum.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {datum.netReturnPercent >= 0 ? '+' : ''}
                                {datum.netReturnPercent.toFixed(2)}%
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar
                  dataKey="winRate"
                  radius={[2, 2, 0, 0]}
                  maxBarSize={42}
                  isAnimationActive={false}
                  onClick={(datum) => {
                    const rowKey = (datum as unknown as BarCompareDatum)?.rowKey;
                    if (rowKey) {
                      setFocusedRowKey((prev) => (prev === rowKey ? null : rowKey));
                      onSelectStrategyRow?.(rowKey);
                    }
                  }}
                >
                  {barData.map((entry) => {
                    const isHighlighted = activeHighlightKey === entry.rowKey;
                    const isDimmed = activeHighlightKey !== null && !isHighlighted;
                    return (
                      <Cell
                        key={entry.rowKey}
                        fill={entry.color}
                        fillOpacity={isDimmed ? 0.25 : 0.9}
                        stroke={isHighlighted ? '#E6EDF3' : 'none'}
                        strokeWidth={isHighlighted ? 1.5 : 0}
                        className="cursor-pointer"
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
