import { Ban, CheckCircle2, Crosshair, ExternalLink, Send, Trash2, XCircle, Zap } from 'lucide-react';
import { useState } from 'react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type { TradingSignal } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

interface SignalCardProps {
  signal: TradingSignal;
  timezone: string;
  onFocusOnChart: (sig: TradingSignal) => void;
  onCancel?: (signalId: string) => void;
  onDelete?: (signalId: string) => void;
}

const TERMINAL_STATES = new Set(['TP3_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'CANCELLED']);

export function SignalCard({
  signal,
  timezone,
  onFocusOnChart,
  onCancel,
  onDelete,
}: SignalCardProps) {
  const { executePaperTrade, paperPositions, executeMt5Trade, mt5ManagedTrades } = useTerminal();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executingMt5, setExecutingMt5] = useState(false);
  const [execFeedback, setExecFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const meta = getInstrumentMeta(signal.symbol);
  const p = meta.pricePrecision;
  const isBuy = signal.direction === 'BUY';
  const isOpen = !TERMINAL_STATES.has(signal.state);
  const paperPos = paperPositions.find((pos) => pos.signalId === signal.id) ?? null;
  const mt5Trade =
    mt5ManagedTrades.find((t) => t.signalId === signal.id && t.status !== 'FAILED') ?? null;

  const handleExecutePaper = async () => {
    setExecuting(true);
    setExecFeedback(null);
    const res = await executePaperTrade(signal.id);
    setExecuting(false);
    if (res.success) {
      setExecFeedback({ type: 'success', text: 'Paper trade executed & journaled!' });
    } else {
      setExecFeedback({ type: 'error', text: `Rejected: ${res.error}` });
    }
  };

  const handleExecuteMt5 = async () => {
    setExecutingMt5(true);
    setExecFeedback(null);
    const res = await executeMt5Trade(signal.id);
    setExecutingMt5(false);
    if (res.success) {
      setExecFeedback({
        type: 'success',
        text: `MT5 ${signal.direction} command queued for ${signal.symbol}. Open MT5 Auto Trade menu to track live fill & SL/TP management.`,
      });
    } else {
      setExecFeedback({ type: 'error', text: `MT5 Rejected: ${res.error}` });
    }
  };

  const fmtTime = (ms: number | null) => {
    if (!ms) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  };

  const dirColor = isBuy ? 'text-[#0ECB81]' : 'text-[#F6465D]';
  const stateColor =
    signal.state === 'TP1_HIT' || signal.state === 'TP2_HIT' || signal.state === 'TP3_HIT'
      ? 'text-[#0ECB81]'
      : signal.state === 'STOPPED' || signal.state === 'INVALIDATED'
        ? 'text-[#F6465D]'
        : signal.state === 'WATCHING'
          ? 'text-[#F59E0B]'
          : signal.state === 'ACTIVE' || signal.state === 'CONFIRMED' || signal.state === 'PARTIAL'
            ? 'text-[#38BDF8]'
            : 'text-[#8B949E]';

  const scoreCategories = [
    { label: 'HTF Bias', cat: signal.scoreBreakdown.htfAlignment },
    { label: 'Liquidity Sweep', cat: signal.scoreBreakdown.liquiditySweep },
    { label: 'Structure (MSS/CHoCH/BOS)', cat: signal.scoreBreakdown.structureConfirmation },
    { label: 'OB / FVG / SD', cat: signal.scoreBreakdown.obFvgConfluence },
    { label: 'Premium / Discount', cat: signal.scoreBreakdown.premiumDiscount },
    { label: 'Volume & Momentum', cat: signal.scoreBreakdown.volumeMomentum },
    { label: 'R:R Quality', cat: signal.scoreBreakdown.riskRewardQuality },
  ];

  return (
    <article className="border border-[#222938] bg-[#0B0E14] p-4">
      {/* Primary Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1D2432] pb-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-sm font-semibold tabular-nums">
            <span className={dirColor}>{signal.direction}</span>
            <span className="text-[#E6EDF3]">{signal.symbol}</span>
            <span aria-hidden="true" className="text-[#4B5563]">·</span>
            <span className="text-xs font-medium text-[#C9D1D9]">{signal.entryTimeframe}</span>
            <span aria-hidden="true" className="text-[#4B5563]">·</span>
            <span className={`text-xs font-semibold ${stateColor}`}>{signal.state}</span>
            {paperPos && (
              <span
                className={`border px-1.5 py-0.5 text-[10px] font-semibold ${
                  paperPos.status === 'CLOSED' || paperPos.status === 'CANCELLED'
                    ? paperPos.realizedPnlUsd >= 0
                      ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                      : 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                    : 'border-[#38BDF8]/50 bg-[#38BDF8]/10 text-[#38BDF8]'
                }`}
              >
                {paperPos.status === 'CLOSED' || paperPos.status === 'CANCELLED'
                  ? `Paper Closed (${paperPos.realizedR >= 0 ? '+' : ''}${paperPos.realizedR.toFixed(2)}R)`
                  : `Paper ${paperPos.status} (${paperPos.unrealizedPnlUsd >= 0 ? '+' : ''}$${paperPos.unrealizedPnlUsd.toFixed(2)})`}
              </span>
            )}
            {mt5Trade && (
              <span
                className={`border px-1.5 py-0.5 text-[10px] font-semibold ${
                  mt5Trade.status === 'CLOSED'
                    ? 'border-[#8B949E]/50 bg-[#161B26] text-[#C9D1D9]'
                    : mt5Trade.status === 'QUEUED'
                      ? 'border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B]'
                      : 'border-[#38BDF8]/50 bg-[#38BDF8]/10 text-[#38BDF8]'
                }`}
              >
                MT5 {mt5Trade.status}
                {mt5Trade.mt5Ticket ? ` #${mt5Trade.mt5Ticket}` : ''}
                {mt5Trade.breakevenDone ? ' · BE' : ''}
                {mt5Trade.slAtTp1Done ? ' · SL@TP1' : ''}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#8B949E] font-mono tabular-nums">
            <span>
              Quality {signal.score}/100 ({signal.classification})
            </span>
            <span aria-hidden="true">·</span>
            <span>{signal.provisional ? 'Provisional Intrabar' : 'Closed-Candle Confirmed'}</span>
            {signal.source === 'strategy_basket' && signal.strategyName && (
              <>
                <span aria-hidden="true">·</span>
                <span className="border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-1.5 py-0.5 text-[10px] text-[#38BDF8]">
                  Basket: {signal.strategyName}
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>Created {fmtTime(signal.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isOpen && !mt5Trade && (
            <button
              type="button"
              onClick={() => void handleExecuteMt5()}
              disabled={executingMt5}
              title="Send this signal order directly to MetaTrader 5 Demo Account"
              className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-2.5 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{executingMt5 ? 'Sending...' : 'Send to MT5'}</span>
            </button>
          )}
          {isOpen && !paperPos && (
            <button
              type="button"
              onClick={() => void handleExecutePaper()}
              disabled={executing}
              className="flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-2.5 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Zap className="h-3.5 w-3.5" />
              <span>{executing ? 'Executing...' : 'Execute Paper'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onFocusOnChart(signal)}
            className="flex items-center gap-1.5 border border-[#2B3548] bg-[#161B26] px-2.5 py-1.5 text-xs font-medium text-[#38BDF8] hover:border-[#38BDF8] hover:bg-[#1C2331] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Crosshair className="h-3.5 w-3.5" />
            <span>Chart</span>
            <ExternalLink className="h-3 w-3" />
          </button>
          {isOpen && onCancel && (
            <button
              type="button"
              onClick={() => onCancel(signal.id)}
              title="Cancel active signal tracking"
              className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1.5 text-xs text-[#8B949E] hover:border-[#F59E0B]/60 hover:text-[#F59E0B] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Ban className="h-3.5 w-3.5" />
              <span>Cancel</span>
            </button>
          )}
          {onDelete && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              title="Delete signal entry from SQLite database"
              className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1.5 text-xs text-[#8B949E] hover:border-[#F6465D]/60 hover:text-[#F6465D] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </button>
          )}
          {onDelete && confirmDelete && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(signal.id);
                }}
                className="border border-[#F6465D] bg-[#F6465D]/15 px-2.5 py-1.5 text-xs font-semibold text-[#F6465D] hover:bg-[#F6465D]/25 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Confirm Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="border border-[#222938] bg-[#12161F] px-2 py-1.5 text-xs text-[#8B949E] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
              >
                Keep
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Trade Plan & HTF Bias Grid */}
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Column 1: Entry, SL, Invalidation */}
        <div className="space-y-1.5 font-mono text-xs tabular-nums">
          <div className="text-[11px] font-sans font-semibold text-[#8B949E]">Execution Plan</div>
          <div className="flex justify-between border-b border-[#1D2432] py-1">
            <span className="text-[#8B949E]">Entry Price</span>
            <span className="font-semibold text-[#E6EDF3]">{signal.entryPrice.toFixed(p)}</span>
          </div>
          <div className="flex justify-between border-b border-[#1D2432] py-1">
            <span className="text-[#8B949E]">Entry Zone</span>
            <span className="text-[#C9D1D9]">
              {signal.entryZone.lower.toFixed(p)} – {signal.entryZone.upper.toFixed(p)}
            </span>
          </div>
          <div className="flex justify-between border-b border-[#1D2432] py-1">
            <span className="text-[#8B949E]">Stop Loss</span>
            <span className="font-semibold text-[#F6465D]">{signal.stopLoss.toFixed(p)}</span>
          </div>
          <div className="flex justify-between border-b border-[#1D2432] py-1">
            <span className="text-[#8B949E]">Invalidation</span>
            <span className="text-[#C9D1D9]">{signal.invalidationLevel.toFixed(p)}</span>
          </div>
          <div className="flex justify-between py-1">
            <span className="text-[#8B949E]">ATR Buffer</span>
            <span className="text-[#8B949E]">{signal.atrBuffer.toFixed(p)}</span>
          </div>
        </div>

        {/* Column 2: Targets & Risk/Reward */}
        <div className="space-y-1.5 font-mono text-xs tabular-nums">
          <div className="text-[11px] font-sans font-semibold text-[#8B949E]">
            Targets & Risk/Reward
          </div>
          {signal.takeProfits.map((tp) => (
            <div key={tp.level} className="flex items-center justify-between border-b border-[#1D2432] py-1 gap-2">
              <div className="min-w-0">
                <span className={tp.hit ? 'font-semibold text-[#38BDF8]' : 'font-semibold text-[#0ECB81]'}>
                  TP{tp.level} {tp.hit ? '(HIT)' : ''}
                </span>
                <span className="ml-2 truncate text-[11px] text-[#8B949E]">{tp.sourceLabel}</span>
              </div>
              <div className="shrink-0 text-right">
                <span className="text-[#E6EDF3]">{tp.price.toFixed(p)}</span>
                <span className="ml-2 text-[#8B949E]">1:{tp.riskReward.toFixed(2)}</span>
              </div>
            </div>
          ))}
          <div className="flex justify-between py-1">
            <span className="text-[#8B949E]">Max Excursion</span>
            <span className="text-[#C9D1D9]">
              +{signal.highestFavorableR.toFixed(2)}R / -{signal.maxAdverseR.toFixed(2)}R
              {signal.realizedR !== null ? ` · Realized ${signal.realizedR > 0 ? '+' : ''}${signal.realizedR}R` : ''}
            </span>
          </div>
        </div>

        {/* Column 3: Score Breakdown & Multi-Timeframe Bias */}
        <div className="space-y-1.5 text-xs">
          <div className="text-[11px] font-semibold text-[#8B949E]">
            Quality Breakdown ({signal.score}/100)
          </div>
          <div className="space-y-1 font-mono text-[11px] tabular-nums">
            {scoreCategories.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[#C9D1D9] truncate">
                  {item.cat.met ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-[#0ECB81]" />
                  ) : (
                    <XCircle className="h-3 w-3 shrink-0 text-[#4B5563]" />
                  )}
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="text-[#E6EDF3] shrink-0">
                  {item.cat.score}/{item.cat.maxScore}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HTF Bias, Signal Issuance Rationale & Failure/Outcome Analysis */}
      <div className="mt-3 space-y-2.5 border-t border-[#1D2432] pt-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[#8B949E] tabular-nums">
          <span className="font-sans font-semibold text-[#C9D1D9]">Timeframe Bias:</span>
          <span>1D {signal.htfBias.d1}</span>
          <span>4H {signal.htfBias.h4}</span>
          <span>1H {signal.htfBias.h1}</span>
          <span>15m {signal.htfBias.m15}</span>
          <span>5m {signal.htfBias.m5}</span>
          {signal.htfBias.m1 && <span>1m {signal.htfBias.m1}</span>}
        </div>

        {(signal.generationSummary || signal.confluenceReasons.length > 0) && (
          <div className="border border-[#1D2432] bg-[#12161F] p-2.5">
            <div className="text-[11px] font-semibold text-[#38BDF8]">
              Why Signal Was Issued
            </div>
            {signal.generationSummary && (
              <p className="mt-1 text-[11px] text-[#E6EDF3]">{signal.generationSummary}</p>
            )}
            {signal.confluenceReasons.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-[#C9D1D9]">
                {signal.confluenceReasons.map((reason, idx) => (
                  <li key={idx}>• {reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(signal.outcomeSummary ||
          (signal.failureReasons && signal.failureReasons.length > 0) ||
          TERMINAL_STATES.has(signal.state)) && (
          <div
            className={`border p-2.5 ${
              signal.state === 'TP3_HIT'
                ? 'border-[#0ECB81]/40 bg-[#0ECB81]/5'
                : signal.state === 'STOPPED' || signal.state === 'INVALIDATED'
                  ? 'border-[#F6465D]/40 bg-[#F6465D]/5'
                  : 'border-[#F59E0B]/40 bg-[#F59E0B]/5'
            }`}
          >
            <div
              className={`text-[11px] font-semibold ${
                signal.state === 'TP3_HIT'
                  ? 'text-[#0ECB81]'
                  : signal.state === 'STOPPED' || signal.state === 'INVALIDATED'
                    ? 'text-[#F6465D]'
                    : 'text-[#F59E0B]'
              }`}
            >
              {signal.state === 'TP3_HIT'
                ? 'Trade Outcome Summary'
                : signal.state === 'STOPPED' || signal.state === 'INVALIDATED'
                  ? `Why Signal Failed (${signal.state})`
                  : `Outcome & Close Reason (${signal.state})`}
            </div>
            {signal.outcomeSummary && (
              <p className="mt-1 text-[11px] font-medium text-[#E6EDF3]">
                {signal.outcomeSummary}
              </p>
            )}
            {signal.failureReasons && signal.failureReasons.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-[#C9D1D9]">
                {signal.failureReasons.map((reason, idx) => (
                  <li key={idx}>• {reason}</li>
                ))}
              </ul>
            ) : (
              signal.timeline.length > 0 && (
                <p className="mt-1 text-[11px] text-[#C9D1D9]">
                  • {signal.timeline[signal.timeline.length - 1].note}
                </p>
              )
            )}
          </div>
        )}

        {execFeedback && (
          <div
            className={`border p-2 text-xs ${
              execFeedback.type === 'error'
                ? 'border-[#F6465D]/40 bg-[#F6465D]/10 text-[#F6465D]'
                : 'border-[#0ECB81]/40 bg-[#0ECB81]/10 text-[#0ECB81]'
            }`}
          >
            {execFeedback.text}
          </div>
        )}

        {signal.timeline.length > 0 && (
          <div className="border-t border-[#1D2432] pt-2">
            <div className="mb-1 text-[10px] font-semibold text-[#8B949E]">
              Lifecycle Timeline
            </div>
            <div className="space-y-0.5 font-mono text-[10px] text-[#8B949E] tabular-nums">
              {signal.timeline.map((ev, idx) => (
                <div key={`${ev.state}-${ev.timestamp}-${idx}`} className="flex items-start justify-between gap-3">
                  <span className="text-[#C9D1D9]">
                    [{ev.state}] {ev.note}
                  </span>
                  <span className="shrink-0 text-[#6E7681]">
                    {ev.price.toFixed(p)} · {fmtTime(ev.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
