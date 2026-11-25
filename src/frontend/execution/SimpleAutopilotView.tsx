import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Filter,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sliders,
  Square,
  Wand2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  getContractSpec,
  getInstrumentMeta,
  INSTRUMENTS,
  MT5_EXECUTION_PRESETS,
} from '../../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  MT5ExecutionPreset,
  MT5ExecutionSettings,
  TradingSignal,
} from '../../shared/types/index.ts';
import { SignalConfigurationPanel } from '../panels/SignalConfigurationPanel.tsx';
import { StrategyManagerDashboard } from '../signals/StrategyManagerDashboard.tsx';
import { useTerminal } from '../state/terminal-context.tsx';

const TERMINAL_SIGNAL_STATES = new Set([
  'TP3_HIT',
  'STOPPED',
  'INVALIDATED',
  'EXPIRED',
  'CANCELLED',
]);

export function doesSettingsMatchPreset(
  settings: MT5ExecutionSettings,
  preset: MT5ExecutionPreset
): boolean {
  const p = preset.patch;
  return (
    settings.sizingMode === p.sizingMode &&
    settings.maxLotSize === p.maxLotSize &&
    settings.minSignalScore === p.minSignalScore &&
    (p.sizingMode === 'FIXED_LOT'
      ? settings.fixedLotSize === p.fixedLotSize
      : settings.riskPercentPerTrade === p.riskPercentPerTrade) &&
    settings.moveSlToBreakeven === p.moveSlToBreakeven &&
    settings.trailSlToTp1OnTp2 === p.trailSlToTp1OnTp2
  );
}

