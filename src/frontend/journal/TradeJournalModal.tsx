import { BookOpen, Star, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';

export function TradeJournalModal({ onClose }: { onClose: () => void }) {
  const { journalEntries, refreshJournal, timezone } = useTerminal();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [lessons, setLessons] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleSaveReflection = async (id: string) => {
    const res = await apiFetch(`/api/journal/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reflectionNotes: notes, lessonsLearned: lessons, rating }),
    });
    if (res.ok) {
      setEditingId(null);
      await refreshJournal();
    }
  };

  const handleDelete = async (id: string) => {
    const res = await apiFetch(`/api/journal/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setDeletingId(null);
      await refreshJournal();
    }
  };

  const totalTrades = journalEntries.length;
  const closedEntries = journalEntries.filter((j) => j.status === 'CLOSED' || j.status === 'CANCELLED');
  const wins = closedEntries.filter((j) => j.outcome === 'WIN' || (j.realizedPnlUsd ?? 0) > 0).length;
  const winRate = closedEntries.length > 0 ? (wins / closedEntries.length) * 100 : 0;
  const netR = journalEntries.reduce((acc, j) => acc + (j.realizedR ?? 0), 0);
  const netPnl = journalEntries.reduce((acc, j) => acc + (j.realizedPnlUsd ?? 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col border border-[#2B3548] bg-[#12161F]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222938] px-5 py-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-[#38BDF8]" />
            <h2 className="text-sm font-semibold text-[#E6EDF3]">
              Strategy Trade Journal & Reflection Log
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Trade Journal"
            className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Stats Strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-[#222938] bg-[#0B0E14] p-4 text-xs font-mono tabular-nums">
          <div className="border border-[#222938] bg-[#12161F] p-3">
            <div className="text-[#8B949E]">Logged Trades</div>
            <div className="mt-1 text-base font-semibold text-[#E6EDF3]">
              {totalTrades}{' '}
              <span className="text-xs font-normal text-[#8B949E]">
                ({closedEntries.length} closed)
              </span>
            </div>
          </div>
          <div className="border border-[#222938] bg-[#12161F] p-3">
            <div className="text-[#8B949E]">Closed Win Rate</div>
            <div className="mt-1 text-base font-semibold text-[#0ECB81]">{winRate.toFixed(1)}%</div>
          </div>
          <div className="border border-[#222938] bg-[#12161F] p-3">
            <div className="text-[#8B949E]">Realized Net R</div>
            <div className={`mt-1 text-base font-semibold ${netR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
              {netR >= 0 ? '+' : ''}{netR.toFixed(2)}R
            </div>
          </div>
          <div className="border border-[#222938] bg-[#12161F] p-3">
            <div className="text-[#8B949E]">Realized P&L ($)</div>
            <div className={`mt-1 text-base font-semibold ${netPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
              {netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Entries List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {journalEntries.length === 0 ? (
            <div className="py-16 text-center text-xs text-[#8B949E]">
              No executed strategy trades in journal yet. Execute a paper trade from the Live Market Strategy or Signal Center to begin logging.
            </div>
          ) : (
            journalEntries.map((entry) => {
              const p = getInstrumentMeta(entry.symbol).pricePrecision;
              const isWin = entry.outcome === 'WIN' || (entry.realizedPnlUsd ?? 0) > 0;
              const isEditing = editingId === entry.id;
              const outcomeBadgeClass =
                entry.outcome === 'WIN'
                  ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                  : entry.outcome === 'LOSS'
                    ? 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                    : entry.outcome === 'BREAKEVEN'
                      ? 'border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B]'
                      : 'border-[#38BDF8]/50 bg-[#38BDF8]/10 text-[#38BDF8]';

              return (
                <div key={entry.id} className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2 font-mono text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={entry.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
                        {entry.direction}
                      </span>
                      <span className="font-semibold text-[#E6EDF3]">{entry.symbol}</span>
                      <span className="text-[#8B949E]">· {entry.timeframe}</span>
                      <span className="border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-1.5 py-0.5 text-[10px] text-[#38BDF8]">
                        {entry.strategyName} ({entry.strategyVersion})
                      </span>
                      <span className={`border px-1.5 py-0.5 text-[10px] font-semibold ${outcomeBadgeClass}`}>
                        {entry.outcome} · {entry.status}
                      </span>
                      {entry.exitReason && (
                        <span className="text-[10px] text-[#8B949E]">({entry.exitReason})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`font-semibold ${
                          entry.outcome === 'OPEN'
                            ? 'text-[#38BDF8]'
                            : isWin
                              ? 'text-[#0ECB81]'
                              : entry.outcome === 'BREAKEVEN'
                                ? 'text-[#F59E0B]'
                                : 'text-[#F6465D]'
                        }`}
                      >
                        {entry.realizedR !== null
                          ? `${entry.realizedR >= 0 ? '+' : ''}${entry.realizedR.toFixed(2)}R (${(entry.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}$${(entry.realizedPnlUsd ?? 0).toFixed(2)})`
                          : 'Open'}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDeletingId(entry.id);
                        }}
                        className="text-[#8B949E] hover:text-[#F6465D] cursor-pointer"
                        title="Delete Journal Entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs tabular-nums text-[#C9D1D9]">
                    <div>
                      <span className="text-[#8B949E]">Entry:</span> {entry.entryPrice.toFixed(p)}
                    </div>
                    <div>
                      <span className="text-[#8B949E]">Exit:</span>{' '}
                      {entry.exitPrice !== null ? entry.exitPrice.toFixed(p) : '—'}
                    </div>
                    <div>
                      <span className="text-[#8B949E]">SL / TP1:</span>{' '}
                      <span className="text-[#F6465D]">{entry.stopLoss.toFixed(p)}</span> /{' '}
                      <span className="text-[#0ECB81]">{entry.takeProfit1.toFixed(p)}</span>
                    </div>
                    <div>
                      <span className="text-[#8B949E]">Vol / Fees:</span> {entry.volume} · $
                      {entry.feesUsd.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-[#8B949E]">Risk:</span> ${entry.riskAmountUsd.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-[#8B949E]">Executed:</span> {fmtTime(entry.executedAt)}
                    </div>
                    <div>
                      <span className="text-[#8B949E]">Closed:</span> {fmtTime(entry.closedAt)}
                    </div>
                  </div>

                  {deletingId === entry.id && (
                    <div className="flex items-center gap-3 border border-[#F6465D]/40 bg-[#F6465D]/10 p-2 text-xs">
                      <span className="text-[#F6465D]">Delete this journal record?</span>
                      <button
                        type="button"
                        onClick={() => void handleDelete(entry.id)}
                        className="bg-[#F6465D] text-white px-3 py-1 font-semibold cursor-pointer"
                      >
                        Confirm Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingId(null)}
                        className="text-[#8B949E] hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Reflection & Notes Section */}
                  <div className="border-t border-[#1D2432] pt-2 text-xs space-y-2">
                    {isEditing ? (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[11px] text-[#8B949E]">Post-Trade Reflection Notes</label>
                          <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="What went well? Did price respect structural S/R?"
                            className="mt-1 w-full border border-[#2B3548] bg-[#12161F] p-2 text-xs text-[#E6EDF3] outline-none"
                            rows={2}
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-[#8B949E]">Lessons Learned</label>
                          <input
                            type="text"
                            value={lessons}
                            onChange={(e) => setLessons(e.target.value)}
                            placeholder="Key takeaway for future executions..."
                            className="mt-1 w-full border border-[#2B3548] bg-[#12161F] p-2 text-xs text-[#E6EDF3] outline-none"
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span className="text-[11px] text-[#8B949E] mr-2">Rating (1-5):</span>
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                key={star}
                                type="button"
                                onClick={() => setRating(star)}
                                className={`cursor-pointer ${
                                  (rating ?? entry.rating ?? 0) >= star ? 'text-[#F59E0B]' : 'text-[#4B5563]'
                                }`}
                              >
                                <Star className="h-3.5 w-3.5 fill-current" />
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveReflection(entry.id)}
                              className="bg-[#38BDF8] text-slate-950 px-3 py-1 font-semibold cursor-pointer"
                            >
                              Save Reflection
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="text-[#8B949E] hover:text-white cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-[#C9D1D9]">
                            <span className="text-[#8B949E]">Reflection:</span> {entry.reflectionNotes || 'No reflection recorded yet.'}
                          </div>
                          {entry.lessonsLearned && (
                            <div className="text-[#38BDF8]">
                              <span className="text-[#8B949E]">Takeaway:</span> {entry.lessonsLearned}
                            </div>
                          )}
                          {entry.rating !== null && entry.rating !== undefined && (
                            <div className="flex items-center gap-1 text-[#F59E0B]">
                              <span>Rating:</span>
                              {Array.from({ length: entry.rating }).map((_, i) => (
                                <Star key={i} className="h-3 w-3 fill-current" />
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(entry.id);
                            setNotes(entry.reflectionNotes);
                            setLessons(entry.lessonsLearned);
                            setRating(entry.rating);
                          }}
                          className="text-xs text-[#38BDF8] hover:underline whitespace-nowrap cursor-pointer"
                        >
                          {entry.reflectionNotes ? 'Edit Reflection' : 'Add Reflection'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
