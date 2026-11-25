import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import {
  Camera,
  Layers,
  Maximize2,
  Minimize2,
  RotateCcw,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  getInstrumentMeta,
  SMC_VISIBILITY_KEYS,
  TIMEFRAMES,
} from '../../shared/constants/index.ts';
import type { ChartVisibilityConfig } from '../../shared/types/index.ts';
import { useTerminal, type ChartType } from '../state/terminal-context.tsx';
import { TerminalOverlayPrimitive } from './overlay-primitive.ts';

const SMC_LAYER_LABELS: Array<{ key: keyof ChartVisibilityConfig; label: string; short: string }> = [
  { key: 'orderBlocks', label: 'Order Blocks', short: 'OB' },
  { key: 'fairValueGaps', label: 'Fair Value Gaps (FVG)', short: 'FVG' },
  { key: 'liquiditySweeps', label: 'Liquidity Sweeps', short: 'Sweeps' },
];

const EXTRA_SMC_LAYER_LABELS: Array<{ key: keyof ChartVisibilityConfig; label: string }> = [
  { key: 'liquidity', label: 'Liquidity Pools' },
  { key: 'marketStructure', label: 'Market Structure (BOS/CHoCH)' },
  { key: 'premiumDiscount', label: 'Premium / Discount & OTE' },
];

const PRICE_ACTION_LAYER_LABELS: Array<{ key: keyof ChartVisibilityConfig; label: string }> = [
  { key: 'candlestickPatterns', label: 'Candle Patterns' },
  { key: 'chartPatterns', label: 'Chart Patterns' },
  { key: 'supportResistance', label: 'Support & Resistance' },
  { key: 'supplyDemand', label: 'Supply & Demand' },
  { key: 'trendlines', label: 'Trendlines' },
  { key: 'sessions', label: 'Trading Sessions' },
  { key: 'volume', label: 'Volume' },
  { key: 'provisional', label: 'Provisional' },
];

