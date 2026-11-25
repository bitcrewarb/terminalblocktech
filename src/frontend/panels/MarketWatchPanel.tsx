import { ArrowDownRight, ArrowUpRight, FlaskConical, Radio, Table2 } from 'lucide-react';
import { INSTRUMENTS } from '../../shared/constants/index.ts';
import type { SignalLifecycleState } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

const OPEN_SIGNAL_STATES = new Set<SignalLifecycleState>([
  'WATCHING',
  'CONFIRMED',
  'ACTIVE',
  'PARTIAL',
  'TP1_HIT',
  'TP2_HIT',
]);

export function MarketWatchPanel({
  onOpenMtfModal,
  onOpenSignalCenter,
  onOpenBacktest,
}: {
  onOpenMtfModal: () => void;
  onOpenSignalCenter?: () => void;
  onOpenBacktest?: () => void;
}) {
  const {
    symbol,
    quotes,
    providers,
    timezone,
    selectSymbol,
    snapshot,
    signals,
    signalDiagnostics,
  } = useTerminal();

  const fmtTime = (ms: number | null | undefined) => {
    if (!ms) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-[#222938] bg-[#12161F]">
      <div className="flex items-center justify-between border-b border-[#222938] px-3 py-2">
        <span className="text-xs font-semibold text-[#E6EDF3]">Market Watch</span>
        <span className="font-mono text-[11px] text-[#8B949E]">4 Feeds</span>
      </div>

      <div className="divide-y divide-[#222938]">
        {INSTRUMENTS.map((inst) => {
          const q = quotes[inst.symbol];
          const prov = providers[inst.symbol];
          const selected = symbol === inst.symbol;
          const pct = q?.changePercent24h ?? 0;
          const chg = q?.change24h ?? 0;
          const isUp = pct >= 0;
          const conn = q?.connectionStatus ?? prov?.connectionStatus ?? 'CONNECTING';
          const openSig = signals.find(
            (s) => s.symbol === inst.symbol && OPEN_SIGNAL_STATES.has(s.state)
          );
          const diag = signalDiagnostics.find((d) => d.symbol === inst.symbol);

          return (
            <button
              key={inst.symbol}
              type="button"
              onClick={() => selectSymbol(inst.symbol)}
              className={`w-full px-3 py-2.5 text-left transition-colors cursor-pointer ${
                selected ? 'bg-[#1C2331]' : 'hover:bg-[#161B26]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-[#E6EDF3]">
                      {inst.symbol}
                    </span>
                    <span className="text-[10px] text-[#8B949E]">{inst.assetClass}</span>
                  </div>
                  <div className="truncate text-[11px] text-[#8B949E]">{inst.name}</div>
                </div>

                <div className="text-right font-mono tabular-nums">
                  <div className="text-xs font-semibold text-[#E6EDF3]">
                    {q && q.price > 0 ? q.price.toFixed(inst.pricePrecision) : '—'}
                  </div>
                  <div
                    className={`flex items-center justify-end gap-0.5 text-[11px] ${
                      isUp ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {isUp ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" />
                    )}
                    <span>
                      {isUp ? '+' : ''}
                      {pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-[#8B949E] tabular-nums">
                <span>
                  {chg !== 0 ? `${chg >= 0 ? '+' : ''}${chg.toFixed(inst.pricePrecision)}` : 'Spot BBO'}
                </span>
                <span>{q?.marketOpen === false || conn === 'MARKET_CLOSED' ? 'CLOSED' : 'OPEN'}</span>
              </div>

              <div className="mt-1 flex items-center justify-between text-[10px] text-[#8B949E]">
                <span className="truncate max-w-[130px]">
                  {prov?.providerName ?? 'Connecting'}
                </span>
                <span
                  className={`font-mono ${
                    conn === 'CONNECTED'
                      ? 'text-[#0ECB81]'
                      : conn === 'CREDENTIALS_REQUIRED' || conn === 'MARKET_CLOSED'
                        ? 'text-[#F59E0B]'
                        : 'text-[#F6465D]'
                  }`}
                >
                  {conn === 'CREDENTIALS_REQUIRED' ? 'API KEY REQ' : conn}
                </span>
              </div>

              <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] text-[#6E7681] tabular-nums">
                <span>Upd {fmtTime(q?.lastUpdateTime ?? prov?.lastUpdateTime)}</span>
                {q?.bid !== undefined && q?.ask !== undefined && (
                  <span>
                    {q.bid.toFixed(inst.pricePrecision)} / {q.ask.toFixed(inst.pricePrecision)}
                  </span>
                )}
              </div>

              <div className="mt-1 flex items-center justify-between border-t border-[#1D2432]/70 pt-1 font-mono text-[10px] tabular-nums">
                <span className="text-[#6E7681]">Signal</span>
                {openSig ? (
                  <span
                    className={
                      openSig.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }
                  >
                    {openSig.direction} {openSig.score} · {openSig.state}
                  </span>
                ) : diag ? (
                  <span className="text-[#8B949E]">
                    NO TRADE · B{diag.buyScore}/S{diag.sellScore}
                  </span>
                ) : (
                  <span className="text-[#6E7681]">Scanning…</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Active Session Anchors & Matrix/Signal Shortcuts */}
      <div className="mt-auto border-t border-[#222938] p-3 space-y-2.5">
        {snapshot && (
          <div className="space-y-1.5 text-[11px]">
            <div className="font-semibold text-[#C9D1D9]">Session & HTF Anchors</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums">
              <span className="text-[#8B949E]">Daily Open</span>
              <span className="text-right text-[#E6EDF3]">
                {snapshot.sessionAnchors.dailyOpen?.toFixed(2) ?? '—'}
              </span>
              <span className="text-[#8B949E]">PDH / PDL</span>
              <span className="text-right text-[#E6EDF3]">
                {snapshot.sessionAnchors.prevDayHigh?.toFixed(2) ?? '—'} /{' '}
                {snapshot.sessionAnchors.prevDayLow?.toFixed(2) ?? '—'}
              </span>
              <span className="text-[#8B949E]">Weekly Open</span>
              <span className="text-right text-[#E6EDF3]">
                {snapshot.sessionAnchors.weeklyOpen?.toFixed(2) ?? '—'}
              </span>
              <span className="text-[#8B949E]">PWH / PWL</span>
              <span className="text-right text-[#E6EDF3]">
                {snapshot.sessionAnchors.prevWeekHigh?.toFixed(2) ?? '—'} /{' '}
                {snapshot.sessionAnchors.prevWeekLow?.toFixed(2) ?? '—'}
              </span>
            </div>
          </div>
        )}

        {onOpenSignalCenter && (
          <button
            type="button"
            onClick={onOpenSignalCenter}
            className="flex w-full items-center justify-center gap-2 border border-[#2B3548] bg-[#161B26] px-3 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#0ECB81] hover:bg-[#1C2331] cursor-pointer"
          >
            <Radio className="h-3.5 w-3.5 text-[#0ECB81]" />
            <span>BUY/SELL Signal Center</span>
          </button>
        )}

        {onOpenBacktest && (
          <button
            type="button"
            onClick={onOpenBacktest}
            className="flex w-full items-center justify-center gap-2 border border-[#2B3548] bg-[#161B26] px-3 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8] hover:bg-[#1C2331] cursor-pointer"
          >
            <FlaskConical className="h-3.5 w-3.5 text-[#38BDF8]" />
            <span>Strategy Backtest Lab</span>
          </button>
        )}

        <button
          type="button"
          onClick={onOpenMtfModal}
          className="flex w-full items-center justify-center gap-2 border border-[#2B3548] bg-[#161B26] px-3 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8] hover:bg-[#1C2331] cursor-pointer"
        >
          <Table2 className="h-3.5 w-3.5 text-[#38BDF8]" />
          <span>Multi-Timeframe Matrix</span>
        </button>
      </div>
    </aside>
  );
}
