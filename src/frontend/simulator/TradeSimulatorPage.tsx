import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Calculator,
  Compass,
  Crosshair,
  Download,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getInstrumentMeta, INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  BacktestRunResult,
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  DiscoveryRunSummary,
  DiscoveryScanRun,
  InstrumentSymbol,
  Timeframe,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import {
  buildRiskComparisonTiers,
  type PositionSizingMode,
  runDeterministicForwardProjection,
  simulateCapitalProjection,
} from './projection.ts';

type SimulatorTab = 'replay' | 'forward' | 'matrix';

const SIM_TIMEFRAMES: Timeframe[] = ['5m', '15m', '30m', '1H', '4H', '1D'];
const SIM_BAR_OPTIONS = [1000, 2500, 4000, 10000, 20000] as const;
const CAPITAL_PRESETS = [1000, 5000, 10000, 25000, 50000, 100000] as const;
const HORIZON_OPTIONS = [25, 50, 100, 200] as const;
const CATEGORIES: Array<'ALL' | BacktestStrategyCategory> = [
  'ALL',
  'SMC',
  'Price Action',
  'Chart Patterns',
  'Support & Resistance',
  'Hybrid SMC/PA',
];

function defaultHtfFor(tf: Timeframe): Timeframe {
  if (tf === '5m' || tf === '15m' || tf === '30m' || tf === '1H') return '4H';
  if (tf === '4H') return '1D';
  return '1W';
}

function fmtUsd(value: number, signed = false): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  });
  if (signed) {
    return `${value >= 0 ? '+$' : '-$'}${formatted}`;
  }
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

function fmtDateTime(sec: number, timezone: string): string {
  if (!sec) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(sec * 1000));
}

function formatExitLabel(reason: string): string {
  switch (reason) {
    case 'TP1':
    case 'TP1_FULL':
      return 'Hit Target 1';
    case 'TP2':
    case 'TP2_FULL':
      return 'Hit Target 2';
    case 'TP3':
    case 'TP3_FULL':
      return 'Hit Target 3';
    case 'SL':
    case 'STOP_LOSS':
      return 'Hit Stop Loss';
    case 'BREAKEVEN_STOP':
      return 'Breakeven Stop';
    case 'INVALIDATION':
      return 'Structure Break';
    case 'TIME_STOP':
      return 'Time Stop';
    case 'END_OF_DATA':
      return 'End of Data';
    default:
      return reason;
  }
}