export function TerminalChart({
  onOpenSettings,
  isFullscreen,
  onToggleFullscreen,
}: {
  onOpenSettings: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const {
    symbol,
    timeframe,
    chartType,
    timezone,
    visibility,
    snapshot,
    loadingSnapshot,
    quotes,
    providers,
    signals,
    hoveredObjectId,
    selectedObjectId,
    focusRequest,
    selectTimeframe,
    setChartType,
    toggleVisibility,
    setLayerVisibility,
    toggleSmcOverlays,
    setAllVisibility,
    setHoveredObjectId,
    setSelectedObjectId,
  } = useTerminal();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlaysMenuRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const primitiveRef = useRef<TerminalOverlayPrimitive | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [layersOpen, setLayersOpen] = useState(false);
  const [priceScaleMode, setPriceScaleMode] = useState<'normal' | 'percent' | 'log'>('normal');
  const [seriesVersion, setSeriesVersion] = useState(0);
  const [crosshairOhlc, setCrosshairOhlc] = useState<{
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    timeStr: string;
  } | null>(null);

  const meta = getInstrumentMeta(symbol);
  const providerStatus = providers[symbol];
  const symbolSignals = signals.filter((s) => s.symbol === symbol);
  const lastFittedKeyRef = useRef<string | null>(null);
  const syncedSeriesMetaRef = useRef<{
    key: string;
    count: number;
    firstTime: number;
    lastTime: number;
  } | null>(null);
  const appliedFocusNonceRef = useRef<number | null>(null);

  // Close Overlays popover on outside click
  useEffect(() => {
    if (!layersOpen) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (overlaysMenuRef.current && !overlaysMenuRef.current.contains(ev.target as Node)) {
        setLayersOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [layersOpen]);

  // Initialize TradingView Lightweight Chart
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const initialW = Math.max(300, el.clientWidth);
    const initialH = Math.max(300, el.clientHeight);

    const chart = createChart(el, {
      width: initialW,
      height: initialH,
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E14' },
        textColor: '#8B949E',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#161B26' },
        horzLines: { color: '#161B26' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#38BDF8', width: 1, style: 2, labelBackgroundColor: '#1C2331' },
        horzLine: { color: '#38BDF8', width: 1, style: 2, labelBackgroundColor: '#1C2331' },
      },
      rightPriceScale: {
        borderColor: '#222938',
        scaleMargins: { top: 0.08, bottom: 0.18 },
      },
      timeScale: {
        borderColor: '#222938',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
      },
      localization: {
        timeFormatter: (time: Time) => {
          const sec = typeof time === 'number' ? time : 0;
          return new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(sec * 1000));
        },
      },
    });

    chartRef.current = chart;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width, height });
        }
      }
    });
    ro.observe(el);

    chart.subscribeCrosshairMove((param) => {
      if (!param.point) {
        setCrosshairOhlc(null);
        return;
      }
      const hit = primitiveRef.current?.hitTest(param.point.x, param.point.y);
      setHoveredObjectId(hit ? hit.id : null);

      if (param.time && mainSeriesRef.current) {
        const data = param.seriesData.get(mainSeriesRef.current) as
          | { open?: number; high?: number; low?: number; close?: number; value?: number }
          | undefined;
        const vol = volumeSeriesRef.current
          ? (param.seriesData.get(volumeSeriesRef.current) as { value?: number } | undefined)?.value ?? 0
          : 0;

        if (data) {
          const sec = typeof param.time === 'number' ? param.time : 0;
          const timeStr = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(sec * 1000));
          setCrosshairOhlc({
            o: data.open ?? data.value ?? 0,
            h: data.high ?? data.value ?? 0,
            l: data.low ?? data.value ?? 0,
            c: data.close ?? data.value ?? 0,
            v: vol,
            timeStr,
          });
        }
      }
    });

    const handleClick = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const hit = primitiveRef.current?.hitTest(x, y);
      if (hit) {
        setSelectedObjectId(hit.id);
      }
    };
    el.addEventListener('click', handleClick);

    return () => {
      el.removeEventListener('click', handleClick);
      ro.disconnect();
      markersRef.current = null;
      primitiveRef.current = null;
      mainSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chart.remove();
      chartRef.current = null;
    };
  }, [timezone, setHoveredObjectId, setSelectedObjectId]);

  // Create/Recreate primary series when chartType or symbol changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      if (primitiveRef.current) {
        try {
          mainSeriesRef.current.detachPrimitive(primitiveRef.current);
        } catch {
          // ignore
        }
      }
      chart.removeSeries(mainSeriesRef.current);
      mainSeriesRef.current = null;
    }
    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }

    const priceFormat = {
      type: 'price' as const,
      precision: meta.pricePrecision,
      minMove: meta.minMove,
    };

    let mainSeries: ISeriesApi<SeriesType>;
    if (chartType === 'candlestick') {
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#0ECB81',
        downColor: '#F6465D',
        borderUpColor: '#0ECB81',
        borderDownColor: '#F6465D',
        wickUpColor: '#0ECB81',
        wickDownColor: '#F6465D',
        priceFormat,
      });
    } else if (chartType === 'bar') {
      mainSeries = chart.addSeries(BarSeries, {
        upColor: '#0ECB81',
        downColor: '#F6465D',
        priceFormat,
      });
    } else {
      mainSeries = chart.addSeries(LineSeries, {
        color: '#38BDF8',
        lineWidth: 2,
        priceFormat,
      });
    }

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      visible: visibility.volume,
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.84, bottom: 0 },
    });

    const primitive = new TerminalOverlayPrimitive({
      snapshot,
      signals: symbolSignals,
      visibility,
      hoveredId: hoveredObjectId,
      selectedId: selectedObjectId,
      precision: meta.pricePrecision,
    });
    mainSeries.attachPrimitive(primitive);
    markersRef.current = createSeriesMarkers(mainSeries, []);

    mainSeriesRef.current = mainSeries;
    volumeSeriesRef.current = volSeries;
    primitiveRef.current = primitive;
    lastFittedKeyRef.current = null;
    syncedSeriesMetaRef.current = null;
    setSeriesVersion((v) => v + 1);
  }, [chartType, symbol, timezone, meta.pricePrecision, meta.minMove]);

  // Update series data & volume incrementally on ticks without resetting user pan/zoom
  useEffect(() => {
    const main = mainSeriesRef.current;
    const vol = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (
      !main ||
      !vol ||
      !chart ||
      !snapshot ||
      snapshot.symbol !== symbol ||
      snapshot.timeframe !== timeframe ||
      snapshot.candles.length === 0
    ) {
      return;
    }

    const candles = snapshot.candles;
    const syncKey = `${symbol}:${timeframe}:${chartType}:${seriesVersion}`;
    const firstTime = candles[0].time;
    const last = candles[candles.length - 1];
    const prevLast = candles.length >= 2 ? candles[candles.length - 2] : null;
    const prevMeta = syncedSeriesMetaRef.current;

    const toMainPoint = (c: (typeof candles)[number]) =>
      chartType === 'line'
        ? { time: c.time as Time, value: c.close }
        : { time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close };

    const toVolPoint = (c: (typeof candles)[number]) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(14, 203, 129, 0.28)' : 'rgba(246, 70, 93, 0.28)',
    });

    const canIncrementalUpdate =
      prevMeta !== null &&
      prevMeta.key === syncKey &&
      prevMeta.firstTime === firstTime &&
      candles.length >= prevMeta.count &&
      candles.length <= prevMeta.count + 2 &&
      last.time >= prevMeta.lastTime;

    vol.applyOptions({ visible: visibility.volume });

    if (canIncrementalUpdate) {
      if (prevLast && prevLast.time >= prevMeta.lastTime) {
        main.update(toMainPoint(prevLast));
        vol.update(toVolPoint(prevLast));
      }
      main.update(toMainPoint(last));
      vol.update(toVolPoint(last));
      syncedSeriesMetaRef.current = {
        key: syncKey,
        count: candles.length,
        firstTime,
        lastTime: last.time,
      };
      return;
    }

    const fitKey = `${snapshot.symbol}:${snapshot.timeframe}:${chartType}`;
    const preserveRange =
      lastFittedKeyRef.current === fitKey && prevMeta !== null && prevMeta.key === syncKey
        ? chart.timeScale().getVisibleLogicalRange()
        : null;

    main.setData(candles.map(toMainPoint));
    vol.setData(candles.map(toVolPoint));
    syncedSeriesMetaRef.current = {
      key: syncKey,
      count: candles.length,
      firstTime,
      lastTime: last.time,
    };

    if (lastFittedKeyRef.current !== fitKey) {
      lastFittedKeyRef.current = fitKey;
      chart.timeScale().fitContent();
    } else if (preserveRange) {
      chart.timeScale().setVisibleLogicalRange(preserveRange);
    }
  }, [snapshot?.candles, snapshot?.symbol, snapshot?.timeframe, symbol, timeframe, chartType, seriesVersion, visibility.volume]);

  // Update swing structure markers + BUY/SELL signal markers independently of tick updates
  useEffect(() => {
    if (
      !markersRef.current ||
      !snapshot ||
      snapshot.symbol !== symbol ||
      snapshot.timeframe !== timeframe
    ) {
      return;
    }

    const markers: SeriesMarker<Time>[] = [];

    if (visibility.marketStructure) {
      for (const s of snapshot.marketStructure.swings
        .filter(
          (sw) =>
            sw.scope === 'external' &&
            (visibility.provisional || sw.confirmationStatus === 'confirmed')
        )
        .slice(-28)) {
        markers.push({
          time: s.candleTime as Time,
          position: s.kind === 'high' ? 'aboveBar' : 'belowBar',
          color:
            s.structureLabel === 'HH' || s.structureLabel === 'HL'
              ? '#10B981'
              : s.structureLabel === 'LH' || s.structureLabel === 'LL'
                ? '#EF4444'
                : '#94A3B8',
          shape: s.kind === 'high' ? 'arrowDown' : 'arrowUp',
          text: `${s.structureLabel}${s.confirmationStatus === 'provisional' ? '?' : ''}`,
        });
      }
    }

    if (visibility.signals && snapshot.candles.length > 0) {
      const candles = snapshot.candles;
      const firstTime = candles[0].time;
      const lastTime = candles[candles.length - 1].time;
      const mapToChartCandleTime = (t: number): number => {
        if (t <= firstTime) return firstTime;
        if (t >= lastTime) return lastTime;
        let lo = 0;
        let hi = candles.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candles[mid].time < t) lo = mid + 1;
          else hi = mid;
        }
        return candles[lo].time;
      };

      for (const sig of symbolSignals) {
        if (!visibility.provisional && sig.state === 'WATCHING') continue;
        if (sig.state === 'EXPIRED' || sig.state === 'CANCELLED') continue;
        const isBuy = sig.direction === 'BUY';
        markers.push({
          time: mapToChartCandleTime(sig.candleTime) as Time,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: sig.state === 'WATCHING' ? '#F59E0B' : isBuy ? '#0ECB81' : '#F6465D',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: `${sig.direction} ${sig.score}${sig.state === 'WATCHING' ? '?' : ''}`,
        });
      }
    }

    markers.sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current.setMarkers(markers);
  }, [
    snapshot?.marketStructure,
    snapshot?.candles,
    snapshot?.symbol,
    snapshot?.timeframe,
    signals,
    symbol,
    timeframe,
    seriesVersion,
    visibility.marketStructure,
    visibility.provisional,
    visibility.signals,
  ]);

  // Update overlay primitive state
  useEffect(() => {
    const matchedSnapshot =
      snapshot && snapshot.symbol === symbol && snapshot.timeframe === timeframe ? snapshot : null;
    primitiveRef.current?.updateState({
      snapshot: matchedSnapshot,
      signals: symbolSignals,
      visibility,
      hoveredId: hoveredObjectId,
      selectedId: selectedObjectId,
      precision: meta.pricePrecision,
    });
  }, [
    snapshot,
    signals,
    symbol,
    timeframe,
    seriesVersion,
    visibility,
    hoveredObjectId,
    selectedObjectId,
    meta.pricePrecision,
  ]);

  // Price scale mode
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale('right').applyOptions({
      mode:
        priceScaleMode === 'percent'
          ? PriceScaleMode.Percentage
          : priceScaleMode === 'log'
            ? PriceScaleMode.Logarithmic
            : PriceScaleMode.Normal,
      autoScale: true,
    });
  }, [priceScaleMode]);

  // Bidirectional focus zoom to exact formation bar range (applied once per focus click)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusRequest || !snapshot || snapshot.candles.length === 0) return;
    if (appliedFocusNonceRef.current === focusRequest.nonce) return;
    appliedFocusNonceRef.current = focusRequest.nonce;

    const candles = snapshot.candles;
    const findIdx = (targetTime: number) => {
      let lo = 0;
      let hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].time < targetTime) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(candles[lo - 1].time - targetTime) < Math.abs(candles[lo].time - targetTime)) {
        return lo - 1;
      }
      return lo;
    };

    const startIdx = findIdx(Math.min(focusRequest.startTime, focusRequest.endTime));
    const endIdx = findIdx(Math.max(focusRequest.startTime, focusRequest.endTime));
    const span = Math.max(1, endIdx - startIdx + 1);
    const padBars = Math.max(16, Math.round(span * 0.55));
    const fromLogical = Math.max(-4, startIdx - padBars);
    const toLogical = Math.min(candles.length + 6, endIdx + padBars);

    if (toLogical > fromLogical) {
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().setVisibleLogicalRange({
        from: fromLogical,
        to: toLogical,
      });
    }
  }, [focusRequest, snapshot, timeframe]);

  const handleZoom = (factor: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const mid = (range.from + range.to) / 2;
    const half = ((range.to - range.from) / 2) * factor;
    chart.timeScale().setVisibleLogicalRange({
      from: mid - half,
      to: mid + half,
    });
  };

  const handleReset = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
    chart.priceScale('right').applyOptions({ autoScale: true });
  };

  const handleScreenshot = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const canvas = chart.takeScreenshot();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `GOLD_BTC_TERMINAL_${symbol}_${timeframe}_${Date.now()}.png`;
    a.click();
  };

  const lastCandle = snapshot?.candles[snapshot.candles.length - 1];
  const displayOhlc = crosshairOhlc ?? (lastCandle
    ? {
        o: lastCandle.open,
        h: lastCandle.high,
        l: lastCandle.low,
        c: lastCandle.close,
        v: lastCandle.volume,
        timeStr: 'Latest',
      }
    : null);

  const smcEnabledCount = SMC_VISIBILITY_KEYS.filter((k) => visibility[k]).length;
  const smcAllEnabled = smcEnabledCount === SMC_VISIBILITY_KEYS.length;
  const smcAnyEnabled = smcEnabledCount > 0;
  const activeObCount = snapshot ? snapshot.orderBlocks.filter((o) => o.valid).length : 0;
  const activeFvgCount = snapshot
    ? snapshot.fairValueGaps.filter((f) => f.status !== 'fully_filled' && f.status !== 'inverted').length
    : 0;
  const activeSweepCount = snapshot
    ? snapshot.liquidityPools.filter((l) => l.swept && l.sweepTime !== null).length
    : 0;
  const smcCounts: Record<'orderBlocks' | 'fairValueGaps' | 'liquiditySweeps', number> = {
    orderBlocks: activeObCount,
    fairValueGaps: activeFvgCount,
    liquiditySweeps: activeSweepCount,
  };
  const totalEnabledLayers = (Object.values(visibility) as boolean[]).filter(Boolean).length;

  return (
    <div className="relative flex h-full w-full flex-col bg-[#0B0E14]">
      {/* Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] bg-[#12161F] px-3 py-1.5">
        {/* Timeframe Selector */}
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => selectTimeframe(tf)}
              className={`px-2 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                timeframe === tf
                  ? 'bg-[#1F2937] text-[#38BDF8]'
                  : 'text-[#8B949E] hover:bg-[#161B26] hover:text-[#E6EDF3]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* Chart Mode, Smart Money Concepts Toggles, Overlays & Tools */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Smart Money Concepts Quick Toggle System */}
          <div
            role="group"
            aria-label="Smart Money Concepts Overlays"
            className="flex items-center border border-[#222938] bg-[#0B0E14]"
          >
            <button
              type="button"
              onClick={toggleSmcOverlays}
              aria-pressed={smcAnyEnabled}
              title="Toggle all Smart Money Concepts markers (Order Blocks, FVG, Liquidity Sweeps)"
              className={`flex items-center gap-1.5 border-r border-[#222938] px-2 py-1 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                smcAllEnabled
                  ? 'bg-[#1C2331] text-[#38BDF8]'
                  : smcAnyEnabled
                    ? 'bg-[#161B26] text-[#7DD3FC]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 ${
                  smcAllEnabled
                    ? 'bg-[#38BDF8]'
                    : smcAnyEnabled
                      ? 'bg-[#F59E0B]'
                      : 'bg-[#4B5563]'
                }`}
              />
              <span>SMC</span>
              <span className="font-mono text-[10px] text-[#6E7681] tabular-nums">
                {smcEnabledCount}/3
              </span>
            </button>
            {SMC_LAYER_LABELS.map((item) => {
              const active = visibility[item.key];
              const count = smcCounts[item.key as 'orderBlocks' | 'fairValueGaps' | 'liquiditySweeps'];
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggleVisibility(item.key)}
                  aria-pressed={active}
                  title={`Toggle ${item.label} on chart`}
                  className={`flex items-center gap-1 px-2 py-1 font-mono text-[11px] whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#1C2331] text-[#38BDF8]'
                      : 'text-[#8B949E] hover:bg-[#12161F] hover:text-[#E6EDF3]'
                  }`}
                >
                  <span>{item.short}</span>
                  {snapshot && (
                    <span className="text-[10px] text-[#6E7681] tabular-nums">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => toggleVisibility('signals')}
            aria-pressed={visibility.signals}
            title="Toggle BUY/SELL Signal Markers, Entry Zone, SL, and TP1-TP3 lines"
            className={`flex items-center gap-1.5 border px-2 py-1 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              visibility.signals
                ? 'border-[#0ECB81]/50 bg-[#1C2331] text-[#0ECB81]'
                : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:text-[#E6EDF3]'
            }`}
          >
            <span>Signals</span>
            <span className="font-mono text-[10px] text-[#8B949E] tabular-nums">
              {symbolSignals.filter((s) => !['EXPIRED', 'CANCELLED', 'STOPPED', 'INVALIDATED', 'TP3_HIT'].includes(s.state)).length}
            </span>
          </button>

          <div className="flex items-center border border-[#222938] bg-[#0B0E14]">
            {(['candlestick', 'bar', 'line'] as ChartType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setChartType(t)}
                className={`px-2 py-1 text-[11px] capitalize whitespace-nowrap shrink-0 cursor-pointer ${
                  chartType === t
                    ? 'bg-[#1C2331] text-[#E6EDF3]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                {t === 'candlestick' ? 'Candles' : t}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() =>
              setPriceScaleMode((m) =>
                m === 'normal' ? 'log' : m === 'log' ? 'percent' : 'normal'
              )
            }
            title="Cycle Price Scale (Linear / Log / %)"
            className="border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[11px] text-[#8B949E] hover:text-[#E6EDF3] whitespace-nowrap shrink-0 cursor-pointer"
          >
            {priceScaleMode === 'normal' ? 'LIN' : priceScaleMode === 'log' ? 'LOG' : '%'}
          </button>

          <div className="relative" ref={overlaysMenuRef}>
            <button
              type="button"
              onClick={() => setLayersOpen((o) => !o)}
              aria-expanded={layersOpen}
              className={`flex items-center gap-1 border px-2 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer ${
                layersOpen || totalEnabledLayers > 0
                  ? 'border-[#38BDF8]/60 bg-[#1C2331] text-[#38BDF8]'
                  : 'border-[#222938] bg-[#0B0E14] text-[#C9D1D9] hover:text-white'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Overlays</span>
              {totalEnabledLayers > 0 && (
                <span className="font-mono text-[10px] text-[#7DD3FC] tabular-nums">
                  {totalEnabledLayers}
                </span>
              )}
            </button>

            {layersOpen && (
              <div className="absolute right-0 top-full z-40 mt-1 max-h-[75vh] w-64 overflow-y-auto border border-[#2B3548] bg-[#12161F] p-2 shadow-xl">
                <div className="mb-1.5 flex items-center justify-between border-b border-[#222938] pb-1 text-[11px] font-semibold text-[#8B949E]">
                  <span>Technical Layers</span>
                  <span className="flex items-center gap-2 font-mono text-[10px] font-normal">
                    <button
                      type="button"
                      onClick={() => setAllVisibility(true)}
                      className="text-[#38BDF8] hover:underline cursor-pointer"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllVisibility(false)}
                      className="text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
                    >
                      None
                    </button>
                  </span>
                </div>

                {/* Smart Money Concepts Group */}
                <div className="mb-2 border-b border-[#222938] pb-2">
                  <div className="mb-1 flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#38BDF8]">
                    <span>Smart Money Concepts</span>
                    <span className="flex items-center gap-2 font-mono text-[10px] font-normal normal-case">
                      <button
                        type="button"
                        onClick={() =>
                          setLayerVisibility({
                            orderBlocks: true,
                            fairValueGaps: true,
                            liquiditySweeps: true,
                          })
                        }
                        className="text-[#38BDF8] hover:underline cursor-pointer"
                      >
                        On
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setLayerVisibility({
                            orderBlocks: false,
                            fairValueGaps: false,
                            liquiditySweeps: false,
                          })
                        }
                        className="text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
                      >
                        Off
                      </button>
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {SMC_LAYER_LABELS.map((item) => (
                      <label
                        key={item.key}
                        className="flex cursor-pointer items-center justify-between px-1.5 py-1 text-xs text-[#E6EDF3] hover:bg-[#1C2331]"
                      >
                        <span>
                          {item.label}{' '}
                          {snapshot && (
                            <span className="font-mono text-[10px] text-[#6E7681]">
                              ({smcCounts[item.key as 'orderBlocks' | 'fairValueGaps' | 'liquiditySweeps']})
                            </span>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          checked={visibility[item.key]}
                          onChange={() => toggleVisibility(item.key)}
                          className="accent-[#38BDF8]"
                        />
                      </label>
                    ))}
                    {EXTRA_SMC_LAYER_LABELS.map((item) => (
                      <label
                        key={item.key}
                        className="flex cursor-pointer items-center justify-between px-1.5 py-1 text-xs text-[#C9D1D9] hover:bg-[#1C2331]"
                      >
                        <span>{item.label}</span>
                        <input
                          type="checkbox"
                          checked={visibility[item.key]}
                          onChange={() => toggleVisibility(item.key)}
                          className="accent-[#38BDF8]"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                {/* Price Action & Context Group */}
                <div>
                  <div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#8B949E]">
                    Price Action & Context
                  </div>
                  <div className="space-y-0.5">
                    {PRICE_ACTION_LAYER_LABELS.map((item) => (
                      <label
                        key={item.key}
                        className="flex cursor-pointer items-center justify-between px-1.5 py-1 text-xs text-[#C9D1D9] hover:bg-[#1C2331]"
                      >
                        <span>{item.label}</span>
                        <input
                          type="checkbox"
                          checked={visibility[item.key]}
                          onChange={() => toggleVisibility(item.key)}
                          className="accent-[#38BDF8]"
                        />
                      </label>
                    ))}
                    <label className="flex cursor-pointer items-center justify-between px-1.5 py-1 text-xs text-[#0ECB81] hover:bg-[#1C2331]">
                      <span>BUY/SELL Signals (Entry/SL/TP)</span>
                      <input
                        type="checkbox"
                        checked={visibility.signals}
                        onChange={() => toggleVisibility('signals')}
                        className="accent-[#0ECB81]"
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => handleZoom(0.7)}
            title="Zoom In"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => handleZoom(1.35)}
            title="Zoom Out"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleReset}
            title="Auto-Scale & Reset Chart"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleScreenshot}
            title="Download Chart Screenshot"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            <Camera className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Technical Analysis Settings"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            title="Toggle Chart Fullscreen"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Chart Viewport */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* OHLC Strip */}
        {displayOhlc && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap items-center gap-3 bg-[#0B0E14]/80 px-2 py-1 font-mono text-[11px] tabular-nums">
            <span className="font-semibold text-[#E6EDF3]">
              {symbol} · {timeframe}
            </span>
            <span className="text-[#8B949E]">
              O <span className="text-[#E6EDF3]">{displayOhlc.o.toFixed(meta.pricePrecision)}</span>
            </span>
            <span className="text-[#8B949E]">
              H <span className="text-[#0ECB81]">{displayOhlc.h.toFixed(meta.pricePrecision)}</span>
            </span>
            <span className="text-[#8B949E]">
              L <span className="text-[#F6465D]">{displayOhlc.l.toFixed(meta.pricePrecision)}</span>
            </span>
            <span className="text-[#8B949E]">
              C <span className="text-[#E6EDF3]">{displayOhlc.c.toFixed(meta.pricePrecision)}</span>
            </span>
            <span className="text-[#8B949E]">
              V <span className="text-[#38BDF8]">{displayOhlc.v.toFixed(2)}</span>
            </span>
            {snapshot && (
              <span className="text-[#8B949E]">
                ATR(14) <span className="text-[#E6EDF3]">{snapshot.atr.toFixed(meta.pricePrecision)}</span>
              </span>
            )}
          </div>
        )}

        {loadingSnapshot && (!snapshot || snapshot.candles.length === 0) && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0B0E14]/90 text-xs text-[#8B949E]">
            Loading genuine historical OHLCV candles from {providerStatus?.providerName ?? 'TradingView'}...
          </div>
        )}

        {providerStatus?.errorMessage && (!snapshot || snapshot.candles.length === 0) && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0B0E14]/95 p-6">
            <div className="max-w-md border border-[#EF4444]/40 bg-[#12161F] p-4 text-xs">
              <div className="font-semibold text-[#EF4444]">Market Data Unavailable</div>
              <p className="mt-1 text-[#C9D1D9]">{providerStatus.errorMessage}</p>
            </div>
          </div>
        )}

        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
