import { BellRing, Plus, RotateCcw, Send, Trash2, Volume2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { INSTRUMENTS } from '../../shared/constants/index.ts';
import type { AlertRule, AlertType, InstrumentSymbol, Timeframe } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

const ALERT_TYPE_OPTIONS: { value: AlertType; label: string }[] = [
  { value: 'approaching_support', label: 'Approaching S/R Level' },
  { value: 'touching_resistance', label: 'Touching / Breaking S/R' },
  { value: 'demand_entry', label: 'Demand Zone Entry' },
  { value: 'supply_entry', label: 'Supply Zone Entry' },
  { value: 'bullish_bos', label: 'Bullish BOS' },
  { value: 'bearish_bos', label: 'Bearish BOS' },
  { value: 'bullish_choch', label: 'Bullish CHoCH / MSS' },
  { value: 'bearish_choch', label: 'Bearish CHoCH / MSS' },
  { value: 'liquidity_sweep', label: 'Liquidity Sweep' },
  { value: 'ob_formation', label: 'Order Block Touch / Form' },
  { value: 'fvg_formation', label: 'Fair Value Gap Touch / Form' },
  { value: 'pattern_confirmation', label: 'Pattern Confirmation' },
  { value: 'trendline_breakout', label: 'Trendline Breakout / Retest' },
  { value: 'htf_alignment', label: 'HTF Structure Alignment' },
];

const ALERT_MODAL_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];

