import { Crosshair, X } from 'lucide-react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

export function ObjectInspectorDrawer() {
  const {
    symbol,
    snapshot,
    signals,
    selectedObjectId,
    setSelectedObjectId,
    focusChartObject,
    timezone,
  } = useTerminal();

  if (!selectedObjectId || !snapshot) return null;

  const meta = getInstrumentMeta(symbol);
  const p = meta.pricePrecision;
  const fmt = (sec: number | null | undefined) => {
    if (!sec) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(sec * 1000));
  };

  type DetailEntry = {
    title: string;
    subtitle: string;
    startTime: number;
    endTime: number;
    rows: Array<{ label: string; value: string }>;
  };

  let detail: DetailEntry | null = null;

  const candlePat = snapshot.candlestickPatterns.find((x) => x.id === selectedObjectId);
  if (candlePat) {
    detail = {
      title: candlePat.name,
      subtitle: `${candlePat.category} candlestick · ${candlePat.direction}`,
      startTime: candlePat.startTime,
      endTime: candlePat.endTime,
      rows: [
        { label: 'Confirmation', value: candlePat.confirmationStatus },
        { label: 'Quality Score', value: `${candlePat.qualityScore} / 100` },
        { label: 'Formation Price', value: candlePat.formationPrice.toFixed(p) },
        { label: 'Invalidation Level', value: candlePat.invalidationLevel.toFixed(p) },
        { label: 'Formation Time', value: fmt(candlePat.formationTime) },
        { label: 'Confirmation Time', value: fmt(candlePat.confirmationTime) },
        { label: 'Detection Time', value: fmt(candlePat.detectionTime) },
        { label: 'Criteria', value: candlePat.description },
      ],
    };
  }

  const chartPat = snapshot.chartPatterns.find((x) => x.id === selectedObjectId);
  if (!detail && chartPat) {
    detail = {
      title: chartPat.name,
      subtitle: `Classical Chart Pattern · ${chartPat.direction}`,
      startTime: chartPat.startTime,
      endTime: chartPat.endTime,
      rows: [
        { label: 'Lifecycle Status', value: chartPat.status },
        { label: 'Breakout Level', value: chartPat.breakoutLevel.toFixed(p) },
        { label: 'Measured Target', value: chartPat.measuredTarget ? chartPat.measuredTarget.toFixed(p) : '—' },
        { label: 'Invalidation Level', value: chartPat.invalidationLevel.toFixed(p) },
        { label: 'Breakout Time', value: fmt(chartPat.breakoutTime) },
        { label: 'Retest Time', value: fmt(chartPat.retestTime) },
        { label: 'Formation Time', value: fmt(chartPat.formationTime) },
        { label: 'Confirmation Time', value: fmt(chartPat.confirmationTime) },
      ],
    };
  }

  const sr = snapshot.supportResistance.find((x) => x.id === selectedObjectId);
  if (!detail && sr) {
    detail = {
      title: sr.label,
      subtitle: `${sr.kind.toUpperCase()} Zone · ${sr.source}`,
      startTime: sr.firstDetection,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? sr.firstDetection,
      rows: [
        { label: 'Status', value: `${sr.status} (${sr.interactionState})` },
        { label: 'Bounds', value: `${sr.lower.toFixed(p)} – ${sr.upper.toFixed(p)}` },
        { label: 'Midpoint', value: sr.midpoint.toFixed(p) },
        { label: 'Strength Score', value: `${sr.strengthScore} / 100` },
        { label: 'Touches / Rejections', value: `${sr.touches} / ${sr.rejections}` },
        { label: 'Breakouts', value: String(sr.breakouts) },
        { label: 'Distance', value: `${sr.distancePercent}%` },
        { label: 'Last Test', value: fmt(sr.lastTest) },
      ],
    };
  }

  const sd = snapshot.supplyDemand.find((x) => x.id === selectedObjectId);
  if (!detail && sd) {
    detail = {
      title: `${sd.patternType} ${sd.kind.toUpperCase()}`,
      subtitle: `Supply/Demand Zone · ${sd.freshness}`,
      startTime: sd.originCandleTime,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? sd.originCandleTime,
      rows: [
        { label: 'Proximal / Distal', value: `${sd.proximal.toFixed(p)} / ${sd.distal.toFixed(p)}` },
        { label: 'Midpoint', value: sd.midpoint.toFixed(p) },
        { label: 'Departure Strength', value: `${sd.departureStrength}x ATR` },
        { label: 'Mitigation', value: `${sd.mitigationPercent}% (${sd.touches} touches)` },
        { label: 'HTF Aligned', value: sd.htfAligned ? 'Yes' : 'No' },
        { label: 'Interaction', value: sd.interactionState },
        { label: 'Formation Time', value: fmt(sd.formationTime) },
        { label: 'Confirmation Time', value: fmt(sd.confirmationTime) },
      ],
    };
  }

  const ob = snapshot.orderBlocks.find((x) => x.id === selectedObjectId);
  if (!detail && ob) {
    detail = {
      title: ob.kind.replace('_', ' ').toUpperCase(),
      subtitle: `Order Block · ${ob.valid ? 'Valid' : 'Invalidated'}`,
      startTime: ob.originTime,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? ob.originTime,
      rows: [
        { label: 'Bounds', value: `${ob.lower.toFixed(p)} – ${ob.upper.toFixed(p)}` },
        { label: 'Displacement', value: `${ob.displacementAtr}x ATR` },
        { label: 'Mitigation', value: `${ob.mitigationPercent}%` },
        { label: 'Touches', value: String(ob.touches) },
        { label: 'Formation Time', value: fmt(ob.formationTime) },
        { label: 'Invalidation Time', value: fmt(ob.invalidationTime) },
      ],
    };
  }

  const fvg = snapshot.fairValueGaps.find((x) => x.id === selectedObjectId);
  if (!detail && fvg) {
    detail = {
      title: fvg.kind.replace('_', ' ').toUpperCase(),
      subtitle: `Imbalance · ${fvg.status}`,
      startTime: fvg.originTime,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? fvg.originTime,
      rows: [
        { label: 'Bounds', value: `${fvg.lower.toFixed(p)} – ${fvg.upper.toFixed(p)}` },
        { label: 'CE (50%)', value: fvg.consequentEncroachment.toFixed(p) },
        { label: 'Fill %', value: `${fvg.fillPercent}%` },
        { label: 'Formation Time', value: fmt(fvg.formationTime) },
        { label: 'Confirmation Time', value: fmt(fvg.confirmationTime) },
      ],
    };
  }

  const liq = snapshot.liquidityPools.find((x) => x.id === selectedObjectId);
  if (!detail && liq) {
    detail = {
      title: liq.label,
      subtitle: `Liquidity Pool · ${liq.swept ? 'Swept' : 'Active'}`,
      startTime: liq.originTimes[0] ?? liq.formationTime,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? liq.formationTime,
      rows: [
        { label: 'Price Level', value: liq.price.toFixed(p) },
        { label: 'Sweep Status', value: liq.swept ? `Swept (${liq.sweepType})` : 'Unswept' },
        { label: 'Sweep Time', value: fmt(liq.sweepTime) },
        { label: 'Confirmation Time', value: fmt(liq.confirmationTime) },
      ],
    };
  }

  const tl = snapshot.trendlines.find((x) => x.id === selectedObjectId);
  if (!detail && tl) {
    detail = {
      title: tl.kind.replace('_', ' ').toUpperCase(),
      subtitle: `Trendline · ${tl.status}`,
      startTime: tl.p1Time,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? tl.p2Time,
      rows: [
        { label: 'Anchor 1', value: `${tl.p1Price.toFixed(p)} @ ${fmt(tl.p1Time)}` },
        { label: 'Anchor 2', value: `${tl.p2Price.toFixed(p)} @ ${fmt(tl.p2Time)}` },
        { label: 'Projected Price', value: tl.currentProjectedPrice.toFixed(p) },
        { label: 'Touches', value: String(tl.touches) },
        { label: 'Breakout Time', value: fmt(tl.breakoutTime) },
        { label: 'Retest Time', value: fmt(tl.retestTime) },
      ],
    };
  }

  const br = snapshot.marketStructure.breaks.find((x) => x.id === selectedObjectId);
  if (!detail && br) {
    detail = {
      title: `${br.direction.toUpperCase()} ${br.type}`,
      subtitle: `Market Structure (${br.scope})`,
      startTime: br.originTime,
      endTime: br.breakTime,
      rows: [
        { label: 'Level Price', value: br.levelPrice.toFixed(p) },
        { label: 'Break Method', value: br.breakMethod },
        { label: 'Origin Time', value: fmt(br.originTime) },
        { label: 'Break Time', value: fmt(br.breakTime) },
        { label: 'Confirmation', value: br.confirmationStatus },
      ],
    };
  }

  const sig = signals.find((x) => x.id === selectedObjectId);
  if (!detail && sig) {
    detail = {
      title: `${sig.direction} SIGNAL · ${sig.symbol}`,
      subtitle: `${sig.state} · ${sig.score}/100 (${sig.classification})`,
      startTime: sig.candleTime,
      endTime: snapshot.candles[snapshot.candles.length - 1]?.time ?? sig.candleTime,
      rows: [
        { label: 'Execution TF', value: `${sig.entryTimeframe} (Setup ${sig.setupTimeframe})` },
        { label: 'Entry Price', value: sig.entryPrice.toFixed(p) },
        { label: 'Entry Zone', value: `${sig.entryZone.lower.toFixed(p)} – ${sig.entryZone.upper.toFixed(p)}` },
        { label: 'Stop Loss', value: sig.stopLoss.toFixed(p) },
        { label: 'Invalidation', value: sig.invalidationLevel.toFixed(p) },
        ...sig.takeProfits.map((tp) => ({
          label: `TP${tp.level}${tp.hit ? ' [HIT]' : ''}`,
          value: `${tp.price.toFixed(p)} (1:${tp.riskReward})`,
        })),
        { label: 'HTF Bias', value: `1D:${sig.htfBias.d1} · 4H:${sig.htfBias.h4} · 1H:${sig.htfBias.h1}` },
      ],
    };
  }

  if (!detail) return null;

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-30 w-80 border border-[#2B3548] bg-[#12161F]/95 p-3 shadow-2xl backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2 border-b border-[#222938] pb-2">
        <div>
          <div className="text-xs font-semibold text-[#E6EDF3]">{detail.title}</div>
          <div className="text-[11px] text-[#8B949E]">{detail.subtitle}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => focusChartObject(selectedObjectId, detail!.startTime, detail!.endTime)}
            title="Focus on Chart"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#38BDF8] hover:bg-[#1C2331] cursor-pointer"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSelectedObjectId(null)}
            title="Close Inspector"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 space-y-1 font-mono text-[11px] tabular-nums">
        {detail.rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-2">
            <span className="text-[#8B949E] shrink-0">{r.label}</span>
            <span className="text-right text-[#E6EDF3]">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