export function SimpleAutopilotView({
  onSwitchToProChart,
  onOpenSignalCenter,
  onOpenSignalFilters,
  onOpenStrategyManager,
  onOpenDiscovery,
  onOpenLiveStrategy,
  onOpenMt5Modal,
}: {
  onSwitchToProChart: (sym?: InstrumentSymbol) => void;
  onOpenSignalCenter: () => void;
  onOpenSignalFilters?: () => void;
  onOpenStrategyManager?: () => void;
  onOpenDiscovery?: () => void;
  onOpenLiveStrategy?: () => void;
  onOpenMt5Modal: (tab?: 'desk' | 'trades' | 'settings' | 'guide') => void;
}) {
  const {
    quotes,
    providers,
    signals,
    signalSettings,
    liveStrategyBasket,
    armBestStrategies,
    evaluatingSignals,
    evaluateSignals,
    mt5Status,
    mt5ExecutionSettings,
    mt5ManagedTrades,
    mt5Commands,
    updateMt5ExecutionSettings,
    executeMt5Trade,
    moveMt5TradeToBreakeven,
    trailMt5TradeToTp1,
    closeMt5Trade,
    closeAllMt5Trades,
    refreshMt5Execution,
    selectSymbol,
  } = useTerminal();

  const [symbolFilter, setSymbolFilter] = useState<'ALL' | InstrumentSymbol>('ALL');
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null);
  const [armingBest, setArmingBest] = useState(false);
  const [sendingSignalId, setSendingSignalId] = useState<string | null>(null);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const connectedFeeds = INSTRUMENTS.filter(
    (inst) => providers[inst.symbol]?.connectionStatus === 'CONNECTED'
  ).length;

  const openSignals = useMemo(() => {
    return signals.filter((s) => {
      if (!signalSettings.allowDefaultSignals && s.source !== 'strategy_basket') return false;
      if (TERMINAL_SIGNAL_STATES.has(s.state)) return false;
      if (s.state === 'WATCHING' && !mt5ExecutionSettings.allowWatchingSignals) return false;
      if (symbolFilter !== 'ALL' && s.symbol !== symbolFilter) return false;
      return true;
    });
  }, [
    signals,
    signalSettings.allowDefaultSignals,
    mt5ExecutionSettings.allowWatchingSignals,
    symbolFilter,
  ]);

  const activeManagedTrades = useMemo(
    () =>
      mt5ManagedTrades.filter(
        (t) => t.status === 'QUEUED' || t.status === 'OPEN' || t.status === 'PARTIAL'
      ),
    [mt5ManagedTrades]
  );

  const recentCommands = useMemo(() => mt5Commands.slice(0, 6), [mt5Commands]);

  const mt5Connected = Boolean(mt5Status?.connected);
  const mt5TradeMode = mt5Status?.tradeMode ?? 'UNKNOWN';
  const accountEquity = mt5Status?.equity ?? mt5Status?.balance ?? 10000;
  const totalOpenPnl = activeManagedTrades.reduce((sum, t) => sum + (t.unrealizedPnlUsd || 0), 0);

  const syncedSymbolMap = useMemo(() => {
    const out: Partial<Record<InstrumentSymbol, string>> = {};
    for (const tick of mt5Status?.syncedTicks ?? []) {
      if (tick.normalizedSymbol && !out[tick.normalizedSymbol]) {
        out[tick.normalizedSymbol] = tick.rawSymbol;
      }
    }
    return out;
  }, [mt5Status?.syncedTicks]);

  const hasAutoDetectableSymbols = useMemo(() => {
    return INSTRUMENTS.some((inst) => {
      const detected = syncedSymbolMap[inst.symbol];
      return detected && detected !== mt5ExecutionSettings.symbolMapping[inst.symbol];
    });
  }, [syncedSymbolMap, mt5ExecutionSettings.symbolMapping]);

  const estimateLot = (sig: TradingSignal): number => {
    const spec = getContractSpec(sig.symbol);
    const maxCap = Math.min(spec.maxVolume, mt5ExecutionSettings.maxLotSize);
    let raw = mt5ExecutionSettings.fixedLotSize;
    if (mt5ExecutionSettings.sizingMode === 'RISK_PERCENT') {
      const stopDist = Math.abs(sig.entryPrice - sig.stopLoss);
      const riskUsd = accountEquity * (mt5ExecutionSettings.riskPercentPerTrade / 100);
      raw = stopDist > 0 ? riskUsd / (stopDist * spec.contractSize) : spec.minVolume;
    }
    const clamped = Math.max(spec.minVolume, Math.min(maxCap, raw));
    const floored = Math.floor((clamped + 1e-12) / spec.volumeStep) * spec.volumeStep;
    return Number(Math.max(spec.minVolume, floored).toFixed(4));
  };

  const handleApplyPreset = async (preset: MT5ExecutionPreset) => {
    setApplyingPresetId(preset.id);
    setFeedback(null);
    const res = await updateMt5ExecutionSettings(preset.patch);
    setApplyingPresetId(null);
    if (res.ok) {
      setFeedback({
        type: 'success',
        text: `Applied "${preset.name}" preset and saved to MT5 Execution Settings.`,
      });
    } else {
      setFeedback({ type: 'error', text: res.error || 'Failed to apply preset.' });
    }
  };

  const handleToggleAutoPilot = async () => {
    const turningOn = !(mt5ExecutionSettings.enabled && mt5ExecutionSettings.autoExecuteSignals);
    setFeedback(null);
    const res = await updateMt5ExecutionSettings({
      enabled: turningOn,
      autoExecuteSignals: turningOn,
    });
    if (res.ok) {
      setFeedback({
        type: 'success',
        text: turningOn
          ? 'Autopilot ON: Confirmed BUY/SELL signals will now automatically execute on MT5 and trail SL.'
          : 'Autopilot paused. You can still send any signal manually with one click.',
      });
    } else {
      setFeedback({ type: 'error', text: res.error || 'Unable to update Autopilot state.' });
    }
  };

  const handleAutoMatchSymbols = async () => {
    const nextMapping = { ...mt5ExecutionSettings.symbolMapping };
    let changes = 0;
    for (const inst of INSTRUMENTS) {
      const detected = syncedSymbolMap[inst.symbol];
      if (detected && nextMapping[inst.symbol] !== detected) {
        nextMapping[inst.symbol] = detected;
        changes += 1;
      }
    }
    if (changes === 0) return;
    const res = await updateMt5ExecutionSettings({ symbolMapping: nextMapping });
    if (res.ok) {
      setFeedback({
        type: 'success',
        text: `Matched ${changes} MT5 broker symbol(s) directly from your connected terminal.`,
      });
    }
  };

  const handleQuickLotUpdate = async (lot: number) => {
    const clamped = Math.max(0.01, Math.min(mt5ExecutionSettings.maxLotSize, lot));
    const res = await updateMt5ExecutionSettings({
      sizingMode: 'FIXED_LOT',
      fixedLotSize: Number(clamped.toFixed(2)),
    });
    if (res.ok) {
      setFeedback({
        type: 'success',
        text: `Fixed Lot updated to ${clamped.toFixed(2)} (Max cap ${mt5ExecutionSettings.maxLotSize}).`,
      });
    }
  };

  const handleSendSignal = async (signalId: string) => {
    setSendingSignalId(signalId);
    setFeedback(null);
    const res = await executeMt5Trade(signalId);
    setSendingSignalId(null);
    if (res.success) {
      setFeedback({
        type: 'success',
        text: 'Order queued for MT5. Your EA will execute it within ~1 second.',
      });
    } else {
      setFeedback({ type: 'error', text: res.error || 'Signal rejected by MT5 Trade Engine.' });
    }
  };

  const handleTradeAction = async (tradeId: string, action: 'be' | 'tp1' | 'close') => {
    setBusyTradeId(tradeId);
    setFeedback(null);
    const res =
      action === 'be'
        ? await moveMt5TradeToBreakeven(tradeId)
        : action === 'tp1'
          ? await trailMt5TradeToTp1(tradeId)
          : await closeMt5Trade(tradeId);
    setBusyTradeId(null);
    if (res.success) {
      setFeedback({
        type: 'success',
        text:
          action === 'be'
            ? 'Move SL to Breakeven sent to MT5.'
            : action === 'tp1'
              ? 'Trail SL to TP1 sent to MT5.'
              : 'Close Trade sent to MT5.',
      });
    } else {
      setFeedback({ type: 'error', text: res.error || 'Command failed.' });
    }
  };

  const handleArmBestStrategies = async () => {
    setArmingBest(true);
    setFeedback(null);
    try {
      const res = await armBestStrategies({
        readinessMode: 'INCLUDE_VERIFY_PAPER',
        avoidPoorRegimes: true,
        requireHtfAlignment: true,
        autoScanIfEmpty: true,
      });
      setFeedback({
        type: res.ok ? 'success' : 'error',
        text: res.message,
      });
    } finally {
      setArmingBest(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] px-4 py-4 sm:px-6">
      <div className="mx-auto max-w-[1400px] space-y-4">
        {/* Top Row: System Readiness & 1-Click Autopilot Control */}
        <section className="border border-[#222938] bg-[#12161F] p-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1D2432] pb-3.5">
            <div>
              <h1 className="text-base font-semibold text-[#E6EDF3]">
                Simple Autopilot Desk
              </h1>
              <p className="mt-0.5 text-xs text-[#8B949E]">
                One-screen control center to pick a preset, verify MT5 connection, send signals, and manage SL/TP trades.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void evaluateSignals()}
                disabled={evaluatingSignals}
                className="flex items-center gap-1.5 border border-[#2B3548] bg-[#0B0E14] px-3 py-2 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${evaluatingSignals ? 'animate-spin' : ''}`} />
                <span>{evaluatingSignals ? 'Scanning...' : 'Scan Markets'}</span>
              </button>

              <button
                type="button"
                onClick={() => onOpenMt5Modal('settings')}
                className="flex items-center gap-1.5 border border-[#2B3548] bg-[#0B0E14] px-3 py-2 text-xs font-medium text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Sliders className="h-3.5 w-3.5" />
                <span>Advanced Rules</span>
              </button>

              <button
                type="button"
                onClick={() => void handleToggleAutoPilot()}
                className={`flex items-center gap-2 border px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                  mt5ExecutionSettings.enabled && mt5ExecutionSettings.autoExecuteSignals
                    ? 'border-[#0ECB81] bg-[#0ECB81] text-slate-950 hover:bg-[#0ECB81]/90'
                    : 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8] hover:bg-[#38BDF8]/25'
                }`}
              >
                {mt5ExecutionSettings.enabled && mt5ExecutionSettings.autoExecuteSignals ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    <span>Auto-Trade ON (Pause)</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    <span>Start Auto-Trading</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 3-Step Guided Trading Flow */}
          <div className="mt-3.5 grid grid-cols-1 gap-3 lg:grid-cols-3">
            {/* Step 1: Pick & Filter Strategies */}
            <div className="flex flex-col justify-between border border-[#1D2432] bg-[#0B0E14] px-3.5 py-3">
              <div>
                <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                  <span className="font-semibold text-[#38BDF8]">STEP 1 · PICK & FILTER STRATEGIES</span>
                  {liveStrategyBasket?.enabled && liveStrategyBasket.strategies.length > 0 ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#0ECB81]" />
                  ) : (
                    <Filter className="h-3.5 w-3.5 text-[#F59E0B]" />
                  )}
                </div>
                <div className="mt-1 font-mono text-xs font-semibold text-[#E6EDF3] tabular-nums">
                  {liveStrategyBasket?.enabled
                    ? `${liveStrategyBasket.strategies.length} Armed Across ${liveStrategyBasket.assignments?.length || 1} Slot(s)`
                    : signalSettings.allowDefaultSignals
                      ? 'Default Scanner Active'
                      : 'No Strategies Armed Yet'}
                </div>
                <div className="mt-0.5 text-[11px] text-[#8B949E]">
                  Filter winning strategies by Win%, PF, regime, or timeframe and add to Main Signals.
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[#1D2432] pt-2">
                {onOpenSignalFilters && (
                  <button
                    type="button"
                    onClick={onOpenSignalFilters}
                    className="flex items-center gap-1 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-2.5 py-1 text-[11px] font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                  >
                    <Filter className="h-3 w-3" />
                    <span>Filter & Add Strategies</span>
                  </button>
                )}
                {onOpenStrategyManager && (
                  <button
                    type="button"
                    onClick={onOpenStrategyManager}
                    className="border border-[#2B3548] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                  >
                    Strategy Manager
                  </button>
                )}
                <button
                  type="button"
                  disabled={armingBest}
                  onClick={() => void handleArmBestStrategies()}
                  className="border border-[#0ECB81]/50 bg-[#0ECB81]/10 px-2.5 py-1 text-[11px] font-medium text-[#0ECB81] hover:bg-[#0ECB81]/20 cursor-pointer disabled:opacity-50"
                >
                  {armingBest ? 'Loading...' : 'Auto-Load Best'}
                </button>
              </div>
            </div>

            {/* Step 2: Review & Scan Main Signals */}
            <div className="flex flex-col justify-between border border-[#1D2432] bg-[#0B0E14] px-3.5 py-3">
              <div>
                <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                  <span className="font-semibold text-[#38BDF8]">STEP 2 · REVIEW MAIN SIGNALS</span>
                  <span className="font-mono text-[10px] text-[#0ECB81] tabular-nums">
                    {connectedFeeds}/4 Feeds Live
                  </span>
                </div>
                <div className="mt-1 font-mono text-xs font-semibold text-[#E6EDF3] tabular-nums">
                  {openSignals.length} Ready Signal{openSignals.length === 1 ? '' : 's'}
                </div>
                <div className="mt-0.5 text-[11px] text-[#8B949E]">
                  Score ≥ {mt5ExecutionSettings.minSignalScore} ·{' '}
                  {signalSettings.allowDefaultSignals ? 'Strategy + Scanner' : 'Armed Strategies Only'}
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[#1D2432] pt-2">
                <button
                  type="button"
                  onClick={onOpenSignalCenter}
                  className="flex items-center gap-1 border border-[#2B3548] bg-[#12161F] px-2.5 py-1 text-[11px] font-semibold text-[#E6EDF3] hover:border-[#38BDF8] cursor-pointer"
                >
                  <Activity className="h-3 w-3 text-[#0ECB81]" />
                  <span>Open Main Signals</span>
                </button>
                <button
                  type="button"
                  onClick={() => void evaluateSignals()}
                  disabled={evaluatingSignals}
                  className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#8B949E] hover:border-[#38BDF8] hover:text-white cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${evaluatingSignals ? 'animate-spin' : ''}`} />
                  <span>{evaluatingSignals ? 'Scanning...' : 'Scan Now'}</span>
                </button>
              </div>
            </div>

            {/* Step 3: Execute Paper / MT5 */}
            <div className="flex flex-col justify-between border border-[#1D2432] bg-[#0B0E14] px-3.5 py-3">
              <div>
                <div className="flex items-center justify-between text-[11px] text-[#8B949E]">
                  <span className="font-semibold text-[#38BDF8]">STEP 3 · EXECUTE PAPER / MT5</span>
                  {mt5Connected ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#0ECB81]" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-[#F59E0B]" />
                  )}
                </div>
                <div
                  className={`mt-1 font-mono text-xs font-semibold tabular-nums ${
                    mt5Connected ? 'text-[#0ECB81]' : 'text-[#F59E0B]'
                  }`}
                >
                  {mt5Connected
                    ? `MT5 ${mt5TradeMode} #${mt5Status?.accountNumber ?? ''}`
                    : `MT5 ${mt5Status?.statusLabel ?? 'DISCONNECTED'}`}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                  {mt5ExecutionSettings.sizingMode === 'FIXED_LOT'
                    ? `${mt5ExecutionSettings.fixedLotSize} Lot`
                    : `${mt5ExecutionSettings.riskPercentPerTrade}% Risk`}{' '}
                  · {mt5ExecutionSettings.moveSlToBreakeven ? 'BE on TP1' : 'BE Off'} ·{' '}
                  {mt5ExecutionSettings.trailSlToTp1OnTp2 ? 'SL→TP1' : 'No Trail'}
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[#1D2432] pt-2">
                <button
                  type="button"
                  onClick={() => void handleToggleAutoPilot()}
                  className={`flex items-center gap-1 border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                    mt5ExecutionSettings.enabled && mt5ExecutionSettings.autoExecuteSignals
                      ? 'border-[#0ECB81] bg-[#0ECB81] text-slate-950'
                      : 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81] hover:bg-[#0ECB81]/25'
                  }`}
                >
                  {mt5ExecutionSettings.enabled && mt5ExecutionSettings.autoExecuteSignals ? (
                    <>
                      <Square className="h-3 w-3" />
                      <span>Autopilot ON</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" />
                      <span>Enable Autopilot</span>
                    </>
                  )}
                </button>
                {!mt5Connected && (
                  <button
                    type="button"
                    onClick={() => onOpenMt5Modal('guide')}
                    className="border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                  >
                    Setup MT5 EA
                  </button>
                )}
              </div>
            </div>
          </div>

          {mt5ExecutionSettings.demoAccountOnly && mt5TradeMode === 'REAL' && (
            <div className="mt-3 flex items-center gap-2 border border-[#F6465D] bg-[#F6465D]/15 px-3 py-2 text-xs text-[#F6465D]">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                Connected MT5 account is REAL. Demo-Only Safety Guard is blocking execution until you switch to an MT5 Demo account or turn off Demo-Only Guard in Advanced Rules.
              </span>
            </div>
          )}

          {feedback && (
            <div
              className={`mt-3 flex items-center justify-between border px-3 py-2 text-xs ${
                feedback.type === 'error'
                  ? 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  : 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
              }`}
            >
              <span>{feedback.text}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="underline text-[11px] cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}
        </section>

        {/* Strategy Manager Dashboard: Live Arming State & Performance Metrics */}
        <StrategyManagerDashboard
          variant="embedded"
          onOpenFilterStrategies={onOpenSignalFilters}
          onOpenMainSignals={onOpenSignalCenter}
          onOpenDiscovery={onOpenDiscovery}
          onOpenLiveStrategy={onOpenLiveStrategy}
          onSwitchToChart={(sym) => onSwitchToProChart(sym)}
        />

        {/* Signal Configuration Panel: Required Pre-Trigger SMC Criteria */}
        <SignalConfigurationPanel variant="inline" onOpenSignalFilters={onOpenSignalFilters} />

        {/* Step 1: 1-Click Trading Presets & Quick Lot Bar */}
        <section className="border border-[#222938] bg-[#12161F] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold text-[#E6EDF3]">
                1-Click Trading Presets
              </h2>
              <p className="text-[11px] text-[#8B949E]">
                Choose a ready-made profile below—settings save automatically with no extra steps.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasAutoDetectableSymbols && (
                <button
                  type="button"
                  onClick={() => void handleAutoMatchSymbols()}
                  className="flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/10 px-2.5 py-1 text-[11px] font-medium text-[#0ECB81] hover:bg-[#0ECB81]/20 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Wand2 className="h-3 w-3" />
                  <span>Auto-Match MT5 Symbols</span>
                </button>
              )}
              <div className="flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2 py-1 text-[11px]">
                <span className="text-[#8B949E] mr-1">Quick Lot:</span>
                {[0.01, 0.02, 0.03, 0.05].map((lot) => {
                  const active =
                    mt5ExecutionSettings.sizingMode === 'FIXED_LOT' &&
                    Math.abs(mt5ExecutionSettings.fixedLotSize - lot) < 0.001;
                  return (
                    <button
                      key={lot}
                      type="button"
                      onClick={() => void handleQuickLotUpdate(lot)}
                      className={`px-2 py-0.5 font-mono tabular-nums cursor-pointer ${
                        active
                          ? 'bg-[#38BDF8] text-slate-950 font-semibold'
                          : 'text-[#C9D1D9] hover:bg-[#1C2331]'
                      }`}
                    >
                      {lot.toFixed(2)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {MT5_EXECUTION_PRESETS.map((preset) => {
              const active = doesSettingsMatchPreset(mt5ExecutionSettings, preset);
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={applyingPresetId === preset.id}
                  onClick={() => void handleApplyPreset(preset)}
                  className={`flex flex-col justify-between border p-3.5 text-left transition-colors cursor-pointer disabled:opacity-60 ${
                    active
                      ? 'border-[#0ECB81] bg-[#0ECB81]/10'
                      : 'border-[#222938] bg-[#0B0E14] hover:border-[#38BDF8]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#E6EDF3]">{preset.name}</span>
                      <span
                        className={`font-mono text-[10px] font-semibold ${
                          active
                            ? 'text-[#0ECB81]'
                            : preset.recommended
                              ? 'text-[#38BDF8]'
                              : 'text-[#8B949E]'
                        }`}
                      >
                        {active ? 'ACTIVE' : preset.recommended ? 'RECOMMENDED' : 'SELECT'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[#8B949E]">{preset.subtitle}</p>
                  </div>
                  <div className="mt-2.5 border-t border-[#1D2432] pt-2 font-mono text-[11px] text-[#C9D1D9] tabular-nums">
                    {preset.summary}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Live 4-Instrument Price Strip & Quick Filter */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 font-mono tabular-nums">
          <button
            type="button"
            onClick={() => setSymbolFilter('ALL')}
            className={`border px-3 py-2 text-left cursor-pointer ${
              symbolFilter === 'ALL'
                ? 'border-[#38BDF8] bg-[#161B26]'
                : 'border-[#222938] bg-[#12161F] hover:border-[#2B3548]'
            }`}
          >
            <div className="text-[11px] font-sans text-[#8B949E]">Filter Instrument</div>
            <div className="mt-0.5 text-xs font-semibold text-[#E6EDF3]">All 4 Markets</div>
          </button>

          {INSTRUMENTS.map((inst) => {
            const q = quotes[inst.symbol];
            const selected = symbolFilter === inst.symbol;
            const chg = q?.changePercent24h ?? 0;
            return (
              <button
                key={inst.symbol}
                type="button"
                onClick={() => setSymbolFilter(selected ? 'ALL' : inst.symbol)}
                className={`border px-3 py-2 text-left cursor-pointer ${
                  selected
                    ? 'border-[#38BDF8] bg-[#161B26]'
                    : 'border-[#222938] bg-[#12161F] hover:border-[#2B3548]'
                }`}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-[#E6EDF3]">{inst.symbol}</span>
                  <span className={chg >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}>
                    {q ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-[#C9D1D9]">
                  {q && q.price > 0 ? q.price.toFixed(inst.pricePrecision) : '—'}
                </div>
              </button>
            );
          })}
        </div>

        {/* Main 2-Column Trading Desk: Signals (Left) + Active MT5 Trades (Right) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 items-stretch">
          {/* Left: Ready BUY / SELL Signals */}
          <section className="lg:col-span-7 flex flex-col border border-[#222938] bg-[#12161F] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2.5">
              <div>
                <h2 className="text-xs font-semibold text-[#E6EDF3]">
                  Ready BUY / SELL Signals ({openSignals.length})
                </h2>
                <p className="text-[11px] text-[#8B949E]">
                  Click Send to MT5 on any signal, or enable Auto-Trade above for hands-free execution.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenSignalCenter}
                className="flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Full Signal Center</span>
                <ArrowUpRight className="h-3 w-3" />
              </button>
            </div>

            {openSignals.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                <Bot className="h-8 w-8 text-[#4B5563]" />
                <div className="mt-2 text-xs font-medium text-[#E6EDF3]">
                  {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals
                    ? 'Strategy-Only Mode — No Best/Filtered Strategies Armed Yet'
                    : 'No open strategy signals match right now'}
                </div>
                <p className="mt-1 max-w-sm text-[11px] text-[#8B949E]">
                  {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals
                    ? 'Generic default signals are disabled for Auto-Trade accuracy. Load validated Best Strategies below or arm filtered strategies in Discovery / Live Market Strategy.'
                    : 'Armed strategies continuously check closed candles, HTF trend alignment, and live market regime compatibility before emitting BUY/SELL.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {onOpenSignalFilters && (
                    <button
                      type="button"
                      onClick={onOpenSignalFilters}
                      className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                    >
                      <Filter className="h-3.5 w-3.5" />
                      <span>Filter & Add Strategies</span>
                    </button>
                  )}
                  {!liveStrategyBasket?.enabled && !signalSettings.allowDefaultSignals && (
                    <button
                      type="button"
                      disabled={armingBest}
                      onClick={() => void handleArmBestStrategies()}
                      className="flex items-center gap-1.5 border border-[#0ECB81]/60 bg-[#0ECB81]/15 px-3 py-1.5 text-xs font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer disabled:opacity-50"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{armingBest ? 'Loading Best...' : 'Load Best Strategies'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void evaluateSignals()}
                    disabled={evaluatingSignals}
                    className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${evaluatingSignals ? 'animate-spin' : ''}`} />
                    <span>{evaluatingSignals ? 'Scanning...' : 'Scan Armed Strategies'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-2.5">
                {openSignals.map((sig) => {
                  const p = getInstrumentMeta(sig.symbol).pricePrecision;
                  const existing = mt5ManagedTrades.find(
                    (t) => t.signalId === sig.id && t.status !== 'FAILED'
                  );
                  const lot = estimateLot(sig);
                  const tp1 = sig.takeProfits[0]?.price;
                  const tp2 = sig.takeProfits[1]?.price;
                  const tp3 = sig.takeProfits[2]?.price;

                  return (
                    <div
                      key={sig.id}
                      className="flex flex-wrap items-center justify-between gap-3 border border-[#1D2432] bg-[#0B0E14] px-3.5 py-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
                          <span
                            className={`font-bold ${
                              sig.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                            }`}
                          >
                            {sig.direction}
                          </span>
                          <span className="font-semibold text-[#E6EDF3]">{sig.symbol}</span>
                          <span className="text-[#4B5563]">·</span>
                          <span className="text-[#8B949E]">{sig.entryTimeframe}</span>
                          <span className="text-[#4B5563]">·</span>
                          <span className="text-[#38BDF8]">Score {sig.score}/100</span>
                          <span className="text-[#4B5563]">·</span>
                          <span className="text-[#C9D1D9]">{lot} lot</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-[#8B949E] tabular-nums">
                          <span>
                            Entry <span className="text-[#E6EDF3]">{sig.entryPrice.toFixed(p)}</span>
                          </span>
                          <span>
                            SL <span className="text-[#F6465D]">{sig.stopLoss.toFixed(p)}</span>
                          </span>
                          {tp1 !== undefined && (
                            <span>
                              TP1 <span className="text-[#0ECB81]">{tp1.toFixed(p)}</span>
                            </span>
                          )}
                          {tp2 !== undefined && (
                            <span>
                              TP2 <span className="text-[#0ECB81]">{tp2.toFixed(p)}</span>
                            </span>
                          )}
                          {tp3 !== undefined && (
                            <span>
                              TP3 <span className="text-[#0ECB81]">{tp3.toFixed(p)}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            selectSymbol(sig.symbol);
                            onSwitchToProChart(sig.symbol);
                          }}
                          className="border border-[#222938] bg-[#12161F] px-2.5 py-1.5 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          View Chart
                        </button>

                        {existing ? (
                          <span className="font-mono text-[11px] font-semibold text-[#38BDF8]">
                            MT5 {existing.status}
                            {existing.mt5Ticket ? ` #${existing.mt5Ticket}` : ''}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={sendingSignalId === sig.id}
                            onClick={() => void handleSendSignal(sig.id)}
                            className={`flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                              sig.direction === 'BUY'
                                ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81] hover:bg-[#0ECB81]/25'
                                : 'border-[#F6465D]/60 bg-[#F6465D]/15 text-[#F6465D] hover:bg-[#F6465D]/25'
                            }`}
                          >
                            <Send className="h-3.5 w-3.5" />
                            <span>
                              {sendingSignalId === sig.id
                                ? 'Sending...'
                                : `Send ${sig.direction} to MT5`}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Right: Active MT5 Trades & Quick SL Controls */}
          <section className="lg:col-span-5 flex flex-col border border-[#222938] bg-[#12161F] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D2432] pb-2.5">
              <div>
                <h2 className="text-xs font-semibold text-[#E6EDF3]">
                  Active MT5 Trades ({activeManagedTrades.length})
                </h2>
                <div className="font-mono text-[11px] text-[#8B949E] tabular-nums">
                  {mt5Status?.balance !== undefined
                    ? `Balance $${mt5Status.balance.toFixed(2)} · Equity $${(mt5Status.equity ?? mt5Status.balance).toFixed(2)} · Open P&L ${totalOpenPnl >= 0 ? '+' : ''}$${totalOpenPnl.toFixed(2)}`
                    : 'Waiting for MT5 account sync'}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void refreshMt5Execution()}
                  className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
                  title="Refresh MT5 Trades"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                {activeManagedTrades.length > 0 && !confirmCloseAll && (
                  <button
                    type="button"
                    onClick={() => setConfirmCloseAll(true)}
                    className="border border-[#F6465D]/60 bg-[#F6465D]/10 px-2.5 py-1 text-[11px] font-semibold text-[#F6465D] hover:bg-[#F6465D]/20 cursor-pointer"
                  >
                    Close All
                  </button>
                )}
                {confirmCloseAll && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCloseAll(false);
                        void closeAllMt5Trades();
                        setFeedback({ type: 'success', text: 'Close All queued for MT5 EA.' });
                      }}
                      className="bg-[#F6465D] px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmCloseAll(false)}
                      className="border border-[#222938] px-2 py-1 text-[11px] text-[#8B949E] cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            {activeManagedTrades.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
                <div className="text-xs font-medium text-[#C9D1D9]">No active MT5 trades</div>
                <p className="mt-1 max-w-xs text-[11px] text-[#8B949E]">
                  Once you send a signal (or Auto-Trade fires), your live ticket, Breakeven, and SL → TP1 controls appear right here.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {activeManagedTrades.map((tr) => {
                  const p = getInstrumentMeta(tr.symbol).pricePrecision;
                  return (
                    <div
                      key={tr.id}
                      className="border border-[#1D2432] bg-[#0B0E14] p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between font-mono text-xs tabular-nums">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-bold ${
                              tr.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                            }`}
                          >
                            {tr.direction}
                          </span>
                          <span className="font-semibold text-[#E6EDF3]">{tr.brokerSymbol}</span>
                          <span className="text-[11px] text-[#8B949E]">
                            {tr.openVolume} lot {tr.mt5Ticket ? `· #${tr.mt5Ticket}` : `· ${tr.status}`}
                          </span>
                        </div>
                        <span
                          className={`font-semibold ${
                            tr.unrealizedPnlUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {tr.unrealizedPnlUsd >= 0 ? '+' : ''}${tr.unrealizedPnlUsd.toFixed(2)}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-[#8B949E] tabular-nums">
                        <div>
                          Entry <span className="text-[#C9D1D9]">{tr.entryPrice.toFixed(p)}</span>
                        </div>
                        <div>
                          Now <span className="text-[#E6EDF3]">{tr.currentPrice.toFixed(p)}</span>
                        </div>
                        <div>
                          SL <span className="text-[#F6465D]">{tr.currentStopLoss.toFixed(p)}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1D2432] pt-2">
                        <span className="text-[11px] text-[#8B949E] truncate max-w-[200px]">
                          {tr.lastManagementNote}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {tr.mt5Ticket && (
                            <>
                              <button
                                type="button"
                                disabled={busyTradeId === tr.id}
                                onClick={() => void handleTradeAction(tr.id, 'be')}
                                className="border border-[#0ECB81]/50 bg-[#0ECB81]/10 px-2 py-1 text-[10px] font-semibold text-[#0ECB81] hover:bg-[#0ECB81]/20 cursor-pointer disabled:opacity-50"
                              >
                                SL → BE
                              </button>
                              <button
                                type="button"
                                disabled={busyTradeId === tr.id}
                                onClick={() => void handleTradeAction(tr.id, 'tp1')}
                                className="border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2 py-1 text-[10px] font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/20 cursor-pointer disabled:opacity-50"
                              >
                                SL → TP1
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            disabled={busyTradeId === tr.id}
                            onClick={() => void handleTradeAction(tr.id, 'close')}
                            className="border border-[#F6465D]/60 bg-[#F6465D]/15 px-2 py-1 text-[10px] font-semibold text-[#F6465D] hover:bg-[#F6465D]/25 cursor-pointer disabled:opacity-50"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {recentCommands.length > 0 && (
              <div className="border-t border-[#1D2432] pt-2.5">
                <div className="mb-1.5 flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-[#8B949E]">Recent MT5 Commands</span>
                  <button
                    type="button"
                    onClick={() => onOpenMt5Modal('desk')}
                    className="text-[#38BDF8] hover:underline cursor-pointer"
                  >
                    View Queue
                  </button>
                </div>
                <div className="space-y-1 font-mono text-[10px] text-[#8B949E] tabular-nums">
                  {recentCommands.slice(0, 4).map((cmd) => (
                    <div key={cmd.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[#C9D1D9]">
                        {cmd.type} {cmd.brokerSymbol} ({cmd.volume} lot)
                      </span>
                      <span
                        className={
                          cmd.status === 'EXECUTED'
                            ? 'text-[#0ECB81]'
                            : cmd.status === 'FAILED' || cmd.status === 'EXPIRED'
                              ? 'text-[#F6465D]'
                              : 'text-[#F59E0B]'
                        }
                      >
                        {cmd.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
