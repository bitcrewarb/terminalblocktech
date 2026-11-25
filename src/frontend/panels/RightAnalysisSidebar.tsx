import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type { InstrumentSymbol } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import { SignalConfigurationPanel } from './SignalConfigurationPanel.tsx';

type SectionId =
  | 'market_structure'
  | 'candle_patterns'
  | 'chart_patterns'
  | 'support_resistance'
  | 'supply_demand'
  | 'liquidity'
  | 'order_blocks'
  | 'fvg'
  | 'trendlines'
  | 'mtf'
  | 'live_events';

export function RightAnalysisSidebar({
  onOpenMtfModal,
  onOpenSignalCenter,
}: {
  onOpenMtfModal: () => void;
  onOpenSignalCenter?: () => void;
}) {
  const {
    symbol,
    timeframe,
    snapshot,
    mtfSummary,
    loadingMtf,
    refreshMtf,
    events,
    timezone,
    hoveredObjectId,
    selectedObjectId,
    setHoveredObjectId,
    focusChartObject,
    selectTimeframe,
    setDealingRangeLookback,
  } = useTerminal();

  const requestedMtfSymbolRef = useRef<InstrumentSymbol | null>(null);
  useEffect(() => {
    if (
      requestedMtfSymbolRef.current !== symbol &&
      !loadingMtf &&
      (!mtfSummary || mtfSummary.symbol !== symbol)
    ) {
      requestedMtfSymbolRef.current = symbol;
      void refreshMtf();
    }
  }, [symbol, mtfSummary, loadingMtf, refreshMtf]);

  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    market_structure: true,
    candle_patterns: true,
    chart_patterns: true,
    support_resistance: true,
    supply_demand: false,
    liquidity: false,
    order_blocks: false,
    fvg: false,
    trendlines: false,
    mtf: true,
    live_events: false,
  });
  const [rangeLookback, setRangeLookback] = useState<string>('auto');

  const meta = getInstrumentMeta(symbol);
  const p = meta.pricePrecision;
  const currentPrice = snapshot?.quote?.price ?? snapshot?.candles[snapshot.candles.length - 1]?.close ?? 0;

  const toggle = (id: SectionId) =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const fmtTime = (secOrMs: number, isMs = false) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(isMs ? secOrMs : secOrMs * 1000));

  const rowClass = (id: string, urgent = false) => {
    const active = hoveredObjectId === id || selectedObjectId === id;
    return `cursor-pointer border-b border-[#1D2432] px-3 py-1.5 text-[11px] transition-colors ${
      active
        ? 'border-l-2 border-l-[#38BDF8] bg-[#1F2D42]'
        : urgent
          ? 'bg-[#F59E0B]/10 hover:bg-[#F59E0B]/15'
          : 'hover:bg-[#161B26]'
    }`;
  };

  const renderSectionHeader = (id: SectionId, title: string, count: number | string) => (
    <button
      type="button"
      onClick={() => toggle(id)}
      className="flex w-full items-center justify-between border-b border-[#222938] bg-[#161B26] px-3 py-2 text-left text-xs font-semibold text-[#E6EDF3] hover:bg-[#1C2331] cursor-pointer"
    >
      <span className="flex items-center gap-1.5">
        {openSections[id] ? (
          <ChevronDown className="h-3.5 w-3.5 text-[#8B949E]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[#8B949E]" />
        )}
        <span>{title}</span>
      </span>
      <span className="font-mono text-[11px] font-normal text-[#8B949E] tabular-nums">
        {count}
      </span>
    </button>
  );

  const ms = snapshot?.marketStructure;
  const dr = snapshot?.dealingRange;
  const demands = (snapshot?.supplyDemand ?? []).filter((z) => z.kind === 'demand' && z.freshness !== 'invalidated');
  const supplies = (snapshot?.supplyDemand ?? []).filter((z) => z.kind === 'supply' && z.freshness !== 'invalidated');

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-[#222938] bg-[#12161F]">
      {/* Signal Configuration (Pre-Trigger SMC Criteria Gates) */}
      <SignalConfigurationPanel
        variant="sidebar"
        onOpenSignalCenter={onOpenSignalCenter}
      />

      {/* 1. Market Structure + Premium/Discount */}
      <div>
        {renderSectionHeader('market_structure', '1. Market Structure', ms ? ms.trend.toUpperCase() : '—')}
        {openSections.market_structure && (
          <div className="divide-y divide-[#1D2432] border-b border-[#222938]">
            {ms ? (
              <>
                <div className="grid grid-cols-2 gap-2 px-3 py-2 font-mono text-[11px] tabular-nums">
                  <div>
                    <div className="text-[10px] text-[#8B949E]">External Trend</div>
                    <div
                      className={
                        ms.trend === 'bullish'
                          ? 'font-semibold text-[#0ECB81]'
                          : ms.trend === 'bearish'
                            ? 'font-semibold text-[#F6465D]'
                            : 'text-[#C9D1D9]'
                      }
                    >
                      {ms.trend.toUpperCase()} ({ms.lastExternalLabel})
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#8B949E]">Internal Trend</div>
                    <div className="text-[#C9D1D9]">
                      {ms.internalTrend.toUpperCase()} ({ms.lastInternalLabel})
                    </div>
                  </div>
                </div>

                {dr && (
                  <div className="space-y-1.5 bg-[#0B0E14]/50 px-3 py-2 font-mono text-[11px] tabular-nums">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-[#8B949E]">Dealing Range ({dr.sourceTimeframe})</span>
                      <select
                        aria-label="Dealing range lookback"
                        value={rangeLookback}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRangeLookback(v);
                          void setDealingRangeLookback(v === 'auto' ? undefined : Number(v));
                        }}
                        className="border border-[#222938] bg-[#12161F] px-1 py-0.5 text-[10px] text-[#38BDF8] outline-none cursor-pointer"
                      >
                        <option value="auto">Auto Swing</option>
                        <option value="50">50 Bars</option>
                        <option value="100">100 Bars</option>
                        <option value="200">200 Bars</option>
                      </select>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8B949E]">Position</span>
                      <span
                        className={
                          dr.currentPosition === 'discount'
                            ? 'text-[#0ECB81]'
                            : dr.currentPosition === 'premium'
                              ? 'text-[#F6465D]'
                              : 'text-[#38BDF8]'
                        }
                      >
                        {dr.currentPosition.toUpperCase()} ({dr.retracementPercent}%)
                        {dr.inOteZone ? ' · OTE' : ''}
                      </span>
                    </div>
                    <div className="flex justify-between text-[10px] text-[#8B949E]">
                      <span>Low {dr.rangeLow.toFixed(p)}</span>
                      <span>EQ {dr.equilibrium.toFixed(p)}</span>
                      <span>High {dr.rangeHigh.toFixed(p)}</span>
                    </div>
                  </div>
                )}

                {ms.breaks.slice(-6).reverse().map((br) => (
                  <div
                    key={br.id}
                    onMouseEnter={() => setHoveredObjectId(br.id)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() => focusChartObject(br.id, br.originTime, br.breakTime)}
                    className={rowClass(br.id)}
                  >
                    <div className="flex items-center justify-between font-mono tabular-nums">
                      <span
                        className={
                          br.direction === 'bullish' ? 'font-semibold text-[#0ECB81]' : 'font-semibold text-[#F6465D]'
                        }
                      >
                        {br.direction === 'bullish' ? 'Bullish' : 'Bearish'} {br.type}
                      </span>
                      <span className="text-[#E6EDF3]">{br.levelPrice.toFixed(p)}</span>
                    </div>
                    <div className="mt-0.5 flex justify-between text-[10px] text-[#8B949E]">
                      <span>
                        {br.scope} · {br.breakMethod}
                      </span>
                      <span className="font-mono">{fmtTime(br.breakTime)}</span>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <div className="px-3 py-2 text-[11px] text-[#8B949E]">No structure data loaded.</div>
            )}
          </div>
        )}
      </div>

      {/* 2. Candlestick Patterns */}
      <div>
        {renderSectionHeader(
          'candle_patterns',
          '2. Candlestick Patterns',
          snapshot?.candlestickPatterns.length ?? 0
        )}
        {openSections.candle_patterns && (
          <div className="max-h-56 overflow-y-auto border-b border-[#222938]">
            {(snapshot?.candlestickPatterns.length ?? 0) === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[#8B949E]">No patterns detected.</div>
            ) : (
              [...(snapshot?.candlestickPatterns ?? [])]
                .reverse()
                .map((pat) => (
                  <div
                    key={pat.id}
                    onMouseEnter={() => setHoveredObjectId(pat.id)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() => focusChartObject(pat.id, pat.startTime, pat.endTime)}
                    className={rowClass(pat.id)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[#E6EDF3]">{pat.name}</span>
                      <span
                        className={`font-mono text-[10px] ${
                          pat.direction === 'bullish'
                            ? 'text-[#0ECB81]'
                            : pat.direction === 'bearish'
                              ? 'text-[#F6465D]'
                              : 'text-[#F59E0B]'
                        }`}
                      >
                        {pat.direction.toUpperCase()} · Q{pat.qualityScore}
                      </span>
                    </div>
                    <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                      <span>
                        {symbol} {timeframe} · {pat.formationPrice.toFixed(p)} (Now {currentPrice.toFixed(p)})
                      </span>
                      <span>{pat.confirmationStatus}</span>
                    </div>
                    <div className="mt-0.5 text-right font-mono text-[10px] text-[#6E7681]">
                      {fmtTime(pat.detectionTime)}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}
      </div>

      {/* 3. Chart Patterns */}
      <div>
        {renderSectionHeader(
          'chart_patterns',
          '3. Chart Patterns',
          snapshot?.chartPatterns.length ?? 0
        )}
        {openSections.chart_patterns && (
          <div className="max-h-52 overflow-y-auto border-b border-[#222938]">
            {(snapshot?.chartPatterns.length ?? 0) === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[#8B949E]">No classical formations active.</div>
            ) : (
              snapshot?.chartPatterns.map((cp) => (
                <div
                  key={cp.id}
                  onMouseEnter={() => setHoveredObjectId(cp.id)}
                  onMouseLeave={() => setHoveredObjectId(null)}
                  onClick={() => focusChartObject(cp.id, cp.startTime, cp.endTime)}
                  className={rowClass(cp.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#E6EDF3]">{cp.name}</span>
                    <span className="font-mono text-[10px] text-[#38BDF8]">{cp.status}</span>
                  </div>
                  <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                    <span className={cp.direction === 'bullish' ? 'text-[#0ECB81]' : cp.direction === 'bearish' ? 'text-[#F6465D]' : ''}>
                      {cp.direction} · BO {cp.breakoutLevel.toFixed(p)}
                    </span>
                    <span>
                      {cp.measuredTarget ? `Tgt ${cp.measuredTarget.toFixed(p)}` : '—'}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 4. Support & Resistance */}
      <div>
        {renderSectionHeader(
          'support_resistance',
          '4. Support & Resistance',
          snapshot?.supportResistance.length ?? 0
        )}
        {openSections.support_resistance && (
          <div className="max-h-60 overflow-y-auto border-b border-[#222938]">
            {(snapshot?.supportResistance.length ?? 0) === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[#8B949E]">No S/R clusters found.</div>
            ) : (
              snapshot?.supportResistance.map((sr) => {
                const urgent =
                  sr.status === 'Approaching' ||
                  sr.status === 'Near' ||
                  sr.status === 'Touched' ||
                  sr.status === 'Breaking';
                return (
                  <div
                    key={sr.id}
                    onMouseEnter={() => setHoveredObjectId(sr.id)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() =>
                      focusChartObject(
                        sr.id,
                        sr.firstDetection,
                        snapshot.candles[snapshot.candles.length - 1]?.time ?? sr.firstDetection
                      )
                    }
                    className={rowClass(sr.id, urgent)}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-medium ${
                          sr.kind === 'support' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                        }`}
                      >
                        {sr.label}
                      </span>
                      <span className="font-mono text-[10px] text-[#E6EDF3] tabular-nums">
                        {sr.lower.toFixed(p)} – {sr.upper.toFixed(p)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                      <span>
                        {sr.status}
                        {sr.touchMethod ? ` (${sr.touchMethod})` : ''} · S{sr.strengthScore}
                      </span>
                      <span>
                        {sr.touches}T / {sr.rejections}R · {sr.distancePercent}%
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 5. Supply & Demand */}
      <div>
        {renderSectionHeader(
          'supply_demand',
          '5. Supply & Demand',
          `${demands.length}D / ${supplies.length}S`
        )}
        {openSections.supply_demand && (
          <div className="max-h-64 overflow-y-auto border-b border-[#222938]">
            <div className="bg-[#0B0E14] px-3 py-1 text-[10px] font-semibold text-[#0ECB81]">
              Demand Zones ({demands.length})
            </div>
            {demands.map((z) => (
              <div
                key={z.id}
                onMouseEnter={() => setHoveredObjectId(z.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    z.id,
                    z.originCandleTime,
                    snapshot?.candles[snapshot.candles.length - 1]?.time ?? z.originCandleTime
                  )
                }
                className={rowClass(
                  z.id,
                  z.interactionState === 'Near' ||
                    z.interactionState === 'Touched' ||
                    z.interactionState === 'Entered Zone'
                )}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-[#0ECB81]">
                    {z.patternType} · {z.freshness}
                  </span>
                  <span className="text-[#E6EDF3]">
                    {z.distal.toFixed(p)} – {z.proximal.toFixed(p)}
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                  <span>
                    {z.departureStrength}x ATR · Mit {z.mitigationPercent}%
                  </span>
                  <span>
                    {z.htfAligned ? 'HTF Aligned · ' : ''}
                    {z.distancePercent}%
                  </span>
                </div>
              </div>
            ))}

            <div className="bg-[#0B0E14] px-3 py-1 text-[10px] font-semibold text-[#F6465D]">
              Supply Zones ({supplies.length})
            </div>
            {supplies.map((z) => (
              <div
                key={z.id}
                onMouseEnter={() => setHoveredObjectId(z.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    z.id,
                    z.originCandleTime,
                    snapshot?.candles[snapshot.candles.length - 1]?.time ?? z.originCandleTime
                  )
                }
                className={rowClass(
                  z.id,
                  z.interactionState === 'Near' ||
                    z.interactionState === 'Touched' ||
                    z.interactionState === 'Entered Zone'
                )}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-[#F6465D]">
                    {z.patternType} · {z.freshness}
                  </span>
                  <span className="text-[#E6EDF3]">
                    {z.proximal.toFixed(p)} – {z.distal.toFixed(p)}
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                  <span>
                    {z.departureStrength}x ATR · Mit {z.mitigationPercent}%
                  </span>
                  <span>
                    {z.htfAligned ? 'HTF Aligned · ' : ''}
                    {z.distancePercent}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 6. Liquidity */}
      <div>
        {renderSectionHeader('liquidity', '6. Liquidity Pools', snapshot?.liquidityPools.length ?? 0)}
        {openSections.liquidity && (
          <div className="max-h-52 overflow-y-auto border-b border-[#222938]">
            {snapshot?.liquidityPools.map((liq) => (
              <div
                key={liq.id}
                onMouseEnter={() => setHoveredObjectId(liq.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    liq.id,
                    liq.originTimes[0] ?? liq.formationTime,
                    snapshot.candles[snapshot.candles.length - 1]?.time ?? liq.formationTime
                  )
                }
                className={rowClass(liq.id)}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span className={liq.swept ? 'text-[#8B949E]' : 'text-[#FACC15]'}>
                    {liq.label}
                  </span>
                  <span className="text-[#E6EDF3]">{liq.price.toFixed(p)}</span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E]">
                  <span>{liq.swept ? `Swept (${liq.sweepType})` : 'Unswept Pool'}</span>
                  <span>{liq.interactionState}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 7. Order Blocks */}
      <div>
        {renderSectionHeader('order_blocks', '7. Order Blocks', snapshot?.orderBlocks.length ?? 0)}
        {openSections.order_blocks && (
          <div className="max-h-52 overflow-y-auto border-b border-[#222938]">
            {snapshot?.orderBlocks.map((ob) => (
              <div
                key={ob.id}
                onMouseEnter={() => setHoveredObjectId(ob.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    ob.id,
                    ob.originTime,
                    snapshot.candles[snapshot.candles.length - 1]?.time ?? ob.originTime
                  )
                }
                className={rowClass(ob.id)}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span
                    className={
                      ob.kind === 'bullish_ob'
                        ? 'text-[#38BDF8]'
                        : ob.kind === 'bearish_ob'
                          ? 'text-[#FB923C]'
                          : 'text-[#C084FC]'
                    }
                  >
                    {ob.kind.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="text-[#E6EDF3]">
                    {ob.lower.toFixed(p)} – {ob.upper.toFixed(p)}
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                  <span>{ob.valid ? 'Valid' : 'Invalidated'} · Mit {ob.mitigationPercent}%</span>
                  <span>{ob.displacementAtr}x ATR</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 8. Fair Value Gaps */}
      <div>
        {renderSectionHeader('fvg', '8. Fair Value Gaps', snapshot?.fairValueGaps.length ?? 0)}
        {openSections.fvg && (
          <div className="max-h-52 overflow-y-auto border-b border-[#222938]">
            {snapshot?.fairValueGaps.map((f) => (
              <div
                key={f.id}
                onMouseEnter={() => setHoveredObjectId(f.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    f.id,
                    f.originTime,
                    snapshot.candles[snapshot.candles.length - 1]?.time ?? f.originTime
                  )
                }
                className={rowClass(f.id)}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span className={f.kind.includes('bullish') ? 'text-[#22D3EE]' : 'text-[#FB7185]'}>
                    {f.kind.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="text-[#E6EDF3]">
                    {f.lower.toFixed(p)} – {f.upper.toFixed(p)}
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                  <span>CE {f.consequentEncroachment.toFixed(p)}</span>
                  <span>
                    {f.status} ({f.fillPercent}%)
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 9. Trendlines */}
      <div>
        {renderSectionHeader('trendlines', '9. Trendlines', snapshot?.trendlines.length ?? 0)}
        {openSections.trendlines && (
          <div className="max-h-44 overflow-y-auto border-b border-[#222938]">
            {snapshot?.trendlines.map((tl) => (
              <div
                key={tl.id}
                onMouseEnter={() => setHoveredObjectId(tl.id)}
                onMouseLeave={() => setHoveredObjectId(null)}
                onClick={() =>
                  focusChartObject(
                    tl.id,
                    tl.p1Time,
                    snapshot.candles[snapshot.candles.length - 1]?.time ?? tl.p2Time
                  )
                }
                className={rowClass(tl.id)}
              >
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-[#E6EDF3]">{tl.kind.replace('_', ' ')}</span>
                  <span className="text-[#38BDF8]">{tl.status}</span>
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                  <span>{tl.touches} touches</span>
                  <span>Proj {tl.currentProjectedPrice.toFixed(p)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 10. Multi-Timeframe Analysis */}
      <div>
        {renderSectionHeader(
          'mtf',
          '10. Multi-Timeframe',
          mtfSummary?.overallAlignment ?? 'Loading'
        )}
        {openSections.mtf && (
          <div className="border-b border-[#222938]">
            {mtfSummary && (
              <>
                <div className="flex items-center justify-between bg-[#0B0E14]/60 px-3 py-1.5 text-[11px]">
                  <span className="font-mono">
                    HTF <span className="text-[#E6EDF3]">{mtfSummary.htfBias.toUpperCase()}</span> / LTF{' '}
                    <span className="text-[#E6EDF3]">{mtfSummary.ltfBias.toUpperCase()}</span>
                  </span>
                  <button
                    type="button"
                    onClick={onOpenMtfModal}
                    className="flex items-center gap-1 text-[#38BDF8] hover:underline cursor-pointer"
                  >
                    <span>Full Matrix</span>
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
                <div className="divide-y divide-[#1D2432]">
                  {mtfSummary.rows
                    .filter((r) => ['5m', '15m', '1H', '4H', '1D', '1W'].includes(r.timeframe))
                    .map((r) => (
                      <button
                        key={r.timeframe}
                        type="button"
                        onClick={() => selectTimeframe(r.timeframe)}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[11px] tabular-nums hover:bg-[#161B26] cursor-pointer ${
                          timeframe === r.timeframe ? 'bg-[#1C2331]' : ''
                        }`}
                      >
                        <span className="w-10 font-semibold text-[#E6EDF3]">{r.timeframe}</span>
                        <span
                          className={
                            r.trend === 'bullish'
                              ? 'text-[#0ECB81]'
                              : r.trend === 'bearish'
                                ? 'text-[#F6465D]'
                                : 'text-[#8B949E]'
                          }
                        >
                          {r.available ? r.trend.toUpperCase() : 'NO DATA'}
                        </span>
                        <span className="text-[10px] text-[#8B949E]">{r.lastSequence}</span>
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 11. Live Market Events */}
      <div>
        {renderSectionHeader(
          'live_events',
          '11. Live Market Events',
          events.filter((e) => e.symbol === symbol).length
        )}
        {openSections.live_events && (
          <div className="max-h-48 overflow-y-auto">
            {events
              .filter((e) => e.symbol === symbol)
              .slice(0, 12)
              .map((ev) => (
                <div
                  key={ev.id}
                  onMouseEnter={() => setHoveredObjectId(ev.objectId)}
                  onMouseLeave={() => setHoveredObjectId(null)}
                  onClick={() => {
                    const sec = Math.floor(ev.timestamp / 1000);
                    focusChartObject(ev.objectId, sec - 3600 * 6, sec + 3600 * 2);
                  }}
                  className={rowClass(ev.objectId)}
                >
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-[#E6EDF3]">{ev.objectLabel}</span>
                    <span className="text-[#38BDF8]">{ev.status}</span>
                  </div>
                  <div className="mt-0.5 flex justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                    <span>{ev.timeframe}</span>
                    <span>{fmtTime(ev.timestamp, true)}</span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </aside>
  );
}
