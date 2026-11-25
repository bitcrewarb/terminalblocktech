import {
  Activity,
  Layers,
  Pause,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { selectMatrixStrategies, type MatrixPreset } from '../../backtest/correlation.ts';
import type {
  BacktestRunResult,
  BacktestStrategyId,
  BacktestStrategyResult,
  BasketBacktestResult,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';

interface BasketPortfolioPanelProps {
  run: BacktestRunResult;
  onSelectStrategy: (id: BacktestStrategyId) => void;
  timezone: string;
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtCorr(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}`;
}

function BasketCurveTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; equity: number; drawdownPercent: number } }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl font-mono tabular-nums">
      <div className="mb-1 text-[10px] text-[#8B949E]">{d.label}</div>
      <div className="flex justify-between gap-4">
        <span className="text-[#8B949E]">Portfolio Equity:</span>
        <span className="text-[#0ECB81]">
          ${d.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-[#8B949E]">Drawdown:</span>
        <span className="text-[#F59E0B]">-{d.drawdownPercent.toFixed(2)}%</span>
      </div>
    </div>
  );
}

export function BasketPortfolioPanel({
  run,
  onSelectStrategy,
  timezone,
}: BasketPortfolioPanelProps) {
  const { liveStrategyBasket, updateLiveStrategyBasket, clearLiveStrategyBasket } = useTerminal();

  const activeStrategies = useMemo(
    () => run.strategies.filter((s) => s.metrics.totalTrades > 0),
    [run.strategies]
  );

  const strategyMap = useMemo(
    () =>
      new Map<BacktestStrategyId, BacktestStrategyResult>(
        run.strategies.map((s) => [s.strategy.id, s])
      ),
    [run.strategies]
  );

  const [basketIds, setBasketIds] = useState<BacktestStrategyId[]>([]);
  const [maxConcurrent, setMaxConcurrent] = useState<number>(4);
  const [maxHeatPct, setMaxHeatPct] = useState<number>(4.0);
  const [riskPerTradePct, setRiskPerTradePct] = useState<number>(run.config.riskPerTradePercent);
  const [addSelectId, setAddSelectId] = useState<string>('');

  const [simulating, setSimulating] = useState<boolean>(false);
  const [basketError, setBasketError] = useState<string | null>(null);
  const [basketResult, setBasketResult] = useState<BasketBacktestResult | null>(null);
  const [savingLive, setSavingLive] = useState<boolean>(false);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  // Auto-populate with Top 6 Uncorrelated Strategies whenever a new backtest run loads
  useEffect(() => {
    const initial = selectMatrixStrategies(
      'uncorrelated_basket',
      run.strategies,
      run.config.initialCapital,
      6
    ).map((s) => s.strategy.id);
    setBasketIds(
      initial.length > 0
        ? initial
        : run.strategies.slice(0, Math.min(6, run.strategies.length)).map((s) => s.strategy.id)
    );
    setRiskPerTradePct(run.config.riskPerTradePercent);
    setBasketResult(null);
    setBasketError(null);
  }, [run.id, run.strategies, run.config.initialCapital, run.config.riskPerTradePercent]);

  const applyPreset = (preset: MatrixPreset, count: number) => {
    const picked = selectMatrixStrategies(preset, run.strategies, run.config.initialCapital, count);
    if (picked.length > 0) {
      setBasketIds(picked.map((s) => s.strategy.id));
    }
  };

  const handleRemoveStrategy = (id: BacktestStrategyId) => {
    setBasketIds((prev) => (prev.length > 1 ? prev.filter((x) => x !== id) : prev));
  };

  const handleAddStrategy = () => {
    if (!addSelectId || basketIds.includes(addSelectId) || basketIds.length >= 20) return;
    setBasketIds((prev) => [...prev, addSelectId]);
    setAddSelectId('');
  };

  const handleSimulatePortfolio = async () => {
    if (basketIds.length === 0) return;
    setSimulating(true);
    setBasketError(null);
    try {
      const res = await apiFetch('/api/backtest/basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: run.config.symbol,
          timeframe: run.config.timeframe,
          htfTimeframe: run.config.htfTimeframe,
          bars: run.config.bars,
          initialCapital: run.config.initialCapital,
          riskPerTradePercent: riskPerTradePct,
          commissionBps: run.config.commissionBps,
          slippageBps: run.config.slippageBps,
          minRiskReward: run.config.minRiskReward,
          moveStopToBreakevenAfterTp1: run.config.moveStopToBreakevenAfterTp1,
          strategyIds: basketIds,
          maxConcurrentPositions: maxConcurrent,
          maxPortfolioHeatPercent: maxHeatPct,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Shared-capital simulation failed (${res.status})`);
      }
      const data = (await res.json()) as BasketBacktestResult;
      setBasketResult(data);
    } catch (err) {
      setBasketError(err instanceof Error ? err.message : 'Shared-capital simulation failed');
    } finally {
      setSimulating(false);
    }
  };

  const handlePromoteToLiveScanner = async () => {
    if (basketIds.length === 0) return;
    setSavingLive(true);
    setBasketError(null);
    setLiveNotice(null);
    try {
      const saved = await updateLiveStrategyBasket({
        enabled: true,
        symbol: run.config.symbol,
        timeframe: run.config.timeframe,
        htfTimeframe: run.config.htfTimeframe,
        strategyIds: basketIds,
        maxConcurrentPositions: maxConcurrent,
        minRiskReward: run.config.minRiskReward,
        sourceRunId: run.id,
      });
      if (saved) {
        setLiveNotice(
          `Live Scanner armed with ${saved.strategies.length} strategies on ${saved.symbol} ${saved.timeframe} (closed-bar evaluation).`
        );
      }
    } catch (err) {
      setBasketError(err instanceof Error ? err.message : 'Failed to arm live scanner');
    } finally {
      setSavingLive(false);
    }
  };

  const handleToggleLivePause = async () => {
    if (!liveStrategyBasket) return;
    setSavingLive(true);
    try {
      await updateLiveStrategyBasket({
        enabled: !liveStrategyBasket.enabled,
        symbol: liveStrategyBasket.symbol,
        timeframe: liveStrategyBasket.timeframe,
        htfTimeframe: liveStrategyBasket.htfTimeframe,
        strategyIds: liveStrategyBasket.strategies.map((s) => s.id),
        maxConcurrentPositions: liveStrategyBasket.maxConcurrentPositions,
        minRiskReward: liveStrategyBasket.minRiskReward,
        sourceRunId: liveStrategyBasket.sourceRunId,
      });
    } finally {
      setSavingLive(false);
    }
  };

  const availableToAdd = useMemo(
    () => activeStrategies.filter((s) => !basketIds.includes(s.strategy.id)).slice(0, 150),
    [activeStrategies, basketIds]
  );

  const chartData = useMemo(() => {
    if (!basketResult) return [];
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return basketResult.equityCurve.map((pt) => ({
      label: fmt.format(new Date(pt.time * 1000)),
      equity: pt.equity,
      drawdownPercent: pt.drawdownPercent,
    }));
  }, [basketResult, timezone]);

  const fmtTime = (sec: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(sec * 1000));

  const portfolioPositive = (basketResult?.metrics.netProfit ?? 0) >= 0;

  return (
    <div className="space-y-3 border-t border-[#222938] pt-3">
      {/* Header & Presets */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[#0ECB81]" />
          <div>
            <h4 className="text-xs font-semibold text-[#E6EDF3]">
              Shared-Capital Basket Simulator &amp; Live Scanner Auto-Run
            </h4>
            <p className="text-[11px] text-[#8B949E]">
              Simulate an uncorrelated basket in one shared ${run.config.initialCapital.toLocaleString('en-US')} capital pool with concurrent/heat caps, or auto-run on live closed bars
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => applyPreset('uncorrelated_basket', 6)}
            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[10px] text-[#0ECB81] hover:border-[#0ECB81] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Uncorrelated (6)
          </button>
          <button
            type="button"
            onClick={() => applyPreset('uncorrelated_basket', 10)}
            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[10px] text-[#0ECB81] hover:border-[#0ECB81] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Uncorrelated (10)
          </button>
          <button
            type="button"
            onClick={() => applyPreset('category_leaders', 5)}
            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[10px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Category Leaders (5)
          </button>
          <button
            type="button"
            onClick={() => applyPreset('top12', 6)}
            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[10px] text-[#8B949E] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Top 6 Ranked
          </button>
        </div>
      </div>

      {/* Live Auto-Run Active Status Banner */}
      {liveStrategyBasket && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs ${
            liveStrategyBasket.enabled
              ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10'
              : 'border-[#F59E0B]/50 bg-[#F59E0B]/10'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Radio
              className={`h-3.5 w-3.5 shrink-0 ${
                liveStrategyBasket.enabled ? 'text-[#0ECB81]' : 'text-[#F59E0B]'
              }`}
            />
            <div className="min-w-0">
              <div className="font-mono text-[11px] font-semibold text-[#E6EDF3] tabular-nums">
                LIVE BASKET {liveStrategyBasket.enabled ? 'ACTIVE' : 'PAUSED'} ·{' '}
                {liveStrategyBasket.symbol} {liveStrategyBasket.timeframe} (HTF{' '}
                {liveStrategyBasket.htfTimeframe}) · {liveStrategyBasket.strategies.length}{' '}
                strategies · Cap {liveStrategyBasket.maxConcurrentPositions} open ·{' '}
                {liveStrategyBasket.emittedSignalCount} signals emitted
              </div>
              {liveStrategyBasket.lastStatusNote && (
                <div className="truncate text-[10px] text-[#C9D1D9]">
                  {liveStrategyBasket.lastStatusNote}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={savingLive}
              onClick={() => void handleToggleLivePause()}
              className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#E6EDF3] hover:border-[#38BDF8] whitespace-nowrap cursor-pointer disabled:opacity-50"
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
              disabled={savingLive}
              onClick={() => void clearLiveStrategyBasket()}
              className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              <span>Stop &amp; Clear</span>
            </button>
          </div>
        </div>
      )}

      {/* Configuration & Strategy Basket Member Bar */}
      <div className="border border-[#222938] bg-[#12161F] p-3 space-y-3">
        {/* Selected Strategy Members */}
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-[#8B949E] tabular-nums">
              Selected Portfolio Basket ({basketIds.length}/20 strategies)
            </span>
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Add strategy to basket"
                value={addSelectId}
                onChange={(e) => setAddSelectId(e.target.value)}
                className="max-w-[260px] border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[11px] text-[#E6EDF3] outline-none"
              >
                <option value="">+ Add strategy to basket...</option>
                {availableToAdd.map((s) => (
                  <option key={s.strategy.id} value={s.strategy.id}>
                    #{s.rank} · {s.strategy.name} ({s.metrics.netReturnPercent >= 0 ? '+' : ''}
                    {s.metrics.netReturnPercent.toFixed(1)}%)
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!addSelectId || basketIds.length >= 20}
                onClick={handleAddStrategy}
                className="flex items-center gap-1 border border-[#222938] bg-[#161B26] px-2 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="h-3 w-3" />
                <span>Add</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {basketIds.map((id) => {
              const s = strategyMap.get(id);
              return (
                <div
                  key={id}
                  className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[11px]"
                >
                  <button
                    type="button"
                    onClick={() => onSelectStrategy(id)}
                    className="flex items-center gap-1.5 text-left hover:text-[#38BDF8] cursor-pointer"
                  >
                    <span className="font-mono text-[10px] text-[#38BDF8]">
                      #{s?.rank ?? '—'}
                    </span>
                    <span className="max-w-[190px] truncate text-[#E6EDF3]">
                      {s?.strategy.name ?? id}
                    </span>
                    <span className="font-mono text-[10px] text-[#8B949E]">
                      {s ? `${s.metrics.netReturnPercent >= 0 ? '+' : ''}${s.metrics.netReturnPercent.toFixed(1)}%` : ''}
                    </span>
                  </button>
                  {basketIds.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove ${s?.strategy.name ?? id}`}
                      onClick={() => handleRemoveStrategy(id)}
                      className="text-[#8B949E] hover:text-[#F6465D] cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Capital Rules & Action Controls */}
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[#1D2432] pt-2.5">
          <div className="grid grid-cols-3 gap-2.5">
            <label className="block">
              <span className="block text-[10px] text-[#8B949E]">Max Concurrent Trades</span>
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                value={maxConcurrent}
                onChange={(e) =>
                  setMaxConcurrent(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                }
                className="mt-1 w-28 border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-[#8B949E]">Max Portfolio Heat (%)</span>
              <input
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                value={maxHeatPct}
                onChange={(e) =>
                  setMaxHeatPct(Math.max(0.5, Math.min(50, Number(e.target.value) || 0.5)))
                }
                className="mt-1 w-28 border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-[#8B949E]">Risk / Trade (%)</span>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.25}
                value={riskPerTradePct}
                onChange={(e) =>
                  setRiskPerTradePct(Math.max(0.1, Math.min(10, Number(e.target.value) || 0.25)))
                }
                className="mt-1 w-28 border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={simulating || basketIds.length === 0}
              onClick={() => void handleSimulatePortfolio()}
              className="flex items-center gap-1.5 bg-[#38BDF8] px-3 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#7DD3FC] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Activity className={`h-3.5 w-3.5 ${simulating ? 'animate-spin' : ''}`} />
              <span>{simulating ? 'Simulating Pool...' : 'Simulate Shared Portfolio'}</span>
            </button>

            <button
              type="button"
              disabled={savingLive || basketIds.length === 0}
              onClick={() => void handlePromoteToLiveScanner()}
              className="flex items-center gap-1.5 border border-[#0ECB81] bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Radio className="h-3.5 w-3.5" />
              <span>{savingLive ? 'Arming...' : 'Auto-Run in Live Scanner'}</span>
            </button>
          </div>
        </div>

        {basketError && (
          <div className="border border-[#F6465D]/60 bg-[#F6465D]/10 px-2.5 py-1.5 text-xs text-[#F6465D]">
            {basketError}
          </div>
        )}
        {liveNotice && (
          <div className="border border-[#0ECB81]/60 bg-[#0ECB81]/10 px-2.5 py-1.5 text-xs text-[#0ECB81]">
            {liveNotice}
          </div>
        )}
      </div>

      {/* Simulation Results */}
      {basketResult && (
        <div className="space-y-3">
          {/* 5 Shared Portfolio KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] text-[#8B949E]">Shared Portfolio Net Profit</div>
              <div
                className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                  portfolioPositive ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                }`}
              >
                {fmtUsd(basketResult.metrics.netProfit)}{' '}
                <span className="text-xs font-normal">
                  ({basketResult.metrics.netReturnPercent >= 0 ? '+' : ''}
                  {basketResult.metrics.netReturnPercent.toFixed(2)}%)
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                End Equity: ${basketResult.metrics.endingEquity.toLocaleString('en-US')}
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="flex items-center justify-between text-[10px] text-[#8B949E]">
                <span>Shared Max Drawdown</span>
                <ShieldCheck className="h-3.5 w-3.5 text-[#0ECB81]" />
              </div>
              <div className="mt-1 font-mono text-base font-semibold text-[#F59E0B] tabular-nums">
                {basketResult.metrics.maxDrawdownPercent.toFixed(2)}%{' '}
                <span
                  className={`text-xs font-normal ${
                    basketResult.drawdownReductionPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                  }`}
                >
                  ({basketResult.drawdownReductionPercent >= 0 ? '-' : '+'}
                  {Math.abs(basketResult.drawdownReductionPercent).toFixed(1)}%)
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                vs {basketResult.standaloneAvgMaxDdPercent.toFixed(2)}% avg standalone DD
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] text-[#8B949E]">Portfolio PF / Sharpe</div>
              <div className="mt-1 font-mono text-base font-semibold text-[#38BDF8] tabular-nums">
                PF {basketResult.metrics.profitFactor ?? '—'}{' '}
                <span className="text-xs font-normal text-[#C9D1D9]">
                  · SR {basketResult.metrics.sharpeRatio.toFixed(2)}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                Win {basketResult.metrics.winRate.toFixed(1)}% · Exp{' '}
                {basketResult.metrics.expectancyR >= 0 ? '+' : ''}
                {basketResult.metrics.expectancyR.toFixed(2)}R
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] text-[#8B949E]">Executed vs Cap-Skipped</div>
              <div className="mt-1 font-mono text-base font-semibold text-[#E6EDF3] tabular-nums">
                {basketResult.totalTradesExecuted}{' '}
                <span className="text-xs font-normal text-[#8B949E]">
                  / {basketResult.totalSignalsGenerated} sigs
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                Skipped: {basketResult.skippedByConcurrentCap} slot ·{' '}
                {basketResult.skippedByHeatCap} heat
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] text-[#8B949E]">Basket Correlation &amp; Heat</div>
              <div className="mt-1 font-mono text-base font-semibold text-[#E6EDF3] tabular-nums">
                r = {fmtCorr(basketResult.avgPairwiseCorrelation)}{' '}
                <span className="text-xs font-normal text-[#8B949E]">avg</span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
                Peak {basketResult.peakConcurrentPositions} open ·{' '}
                {basketResult.peakPortfolioHeatPercent.toFixed(1)}% heat
              </div>
            </div>
          </div>

          {/* Row 1: Shared Equity Curve + Strategy Contribution Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h5 className="text-xs font-semibold text-[#E6EDF3]">
                    Shared-Capital Equity &amp; Drawdown Curve ({basketResult.config.symbol}{' '}
                    {basketResult.config.timeframe})
                  </h5>
                  <p className="font-mono text-[10px] text-[#8B949E] tabular-nums">
                    {basketResult.contributions.length} strategies · Cap{' '}
                    {basketResult.config.maxConcurrentPositions} open · Max Heat{' '}
                    {basketResult.config.maxPortfolioHeatPercent}% ·{' '}
                    {basketResult.durationMs}ms
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[10px] text-[#8B949E]">
                  <span className="flex items-center gap-1">
                    <span
                      className={`inline-block h-2 w-2 ${
                        portfolioPositive ? 'bg-[#0ECB81]' : 'bg-[#F6465D]'
                      }`}
                    />{' '}
                    Equity ($)
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 bg-[#F59E0B]" /> DD (%)
                  </span>
                </div>
              </div>

              <div className="h-[225px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 8, right: 10, left: 4, bottom: 2 }}
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
                      width={40}
                    />
                    <Tooltip content={<BasketCurveTooltip />} />
                    <ReferenceLine
                      yAxisId="eq"
                      y={basketResult.config.initialCapital}
                      stroke="#30363D"
                      strokeDasharray="3 3"
                    />
                    <Area
                      yAxisId="eq"
                      type="monotone"
                      dataKey="equity"
                      stroke={portfolioPositive ? '#0ECB81' : '#F6465D'}
                      strokeWidth={2}
                      fill={portfolioPositive ? '#0ECB81' : '#F6465D'}
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
            </div>

            {/* Per-Strategy Attribution Table */}
            <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
              <div className="mb-2">
                <h5 className="text-xs font-semibold text-[#E6EDF3]">
                  Per-Strategy Portfolio Attribution
                </h5>
                <p className="text-[10px] text-[#8B949E]">
                  Net contribution inside the shared pool &amp; trades filtered by portfolio caps
                </p>
              </div>

              <div className="max-h-[225px] overflow-auto">
                <table className="w-full text-left font-mono text-[11px] tabular-nums">
                  <thead className="sticky top-0 z-10 border-b border-[#222938] bg-[#12161F] text-[10px] text-[#8B949E]">
                    <tr>
                      <th className="py-1.5 pr-2">Strategy</th>
                      <th className="py-1.5 px-2 text-right">Trades</th>
                      <th className="py-1.5 px-2 text-right">Win %</th>
                      <th className="py-1.5 px-2 text-right">Net PnL</th>
                      <th className="py-1.5 px-2 text-right">Avg R</th>
                      <th className="py-1.5 pl-2 text-right">Cap Skip</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D2432]">
                    {basketResult.contributions.map((c) => {
                      const skipped = c.skippedByConcurrentCap + c.skippedByHeatCap;
                      return (
                        <tr key={c.strategy.id} className="hover:bg-[#161B26]">
                          <td className="max-w-[200px] py-1.5 pr-2 font-sans">
                            <button
                              type="button"
                              onClick={() => onSelectStrategy(c.strategy.id)}
                              className="block truncate font-medium text-[#E6EDF3] hover:text-[#38BDF8] cursor-pointer"
                            >
                              {c.strategy.name}
                            </button>
                            <div className="text-[10px] text-[#8B949E]">{c.strategy.category}</div>
                          </td>
                          <td className="px-2 py-1.5 text-right text-[#C9D1D9]">
                            {c.tradesExecuted}
                          </td>
                          <td className="px-2 py-1.5 text-right text-[#38BDF8]">
                            {c.winRate.toFixed(1)}%
                          </td>
                          <td
                            className={`px-2 py-1.5 text-right font-semibold ${
                              c.netPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                            }`}
                          >
                            {fmtUsd(c.netPnl)}
                          </td>
                          <td className="px-2 py-1.5 text-right text-[#C9D1D9]">
                            {c.avgR >= 0 ? '+' : ''}
                            {c.avgR.toFixed(2)}R
                          </td>
                          <td className="py-1.5 pl-2 text-right text-[#F59E0B]">{skipped}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Unified Chronological Basket Trade Ledger */}
          <div className="border border-[#222938] bg-[#12161F] p-3">
            <div className="mb-2 flex items-center justify-between">
              <h5 className="text-xs font-semibold text-[#E6EDF3]">
                Shared Portfolio Trade Ledger ({basketResult.trades.length} shown)
              </h5>
              <span className="font-mono text-[10px] text-[#8B949E] tabular-nums">
                Concurrent Open &amp; Heat % recorded at each entry
              </span>
            </div>

            <div className="max-h-[220px] overflow-auto">
              <table className="w-full text-left font-mono text-[11px] tabular-nums">
                <thead className="sticky top-0 z-10 border-b border-[#222938] bg-[#12161F] text-[10px] text-[#8B949E]">
                  <tr>
                    <th className="py-1.5 pr-2">#</th>
                    <th className="py-1.5 px-2">Strategy</th>
                    <th className="py-1.5 px-2">Side</th>
                    <th className="py-1.5 px-2">Entry → Exit</th>
                    <th className="py-1.5 px-2 text-right">Slots / Heat</th>
                    <th className="py-1.5 px-2 text-right">Net PnL</th>
                    <th className="py-1.5 px-2 text-right">R</th>
                    <th className="py-1.5 pl-2 text-right">Exit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1D2432]">
                  {basketResult.trades.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center font-sans text-xs text-[#8B949E]">
                        No trades executed inside this historical window.
                      </td>
                    </tr>
                  ) : (
                    basketResult.trades.slice(0, 100).map((t) => (
                      <tr key={t.id} className="hover:bg-[#161B26]">
                        <td className="py-1.5 pr-2 text-[#8B949E]">#{t.tradeNumber}</td>
                        <td className="max-w-[190px] truncate px-2 py-1.5 font-sans text-[#E6EDF3]">
                          {t.strategyName}
                        </td>
                        <td
                          className={`px-2 py-1.5 font-semibold ${
                            t.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {t.direction}
                        </td>
                        <td className="px-2 py-1.5 text-[#C9D1D9]">
                          {fmtTime(t.entryTime)} → {fmtTime(t.exitTime)}
                        </td>
                        <td className="px-2 py-1.5 text-right text-[#8B949E]">
                          {t.concurrentPositionsAtEntry} open · {t.portfolioHeatAtEntry.toFixed(1)}%
                        </td>
                        <td
                          className={`px-2 py-1.5 text-right font-semibold ${
                            t.netPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {fmtUsd(t.netPnl)}
                        </td>
                        <td
                          className={`px-2 py-1.5 text-right ${
                            t.realizedR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {t.realizedR >= 0 ? '+' : ''}
                          {t.realizedR.toFixed(2)}R
                        </td>
                        <td className="py-1.5 pl-2 text-right text-[#8B949E]">{t.exitReason}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
