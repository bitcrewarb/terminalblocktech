import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type { SignalLifecycleState } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

type BottomTab =
  | 'live_events'
  | 'signals'
  | 'patterns'
  | 'bos_choch'
  | 'zone_monitor'
  | 'sweeps_breakouts';

const OPEN_SIGNAL_STATES = new Set<SignalLifecycleState>([
  'WATCHING',
  'CONFIRMED',
  'ACTIVE',
  'PARTIAL',
  'TP1_HIT',
  'TP2_HIT',
]);

export function BottomEventsPanel({
  onOpenSignalCenter,
}: {
  onOpenSignalCenter?: () => void;
}) {
  const {
    symbol,
    timeframe,
    snapshot,
    events,
    signals,
    signalDiagnostics,
    timezone,
    hoveredObjectId,
    setHoveredObjectId,
    focusChartObject,
    selectSymbol,
    selectTimeframe,
    deleteSignal,
  } = useTerminal();

  const [tab, setTab] = useState<BottomTab>('live_events');
  const [onlyActiveTf, setOnlyActiveTf] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const meta = getInstrumentMeta(symbol);

  const fmtTime = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));

  const filteredEvents = useMemo(() => {
    let symEvents = events.filter((e) => e.symbol === symbol);
    if (onlyActiveTf) {
      symEvents = symEvents.filter((e) => e.timeframe === timeframe);
    }
    if (tab === 'bos_choch') {
      symEvents = symEvents.filter((e) => e.objectCategory === 'market_structure');
    } else if (tab === 'sweeps_breakouts') {
      symEvents = symEvents.filter(
        (e) =>
          e.objectCategory === 'liquidity' ||
          e.status === 'Confirmed Breakout' ||
          e.status === 'Breaking' ||
          e.status === 'Retesting'
      );
    }
    return [...symEvents].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }, [events, symbol, timeframe, onlyActiveTf, tab]);

  const zoneRows = useMemo(() => {
    return (snapshot?.zoneInteractions ?? [])
      .filter((z) => z.status !== 'Far Away' && z.status !== 'Invalidated')
      .slice(0, 30);
  }, [snapshot?.zoneInteractions]);

  const openSignalCount = useMemo(
    () => signals.filter((s) => OPEN_SIGNAL_STATES.has(s.state)).length,
    [signals]
  );

  const latestPatterns = useMemo(() => {
    if (!snapshot) return [];
    const cp = snapshot.candlestickPatterns.map((p) => ({
      id: p.id,
      kind: 'Candle',
      name: p.name,
      direction: p.direction,
      price: p.formationPrice,
      status: p.confirmationStatus,
      time: p.detectionTime,
      start: p.startTime,
      end: p.endTime,
    }));
    const ch = snapshot.chartPatterns.map((p) => ({
      id: p.id,
      kind: 'Chart',
      name: p.name,
      direction: p.direction,
      price: p.breakoutLevel,
      status: p.status,
      time: p.detectionTime,
      start: p.startTime,
      end: p.endTime,
    }));
    return [...cp, ...ch].sort((a, b) => b.time - a.time).slice(0, 30);
  }, [snapshot]);

  const tabs: Array<{ id: BottomTab; label: string }> = [
    { id: 'live_events', label: 'Live Technical Events' },
    { id: 'signals', label: `BUY/SELL Signals (${openSignalCount})` },
    { id: 'zone_monitor', label: `Zone Monitor (${zoneRows.length})` },
    { id: 'patterns', label: 'Latest Patterns' },
    { id: 'bos_choch', label: 'BOS & CHoCH' },
    { id: 'sweeps_breakouts', label: 'Sweeps & Breakouts' },
  ];

  return (
    <section className="flex h-full flex-col border-t border-[#222938] bg-[#12161F]">
      <div className="flex items-center justify-between border-b border-[#222938] px-3 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1 text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                tab === t.id
                  ? 'bg-[#1C2331] text-[#38BDF8]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenSignalCenter && (
            <button
              type="button"
              onClick={onOpenSignalCenter}
              className="border border-[#2B3548] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#0ECB81] hover:border-[#0ECB81] cursor-pointer"
            >
              Signal Center
            </button>
          )}
          <button
            type="button"
            onClick={() => setOnlyActiveTf((v) => !v)}
            className="border border-[#222938] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            {onlyActiveTf ? `TF: ${timeframe}` : 'All TFs'}
          </button>
          <span className="hidden sm:inline font-mono text-[11px] text-[#8B949E]">
            {symbol} · Click row to focus chart
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'signals' ? (
          <table className="w-full text-left font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#161B26] text-[#8B949E]">
              <tr>
                <th className="px-3 py-1.5 font-medium">Instrument</th>
                <th className="px-3 py-1.5 font-medium">Side</th>
                <th className="px-3 py-1.5 font-medium">State</th>
                <th className="px-3 py-1.5 font-medium text-right">Score</th>
                <th className="px-3 py-1.5 font-medium text-right">Entry</th>
                <th className="px-3 py-1.5 font-medium text-right">Stop Loss</th>
                <th className="px-3 py-1.5 font-medium text-right">Targets</th>
                <th className="px-3 py-1.5 font-medium text-right">Saved</th>
                <th className="px-3 py-1.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1D2432]">
              {signals.length > 0 ? (
                signals.slice(0, 60).map((sig) => {
                  const sigMeta = getInstrumentMeta(sig.symbol);
                  const tp1 = sig.takeProfits[0];
                  const confirming = confirmDeleteId === sig.id;
                  return (
                    <tr
                      key={sig.id}
                      onMouseEnter={() => setHoveredObjectId(sig.id)}
                      onMouseLeave={() => setHoveredObjectId(null)}
                      onClick={() => {
                        if (sig.symbol !== symbol) selectSymbol(sig.symbol);
                        if (sig.entryTimeframe !== timeframe) selectTimeframe(sig.entryTimeframe);
                        focusChartObject(sig.id, sig.candleTime - 3600 * 2, sig.candleTime + 3600 * 4);
                      }}
                      className={`cursor-pointer transition-colors ${
                        hoveredObjectId === sig.id ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                      }`}
                    >
                      <td className="px-3 py-1 text-[#E6EDF3]">
                        {sig.symbol} · {sig.entryTimeframe}
                      </td>
                      <td
                        className={`px-3 py-1 font-semibold ${
                          sig.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                        }`}
                      >
                        {sig.direction}
                      </td>
                      <td className="px-3 py-1 text-[#C9D1D9]">
                        {sig.state}
                        {sig.provisional ? ' (Provisional)' : ''}
                      </td>
                      <td className="px-3 py-1 text-right text-[#38BDF8]">
                        {sig.score}/100
                      </td>
                      <td className="px-3 py-1 text-right text-[#E6EDF3]">
                        {sig.entryPrice.toFixed(sigMeta.pricePrecision)}
                      </td>
                      <td className="px-3 py-1 text-right text-[#F6465D]">
                        {sig.stopLoss.toFixed(sigMeta.pricePrecision)}
                      </td>
                      <td className="px-3 py-1 text-right text-[#0ECB81]">
                        {tp1
                          ? `${tp1.price.toFixed(sigMeta.pricePrecision)} (1:${tp1.riskReward.toFixed(2)})${sig.takeProfits.length > 1 ? ` +${sig.takeProfits.length - 1}` : ''}`
                          : '—'}
                      </td>
                      <td className="px-3 py-1 text-right text-[#8B949E]">
                        {fmtTime(sig.closedAt ?? sig.activatedAt ?? sig.confirmedAt ?? sig.createdAt)}
                      </td>
                      <td
                        className="px-3 py-1 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!confirming ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(sig.id)}
                            title="Delete signal from SQLite"
                            className="inline-flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-1.5 py-0.5 text-[10px] text-[#8B949E] hover:border-[#F6465D]/60 hover:text-[#F6465D] cursor-pointer"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Del</span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null);
                                void deleteSignal(sig.id);
                              }}
                              className="border border-[#F6465D] bg-[#F6465D]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#F6465D] cursor-pointer"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="border border-[#222938] bg-[#0B0E14] px-1.5 py-0.5 text-[10px] text-[#8B949E] cursor-pointer"
                            >
                              No
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : signalDiagnostics.length > 0 ? (
                signalDiagnostics.map((d) => (
                  <tr
                    key={d.symbol}
                    onClick={() => {
                      if (d.symbol !== symbol) selectSymbol(d.symbol);
                      onOpenSignalCenter?.();
                    }}
                    className="cursor-pointer hover:bg-[#161B26]"
                  >
                    <td className="px-3 py-1 text-[#E6EDF3]">
                      {d.symbol} · {d.timeframe}
                    </td>
                    <td className="px-3 py-1 text-[#8B949E]">{d.dominantDirection}</td>
                    <td className="px-3 py-1 text-[#F59E0B]">NO TRADE</td>
                    <td className="px-3 py-1 text-right text-[#8B949E]">
                      B{d.buyScore} / S{d.sellScore}
                    </td>
                    <td colSpan={4} className="px-3 py-1 text-[#8B949E] truncate max-w-[360px]">
                      {d.rejectionReasons[0] ?? 'Waiting for valid multi-timeframe SMC confluence.'}
                    </td>
                    <td className="px-3 py-1 text-right text-[#8B949E]">
                      {fmtTime(d.evaluatedAt)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={9} className="px-3 py-4 text-center text-[#8B949E]">
                    Evaluating multi-timeframe SMC structure for BUY/SELL setups...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : tab === 'patterns' ? (
          <table className="w-full text-left font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#161B26] text-[#8B949E]">
              <tr>
                <th className="px-3 py-1.5 font-medium">Type</th>
                <th className="px-3 py-1.5 font-medium">Pattern</th>
                <th className="px-3 py-1.5 font-medium">Direction</th>
                <th className="px-3 py-1.5 font-medium text-right">Level</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 font-medium text-right">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1D2432]">
              {latestPatterns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-[#8B949E]">
                    No patterns detected in active window.
                  </td>
                </tr>
              ) : (
                latestPatterns.map((p) => (
                  <tr
                    key={p.id}
                    onMouseEnter={() => setHoveredObjectId(p.id)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() => focusChartObject(p.id, p.start, p.end)}
                    className={`cursor-pointer transition-colors ${
                      hoveredObjectId === p.id ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                    }`}
                  >
                    <td className="px-3 py-1 text-[#8B949E]">{p.kind}</td>
                    <td className="px-3 py-1 text-[#E6EDF3]">{p.name}</td>
                    <td
                      className={`px-3 py-1 ${
                        p.direction === 'bullish'
                          ? 'text-[#0ECB81]'
                          : p.direction === 'bearish'
                            ? 'text-[#F6465D]'
                            : 'text-[#F59E0B]'
                      }`}
                    >
                      {p.direction}
                    </td>
                    <td className="px-3 py-1 text-right text-[#E6EDF3]">
                      {p.price.toFixed(meta.pricePrecision)}
                    </td>
                    <td className="px-3 py-1 text-[#C9D1D9]">{p.status}</td>
                    <td className="px-3 py-1 text-right text-[#8B949E]">
                      {fmtTime(p.time * 1000)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : tab === 'zone_monitor' ? (
          <table className="w-full text-left font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#161B26] text-[#8B949E]">
              <tr>
                <th className="px-3 py-1.5 font-medium">Object</th>
                <th className="px-3 py-1.5 font-medium">TF</th>
                <th className="px-3 py-1.5 font-medium text-right">Boundaries</th>
                <th className="px-3 py-1.5 font-medium text-right">Price</th>
                <th className="px-3 py-1.5 font-medium text-right">Dist %</th>
                <th className="px-3 py-1.5 font-medium">State</th>
                <th className="px-3 py-1.5 font-medium text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1D2432]">
              {zoneRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[#8B949E]">
                    No zones currently within approaching threshold.
                  </td>
                </tr>
              ) : (
                zoneRows.map((z) => (
                  <tr
                    key={z.id}
                    onMouseEnter={() => setHoveredObjectId(z.objectId)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() => {
                      const nowSec = Math.floor(Date.now() / 1000);
                      focusChartObject(z.objectId, nowSec - 3600 * 12, nowSec);
                    }}
                    className={`cursor-pointer ${
                      hoveredObjectId === z.objectId ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                    }`}
                  >
                    <td className="px-3 py-1 text-[#E6EDF3]">{z.objectLabel}</td>
                    <td className="px-3 py-1 text-[#8B949E]">{z.timeframe}</td>
                    <td className="px-3 py-1 text-right text-[#C9D1D9]">
                      {z.lowerBound.toFixed(meta.pricePrecision)} – {z.upperBound.toFixed(meta.pricePrecision)}
                    </td>
                    <td className="px-3 py-1 text-right text-[#E6EDF3]">
                      {z.currentPrice.toFixed(meta.pricePrecision)}
                    </td>
                    <td className="px-3 py-1 text-right text-[#F59E0B]">{z.distancePercent}%</td>
                    <td className="px-3 py-1 text-[#38BDF8]">{z.status}</td>
                    <td className="px-3 py-1 text-right text-[#8B949E]">{fmtTime(z.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#161B26] text-[#8B949E]">
              <tr>
                <th className="px-3 py-1.5 font-medium">TF</th>
                <th className="px-3 py-1.5 font-medium">Category</th>
                <th className="px-3 py-1.5 font-medium">Event</th>
                <th className="px-3 py-1.5 font-medium text-right">Price</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 font-medium text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1D2432]">
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-[#8B949E]">
                    Monitoring live market stream for technical events...
                  </td>
                </tr>
              ) : (
                filteredEvents.map((ev) => (
                  <tr
                    key={ev.id}
                    onMouseEnter={() => setHoveredObjectId(ev.objectId)}
                    onMouseLeave={() => setHoveredObjectId(null)}
                    onClick={() => {
                      const sec = Math.floor(ev.timestamp / 1000);
                      focusChartObject(ev.objectId, sec - 3600 * 6, sec + 3600 * 2);
                    }}
                    className={`cursor-pointer ${
                      hoveredObjectId === ev.objectId ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                    }`}
                  >
                    <td className="px-3 py-1 text-[#8B949E]">{ev.timeframe}</td>
                    <td className="px-3 py-1 text-[#8B949E]">{ev.objectCategory}</td>
                    <td className="px-3 py-1 text-[#E6EDF3]">{ev.objectLabel}</td>
                    <td className="px-3 py-1 text-right text-[#E6EDF3]">
                      {ev.currentPrice.toFixed(meta.pricePrecision)}
                    </td>
                    <td
                      className={`px-3 py-1 ${
                        ev.status === 'Touched' || ev.status === 'Entered Zone'
                          ? 'text-[#F59E0B]'
                          : ev.status === 'Confirmed Breakout'
                            ? 'text-[#38BDF8]'
                            : 'text-[#C9D1D9]'
                      }`}
                    >
                      {ev.status}
                      {ev.touchMethod ? ` (${ev.touchMethod})` : ''}
                    </td>
                    <td className="px-3 py-1 text-right text-[#8B949E]">{fmtTime(ev.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
