import * as d3 from 'd3';
import { ArrowRight, CheckCircle2, Flame, Info, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  MarketRegimeType,
  StrategyDiscoveryCombination,
  Timeframe,
  ValidationStatus,
} from '../../shared/types/index.ts';
import { formatRiskRewardRatio, HintBadge, SimpleValidationLabel } from './HintBadge.tsx';

type HeatmapMetric = 'oosScore' | 'expectancyR' | 'netReturnPercent' | 'profitFactor' | 'winRate';

interface CellDatum {
  key: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  combo: StrategyDiscoveryCombination | null;
  matchingCombos: StrategyDiscoveryCombination[];
  value: number | null;
  validatedCount: number;
}

const METRIC_OPTIONS: Array<{
  key: HeatmapMetric;
  label: string;
  plainGuide: string;
}> = [
  {
    key: 'oosScore',
    label: 'Overall Score (0–100)',
    plainGuide: 'Score out of 100 on unseen test data — 60+ is strong, 40–59 is decent, below 40 is weak.',
  },
  {
    key: 'expectancyR',
    label: 'Avg Profit / Trade (R)',
    plainGuide: 'Average reward earned per trade vs 1 risk unit (e.g. +0.40R means each trade averages +0.40× your stop-loss risk).',
  },
  {
    key: 'netReturnPercent',
    label: 'Test Profit %',
    plainGuide: 'Total account growth % during the unseen test period after fees & slippage.',
  },
  {
    key: 'profitFactor',
    label: 'Profit Factor (Wins ÷ Losses)',
    plainGuide: 'Total profit from winning trades divided by total loss from losing trades — 1.0 is breakeven, 1.5+ is good, 2.0+ is strong.',
  },
  {
    key: 'winRate',
    label: 'Win Rate %',
    plainGuide: 'Percentage of trades in the unseen test that closed in profit.',
  },
];

const REGIME_OPTIONS: Array<'ALL' | MarketRegimeType> = [
  'ALL',
  'Trending',
  'Ranging',
  'High Volatility',
  'Low Volatility',
  'Transitional',
];

function extractMetric(c: StrategyDiscoveryCombination, metric: HeatmapMetric): number {
  switch (metric) {
    case 'oosScore':
      return c.oosScore;
    case 'expectancyR':
      return c.oosMetrics.expectancyR;
    case 'netReturnPercent':
      return c.oosMetrics.netReturnPercent;
    case 'profitFactor':
      return Math.min(5, c.oosMetrics.profitFactor ?? 0);
    case 'winRate':
      return c.oosMetrics.winRate;
  }
}

function formatCellMetricValue(val: number, metric: HeatmapMetric): string {
  switch (metric) {
    case 'oosScore':
      return `${val.toFixed(0)} / 100`;
    case 'expectancyR':
      return `${val >= 0 ? '+' : ''}${val.toFixed(2)}R / tr`;
    case 'netReturnPercent':
      return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
    case 'profitFactor':
      return `${val.toFixed(2)}×`;
    case 'winRate':
      return `${val.toFixed(0)}% wins`;
  }
}

function statusColorHex(status: ValidationStatus): string {
  switch (status) {
    case 'Validated':
      return '#0ECB81';
    case 'Preliminary Candidate':
      return '#F59E0B';
    case 'Insufficient Evidence':
      return '#8B949E';
    case 'Failed Validation':
      return '#F6465D';
  }
}

function shortTrustTag(status: ValidationStatus): string {
  switch (status) {
    case 'Validated':
      return 'Verified';
    case 'Preliminary Candidate':
      return 'Promising';
    case 'Insufficient Evidence':
      return 'Low Data';
    case 'Failed Validation':
      return 'Failed';
  }
}

