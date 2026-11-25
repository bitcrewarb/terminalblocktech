import { RefreshCw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { InstrumentSymbol } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

export function MtfMatrixModal({ onClose }: { onClose: () => void }) {
  const { symbol, timeframe, mtfSummary, loadingMtf, refreshMtf, selectTimeframe } = useTerminal();

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col border border-[#2B3548] bg-[#12161F]">
        <div className="flex items-center justify-between border-b border-[#222938] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#E6EDF3]">
              Multi-Timeframe Structure Matrix — {symbol}
            </h2>
            <p className="text-xs text-[#8B949E]">
              Independent deterministic calculation per timeframe · Click any row to switch chart
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshMtf()}
              disabled={loadingMtf}
              className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#C9D1D9] hover:text-white cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingMtf ? 'animate-spin' : ''}`} />
              Recalculate
            </button>
            <button
              type="button"
              onClick={onClose}
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {mtfSummary && (
          <div className="grid grid-cols-1 gap-3 border-b border-[#222938] bg-[#0B0E14] px-4 py-3 text-xs sm:grid-cols-4">
            <div>
              <div className="text-[#8B949E]">Higher Timeframe Bias</div>
              <div
                className={`mt-0.5 font-mono font-semibold ${
                  mtfSummary.htfBias === 'bullish'
                    ? 'text-[#0ECB81]'
                    : mtfSummary.htfBias === 'bearish'
                      ? 'text-[#F6465D]'
                      : 'text-[#F59E0B]'
                }`}
              >
                {mtfSummary.htfBias.toUpperCase()}
              </div>
            </div>
            <div>
              <div className="text-[#8B949E]">Lower Timeframe Bias</div>
              <div
                className={`mt-0.5 font-mono font-semibold ${
                  mtfSummary.ltfBias === 'bullish'
                    ? 'text-[#0ECB81]'
                    : mtfSummary.ltfBias === 'bearish'
                      ? 'text-[#F6465D]'
                      : 'text-[#F59E0B]'
                }`}
              >
                {mtfSummary.ltfBias.toUpperCase()}
              </div>
            </div>
            <div>
              <div className="text-[#8B949E]">Alignment State</div>
              <div className="mt-0.5 font-mono font-semibold text-[#38BDF8]">
                {mtfSummary.overallAlignment}
              </div>
            </div>
            <div>
              <div className="text-[#8B949E]">Reversal Condition</div>
              <div className="mt-0.5 text-[#C9D1D9]">
                {mtfSummary.potentialReversalCondition ?? 'None active'}
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left font-mono text-xs tabular-nums">
            <thead className="sticky top-0 bg-[#161B26] text-[11px] text-[#8B949E]">
              <tr>
                <th className="px-4 py-2 font-medium">Timeframe</th>
                <th className="px-4 py-2 font-medium">Trend</th>
                <th className="px-4 py-2 font-medium">Structure</th>
                <th className="px-4 py-2 font-medium">Momentum</th>
                <th className="px-4 py-2 font-medium">Liquidity</th>
                <th className="px-4 py-2 font-medium">Nearest Important Zone</th>
                <th className="px-4 py-2 font-medium">Alignment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1D2432]">
              {mtfSummary?.rows.map((r) => (
                <tr
                  key={r.timeframe}
                  onClick={() => {
                    selectTimeframe(r.timeframe);
                    onClose();
                  }}
                  className={`cursor-pointer transition-colors ${
                    timeframe === r.timeframe ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
                  }`}
                >
                  <td className="px-4 py-2 font-semibold text-[#E6EDF3]">{r.timeframe}</td>
                  <td
                    className={`px-4 py-2 font-medium ${
                      !r.available
                        ? 'text-[#6E7681]'
                        : r.trend === 'bullish'
                          ? 'text-[#0ECB81]'
                          : r.trend === 'bearish'
                            ? 'text-[#F6465D]'
                            : 'text-[#F59E0B]'
                    }`}
                  >
                    {r.available ? r.trend.toUpperCase() : 'UNLOADED'}
                  </td>
                  <td className="px-4 py-2 text-[#C9D1D9]">
                    {r.available ? `${r.lastSequence} · ${r.bosCount} BOS / ${r.chochCount} CHoCH` : 'Click to load'}
                  </td>
                  <td className="px-4 py-2 text-[#C9D1D9]">{r.momentum.replace('_', ' ')}</td>
                  <td className="px-4 py-2 text-[#FACC15]">{r.liquidityTarget}</td>
                  <td className="px-4 py-2 text-[#E6EDF3]">{r.nearestImportantZone}</td>
                  <td
                    className={`px-4 py-2 ${
                      r.alignment === 'bullish_aligned'
                        ? 'text-[#0ECB81]'
                        : r.alignment === 'bearish_aligned'
                          ? 'text-[#F6465D]'
                          : r.alignment === 'conflicting'
                            ? 'text-[#F59E0B]'
                            : 'text-[#8B949E]'
                    }`}
                  >
                    {r.alignment.replace('_', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