export function AlertsModal({ onClose }: { onClose: () => void }) {
  const {
    alerts,
    signalNotifications,
    alertRules,
    alertsEnabled,
    setAlertsEnabled,
    refreshAlerts,
    updateAlertRules,
    resetAlertRules,
    clearAlertHistory,
    triggerTestAlert,
    soundEnabled,
    setSoundEnabled,
    browserAlertsEnabled,
    setBrowserAlertsEnabled,
    timezone,
    symbol,
    timeframe,
  } = useTerminal();

  const [tab, setTab] = useState<'history' | 'signals' | 'rules'>('history');
  const [draftRules, setDraftRules] = useState<AlertRule[]>(() => structuredClone(alertRules));
  const [distanceInputs, setDistanceInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(alertRules.map((r) => [r.id, String(r.distanceThresholdPercent)]))
  );
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showNewRuleForm, setShowNewRuleForm] = useState(false);

  const [newRuleType, setNewRuleType] = useState<AlertType>('approaching_support');
  const [newRuleLabel, setNewRuleLabel] = useState('');
  const [newRuleDistance, setNewRuleDistance] = useState('0.25');
  const [newRuleSymbols, setNewRuleSymbols] = useState<InstrumentSymbol[]>([
    'XAUUSD',
    'XAGUSD',
    'BTCUSDT',
    'ETHUSDT',
  ]);
  const [newRuleTimeframes, setNewRuleTimeframes] = useState<Timeframe[]>([
    '5m',
    '15m',
    '1H',
    '4H',
    '1D',
  ]);

  useEffect(() => {
    void refreshAlerts();
  }, [refreshAlerts]);

  useEffect(() => {
    setDraftRules(structuredClone(alertRules));
    setDistanceInputs(
      Object.fromEntries(alertRules.map((r) => [r.id, String(r.distanceThresholdPercent)]))
    );
  }, [alertRules]);

  const showStatus = (kind: 'success' | 'error', text: string) => {
    setFeedback({ kind, text });
  };

  const commitRules = async (next: AlertRule[], successMsg?: string) => {
    setDraftRules(next);
    const res = await updateAlertRules(next);
    if (!res.ok) {
      showStatus('error', res.error || 'Failed to update alert rules.');
    } else if (successMsg) {
      showStatus('success', successMsg);
    }
  };

  const requestBrowserNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showStatus('error', 'Browser notifications are unavailable in this environment.');
      return;
    }
    if (Notification.permission === 'granted') {
      setBrowserAlertsEnabled(!browserAlertsEnabled);
      return;
    }
    const perm = await Notification.requestPermission();
    setBrowserAlertsEnabled(perm === 'granted');
    if (perm !== 'granted') {
      showStatus('error', 'Browser notification permission was denied.');
    }
  };

  const toggleRuleEnabled = (id: string) => {
    const next = draftRules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    void commitRules(next);
  };

  const toggleRuleSound = (id: string) => {
    const next = draftRules.map((r) =>
      r.id === id ? { ...r, soundEnabled: !r.soundEnabled } : r
    );
    void commitRules(next);
  };

  const toggleRulePush = (id: string) => {
    const next = draftRules.map((r) =>
      r.id === id ? { ...r, browserNotify: !r.browserNotify } : r
    );
    void commitRules(next);
  };

  const toggleSymbol = (ruleId: string, sym: InstrumentSymbol) => {
    const next = draftRules.map((r) => {
      if (r.id !== ruleId) return r;
      const has = r.symbols.includes(sym);
      return {
        ...r,
        symbols: has ? r.symbols.filter((s) => s !== sym) : [...r.symbols, sym],
      };
    });
    void commitRules(next);
  };

  const toggleTimeframe = (ruleId: string, tf: Timeframe) => {
    const next = draftRules.map((r) => {
      if (r.id !== ruleId) return r;
      const has = r.timeframes.includes(tf);
      return {
        ...r,
        timeframes: has ? r.timeframes.filter((t) => t !== tf) : [...r.timeframes, tf],
      };
    });
    void commitRules(next);
  };

  const handleDistanceChange = (ruleId: string, raw: string) => {
    setDistanceInputs((prev) => ({ ...prev, [ruleId]: raw }));
    if (raw.trim() === '') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 5) return;
    const next = draftRules.map((r) =>
      r.id === ruleId ? { ...r, distanceThresholdPercent: parsed } : r
    );
    void commitRules(next);
  };

  const handleDistanceBlur = (ruleId: string) => {
    const raw = (distanceInputs[ruleId] ?? '').trim();
    const current = draftRules.find((r) => r.id === ruleId)?.distanceThresholdPercent ?? 0.25;
    const parsed = Number(raw);
    const clamped =
      raw !== '' && Number.isFinite(parsed)
        ? Math.min(5, Math.max(0.01, Number(parsed.toFixed(2))))
        : current;
    setDistanceInputs((prev) => ({ ...prev, [ruleId]: String(clamped) }));
    if (clamped !== current) {
      const next = draftRules.map((r) =>
        r.id === ruleId ? { ...r, distanceThresholdPercent: clamped } : r
      );
      void commitRules(next);
    }
  };

  const deleteRule = (ruleId: string) => {
    const next = draftRules.filter((r) => r.id !== ruleId);
    void commitRules(next, 'Alert rule deleted.');
  };

  const handleSendTestAlert = async (ruleId?: string) => {
    setBusyAction(ruleId ?? 'test');
    try {
      const res = await triggerTestAlert(ruleId);
      if (res.ok) {
        showStatus('success', `Test alert triggered for ${symbol} ${timeframe}.`);
        if (tab === 'rules' && !ruleId) {
          setTab('history');
        }
      } else {
        showStatus('error', res.error || 'Failed to trigger test alert.');
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetDefaults = async () => {
    setBusyAction('reset');
    try {
      await resetAlertRules();
      showStatus('success', 'Default institutional alert rules restored.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearHistory = async () => {
    setBusyAction('clear');
    try {
      await clearAlertHistory();
      showStatus('success', 'Technical alert history cleared.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateCustomRule = async () => {
    const typeOption = ALERT_TYPE_OPTIONS.find((o) => o.value === newRuleType);
    const label = newRuleLabel.trim() || `${typeOption?.label ?? newRuleType} (Custom)`;
    const distParsed = Number(newRuleDistance);
    const dist =
      Number.isFinite(distParsed) && distParsed > 0
        ? Math.min(5, Math.max(0.01, Number(distParsed.toFixed(2))))
        : 0.25;

    if (newRuleSymbols.length === 0 || newRuleTimeframes.length === 0) {
      showStatus('error', 'Select at least one instrument and one timeframe for the rule.');
      return;
    }

    const customRule: AlertRule = {
      id: `rule:custom:${newRuleType}:${Date.now()}`,
      type: newRuleType,
      label,
      enabled: true,
      symbols: [...newRuleSymbols],
      timeframes: [...newRuleTimeframes],
      distanceThresholdPercent: dist,
      browserNotify: true,
      soundEnabled: true,
    };

    const next = [customRule, ...draftRules];
    await commitRules(next, `Added custom rule "${label}".`);
    setNewRuleLabel('');
    setNewRuleDistance('0.25');
    setShowNewRuleForm(false);
  };

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

  const ruleTypeLabel = (t: AlertType) =>
    ALERT_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col border border-[#2B3548] bg-[#12161F]">
        <div className="flex items-center justify-between border-b border-[#222938] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#E6EDF3]">
              Real-Time Technical Alert Engine
            </h2>
            <p className="text-xs text-[#8B949E]">
              Persistent market structure, zone, liquidity & pattern alert rules separated from BUY/SELL signals
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] bg-[#161B26] px-4 py-2 text-xs">
          <label className="flex items-center gap-2 font-medium text-[#E6EDF3] cursor-pointer">
            <input
              type="checkbox"
              checked={alertsEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                void setAlertsEnabled(next);
                showStatus(
                  'success',
                  next
                    ? 'Real-Time Alert System enabled. Tick rules below to receive live alerts.'
                    : 'Real-Time Alert System turned OFF. No automatic alerts or alert chimes will trigger.'
                );
              }}
              className="accent-[#38BDF8]"
            />
            <span>Enable Real-Time Alert System</span>
          </label>
          <span className="text-[11px] text-[#8B949E]">
            {alertsEnabled
              ? 'Active — monitors ticked rules only'
              : 'OFF by default — silent until you tick above'}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] bg-[#0B0E14] px-4 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setTab('history')}
              className={`px-3 py-1 text-xs font-medium cursor-pointer ${
                tab === 'history' ? 'bg-[#1C2331] text-[#38BDF8]' : 'text-[#8B949E] hover:text-white'
              }`}
            >
              Technical Alerts ({alerts.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('signals')}
              className={`px-3 py-1 text-xs font-medium cursor-pointer ${
                tab === 'signals' ? 'bg-[#1C2331] text-[#0ECB81]' : 'text-[#8B949E] hover:text-white'
              }`}
            >
              Signal Notifications ({signalNotifications.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('rules')}
              className={`px-3 py-1 text-xs font-medium cursor-pointer ${
                tab === 'rules' ? 'bg-[#1C2331] text-[#38BDF8]' : 'text-[#8B949E] hover:text-white'
              }`}
            >
              Alert Rules ({draftRules.filter((r) => r.enabled).length}/{draftRules.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleSendTestAlert()}
              className="flex items-center gap-1.5 border border-[#2B3548] bg-[#161B26] px-2.5 py-1 text-[#E6EDF3] hover:border-[#38BDF8] hover:text-[#38BDF8] cursor-pointer disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              Send Test Alert
            </button>
            <button
              type="button"
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`flex items-center gap-1.5 border px-2.5 py-1 cursor-pointer ${
                soundEnabled
                  ? 'border-[#38BDF8] bg-[#1C2331] text-[#38BDF8]'
                  : 'border-[#222938] text-[#8B949E]'
              }`}
            >
              <Volume2 className="h-3.5 w-3.5" />
              Sound {soundEnabled ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              onClick={() => void requestBrowserNotifications()}
              className={`flex items-center gap-1.5 border px-2.5 py-1 cursor-pointer ${
                browserAlertsEnabled
                  ? 'border-[#0ECB81] bg-[#1C2331] text-[#0ECB81]'
                  : 'border-[#222938] text-[#8B949E]'
              }`}
            >
              <BellRing className="h-3.5 w-3.5" />
              Browser Push {browserAlertsEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        {feedback && (
          <div
            className={`flex items-center justify-between border-b px-4 py-2 text-xs ${
              feedback.kind === 'error'
                ? 'border-[#F6465D]/40 bg-[#F6465D]/10 text-[#F6465D]'
                : 'border-[#0ECB81]/40 bg-[#0ECB81]/10 text-[#0ECB81]'
            }`}
          >
            <span>{feedback.text}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-[11px] underline hover:opacity-80 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'history' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[#8B949E]">
                <span>
                  Showing {alerts.length} recorded alert{alerts.length === 1 ? '' : 's'}
                </span>
                {alerts.length > 0 && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handleClearHistory()}
                    className="flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-[11px] text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear History
                  </button>
                )}
              </div>

              {alerts.length === 0 ? (
                <div className="border border-[#222938] bg-[#0B0E14] py-12 text-center text-xs text-[#8B949E]">
                  No technical alerts triggered yet. Enabled rules monitor S/R zones, Supply/Demand, BOS/CHoCH, Sweeps, OBs, FVGs, and patterns in real time.
                </div>
              ) : (
                <div className="divide-y divide-[#1D2432] border border-[#222938]">
                  {alerts.map((a) => (
                    <div key={a.id} className="flex items-start justify-between gap-4 px-3 py-2 text-xs">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${
                              a.direction === 'bullish'
                                ? 'bg-[#0ECB81]'
                                : a.direction === 'bearish'
                                  ? 'bg-[#F6465D]'
                                  : 'bg-[#38BDF8]'
                            }`}
                          />
                          <span className="font-semibold text-[#E6EDF3]">{a.title}</span>
                          <span className="border border-[#222938] bg-[#0B0E14] px-1.5 py-0.5 font-mono text-[10px] text-[#8B949E]">
                            {a.type}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[#8B949E]">{a.message}</div>
                      </div>
                      <div className="text-right font-mono text-[11px] tabular-nums shrink-0">
                        <div className="text-[#38BDF8]">{a.symbol} · {a.timeframe}</div>
                        <div className="text-[#8B949E]">{fmtTime(a.timestamp)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'signals' ? (
            signalNotifications.length === 0 ? (
              <div className="border border-[#222938] bg-[#0B0E14] py-12 text-center text-xs text-[#8B949E]">
                No BUY/SELL signal notifications recorded in the current session yet.
              </div>
            ) : (
              <div className="divide-y divide-[#1D2432] border border-[#222938]">
                {signalNotifications.map((sn) => (
                  <div key={sn.id} className="flex items-start justify-between gap-4 px-3 py-2 text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono font-semibold ${
                            sn.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                          }`}
                        >
                          {sn.direction}
                        </span>
                        <span className="font-semibold text-[#E6EDF3]">{sn.title}</span>
                        <span className="font-mono text-[11px] text-[#38BDF8]">
                          {sn.score}/100
                        </span>
                        <span className="font-mono text-[11px] text-[#8B949E]">
                          {sn.state}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[#8B949E]">{sn.message}</div>
                    </div>
                    <div className="text-right font-mono text-[11px] tabular-nums shrink-0">
                      <div className="text-[#E6EDF3]">{sn.symbol} · {sn.timeframe}</div>
                      <div className="text-[#8B949E]">{fmtTime(sn.timestamp)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border border-[#222938] bg-[#0B0E14] px-3 py-2 text-xs">
                <div className="text-[#8B949E]">
                  <span className="font-semibold text-[#E6EDF3]">
                    {draftRules.filter((r) => r.enabled).length}
                  </span>{' '}
                  of {draftRules.length} rules active
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void commitRules(
                        draftRules.map((r) => ({ ...r, enabled: true })),
                        'All alert rules enabled.'
                      )
                    }
                    className="border border-[#0ECB81]/50 bg-[#0B0E14] px-2.5 py-1 text-[#0ECB81] hover:bg-[#0ECB81]/10 cursor-pointer"
                  >
                    Enable All
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void commitRules(
                        draftRules.map((r) => ({ ...r, enabled: false })),
                        'All alert rules disabled.'
                      )
                    }
                    className="border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-[#8B949E] hover:text-white cursor-pointer"
                  >
                    Disable All
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowNewRuleForm((v) => !v)}
                    className="flex items-center gap-1 border border-[#38BDF8]/60 bg-[#1C2331] px-2.5 py-1 text-[#38BDF8] hover:bg-[#232D3F] cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New Custom Rule
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handleResetDefaults()}
                    className="flex items-center gap-1 border border-[#222938] bg-[#12161F] px-2.5 py-1 text-[#8B949E] hover:border-[#E6EDF3] hover:text-[#E6EDF3] cursor-pointer disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset Defaults
                  </button>
                </div>
              </div>

              {showNewRuleForm && (
                <div className="border border-[#38BDF8]/40 bg-[#0B0E14] p-3 text-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#38BDF8]">Create Custom Alert Rule</span>
                    <button
                      type="button"
                      onClick={() => setShowNewRuleForm(false)}
                      className="text-[#8B949E] hover:text-white cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] text-[#8B949E]">Condition Type</span>
                      <select
                        value={newRuleType}
                        onChange={(e) => setNewRuleType(e.target.value as AlertType)}
                        className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3]"
                      >
                        {ALERT_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] text-[#8B949E]">Rule Name</span>
                      <input
                        type="text"
                        placeholder="e.g. Gold 5m Liquidity Sweep"
                        value={newRuleLabel}
                        onChange={(e) => setNewRuleLabel(e.target.value)}
                        className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3]"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] text-[#8B949E]">Distance Threshold (%)</span>
                      <input
                        type="number"
                        step={0.05}
                        min={0.01}
                        max={5}
                        value={newRuleDistance}
                        onChange={(e) => setNewRuleDistance(e.target.value)}
                        className="w-full border border-[#222938] bg-[#12161F] px-2 py-1 text-xs text-[#E6EDF3] font-mono"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-[#8B949E] mr-1">Symbols:</span>
                    {INSTRUMENTS.map((inst) => {
                      const active = newRuleSymbols.includes(inst.symbol);
                      return (
                        <button
                          key={inst.symbol}
                          type="button"
                          onClick={() =>
                            setNewRuleSymbols((prev) =>
                              active ? prev.filter((s) => s !== inst.symbol) : [...prev, inst.symbol]
                            )
                          }
                          className={`border px-2 py-0.5 font-mono text-[10px] cursor-pointer ${
                            active
                              ? 'border-[#38BDF8] bg-[#1C2331] text-[#38BDF8]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          {inst.symbol}
                        </button>
                      );
                    })}
                    <span className="mx-1 text-[#222938]">|</span>
                    <span className="text-[11px] text-[#8B949E] mr-1">Timeframes:</span>
                    {ALERT_MODAL_TIMEFRAMES.map((tf) => {
                      const active = newRuleTimeframes.includes(tf);
                      return (
                        <button
                          key={tf}
                          type="button"
                          onClick={() =>
                            setNewRuleTimeframes((prev) =>
                              active ? prev.filter((t) => t !== tf) : [...prev, tf]
                            )
                          }
                          className={`border px-1.5 py-0.5 font-mono text-[10px] cursor-pointer ${
                            active
                              ? 'border-[#0ECB81] bg-[#1C2331] text-[#0ECB81]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          {tf}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void handleCreateCustomRule()}
                      className="border border-[#0ECB81] bg-[#0ECB81]/15 px-3 py-1 font-medium text-[#0ECB81] hover:bg-[#0ECB81]/25 cursor-pointer"
                    >
                      Save Custom Rule
                    </button>
                  </div>
                </div>
              )}

              {draftRules.length === 0 ? (
                <div className="border border-[#222938] bg-[#0B0E14] py-10 text-center text-xs text-[#8B949E]">
                  No alert rules configured. Click <span className="text-[#E6EDF3]">Reset Defaults</span> or <span className="text-[#38BDF8]">New Custom Rule</span> to start monitoring.
                </div>
              ) : (
                draftRules.map((rule) => (
                  <div key={rule.id} className="border border-[#222938] bg-[#0B0E14] p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 font-medium text-[#E6EDF3] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={() => toggleRuleEnabled(rule.id)}
                          className="accent-[#38BDF8]"
                        />
                        <span>{rule.label}</span>
                        <span className="border border-[#222938] bg-[#12161F] px-1.5 py-0.5 font-mono text-[10px] text-[#8B949E]">
                          {ruleTypeLabel(rule.type)}
                        </span>
                      </label>

                      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#8B949E]">
                        <button
                          type="button"
                          onClick={() => toggleRuleSound(rule.id)}
                          title="Toggle sound for this rule"
                          className={`border px-1.5 py-0.5 text-[10px] cursor-pointer ${
                            rule.soundEnabled
                              ? 'border-[#38BDF8]/60 bg-[#1C2331] text-[#38BDF8]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          Sound {rule.soundEnabled ? 'On' : 'Off'}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleRulePush(rule.id)}
                          title="Toggle browser push for this rule"
                          className={`border px-1.5 py-0.5 text-[10px] cursor-pointer ${
                            rule.browserNotify
                              ? 'border-[#0ECB81]/60 bg-[#1C2331] text-[#0ECB81]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          Push {rule.browserNotify ? 'On' : 'Off'}
                        </button>
                        <span>Dist %</span>
                        <input
                          type="number"
                          step={0.05}
                          min={0.01}
                          max={5.0}
                          value={distanceInputs[rule.id] ?? String(rule.distanceThresholdPercent)}
                          onChange={(e) => handleDistanceChange(rule.id, e.target.value)}
                          onBlur={() => handleDistanceBlur(rule.id)}
                          className="w-16 border border-[#222938] bg-[#12161F] px-1.5 py-0.5 text-right text-[#E6EDF3]"
                        />
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void handleSendTestAlert(rule.id)}
                          title="Trigger test alert for this rule"
                          className="border border-[#222938] bg-[#12161F] px-1.5 py-0.5 text-[10px] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#38BDF8] cursor-pointer disabled:opacity-50"
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRule(rule.id)}
                          title="Delete alert rule"
                          className="border border-[#222938] bg-[#12161F] p-1 text-[#8B949E] hover:border-[#F6465D] hover:text-[#F6465D] cursor-pointer"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {INSTRUMENTS.map((inst) => (
                        <button
                          key={inst.symbol}
                          type="button"
                          onClick={() => toggleSymbol(rule.id, inst.symbol)}
                          className={`border px-2 py-0.5 font-mono text-[10px] cursor-pointer ${
                            rule.symbols.includes(inst.symbol)
                              ? 'border-[#38BDF8] bg-[#1C2331] text-[#38BDF8]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          {inst.symbol}
                        </button>
                      ))}
                      <span className="mx-1 text-[#222938]">|</span>
                      {ALERT_MODAL_TIMEFRAMES.map((tf) => (
                        <button
                          key={tf}
                          type="button"
                          onClick={() => toggleTimeframe(rule.id, tf)}
                          className={`border px-1.5 py-0.5 font-mono text-[10px] cursor-pointer ${
                            rule.timeframes.includes(tf)
                              ? 'border-[#0ECB81] bg-[#1C2331] text-[#0ECB81]'
                              : 'border-[#222938] text-[#6E7681]'
                          }`}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
