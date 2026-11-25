import {
  Activity,
  Check,
  Copy,
  Download,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getInstrumentMeta } from '../../shared/constants/index.ts';
import type { PaperPosition } from '../../shared/types/index.ts';
import { apiFetch } from '../state/api-client.ts';
import { useTerminal } from '../state/terminal-context.tsx';

interface PingResult {
  ok: boolean;
  endpointReachable?: boolean;
  allowedOrigin?: string;
  ingestUrl?: string;
  requiresApiToken?: boolean;
  error?: string;
  checkedAt: number;
}

export function PaperRiskControlModal({
  onClose,
  initialTab = 'paper',
}: {
  onClose: () => void;
  initialTab?: 'paper' | 'mt5';
}) {
  const {
    symbol,
    quotes,
    providers,
    timezone,
    paperPositions,
    paperOrders,
    riskSnapshot,
    mt5Status,
    refreshMt5Status,
    refreshPaperState,
    closePaperPosition,
    resetPaperAccount,
    updateRiskSettings,
  } = useTerminal();

  const [activeTab, setActiveTab] = useState<'paper' | 'mt5'>(initialTab);
  const [killReason, setKillReason] = useState('');
  const [showKillInput, setShowKillInput] = useState(false);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Risk & Auto-Paper settings form
  const [showSettingsForm, setShowSettingsForm] = useState(false);
  const [equityInput, setEquityInput] = useState('10000');
  const [riskPerTradeInput, setRiskPerTradeInput] = useState('0.25');
  const [maxDailyLossInput, setMaxDailyLossInput] = useState('1.5');
  const [maxInstOpenInput, setMaxInstOpenInput] = useState('1');
  const [minRrInput, setMinRrInput] = useState('1.2');
  const [autoExecuteInput, setAutoExecuteInput] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Account reset inline confirmation
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // MT5 Bridge verification & copy helpers
  const [pingLoading, setPingLoading] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [downloadingEa, setDownloadingEa] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    void refreshPaperState();
    void refreshMt5Status();
    const timer = setInterval(() => {
      void refreshPaperState();
      void refreshMt5Status();
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshPaperState, refreshMt5Status]);

  useEffect(() => {
    if (!riskSnapshot?.settings) return;
    setEquityInput(String(riskSnapshot.settings.accountEquity));
    setRiskPerTradeInput(String(riskSnapshot.settings.riskPerTradePercent));
    setMaxDailyLossInput(String(riskSnapshot.settings.maxDailyLossPercent));
    setMaxInstOpenInput(String(riskSnapshot.settings.maxOpenPositionsPerInstrument));
    setMinRrInput(String(riskSnapshot.settings.minPlannedNetRR));
    setAutoExecuteInput(Boolean(riskSnapshot.settings.autoExecuteConfirmedSignals));
  }, [riskSnapshot?.settings]);

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

  const handleToggleKillSwitch = async (engage: boolean) => {
    const res = await apiFetch('/api/risk/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engage,
        reason: killReason.trim() || 'Operator emergency risk halt',
      }),
    });
    if (res.ok) {
      await refreshPaperState();
      setShowKillInput(false);
      setKillReason('');
      setActionBanner({
        type: 'success',
        text: engage ? 'Emergency Kill Switch engaged.' : 'Kill Switch released. Paper trading ready.',
      });
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setActionBanner({
        type: 'error',
        text: err.error || `Failed to update Kill Switch (${res.status})`,
      });
    }
  };

  const handleClosePosition = async (positionId: string) => {
    setClosingPositionId(positionId);
    setActionBanner(null);
    const res = await closePaperPosition(positionId);
    setClosingPositionId(null);
    if (res.success) {
      setActionBanner({ type: 'success', text: 'Paper position closed & journal synced.' });
    } else {
      setActionBanner({ type: 'error', text: res.error || 'Failed to close position.' });
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setActionBanner(null);
    try {
      await updateRiskSettings({
        accountEquity: Number(equityInput) || 10000,
        riskPerTradePercent: Number(riskPerTradeInput) || 0.25,
        maxDailyLossPercent: Number(maxDailyLossInput) || 1.5,
        maxOpenPositionsPerInstrument: Math.max(1, Math.round(Number(maxInstOpenInput) || 1)),
        minPlannedNetRR: Number(minRrInput) || 1.2,
        autoExecuteConfirmedSignals: autoExecuteInput,
      });
      await refreshPaperState();
      setShowSettingsForm(false);
      setActionBanner({ type: 'success', text: 'Risk & Paper Execution settings updated.' });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to save settings.',
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleConfirmReset = async () => {
    setResetting(true);
    setActionBanner(null);
    try {
      const targetEquity = Number(equityInput);
      await resetPaperAccount(
        Number.isFinite(targetEquity) && targetEquity >= 100 ? targetEquity : undefined
      );
      setConfirmReset(false);
      setActionBanner({
        type: 'success',
        text: 'Paper trading account reset cleanly.',
      });
    } finally {
      setResetting(false);
    }
  };

  const handleTestBridgePing = async () => {
    setPingLoading(true);
    try {
      const res = await apiFetch('/api/mt5/test-ping', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as Partial<PingResult>;
      setPingResult({
        ok: res.ok && Boolean(data.ok),
        endpointReachable: data.endpointReachable,
        allowedOrigin: data.allowedOrigin,
        ingestUrl: data.ingestUrl,
        requiresApiToken: data.requiresApiToken,
        error: res.ok ? undefined : data.error || `HTTP ${res.status}`,
        checkedAt: Date.now(),
      });
      await refreshMt5Status();
    } catch (err) {
      setPingResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Request failed',
        checkedAt: Date.now(),
      });
    } finally {
      setPingLoading(false);
    }
  };

  const handleDownloadEa = async () => {
    setDownloadingEa(true);
    try {
      const res = await apiFetch('/api/mt5/ea/download');
      if (!res.ok) {
        setActionBanner({ type: 'error', text: 'Unable to download GoldBtcTerminalBridge.mq5' });
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
    } finally {
      setDownloadingEa(false);
    }
  };

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context; user can copy from input text
    }
  };

  const quote = quotes[symbol];
  const provider = providers[symbol];
  const isKilled = Boolean(riskSnapshot?.settings?.killSwitchEngaged);

  const openPositions = useMemo(
    () => paperPositions.filter((p) => p.status === 'OPEN' || p.status === 'PARTIAL'),
    [paperPositions]
  );
  const closedPositions = useMemo(
    () => paperPositions.filter((p) => p.status === 'CLOSED' || p.status === 'CANCELLED'),
    [paperPositions]
  );

  const totalUnrealizedPnl = useMemo(
    () => openPositions.reduce((sum, p) => sum + (p.unrealizedPnlUsd || 0), 0),
    [openPositions]
  );
  const totalRealizedPnl = useMemo(
    () => paperPositions.reduce((sum, p) => sum + (p.realizedPnlUsd || 0), 0),
    [paperPositions]
  );
  const closedWins = useMemo(
    () => closedPositions.filter((p) => p.realizedPnlUsd > 0).length,
    [closedPositions]
  );
  const closedWinRate =
    closedPositions.length > 0 ? (closedWins / closedPositions.length) * 100 : 0;

  const accountEquity = riskSnapshot?.currentEquity ?? 10000;
  const totalLiveEquity = accountEquity + totalUnrealizedPnl;

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const currentIngestUrl = `${currentOrigin}/api/mt5/bridge/ingest`;
  const isCloudRunOrigin = currentOrigin.includes('.run.app');
  const mt5State = mt5Status?.statusLabel ?? 'DISCONNECTED';

  const getNextTpLabel = (pos: PaperPosition) => {
    const meta = getInstrumentMeta(pos.symbol);
    const nextTp = pos.takeProfits.find((t) => !t.hit) ?? pos.takeProfits[pos.takeProfits.length - 1];
    if (!nextTp) return '—';
    return `TP${nextTp.level}: ${nextTp.price.toFixed(meta.pricePrecision)}`;
  };

  const isAtBreakeven = (pos: PaperPosition) => {
    const meta = getInstrumentMeta(pos.symbol);
    const tol = Math.pow(10, -meta.pricePrecision) * 5;
    if (pos.direction === 'BUY') return pos.stopLoss >= pos.entryPrice - tol && pos.stopLoss > pos.initialStopLoss;
    return pos.stopLoss <= pos.entryPrice + tol && pos.stopLoss < pos.initialStopLoss;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col border border-[#2B3548] bg-[#12161F]">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222938] px-5 py-3">
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-[#0ECB81]" />
            <div>
              <h2 className="text-sm font-semibold text-[#E6EDF3]">
                Paper Trading, Risk Guard & MT5 Bridge Control
              </h2>
              <div className="text-[11px] font-mono text-[#8B949E]">
                Live Mark-to-Market Paper Engine · Read-Only MT5 Relay
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex border border-[#222938] bg-[#0B0E14] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('paper')}
                className={`px-3 py-1 font-medium cursor-pointer ${
                  activeTab === 'paper'
                    ? 'bg-[#1C2331] text-[#0ECB81]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                Paper Trading & Risk ({openPositions.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('mt5')}
                className={`flex items-center gap-1.5 px-3 py-1 font-medium cursor-pointer ${
                  activeTab === 'mt5'
                    ? 'bg-[#1C2331] text-[#38BDF8]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    mt5State === 'CONNECTED'
                      ? 'bg-[#0ECB81]'
                      : mt5State === 'STALE'
                        ? 'bg-[#F59E0B]'
                        : 'bg-[#F6465D]'
                  }`}
                />
                <span>MT5 Bridge ({mt5State})</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close Paper & Risk Control"
              className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Execution Mode Lock Banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 border border-[#0ECB81]/50 bg-[#0ECB81]/10 p-3">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-5 w-5 text-[#0ECB81] shrink-0" />
              <div>
                <div className="font-semibold text-[#0ECB81]">
                  PAPER TRADING MODE — REAL BROKER ORDERS PERMANENTLY LOCKED
                </div>
                <div className="text-[11px] text-[#C9D1D9]">
                  Executes simulated orders on real bid/ask prices with spread, commission & slippage. Automatically evaluates SL, TP1/TP2 partial exits, breakeven stops & Trade Journal sync.
                </div>
              </div>
            </div>
            <div className="font-mono text-[11px] text-[#0ECB81] bg-[#0ECB81]/20 px-2.5 py-1 shrink-0">
              PAPER_MODE_LOCKED = true
            </div>
          </div>

          {actionBanner && (
            <div
              className={`border px-3 py-2 text-xs ${
                actionBanner.type === 'error'
                  ? 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  : 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
              }`}
            >
              {actionBanner.text}
            </div>
          )}

          {activeTab === 'paper' ? (
            <>
              {/* Account KPI Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono tabular-nums">
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Settled Equity</div>
                  <div className="mt-1 text-sm font-semibold text-[#E6EDF3]">
                    ${accountEquity.toFixed(2)}
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Live Equity (M2M)</div>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      totalLiveEquity >= accountEquity ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    ${totalLiveEquity.toFixed(2)}
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Unrealized P&L</div>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      totalUnrealizedPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)}
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Total Realized P&L</div>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      totalRealizedPnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)}
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Open Risk / Max</div>
                  <div className="mt-1 text-sm font-semibold text-[#38BDF8]">
                    {riskSnapshot?.totalOpenRiskPercent ?? 0}% /{' '}
                    {riskSnapshot?.settings?.maxTotalOpenRiskPercent ?? 1}%
                  </div>
                </div>
                <div className="border border-[#222938] bg-[#0B0E14] p-3">
                  <div className="text-[11px] font-sans text-[#8B949E]">Paper Win Rate</div>
                  <div className="mt-1 text-sm font-semibold text-[#E6EDF3]">
                    {closedWinRate.toFixed(1)}% ({closedWins}/{closedPositions.length})
                  </div>
                </div>
              </div>

              {/* Risk Controls, Kill Switch, Settings & Account Reset */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Kill Switch & Risk Summary */}
                <div
                  className={`border p-4 space-y-3 ${
                    isKilled ? 'border-[#F6465D] bg-[#F6465D]/10' : 'border-[#222938] bg-[#0B0E14]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <ShieldAlert
                        className={`h-4 w-4 ${isKilled ? 'text-[#F6465D]' : 'text-[#F59E0B]'}`}
                      />
                      <span className="font-semibold text-[#E6EDF3]">
                        Risk Guard:{' '}
                        {isKilled
                          ? 'KILL SWITCH ENGAGED'
                          : riskSnapshot?.tradingLocked
                            ? 'DAILY/WEEKLY LIMIT LOCKED'
                            : 'ACTIVE & ARMED'}
                      </span>
                    </div>
                    {isKilled ? (
                      <button
                        type="button"
                        onClick={() => void handleToggleKillSwitch(false)}
                        className="bg-[#0ECB81] px-3 py-1 font-semibold text-slate-950 cursor-pointer"
                      >
                        Release Kill Switch
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowKillInput((prev) => !prev)}
                        className="bg-[#F6465D] px-3 py-1 font-semibold text-white cursor-pointer"
                      >
                        Engage Kill Switch
                      </button>
                    )}
                  </div>

                  {showKillInput && !isKilled && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-[#222938] pt-2.5">
                      <input
                        type="text"
                        value={killReason}
                        onChange={(e) => setKillReason(e.target.value)}
                        placeholder="Kill switch reason..."
                        className="flex-1 min-w-[180px] border border-[#2B3548] bg-[#12161F] px-2.5 py-1 text-xs text-[#E6EDF3] outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handleToggleKillSwitch(true)}
                        className="bg-[#F6465D] px-3 py-1 font-semibold text-white cursor-pointer"
                      >
                        Confirm Halt
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-[#C9D1D9]">
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Risk / Trade</span>
                      <span>{riskSnapshot?.settings?.riskPerTradePercent ?? 0.25}%</span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Trades Today</span>
                      <span>
                        {riskSnapshot?.tradesTodayCount ?? 0} /{' '}
                        {riskSnapshot?.settings?.maxDailyTrades ?? 12}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Daily Realized</span>
                      <span
                        className={
                          (riskSnapshot?.dailyRealizedPnlUsd ?? 0) >= 0
                            ? 'text-[#0ECB81]'
                            : 'text-[#F6465D]'
                        }
                      >
                        ${(riskSnapshot?.dailyRealizedPnlUsd ?? 0).toFixed(2)} (Loss{' '}
                        {riskSnapshot?.dailyLossPercent ?? 0}% /{' '}
                        {riskSnapshot?.settings?.maxDailyLossPercent ?? 1.5}%)
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Auto-Execute</span>
                      <span
                        className={
                          riskSnapshot?.settings?.autoExecuteConfirmedSignals
                            ? 'text-[#0ECB81] font-semibold'
                            : 'text-[#8B949E]'
                        }
                      >
                        {riskSnapshot?.settings?.autoExecuteConfirmedSignals ? 'ON' : 'MANUAL'}
                      </span>
                    </div>
                  </div>

                  {riskSnapshot?.lockReasons && riskSnapshot.lockReasons.length > 0 && (
                    <div className="border border-[#F6465D]/40 bg-[#F6465D]/10 px-2.5 py-1.5 text-[11px] text-[#F6465D]">
                      {riskSnapshot.lockReasons.join(' · ')}
                    </div>
                  )}
                </div>

                {/* Risk & Auto-Execute Configuration + Account Reset */}
                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-[#E6EDF3]">
                      Paper Account & Auto-Execution Controls
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowSettingsForm((s) => !s)}
                        className="border border-[#2B3548] bg-[#12161F] px-2.5 py-1 text-[11px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer"
                      >
                        {showSettingsForm ? 'Hide Settings' : 'Edit Risk Settings'}
                      </button>
                      {!confirmReset ? (
                        <button
                          type="button"
                          onClick={() => setConfirmReset(true)}
                          className="flex items-center gap-1 border border-[#F59E0B]/50 bg-[#F59E0B]/10 px-2.5 py-1 text-[11px] text-[#F59E0B] hover:bg-[#F59E0B]/20 cursor-pointer"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Reset Account</span>
                        </button>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={resetting}
                            onClick={() => void handleConfirmReset()}
                            className="bg-[#F6465D] px-2.5 py-1 text-[11px] font-semibold text-white cursor-pointer disabled:opacity-50"
                          >
                            {resetting ? 'Resetting...' : 'Confirm Reset'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmReset(false)}
                            className="border border-[#222938] bg-[#12161F] px-2 py-1 text-[11px] text-[#8B949E] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {showSettingsForm ? (
                    <div className="space-y-2.5 border-t border-[#1D2432] pt-2.5">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                        <label className="space-y-1">
                          <span className="text-[#8B949E]">Starting Equity ($)</span>
                          <input
                            type="number"
                            step="100"
                            value={equityInput}
                            onChange={(e) => setEquityInput(e.target.value)}
                            className="w-full border border-[#2B3548] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3] outline-none"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[#8B949E]">Risk / Trade (%)</span>
                          <input
                            type="number"
                            step="0.05"
                            value={riskPerTradeInput}
                            onChange={(e) => setRiskPerTradeInput(e.target.value)}
                            className="w-full border border-[#2B3548] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3] outline-none"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[#8B949E]">Max Daily Loss (%)</span>
                          <input
                            type="number"
                            step="0.25"
                            value={maxDailyLossInput}
                            onChange={(e) => setMaxDailyLossInput(e.target.value)}
                            className="w-full border border-[#2B3548] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3] outline-none"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[#8B949E]">Max Pos / Symbol</span>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={maxInstOpenInput}
                            onChange={(e) => setMaxInstOpenInput(e.target.value)}
                            className="w-full border border-[#2B3548] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3] outline-none"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[#8B949E]">Min Net R:R</span>
                          <input
                            type="number"
                            step="0.1"
                            value={minRrInput}
                            onChange={(e) => setMinRrInput(e.target.value)}
                            className="w-full border border-[#2B3548] bg-[#12161F] px-2 py-1 font-mono text-[#E6EDF3] outline-none"
                          />
                        </label>
                        <label className="flex items-center gap-2 pt-4 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoExecuteInput}
                            onChange={(e) => setAutoExecuteInput(e.target.checked)}
                            className="accent-[#0ECB81]"
                          />
                          <span className="text-[#C9D1D9]">Auto-Paper Confirmed Signals</span>
                        </label>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={savingSettings}
                          onClick={() => void handleSaveSettings()}
                          className="flex items-center gap-1.5 bg-[#0ECB81] px-3 py-1 font-semibold text-slate-950 cursor-pointer disabled:opacity-50"
                        >
                          <Save className="h-3.5 w-3.5" />
                          <span>{savingSettings ? 'Saving...' : 'Save Settings'}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5 text-[11px] text-[#8B949E]">
                      <div>
                        • Live quotes on <span className="font-mono text-[#E6EDF3]">{symbol}</span>:{' '}
                        <span className="font-mono text-[#C9D1D9]">
                          {quote?.bid?.toFixed(getInstrumentMeta(symbol).pricePrecision) ?? '—'} /{' '}
                          {quote?.ask?.toFixed(getInstrumentMeta(symbol).pricePrecision) ?? '—'}
                        </span>{' '}
                        ({provider?.providerName ?? 'Connecting...'})
                      </div>
                      <div>
                        • TP1 takes 50% partial profit and moves Stop Loss to{' '}
                        <span className="text-[#0ECB81]">Breakeven</span> automatically. TP3 or SL closes remaining size & updates Trade Journal.
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Open & Partial Paper Positions */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-[#E6EDF3]">
                    Active Paper Positions ({openPositions.length})
                  </div>
                  <div className="font-mono text-[11px] text-[#8B949E]">
                    Auto-evaluated on every live quote & candle tick
                  </div>
                </div>
                {openPositions.length === 0 ? (
                  <div className="py-5 text-center text-[#8B949E]">
                    No active virtual paper positions. Execute a confirmed signal from Signal Center or enable Auto-Paper Confirmed Signals.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1.5 pr-3">Instrument</th>
                          <th className="py-1.5 pr-3">Side</th>
                          <th className="py-1.5 pr-3">Strategy</th>
                          <th className="py-1.5 pr-3">Vol (Rem/Tot)</th>
                          <th className="py-1.5 pr-3">Entry</th>
                          <th className="py-1.5 pr-3">Live Mark</th>
                          <th className="py-1.5 pr-3">Stop Loss</th>
                          <th className="py-1.5 pr-3">Next TP</th>
                          <th className="py-1.5 pr-3">Unrealized</th>
                          <th className="py-1.5 pr-3">Fees</th>
                          <th className="py-1.5 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {openPositions.map((pos) => {
                          const p = getInstrumentMeta(pos.symbol).pricePrecision;
                          const liveQuote = quotes[pos.symbol];
                          const markPrice =
                            pos.direction === 'BUY'
                              ? (liveQuote?.bid ?? liveQuote?.price ?? pos.currentPrice)
                              : (liveQuote?.ask ?? liveQuote?.price ?? pos.currentPrice);
                          const beMoved = isAtBreakeven(pos);
                          return (
                            <tr key={pos.id}>
                              <td className="py-2 pr-3 font-semibold text-[#E6EDF3]">
                                {pos.symbol} <span className="text-[#8B949E]">{pos.timeframe}</span>
                              </td>
                              <td
                                className={`py-2 pr-3 font-semibold ${
                                  pos.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {pos.direction}
                              </td>
                              <td className="py-2 pr-3 text-[#38BDF8]">{pos.strategyName}</td>
                              <td className="py-2 pr-3">
                                {pos.volumeRemaining}/{pos.volumeTotal}
                              </td>
                              <td className="py-2 pr-3">{pos.entryPrice.toFixed(p)}</td>
                              <td className="py-2 pr-3 text-[#E6EDF3]">{markPrice.toFixed(p)}</td>
                              <td className="py-2 pr-3 text-[#F6465D]">
                                {pos.stopLoss.toFixed(p)}{' '}
                                {beMoved && (
                                  <span className="ml-1 border border-[#0ECB81]/40 bg-[#0ECB81]/10 px-1 text-[10px] text-[#0ECB81]">
                                    BE
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-[#0ECB81]">{getNextTpLabel(pos)}</td>
                              <td
                                className={`py-2 pr-3 font-semibold ${
                                  pos.unrealizedPnlUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {pos.unrealizedPnlUsd >= 0 ? '+' : ''}$
                                {pos.unrealizedPnlUsd.toFixed(2)}
                              </td>
                              <td className="py-2 pr-3 text-[#8B949E]">${pos.feesUsd.toFixed(2)}</td>
                              <td className="py-2 text-right">
                                <button
                                  type="button"
                                  disabled={closingPositionId === pos.id}
                                  onClick={() => void handleClosePosition(pos.id)}
                                  className="border border-[#F6465D]/60 bg-[#F6465D]/15 px-2.5 py-1 text-[11px] font-semibold text-[#F6465D] hover:bg-[#F6465D]/25 cursor-pointer disabled:opacity-50"
                                >
                                  {closingPositionId === pos.id ? 'Closing...' : 'Close Now'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Closed Paper Trades History */}
              <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-[#E6EDF3]">
                    Closed Paper Trades ({closedPositions.length}) · Recorded Orders ({paperOrders.length})
                  </div>
                </div>
                {closedPositions.length === 0 ? (
                  <div className="py-4 text-center text-[#8B949E]">
                    No closed paper trades yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[11px] tabular-nums">
                      <thead className="border-b border-[#222938] text-[#8B949E]">
                        <tr>
                          <th className="py-1.5 pr-3">Instrument</th>
                          <th className="py-1.5 pr-3">Side</th>
                          <th className="py-1.5 pr-3">Strategy</th>
                          <th className="py-1.5 pr-3">Vol</th>
                          <th className="py-1.5 pr-3">Entry</th>
                          <th className="py-1.5 pr-3">Exit</th>
                          <th className="py-1.5 pr-3">Exit Reason</th>
                          <th className="py-1.5 pr-3">Realized ($)</th>
                          <th className="py-1.5 pr-3">Realized R</th>
                          <th className="py-1.5">Closed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                        {closedPositions.map((pos) => {
                          const p = getInstrumentMeta(pos.symbol).pricePrecision;
                          return (
                            <tr key={pos.id}>
                              <td className="py-1.5 pr-3 font-semibold text-[#E6EDF3]">
                                {pos.symbol} {pos.timeframe}
                              </td>
                              <td
                                className={`py-1.5 pr-3 ${
                                  pos.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {pos.direction}
                              </td>
                              <td className="py-1.5 pr-3 text-[#38BDF8]">{pos.strategyName}</td>
                              <td className="py-1.5 pr-3">{pos.volumeTotal}</td>
                              <td className="py-1.5 pr-3">{pos.entryPrice.toFixed(p)}</td>
                              <td className="py-1.5 pr-3">
                                {pos.exitPrice !== null ? pos.exitPrice.toFixed(p) : '—'}
                              </td>
                              <td className="py-1.5 pr-3 text-[#C9D1D9]">{pos.exitReason ?? 'CLOSED'}</td>
                              <td
                                className={`py-1.5 pr-3 font-semibold ${
                                  pos.realizedPnlUsd >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {pos.realizedPnlUsd >= 0 ? '+' : ''}${pos.realizedPnlUsd.toFixed(2)}
                              </td>
                              <td
                                className={`py-1.5 pr-3 font-semibold ${
                                  pos.realizedR >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {pos.realizedR >= 0 ? '+' : ''}
                                {pos.realizedR.toFixed(2)}R
                              </td>
                              <td className="py-1.5 text-[#8B949E]">{fmtTime(pos.closedAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* MT5 Connection Status Banner */}
              <div
                className={`flex flex-wrap items-center justify-between gap-3 border p-4 ${
                  mt5State === 'CONNECTED'
                    ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10'
                    : mt5State === 'STALE'
                      ? 'border-[#F59E0B]/50 bg-[#F59E0B]/10'
                      : 'border-[#F6465D]/40 bg-[#F6465D]/10'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Server
                    className={`h-5 w-5 shrink-0 ${
                      mt5State === 'CONNECTED'
                        ? 'text-[#0ECB81]'
                        : mt5State === 'STALE'
                          ? 'text-[#F59E0B]'
                          : 'text-[#F6465D]'
                    }`}
                  />
                  <div>
                    <div className="font-semibold text-[#E6EDF3]">
                      MetaTrader 5 Bridge Status:{' '}
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
                    <div className="mt-0.5 font-mono text-[11px] text-[#C9D1D9]">
                      Last Heartbeat: {fmtTime(mt5Status?.lastHeartbeat)} · Messages Received:{' '}
                      {mt5Status?.messagesReceived ?? 0} · Last Tick:{' '}
                      {fmtTime(mt5Status?.lastTickAt)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshMt5Status()}
                    className="flex items-center gap-1.5 border border-[#2B3548] bg-[#12161F] px-3 py-1.5 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Refresh</span>
                  </button>
                  <button
                    type="button"
                    disabled={pingLoading}
                    onClick={() => void handleTestBridgePing()}
                    className="flex items-center gap-1.5 border border-[#38BDF8]/60 bg-[#38BDF8]/15 px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/25 cursor-pointer disabled:opacity-50"
                  >
                    <Activity className="h-3.5 w-3.5" />
                    <span>{pingLoading ? 'Checking...' : 'Verify Bridge Endpoint'}</span>
                  </button>
                </div>
              </div>

              {pingResult && (
                <div
                  className={`border p-3 font-mono text-[11px] ${
                    pingResult.ok
                      ? 'border-[#0ECB81]/50 bg-[#0ECB81]/10 text-[#0ECB81]'
                      : 'border-[#F6465D]/50 bg-[#F6465D]/10 text-[#F6465D]'
                  }`}
                >
                  {pingResult.ok ? (
                    <div>
                      Endpoint reachable: <span className="text-[#E6EDF3]">{pingResult.ingestUrl}</span> ·
                      MT5 Allowed URL: <span className="text-[#E6EDF3]">{pingResult.allowedOrigin}</span> ·
                      Bearer Token Required:{' '}
                      <span className="text-[#E6EDF3]">
                        {pingResult.requiresApiToken ? 'YES (TERMINAL_API_TOKEN set)' : 'NO'}
                      </span>
                    </div>
                  ) : (
                    <div>Endpoint check failed: {pingResult.error}</div>
                  )}
                </div>
              )}

              {/* MT5 Account Telemetry & Feed Status */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                  <div className="font-semibold text-[#E6EDF3]">MT5 Account Telemetry</div>
                  <div className="space-y-1 font-mono text-xs tabular-nums text-[#C9D1D9]">
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Broker / Server</span>
                      <span>
                        {mt5Status?.broker || '—'} {mt5Status?.server ? `(${mt5Status.server})` : ''}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Account Login</span>
                      <span>{mt5Status?.accountNumber || '—'}</span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Balance / Equity</span>
                      <span className="text-[#E6EDF3]">
                        {mt5Status?.balance !== undefined
                          ? `${mt5Status.balance.toFixed(2)} / ${mt5Status.equity?.toFixed(2) ?? '—'} ${mt5Status.currency ?? ''}`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Margin / Free Margin</span>
                      <span>
                        {mt5Status?.margin !== undefined
                          ? `${mt5Status.margin.toFixed(2)} / ${mt5Status.freeMargin?.toFixed(2) ?? '—'}`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-[#8B949E]">Leverage / Bridge Build</span>
                      <span>
                        {mt5Status?.leverage ? `1:${mt5Status.leverage}` : '—'} ·{' '}
                        {mt5Status?.terminalVersion || '—'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                  <div className="font-semibold text-[#E6EDF3]">Terminal Market Data Feed ({symbol})</div>
                  <div className="space-y-1 font-mono text-xs tabular-nums text-[#C9D1D9]">
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Active Feed Provider</span>
                      <span className="text-[#38BDF8]">{provider?.providerName ?? 'Connecting...'}</span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Feed Connection</span>
                      <span
                        className={
                          provider?.connectionStatus === 'CONNECTED'
                            ? 'text-[#0ECB81]'
                            : 'text-[#F59E0B]'
                        }
                      >
                        {provider?.connectionStatus ?? 'CONNECTING'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Bid / Ask</span>
                      <span>
                        {quote?.bid?.toFixed(getInstrumentMeta(symbol).pricePrecision) ?? '—'} /{' '}
                        {quote?.ask?.toFixed(getInstrumentMeta(symbol).pricePrecision) ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-[#1D2432] py-1">
                      <span className="text-[#8B949E]">Feed Delay</span>
                      <span>{provider?.feedDelaySeconds ?? 0}s</span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-[#8B949E]">API Token Required</span>
                      <span className={mt5Status?.requiresApiToken ? 'text-[#F59E0B]' : 'text-[#0ECB81]'}>
                        {mt5Status?.requiresApiToken ? 'YES (Set TERMINAL_API_TOKEN)' : 'NO (Open Local Bridge)'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Synced MT5 Ticks & MT5 Open Positions */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                  <div className="font-semibold text-[#E6EDF3]">
                    Synced MT5 Live Ticks ({mt5Status?.syncedTicks?.length ?? 0})
                  </div>
                  {!mt5Status?.syncedTicks || mt5Status.syncedTicks.length === 0 ? (
                    <div className="py-4 text-center text-[#8B949E]">
                      No ticks received from MetaTrader 5 EA yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-[11px] tabular-nums">
                        <thead className="border-b border-[#222938] text-[#8B949E]">
                          <tr>
                            <th className="py-1 pr-3">Symbol</th>
                            <th className="py-1 pr-3">Bid</th>
                            <th className="py-1 pr-3">Ask</th>
                            <th className="py-1">Received</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                          {mt5Status.syncedTicks.map((t) => (
                            <tr key={t.rawSymbol}>
                              <td className="py-1.5 pr-3 text-[#E6EDF3]">
                                {t.rawSymbol}
                                {t.normalizedSymbol && t.normalizedSymbol !== t.rawSymbol && (
                                  <span className="ml-1 text-[#38BDF8]">→ {t.normalizedSymbol}</span>
                                )}
                              </td>
                              <td className="py-1.5 pr-3">{t.bid}</td>
                              <td className="py-1.5 pr-3">{t.ask}</td>
                              <td className="py-1.5 text-[#8B949E]">{fmtTime(t.receivedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="border border-[#222938] bg-[#0B0E14] p-4 space-y-2.5">
                  <div className="font-semibold text-[#E6EDF3]">
                    MT5 Broker Open Positions (Read-Only: {mt5Status?.openPositions?.length ?? 0})
                  </div>
                  {!mt5Status?.openPositions || mt5Status.openPositions.length === 0 ? (
                    <div className="py-4 text-center text-[#8B949E]">
                      No open MT5 positions reported by EA.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-[11px] tabular-nums">
                        <thead className="border-b border-[#222938] text-[#8B949E]">
                          <tr>
                            <th className="py-1 pr-2">Ticket</th>
                            <th className="py-1 pr-2">Symbol</th>
                            <th className="py-1 pr-2">Type</th>
                            <th className="py-1 pr-2">Vol</th>
                            <th className="py-1 pr-2">Open</th>
                            <th className="py-1">Profit</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1D2432] text-[#C9D1D9]">
                          {mt5Status.openPositions.map((p) => (
                            <tr key={p.ticket}>
                              <td className="py-1.5 pr-2 text-[#8B949E]">{p.ticket}</td>
                              <td className="py-1.5 pr-2 text-[#E6EDF3]">{p.symbol}</td>
                              <td
                                className={`py-1.5 pr-2 ${
                                  p.type === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                                }`}
                              >
                                {p.type}
                              </td>
                              <td className="py-1.5 pr-2">{p.volume}</td>
                              <td className="py-1.5 pr-2">{p.openPrice}</td>
                              <td
                                className={`py-1.5 ${
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
              </div>

              {/* Troubleshooting & Setup for WebRequest Error Code -1 */}
              <div className="border border-[#2B3548] bg-[#0B0E14] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-[#38BDF8]" />
                    <span className="font-semibold text-[#E6EDF3]">
                      MT5 EA Setup & Fix for "WebRequest error: code -1"
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={downloadingEa}
                    onClick={() => void handleDownloadEa()}
                    className="flex items-center gap-1.5 bg-[#38BDF8] px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-[#38BDF8]/90 cursor-pointer disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>
                      {downloadingEa ? 'Preparing EA...' : 'Download Configured GoldBtcTerminalBridge.mq5'}
                    </span>
                  </button>
                </div>

                {isCloudRunOrigin && (
                  <div className="border border-[#F59E0B]/50 bg-[#F59E0B]/10 p-2.5 text-[11px] text-[#F59E0B]">
                    Note: You are currently viewing the AI Studio cloud preview (<span className="font-mono">{currentOrigin}</span>). Your Windows MetaTrader 5 terminal cannot reach <span className="font-mono">http://localhost:3000</span> unless you run this app locally on the same Windows PC (<span className="font-mono">npm run dev</span>), and <span className="font-mono">ais-dev-*.run.app</span> URLs are gated by Google authentication cookies. Run this server locally or deploy an un-gated production URL for live Windows MT5 bridging.
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                  <div className="border border-[#222938] bg-[#12161F] p-2.5 space-y-1">
                    <div className="text-[#8B949E]">1. MT5 Whitelist Origin (Tools → Options → Expert Advisors)</div>
                    <div className="flex items-center justify-between gap-2 font-mono text-[#E6EDF3]">
                      <span className="truncate">{currentOrigin}</span>
                      <button
                        type="button"
                        onClick={() => void handleCopy('origin', currentOrigin)}
                        className="flex items-center gap-1 border border-[#2B3548] bg-[#0B0E14] px-2 py-0.5 text-[10px] text-[#38BDF8] shrink-0 cursor-pointer"
                      >
                        {copiedField === 'origin' ? (
                          <Check className="h-3 w-3 text-[#0ECB81]" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        <span>{copiedField === 'origin' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="border border-[#222938] bg-[#12161F] p-2.5 space-y-1">
                    <div className="text-[#8B949E]">2. EA Input (InpServerUrl)</div>
                    <div className="flex items-center justify-between gap-2 font-mono text-[#E6EDF3]">
                      <span className="truncate">{currentIngestUrl}</span>
                      <button
                        type="button"
                        onClick={() => void handleCopy('ingest', currentIngestUrl)}
                        className="flex items-center gap-1 border border-[#2B3548] bg-[#0B0E14] px-2 py-0.5 text-[10px] text-[#38BDF8] shrink-0 cursor-pointer"
                      >
                        {copiedField === 'ingest' ? (
                          <Check className="h-3 w-3 text-[#0ECB81]" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        <span>{copiedField === 'ingest' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>
                </div>

                <ol className="list-decimal list-inside space-y-1 text-[11px] text-[#C9D1D9]">
                  <li>
                    In MetaTrader 5, open <span className="font-mono text-[#E6EDF3]">Tools → Options → Expert Advisors</span>.
                  </li>
                  <li>
                    Check <span className="font-mono text-[#E6EDF3]">Allow WebRequest for listed URL</span> and add{' '}
                    <span className="font-mono text-[#38BDF8]">http://localhost:3000</span> (for local server) or your deployed base origin (fixes MQL5 error <span className="font-mono text-[#F59E0B]">4014</span> / <span className="font-mono text-[#F59E0B]">code -1</span>).
                  </li>
                  <li>
                    Download the updated <span className="font-mono text-[#E6EDF3]">GoldBtcTerminalBridge.mq5</span> above (fixes trailing NUL JSON byte, adds tick throttling & exact error code diagnostics), compile in MetaEditor (<span className="font-mono">F7</span>), and attach to chart with <span className="font-mono">Algo Trading</span> enabled.
                  </li>
                  <li>
                    If you see error <span className="font-mono text-[#F59E0B]">5200 / 5201 / 5203</span> in MT5 Experts tab, the terminal server is not reachable at <span className="font-mono">InpServerUrl</span> — ensure <span className="font-mono">npm run dev</span> is running on port 3000 on that machine or point <span className="font-mono">InpServerUrl</span> to your reachable server.
                  </li>
                </ol>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