export function PerformanceHeatmapD3({
  combinations,
  scannedSymbols,
  scannedTimeframes,
  onSelectCombination,
}: {
  combinations: StrategyDiscoveryCombination[];
  scannedSymbols: InstrumentSymbol[];
  scannedTimeframes: Timeframe[];
  onSelectCombination: (combo: StrategyDiscoveryCombination) => void;
}) {
  const [metric, setMetric] = useState<HeatmapMetric>('oosScore');
  const [regimeScope, setRegimeScope] = useState<'ALL' | MarketRegimeType>('ALL');
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{
    datum: CellDatum;
    x: number;
    y: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const legendRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(880);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = el.clientWidth;
      if (w > 240) setContainerWidth(w);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const symbols = useMemo<InstrumentSymbol[]>(
    () =>
      scannedSymbols.length > 0
        ? scannedSymbols
        : INSTRUMENTS.map((i) => i.symbol),
    [scannedSymbols]
  );

  const timeframes = useMemo<Timeframe[]>(
    () => (scannedTimeframes.length > 0 ? scannedTimeframes : ['5m', '15m', '30m', '1H', '4H']),
    [scannedTimeframes]
  );

  const cells = useMemo<CellDatum[]>(() => {
    const out: CellDatum[] = [];
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const matching = combinations.filter(
          (c) =>
            c.symbol === symbol &&
            c.timeframe === timeframe &&
            (regimeScope === 'ALL' || c.regime === regimeScope)
        );
        const best = matching[0] ?? null;
        const validatedCount = matching.filter((m) => m.validationStatus === 'Validated').length;
        out.push({
          key: `${symbol}::${timeframe}`,
          symbol,
          timeframe,
          combo: best,
          matchingCombos: matching,
          value: best ? extractMetric(best, metric) : null,
          validatedCount,
        });
      }
    }
    return out;
  }, [combinations, symbols, timeframes, regimeScope, metric]);

  const selectedCell = useMemo(
    () => cells.find((c) => c.key === selectedCellKey && c.combo !== null) ?? null,
    [cells, selectedCellKey]
  );

  const activeMetricMeta = useMemo(
    () => METRIC_OPTIONS.find((m) => m.key === metric) ?? METRIC_OPTIONS[0],
    [metric]
  );

  const colorScale = useMemo(() => {
    const populated = cells.map((c) => c.value).filter((v): v is number => v !== null);
    if (metric === 'oosScore') {
      return d3
        .scaleSequential<string>()
        .domain([0, 75])
        .interpolator(d3.interpolateRgbBasis(['#4C1D24', '#1E2534', '#0E7490', '#0ECB81']))
        .clamp(true);
    }
    if (metric === 'expectancyR') {
      return d3
        .scaleDiverging<string>()
        .domain([-0.5, 0, 0.7])
        .interpolator(d3.interpolateRgbBasis(['#991B1B', '#1B2230', '#059669', '#0ECB81']))
        .clamp(true);
    }
    if (metric === 'netReturnPercent') {
      const absMax = Math.max(10, ...populated.map((v) => Math.abs(v)));
      const bound = Math.min(40, absMax);
      return d3
        .scaleDiverging<string>()
        .domain([-bound, 0, bound])
        .interpolator(d3.interpolateRgbBasis(['#991B1B', '#1B2230', '#059669', '#0ECB81']))
        .clamp(true);
    }
    if (metric === 'profitFactor') {
      return d3
        .scaleDiverging<string>()
        .domain([0.5, 1.0, 2.4])
        .interpolator(d3.interpolateRgbBasis(['#991B1B', '#1B2230', '#059669', '#0ECB81']))
        .clamp(true);
    }
    return d3
      .scaleDiverging<string>()
      .domain([25, 50, 75])
      .interpolator(d3.interpolateRgbBasis(['#991B1B', '#1B2230', '#059669', '#0ECB81']))
      .clamp(true);
  }, [cells, metric]);

  // Render D3 SVG Heatmap
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const margin = { top: 34, right: 14, bottom: 12, left: 86 };
    const rowHeight = 82;
    const width = Math.max(520, containerWidth);
    const innerW = width - margin.left - margin.right;
    const innerH = symbols.length * rowHeight;
    const height = innerH + margin.top + margin.bottom;

    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%').attr('height', height);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const xScale = d3
      .scaleBand<Timeframe>()
      .domain(timeframes)
      .range([0, innerW])
      .padding(0.06);

    const yScale = d3
      .scaleBand<InstrumentSymbol>()
      .domain(symbols)
      .range([0, innerH])
      .padding(0.09);

    // X-axis timeframe labels at top
    const xAxisGroup = g.append('g').call(d3.axisTop(xScale).tickSize(0));
    xAxisGroup.select('.domain').remove();
    xAxisGroup
      .selectAll('text')
      .attr('fill', '#38BDF8')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '11px')
      .attr('font-weight', '700')
      .attr('dy', '-8px');

    // Y-axis instrument labels at left
    const yAxisGroup = g.append('g').call(d3.axisLeft(yScale).tickSize(0));
    yAxisGroup.select('.domain').remove();
    yAxisGroup
      .selectAll('text')
      .attr('fill', '#E6EDF3')
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', '12px')
      .attr('font-weight', '700')
      .attr('dx', '-10px');

    const cellGroups = g
      .selectAll<SVGGElement, CellDatum>('g.hm-cell')
      .data(cells, (d) => d.key)
      .enter()
      .append('g')
      .attr('class', 'hm-cell')
      .attr(
        'transform',
        (d) => `translate(${xScale(d.timeframe) ?? 0},${yScale(d.symbol) ?? 0})`
      )
      .style('cursor', (d) => (d.combo ? 'pointer' : 'default'));

    const cellW = xScale.bandwidth();
    const cellH = yScale.bandwidth();

    const getStrokeColor = (d: CellDatum) => {
      if (d.key === selectedCellKey) return '#38BDF8';
      if (d.combo?.validationStatus === 'Validated') return '#0ECB81';
      return d.combo ? '#222938' : '#161B26';
    };

    const getStrokeWidth = (d: CellDatum) => {
      if (d.key === selectedCellKey) return 2.5;
      if (d.combo?.validationStatus === 'Validated') return 1.5;
      return 1;
    };

    cellGroups
      .append('rect')
      .attr('width', cellW)
      .attr('height', cellH)
      .attr('rx', 3)
      .attr('fill', (d) => (d.value !== null ? colorScale(d.value) : '#0E131B'))
      .attr('fill-opacity', (d) => (d.value !== null ? 0.86 : 0.7))
      .attr('stroke', getStrokeColor)
      .attr('stroke-width', getStrokeWidth);

    // Top-right trust status label (clear words instead of a mystery dot)
    cellGroups
      .filter((d) => d.combo !== null && cellW >= 120)
      .append('text')
      .attr('x', cellW - 9)
      .attr('y', 20)
      .attr('text-anchor', 'end')
      .attr('fill', (d) => statusColorHex(d.combo!.validationStatus))
      .attr('font-family', 'Plus Jakarta Sans, sans-serif')
      .attr('font-size', '10px')
      .attr('font-weight', '700')
      .text((d) => `● ${shortTrustTag(d.combo!.validationStatus)}`);

    // Compact dot if cells are narrow
    cellGroups
      .filter((d) => d.combo !== null && cellW < 120)
      .append('circle')
      .attr('cx', Math.max(10, cellW - 10))
      .attr('cy', 12)
      .attr('r', 3.5)
      .attr('fill', (d) => statusColorHex(d.combo!.validationStatus))
      .attr('stroke', '#0B0E14')
      .attr('stroke-width', 1);

    // Primary metric value with unit context
    cellGroups
      .append('text')
      .attr('x', 10)
      .attr('y', 23)
      .attr('fill', (d) => (d.value !== null ? '#FFFFFF' : '#4B5563'))
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', cellW < 120 ? '11.5px' : '13px')
      .attr('font-weight', '700')
      .text((d) => (d.value !== null ? formatCellMetricValue(d.value, metric) : '—'));

    // Secondary line: top strategy name
    cellGroups
      .filter((d) => d.combo !== null)
      .append('text')
      .attr('x', 10)
      .attr('y', 42)
      .attr('fill', '#E6EDF3')
      .attr('fill-opacity', 0.94)
      .attr('font-family', 'Plus Jakarta Sans, sans-serif')
      .attr('font-size', '10.5px')
      .attr('font-weight', '600')
      .text((d) => {
        const maxChars = Math.max(10, Math.floor((cellW - 18) / 5.7));
        const name = d.combo!.strategy.name;
        return name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
      });

    // Third line: clear plain-English condition + trade count
    cellGroups
      .filter((d) => d.combo !== null)
      .append('text')
      .attr('x', 10)
      .attr('y', 58)
      .attr('fill', '#CBD5E1')
      .attr('fill-opacity', 0.86)
      .attr('font-family', 'Plus Jakarta Sans, sans-serif')
      .attr('font-size', '10px')
      .text((d) => {
        const c = d.combo!;
        const cond =
          c.regime === 'High Volatility'
            ? 'Big Swings'
            : c.regime === 'Low Volatility'
              ? 'Quiet Market'
              : c.regime;
        const text = `${cond} · ${c.oosMetrics.trades} trades`;
        const maxChars = Math.max(10, Math.floor((cellW - 18) / 5.4));
        return text.length > maxChars ? `${c.oosMetrics.trades} trades` : text;
      });

    // Empty cell hint
    cellGroups
      .filter((d) => d.combo === null)
      .append('text')
      .attr('x', 10)
      .attr('y', 44)
      .attr('fill', '#6E7681')
      .attr('font-size', '10px')
      .text('No qualifying trades');

    // Interactive D3 hover highlight + click
    cellGroups
      .on('mouseenter', function (_event, d) {
        if (d.combo) {
          d3.select(this)
            .select('rect')
            .attr('stroke', '#38BDF8')
            .attr('stroke-width', 2.5);
        }
        const wrapperRect = wrapperRef.current?.getBoundingClientRect();
        const mouseEvent = _event as MouseEvent;
        if (wrapperRect && d.combo) {
          setHoveredCell({
            datum: d,
            x: mouseEvent.clientX - wrapperRect.left,
            y: mouseEvent.clientY - wrapperRect.top,
          });
        }
      })
      .on('mousemove', function (_event, d) {
        const wrapperRect = wrapperRef.current?.getBoundingClientRect();
        const mouseEvent = _event as MouseEvent;
        if (wrapperRect && d.combo) {
          setHoveredCell({
            datum: d,
            x: mouseEvent.clientX - wrapperRect.left,
            y: mouseEvent.clientY - wrapperRect.top,
          });
        }
      })
      .on('mouseleave', function (_event, d) {
        d3.select(this)
          .select('rect')
          .attr('stroke', getStrokeColor(d))
          .attr('stroke-width', getStrokeWidth(d));
        setHoveredCell(null);
      })
      .on('click', (_event, d) => {
        if (d.combo) {
          setSelectedCellKey((prev) => (prev === d.key ? null : d.key));
        }
      });
  }, [cells, symbols, timeframes, metric, colorScale, containerWidth, selectedCellKey]);

  // Render D3 Gradient Legend
  useEffect(() => {
    const legEl = legendRef.current;
    if (!legEl) return;
    const svg = d3.select(legEl);
    svg.selectAll('*').remove();

    const w = 220;
    const h = 24;
    svg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);

    const defs = svg.append('defs');
    const gradId = `hm-legend-grad-${metric}`;
    const grad = defs.append('linearGradient').attr('id', gradId).attr('x1', '0%').attr('x2', '100%');

    const stops = [0, 0.25, 0.5, 0.75, 1];
    const [dMin, dMax] =
      metric === 'oosScore'
        ? [0, 75]
        : metric === 'expectancyR'
          ? [-0.5, 0.7]
          : metric === 'netReturnPercent'
            ? [-25, 25]
            : metric === 'profitFactor'
              ? [0.5, 2.4]
              : [25, 75];

    stops.forEach((s) => {
      const val = dMin + (dMax - dMin) * s;
      grad
        .append('stop')
        .attr('offset', `${s * 100}%`)
        .attr('stop-color', colorScale(val));
    });

    svg
      .append('rect')
      .attr('x', 0)
      .attr('y', 2)
      .attr('width', w)
      .attr('height', 8)
      .attr('rx', 2)
      .attr('fill', `url(#${gradId})`);

    const labels =
      metric === 'oosScore'
        ? ['0 Weak', '40 Fair', '75+ Best']
        : metric === 'expectancyR'
          ? ['-0.50R Loss', '0.00R Even', '+0.70R+ Best']
          : metric === 'netReturnPercent'
            ? ['Loss', '0%', 'Big Gain']
            : metric === 'profitFactor'
              ? ['0.5× Losing', '1.0× Even', '2.4×+ Best']
              : ['25%', '50%', '75%'];

    svg
      .append('text')
      .attr('x', 0)
      .attr('y', 21)
      .attr('fill', '#8B949E')
      .attr('font-size', '9.5px')
      .attr('font-family', 'JetBrains Mono, monospace')
      .text(labels[0]);
    svg
      .append('text')
      .attr('x', w / 2)
      .attr('y', 21)
      .attr('text-anchor', 'middle')
      .attr('fill', '#8B949E')
      .attr('font-size', '9.5px')
      .attr('font-family', 'JetBrains Mono, monospace')
      .text(labels[1]);
    svg
      .append('text')
      .attr('x', w)
      .attr('y', 21)
      .attr('text-anchor', 'end')
      .attr('fill', '#0ECB81')
      .attr('font-size', '9.5px')
      .attr('font-family', 'JetBrains Mono, monospace')
      .text(labels[2]);
  }, [colorScale, metric]);

  const topSelected = selectedCell?.combo ?? null;
  const topRR = topSelected ? formatRiskRewardRatio(topSelected.oosMetrics) : null;

  return (
    <div className="border border-[#222938] bg-[#12161F]">
      {/* Heatmap Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] px-4 py-2.5">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-[#E6EDF3]">
            <Flame className="h-4 w-4 text-[#0ECB81]" />
            <span>Where Each Coin & Timeframe Performs Best (Heatmap)</span>
            <HintBadge termKey="oosScore" align="left" />
          </div>
          <div className="mt-0.5 text-[11px] text-[#8B949E]">
            Each box shows the #1 strategy for that Asset + Timeframe.{' '}
            <strong className="text-[#E6EDF3]">Click any box</strong> to see a plain-English breakdown & compare the top setups inside it.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Metric Selector */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-[11px] text-[#8B949E]">Show Number:</span>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as HeatmapMetric)}
              className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Market Condition Scope */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-[11px] text-[#8B949E]">Market Mood:</span>
            <select
              value={regimeScope}
              onChange={(e) => setRegimeScope(e.target.value as 'ALL' | MarketRegimeType)}
              className="border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3] outline-none"
            >
              {REGIME_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r === 'ALL' ? 'Best Any Condition' : r}
                </option>
              ))}
            </select>
          </div>

          {/* D3 Legend */}
          <svg ref={legendRef} className="shrink-0" />
        </div>
      </div>

      {/* Plain-English "How to Read This Grid" Helper Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1B2230] bg-[#0E131B] px-4 py-1.5 text-[11px] text-[#8B949E]">
        <div className="flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-[#38BDF8] shrink-0" />
          <span className="text-[#C9D1D9]">{activeMetricMeta.plainGuide}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] font-medium">
          <span className="inline-flex items-center gap-1 text-[#0ECB81]">
            <span>● Verified</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[#F59E0B]">
            <span>● Promising</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[#8B949E]">
            <span>● Low Data</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[#F6465D]">
            <span>● Failed</span>
          </span>
        </div>
      </div>

      {/* D3 SVG Canvas + Simple Hover Tooltip */}
      <div ref={wrapperRef} className="relative p-3">
        <svg ref={svgRef} className="block w-full select-none" />

        {hoveredCell && hoveredCell.datum.combo && (() => {
          const hc = hoveredCell.datum.combo!;
          const hcRr = formatRiskRewardRatio(hc.oosMetrics);
          return (
            <div
              className="pointer-events-none absolute z-40 w-72 border border-[#38BDF8]/60 bg-[#0B0E14]/95 p-3 shadow-2xl text-xs"
              style={{
                left: Math.min(Math.max(12, hoveredCell.x + 14), Math.max(12, containerWidth - 300)),
                top: Math.max(10, hoveredCell.y - 24),
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-[#E6EDF3]">
                  {hoveredCell.datum.symbol} · {hoveredCell.datum.timeframe}
                </span>
                <span
                  className="text-[10px] font-semibold"
                  style={{ color: statusColorHex(hc.validationStatus) }}
                >
                  {SimpleValidationLabel(hc.validationStatus)}
                </span>
              </div>
              <div className="mt-1 font-semibold text-[#38BDF8]">{hc.strategy.name}</div>
              <div className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-[#C9D1D9]">
                <div>
                  Best Market: <strong className="text-white">{hc.regime}</strong>
                </div>
                <div>
                  Risk : Reward{' '}
                  <strong className="font-mono text-[#38BDF8]">{hcRr.ratioText}</strong> · Win{' '}
                  <strong className="font-mono text-white">
                    {hc.oosMetrics.winRate.toFixed(0)}%
                  </strong>{' '}
                  ({hc.oosMetrics.wins}W / {hc.oosMetrics.losses}L)
                </div>
                <div>
                  Test Profit:{' '}
                  <strong
                    className={`font-mono ${
                      hc.oosMetrics.netReturnPercent >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {hc.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                    {hc.oosMetrics.netReturnPercent.toFixed(1)}%
                  </strong>{' '}
                  across {hc.oosMetrics.trades} trades
                </div>
              </div>
              <div className="mt-2 border-t border-[#1B2230] pt-1.5 text-[10px] font-medium text-[#38BDF8]">
                Click this box to see all top setups & simple summary ↓
              </div>
            </div>
          );
        })()}
      </div>

      {/* Interactive Box Deep-Dive Panel (Appears on Click!) */}
      {selectedCell && topSelected && topRR && (
        <div className="border-t border-[#38BDF8]/50 bg-[#0E131B] p-4 space-y-4">
          {/* Plain-English Box Verdict */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 max-w-4xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold text-[#38BDF8]">
                  {selectedCell.symbol} · {selectedCell.timeframe} BOX EXPLAINED
                </span>
                <span className="text-[#30363D]">|</span>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold"
                  style={{ color: statusColorHex(topSelected.validationStatus) }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {SimpleValidationLabel(topSelected.validationStatus)}
                </span>
              </div>

              <p className="text-xs leading-relaxed text-[#E6EDF3]">
                Best setup for{' '}
                <strong>
                  {selectedCell.symbol} ({selectedCell.timeframe})
                </strong>
                : <strong className="text-[#38BDF8]">{topSelected.strategy.name}</strong> when the
                market is <strong>{topSelected.regime}</strong>. Risk : Reward{' '}
                <strong className="font-mono text-[#38BDF8]">{topRR.ratioText}</strong> · Won{' '}
                <strong>
                  {topSelected.oosMetrics.winRate.toFixed(0)}% ({topSelected.oosMetrics.wins}W /{' '}
                  {topSelected.oosMetrics.losses}L)
                </strong>{' '}
                · Test Profit{' '}
                <strong
                  className={
                    topSelected.oosMetrics.netReturnPercent >= 0
                      ? 'text-[#0ECB81]'
                      : 'text-[#F6465D]'
                  }
                >
                  {topSelected.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                  {topSelected.oosMetrics.netReturnPercent.toFixed(1)}%
                </strong>{' '}
                (max drop{' '}
                <strong className="text-[#F6465D]">
                  -{topSelected.oosMetrics.maxDrawdownPercent.toFixed(1)}%
                </strong>
                ).
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onSelectCombination(topSelected)}
                className="inline-flex items-center gap-1.5 border border-[#0ECB81] bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer"
              >
                <span>Open Full Report & All Trades</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setSelectedCellKey(null)}
                title="Close box breakdown"
                className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* 4 Plain-English Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                Risk : Reward Ratio
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#38BDF8]">
                {topRR.ratioText}
              </div>
              <div className="text-[10px] text-[#8B949E]">
                Avg{' '}
                <span
                  className={
                    topSelected.oosMetrics.expectancyR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                  }
                >
                  {topSelected.oosMetrics.expectancyR >= 0 ? '+' : ''}
                  {topSelected.oosMetrics.expectancyR.toFixed(2)}R
                </span>{' '}
                per trade
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                Win Rate & Trades
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#E6EDF3]">
                {topSelected.oosMetrics.winRate.toFixed(1)}%
              </div>
              <div className="text-[10px] text-[#8B949E]">
                {topSelected.oosMetrics.wins} Won / {topSelected.oosMetrics.losses} Lost (
                {topSelected.oosMetrics.trades} trades)
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                Test Profit vs Max Drop
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums">
                <span
                  className={
                    topSelected.oosMetrics.netReturnPercent >= 0
                      ? 'text-[#0ECB81]'
                      : 'text-[#F6465D]'
                  }
                >
                  {topSelected.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                  {topSelected.oosMetrics.netReturnPercent.toFixed(1)}%
                </span>{' '}
                <span className="text-xs font-normal text-[#F6465D]">
                  (-{topSelected.oosMetrics.maxDrawdownPercent.toFixed(1)}% drop)
                </span>
              </div>
              <div className="text-[10px] text-[#8B949E]">
                After fees & slippage deducted
              </div>
            </div>

            <div className="border border-[#222938] bg-[#12161F] p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">
                Consistent Over Time?
              </div>
              <div className="mt-1 font-mono text-sm font-bold tabular-nums text-[#38BDF8]">
                {topSelected.wfProfitableFolds} of {topSelected.wfActiveFolds} Periods Won
              </div>
              <div className="text-[10px] text-[#8B949E]">
                {topSelected.wfConsistencyPercent.toFixed(0)}% steady · Final Proof:{' '}
                {topSelected.holdoutMetrics.trades > 0
                  ? `${topSelected.holdoutMetrics.netReturnPercent >= 0 ? '+' : ''}${topSelected.holdoutMetrics.netReturnPercent.toFixed(1)}%`
                  : '0 trades'}
              </div>
            </div>
          </div>

          {/* Top 5 Strategies Inside This Box */}
          <div className="border border-[#222938] bg-[#12161F]">
            <div className="flex items-center justify-between border-b border-[#222938] px-3 py-2 text-[11px]">
              <span className="font-semibold text-[#E6EDF3]">
                Top {Math.min(5, selectedCell.matchingCombos.length)} Setups Found for{' '}
                {selectedCell.symbol} · {selectedCell.timeframe} (of {selectedCell.matchingCombos.length} total)
              </span>
              <span className="text-[#8B949E]">
                Click any row to open full chart, equity curve & every trade
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#222938] bg-[#0B0E14] text-[10px] uppercase tracking-wider text-[#8B949E]">
                    <th className="px-3 py-1.5">Strategy</th>
                    <th className="px-3 py-1.5">Best Market Mood</th>
                    <th className="px-3 py-1.5">Trust Level</th>
                    <th className="px-3 py-1.5 text-right">Risk : Reward</th>
                    <th className="px-3 py-1.5 text-right">Win % (W/L)</th>
                    <th className="px-3 py-1.5 text-right">Test Profit</th>
                    <th className="px-3 py-1.5 text-right">Max Drop</th>
                    <th className="px-3 py-1.5 text-right">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCell.matchingCombos.slice(0, 5).map((c) => {
                    const rr = formatRiskRewardRatio(c.oosMetrics);
                    return (
                      <tr
                        key={c.comboKey}
                        onClick={() => onSelectCombination(c)}
                        className="border-b border-[#1B2230] text-xs hover:bg-[#161B26] cursor-pointer"
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium text-[#E6EDF3]">{c.strategy.name}</div>
                          <div className="text-[10px] text-[#8B949E]">{c.strategy.category}</div>
                        </td>
                        <td className="px-3 py-2 text-[#C9D1D9]">{c.regime}</td>
                        <td
                          className="px-3 py-2 text-[11px] font-medium whitespace-nowrap"
                          style={{ color: statusColorHex(c.validationStatus) }}
                        >
                          ● {SimpleValidationLabel(c.validationStatus)}
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
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[#C9D1D9]">
                          <div>{c.oosMetrics.winRate.toFixed(0)}%</div>
                          <div className="text-[10px] text-[#8B949E]">
                            {c.oosMetrics.wins}W / {c.oosMetrics.losses}L
                          </div>
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono tabular-nums ${
                            c.oosMetrics.netReturnPercent >= 0
                              ? 'text-[#0ECB81]'
                              : 'text-[#F6465D]'
                          }`}
                        >
                          {c.oosMetrics.netReturnPercent >= 0 ? '+' : ''}
                          {c.oosMetrics.netReturnPercent.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[#F6465D]">
                          -{c.oosMetrics.maxDrawdownPercent.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-[11px] text-[#38BDF8] hover:underline">
                            Full Report →
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
