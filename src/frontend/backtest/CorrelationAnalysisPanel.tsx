import { GitCompareArrows, Layers, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import {
  analyzeAnchorCorrelations,
  buildCorrelationMatrix,
  selectMatrixStrategies,
  simulateBlendedPortfolio,
  type CorrelationBucket,
  type CorrelationMatrixCell,
  type MatrixPreset,
  type StrategyCorrelationPeer,
} from '../../backtest/correlation.ts';
import type {
  BacktestRunResult,
  BacktestStrategyId,
  BacktestStrategyResult,
} from '../../shared/types/index.ts';

interface CorrelationAnalysisPanelProps {
  run: BacktestRunResult;
  selectedStrategyId: BacktestStrategyId | null;
  onSelectStrategy: (id: BacktestStrategyId) => void;
  timezone: string;
}

type PeerListMode = 'redundant' | 'diversifiers';

function fmtCorr(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}`;
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function cellBackground(r: number, isDiag: boolean): string {
  if (isDiag) return 'rgba(56, 189, 248, 0.22)';
  if (r >= 0.85) return 'rgba(246, 70, 93, 0.48)';
  if (r >= 0.7) return 'rgba(246, 70, 93, 0.30)';
  if (r >= 0.45) return 'rgba(245, 158, 11, 0.22)';
  if (r >= 0.15) return 'rgba(139, 148, 158, 0.12)';
  if (r > -0.2) return 'rgba(22, 27, 38, 0.95)';
  return 'rgba(14, 203, 129, 0.32)';
}

function cellTextClass(r: number, isDiag: boolean): string {
  if (isDiag) return 'text-[#38BDF8] font-semibold';
  if (r >= 0.7) return 'text-[#FF8A98] font-semibold';
  if (r >= 0.45) return 'text-[#F59E0B]';
  if (r <= -0.2) return 'text-[#0ECB81] font-semibold';
  return 'text-[#C9D1D9]';
}

function bucketBarColor(tone: CorrelationBucket['tone']): string {
  switch (tone) {
    case 'hedge':
      return '#0ECB81';
    case 'uncorrelated':
      return '#38BDF8';
    case 'low':
      return '#60A5FA';
    case 'moderate':
      return '#F59E0B';
    case 'high':
      return '#FB7185';
    case 'duplicate':
      return '#F6465D';
  }
}

function BucketTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: CorrelationBucket }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl">
      <div className="mb-1 font-semibold text-[#E6EDF3]">{d.rangeLabel}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums">
        <span className="text-[#8B949E]">Strategies in Bucket:</span>
        <span className="text-[#E6EDF3]">{d.count.toLocaleString('en-US')}</span>
        <span className="text-[#8B949E]">Profitable in Bucket:</span>
        <span className="text-[#0ECB81]">{d.profitableCount.toLocaleString('en-US')}</span>
      </div>
    </div>
  );
}

function BlendTooltip({
  active,
  payload,
  anchorName,
  peerName,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; anchorReturnPct: number; peerReturnPct: number; blendedReturnPct: number } }>;
  anchorName: string;
  peerName: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-[#222938] bg-[#12161F] p-2.5 text-[11px] text-[#E6EDF3] shadow-xl font-mono tabular-nums">
      <div className="mb-1 text-[10px] text-[#8B949E]">{d.label}</div>
      <div className="flex justify-between gap-4">
        <span className="truncate max-w-[160px] text-[#38BDF8]">{anchorName}:</span>
        <span>
          {d.anchorReturnPct >= 0 ? '+' : ''}
          {d.anchorReturnPct.toFixed(2)}%
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="truncate max-w-[160px] text-[#F59E0B]">{peerName}:</span>
        <span>
          {d.peerReturnPct >= 0 ? '+' : ''}
          {d.peerReturnPct.toFixed(2)}%
        </span>
      </div>
      <div className="mt-1 flex justify-between gap-4 border-t border-[#222938] pt-1 font-semibold text-[#0ECB81]">
        <span>50/50 Risk Blend:</span>
        <span>
          {d.blendedReturnPct >= 0 ? '+' : ''}
          {d.blendedReturnPct.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

export function CorrelationAnalysisPanel({
  run,
  selectedStrategyId,
  onSelectStrategy,
  timezone,
}: CorrelationAnalysisPanelProps) {
  const activeStrategies = useMemo(
    () => run.strategies.filter((s) => s.metrics.totalTrades > 0 && s.equityCurve.length >= 3),
    [run.strategies]
  );

  const strategyMap = useMemo(
    () => new Map<BacktestStrategyId, BacktestStrategyResult>(activeStrategies.map((s) => [s.strategy.id, s])),
    [activeStrategies]
  );

  const defaultAnchorId = useMemo(() => {
    if (selectedStrategyId && strategyMap.has(selectedStrategyId)) return selectedStrategyId;
    return activeStrategies[0]?.strategy.id ?? '';
  }, [selectedStrategyId, strategyMap, activeStrategies]);

  const [anchorId, setAnchorId] = useState<BacktestStrategyId>(defaultAnchorId);
  const [peerId, setPeerId] = useState<BacktestStrategyId>('');
  const [preset, setPreset] = useState<MatrixPreset>('top12');
  const [peerListMode, setPeerListMode] = useState<PeerListMode>('redundant');
  const [hoveredCell, setHoveredCell] = useState<{
    cell: CorrelationMatrixCell;
    rowStrat: BacktestStrategyResult;
    colStrat: BacktestStrategyResult;
  } | null>(null);

  // Sync anchor on new run or when current anchor is absent
  useEffect(() => {
    if (!strategyMap.has(anchorId)) {
      setAnchorId(defaultAnchorId);
    }
  }, [anchorId, defaultAnchorId, strategyMap]);

  const report = useMemo(() => {
    if (!anchorId || activeStrategies.length < 2) return null;
    return analyzeAnchorCorrelations(anchorId, activeStrategies, run.config.initialCapital);
  }, [anchorId, activeStrategies, run.config.initialCapital]);

  // Default comparison peer to top diversifier (or first non-anchor peer) so risk reduction shows immediately
  useEffect(() => {
    if (!report) return;
    if (!peerId || peerId === report.anchor.strategy.id || !strategyMap.has(peerId)) {
      const candidate =
        report.diversifierPeers[0]?.strategy.strategy.id ??
        report.redundantPeers[0]?.strategy.strategy.id ??
        '';
      if (candidate) setPeerId(candidate);
    }
  }, [report, peerId, strategyMap]);

  const matrixStrategies = useMemo(
    () => selectMatrixStrategies(preset, activeStrategies, run.config.initialCapital, 12),
    [preset, activeStrategies, run.config.initialCapital]
  );

  const matrix = useMemo(
    () => buildCorrelationMatrix(matrixStrategies, run.config.initialCapital),
    [matrixStrategies, run.config.initialCapital]
  );

  const peerStrategy = useMemo(() => {
    if (!report) return null;
    return (
      strategyMap.get(peerId) ??
      report.diversifierPeers[0]?.strategy ??
      report.redundantPeers[0]?.strategy ??
      null
    );
  }, [report, peerId, strategyMap]);

  const blendSummary = useMemo(() => {
    if (!report || !peerStrategy) return null;
    return simulateBlendedPortfolio(report.anchor, peerStrategy, run.config.initialCapital);
  }, [report, peerStrategy, run.config.initialCapital]);

  const blendChartData = useMemo(() => {
    if (!blendSummary) return [];
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return blendSummary.series.map((pt) => ({
      label: fmt.format(new Date(pt.time * 1000)),
      anchorReturnPct: pt.anchorReturnPct,
      peerReturnPct: pt.peerReturnPct,
      blendedReturnPct: pt.blendedReturnPct,
    }));
  }, [blendSummary, timezone]);

  // Anchor dropdown options: top 120 active strategies + currently selected anchor/inspected
  const anchorOptions = useMemo(() => {
    const slice = activeStrategies.slice(0, 120);
    if (anchorId && !slice.some((s) => s.strategy.id === anchorId)) {
      const a = strategyMap.get(anchorId);
      if (a) slice.push(a);
    }
    if (selectedStrategyId && !slice.some((s) => s.strategy.id === selectedStrategyId)) {
      const sel = strategyMap.get(selectedStrategyId);
      if (sel) slice.push(sel);
    }
    return slice;
  }, [activeStrategies, anchorId, selectedStrategyId, strategyMap]);

  if (!report || activeStrategies.length < 2) {
    return (
      <div className="border border-[#222938] bg-[#12161F] p-4 text-xs text-[#8B949E]">
        Correlation &amp; Position Overlap Analysis requires at least 2 active strategies with executed trades.
      </div>
    );
  }

  const displayedPeers: StrategyCorrelationPeer[] =
    peerListMode === 'redundant' ? report.redundantPeers : report.diversifierPeers;

  const overlapRatioPct =
    report.activeCount > 1
      ? ((report.highOverlapCount / (report.activeCount - 1)) * 100).toFixed(1)
      : '0.0';

  return (
    <div className="space-y-3 border-t border-[#222938] pt-3">
      {/* Header & Anchor Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-[#38BDF8]" />
          <div>
            <h4 className="text-xs font-semibold text-[#E6EDF3]">
              Strategy Correlation &amp; Position Overlap Analysis ({report.activeCount.toLocaleString('en-US')} Active Peers)
            </h4>
            <p className="text-[11px] text-[#8B949E]">
              Detects duplicate signal curves (high r &amp; concurrent trade overlap) and uncovers low-correlation diversifiers to cut portfolio drawdown
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-[#8B949E]">
            <span className="whitespace-nowrap">Anchor Strategy:</span>
            <select
              value={report.anchor.strategy.id}
              onChange={(e) => setAnchorId(e.target.value)}
              aria-label="Correlation Anchor Strategy"
              className="max-w-[280px] border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[11px] text-[#E6EDF3] outline-none focus:border-[#38BDF8]"
            >
              {anchorOptions.map((s) => (
                <option key={s.strategy.id} value={s.strategy.id}>
                  #{s.rank} · {s.strategy.name} ({s.metrics.netProfit >= 0 ? '+' : ''}
                  {s.metrics.netReturnPercent.toFixed(1)}%)
                </option>
              ))}
            </select>
          </label>

          {selectedStrategyId &&
            selectedStrategyId !== report.anchor.strategy.id &&
            strategyMap.has(selectedStrategyId) && (
              <button
                type="button"
                onClick={() => setAnchorId(selectedStrategyId)}
                className="border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Use Inspected Strategy
              </button>
            )}
        </div>
      </div>

      {/* 4 Correlation & Risk KPI Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] text-[#8B949E]">
            <span>High-Overlap Peers (r ≥ 0.75)</span>
            <TriangleAlert className="h-3.5 w-3.5 text-[#F6465D]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#F6465D] tabular-nums">
            {report.highOverlapCount.toLocaleString('en-US')}{' '}
            <span className="text-xs font-normal text-[#8B949E]">({overlapRatioPct}%)</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Peers closely mirroring #{report.anchor.rank} equity curve
          </div>
        </div>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] text-[#8B949E]">
            <span>Uncorrelated / Inverse Peers</span>
            <ShieldCheck className="h-3.5 w-3.5 text-[#0ECB81]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#0ECB81] tabular-nums">
            {(report.uncorrelatedCount + report.inverseHedgeCount).toLocaleString('en-US')}{' '}
            <span className="text-xs font-normal text-[#8B949E]">
              ({report.inverseHedgeCount} inverse)
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Low-overlap candidates (r ≤ 0.25) for risk diversification
          </div>
        </div>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] text-[#8B949E]">
            <span>Matrix Mean Correlation</span>
            <Layers className="h-3.5 w-3.5 text-[#F59E0B]" />
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[#F59E0B] tabular-nums">
            {fmtCorr(matrix.avgPairwiseCorrelation)}{' '}
            <span className="text-xs font-normal text-[#8B949E]">avg r</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            Avg Same-Dir Position Overlap: {matrix.avgSameDirOverlapPct.toFixed(1)}%
          </div>
        </div>

        <div className="border border-[#222938] bg-[#12161F] p-2.5">
          <div className="flex items-center justify-between text-[10px] text-[#8B949E]">
            <span>50/50 Blend Risk Reduction</span>
            <ShieldCheck className="h-3.5 w-3.5 text-[#38BDF8]" />
          </div>
          <div
            className={`mt-1 font-mono text-base font-semibold tabular-nums ${
              (blendSummary?.drawdownReductionPctPoints ?? 0) >= 0
                ? 'text-[#0ECB81]'
                : 'text-[#F6465D]'
            }`}
          >
            {blendSummary
              ? `${blendSummary.blendedMaxDdPct.toFixed(2)}% DD`
              : '—'}
            {blendSummary && (
              <span className="ml-1.5 text-xs font-normal text-[#8B949E]">
                ({blendSummary.drawdownReductionPctPoints >= 0 ? '-' : '+'}
                {Math.abs(blendSummary.drawdownReductionRelativePct).toFixed(1)}%)
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
            {blendSummary
              ? `vs ${blendSummary.avgStandaloneMaxDdPct.toFixed(2)}% avg standalone DD`
              : 'Select pair to measure drawdown reduction'}
          </div>
        </div>
      </div>

      {/* Row 1: Correlation Matrix Heatmap (7 cols) + 1000+ Correlation Distribution Histogram (5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* Matrix Heatmap */}
        <div className="lg:col-span-7 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h5 className="text-xs font-semibold text-[#E6EDF3]">
                Pairwise Return Correlation Matrix ({matrix.strategies.length}×{matrix.strategies.length})
              </h5>
              <p className="text-[10px] text-[#8B949E]">
                Click any cell to simulate 50/50 portfolio blend · Red = overlapping risk, Green = hedge
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ['top12', 'Top 12 Ranked'],
                  ['category_leaders', 'Category Leaders'],
                  ['uncorrelated_basket', 'Uncorrelated Basket'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPreset(key)}
                  className={`border px-2 py-1 text-[10px] whitespace-nowrap shrink-0 cursor-pointer ${
                    preset === key
                      ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-medium'
                      : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px] tabular-nums">
              <thead>
                <tr>
                  <th className="p-1 text-left text-[#8B949E] font-normal">Strategy</th>
                  {matrix.strategies.map((col) => (
                    <th
                      key={col.strategy.id}
                      title={`#${col.rank} ${col.strategy.name}`}
                      className="p-1 text-center text-[#8B949E] font-normal whitespace-nowrap"
                    >
                      #{col.rank}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.strategies.map((rowStrat, rIdx) => (
                  <tr key={rowStrat.strategy.id}>
                    <td
                      title={`#${rowStrat.rank} ${rowStrat.strategy.name} (${rowStrat.strategy.category})`}
                      className="max-w-[130px] truncate pr-2 py-0.5 text-left font-sans text-[10px] text-[#C9D1D9]"
                    >
                      <button
                        type="button"
                        onClick={() => setAnchorId(rowStrat.strategy.id)}
                        className={`truncate hover:text-[#38BDF8] cursor-pointer ${
                          rowStrat.strategy.id === report.anchor.strategy.id
                            ? 'text-[#38BDF8] font-semibold'
                            : ''
                        }`}
                      >
                        #{rowStrat.rank} {rowStrat.strategy.name}
                      </button>
                    </td>
                    {matrix.cells[rIdx]?.map((cell, cIdx) => {
                      const colStrat = matrix.strategies[cIdx];
                      const isDiag = rIdx === cIdx;
                      const isPairSelected =
                        (cell.rowId === report.anchor.strategy.id &&
                          cell.colId === peerStrategy?.strategy.id) ||
                        (cell.colId === report.anchor.strategy.id &&
                          cell.rowId === peerStrategy?.strategy.id);
                      return (
                        <td key={cell.colId} className="p-0.5">
                          <button
                            type="button"
                            onMouseEnter={() =>
                              setHoveredCell({ cell, rowStrat, colStrat })
                            }
                            onMouseLeave={() => setHoveredCell(null)}
                            onClick={() => {
                              if (!isDiag) {
                                setAnchorId(rowStrat.strategy.id);
                                setPeerId(colStrat.strategy.id);
                              } else {
                                onSelectStrategy(rowStrat.strategy.id);
                              }
                            }}
                            style={{ backgroundColor: cellBackground(cell.correlation, isDiag) }}
                            className={`flex h-6 w-full min-w-[34px] items-center justify-center border text-[9.5px] cursor-pointer ${
                              isPairSelected
                                ? 'border-[#38BDF8]'
                                : 'border-[#1D2432] hover:border-[#8B949E]'
                            } ${cellTextClass(cell.correlation, isDiag)}`}
                          >
                            {cell.correlation.toFixed(2)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cell Hover Telemetry Strip */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#1D2432] pt-2 text-[10px] font-mono tabular-nums text-[#8B949E]">
            {hoveredCell ? (
              <>
                <span className="truncate max-w-[380px] text-[#E6EDF3]">
                  #{hoveredCell.rowStrat.rank} {hoveredCell.rowStrat.strategy.name} ↔ #
                  {hoveredCell.colStrat.rank} {hoveredCell.colStrat.strategy.name}
                </span>
                <span>
                  r ={' '}
                  <strong className="text-[#E6EDF3]">
                    {fmtCorr(hoveredCell.cell.correlation)}
                  </strong>{' '}
                  · Same-Dir Overlap:{' '}
                  <strong className="text-[#F59E0B]">
                    {hoveredCell.cell.sameDirOverlapPct.toFixed(1)}%
                  </strong>{' '}
                  · Hedge Overlap:{' '}
                  <strong className="text-[#0ECB81]">
                    {hoveredCell.cell.oppDirOverlapPct.toFixed(1)}%
                  </strong>
                </span>
              </>
            ) : (
              <span>
                Hover any matrix cell to inspect exact return correlation &amp; concurrent position overlap %
              </span>
            )}
          </div>
        </div>

        {/* Correlation Distribution Histogram Across All 1,000+ Strategies */}
        <div className="lg:col-span-5 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2">
            <h5 className="text-xs font-semibold text-[#E6EDF3]">
              Similarity Distribution Across All {report.activeCount - 1} Active Peers
            </h5>
            <p className="text-[10px] text-[#8B949E]">
              How all strategies correlate with #{report.anchor.rank} ({report.anchor.strategy.name})
            </p>
          </div>

          <div className="h-[245px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={report.distributionBuckets}
                margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
              >
                <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={{ stroke: '#222938' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip content={<BucketTooltip />} cursor={{ fill: '#1C2331', opacity: 0.45 }} />
                <Bar dataKey="count" maxBarSize={36}>
                  {report.distributionBuckets.map((entry) => (
                    <Cell key={entry.bucket} fill={bucketBarColor(entry.tone)} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Row 2: Redundant / Diversifier Scanner Table (6 cols) + 50/50 Risk Blend Simulator (6 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* Peer Similarity & Overlap Table */}
        <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h5 className="text-xs font-semibold text-[#E6EDF3]">
                {peerListMode === 'redundant'
                  ? 'Highest-Overlap Peers (Redundant Risk Alert)'
                  : 'Top Profitable Diversifiers (Lowest Correlation)'}
              </h5>
              <p className="text-[10px] text-[#8B949E]">
                Click a row to compare against #{report.anchor.rank} in the 50/50 Risk Blend chart
              </p>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPeerListMode('redundant')}
                className={`border px-2 py-1 text-[10px] whitespace-nowrap shrink-0 cursor-pointer ${
                  peerListMode === 'redundant'
                    ? 'border-[#F6465D] bg-[#F6465D]/15 text-[#F6465D] font-medium'
                    : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                }`}
              >
                Overlapping Risk
              </button>
              <button
                type="button"
                onClick={() => setPeerListMode('diversifiers')}
                className={`border px-2 py-1 text-[10px] whitespace-nowrap shrink-0 cursor-pointer ${
                  peerListMode === 'diversifiers'
                    ? 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81] font-medium'
                    : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-white'
                }`}
              >
                Best Diversifiers
              </button>
            </div>
          </div>

          <div className="max-h-[245px] overflow-auto">
            <table className="w-full text-left font-mono text-[11px] tabular-nums">
              <thead className="sticky top-0 z-10 border-b border-[#222938] bg-[#12161F] text-[10px] text-[#8B949E]">
                <tr>
                  <th className="py-1.5 pr-2">Rank / Strategy</th>
                  <th className="py-1.5 px-2 text-right">Corr r</th>
                  <th className="py-1.5 px-2 text-right">Pos Overlap</th>
                  <th className="py-1.5 px-2 text-right">Profit</th>
                  <th className="py-1.5 pl-2 text-right">Max DD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1D2432]">
                {displayedPeers.map((p) => {
                  const isCompared = peerStrategy?.strategy.id === p.strategy.strategy.id;
                  const rColor =
                    p.correlation >= 0.75
                      ? 'text-[#F6465D]'
                      : p.correlation <= 0.15
                        ? 'text-[#0ECB81]'
                        : 'text-[#F59E0B]';
                  return (
                    <tr
                      key={p.strategy.strategy.id}
                      onClick={() => setPeerId(p.strategy.strategy.id)}
                      className={`cursor-pointer ${
                        isCompared ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                      }`}
                    >
                      <td className="max-w-[230px] py-1.5 pr-2 font-sans">
                        <div className="truncate font-medium text-[#E6EDF3]">
                          <span className="font-mono text-[#38BDF8]">#{p.strategy.rank}</span>{' '}
                          {p.strategy.strategy.name}
                        </div>
                        <div className="text-[10px] text-[#8B949E]">
                          {p.strategy.strategy.category} · {p.strategy.metrics.totalTrades} trades
                        </div>
                      </td>
                      <td className={`px-2 py-1.5 text-right font-semibold ${rColor}`}>
                        {fmtCorr(p.correlation)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#C9D1D9]">
                        {p.overlap.sameDirOverlapPct.toFixed(1)}%
                      </td>
                      <td
                        className={`px-2 py-1.5 text-right ${
                          p.strategy.metrics.netProfit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                        }`}
                      >
                        {fmtUsd(p.strategy.metrics.netProfit)}
                      </td>
                      <td className="py-1.5 pl-2 text-right text-[#F59E0B]">
                        {p.strategy.metrics.maxDrawdownPercent.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* 50/50 Blended Risk Reduction Comparison Chart */}
        <div className="lg:col-span-6 border border-[#222938] bg-[#12161F] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h5 className="truncate text-xs font-semibold text-[#E6EDF3]">
                Portfolio Risk Blend: #{report.anchor.rank} + #{peerStrategy?.rank ?? '—'} (r ={' '}
                {blendSummary ? fmtCorr(blendSummary.correlation) : '—'})
              </h5>
              <p className="font-mono text-[10px] text-[#8B949E] tabular-nums">
                {blendSummary
                  ? `Same-Dir Overlap ${blendSummary.overlap.sameDirOverlapPct.toFixed(1)}% · Blend Return ${blendSummary.blendedReturnPct >= 0 ? '+' : ''}${blendSummary.blendedReturnPct.toFixed(2)}% · Blend DD ${blendSummary.blendedMaxDdPct.toFixed(2)}%`
                  : 'Select a comparison peer'}
              </p>
            </div>

            {peerStrategy && (
              <button
                type="button"
                onClick={() => onSelectStrategy(peerStrategy.strategy.id)}
                className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[10px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Inspect Peer #{peerStrategy.rank}
              </button>
            )}
          </div>

          <div className="mb-1.5 flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#8B949E]">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-[#38BDF8]" /> #{report.anchor.rank} Anchor
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-[#F59E0B]" /> #{peerStrategy?.rank ?? '—'} Peer
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-[#0ECB81]" /> 50/50 Blended Curve
            </span>
          </div>

          <div className="h-[222px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={blendChartData} margin={{ top: 6, right: 10, left: 0, bottom: 2 }}>
                <CartesianGrid stroke="#1D2432" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  minTickGap={34}
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={{ stroke: '#222938' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#8B949E', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={44}
                />
                <Tooltip
                  content={
                    <BlendTooltip
                      anchorName={`#${report.anchor.rank} ${report.anchor.strategy.name}`}
                      peerName={peerStrategy ? `#${peerStrategy.rank} ${peerStrategy.strategy.name}` : 'Peer'}
                    />
                  }
                />
                <ReferenceLine y={0} stroke="#30363D" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="anchorReturnPct"
                  stroke="#38BDF8"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="peerReturnPct"
                  stroke="#F59E0B"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="blendedReturnPct"
                  stroke="#0ECB81"
                  strokeWidth={2.2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