export function TradeSimulatorPage({
  onBackToTerminal,
  onOpenDiscovery,
}: {
  onBackToTerminal: () => void;
  onOpenDiscovery: () => void;
}) {
  const { symbol, timeframe, timezone, selectSymbol, selectTimeframe, focusChartObject } =
    useTerminal();

  // Catalog & Discovery presets
  const [strategies, setStrategies] = useState<BacktestStrategyDefinition[]>([]);
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryRunSummary[]>([]);
  const [latestDiscoveryRun, setLatestDiscoveryRun] = useState<DiscoveryScanRun | null>(null);
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>('');

  // Instant Capital & Risk controls (no backend re-fetch needed when changed)
  const [capital, setCapital] = useState<number>(10000);
  const [riskPercent, setRiskPercent] = useState<number>(1.0);
  const [sizingMode, setSizingMode] = useState<PositionSizingMode>('compounding');
  const [horizonTrades, setHorizonTrades] = useState<number>(50);

  // Market & Strategy controls (triggers historical backtest fetch)
  const [simSymbol, setSimSymbol] = useState<InstrumentSymbol>(symbol);
  const [simTimeframe, setSimTimeframe] = useState<Timeframe>(
    SIM_TIMEFRAMES.includes(timeframe) ? timeframe : '15m'
  );
  const [simBars, setSimBars] = useState<number>(2500);
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | BacktestStrategyCategory>('ALL');
  const [strategyQuery, setStrategyQuery] = useState<string>('');
  const [selectedStrategyId, setSelectedStrategyId] = useState<BacktestStrategyId | ''>('');
  const [minRiskReward, setMinRiskReward] = useState<number>(1.5);
  const [commissionBps, setCommissionBps] = useState<number>(4);
  const [slippageBps, setSlippageBps] = useState<number>(2);

  // Active Simulation Data & View State
  const [activeTab, setActiveTab] = useState<SimulatorTab>('replay');
  const [running, setRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [backtestRun, setBacktestRun] = useState<BacktestRunResult | null>(null);
  const autoRanRef = useRef<boolean>(false);

  const runHistoricalSimulation = useCallback(
    async (opts?: {
      symbol?: InstrumentSymbol;
      timeframe?: Timeframe;
      bars?: number;
      strategyId?: BacktestStrategyId;
      minRR?: number;
      commBps?: number;
      slipBps?: number;
    }) => {
      const targetSymbol = opts?.symbol ?? simSymbol;
      const targetTf = opts?.timeframe ?? simTimeframe;
      const targetBars = opts?.bars ?? simBars;
      const targetStrategy = opts?.strategyId ?? selectedStrategyId;
      if (!targetStrategy) return;

      setRunning(true);
      setErrorMsg(null);
      try {
        const res = await apiFetch('/api/backtest/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: targetSymbol,
            timeframe: targetTf,
            htfTimeframe: defaultHtfFor(targetTf),
            bars: targetBars,
            initialCapital: 10000,
            riskPerTradePercent: 1.0,
            commissionBps: opts?.commBps ?? commissionBps,
            slippageBps: opts?.slipBps ?? slippageBps,
            minRiskReward: opts?.minRR ?? minRiskReward,
            moveStopToBreakevenAfterTp1: true,
            strategyIds: [targetStrategy],
            saveToArchive: false,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || `Simulation failed (${res.status})`);
        }
        const data = (await res.json()) as BacktestRunResult;
        setBacktestRun(data);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to run historical simulation');
      } finally {
        setRunning(false);
      }
    },
    [simSymbol, simTimeframe, simBars, selectedStrategyId, commissionBps, slippageBps, minRiskReward]
  );

  // Load strategy catalog + latest Discovery run presets on mount
  useEffect(() => {
    let active = true;
    const bootstrap = async () => {
      try {
        const [stratRes, discRes] = await Promise.all([
          apiFetch('/api/backtest/strategies'),
          apiFetch('/api/discovery/runs'),
        ]);
        if (!active) return;

        let loadedStrategies: BacktestStrategyDefinition[] = [];
        if (stratRes.ok) {
          const d = (await stratRes.json()) as { strategies: BacktestStrategyDefinition[] };
          loadedStrategies = d.strategies;
          setStrategies(loadedStrategies);
        }

        let initialStrategy: BacktestStrategyId | '' = loadedStrategies[0]?.id ?? '';
        let initialSym: InstrumentSymbol = symbol;
        let initialTf: Timeframe = SIM_TIMEFRAMES.includes(timeframe) ? timeframe : '15m';

        if (discRes.ok) {
          const r = (await discRes.json()) as { runs: DiscoveryRunSummary[] };
          setDiscoveryRuns(r.runs);
          if (r.runs.length > 0) {
            const latestRes = await apiFetch(`/api/discovery/runs/${encodeURIComponent(r.runs[0].id)}`);
            if (active && latestRes.ok) {
              const latest = (await latestRes.json()) as DiscoveryScanRun;
              setLatestDiscoveryRun(latest);
              const bestWinner =
                latest.combinations.find((c) => c.validationStatus === 'Validated') ??
                latest.combinations[0];
              if (bestWinner) {
                initialStrategy = bestWinner.strategy.id;
                initialSym = bestWinner.symbol;
                initialTf = bestWinner.timeframe;
                setSelectedPresetKey(bestWinner.comboKey);
                setSimSymbol(bestWinner.symbol);
                setSimTimeframe(bestWinner.timeframe);
              }
            }
          }
        }

        if (active && initialStrategy) {
          setSelectedStrategyId(initialStrategy);
          if (!autoRanRef.current) {
            autoRanRef.current = true;
            void runHistoricalSimulation({
              symbol: initialSym,
              timeframe: initialTf,
              bars: 2500,
              strategyId: initialStrategy,
            });
          }
        }
      } catch {
        // Non-fatal bootstrap error handled gracefully
      }
    };
    void bootstrap();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredStrategies = useMemo(() => {
    const q = strategyQuery.trim().toLowerCase();
    return strategies.filter((s) => {
      if (selectedCategory !== 'ALL' && s.category !== selectedCategory) return false;
      if (
        q &&
        !s.name.toLowerCase().includes(q) &&
        !s.id.toLowerCase().includes(q) &&
        !s.summary.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [strategies, selectedCategory, strategyQuery]);

  // Keep selectedStrategyId valid when category/search changes
  useEffect(() => {
    if (
      filteredStrategies.length > 0 &&
      selectedStrategyId &&
      !filteredStrategies.some((s) => s.id === selectedStrategyId)
    ) {
      setSelectedStrategyId(filteredStrategies[0].id);
    }
  }, [filteredStrategies, selectedStrategyId]);

  const activeStrategyDef = useMemo(
    () => strategies.find((s) => s.id === selectedStrategyId) ?? null,
    [strategies, selectedStrategyId]
  );

  // Deduplicated top verified presets from latest Discovery run
  const discoveryWinnerPresets = useMemo(() => {
    if (!latestDiscoveryRun) return [];
    const seen = new Set<string>();
    const out = [];
    for (const c of latestDiscoveryRun.combinations) {
      const k = `${c.strategy.id}::${c.symbol}::${c.timeframe}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
      if (out.length >= 16) break;
    }
    return out;
  }, [latestDiscoveryRun]);

  const handlePickDiscoveryPreset = (comboKey: string) => {
    setSelectedPresetKey(comboKey);
    const match = latestDiscoveryRun?.combinations.find((c) => c.comboKey === comboKey);
    if (!match) return;
    setSelectedCategory('ALL');
    setStrategyQuery('');
    setSimSymbol(match.symbol);
    setSimTimeframe(match.timeframe);
    setSelectedStrategyId(match.strategy.id);
    void runHistoricalSimulation({
      symbol: match.symbol,
      timeframe: match.timeframe,
      bars: Math.max(simBars, Math.min(20000, latestDiscoveryRun?.config.barsPerTimeframe ?? simBars)),
      strategyId: match.strategy.id,
    });
  };

  // Real historical trades for the simulated strategy
  const strategyResult = useMemo(() => {
    if (!backtestRun) return null;
    return (
      backtestRun.strategies.find((s) => s.strategy.id === selectedStrategyId) ??
      backtestRun.strategies[0] ??
      null
    );
  }, [backtestRun, selectedStrategyId]);

  const historicalTrades = useMemo(
    () => strategyResult?.trades ?? [],
    [strategyResult]
  );

  // Instant deterministic capital & risk projection
  const projection = useMemo(
    () =>
      simulateCapitalProjection(historicalTrades, {
        initialCapital: capital,
        riskPerTradePercent: riskPercent,
        sizingMode,
      }),
    [historicalTrades, capital, riskPercent, sizingMode]
  );

  // Instant risk scaling comparison table
  const riskComparison = useMemo(
    () => buildRiskComparisonTiers(historicalTrades, capital, sizingMode),
    [historicalTrades, capital, sizingMode]
  );

  // Instant deterministic forward sequence-risk projection
  const forwardProjection = useMemo(
    () =>
      runDeterministicForwardProjection(historicalTrades, {
        initialCapital: capital,
        riskPerTradePercent: riskPercent,
        sizingMode,
        horizonTrades,
        strategyId: selectedStrategyId || 'default',
        paths: 250,
      }),
    [historicalTrades, capital, riskPercent, sizingMode, horizonTrades, selectedStrategyId]
  );

  const handleExportCsv = () => {
    if (projection.rows.length === 0) return;
    const escapeCsv = (val: string | number) => {
      const s = String(val);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = [
      'Trade #',
      'Entry Time',
      'Exit Time',
      'Direction',
      'Entry Price',
      'Exit Price',
      'Exit Reason',
      'Result (R)',
      'Dollar Risk',
      'Dollar P&L',
      'Balance After',
      'Drawdown %',
    ];
    const rows = projection.rows.map((r) => [
      r.index,
      fmtDateTime(r.trade.entryTime, timezone),
      fmtDateTime(r.trade.exitTime, timezone),
      r.trade.direction,
      r.trade.entryPrice,
      r.trade.exitPrice,
      formatExitLabel(r.trade.exitReason),
      r.trade.realizedR,
      r.riskUsd,
      r.pnlUsd,
      r.balanceAfter,
      r.drawdownPercent,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-simulator-${simSymbol}-${simTimeframe}-${selectedStrategyId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleJumpToChart = (signalTime: number, exitTime: number, tradeId: string) => {
    selectSymbol(simSymbol);
    selectTimeframe(simTimeframe);
    focusChartObject(tradeId, signalTime, exitTime);
    onBackToTerminal();
  };

  const symMeta = getInstrumentMeta(simSymbol);
  const liveRiskUsd = (capital * riskPercent) / 100;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-[#0B0E14] text-[#E6EDF3]">
      {/* Page Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#222938] bg-[#12161F] px-5 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Calculator className="h-4 w-4 text-[#38BDF8] shrink-0" />
            <h1 className="text-sm font-bold tracking-tight text-[#E6EDF3]">
              Interactive Trade Simulator
            </h1>
            <span className="text-[#30363D]" aria-hidden="true">
              ·
            </span>
            <span className="text-xs text-[#8B949E]">
              Enter your starting capital, risk per trade, and strategy to project real historical outcomes
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenDiscovery}
            className="inline-flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Compass className="h-3.5 w-3.5 text-[#38BDF8]" />
            <span>Open Discovery Scanner</span>
          </button>
          <button
            type="button"
            onClick={onBackToTerminal}
            className="border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Back to Live Terminal
          </button>
        </div>
      </div>

      {/* Main 2-Column Workspace */}
      <div className="flex flex-1 flex-col lg:flex-row min-h-0">
        {/* Left Configuration Column (340px on desktop) */}
        <aside className="w-full lg:w-[340px] xl:w-[360px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#222938] bg-[#12161F] p-4 space-y-5 overflow-y-auto">
          {/* Quick Preset from Saved Discovery Winners */}
          {discoveryWinnerPresets.length > 0 && (
            <div className="space-y-1.5 pb-4 border-b border-[#222938]">
              <label
                htmlFor="sim-discovery-preset"
                className="block text-xs font-semibold text-[#38BDF8]"
              >
                Load Verified Winner from Discovery ({discoveryRuns.length} saved scans)
              </label>
              <select
                id="sim-discovery-preset"
                value={selectedPresetKey}
                onChange={(e) => {
                  if (e.target.value) handlePickDiscoveryPreset(e.target.value);
                }}
                className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-2 text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              >
                <option value="">Choose a Discovery setup...</option>
                {discoveryWinnerPresets.map((c) => (
                  <option key={c.comboKey} value={c.comboKey}>
                    {c.symbol} {c.timeframe} · {c.strategy.name} ({c.regime})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Section 1: Your Capital & Risk (Updates Live Instantly) */}
          <div className="space-y-4 pb-4 border-b border-[#222938]">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-[#E6EDF3]">
                1. Your Capital & Risk Sizing
              </h2>
              <span className="text-[11px] text-[#0ECB81]">Updates instantly</span>
            </div>

            {/* Starting Capital */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-capital" className="text-[#8B949E]">
                  Starting Capital ($)
                </label>
                <span className="font-mono text-xs font-semibold tabular-nums text-[#E6EDF3]">
                  {fmtUsd(capital)}
                </span>
              </div>
              <input
                id="sim-capital"
                type="number"
                min={100}
                max={100000000}
                step={500}
                value={capital}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setCapital(Math.max(100, v));
                }}
                className="w-full border border-[#222938] bg-[#0B0E14] px-3 py-2 font-mono text-sm font-semibold tabular-nums text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              />
              <div className="grid grid-cols-3 gap-1.5">
                {CAPITAL_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setCapital(preset)}
                    className={`border px-2 py-1 font-mono text-[11px] tabular-nums whitespace-nowrap cursor-pointer transition-colors ${
                      capital === preset
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    ${preset >= 1000 ? `${preset / 1000}K` : preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Risk Per Trade (%) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-risk-pct" className="text-[#8B949E]">
                  Risk Per Trade (%)
                </label>
                <span className="font-mono text-xs font-semibold tabular-nums text-[#38BDF8]">
                  {riskPercent.toFixed(2)}% ({fmtUsd(liveRiskUsd)} / trade)
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  aria-label="Risk Per Trade Slider"
                  min={0.25}
                  max={5.0}
                  step={0.25}
                  value={Math.min(5, riskPercent)}
                  onChange={(e) => setRiskPercent(Number(e.target.value))}
                  className="flex-1 accent-[#38BDF8] cursor-pointer"
                />
                <input
                  id="sim-risk-pct"
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={riskPercent}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setRiskPercent(Math.min(10, Math.max(0.1, v)));
                  }}
                  className="w-16 border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-right tabular-nums text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                />
              </div>
              <div className="grid grid-cols-5 gap-1">
                {[0.5, 1.0, 1.5, 2.0, 3.0].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRiskPercent(r)}
                    className={`border px-1.5 py-1 font-mono text-[11px] tabular-nums cursor-pointer ${
                      Math.abs(riskPercent - r) < 0.01
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    {r}%
                  </button>
                ))}
              </div>
            </div>

            {/* Position Sizing Mode */}
            <div className="space-y-1.5">
              <div className="text-xs text-[#8B949E]">Position Sizing Rule</div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setSizingMode('compounding')}
                  className={`border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                    sizingMode === 'compounding'
                      ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                      : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                  }`}
                >
                  Compounding %
                </button>
                <button
                  type="button"
                  onClick={() => setSizingMode('fixed_risk')}
                  className={`border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                    sizingMode === 'fixed_risk'
                      ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                      : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                  }`}
                >
                  Fixed $ Risk
                </button>
              </div>
              <p className="text-[11px] text-[#8B949E] leading-snug">
                {sizingMode === 'compounding'
                  ? `Scales risk to ${riskPercent}% of your updated account balance after every closed trade.`
                  : `Risks a fixed ${fmtUsd(liveRiskUsd)} on every trade regardless of account growth.`}
              </p>
            </div>

            {/* Forward Projection Horizon */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#8B949E]">Forward Projection Horizon</span>
                <span className="font-mono text-[#E6EDF3] tabular-nums">{horizonTrades} trades</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {HORIZON_OPTIONS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setHorizonTrades(h)}
                    className={`border px-2 py-1 font-mono text-[11px] tabular-nums cursor-pointer ${
                      horizonTrades === h
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    {h}t
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section 2: Market & Preferred Strategy */}
          <div className="space-y-3.5">
            <h2 className="text-xs font-semibold text-[#E6EDF3]">
              2. Preferred Strategy & Market History
            </h2>

            {/* Instrument */}
            <div className="space-y-1.5">
              <div className="text-xs text-[#8B949E]">Trading Instrument</div>
              <div className="grid grid-cols-4 gap-1">
                {INSTRUMENTS.map((inst) => (
                  <button
                    key={inst.symbol}
                    type="button"
                    onClick={() => {
                      setSimSymbol(inst.symbol);
                      setSelectedPresetKey('');
                    }}
                    className={`border px-2 py-1.5 font-mono text-[11px] font-semibold cursor-pointer ${
                      simSymbol === inst.symbol
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    {inst.symbol}
                  </button>
                ))}
              </div>
            </div>

            {/* Timeframe & Past Candles */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <label htmlFor="sim-tf" className="block text-xs text-[#8B949E]">
                  Chart Timeframe
                </label>
                <select
                  id="sim-tf"
                  value={simTimeframe}
                  onChange={(e) => {
                    setSimTimeframe(e.target.value as Timeframe);
                    setSelectedPresetKey('');
                  }}
                  className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                >
                  {SIM_TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf} (HTF {defaultHtfFor(tf)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="sim-bars" className="block text-xs text-[#8B949E]">
                  Past Candles
                </label>
                <select
                  id="sim-bars"
                  value={simBars}
                  onChange={(e) => setSimBars(Number(e.target.value))}
                  className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 font-mono text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                >
                  {SIM_BAR_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {b.toLocaleString()} candles
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Strategy Category + Search + Select */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#8B949E]">Preferred Strategy</span>
                <span className="font-mono text-[11px] text-[#8B949E] tabular-nums">
                  {filteredStrategies.length} available
                </span>
              </div>

              <select
                aria-label="Filter by Strategy Category"
                value={selectedCategory}
                onChange={(e) =>
                  setSelectedCategory(e.target.value as 'ALL' | BacktestStrategyCategory)
                }
                className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#C9D1D9] outline-none focus:border-[#38BDF8]"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c === 'ALL' ? 'All Strategy Categories' : c}
                  </option>
                ))}
              </select>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8B949E]" />
                <input
                  type="text"
                  value={strategyQuery}
                  onChange={(e) => setStrategyQuery(e.target.value)}
                  placeholder="Search SMC, ICT, Pattern..."
                  className="w-full border border-[#222938] bg-[#0B0E14] pl-8 pr-2.5 py-1.5 text-xs text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                />
              </div>

              <select
                aria-label="Preferred Strategy"
                value={selectedStrategyId}
                onChange={(e) => {
                  setSelectedStrategyId(e.target.value as BacktestStrategyId);
                  setSelectedPresetKey('');
                }}
                className="w-full border border-[#222938] bg-[#0B0E14] px-2.5 py-2 text-xs font-medium text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
              >
                {filteredStrategies.slice(0, 250).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.category})
                  </option>
                ))}
                {filteredStrategies.length === 0 && (
                  <option value="">No matching strategies</option>
                )}
              </select>

              {activeStrategyDef && (
                <p className="text-[11px] leading-snug text-[#8B949E]">
                  {activeStrategyDef.summary}
                </p>
              )}
            </div>

            {/* Min R:R, Fees, Slippage */}
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <label htmlFor="sim-rr" className="block text-[11px] text-[#8B949E]">
                  Min R:R
                </label>
                <input
                  id="sim-rr"
                  type="number"
                  min={1.0}
                  max={5.0}
                  step={0.1}
                  value={minRiskReward}
                  onChange={(e) => setMinRiskReward(Number(e.target.value) || 1.5)}
                  className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs tabular-nums text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="sim-comm" className="block text-[11px] text-[#8B949E]">
                  Fees (bps)
                </label>
                <input
                  id="sim-comm"
                  type="number"
                  min={0}
                  max={50}
                  value={commissionBps}
                  onChange={(e) => setCommissionBps(Number(e.target.value) || 0)}
                  className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs tabular-nums text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="sim-slip" className="block text-[11px] text-[#8B949E]">
                  Slip (bps)
                </label>
                <input
                  id="sim-slip"
                  type="number"
                  min={0}
                  max={50}
                  value={slippageBps}
                  onChange={(e) => setSlippageBps(Number(e.target.value) || 0)}
                  className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs tabular-nums text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={running || !selectedStrategyId}
              onClick={() => void runHistoricalSimulation()}
              className="flex w-full items-center justify-center gap-2 border border-[#0ECB81] bg-[#0ECB81]/15 px-4 py-2 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 disabled:opacity-50 cursor-pointer"
            >
              {running ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Simulating Historical Data...</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  <span>Run Historical Simulation</span>
                </>
              )}
            </button>
          </div>
        </aside>

        {/* Right Outcome Projection Workspace */}
        <main className="flex-1 min-w-0 p-5 space-y-5 overflow-y-auto">
          {errorMsg && (
            <div className="flex items-center justify-between gap-3 border border-[#F6465D]/50 bg-[#12161F] px-4 py-3 text-xs text-[#F6465D]">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <button
                type="button"
                onClick={() => void runHistoricalSimulation()}
                className="border border-[#F6465D]/60 px-2.5 py-1 text-xs font-medium text-[#E6EDF3] hover:text-white cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {/* Top Simulation Context Bar (Unboxed metadata, zero pills) */}
          {backtestRun && strategyResult && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] pb-3">
              <div className="space-y-1">
                <div className="text-base font-bold text-[#E6EDF3]">
                  {strategyResult.strategy.name}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B949E]">
                  <span className="font-mono text-[#38BDF8]">{backtestRun.config.symbol}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{backtestRun.config.timeframe}</span>
                  <span aria-hidden="true">·</span>
                  <span>{strategyResult.strategy.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {backtestRun.dataRange.totalBars.toLocaleString()} historical candles
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{backtestRun.dataRange.provider}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {fmtDateTime(backtestRun.dataRange.startTime, timezone)} to{' '}
                    {fmtDateTime(backtestRun.dataRange.endTime, timezone)}
                  </span>
                </div>
              </div>

              <button
                type="button"
                disabled={projection.rows.length === 0}
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 border border-[#222938] bg-[#12161F] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download CSV ({projection.totalTrades} trades)</span>
              </button>
            </div>
          )}

          {/* Loading Skeleton */}
          {running && !backtestRun && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-24 border border-[#222938] bg-[#12161F] animate-pulse"
                  />
                ))}
              </div>
              <div className="h-72 border border-[#222938] bg-[#12161F] animate-pulse" />
            </div>
          )}

          {/* Empty Trade Sample State */}
          {!running && backtestRun && projection.totalTrades === 0 && (
            <div className="border border-[#222938] bg-[#12161F] p-8 text-center space-y-3">
              <div className="text-sm font-semibold text-[#E6EDF3]">
                No trades triggered for {activeStrategyDef?.name ?? selectedStrategyId} on{' '}
                {backtestRun.config.symbol} ({backtestRun.config.timeframe})
              </div>
              <p className="mx-auto max-w-xl text-xs text-[#8B949E]">
                In the last {backtestRun.dataRange.totalBars.toLocaleString()} candles with Min{' '}
                {minRiskReward.toFixed(1)} R:R, this strategy did not find qualifying setups. Try
                increasing Past Candles to 4,000–20,000, switching timeframe, or picking a Discovery
                winner above.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSimBars(10000);
                    void runHistoricalSimulation({ bars: 10000 });
                  }}
                  className="border border-[#38BDF8] bg-[#161B26] px-4 py-2 text-xs font-semibold text-[#38BDF8] hover:text-white cursor-pointer"
                >
                  Simulate with 10,000 Candles
                </button>
              </div>
            </div>
          )}

          {/* Populated Outcome Dashboard */}
          {backtestRun && projection.totalTrades > 0 && (
            <>
              {/* 4 Projected Outcome KPI Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="text-xs text-[#8B949E]">Projected Ending Balance</div>
                  <div
                    className={`mt-1.5 font-mono text-xl font-bold tabular-nums ${
                      projection.netProfitUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {fmtUsd(projection.endingCapital)}
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-[#C9D1D9]">
                    <span
                      className={
                        projection.netProfitUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                      }
                    >
                      {fmtUsd(projection.netProfitUsd, true)} (
                      {projection.netReturnPercent >= 0 ? '+' : ''}
                      {projection.netReturnPercent.toFixed(1)}%)
                    </span>{' '}
                    from {fmtUsd(projection.initialCapital)}
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="text-xs text-[#8B949E]">Risk : Reward & Avg Trade</div>
                  <div className="mt-1.5 font-mono text-xl font-bold tabular-nums text-[#38BDF8]">
                    {projection.losses === 0 && projection.wins > 0
                      ? `1 : ${projection.avgWinR.toFixed(1)}`
                      : `1 : ${projection.rewardToRiskRatio.toFixed(2)}`}
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-[#C9D1D9]">
                    Avg{' '}
                    <span
                      className={
                        projection.avgDollarPerTrade >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                      }
                    >
                      {fmtUsd(projection.avgDollarPerTrade, true)}
                    </span>{' '}
                    ({projection.expectancyR >= 0 ? '+' : ''}
                    {projection.expectancyR.toFixed(2)}R / trade)
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="text-xs text-[#8B949E]">Win Rate & Trade Breakdown</div>
                  <div className="mt-1.5 font-mono text-xl font-bold tabular-nums text-[#E6EDF3]">
                    {projection.winRatePercent.toFixed(1)}%
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-[#8B949E]">
                    {projection.wins}W / {projection.losses}L ({projection.totalTrades} trades) · PF{' '}
                    <span className="text-[#E6EDF3]">
                      {projection.profitFactor !== null
                        ? `${projection.profitFactor.toFixed(2)}×`
                        : '—'}
                    </span>
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#12161F] p-4">
                  <div className="text-xs text-[#8B949E]">Worst Historical Dip (Max Drawdown)</div>
                  <div className="mt-1.5 font-mono text-xl font-bold tabular-nums text-[#F6465D]">
                    -{fmtUsd(projection.maxDrawdownUsd)} ({projection.maxDrawdownPercent.toFixed(1)}%)
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-[#8B949E]">
                    Worst loss streak: {projection.maxLossStreak} · 10-loss cost:{' '}
                    <span className="text-[#F59E0B]">-{fmtUsd(projection.tenLossStreakUsd)}</span>
                  </div>
                </div>
              </div>

              {/* View Mode Tabs */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-[#222938] bg-[#12161F] px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActiveTab('replay')}
                    className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      activeTab === 'replay'
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    <TrendingUp className="h-3.5 w-3.5" />
                    <span>1. Historical Replay Curve</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('forward')}
                    className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      activeTab === 'forward'
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    <Activity className="h-3.5 w-3.5" />
                    <span>2. Next {horizonTrades}-Trade Projection</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('matrix')}
                    className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      activeTab === 'matrix'
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    <span>3. Risk % Scaling & Trade Log</span>
                  </button>
                </div>

                <div className="font-mono text-[11px] text-[#8B949E] tabular-nums">
                  {sizingMode === 'compounding' ? 'Compounding' : 'Fixed'} {riskPercent.toFixed(2)}%
                  risk · Start {fmtUsd(capital)}
                </div>
              </div>

              {/* TAB 1: HISTORICAL REPLAY CURVE */}
              {activeTab === 'replay' && (
                <div className="space-y-4">
                  <div className="border border-[#222938] bg-[#12161F] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold text-[#E6EDF3]">
                          Simulated Account Balance Over {projection.totalTrades} Historical Trades
                        </h3>
                        <p className="text-[11px] text-[#8B949E]">
                          Replays every historical trade with {riskPercent.toFixed(2)}%{' '}
                          {sizingMode === 'compounding' ? 'compounding' : 'fixed'} risk after fees
                          & slippage.
                        </p>
                      </div>
                      <div className="font-mono text-xs tabular-nums text-[#C9D1D9]">
                        Peak Balance:{' '}
                        <strong className="text-[#0ECB81]">{fmtUsd(projection.peakBalance)}</strong>
                      </div>
                    </div>

                    <div className="h-72 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={projection.curve}>
                          <defs>
                            <linearGradient id="simEqFill" x1="0" y1="0" x2="0" y2="1">
                              <stop
                                offset="0%"
                                stopColor={projection.netProfitUsd >= 0 ? '#0ECB81' : '#F6465D'}
                                stopOpacity={0.28}
                              />
                              <stop
                                offset="100%"
                                stopColor={projection.netProfitUsd >= 0 ? '#0ECB81' : '#F6465D'}
                                stopOpacity={0.02}
                              />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            minTickGap={24}
                          />
                          <YAxis
                            domain={['auto', 'auto']}
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            width={70}
                            tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
                          />
                          <ReferenceLine
                            y={projection.initialCapital}
                            stroke="#3B475E"
                            strokeDasharray="4 4"
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0B0E14',
                              borderColor: '#38BDF8',
                              fontSize: '11px',
                            }}
                            formatter={(val: unknown, name: unknown) => [
                              name === 'balance'
                                ? fmtUsd(Number(val))
                                : `-${Number(val).toFixed(2)}%`,
                              name === 'balance' ? 'Account Balance' : 'Drawdown',
                            ]}
                            labelFormatter={(label, payload) => {
                              const pt = payload?.[0]?.payload as
                                | { time?: number; realizedR?: number; pnlUsd?: number }
                                | undefined;
                              if (!pt || label === 'Start') return 'Starting Capital';
                              return `Trade ${String(label)} · ${fmtDateTime(pt.time ?? 0, timezone)} · ${fmtUsd(pt.pnlUsd ?? 0, true)} (${(pt.realizedR ?? 0) >= 0 ? '+' : ''}${pt.realizedR ?? 0}R)`;
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey="balance"
                            stroke={projection.netProfitUsd >= 0 ? '#0ECB81' : '#F6465D'}
                            strokeWidth={2}
                            fill="url(#simEqFill)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Drawdown Sub-Chart */}
                  <div className="border border-[#222938] bg-[#12161F] p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-[#E6EDF3]">
                        Account Dip % From Peak (Drawdown Trajectory)
                      </h3>
                      <span className="font-mono text-xs tabular-nums text-[#F6465D]">
                        Max Dip: -{projection.maxDrawdownPercent.toFixed(2)}%
                      </span>
                    </div>
                    <div className="h-36 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={projection.curve}>
                          <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            minTickGap={24}
                          />
                          <YAxis
                            reversed
                            domain={[0, 'auto']}
                            tick={{ fill: '#F6465D', fontSize: 10 }}
                            width={54}
                            tickFormatter={(v: number) => `-${v.toFixed(1)}%`}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0B0E14',
                              borderColor: '#F6465D',
                              fontSize: '11px',
                            }}
                            formatter={(val: unknown) => [
                              `-${Number(val).toFixed(2)}%`,
                              'Drawdown From Peak',
                            ]}
                          />
                          <Area
                            type="monotone"
                            dataKey="drawdownPercent"
                            stroke="#F6465D"
                            strokeWidth={1.5}
                            fill="#F6465D"
                            fillOpacity={0.2}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: FORWARD NEXT-N-TRADE PROJECTION */}
              {activeTab === 'forward' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <div className="border border-[#222938] bg-[#12161F] p-3.5">
                      <div className="text-xs text-[#8B949E]">Conservative Outcome (25th Pct)</div>
                      <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#C9D1D9]">
                        {fmtUsd(forwardProjection.conservativeCapitalP25)}
                      </div>
                      <div className="text-[11px] text-[#8B949E]">
                        75% of simulated trade sequences finish above this
                      </div>
                    </div>

                    <div className="border border-[#222938] bg-[#12161F] p-3.5">
                      <div className="text-xs text-[#38BDF8]">Expected Median (50th Pct)</div>
                      <div
                        className={`mt-1 font-mono text-base font-bold tabular-nums ${
                          forwardProjection.medianProfitUsd >= 0
                            ? 'text-[#0ECB81]'
                            : 'text-[#F6465D]'
                        }`}
                      >
                        {fmtUsd(forwardProjection.medianEndingCapital)}
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-[#8B949E]">
                        {fmtUsd(forwardProjection.medianProfitUsd, true)} (
                        {forwardProjection.medianReturnPercent >= 0 ? '+' : ''}
                        {forwardProjection.medianReturnPercent.toFixed(1)}%)
                      </div>
                    </div>

                    <div className="border border-[#222938] bg-[#12161F] p-3.5">
                      <div className="text-xs text-[#0ECB81]">Optimistic Outcome (75th Pct)</div>
                      <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#0ECB81]">
                        {fmtUsd(forwardProjection.optimisticCapitalP75)}
                      </div>
                      <div className="text-[11px] text-[#8B949E]">
                        Top quartile path after {horizonTrades} trades
                      </div>
                    </div>

                    <div className="border border-[#222938] bg-[#12161F] p-3.5">
                      <div className="text-xs text-[#8B949E]">Profit Odds & Stress Drawdown</div>
                      <div className="mt-1 font-mono text-base font-bold tabular-nums text-[#E6EDF3]">
                        {forwardProjection.probabilityOfProfitPercent.toFixed(0)}% Profitable
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-[#F6465D]">
                        Median dip -{forwardProjection.medianMaxDrawdownPercent.toFixed(1)}% · 95th
                        dip -{forwardProjection.worst95DrawdownPercent.toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold text-[#E6EDF3]">
                          Next {horizonTrades} Trades — Historical Sequence Range ({forwardProjection.pathsSimulated} Shuffled Paths)
                        </h3>
                        <p className="text-[11px] text-[#8B949E]">
                          Built deterministically by resampling this strategy&apos;s actual{' '}
                          {projection.totalTrades} historical trade R-outcomes so you can see how
                          winning/losing streak order affects your {fmtUsd(capital)} account.
                        </p>
                      </div>
                      <div className="flex items-center gap-4 text-[11px] text-[#C9D1D9]">
                        <span className="font-mono text-[#0ECB81]">── 75th / 90th Pct</span>
                        <span className="font-mono text-[#38BDF8]">── Median (50th)</span>
                        <span className="font-mono text-[#F59E0B]">── 25th / 10th Pct</span>
                      </div>
                    </div>

                    <div className="h-72 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={forwardProjection.steps}>
                          <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="tradeNumber"
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            tickFormatter={(v: number) => `T${v}`}
                          />
                          <YAxis
                            domain={['auto', 'auto']}
                            tick={{ fill: '#8B949E', fontSize: 10 }}
                            width={72}
                            tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
                          />
                          <ReferenceLine
                            y={capital}
                            stroke="#3B475E"
                            strokeDasharray="4 4"
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#0B0E14',
                              borderColor: '#38BDF8',
                              fontSize: '11px',
                            }}
                            formatter={(val: unknown, name: unknown) => {
                              const labelMap: Record<string, string> = {
                                p90: '90th Pct (Best Decile)',
                                p75: '75th Pct (Optimistic)',
                                p50: '50th Pct (Median)',
                                p25: '25th Pct (Conservative)',
                                p10: '10th Pct (Stress Floor)',
                              };
                              return [
                                fmtUsd(Number(val)),
                                labelMap[String(name)] ?? String(name),
                              ];
                            }}
                            labelFormatter={(v) => `After Trade #${v}`}
                          />
                          <Line
                            type="monotone"
                            dataKey="p90"
                            stroke="#0ECB81"
                            strokeWidth={1}
                            strokeDasharray="3 3"
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="p75"
                            stroke="#0ECB81"
                            strokeWidth={1.75}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="p50"
                            stroke="#38BDF8"
                            strokeWidth={2.5}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="p25"
                            stroke="#F59E0B"
                            strokeWidth={1.75}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="p10"
                            stroke="#F6465D"
                            strokeWidth={1}
                            strokeDasharray="3 3"
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: RISK SCALING MATRIX & TRADE LOG */}
              {activeTab === 'matrix' && (
                <div className="space-y-4">
                  {/* Risk % Comparison Matrix */}
                  <div className="border border-[#222938] bg-[#12161F]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2.5">
                      <h3 className="text-xs font-semibold text-[#E6EDF3]">
                        Risk-Per-Trade Comparison on {fmtUsd(capital)} Capital (
                        {sizingMode === 'compounding' ? 'Compounding' : 'Fixed Dollar'})
                      </h3>
                      <span className="text-[11px] text-[#8B949E]">
                        Click any row to apply that risk % immediately
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#222938] bg-[#0B0E14] text-[11px] text-[#8B949E]">
                            <th className="px-3 py-2">Risk %</th>
                            <th className="px-3 py-2 text-right">Initial $ Risk</th>
                            <th className="px-3 py-2 text-right">Projected Balance</th>
                            <th className="px-3 py-2 text-right">Net Profit ($)</th>
                            <th className="px-3 py-2 text-right">Return (%)</th>
                            <th className="px-3 py-2 text-right">Worst Dip ($)</th>
                            <th className="px-3 py-2 text-right">Worst Dip (%)</th>
                            <th className="px-3 py-2 text-right">10-Loss Streak</th>
                          </tr>
                        </thead>
                        <tbody>
                          {riskComparison.map((tier) => {
                            const isSelected = Math.abs(tier.riskPercent - riskPercent) < 0.05;
                            return (
                              <tr
                                key={tier.riskPercent}
                                onClick={() => setRiskPercent(tier.riskPercent)}
                                className={`border-b border-[#1B2230] text-xs cursor-pointer ${
                                  isSelected
                                    ? 'bg-[#161B26] text-[#E6EDF3]'
                                    : 'hover:bg-[#161B26]/60'
                                }`}
                              >
                                <td className="px-3 py-2 font-mono font-semibold tabular-nums text-[#38BDF8]">
                                  {tier.riskPercent.toFixed(1)}%
                                  {isSelected && (
                                    <span className="ml-2 text-[10px] text-[#0ECB81]">Active</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                                  {fmtUsd(tier.initialRiskUsd)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#E6EDF3]">
                                  {fmtUsd(tier.endingCapital)}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                                    tier.netProfitUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                  }`}
                                >
                                  {fmtUsd(tier.netProfitUsd, true)}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono tabular-nums ${
                                    tier.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                  }`}
                                >
                                  {tier.netReturnPercent >= 0 ? '+' : ''}
                                  {tier.netReturnPercent.toFixed(1)}%
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#F6465D]">
                                  -{fmtUsd(tier.maxDrawdownUsd)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#F6465D]">
                                  -{tier.maxDrawdownPercent.toFixed(1)}%
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#F59E0B]">
                                  -{fmtUsd(tier.tenLossStreakUsd)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Simulated Historical Trade Log */}
                  <div className="border border-[#222938] bg-[#12161F]">
                    <div className="flex items-center justify-between border-b border-[#222938] px-4 py-2.5">
                      <h3 className="text-xs font-semibold text-[#E6EDF3]">
                        Simulated Historical Trade Ledger ({projection.totalTrades} trades)
                      </h3>
                      <span className="text-[11px] text-[#8B949E]">
                        Click View Chart to inspect any trade on the live chart
                      </span>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 bg-[#0B0E14] z-10">
                          <tr className="border-b border-[#222938] text-[11px] text-[#8B949E]">
                            <th className="px-3 py-2">#</th>
                            <th className="px-3 py-2">Entry / Exit ({timezone})</th>
                            <th className="px-3 py-2">Side</th>
                            <th className="px-3 py-2 text-right">Entry → Exit</th>
                            <th className="px-3 py-2">Exit Reason</th>
                            <th className="px-3 py-2 text-right">Risk ($)</th>
                            <th className="px-3 py-2 text-right">Result (R)</th>
                            <th className="px-3 py-2 text-right">P&L ($)</th>
                            <th className="px-3 py-2 text-right">Balance</th>
                            <th className="px-3 py-2 text-right">Chart</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projection.rows.map((r) => (
                            <tr
                              key={r.trade.id}
                              className="border-b border-[#1B2230] text-xs hover:bg-[#161B26]"
                            >
                              <td className="px-3 py-2 font-mono tabular-nums text-[#8B949E]">
                                {r.index}
                              </td>
                              <td className="px-3 py-2 font-mono text-[11px] tabular-nums text-[#C9D1D9] whitespace-nowrap">
                                {fmtDateTime(r.trade.entryTime, timezone)} →{' '}
                                {fmtDateTime(r.trade.exitTime, timezone)}
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={`inline-flex items-center gap-1 font-mono text-[11px] font-semibold ${
                                    r.trade.direction === 'BUY'
                                      ? 'text-[#0ECB81]'
                                      : 'text-[#F6465D]'
                                  }`}
                                >
                                  {r.trade.direction === 'BUY' ? (
                                    <ArrowUpRight className="h-3 w-3" />
                                  ) : (
                                    <ArrowDownRight className="h-3 w-3" />
                                  )}
                                  {r.trade.direction}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-[#C9D1D9]">
                                {r.trade.entryPrice.toFixed(symMeta.pricePrecision)} →{' '}
                                {r.trade.exitPrice.toFixed(symMeta.pricePrecision)}
                              </td>
                              <td className="px-3 py-2 text-[11px] text-[#C9D1D9]">
                                {formatExitLabel(r.trade.exitReason)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                                {fmtUsd(r.riskUsd)}
                              </td>
                              <td
                                className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                                  r.trade.realizedR > 0
                                    ? 'text-[#0ECB81]'
                                    : r.trade.realizedR < 0
                                      ? 'text-[#F6465D]'
                                      : 'text-[#8B949E]'
                                }`}
                              >
                                {r.trade.realizedR >= 0 ? '+' : ''}
                                {r.trade.realizedR.toFixed(2)}R
                              </td>
                              <td
                                className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                                  r.pnlUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {fmtUsd(r.pnlUsd, true)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#E6EDF3]">
                                {fmtUsd(r.balanceAfter)}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleJumpToChart(
                                      r.trade.signalTime,
                                      r.trade.exitTime,
                                      r.trade.id
                                    )
                                  }
                                  className="inline-flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2 py-0.5 text-[10px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                                >
                                  <Crosshair className="h-3 w-3" />
                                  <span>Chart</span>
                                </button>
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
          )}
        </main>
      </div>
    </div>
  );
}
