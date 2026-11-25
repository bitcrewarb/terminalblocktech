import {
  Activity,
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  Copy,
  Download,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sliders,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_MT5_EXECUTION_SETTINGS,
  getContractSpec,
  getInstrumentMeta,
  INSTRUMENTS,
  MT5_EXECUTION_PRESETS,
} from '../../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  MT5BreakevenTrigger,
  MT5ExecutionPreset,
  MT5ExecutionSettings,
  MT5SizingMode,
  MT5TrailingMode,
  TradingSignal,
} from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';
import { doesSettingsMatchPreset } from './SimpleAutopilotView.tsx';

const TERMINAL_SIGNAL_STATES = new Set([
  'TP3_HIT',
  'STOPPED',
  'INVALIDATED',
  'EXPIRED',
  'CANCELLED',
]);

export function MT5ExecutionModal({
  initialTab = 'desk',
  onClose,
}: {
  initialTab?: 'desk' | 'trades' | 'settings' | 'guide';
  onClose: () => void;
}) {
  const {
    signals,
    signalSettings,
    quotes,
    timezone,
    mt5Status,
    mt5ExecutionSettings,
    mt5ManagedTrades,
    mt5Commands,
    refreshMt5Status,
    refreshMt5Execution,
    updateMt5ExecutionSettings,
    executeMt5Trade,
    moveMt5TradeToBreakeven,
    trailMt5TradeToTp1,
    closeMt5Trade,
    closeAllMt5Trades,
    cancelMt5Command,
  } = useTerminal();

  const [tab, setTab] = useState<'desk' | 'trades' | 'settings' | 'guide'>(initialTab);
  const [draft, setDraft] = useState<MT5ExecutionSettings>(() =>
    structuredClone(mt5ExecutionSettings)
  );
  const [saving, setSaving] = useState(false);
  const [sendingSignalId, setSendingSignalId] = useState<string | null>(null);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [downloadingEa, setDownloadingEa] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    void refreshMt5Status();
    void refreshMt5Execution();
    const timer = setInterval(() => {
      void refreshMt5Status();
      void refreshMt5Execution();
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshMt5Status, refreshMt5Execution]);

  useEffect(() => {
    setDraft(structuredClone(mt5ExecutionSettings));
  }, [mt5ExecutionSettings]);

  const activeManagedTrades = useMemo(
    () =>
      mt5ManagedTrades.filter(
        (t) => t.status === 'QUEUED' || t.status === 'OPEN' || t.status === 'PARTIAL'
      ),
    [mt5ManagedTrades]
  );

  const closedManagedTrades = useMemo(
    () => mt5ManagedTrades.filter((t) => t.status === 'CLOSED' || t.status === 'FAILED'),
    [mt5ManagedTrades]
  );

  const executableSignals = useMemo(() => {
    return signals.filter((s) => {
      if (!signalSettings.allowDefaultSignals && s.source !== 'strategy_basket') return false;
      if (TERMINAL_SIGNAL_STATES.has(s.state)) return false;
      if (s.state === 'WATCHING' && !mt5ExecutionSettings.allowWatchingSignals) return false;
      return true;
    });
  }, [signals, signalSettings.allowDefaultSignals, mt5ExecutionSettings.allowWatchingSignals]);

  const mt5State = mt5Status?.statusLabel ?? 'DISCONNECTED';
  const tradeMode = mt5Status?.tradeMode ?? 'UNKNOWN';
  const isRealAccount = tradeMode === 'REAL';
  const accountEquity = mt5Status?.equity ?? mt5Status?.balance ?? 10000;

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const currentIngestUrl = `${currentOrigin}/api/mt5/bridge/ingest`;

  const fmtTime = (ms: number | null | undefined) => {
    if (!ms || ms <= 0) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  };

  const previewLot = (sig: TradingSignal): number => {
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

  const previewBrokerSymbol = (sym: InstrumentSymbol): string => {
    const mapped = mt5ExecutionSettings.symbolMapping[sym] || sym;
    const ticks = mt5Status?.syncedTicks ?? [];
    if (ticks.some((t) => t.rawSymbol === mapped)) return mapped;
    const matched = ticks.find((t) => t.normalizedSymbol === sym);
    return matched ? matched.rawSymbol : mapped;
  };

  const handleToggleMaster = async () => {
    const nextEnabled = !mt5ExecutionSettings.enabled;
    const res = await updateMt5ExecutionSettings({ enabled: nextEnabled });
    if (res.ok) {
      setBanner({
        type: 'success',
        text: nextEnabled
          ? 'MT5 Signal Trade Engine ARMED & READY.'
          : 'MT5 Signal Trade Engine paused (existing open trades remain monitored).',
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Failed to update MT5 status.' });
    }
  };

  const handleToggleAuto = async () => {
    const nextAuto = !mt5ExecutionSettings.autoExecuteSignals;
    const res = await updateMt5ExecutionSettings({
      autoExecuteSignals: nextAuto,
      enabled: nextAuto ? true : mt5ExecutionSettings.enabled,
    });
    if (res.ok) {
      setBanner({
        type: 'success',
        text: nextAuto
          ? 'Auto-Execution ENABLED: confirmed BUY/SELL signals will be sent automatically to MT5.'
          : 'Auto-Execution disabled (Manual per-signal send mode).',
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Failed to toggle auto-execution.' });
    }
  };

  const handleSendSignal = async (signalId: string) => {
    setSendingSignalId(signalId);
    setBanner(null);
    const res = await executeMt5Trade(signalId);
    setSendingSignalId(null);
    if (res.success) {
      setBanner({
        type: 'success',
        text: 'Order command queued! GoldBtcTerminalBridge EA will execute it on MT5 within ~1 second.',
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Rejected by MT5 Trade Engine.' });
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setBanner(null);
    const res = await updateMt5ExecutionSettings(draft);
    setSaving(false);
    if (res.ok) {
      setBanner({
        type: 'success',
        text: 'MT5 trade execution & SL/BE/trailing management rules saved.',
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Failed to save settings.' });
    }
  };

  const handleResetSettings = async () => {
    setDraft(structuredClone(DEFAULT_MT5_EXECUTION_SETTINGS));
    const res = await updateMt5ExecutionSettings(DEFAULT_MT5_EXECUTION_SETTINGS);
    if (res.ok) {
      setBanner({ type: 'success', text: 'MT5 settings restored to recommended defaults.' });
    }
  };

  const handleApplyPreset = async (preset: MT5ExecutionPreset) => {
    setSaving(true);
    setBanner(null);
    setDraft((prev) => ({
      ...prev,
      ...preset.patch,
    }));
    const res = await updateMt5ExecutionSettings(preset.patch);
    setSaving(false);
    if (res.ok) {
      setBanner({
        type: 'success',
        text: `Applied "${preset.name}" preset (${preset.summary}).`,
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Failed to apply preset.' });
    }
  };

  const handleAutoMatchSymbols = () => {
    const ticks = mt5Status?.syncedTicks ?? [];
    if (ticks.length === 0) {
      setBanner({
        type: 'error',
        text: 'No live MT5 Market Watch symbols synced yet. Connect the EA in MT5 first.',
      });
      return;
    }
    const nextMapping = { ...draft.symbolMapping };
    let matchedCount = 0;
    for (const inst of INSTRUMENTS) {
      const tick = ticks.find((t) => t.normalizedSymbol === inst.symbol);
      if (tick?.rawSymbol) {
        nextMapping[inst.symbol] = tick.rawSymbol;
        matchedCount += 1;
      }
    }
    setDraft((d) => ({ ...d, symbolMapping: nextMapping }));
    setBanner({
      type: matchedCount > 0 ? 'success' : 'error',
      text:
        matchedCount > 0
          ? `Matched ${matchedCount} MT5 broker symbol(s) from live Market Watch ticks. Click "Save MT5 Management Settings" to persist.`
          : 'Synced MT5 ticks did not match XAUUSD, XAGUSD, BTCUSDT, or ETHUSDT automatically.',
    });
  };

  const handleTradeAction = async (
    tradeId: string,
    action: 'be' | 'tp1' | 'close'
  ) => {
    setBusyTradeId(tradeId);
    setBanner(null);
    const res =
      action === 'be'
        ? await moveMt5TradeToBreakeven(tradeId)
        : action === 'tp1'
          ? await trailMt5TradeToTp1(tradeId)
          : await closeMt5Trade(tradeId);
    setBusyTradeId(null);
    if (res.success) {
      setBanner({
        type: 'success',
        text:
          action === 'be'
            ? 'Move SL to Breakeven command queued for MT5 EA.'
            : action === 'tp1'
              ? 'Trail SL to TP1 command queued for MT5 EA.'
              : 'Close Position command queued for MT5 EA.',
      });
    } else {
      setBanner({ type: 'error', text: res.error || 'Command failed.' });
    }
  };

  const handleDownloadEa = async () => {
    setDownloadingEa(true);
    try {
      const res = await apiFetch('/api/mt5/ea/download');
      if (!res.ok) {
        setBanner({ type: 'error', text: 'Failed to download GoldBtcTerminalBridge.mq5' });
        return;
      }
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'GoldBtcTerminalBridge.mq5';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBanner({
        type: 'success',
        text: 'Downloaded GoldBtcTerminalBridge.mq5 (v3.00 Two-Way Execution EA).',
      });
    } finally {
      setDownloadingEa(false);
    }
  };

  const handleTestPing = async () => {
    const res = await apiFetch('/api/mt5/test-ping', { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      ingestUrl?: string;
      allowedOrigin?: string;
      error?: string;
    };
    if (res.ok && data.ok) {
      setPingResult({
        ok: true,
        text: `Reachable: ${data.ingestUrl} (MT5 Whitelist: ${data.allowedOrigin})`,
      });
    } else {
      setPingResult({ ok: false, text: data.error || `HTTP ${res.status}` });
    }
  };

  const handleCopy = async (key: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedField(key);
      setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // ignore if clipboard blocked
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col border border-[#2B3548] bg-[#12161F]">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] px-5 py-3">
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-[#38BDF8]" />
            <div>
              <h2 className="text-sm font-semibold text-[#E6EDF3]">
                MT5 Demo Auto-Trade & Position Management System
              </h2>
              <div className="font-mono text-[11px] text-[#8B949E]">
                Send Signal BUY/SELL Orders to MT5 · Breakeven, SL → TP1 Trailing & Partial Closes
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex border border-[#222938] bg-[#0B0E14] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTab('desk')}
                className={`px-3 py-1 font-medium cursor-pointer ${
                  tab === 'desk' ? 'bg-[#1C2331] text-[#38BDF8]' : 'text-[#8B949E] hover:text-white'
                }`}
              >
                Signal Execution ({executableSignals.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('trades')}
                className={`px-3 py-1 font-medium cursor-pointer ${
                  tab === 'trades'
                    ? 'bg-[#1C2331] text-[#0ECB81]'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                MT5 Trades ({activeManagedTrades.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('settings')}
                className={`flex items-center gap-1 px-3 py-1 font-medium cursor-pointer ${
                  tab === 'settings'
                    ? 'bg-[#1C2331] text-[#38BDF8]'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                <Sliders className="h-3 w-3" />
                <span>Trade Management Settings</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('guide')}
                className={`flex items-center gap-1 px-3 py-1 font-medium cursor-pointer ${
                  tab === 'guide'
                    ? 'bg-[#1C2331] text-[#0ECB81]'
                    : 'text-[#8B949E] hover:text-white'
                }`}
              >
                <BookOpen className="h-3 w-3" />
                <span>EA & How to Use</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close MT5 Trade Engine"
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Live MT5 Account & Master Switch Strip */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 border border-[#222938] bg-[#0B0E14] p-3">
            <div className="lg:col-span-7 flex flex-wrap items-center gap-x-5 gap-y-2">
              <div>
                <div className="text-[10px] text-[#8B949E]">MT5 Bridge</div>
                <div className="flex items-center gap-1.5 font-mono font-semibold">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      mt5State === 'CONNECTED'
                        ? 'bg-[#0ECB81]'
                        : mt5State === 'STALE'
                          ? 'bg-[#F59E0B]'
                          : 'bg-[#F6465D]'
                    }`}
                  />
                  <span
                    className={
                      mt5State === 'CONNECTED'
                        ? 'text-[#0ECB81]'
                        : mt5State === 'STALE'
                          ? 'text-[#F59E0B]'
                          : 'text-[#F6465D]'
                    }
                  >
                    {mt5State}
                  </span>
                </div>
              </div>

              <div>
                <div className="text-[10px] text-[#8B949E]">Account & Mode</div>
                <div className="flex items-center gap-1.5 font-mono text-[#E6EDF3]">
                  <span>{mt5Status?.accountNumber || '—'}</span>
                  <span
                    className={`border px-1.5 py-0.5 text-[10px] font-semibold ${
                      isRealAccount
                        ? 'border-[#F6465D]/60 bg-[#F6465D]/15 text-[#F6465D]'
                        : tradeMode === 'DEMO' || tradeMode === 'CONTEST'
                          ? 'border-[#0ECB81]/60 bg-[#0ECB81]/10 text-[#0ECB81]'
                          : 'border-[#222938] text-[#8B949E]'
                    }`}
                  >
                    {tradeMode}
                  </span>
                </div>
              </div>

              <div>
                <div className="text-[10px] text-[#8B949E]">Broker</div>
                <div className="font-mono text-[#C9D1D9] truncate max-w-[180px]">
                  {mt5Status?.broker || '—'}
                </div>
              </div>

              <div>
                <div className="text-[10px] text-[#8B949E]">Balance / Equity</div>
                <div className="font-mono text-[#E6EDF3] tabular-nums">
                  {mt5Status?.balance !== undefined
                    ? `${mt5Status.balance.toFixed(2)} / ${mt5Status.equity?.toFixed(2) ?? '—'} ${mt5Status.currency ?? ''}`
                    : '—'}
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 flex flex-wrap items-center justify-start lg:justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleToggleMaster()}
                className={`flex items-center gap-1.5 border px-3 py-1.5 font-semibold cursor-pointer ${
                  mt5ExecutionSettings.enabled
                    ? 'border-[#0ECB81] bg-[#0ECB81]/15 text-[#0ECB81]'
                    : 'border-[#38BDF8]/60 bg-[#161B26] text-[#38BDF8] hover:border-[#38BDF8]'
                }`}
              >
                {mt5ExecutionSettings.enabled ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    <span>Engine ARMED (Pause)</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    <span>Start MT5 Engine</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => void handleToggleAuto()}
                className={`flex items-center gap-1.5 border px-3 py-1.5 font-semibold cursor-pointer ${
                  mt5ExecutionSettings.autoExecuteSignals
                    ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                    : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                <span>
                  Auto Signals: {mt5ExecutionSettings.autoExecuteSignals ? 'ON' : 'MANUAL'}
                </span>
              </button>

              {activeManagedTrades.length > 0 && !confirmCloseAll && (
                <button
                  type="button"
                  onClick={() => setConfirmCloseAll(true)}
                  className="border border-[#F6465D]/60 bg-[#F6465D]/10 px-2.5 py-1.5 font-semibold text-[#F6465D] hover:bg-[#F6465D]/20 cursor-pointer"
                >
                  Close All ({activeManagedTrades.length})
                </button>
              )}
              {confirmCloseAll && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmCloseAll(false);
                      void closeAllMt5Trades();
                      setBanner({ type: 'success', text: 'Close All commands queued to MT5 EA.' });
                    }}
                    className="bg-[#F6465D] px-2.5 py-1.5 font-semibold text-white cursor-pointer"
                  >
                    Confirm Close All
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmCloseAll(false)}
                    className="border border-[#222938] px-2 py-1.5 text-[#8B949E] cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Demo Guard Warning */}
          {mt5ExecutionSettings.demoAccountOnly && isRealAccount && (
            <div className="flex items-center gap-2.5 border border-[#F6465D] bg-[#F6465D]/15 p-3 text-[#F6465D]">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <div>
                <div className="font-semibold">REAL LIVE ACCOUNT DETECTED — EXECUTION BLOCKED</div>
                <div className="text-[11px] text-[#E6EDF3]">
                  Demo-Only Safety Guard is active. Connect an MT5 Demo account or disable Demo-Only Guard in Trade Management Settings.
                </div>
              </div>
            </div>
          )}

          {!mt5Status?.connected && (
            <div className="flex flex-wrap items-center justify-between gap-2 border border-[#F59E0B]/50 bg-[#F59E0B]/10 p-3 text-[#F59E0B]">
              <div>
                <span className="font-semibold">MT5 Bridge is {mt5State}.</span> Ensure{' '}
                <span className="font-mono text-[#E6EDF3]">GoldBtcTerminalBridge.mq5 (v3.00)</span> is running on your MT5 Demo chart with <span className="font-mono">Algo Trading</span> enabled to execute orders.
              </div>
              <button
                type="button"
                onClick={() => setTab('guide')}
                className="border border-[#F59E0B]/60 bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#F59E0B] hover:bg-[#12161F] cursor-pointer"
              >
                Open EA Setup Guide
              </button>
            </div>
          )}

          {banner && (
            <div
              className={`flex items-center justify-between border px-3 py-2 text-xs ${
                banner.type === 'error'
                  ? 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  : 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
              }`}
            >
              <span>{banner.text}</span>
              <button
                type="button"
                onClick={() => setBanner(null)}
                className="underline text-[11px] cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Active Management Policy Summary Bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border border-[#1D2432] bg-[#0B0E14] px-3 py-2 font-mono text-[11px] text-[#8B949E]">
            <span>
              Sizing:{' '}
              <span className="text-[#E6EDF3]">
                {mt5ExecutionSettings.sizingMode === 'RISK_PERCENT'
                  ? `${mt5ExecutionSettings.riskPercentPerTrade}% Risk/Trade`
                  : `${mt5ExecutionSettings.fixedLotSize} Fixed Lot`}
              </span>
            </span>
            <span>·</span>
            <span>
              Breakeven:{' '}
              <span className={mt5ExecutionSettings.moveSlToBreakeven ? 'text-[#0ECB81]' : 'text-[#6E7681]'}>
                {mt5ExecutionSettings.moveSlToBreakeven
                  ? mt5ExecutionSettings.breakevenTrigger === 'TP1_HIT'
                    ? `On TP1 Hit (+${mt5ExecutionSettings.breakevenOffsetPoints} pts)`
                    : `At +${mt5ExecutionSettings.breakevenTriggerR}R (+${mt5ExecutionSettings.breakevenOffsetPoints} pts)`
                  : 'OFF'}
              </span>
            </span>
            <span>·</span>
            <span>
              SL → TP1 on TP2:{' '}
              <span className={mt5ExecutionSettings.trailSlToTp1OnTp2 ? 'text-[#0ECB81]' : 'text-[#6E7681]'}>
                {mt5ExecutionSettings.trailSlToTp1OnTp2 ? 'ON' : 'OFF'}
              </span>
            </span>
            <span>·</span>
            <span>
              Trailing:{' '}
              <span className="text-[#38BDF8]">{mt5ExecutionSettings.trailingMode}</span>
            </span>
            <span>·</span>
            <span>
              Partial TP:{' '}
              <span className={mt5ExecutionSettings.partialCloseEnabled ? 'text-[#0ECB81]' : 'text-[#6E7681]'}>
                {mt5ExecutionSettings.partialCloseEnabled
                  ? `TP1 ${mt5ExecutionSettings.tp1ClosePercent}% / TP2 ${mt5ExecutionSettings.tp2ClosePercent}%`
                  : 'OFF'}
              </span>
            </span>
          </div>

          {tab === 'desk' && (
            <div className="space-y-4">
              {/* Signals Ready for MT5 Dispatch */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#E6EDF3]">
                      Live BUY / SELL Signals Ready for MT5 ({executableSignals.length})
                    </div>
                    <div className="text-[11px] text-[#8B949E]">
                      Send any confirmed signal directly to your MT5 Demo account with automatic SL, TP, BE & trailing rules attached.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshMt5Execution()}
                    className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#C9D1D9] hover:border-[#38BDF8] cursor-pointer"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Refresh</span>
                  </button>
                </div>

                {executableSignals.length === 0 ? (
                  <div className="py-6 text-center text-[#8B949E]">
                    {!signalSettings.allowDefaultSignals
                      ? 'No confirmed Best/Filtered Strategy signals active right now. Arm validated strategies in Simple Mode, Strategy Discovery, or Live Market Strategy.'
                      : 'No open confirmed BUY/SELL signals right now. Open Signals Center or enable LIVE MARKET Strategy to generate signals.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1.5 pr-3">Signal</th>
                          <th className="py-1.5 pr-3">MT5 Symbol</th>
                          <th className="py-1.5 pr-3">Strategy</th>
                          <th className="py-1.5 pr-3">Score</th>
                          <th className="py-1.5 pr-3">Entry / Live</th>
                          <th className="py-1.5 pr-3">Stop Loss</th>
                          <th className="py-1.5 pr-3">TP1 / TP2 / TP3</th>
                          <th className="py-1.5 pr-3">Est. Lot</th>
                          <th className="py-1.5 text-right">MT5 Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {executableSignals.map((sig) => {
                          const p = getInstrumentMeta(sig.symbol).pricePrecision;
                          const liveQ = quotes[sig.symbol];
                          const brokerSym = previewBrokerSymbol(sig.symbol);
                          const existing = mt5ManagedTrades.find(
                            (t) => t.signalId === sig.id && t.status !== 'FAILED'
                          );
                          const lot = previewLot(sig);
                          const tp1 = sig.takeProfits[0]?.price;
                          const tp2 = sig.takeProfits[1]?.price;
                          const tp3 = sig.takeProfits[2]?.price;

                          return (
                            <tr key={sig.id}>
                              <td className="py-2 pr-3">
                                <span
                                  className={`font-semibold ${
                                    sig.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                  }`}
                                >
                                  {sig.direction}
                                </span>{' '}
                                <span className="text-[#E6EDF3]">{sig.symbol}</span>{' '}
                                <span className="text-[#8B949E]">({sig.entryTimeframe})</span>
                                <div className="text-[10px] text-[#38BDF8]">{sig.state}</div>
                              </td>
                              <td className="py-2 pr-3 text-[#E6EDF3]">{brokerSym}</td>
                              <td className="py-2 pr-3 text-[#38BDF8]">
                                {sig.strategyName ?? 'Signal Engine'}
                              </td>
                              <td className="py-2 pr-3">{sig.score}/100</td>
                              <td className="py-2 pr-3">
                                <div>{sig.entryPrice.toFixed(p)}</div>
                                <div className="text-[10px] text-[#8B949E]">
                                  Live: {liveQ?.price ? liveQ.price.toFixed(p) : '—'}
                                </div>
                              </td>
                              <td className="py-2 pr-3 text-[#F6465D]">{sig.stopLoss.toFixed(p)}</td>
                              <td className="py-2 pr-3 text-[#0ECB81]">
                                {[tp1, tp2, tp3]
                                  .filter((v): v is number => v !== undefined)
                                  .map((v) => v.toFixed(p))
                                  .join(' / ')}
                              </td>
                              <td className="py-2 pr-3 font-semibold text-[#E6EDF3]">{lot}</td>
                              <td className="py-2 text-right">
                                {existing ? (
                                  <span className="inline-block border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2 py-1 text-[10px] font-semibold text-[#38BDF8]">
                                    MT5 {existing.status}
                                    {existing.mt5Ticket ? ` #${existing.mt5Ticket}` : ''}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={sendingSignalId === sig.id}
                                    onClick={() => void handleSendSignal(sig.id)}
                                    className={`inline-flex items-center gap-1 border px-2.5 py-1 text-[11px] font-semibold cursor-pointer disabled:opacity-50 ${
                                      sig.direction === 'BUY'
                                        ? 'border-[#0ECB81]/60 bg-[#0ECB81]/15 text-[#0ECB81] hover:bg-[#0ECB81]/25'
                                        : 'border-[#F6465D]/60 bg-[#F6465D]/15 text-[#F6465D] hover:bg-[#F6465D]/25'
                                    }`}
                                  >
                                    <Send className="h-3 w-3" />
                                    <span>
                                      {sendingSignalId === sig.id
                                        ? 'Queuing...'
                                        : `Send ${sig.direction} to MT5`}
                                    </span>
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Command Queue Log */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                <div className="font-semibold text-[#E6EDF3]">
                  MT5 Bridge Command Queue ({mt5Commands.length})
                </div>
                {mt5Commands.length === 0 ? (
                  <div className="py-4 text-center text-[#8B949E]">
                    No commands dispatched to MT5 yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1 pr-3">Time</th>
                          <th className="py-1 pr-3">Command</th>
                          <th className="py-1 pr-3">Symbol</th>
                          <th className="py-1 pr-3">Vol / SL / TP</th>
                          <th className="py-1 pr-3">Reason</th>
                          <th className="py-1 pr-3">Status</th>
                          <th className="py-1 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {mt5Commands.slice(0, 30).map((cmd) => (
                          <tr key={cmd.id}>
                            <td className="py-1.5 pr-3 text-[#8B949E]">{fmtTime(cmd.createdAt)}</td>
                            <td className="py-1.5 pr-3 font-semibold text-[#E6EDF3]">
                              {cmd.type} ({cmd.side})
                            </td>
                            <td className="py-1.5 pr-3">
                              {cmd.brokerSymbol}
                              {cmd.mt5Ticket ? ` #${cmd.mt5Ticket}` : ''}
                            </td>
                            <td className="py-1.5 pr-3">
                              {cmd.volume} lot · SL {cmd.stopLoss} · TP {cmd.takeProfit}
                            </td>
                            <td className="py-1.5 pr-3 text-[#8B949E]">
                              {cmd.reason}
                              {cmd.errorMessage && (
                                <div className="text-[#F6465D]">{cmd.errorMessage}</div>
                              )}
                            </td>
                            <td className="py-1.5 pr-3">
                              <span
                                className={`font-semibold ${
                                  cmd.status === 'EXECUTED'
                                    ? 'text-[#0ECB81]'
                                    : cmd.status === 'FAILED' || cmd.status === 'EXPIRED'
                                      ? 'text-[#F6465D]'
                                      : cmd.status === 'PENDING' || cmd.status === 'DISPATCHED'
                                        ? 'text-[#F59E0B]'
                                        : 'text-[#8B949E]'
                                }`}
                              >
                                {cmd.status}
                              </span>
                            </td>
                            <td className="py-1.5 text-right">
                              {cmd.status === 'PENDING' && (
                                <button
                                  type="button"
                                  onClick={() => void cancelMt5Command(cmd.id)}
                                  className="border border-[#F6465D]/50 px-2 py-0.5 text-[10px] text-[#F6465D] cursor-pointer"
                                >
                                  Cancel
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'trades' && (
            <div className="space-y-4">
              {/* Managed MT5 Trades */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="font-semibold text-[#E6EDF3]">
                  Active Managed MT5 Trades ({activeManagedTrades.length})
                </div>
                {activeManagedTrades.length === 0 ? (
                  <div className="py-5 text-center text-[#8B949E]">
                    No active signal trades on MT5. Send a BUY/SELL signal from the Signal Execution tab.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1.5 pr-2">Ticket</th>
                          <th className="py-1.5 pr-2">Trade</th>
                          <th className="py-1.5 pr-2">Vol</th>
                          <th className="py-1.5 pr-2">Entry / Now</th>
                          <th className="py-1.5 pr-2">Current SL</th>
                          <th className="py-1.5 pr-2">TP1 / TP2 / TP3</th>
                          <th className="py-1.5 pr-2">P&L</th>
                          <th className="py-1.5 pr-2">Management Status</th>
                          <th className="py-1.5 text-right">Controls</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {activeManagedTrades.map((tr) => {
                          const p = getInstrumentMeta(tr.symbol).pricePrecision;
                          return (
                            <tr key={tr.id}>
                              <td className="py-2 pr-2 text-[#38BDF8]">
                                {tr.mt5Ticket ? `#${tr.mt5Ticket}` : tr.status}
                              </td>
                              <td className="py-2 pr-2">
                                <span
                                  className={`font-semibold ${
                                    tr.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                  }`}
                                >
                                  {tr.direction}
                                </span>{' '}
                                <span className="text-[#E6EDF3]">{tr.brokerSymbol}</span>
                                <div className="text-[10px] text-[#8B949E]">{tr.strategyName}</div>
                              </td>
                              <td className="py-2 pr-2">
                                {tr.openVolume}/{tr.requestedVolume}
                              </td>
                              <td className="py-2 pr-2">
                                <div>{tr.entryPrice.toFixed(p)}</div>
                                <div className="text-[#E6EDF3]">{tr.currentPrice.toFixed(p)}</div>
                              </td>
                              <td className="py-2 pr-2 text-[#F6465D]">
                                <div>{tr.currentStopLoss.toFixed(p)}</div>
                                <div className="flex gap-1 mt-0.5">
                                  {tr.breakevenDone && (
                                    <span className="border border-[#0ECB81]/50 bg-[#0ECB81]/10 px-1 text-[9px] text-[#0ECB81]">
                                      BE
                                    </span>
                                  )}
                                  {tr.slAtTp1Done && (
                                    <span className="border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-1 text-[9px] text-[#38BDF8]">
                                      SL@TP1
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 pr-2">
                                <div className={tr.tp1Done ? 'text-[#38BDF8]' : 'text-[#0ECB81]'}>
                                  TP1: {tr.tp1Price.toFixed(p)} {tr.tp1Done ? '✓' : ''}
                                </div>
                                {tr.tp2Price && (
                                  <div className={tr.tp2Done ? 'text-[#38BDF8]' : 'text-[#8B949E]'}>
                                    TP2: {tr.tp2Price.toFixed(p)} {tr.tp2Done ? '✓' : ''}
                                  </div>
                                )}
                              </td>
                              <td
                                className={`py-2 pr-2 font-semibold ${
                                  tr.unrealizedPnlUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {tr.unrealizedPnlUsd >= 0 ? '+' : ''}${tr.unrealizedPnlUsd.toFixed(2)}
                              </td>
                              <td className="py-2 pr-2 text-[#8B949E] max-w-[200px]">
                                {tr.lastManagementNote}
                              </td>
                              <td className="py-2 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1">
                                  {tr.mt5Ticket && (
                                    <>
                                      <button
                                        type="button"
                                        disabled={busyTradeId === tr.id}
                                        onClick={() => void handleTradeAction(tr.id, 'be')}
                                        title="Move Stop Loss to Breakeven right now"
                                        className="border border-[#0ECB81]/50 bg-[#0ECB81]/10 px-2 py-1 text-[10px] text-[#0ECB81] hover:bg-[#0ECB81]/20 cursor-pointer disabled:opacity-50"
                                      >
                                        SL → BE
                                      </button>
                                      <button
                                        type="button"
                                        disabled={busyTradeId === tr.id}
                                        onClick={() => void handleTradeAction(tr.id, 'tp1')}
                                        title="Trail Stop Loss to TP1 right now"
                                        className="border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2 py-1 text-[10px] text-[#38BDF8] hover:bg-[#38BDF8]/20 cursor-pointer disabled:opacity-50"
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
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Raw Broker Open Positions */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                <div className="font-semibold text-[#E6EDF3]">
                  Live MT5 Terminal Open Positions ({mt5Status?.openPositions?.length ?? 0})
                </div>
                {!mt5Status?.openPositions || mt5Status.openPositions.length === 0 ? (
                  <div className="py-4 text-center text-[#8B949E]">
                    No open positions currently reported by MetaTrader 5.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1 pr-3">Ticket</th>
                          <th className="py-1 pr-3">Symbol</th>
                          <th className="py-1 pr-3">Side</th>
                          <th className="py-1 pr-3">Volume</th>
                          <th className="py-1 pr-3">Open</th>
                          <th className="py-1 pr-3">Current</th>
                          <th className="py-1 pr-3">SL</th>
                          <th className="py-1 pr-3">TP</th>
                          <th className="py-1 pr-3">Comment</th>
                          <th className="py-1 text-right">Profit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {mt5Status.openPositions.map((p) => (
                          <tr key={p.ticket}>
                            <td className="py-1.5 pr-3 text-[#38BDF8]">#{p.ticket}</td>
                            <td className="py-1.5 pr-3 text-[#E6EDF3]">{p.symbol}</td>
                            <td
                              className={`py-1.5 pr-3 font-semibold ${
                                p.type === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                              }`}
                            >
                              {p.type}
                            </td>
                            <td className="py-1.5 pr-3">{p.volume}</td>
                            <td className="py-1.5 pr-3">{p.openPrice}</td>
                            <td className="py-1.5 pr-3">{p.currentPrice}</td>
                            <td className="py-1.5 pr-3 text-[#F6465D]">{p.sl || '—'}</td>
                            <td className="py-1.5 pr-3 text-[#0ECB81]">{p.tp || '—'}</td>
                            <td className="py-1.5 pr-3 text-[#8B949E]">{p.comment || '—'}</td>
                            <td
                              className={`py-1.5 text-right font-semibold ${
                                p.profit >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                              }`}
                            >
                              {p.profit >= 0 ? '+' : ''}
                              {p.profit.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Closed / Failed MT5 Trades */}
              {closedManagedTrades.length > 0 && (
                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                  <div className="font-semibold text-[#E6EDF3]">
                    Closed / Historical MT5 Signal Trades ({closedManagedTrades.length})
                  </div>
                  <div className="overflow-x-auto max-h-56 overflow-y-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1 pr-3">Ticket</th>
                          <th className="py-1 pr-3">Trade</th>
                          <th className="py-1 pr-3">Strategy</th>
                          <th className="py-1 pr-3">Entry</th>
                          <th className="py-1 pr-3">Status</th>
                          <th className="py-1 pr-3">Note</th>
                          <th className="py-1 text-right">Closed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {closedManagedTrades.map((tr) => (
                          <tr key={tr.id}>
                            <td className="py-1.5 pr-3 text-[#8B949E]">
                              {tr.mt5Ticket ? `#${tr.mt5Ticket}` : '—'}
                            </td>
                            <td className="py-1.5 pr-3">
                              <span
                                className={
                                  tr.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }
                              >
                                {tr.direction}
                              </span>{' '}
                              {tr.brokerSymbol}
                            </td>
                            <td className="py-1.5 pr-3 text-[#38BDF8]">{tr.strategyName}</td>
                            <td className="py-1.5 pr-3">{tr.entryPrice}</td>
                            <td
                              className={`py-1.5 pr-3 font-semibold ${
                                tr.status === 'FAILED' ? 'text-[#F6465D]' : 'text-[#C9D1D9]'
                              }`}
                            >
                              {tr.status}
                            </td>
                            <td className="py-1.5 pr-3 text-[#8B949E]">{tr.lastManagementNote}</td>
                            <td className="py-1.5 text-right text-[#8B949E]">
                              {fmtTime(tr.closedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-4">
              {/* 1-Click Presets */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#E6EDF3]">
                      1-Click Trading Presets
                    </div>
                    <div className="text-[11px] text-[#8B949E]">
                      Apply a ready-to-trade lot sizing &amp; SL protection profile immediately, then customize individual fields below if needed.
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {MT5_EXECUTION_PRESETS.map((preset) => {
                    const active = doesSettingsMatchPreset(draft, preset);
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={saving}
                        onClick={() => void handleApplyPreset(preset)}
                        className={`text-left border p-3 transition-colors cursor-pointer disabled:opacity-50 ${
                          active
                            ? 'border-[#0ECB81] bg-[#0ECB81]/10'
                            : 'border-[#222938] bg-[#12161F] hover:border-[#38BDF8]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-xs text-[#E6EDF3]">
                            {preset.name}
                          </span>
                          {active ? (
                            <span className="font-mono text-[10px] font-semibold text-[#0ECB81] whitespace-nowrap">
                              ACTIVE
                            </span>
                          ) : preset.recommended ? (
                            <span className="font-mono text-[10px] font-semibold text-[#38BDF8] whitespace-nowrap">
                              RECOMMENDED
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[11px] text-[#8B949E] leading-snug">
                          {preset.subtitle}
                        </p>
                        <div className="mt-2 font-mono text-[10px] text-[#C9D1D9] tabular-nums">
                          {preset.summary}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Section 1: Breakeven & SL Trailing Rules */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#0ECB81]">
                      1. Stop Loss Trailing, Breakeven & SL → TP1 Progression
                    </div>
                    <div className="text-[11px] text-[#8B949E]">
                      Controls how open MT5 trades are automatically protected as price hits TP1, TP2, or R-multiple milestones.
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="border border-[#1D2432] bg-[#12161F] p-3 space-y-2.5">
                    <label className="flex items-center gap-2 font-semibold text-[#E6EDF3] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.moveSlToBreakeven}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, moveSlToBreakeven: e.target.checked }))
                        }
                        className="accent-[#0ECB81]"
                      />
                      <span>Move SL to Breakeven</span>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-[#8B949E]">Breakeven Trigger</span>
                      <select
                        value={draft.breakevenTrigger}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            breakevenTrigger: e.target.value as MT5BreakevenTrigger,
                          }))
                        }
                        className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3]"
                      >
                        <option value="TP1_HIT">When TP1 is Hit</option>
                        <option value="R_MULTIPLE">At Custom R-Multiple</option>
                      </select>
                    </label>
                    {draft.breakevenTrigger === 'R_MULTIPLE' && (
                      <label className="block space-y-1">
                        <span className="text-[11px] text-[#8B949E]">Trigger R-Multiple</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0.2"
                          max="5"
                          value={draft.breakevenTriggerR}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              breakevenTriggerR: Number(e.target.value) || 1.0,
                            }))
                          }
                          className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                        />
                      </label>
                    )}
                    <label className="block space-y-1">
                      <span className="text-[11px] text-[#8B949E]">
                        Breakeven Lock Offset (Points)
                      </span>
                      <input
                        type="number"
                        step="5"
                        min="0"
                        max="500"
                        value={draft.breakevenOffsetPoints}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            breakevenOffsetPoints: Number(e.target.value) || 0,
                          }))
                        }
                        className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                      />
                    </label>
                  </div>

                  <div className="border border-[#1D2432] bg-[#12161F] p-3 space-y-2.5">
                    <label className="flex items-center gap-2 font-semibold text-[#E6EDF3] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.trailSlToTp1OnTp2}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, trailSlToTp1OnTp2: e.target.checked }))
                        }
                        className="accent-[#38BDF8]"
                      />
                      <span>Trail SL to TP1 on TP2 Hit</span>
                    </label>
                    <p className="text-[11px] text-[#8B949E]">
                      Locks guaranteed profit at TP1 automatically as soon as price reaches TP2.
                    </p>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-[#8B949E]">Dynamic Trailing Mode</span>
                      <select
                        value={draft.trailingMode}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            trailingMode: e.target.value as MT5TrailingMode,
                          }))
                        }
                        className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3]"
                      >
                        <option value="TP_STEP">TP Step Only (BE at TP1 → SL@TP1 at TP2)</option>
                        <option value="FIXED_R">Fixed R-Distance Trailing</option>
                        <option value="ATR_MULTIPLE">ATR Volatility Trailing</option>
                        <option value="NONE">No Trailing Stop</option>
                      </select>
                    </label>
                    {(draft.trailingMode === 'FIXED_R' ||
                      draft.trailingMode === 'ATR_MULTIPLE') && (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block space-y-1">
                          <span className="text-[10px] text-[#8B949E]">Activate at (R)</span>
                          <input
                            type="number"
                            step="0.1"
                            min="0.3"
                            max="10"
                            value={draft.trailingActivationR}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                trailingActivationR: Number(e.target.value) || 1.2,
                              }))
                            }
                            className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                          />
                        </label>
                        {draft.trailingMode === 'FIXED_R' ? (
                          <label className="block space-y-1">
                            <span className="text-[10px] text-[#8B949E]">Trail Dist (R)</span>
                            <input
                              type="number"
                              step="0.1"
                              min="0.1"
                              max="5"
                              value={draft.trailingDistanceR}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  trailingDistanceR: Number(e.target.value) || 0.5,
                                }))
                              }
                              className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                            />
                          </label>
                        ) : (
                          <label className="block space-y-1">
                            <span className="text-[10px] text-[#8B949E]">ATR Mult</span>
                            <input
                              type="number"
                              step="0.1"
                              min="0.2"
                              max="6"
                              value={draft.trailingAtrMultiplier}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  trailingAtrMultiplier: Number(e.target.value) || 1.5,
                                }))
                              }
                              className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                            />
                          </label>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border border-[#1D2432] bg-[#12161F] p-3 space-y-2.5">
                    <label className="flex items-center gap-2 font-semibold text-[#E6EDF3] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.partialCloseEnabled}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, partialCloseEnabled: e.target.checked }))
                        }
                        className="accent-[#0ECB81]"
                      />
                      <span>Enable Partial Take Profits</span>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-[#8B949E]">Initial Broker Hard TP</span>
                      <select
                        value={draft.initialTpLevel}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            initialTpLevel: Number(e.target.value) as 1 | 2 | 3,
                          }))
                        }
                        className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 text-xs text-[#E6EDF3]"
                      >
                        <option value={3}>TP3 (Full Runner + Partial TP1/TP2)</option>
                        <option value={2}>TP2 Target</option>
                        <option value={1}>TP1 Target (Single Exit)</option>
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-[10px] text-[#8B949E]">TP1 Close %</span>
                        <input
                          type="number"
                          step="10"
                          min="0"
                          max="100"
                          value={draft.tp1ClosePercent}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              tp1ClosePercent: Number(e.target.value) || 0,
                            }))
                          }
                          className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[10px] text-[#8B949E]">TP2 Close %</span>
                        <input
                          type="number"
                          step="10"
                          min="0"
                          max="100"
                          value={draft.tp2ClosePercent}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              tp2ClosePercent: Number(e.target.value) || 0,
                            }))
                          }
                          className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[10px] text-[#8B949E]">
                        Min Trail Step (Points)
                      </span>
                      <input
                        type="number"
                        step="5"
                        min="1"
                        max="500"
                        value={draft.trailingMinStepPoints}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            trailingMinStepPoints: Number(e.target.value) || 20,
                          }))
                        }
                        className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-[#E6EDF3]"
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Section 2: Lot Sizing, Signal Rules & Safety Guards */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="font-semibold text-[#38BDF8]">
                  2. Position Sizing, Signal Filters & Safety Limits
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Sizing Mode</span>
                    <select
                      value={draft.sizingMode}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, sizingMode: e.target.value as MT5SizingMode }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 text-[#E6EDF3]"
                    >
                      <option value="RISK_PERCENT">Risk % of MT5 Equity</option>
                      <option value="FIXED_LOT">Fixed Lot Size</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">
                      {draft.sizingMode === 'RISK_PERCENT' ? 'Risk / Trade (%)' : 'Fixed Lot Size'}
                    </span>
                    <input
                      type="number"
                      min="0.01"
                      max="50"
                      step={draft.sizingMode === 'RISK_PERCENT' ? '0.1' : '0.01'}
                      value={
                        draft.sizingMode === 'RISK_PERCENT'
                          ? draft.riskPercentPerTrade
                          : draft.fixedLotSize
                      }
                      onChange={(e) => {
                        const v = Number(e.target.value) || 0;
                        setDraft((d) =>
                          d.sizingMode === 'RISK_PERCENT'
                            ? { ...d, riskPercentPerTrade: v }
                            : { ...d, fixedLotSize: v }
                        );
                      }}
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Max Lot Cap</span>
                    <input
                      type="number"
                      min="0.01"
                      max="50"
                      step="0.01"
                      value={draft.maxLotSize}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, maxLotSize: Number(e.target.value) || 0.05 }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Min Signal Score</span>
                    <input
                      type="number"
                      min="40"
                      max="99"
                      value={draft.minSignalScore}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, minSignalScore: Number(e.target.value) || 75 }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Max Open Total</span>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={draft.maxOpenPositionsTotal}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          maxOpenPositionsTotal: Number(e.target.value) || 4,
                        }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Max Open / Symbol</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={draft.maxOpenPositionsPerSymbol}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          maxOpenPositionsPerSymbol: Number(e.target.value) || 1,
                        }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">EA Magic Number</span>
                    <input
                      type="number"
                      value={draft.magicNumber}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, magicNumber: Number(e.target.value) || 202611 }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] text-[#8B949E]">Slippage Deviation (Pts)</span>
                    <input
                      type="number"
                      min="0"
                      max="500"
                      value={draft.deviationPoints}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, deviationPoints: Number(e.target.value) || 30 }))
                      }
                      className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3]"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.demoAccountOnly}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, demoAccountOnly: e.target.checked }))
                      }
                      className="accent-[#0ECB81]"
                    />
                    <span className="text-[#0ECB81] font-semibold">
                      Demo-Only Safety Guard (Block REAL accounts)
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.allowWatchingSignals}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, allowWatchingSignals: e.target.checked }))
                      }
                      className="accent-[#38BDF8]"
                    />
                    <span className="text-[#C9D1D9]">Allow WATCHING signals (intrabar)</span>
                  </label>
                </div>
              </div>

              {/* Section 3: Allowed Symbols & Broker Mapping */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#E6EDF3]">
                      3. Allowed Instruments & MT5 Broker Symbol Names
                    </div>
                    <p className="text-[11px] text-[#8B949E]">
                      Match your MT5 Market Watch symbol names exactly (for example <span className="font-mono text-[#C9D1D9]">XAUUSDm</span>, <span className="font-mono text-[#C9D1D9]">GOLD</span>, or <span className="font-mono text-[#C9D1D9]">BTCUSD</span>).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAutoMatchSymbols}
                    className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#12161F] px-2.5 py-1 text-[11px] font-semibold text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap cursor-pointer"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    <span>Auto-Match MT5 Symbols</span>
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {INSTRUMENTS.map((inst) => {
                    const enabled = draft.allowedSymbols.includes(inst.symbol);
                    return (
                      <div key={inst.symbol} className="border border-[#1D2432] bg-[#12161F] p-2.5 space-y-2">
                        <label className="flex items-center justify-between font-mono font-semibold text-[#E6EDF3] cursor-pointer">
                          <span>{inst.symbol}</span>
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={() =>
                              setDraft((d) => ({
                                ...d,
                                allowedSymbols: enabled
                                  ? d.allowedSymbols.filter((s) => s !== inst.symbol)
                                  : [...d.allowedSymbols, inst.symbol],
                              }))
                            }
                            className="accent-[#0ECB81]"
                          />
                        </label>
                        <input
                          type="text"
                          value={draft.symbolMapping[inst.symbol]}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              symbolMapping: { ...d.symbolMapping, [inst.symbol]: e.target.value },
                            }))
                          }
                          placeholder={`Broker ${inst.symbol} symbol`}
                          className="w-full border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#38BDF8]"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => void handleResetSettings()}
                  className="border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#8B949E] hover:text-white cursor-pointer"
                >
                  Reset to Recommended Defaults
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveSettings()}
                  className="flex items-center gap-1.5 bg-[#0ECB81] px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-[#0ECB81]/90 cursor-pointer disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>{saving ? 'Saving...' : 'Save MT5 Management Settings'}</span>
                </button>
              </div>
            </div>
          )}

          {tab === 'guide' && (
            <div className="space-y-4">
              <div className="border border-[#0ECB81]/40 bg-[#0ECB81]/10 p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="h-5 w-5 text-[#0ECB81] shrink-0" />
                  <div>
                    <div className="font-semibold text-[#0ECB81]">
                      Upgrade to GoldBtcTerminalBridge.mq5 v3.00 (Two-Way Execution EA)
                    </div>
                    <div className="text-[11px] text-[#C9D1D9]">
                      Replaces the read-only EA so your MT5 Demo terminal can execute app BUY/SELL signals, partial TPs, Breakeven, and SL-to-TP1 modifications.
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestPing()}
                    className="border border-[#38BDF8]/60 bg-[#0B0E14] px-3 py-1.5 font-semibold text-[#38BDF8] cursor-pointer"
                  >
                    Verify Bridge URL
                  </button>
                  <button
                    type="button"
                    disabled={downloadingEa}
                    onClick={() => void handleDownloadEa()}
                    className="flex items-center gap-1.5 bg-[#38BDF8] px-3 py-1.5 font-semibold text-slate-950 hover:bg-[#38BDF8]/90 cursor-pointer disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{downloadingEa ? 'Downloading...' : 'Download EA v3.00 (.mq5)'}</span>
                  </button>
                </div>
              </div>

              {pingResult && (
                <div
                  className={`border p-2.5 font-mono text-[11px] ${
                    pingResult.ok
                      ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                      : 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  }`}
                >
                  {pingResult.text}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                <div className="border border-[#222938] bg-[#0B0E14] p-3 space-y-1">
                  <div className="text-[#8B949E]">MT5 Whitelist Origin</div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[#E6EDF3]">
                    <span className="truncate">{currentOrigin}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy('origin', currentOrigin)}
                      className="flex items-center gap-1 border border-[#2B3548] px-2 py-0.5 text-[10px] text-[#38BDF8] cursor-pointer"
                    >
                      {copiedField === 'origin' ? <Check className="h-3 w-3 text-[#0ECB81]" /> : <Copy className="h-3 w-3" />}
                      <span>{copiedField === 'origin' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3 space-y-1">
                  <div className="text-[#8B949E]">EA Input InpServerUrl</div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[#E6EDF3]">
                    <span className="truncate">{currentIngestUrl}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy('ingest', currentIngestUrl)}
                      className="flex items-center gap-1 border border-[#2B3548] px-2 py-0.5 text-[10px] text-[#38BDF8] cursor-pointer"
                    >
                      {copiedField === 'ingest' ? <Check className="h-3 w-3 text-[#0ECB81]" /> : <Copy className="h-3 w-3" />}
                      <span>{copiedField === 'ingest' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5 text-xs text-[#C9D1D9]">
                <div className="font-semibold text-[#E6EDF3]">How to Use MT5 Demo Signal Trading</div>
                <ol className="list-decimal list-inside space-y-1.5 text-[11px]">
                  <li>
                    Click <span className="text-[#38BDF8] font-semibold">Download EA v3.00 (.mq5)</span> above and overwrite <span className="font-mono text-[#E6EDF3]">MQL5/Experts/GoldBtcTerminalBridge.mq5</span> in MetaTrader 5, then press <span className="font-mono">F7</span> in MetaEditor to compile.
                  </li>
                  <li>
                    Attach the EA to your MT5 Demo chart with <span className="font-mono text-[#E6EDF3]">InpEnableTradeExecution = true</span> and <span className="font-mono text-[#0ECB81]">Algo Trading</span> enabled in the MT5 toolbar.
                  </li>
                  <li>
                    Open the <span className="text-[#38BDF8] font-semibold">Trade Management Settings</span> tab: set your Risk %, Broker Symbol Names (e.g. <span className="font-mono">XAUUSDm</span> / <span className="font-mono">BTCUSD</span>), Breakeven trigger (TP1 Hit or +R), Partial TP percentages, and <span className="font-semibold text-[#0ECB81]">Trail SL to TP1 on TP2 Hit</span>.
                  </li>
                  <li>
                    Click <span className="text-[#0ECB81] font-semibold">Start MT5 Engine</span> at the top right. Choose <span className="font-semibold">MANUAL</span> (click <span className="font-mono">Send BUY/SELL to MT5</span> per signal) or toggle <span className="font-semibold text-[#38BDF8]">Auto Signals: ON</span> to automatically execute new confirmed signals.
                  </li>
                  <li>
                    Track every ticket in the <span className="text-[#0ECB81] font-semibold">MT5 Trades</span> tab, where you can also click <span className="font-mono">SL → BE</span>, <span className="font-mono">SL → TP1</span>, or <span className="font-mono">Close</span> at any moment.
                  </li>
                </ol>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
