import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Crosshair,
  ListChecks,
  ShieldCheck,
  TrendingDown,
  X,
  XCircle,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type {
  ChronologicalSplitLabel,
  CombinationDetailResult,
  MarketRegimeType,
  ProductionReadinessStatus,
  StrategyDiscoveryCombination,
  ValidationStatus,
  WindowSegmentMetrics,
} from '../../shared/types/index.ts';
import {
  deriveProductionAudit,
  formatRiskRewardRatio,
  HintBadge,
  SimpleValidationLabel,
} from './HintBadge.tsx';

type ModalSectionTab = 'all' | 'charts' | 'trades' | 'regimes';
type TradeSplitFilter = 'ALL' | ChronologicalSplitLabel;
type TradeOutcomeFilter = 'ALL' | 'WINS' | 'LOSSES' | 'BUY' | 'SELL';

const REGIMES_ORDER: MarketRegimeType[] = [
  'Trending',
  'Ranging',
  'High Volatility',
  'Low Volatility',
  'Transitional',
];

function fmtDate(sec: number, timezone: string): string {
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

function statusAccent(status: ValidationStatus): {
  dot: string;
  text: string;
  border: string;
} {
  switch (status) {
    case 'Validated':
      return { dot: 'bg-[#0ECB81]', text: 'text-[#0ECB81]', border: 'border-[#0ECB81]/50' };
    case 'Preliminary Candidate':
      return { dot: 'bg-[#F59E0B]', text: 'text-[#F59E0B]', border: 'border-[#F59E0B]/50' };
    case 'Insufficient Evidence':
      return { dot: 'bg-[#8B949E]', text: 'text-[#8B949E]', border: 'border-[#30363D]' };
    case 'Failed Validation':
      return { dot: 'bg-[#F6465D]', text: 'text-[#F6465D]', border: 'border-[#F6465D]/50' };
  }
}

function regimeSubtitle(regime: MarketRegimeType): string {
  switch (regime) {
    case 'Trending':
      return 'Strong directional move';
    case 'Ranging':
      return 'Moving sideways';
    case 'High Volatility':
      return 'Big, fast price swings';
    case 'Low Volatility':
      return 'Slow & quiet market';
    case 'Transitional':
      return 'Shifting between trends';
  }
}

function splitPlainName(split: ChronologicalSplitLabel): string {
  switch (split) {
    case 'IS':
      return 'Train';
    case 'OOS':
      return 'Test';
    case 'HOLDOUT':
      return 'Final';
  }
}

function formatExitReason(reason: string): string {
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

function readinessBadgeStyle(readiness: ProductionReadinessStatus): string {
  switch (readiness) {
    case 'Production Ready':
      return 'border-[#0ECB81]/50 bg-[#0ECB81]/15 text-[#0ECB81]';
    case 'Verify Paper':
      return 'border-[#F59E0B]/50 bg-[#F59E0B]/15 text-[#F59E0B]';
    case 'Overfit / Decayed':
      return 'border-[#F6465D]/50 bg-[#F6465D]/15 text-[#F6465D]';
    case 'Not Ready':
      return 'border-[#30363D] bg-[#0B0E14] text-[#8B949E]';
  }
}

function formatUtcRangeInTimezone(utcStartHour: number, utcEndHour: number, timezone: string): string {
  try {
    const startDt = new Date(Date.UTC(2025, 0, 15, utcStartHour, 0, 0));
    const endDt = new Date(Date.UTC(2025, 0, 15, utcEndHour % 24, 0, 0));
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${fmt.format(startDt)}–${fmt.format(endDt)}`;
  } catch {
    return `${String(utcStartHour).padStart(2, '0')}:00–${String(utcEndHour % 24).padStart(2, '0')}:00 UTC`;
  }
}

function SegmentComparisonRow({
  label,
  sublabel,
  metrics,
  highlight = false,
  auditOnly = false,
}: {
  label: string;
  sublabel: string;
  metrics: WindowSegmentMetrics;
  highlight?: boolean;
  auditOnly?: boolean;
}) {
  const rr = formatRiskRewardRatio(metrics);
  return (
    <tr
      className={`border-b border-[#1B2230] ${
        highlight ? 'bg-[#161B26]' : auditOnly ? 'bg-[#0F141D]' : ''
      }`}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[#E6EDF3]">{label}</span>
          {auditOnly && (
            <span className="text-[10px] font-mono text-[#38BDF8]">FINAL PROOF</span>
          )}
        </div>
        <div className="text-[10px] text-[#8B949E]">{sublabel}</div>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-[#E6EDF3]">
        <div>{metrics.trades}</div>
        <div className="text-[10px] text-[#8B949E]">
          {metrics.wins}W / {metrics.losses}L
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-[#C9D1D9]">
        {metrics.winRate.toFixed(1)}%
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-[#38BDF8]">
        <div>{rr.ratioText}</div>
        {rr.avgWinR !== null && rr.avgLossR !== null && (
          <div className="text-[10px] font-normal text-[#8B949E]">
            +{rr.avgWinR.toFixed(1)}R / -{rr.avgLossR.toFixed(1)}R
          </div>
        )}
      </td>
      <td
        className={`px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums ${
          metrics.expectancyR > 0
            ? 'text-[#0ECB81]'
            : metrics.expectancyR < 0
              ? 'text-[#F6465D]'
              : 'text-[#8B949E]'
        }`}
      >
        {metrics.expectancyR >= 0 ? '+' : ''}
        {metrics.expectancyR.toFixed(2)}R
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-[#E6EDF3]">
        {metrics.profitFactor !== null ? `${metrics.profitFactor.toFixed(2)}×` : '—'}
      </td>
      <td
        className={`px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums ${
          metrics.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
        }`}
      >
        {metrics.netReturnPercent >= 0 ? '+' : ''}
        {metrics.netReturnPercent.toFixed(2)}%
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-[#F6465D]">
        -{metrics.maxDrawdownPercent.toFixed(2)}%
      </td>
    </tr>
  );
}

export function CombinationDetailModal({
  combination,
  detail,
  loading,
  error,
  timezone,
  onClose,
  onJumpToChart,
}: {
  combination?: StrategyDiscoveryCombination | null;
  detail: CombinationDetailResult | null;
  loading: boolean;
  error: string | null;
  timezone: string;
  onClose: () => void;
  onJumpToChart: (
    symbol: StrategyDiscoveryCombination['symbol'],
    timeframe: StrategyDiscoveryCombination['timeframe'],
    signalTime: number,
    exitTime: number,
    tradeId: string
  ) => void;
}) {
  const [sectionTab, setSectionTab] = useState<ModalSectionTab>('all');
  const [splitFilter, setSplitFilter] = useState<TradeSplitFilter>('ALL');
  const [regimeFilter, setRegimeFilter] = useState<'ALL' | MarketRegimeType>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<TradeOutcomeFilter>('ALL');
  const [showAllTrades, setShowAllTrades] = useState<boolean>(false);
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const combo = detail?.combination ?? combination ?? null;
  const meta = combo ? getInstrumentMeta(combo.symbol) : null;
  const fullMetrics = detail?.backtestResult.metrics ?? null;
  const prodAudit = useMemo(() => (combo ? deriveProductionAudit(combo) : null), [combo]);
  const sessionRows = useMemo(
    () => detail?.sessionBreakdown ?? combo?.sessionBreakdown ?? [],
    [detail, combo]
  );

  // Enrich IS/OOS/Holdout Risk:Reward directly from annotatedTrades if missing in older saved runs
  const enrichedSplitMetrics = useMemo(() => {
    if (!combo) return null;
    const computeExactAvgWinLoss = (split: ChronologicalSplitLabel, base: WindowSegmentMetrics) => {
      if (
        typeof base.rewardToRiskRatio === 'number' &&
        typeof base.avgWinR === 'number' &&
        typeof base.avgLossR === 'number'
      ) {
        return base;
      }
      if (!detail) return base;
      const matching = detail.annotatedTrades.filter(
        (t) => t.split === split && t.entryRegime === combo.regime
      );
      if (matching.length === 0) return base;
      const winRs = matching.filter((t) => t.realizedR > 0.02).map((t) => t.realizedR);
      const lossRs = matching.filter((t) => t.realizedR < -0.02).map((t) => Math.abs(t.realizedR));
      const avgWinR = winRs.length > 0 ? winRs.reduce((s, v) => s + v, 0) / winRs.length : 0;
      const avgLossR = lossRs.length > 0 ? lossRs.reduce((s, v) => s + v, 0) / lossRs.length : 0;
      const rewardToRiskRatio =
        avgLossR > 0 ? avgWinR / avgLossR : avgWinR > 0 ? avgWinR : 0;
      return {
        ...base,
        avgWinR: Math.round(avgWinR * 100) / 100,
        avgLossR: Math.round(avgLossR * 100) / 100,
        rewardToRiskRatio: Math.round(rewardToRiskRatio * 100) / 100,
      };
    };
    return {
      is: computeExactAvgWinLoss('IS', combo.isMetrics),
      oos: computeExactAvgWinLoss('OOS', combo.oosMetrics),
      holdout: computeExactAvgWinLoss('HOLDOUT', combo.holdoutMetrics),
    };
  }, [combo, detail]);

  const filteredTrades = useMemo(() => {
    if (!detail) return [];
    return detail.annotatedTrades.filter((t) => {
      if (splitFilter !== 'ALL' && t.split !== splitFilter) return false;
      if (regimeFilter !== 'ALL' && t.entryRegime !== regimeFilter) return false;
      if (outcomeFilter === 'BUY' && t.direction !== 'BUY') return false;
      if (outcomeFilter === 'SELL' && t.direction !== 'SELL') return false;
      if (outcomeFilter === 'WINS' && t.netPnl <= 0.01) return false;
      if (outcomeFilter === 'LOSSES' && t.netPnl >= -0.01) return false;
      return true;
    });
  }, [detail, splitFilter, regimeFilter, outcomeFilter]);

  const displayedTrades = useMemo(() => {
    return showAllTrades ? filteredTrades : filteredTrades.slice(0, 120);
  }, [filteredTrades, showAllTrades]);

  const equitySeries = useMemo(() => {
    if (!detail) return [];
    const { isEndTime, oosEndTime } = detail.splitBoundaries;
    return detail.backtestResult.equityCurve.map((pt) => ({
      time: pt.time,
      label: fmtDate(pt.time, timezone),
      equity: Number(pt.equity.toFixed(2)),
      drawdown: Number((-pt.drawdownPercent).toFixed(2)),
      drawdownAbs: pt.drawdownPercent,
      split:
        pt.time < isEndTime ? 'Training' : pt.time < oosEndTime ? 'Unseen Test' : 'Final Check',
    }));
  }, [detail, timezone]);

  const drawdownStats = useMemo(() => {
    if (equitySeries.length === 0) {
      return { avgDd: 0, peakEquity: 10000, troughEquity: 10000 };
    }
    let sumDd = 0;
    let peak = equitySeries[0].equity;
    let trough = equitySeries[0].equity;
    for (const pt of equitySeries) {
      sumDd += pt.drawdownAbs;
      if (pt.equity > peak) peak = pt.equity;
      if (pt.equity < trough) trough = pt.equity;
    }
    return {
      avgDd: sumDd / equitySeries.length,
      peakEquity: peak,
      troughEquity: trough,
    };
  }, [equitySeries]);

  const wfChartData = useMemo(() => {
    if (!combo) return [];
    return combo.walkForwardFolds.map((f) => ({
      name: `Period ${f.foldIndex}`,
      expectancyR: f.testMetrics.expectancyR,
      netReturn: f.testMetrics.netReturnPercent,
      trades: f.testMetrics.trades,
      active: f.active,
      profitable: f.profitable,
    }));
  }, [combo]);

  const showChartsSection = sectionTab === 'all' || sectionTab === 'charts';
  const showRegimesSection = sectionTab === 'all' || sectionTab === 'regimes';
  const showTradesSection = sectionTab === 'all' || sectionTab === 'trades';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 md:p-5"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94vh] w-full max-w-6xl flex-col border border-[#222938] bg-[#0B0E14] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-[#222938] bg-[#12161F] px-5 py-3.5 space-y-2.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {combo ? (
                <>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-mono text-xs text-[#38BDF8]">
                      RANK #{combo.rank}
                    </span>
                    <span className="text-[#30363D]">/</span>
                    <h2 className="text-sm font-bold text-[#E6EDF3]">
                      {combo.strategy.name}
                    </h2>
                    <span className="text-[#30363D]">·</span>
                    <span className="font-mono text-xs font-semibold text-[#E6EDF3]">
                      {combo.symbol} {combo.timeframe}
                    </span>
                    <span className="text-[#30363D]">·</span>
                    <span className="font-mono text-xs text-[#38BDF8]">
                      {combo.regime}
                    </span>
                    <span className="text-[#30363D]">·</span>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <span
                        className={`h-2 w-2 rounded-full ${statusAccent(combo.validationStatus).dot}`}
                      />
                      <span className={statusAccent(combo.validationStatus).text}>
                        {SimpleValidationLabel(combo.validationStatus)}
                      </span>
                      <HintBadge termKey="validation" />
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-[#8B949E]">
                    <span>{combo.strategy.category}</span>
                    <span>·</span>
                    <span>Big-Picture Trend (HTF): {combo.htfTimeframe}</span>
                    <span>·</span>
                    <span className="font-mono tabular-nums inline-flex items-center gap-1">
                      Test Score:{' '}
                      <strong className="text-[#E6EDF3]">{combo.oosScore.toFixed(1)}/100</strong>
                      <HintBadge termKey="oosScore" />
                    </span>
                    <span>·</span>
                    <span className="font-mono tabular-nums inline-flex items-center gap-1">
                      Time Consistency:{' '}
                      <strong className="text-[#E6EDF3]">
                        {combo.wfConsistencyPercent.toFixed(1)}% ({combo.wfProfitableFolds}/
                        {combo.wfActiveFolds} periods)
                      </strong>
                      <HintBadge termKey="wfCons" />
                    </span>
                    <span>·</span>
                    <span className="font-mono tabular-nums">
                      Candles in {combo.regime}: {combo.barsInRegime}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-sm font-semibold text-[#E6EDF3]">
                  Combination Backtest & Validation Audit
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              title="Close modal (Esc)"
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:border-[#38BDF8] hover:text-white cursor-pointer shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Drill-Down Section Navigation Bar */}
          {detail && !loading && !error && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[#1B2230]">
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    ['all', 'Full Expanded Report'],
                    ['charts', 'Equity Curve & Drawdowns'],
                    ['regimes', 'Market Moods & Rules'],
                    ['trades', `Trade Execution Logs (${detail.annotatedTrades.length})`],
                  ] as Array<[ModalSectionTab, string]>
                ).map(([tabKey, tabLabel]) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setSectionTab(tabKey)}
                    className={`border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap cursor-pointer ${
                      sectionTab === tabKey
                        ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                        : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                    }`}
                  >
                    {tabLabel}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-[#8B949E]">
                Press Esc or click outside to close
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading && (
            <div className="border border-[#222938] bg-[#12161F] p-10 text-center space-y-2">
              <div className="text-xs font-medium text-[#38BDF8]">
                Loading Full Backtest Equity Curve, Drawdowns & Trade Execution Logs...
              </div>
              <div className="text-[11px] text-[#8B949E]">
                Replaying historical OHLCV bars for {combo?.symbol} {combo?.timeframe}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="border border-[#F6465D]/50 bg-[#12161F] p-4 text-xs text-[#F6465D]">
              {error}
            </div>
          )}

          {!loading && !error && detail && combo && meta && fullMetrics && (
            <>
              {/* Simple Plain-English Summary Card */}
              {sectionTab === 'all' && prodAudit && enrichedSplitMetrics && (() => {
                const oosRr = formatRiskRewardRatio(enrichedSplitMetrics.oos);
                const isRr = formatRiskRewardRatio(enrichedSplitMetrics.is);
                const holdRr = formatRiskRewardRatio(enrichedSplitMetrics.holdout);
                return (
                  <div
                    className={`border ${statusAccent(combo.validationStatus).border} bg-[#12161F] p-4 space-y-3`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${statusAccent(combo.validationStatus).dot}`}
                        />
                        <span
                          className={`text-sm font-bold ${statusAccent(combo.validationStatus).text}`}
                        >
                          {combo.validationStatus === 'Validated'
                            ? 'Verified Winner — Steady Across Past & Fresh Data'
                            : combo.validationStatus === 'Preliminary Candidate'
                              ? 'Promising Setup — Needs More Trade History'
                              : combo.validationStatus === 'Insufficient Evidence'
                                ? 'Too Few Trades — Not Enough Proof Yet'
                                : 'Failed Test — Lost Money on Fresh Data'}
                        </span>
                        <span
                          className={`border px-2 py-0.5 font-mono text-[10px] font-semibold ${readinessBadgeStyle(prodAudit.readiness)}`}
                        >
                          {prodAudit.readiness}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] font-mono text-[#8B949E]">
                        <span className="inline-flex items-center gap-1">
                          Confidence:{' '}
                          <strong className="text-[#E6EDF3]">
                            {prodAudit.edgeConfidencePercent.toFixed(0)}%
                          </strong>
                          <HintBadge termKey="edgeConfidence" align="right" />
                        </span>
                        <span>
                          Score:{' '}
                          <strong className="text-[#E6EDF3]">{combo.oosScore.toFixed(0)} / 100</strong>
                        </span>
                      </div>
                    </div>

                    {/* 4 Crystal-Clear Numbers (Risk:Reward, Win Rate, Profit, Max Drop) */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                      <div className="border border-[#222938] bg-[#0B0E14] p-3">
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#8B949E]">
                          <span>Risk : Reward Ratio</span>
                          <HintBadge termKey="riskReward" align="left" />
                        </div>
                        <div className="mt-1 font-mono text-lg font-bold text-[#38BDF8] tabular-nums">
                          {oosRr.ratioText}
                        </div>
                        <div className="text-[11px] text-[#C9D1D9]">
                          {oosRr.avgWinR !== null && oosRr.avgLossR !== null
                            ? `Avg Win +${oosRr.avgWinR.toFixed(2)}R vs Loss -${oosRr.avgLossR.toFixed(2)}R`
                            : `Profit Factor ${combo.oosMetrics.profitFactor?.toFixed(2) ?? '—'}×`}
                        </div>
                      </div>

                      <div className="border border-[#222938] bg-[#0B0E14] p-3">
                        <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                          Win Rate & Trades
                        </div>
                        <div className="mt-1 font-mono text-lg font-bold text-[#E6EDF3] tabular-nums">
                          {combo.oosMetrics.winRate.toFixed(0)}% Win Rate
                        </div>
                        <div className="text-[11px] text-[#C9D1D9]">
                          {combo.oosMetrics.wins} Won · {combo.oosMetrics.losses} Lost ({combo.oosMetrics.trades} trades)
                        </div>
                      </div>

                      <div className="border border-[#222938] bg-[#0B0E14] p-3">
                        <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                          Unseen Test Profit
                        </div>
                        <div
                          className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                            combo.oosMetrics.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {combo.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                          {combo.oosMetrics.netReturnPercent.toFixed(1)}%
                        </div>
                        <div className="text-[11px] text-[#C9D1D9]">
                          Avg {combo.oosMetrics.expectancyR >= 0 ? '+' : ''}
                          {combo.oosMetrics.expectancyR.toFixed(2)}R per trade
                        </div>
                      </div>

                      <div className="border border-[#222938] bg-[#0B0E14] p-3">
                        <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                          Max Account Drop
                        </div>
                        <div className="mt-1 font-mono text-lg font-bold text-[#F6465D] tabular-nums">
                          -{combo.oosMetrics.maxDrawdownPercent.toFixed(1)}%
                        </div>
                        <div className="text-[11px] text-[#C9D1D9]">
                          Consistency: {combo.wfProfitableFolds}/{combo.wfActiveFolds} periods won
                        </div>
                      </div>
                    </div>

                    {/* Simple 4-Step Trading Plan */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 border border-[#222938] bg-[#0B0E14] p-3 text-[11px]">
                      <div>
                        <div className="text-[#8B949E]">1. Asset & Chart</div>
                        <div className="mt-0.5 font-mono font-semibold text-[#E6EDF3]">
                          {combo.symbol} · {combo.timeframe}
                        </div>
                        <div className="text-[10px] text-[#8B949E]">Trend filter: {combo.htfTimeframe}</div>
                      </div>
                      <div>
                        <div className="text-[#8B949E]">2. Best Market Condition</div>
                        <div className="mt-0.5 font-semibold text-[#0ECB81]">{combo.regime}</div>
                        <div className="text-[10px] text-[#F59E0B]">
                          {combo.poorRegimes.length > 0
                            ? `Avoid: ${combo.poorRegimes[0].regime}`
                            : 'Works across moods'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[#8B949E]">3. Best Trading Time</div>
                        <div className="mt-0.5 font-mono font-semibold text-[#38BDF8]">
                          {combo.bestSession ?? 'See Session Table Below'}
                        </div>
                        <div className="text-[10px] text-[#8B949E]">
                          {combo.avoidSessions && combo.avoidSessions.length > 0
                            ? `Skip: ${combo.avoidSessions[0].split(' (')[0]}`
                            : 'No weak session flagged'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[#8B949E]">4. Final Proof Verdict</div>
                        <div className="mt-0.5 text-[#C9D1D9] leading-snug">
                          {prodAudit.summaryNote}
                        </div>
                      </div>
                    </div>

                    {/* 3 Time Windows Simple Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-[11px]">
                      <div className="border border-[#222938] bg-[#0B0E14] p-2.5">
                        <div className="text-[#8B949E] font-medium">
                          1. Older History (First 50%)
                        </div>
                        <div className="mt-1 flex items-baseline justify-between font-mono">
                          <span
                            className={`text-sm font-bold ${
                              combo.isMetrics.netReturnPercent >= 0
                                ? 'text-[#0ECB81]'
                                : 'text-[#F6465D]'
                            }`}
                          >
                            {combo.isMetrics.netReturnPercent >= 0 ? '+' : ''}
                            {combo.isMetrics.netReturnPercent.toFixed(1)}%
                          </span>
                          <span className="text-[#C9D1D9]">
                            R:R {isRr.ratioText} · {combo.isMetrics.trades}t ({combo.isMetrics.winRate.toFixed(0)}% W)
                          </span>
                        </div>
                      </div>

                      <div className="border border-[#38BDF8]/40 bg-[#161B26] p-2.5">
                        <div className="text-[#38BDF8] font-medium">
                          2. Unseen Test (Next 25% · Ranked Here)
                        </div>
                        <div className="mt-1 flex items-baseline justify-between font-mono">
                          <span
                            className={`text-sm font-bold ${
                              combo.oosMetrics.netReturnPercent >= 0
                                ? 'text-[#0ECB81]'
                                : 'text-[#F6465D]'
                            }`}
                          >
                            {combo.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                            {combo.oosMetrics.netReturnPercent.toFixed(1)}%
                          </span>
                          <span className="text-[#E6EDF3]">
                            R:R {oosRr.ratioText} · {combo.oosMetrics.trades}t ({combo.oosMetrics.winRate.toFixed(0)}% W)
                          </span>
                        </div>
                      </div>

                      <div className="border border-[#222938] bg-[#0B0E14] p-2.5">
                        <div className="text-[#8B949E] font-medium">
                          3. Final Proof (Newest 25%)
                        </div>
                        <div className="mt-1 flex items-baseline justify-between font-mono">
                          <span
                            className={`text-sm font-bold ${
                              combo.holdoutMetrics.trades === 0
                                ? 'text-[#8B949E]'
                                : combo.holdoutMetrics.netReturnPercent >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                            }`}
                          >
                            {combo.holdoutMetrics.trades > 0
                              ? `${combo.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}${combo.holdoutMetrics.netReturnPercent.toFixed(1)}%`
                              : 'No trades'}
                          </span>
                          <span className="text-[#C9D1D9]">
                            {combo.holdoutMetrics.trades > 0
                              ? `R:R ${holdRr.ratioText} · ${combo.holdoutMetrics.trades}t (${combo.holdoutMetrics.winRate.toFixed(0)}% W)`
                              : 'Waiting for signal'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Expanded Full Backtest Summary KPI Strip (All Regimes & Full History) */}
              {showChartsSection && (
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Ending Capital
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#E6EDF3]">
                      ${fullMetrics.endingEquity.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </div>
                    <div
                      className={`text-[10px] font-mono tabular-nums ${
                        fullMetrics.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                      }`}
                    >
                      {fullMetrics.netReturnPercent >= 0 ? '+' : ''}
                      {fullMetrics.netReturnPercent.toFixed(2)}% from $
                      {fullMetrics.startingCapital.toLocaleString('en-US')}
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Max Drawdown
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#F6465D]">
                      -{fullMetrics.maxDrawdownPercent.toFixed(2)}%
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-[#8B949E]">
                      -${fullMetrics.maxDrawdownDollar.toFixed(0)} · Avg -
                      {drawdownStats.avgDd.toFixed(2)}%
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Full Trade Sample
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#E6EDF3]">
                      {fullMetrics.totalTrades} trades ({fullMetrics.winRate.toFixed(1)}% W)
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-[#8B949E]">
                      {fullMetrics.wins}W / {fullMetrics.losses}L · Long {fullMetrics.longWinRate.toFixed(0)}% / Short {fullMetrics.shortWinRate.toFixed(0)}%
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Profit Factor & Avg Win/Loss
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#38BDF8]">
                      {fullMetrics.profitFactor !== null ? `${fullMetrics.profitFactor.toFixed(2)}×` : '—'}
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-[#8B949E]">
                      Win +{fullMetrics.avgWinR.toFixed(2)}R / Loss {fullMetrics.avgLossR.toFixed(2)}R
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Streaks & Avg Hold
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#E6EDF3]">
                      {fullMetrics.maxConsecutiveWins}W / {fullMetrics.maxConsecutiveLosses}L
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-[#8B949E]">
                      Avg {fullMetrics.avgBarsHeld.toFixed(1)} bars · Sharpe {fullMetrics.sharpeRatio.toFixed(2)}
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                      Costs & Targets Hit
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#C9D1D9]">
                      -${fullMetrics.totalFeesAndSlippage.toFixed(2)}
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-[#8B949E]">
                      TP1 {fullMetrics.tp1HitRate.toFixed(0)}% · SL {fullMetrics.slHitRate.toFixed(0)}%
                    </div>
                  </div>
                </div>
              )}

              {/* Chronological Splits Table */}
              {sectionTab === 'all' && (
                <div className="border border-[#222938] bg-[#12161F]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#E6EDF3]">
                      <ShieldCheck className="h-4 w-4 text-[#0ECB81]" />
                      <span>
                        Detailed Numbers Across Separate Time Periods ({combo.regime} Market Only)
                      </span>
                      <HintBadge termKey="oos" align="left" />
                    </div>
                    <div className="text-[11px] font-mono text-[#8B949E]">
                      Train: {fmtDate(detail.splitBoundaries.startTime, timezone)} →{' '}
                      {fmtDate(detail.splitBoundaries.isEndTime, timezone)} · Unseen Test →{' '}
                      {fmtDate(detail.splitBoundaries.oosEndTime, timezone)} · Final Check →{' '}
                      {fmtDate(detail.splitBoundaries.endTime, timezone)}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                          <th className="px-3 py-2">Time Period</th>
                          <th className="px-3 py-2 text-right">Trades (W/L)</th>
                          <th className="px-3 py-2 text-right">Win %</th>
                          <th className="px-3 py-2 text-right">
                            <span className="inline-flex items-center gap-1">
                              Risk : Reward <HintBadge termKey="riskReward" align="right" />
                            </span>
                          </th>
                          <th className="px-3 py-2 text-right">
                            <span className="inline-flex items-center gap-1">
                              Avg R / Trade <HintBadge termKey="oosExp" align="right" />
                            </span>
                          </th>
                          <th className="px-3 py-2 text-right">
                            <span className="inline-flex items-center gap-1">
                              Profit Factor <HintBadge termKey="oosPf" align="right" />
                            </span>
                          </th>
                          <th className="px-3 py-2 text-right">Net Profit %</th>
                          <th className="px-3 py-2 text-right">
                            <span className="inline-flex items-center gap-1">
                              Max Drop <HintBadge termKey="maxDd" align="right" />
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <SegmentComparisonRow
                          label="1. Older Past (Training · First 50%)"
                          sublabel="Older price history baseline"
                          metrics={enrichedSplitMetrics?.is ?? combo.isMetrics}
                        />
                        <SegmentComparisonRow
                          label="2. Unseen Test (OOS · Next 25%)"
                          sublabel="Fresh data used for main score"
                          metrics={enrichedSplitMetrics?.oos ?? combo.oosMetrics}
                          highlight
                        />
                        <SegmentComparisonRow
                          label="3. Final Proof (Holdout · Newest 25%)"
                          sublabel="Kept locked away from ranking to prevent overfitting"
                          metrics={enrichedSplitMetrics?.holdout ?? combo.holdoutMetrics}
                          auditOnly
                        />
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Synchronized Performance Equity Curve + Underwater Drawdown Chart + Walk-Forward */}
              {showChartsSection && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2 border border-[#222938] bg-[#12161F] p-3.5 space-y-4">
                    {/* Performance Equity Curve */}
                    <div>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-[#E6EDF3] inline-flex items-center gap-1.5">
                          <Activity className="h-3.5 w-3.5 text-[#38BDF8]" />
                          Performance Equity Curve ({combo.symbol} {combo.timeframe})
                        </span>
                        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-[#8B949E]">
                          <span>Peak: ${drawdownStats.peakEquity.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                          <span>
                            Net:{' '}
                            <strong
                              className={
                                fullMetrics.netReturnPercent >= 0
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                              }
                            >
                              {fullMetrics.netReturnPercent >= 0 ? '+' : ''}
                              {fullMetrics.netReturnPercent}%
                            </strong>
                          </span>
                          <span className="text-[#0ECB81]">| OOS Start</span>
                          <span className="text-[#38BDF8]">| Final Check</span>
                        </div>
                      </div>
                      <div className={sectionTab === 'charts' ? 'h-64 w-full' : 'h-52 w-full'}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={equitySeries} syncId="discoveryPerfSync">
                            <defs>
                              <linearGradient id="discEqGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#38BDF8" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#38BDF8" stopOpacity={0.02} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="time"
                              type="number"
                              scale="time"
                              domain={['dataMin', 'dataMax']}
                              tickFormatter={(v) => fmtDate(Number(v), timezone)}
                              tick={{ fill: '#8B949E', fontSize: 10 }}
                              minTickGap={42}
                            />
                            <YAxis
                              tick={{ fill: '#8B949E', fontSize: 10 }}
                              domain={['auto', 'auto']}
                              tickFormatter={(v) => `$${Math.round(Number(v))}`}
                              width={58}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#12161F',
                                borderColor: '#222938',
                                fontSize: '11px',
                              }}
                              labelFormatter={(label) => fmtDate(Number(label), timezone)}
                              formatter={(
                                value: unknown,
                                _name: unknown,
                                item: { payload?: { split?: string } }
                              ) => [
                                `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
                                `Equity (${item?.payload?.split ?? ''})`,
                              ]}
                            />
                            <ReferenceLine
                              y={fullMetrics.startingCapital}
                              stroke="#3B475E"
                              strokeDasharray="4 4"
                            />
                            <ReferenceLine
                              x={detail.splitBoundaries.isEndTime}
                              stroke="#0ECB81"
                              strokeDasharray="3 3"
                            />
                            <ReferenceLine
                              x={detail.splitBoundaries.oosEndTime}
                              stroke="#38BDF8"
                              strokeDasharray="3 3"
                            />
                            <Area
                              type="monotone"
                              dataKey="equity"
                              stroke="#38BDF8"
                              strokeWidth={2}
                              fill="url(#discEqGrad)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Underwater Drawdown Curve */}
                    <div className="pt-3 border-t border-[#1B2230]">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-[#E6EDF3] inline-flex items-center gap-1.5">
                          <TrendingDown className="h-3.5 w-3.5 text-[#F6465D]" />
                          Underwater Drawdown Curve (% Below Peak)
                          <HintBadge termKey="maxDd" align="left" />
                        </span>
                        <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-[#8B949E]">
                          <span>
                            Max Drop:{' '}
                            <strong className="text-[#F6465D]">
                              -{fullMetrics.maxDrawdownPercent.toFixed(2)}% (-$
                              {fullMetrics.maxDrawdownDollar.toFixed(0)})
                            </strong>
                          </span>
                          <span>
                            Avg Dip: <strong className="text-[#C9D1D9]">-{drawdownStats.avgDd.toFixed(2)}%</strong>
                          </span>
                        </div>
                      </div>
                      <div className={sectionTab === 'charts' ? 'h-40 w-full' : 'h-32 w-full'}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={equitySeries} syncId="discoveryPerfSync">
                            <defs>
                              <linearGradient id="discDdGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#F6465D" stopOpacity={0.08} />
                                <stop offset="95%" stopColor="#F6465D" stopOpacity={0.38} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="time"
                              type="number"
                              scale="time"
                              domain={['dataMin', 'dataMax']}
                              tickFormatter={(v) => fmtDate(Number(v), timezone)}
                              tick={{ fill: '#8B949E', fontSize: 10 }}
                              minTickGap={42}
                            />
                            <YAxis
                              tick={{ fill: '#F6465D', fontSize: 10 }}
                              domain={['auto', 0]}
                              tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                              width={58}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#12161F',
                                borderColor: '#222938',
                                fontSize: '11px',
                              }}
                              labelFormatter={(label) => fmtDate(Number(label), timezone)}
                              formatter={(
                                value: unknown,
                                _name: unknown,
                                item: { payload?: { split?: string } }
                              ) => [
                                `${Number(value).toFixed(2)}%`,
                                `Drawdown (${item?.payload?.split ?? ''})`,
                              ]}
                            />
                            <ReferenceLine y={0} stroke="#30363D" />
                            <ReferenceLine
                              x={detail.splitBoundaries.isEndTime}
                              stroke="#0ECB81"
                              strokeDasharray="3 3"
                            />
                            <ReferenceLine
                              x={detail.splitBoundaries.oosEndTime}
                              stroke="#38BDF8"
                              strokeDasharray="3 3"
                            />
                            <Area
                              type="monotone"
                              dataKey="drawdown"
                              stroke="#F6465D"
                              strokeWidth={1.5}
                              fill="url(#discDdGrad)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>

                  {/* Walk-Forward Fold Chart */}
                  <div className="border border-[#222938] bg-[#12161F] p-3.5 flex flex-col justify-between">
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs">
                        <span className="font-semibold text-[#E6EDF3] inline-flex items-center gap-1.5">
                          Consistency Over 4 Time Periods
                          <HintBadge termKey="wfCons" align="right" />
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-[#8B949E]">
                          {combo.wfProfitableFolds}/{combo.wfActiveFolds} Won
                        </span>
                      </div>
                      <div className="h-52 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={wfChartData}>
                            <CartesianGrid stroke="#1B2230" strokeDasharray="3 3" />
                            <XAxis dataKey="name" tick={{ fill: '#8B949E', fontSize: 10 }} />
                            <YAxis tick={{ fill: '#8B949E', fontSize: 10 }} width={36} />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#12161F',
                                borderColor: '#222938',
                                fontSize: '11px',
                              }}
                              formatter={(value: unknown) => [
                                `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}R`,
                                'Avg Return / Trade',
                              ]}
                            />
                            <ReferenceLine y={0} stroke="#3B475E" />
                            <Bar dataKey="expectancyR">
                              {wfChartData.map((entry, idx) => (
                                <Cell
                                  key={idx}
                                  fill={
                                    !entry.active
                                      ? '#30363D'
                                      : entry.profitable
                                        ? '#0ECB81'
                                        : '#F6465D'
                                  }
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="mt-3 space-y-1.5 border-t border-[#1B2230] pt-3 text-[10px] font-mono tabular-nums text-[#8B949E]">
                      {combo.walkForwardFolds.map((f) => (
                        <div key={f.foldIndex} className="flex items-center justify-between">
                          <span>
                            Period {f.foldIndex}: {f.testMetrics.trades} trades (
                            {fmtDate(f.testStartTime, timezone).split(',')[0]})
                          </span>
                          <span
                            className={
                              !f.active
                                ? 'text-[#6E7681]'
                                : f.profitable
                                  ? 'text-[#0ECB81]'
                                  : 'text-[#F6465D]'
                            }
                          >
                            {f.active
                              ? `${f.testMetrics.expectancyR >= 0 ? '+' : ''}${f.testMetrics.expectancyR.toFixed(2)}R avg · ${f.testMetrics.netReturnPercent >= 0 ? '+' : ''}${f.testMetrics.netReturnPercent.toFixed(1)}%`
                              : 'No Trades'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* All 5 Market Conditions Comparison + Audit/Rules */}
              {showRegimesSection && (
                <>
                  <div className="border border-[#222938] bg-[#12161F]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2.5">
                      <span className="text-xs font-semibold text-[#E6EDF3] inline-flex items-center gap-1.5">
                        How This Strategy Performs in Different Market Moods ({combo.symbol}{' '}
                        {combo.timeframe})
                        <HintBadge termKey="regime" align="left" />
                      </span>
                      {combo.poorRegimes.length > 0 && (
                        <span className="flex items-center gap-1.5 text-[11px] text-[#F59E0B]">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Avoid Trading During:{' '}
                          {combo.poorRegimes.map((p) => p.regime).join(', ')}
                        </span>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                            <th className="px-3 py-2">Market Mood</th>
                            <th className="px-3 py-2 text-right">Candles</th>
                            <th className="px-3 py-2 text-right">Older Trades / Avg R</th>
                            <th className="px-3 py-2 text-right">Test Trades</th>
                            <th className="px-3 py-2 text-right">Test Win %</th>
                            <th className="px-3 py-2 text-right">Risk : Reward</th>
                            <th className="px-3 py-2 text-right">Profit Factor</th>
                            <th className="px-3 py-2 text-right">Test Profit</th>
                            <th className="px-3 py-2 text-right">Final Proof</th>
                          </tr>
                        </thead>
                        <tbody>
                          {combo.allRegimesBreakdown.map((rb) => {
                            const isSelected = rb.regime === combo.regime;
                            const isPoor = combo.poorRegimes.some((p) => p.regime === rb.regime);
                            const rbRr = formatRiskRewardRatio(rb.oosMetrics);
                            return (
                              <tr
                                key={rb.regime}
                                className={`border-b border-[#1B2230] text-xs ${
                                  isSelected ? 'bg-[#161B26]' : ''
                                }`}
                              >
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-2 font-medium text-[#E6EDF3]">
                                    <span>{rb.regime}</span>
                                    {isSelected && (
                                      <span className="font-mono text-[10px] text-[#38BDF8]">
                                        BEST CONDITION
                                      </span>
                                    )}
                                    {isPoor && !isSelected && (
                                      <span className="font-mono text-[10px] text-[#F6465D]">
                                        AVOID
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-[#8B949E]">
                                    {regimeSubtitle(rb.regime)}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                                  {rb.barsInRegime}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                                  {rb.isMetrics.trades}t /{' '}
                                  <span
                                    className={
                                      rb.isMetrics.expectancyR >= 0
                                        ? 'text-[#0ECB81]'
                                        : 'text-[#F6465D]'
                                    }
                                  >
                                    {rb.isMetrics.expectancyR >= 0 ? '+' : ''}
                                    {rb.isMetrics.expectancyR.toFixed(2)}R
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                                  {rb.oosMetrics.trades}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                                  {rb.oosMetrics.trades > 0
                                    ? `${rb.oosMetrics.winRate.toFixed(1)}%`
                                    : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-[#38BDF8]">
                                  {rb.oosMetrics.trades > 0 ? rbRr.ratioText : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                                  {rb.oosMetrics.profitFactor !== null
                                    ? `${rb.oosMetrics.profitFactor.toFixed(2)}×`
                                    : '—'}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono tabular-nums ${
                                    rb.oosMetrics.trades === 0
                                      ? 'text-[#6E7681]'
                                      : rb.oosMetrics.netReturnPercent >= 0
                                        ? 'text-[#0ECB81]'
                                        : 'text-[#F6465D]'
                                  }`}
                                >
                                  {rb.oosMetrics.trades > 0
                                    ? `${rb.oosMetrics.netReturnPercent >= 0 ? '+' : ''}${rb.oosMetrics.netReturnPercent.toFixed(2)}%`
                                    : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                                  {rb.holdoutMetrics.trades > 0
                                    ? `${rb.holdoutMetrics.trades}t · ${rb.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}${rb.holdoutMetrics.netReturnPercent.toFixed(1)}%`
                                    : '0 trades'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Best Trading Times (5 UTC Sessions Breakdown) */}
                  <div className="border border-[#222938] bg-[#12161F]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2.5">
                      <span className="text-xs font-semibold text-[#E6EDF3] inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-[#38BDF8]" />
                        <span>
                          Best Trading Times (5 Global Sessions · {combo.symbol} {combo.timeframe})
                        </span>
                        <HintBadge termKey="sessionTime" align="left" />
                      </span>
                      <span className="text-[11px] font-mono text-[#8B949E]">
                        Timezone converted to <strong className="text-[#C9D1D9]">{timezone}</strong>
                      </span>
                    </div>
                    {sessionRows.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                              <th className="px-3 py-2">Trading Session (UTC)</th>
                              <th className="px-3 py-2">Your Local Time ({timezone})</th>
                              <th className="px-3 py-2 text-right">Trades</th>
                              <th className="px-3 py-2 text-right">Win %</th>
                              <th className="px-3 py-2 text-right">Avg R / Trade</th>
                              <th className="px-3 py-2 text-right">Profit Factor</th>
                              <th className="px-3 py-2 text-right">Profit %</th>
                              <th className="px-3 py-2 text-right">Final Proof</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionRows.map((sr) => {
                              const isBest = combo.bestSession === sr.session;
                              const isAvoid =
                                (combo.avoidSessions?.includes(sr.session) ?? false) ||
                                (sr.preHoldoutTrades >= 2 &&
                                  (sr.expectancyR < 0 || sr.netReturnPercent < 0));
                              return (
                                <tr
                                  key={sr.session}
                                  className={`border-b border-[#1B2230] text-xs ${
                                    isBest ? 'bg-[#161B26]' : ''
                                  }`}
                                >
                                  <td className="px-3 py-2">
                                    <div className="flex items-center gap-2 font-medium text-[#E6EDF3]">
                                      <span>{sr.session}</span>
                                      {isBest && (
                                        <span className="font-mono text-[10px] text-[#0ECB81]">
                                          BEST TIME
                                        </span>
                                      )}
                                      {isAvoid && !isBest && (
                                        <span className="font-mono text-[10px] text-[#F6465D]">
                                          AVOID
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 font-mono text-[11px] text-[#8B949E]">
                                    {formatUtcRangeInTimezone(
                                      sr.utcStartHour,
                                      sr.utcEndHour,
                                      timezone
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                                    {sr.preHoldoutTrades}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                                    {sr.preHoldoutTrades > 0 ? `${sr.winRate.toFixed(1)}%` : '—'}
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${
                                      sr.preHoldoutTrades === 0
                                        ? 'text-[#6E7681]'
                                        : sr.expectancyR >= 0
                                          ? 'text-[#0ECB81]'
                                          : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {sr.preHoldoutTrades > 0
                                      ? `${sr.expectancyR >= 0 ? '+' : ''}${sr.expectancyR.toFixed(2)}R`
                                      : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E6EDF3]">
                                    {sr.profitFactor !== null
                                      ? `${sr.profitFactor.toFixed(2)}×`
                                      : '—'}
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right font-mono tabular-nums ${
                                      sr.preHoldoutTrades === 0
                                        ? 'text-[#6E7681]'
                                        : sr.netReturnPercent >= 0
                                          ? 'text-[#0ECB81]'
                                          : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {sr.preHoldoutTrades > 0
                                      ? `${sr.netReturnPercent >= 0 ? '+' : ''}${sr.netReturnPercent.toFixed(2)}%`
                                      : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[#8B949E]">
                                    {sr.holdoutTrades > 0
                                      ? `${sr.holdoutTrades}t · ${sr.holdoutExpectancyR >= 0 ? '+' : ''}${sr.holdoutExpectancyR.toFixed(2)}R`
                                      : '0 trades'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="px-4 py-4 text-xs text-[#8B949E]">
                        No session-level trade breakdown available for this setup yet.
                      </div>
                    )}
                  </div>

                  {/* Validation Audit, Strengths/Weaknesses & Rules */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="border border-[#222938] bg-[#12161F] p-3.5 space-y-2">
                      <div className="text-xs font-semibold text-[#E6EDF3]">
                        Why It Got This Rating
                      </div>
                      <ul className="space-y-1.5 text-[11px] text-[#C9D1D9]">
                        {combo.validationReasons.map((r, i) => (
                          <li key={i} className="flex items-start gap-2">
                            {combo.validationStatus === 'Validated' && i === 0 ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-[#0ECB81] shrink-0 mt-0.5" />
                            ) : combo.validationStatus === 'Failed Validation' && i === 0 ? (
                              <XCircle className="h-3.5 w-3.5 text-[#F6465D] shrink-0 mt-0.5" />
                            ) : (
                              <span className="text-[#38BDF8] font-mono">·</span>
                            )}
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="border border-[#222938] bg-[#12161F] p-3.5 space-y-2">
                      <div className="text-xs font-semibold text-[#E6EDF3]">
                        Strengths & Weaknesses
                      </div>
                      <div className="space-y-1 text-[11px]">
                        {combo.strengths.map((s, i) => (
                          <div key={`st-${i}`} className="text-[#0ECB81]">
                            + {s}
                          </div>
                        ))}
                        {combo.weaknesses.map((w, i) => (
                          <div key={`wk-${i}`} className="text-[#F59E0B]">
                            - {w}
                          </div>
                        ))}
                        {combo.strengths.length === 0 && combo.weaknesses.length === 0 && (
                          <div className="text-[#8B949E]">Balanced baseline sample metrics</div>
                        )}
                      </div>
                    </div>

                    <div className="border border-[#222938] bg-[#12161F] p-3.5 space-y-2">
                      <div className="text-xs font-semibold text-[#E6EDF3]">
                        Best Trading Conditions & Strategy Rules
                      </div>
                      <div className="space-y-1 text-[11px] text-[#C9D1D9]">
                        {combo.recommendedConditions.map((rc, i) => (
                          <div key={i}>• {rc}</div>
                        ))}
                      </div>
                      <div className="pt-2 border-t border-[#1B2230] text-[10px] text-[#8B949E]">
                        Entry: {combo.strategy.entryRules.join(' · ')}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Trade Execution Logs */}
              {showTradesSection && (
                <div className="border border-[#222938] bg-[#12161F]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#E6EDF3]">
                      <ListChecks className="h-4 w-4 text-[#38BDF8]" />
                      <span>
                        Trade Execution Logs ({filteredTrades.length} of{' '}
                        {detail.annotatedTrades.length} trades)
                      </span>
                      <span className="text-[10px] font-normal text-[#8B949E]">
                        Click any trade row for entry rationale & SL/TP details
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <select
                        value={splitFilter}
                        onChange={(e) => setSplitFilter(e.target.value as TradeSplitFilter)}
                        className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[#C9D1D9] outline-none"
                      >
                        <option value="ALL">All Time Periods</option>
                        <option value="IS">Training Period (IS)</option>
                        <option value="OOS">Unseen Test (OOS)</option>
                        <option value="HOLDOUT">Final Check (Holdout)</option>
                      </select>
                      <select
                        value={regimeFilter}
                        onChange={(e) =>
                          setRegimeFilter(e.target.value as 'ALL' | MarketRegimeType)
                        }
                        className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[#C9D1D9] outline-none"
                      >
                        <option value="ALL">All Market Conditions</option>
                        {REGIMES_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <select
                        value={outcomeFilter}
                        onChange={(e) => setOutcomeFilter(e.target.value as TradeOutcomeFilter)}
                        className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[#C9D1D9] outline-none"
                      >
                        <option value="ALL">All Trades</option>
                        <option value="WINS">Winners</option>
                        <option value="LOSSES">Losses</option>
                        <option value="BUY">Longs</option>
                        <option value="SELL">Shorts</option>
                      </select>
                    </div>
                  </div>

                  <div
                    className={`${
                      sectionTab === 'trades' ? 'max-h-[56vh]' : 'max-h-80'
                    } overflow-y-auto overflow-x-auto`}
                  >
                    <table className="w-full text-left border-collapse">
                      <thead className="sticky top-0 bg-[#0B0E14] z-10">
                        <tr className="border-b border-[#222938] text-[10px] uppercase tracking-wider text-[#8B949E]">
                          <th className="px-3 py-2">#</th>
                          <th className="px-3 py-2">Period</th>
                          <th className="px-3 py-2">Market Mood</th>
                          <th className="px-3 py-2">Action</th>
                          <th className="px-3 py-2">Entry → Exit</th>
                          <th className="px-3 py-2 text-right">Entry Price</th>
                          <th className="px-3 py-2 text-right">SL / TP1</th>
                          <th className="px-3 py-2 text-right">Exit Price</th>
                          <th className="px-3 py-2">Closed By</th>
                          <th className="px-3 py-2 text-right">Peak / Dip (R)</th>
                          <th className="px-3 py-2 text-right">Result (R)</th>
                          <th className="px-3 py-2 text-right">Net PnL (Fees)</th>
                          <th className="px-3 py-2 text-right">See Chart</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedTrades.map((t) => {
                          const isExpanded = expandedTradeId === t.id;
                          const tp1 = t.takeProfits[0]?.price;
                          return (
                            <Fragment key={t.id}>
                              <tr
                                onClick={() =>
                                  setExpandedTradeId((prev) => (prev === t.id ? null : t.id))
                                }
                                className="border-b border-[#1B2230] text-[11px] hover:bg-[#161B26] cursor-pointer"
                              >
                                <td className="px-3 py-1.5 font-mono tabular-nums text-[#8B949E] whitespace-nowrap">
                                  <span className="inline-flex items-center gap-1">
                                    {isExpanded ? (
                                      <ChevronDown className="h-3 w-3 text-[#38BDF8]" />
                                    ) : (
                                      <ChevronRight className="h-3 w-3 opacity-50" />
                                    )}
                                    {t.tradeNumber}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5 font-mono text-[10px]">
                                  <span
                                    className={
                                      t.split === 'OOS'
                                        ? 'text-[#0ECB81]'
                                        : t.split === 'HOLDOUT'
                                          ? 'text-[#38BDF8]'
                                          : 'text-[#8B949E]'
                                    }
                                  >
                                    {splitPlainName(t.split)}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5 text-[#C9D1D9] whitespace-nowrap">
                                  {t.entryRegime}
                                </td>
                                <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                                  <span
                                    className={`inline-flex items-center gap-0.5 font-semibold ${
                                      t.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                    }`}
                                  >
                                    {t.direction === 'BUY' ? (
                                      <ArrowUpRight className="h-3 w-3" />
                                    ) : (
                                      <ArrowDownRight className="h-3 w-3" />
                                    )}
                                    {t.direction}
                                  </span>
                                  <span className="ml-1 text-[9px] text-[#6E7681]">
                                    {t.entryMode === 'limit_retest' ? 'LMT' : 'MKT'}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5 font-mono tabular-nums text-[#8B949E] whitespace-nowrap">
                                  <div className="text-[#C9D1D9]">
                                    {fmtDate(t.entryTime, timezone)}
                                  </div>
                                  <div className="text-[10px] text-[#6E7681]">
                                    {fmtDate(t.exitTime, timezone)} · {t.barsHeld}b
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[#E6EDF3]">
                                  {t.entryPrice.toFixed(meta.pricePrecision)}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums whitespace-nowrap">
                                  <div className="text-[#F6465D]">
                                    SL {t.initialStopLoss.toFixed(meta.pricePrecision)}
                                  </div>
                                  <div className="text-[#0ECB81]">
                                    TP {tp1 ? tp1.toFixed(meta.pricePrecision) : '—'}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[#C9D1D9]">
                                  {t.exitPrice.toFixed(meta.pricePrecision)}
                                </td>
                                <td className="px-3 py-1.5 font-mono text-[10px] text-[#8B949E] whitespace-nowrap">
                                  {formatExitReason(t.exitReason)}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[10px] tabular-nums whitespace-nowrap">
                                  <span className="text-[#0ECB81]">+{t.mfeR.toFixed(1)}R</span>
                                  <span className="text-[#6E7681]"> / </span>
                                  <span className="text-[#F6465D]">-{t.maeR.toFixed(1)}R</span>
                                </td>
                                <td
                                  className={`px-3 py-1.5 text-right font-mono font-semibold tabular-nums whitespace-nowrap ${
                                    t.realizedR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                  }`}
                                >
                                  {t.realizedR >= 0 ? '+' : ''}
                                  {t.realizedR.toFixed(2)}R
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                                  <div
                                    className={
                                      t.netPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                    }
                                  >
                                    {t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(2)}
                                  </div>
                                  <div className="text-[10px] text-[#6E7681]">
                                    fee -${t.feesAndSlippage.toFixed(2)}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-right">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onJumpToChart(
                                        combo.symbol,
                                        combo.timeframe,
                                        t.signalTime,
                                        t.exitTime,
                                        t.id
                                      );
                                    }}
                                    title="Show this exact trade on the live chart"
                                    className="inline-flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-1.5 py-0.5 text-[10px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                                  >
                                    <Crosshair className="h-3 w-3" />
                                  </button>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr className="bg-[#0F141D] border-b border-[#222938]">
                                  <td colSpan={13} className="px-5 py-2.5 text-[11px] space-y-1">
                                    <div className="flex flex-wrap items-center gap-3 text-[#C9D1D9]">
                                      <span>
                                        <strong className="text-[#38BDF8]">Entry Logic:</strong>{' '}
                                        {t.entryRationale.join(' · ') || 'Rule trigger'}
                                      </span>
                                      <span className="text-[#30363D]">|</span>
                                      <span>
                                        <strong className="text-[#8B949E]">Exit Note:</strong>{' '}
                                        {t.exitNote || formatExitReason(t.exitReason)}
                                      </span>
                                      <span className="text-[#30363D]">|</span>
                                      <span className="font-mono text-[#E6EDF3]">
                                        Account After Trade: $
                                        {t.equityAfter.toLocaleString('en-US', {
                                          minimumFractionDigits: 2,
                                        })}
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                        {filteredTrades.length === 0 && (
                          <tr>
                            <td colSpan={13} className="px-3 py-6 text-center text-xs text-[#8B949E]">
                              No trades match the current split / market mood / outcome filters.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {!showAllTrades && filteredTrades.length > 120 && (
                    <div className="border-t border-[#222938] px-4 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => setShowAllTrades(true)}
                        className="border border-[#222938] bg-[#0B0E14] px-3 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                      >
                        Show All {filteredTrades.length} Trades ({filteredTrades.length - 120} more)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
