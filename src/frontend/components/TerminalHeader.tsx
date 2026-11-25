import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Calculator,
  CandlestickChart,
  ChevronDown,
  Compass,
  Filter,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Maximize2,
  Minimize2,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COMMON_TIMEZONES, getInstrumentMeta } from '../../shared/constants/index.ts';
import { useAuth } from '../state/auth-context.tsx';
import { useTerminal } from '../state/terminal-context.tsx';

export function TerminalHeader({
  onOpenSettings,
  onOpenAlerts,
  onOpenSignals,
  onOpenSignalFilters,
  onOpenBacktest,
  onOpenJournal,
  onOpenPaperRisk,
  onOpenMt5Bridge: _onOpenMt5Bridge,
  onOpenMt5Execution,
  simpleActive = false,
  onSelectSimple,
  strategyManagerActive = false,
  onSelectStrategyManager,
  terminalActive = true,
  onSelectTerminal,
  discoveryActive,
  onToggleDiscovery,
  liveStrategyActive,
  onToggleLiveStrategy,
  simulatorActive,
  onToggleSimulator,
  isFullscreen,
  onToggleFullscreen,
}: {
  onOpenSettings: () => void;
  onOpenAlerts: () => void;
  onOpenSignals: () => void;
  onOpenSignalFilters?: () => void;
  onOpenBacktest: () => void;
  onOpenJournal: () => void;
  onOpenPaperRisk: () => void;
  onOpenMt5Bridge?: () => void;
  onOpenMt5Execution: () => void;
  simpleActive?: boolean;
  onSelectSimple?: () => void;
  strategyManagerActive?: boolean;
  onSelectStrategyManager?: () => void;
  terminalActive?: boolean;
  onSelectTerminal?: () => void;
  discoveryActive: boolean;
  onToggleDiscovery: () => void;
  liveStrategyActive: boolean;
  onToggleLiveStrategy: () => void;
  simulatorActive: boolean;
  onToggleSimulator: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { user, logout } = useAuth();
  const {
    symbol,
    quotes,
    providers,
    timezone,
    setTimezone,
    soundEnabled,
    setSoundEnabled,
    alerts,
    alertsEnabled,
    signals,
    liveStrategyBasket,
    socketConnected,
    mt5Status,
    mt5ExecutionSettings,
    mt5ManagedTrades,
    paperPositions,
  } = useTerminal();

  const [now, setNow] = useState(() => Date.now());
  const [strategyLabOpen, setStrategyLabOpen] = useState(false);
  const strategyLabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!strategyLabOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (strategyLabRef.current && !strategyLabRef.current.contains(e.target as Node)) {
        setStrategyLabOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStrategyLabOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [strategyLabOpen]);

  const meta = getInstrumentMeta(symbol);
  const quote = quotes[symbol];
  const provider = providers[symbol];

  const timeFormatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(now));

  const pct = quote?.changePercent24h ?? 0;
  const pctPositive = pct >= 0;
  const conn = quote?.connectionStatus ?? provider?.connectionStatus ?? 'CONNECTING';
  const openSignalCount = signals.filter(
    (s) => !['TP3_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'CANCELLED'].includes(s.state)
  ).length;
  const armedStrategyCount = liveStrategyBasket?.enabled
    ? liveStrategyBasket.strategies.length
    : 0;
  const openPaperCount = paperPositions.filter(
    (p) => p.status === 'OPEN' || p.status === 'PARTIAL'
  ).length;
  const openMt5Count = mt5ManagedTrades.filter(
    (t) => t.status === 'QUEUED' || t.status === 'OPEN' || t.status === 'PARTIAL'
  ).length;
  const mt5ExecBadge =
    mt5ExecutionSettings?.enabled && mt5ExecutionSettings?.autoExecuteSignals
      ? 'AUTO'
      : mt5ExecutionSettings?.enabled
        ? 'ARMED'
        : 'OFF';
  const mt5State = mt5Status?.statusLabel ?? 'DISCONNECTED';

  const strategyLabActive = discoveryActive || liveStrategyActive || simulatorActive;
  const strategyLabLabel = liveStrategyActive
    ? 'Live Strategy'
    : discoveryActive
      ? 'Discovery'
      : simulatorActive
        ? 'Simulator'
        : 'Strategy Lab';

  return (
    <header className="w-full shrink-0 border-b border-[#222938] bg-[#12161F]">
      {/* Row 1: Branding, Live Quote Telemetry, Feed Status, Clock & Always-Visible Logout */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-[#1A202C] px-3 py-1.5">
        {/* Left Telemetry */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <div className="text-xs sm:text-sm font-bold tracking-tight text-[#E6EDF3] whitespace-nowrap shrink-0">
            GOLD BTC TERMINAL
          </div>

          <div className="hidden sm:block h-3.5 w-px bg-[#222938]" />

          <div className="flex items-center gap-2.5 min-w-0">
            <div className="whitespace-nowrap shrink-0">
              <span className="font-mono text-xs sm:text-sm font-semibold text-[#E6EDF3]">
                {symbol}
              </span>
              <span className="ml-1.5 hidden md:inline text-xs text-[#8B949E]">{meta.name}</span>
            </div>

            <div className="flex items-baseline gap-2 font-mono tabular-nums whitespace-nowrap shrink-0">
              <span className="text-sm sm:text-base font-semibold text-[#E6EDF3]">
                {quote && quote.price > 0 ? quote.price.toFixed(meta.pricePrecision) : '—'}
              </span>
              {quote && quote.price > 0 && (
                <span
                  className={`text-xs font-medium ${pctPositive ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}
                >
                  {pctPositive ? '+' : ''}
                  {pct.toFixed(2)}%
                </span>
              )}
            </div>

            {quote?.bid !== undefined && quote?.ask !== undefined && (
              <div className="hidden xl:flex items-center gap-1.5 font-mono text-[11px] text-[#8B949E] tabular-nums whitespace-nowrap shrink-0">
                <span>
                  B <span className="text-[#C9D1D9]">{quote.bid.toFixed(meta.pricePrecision)}</span>
                </span>
                <span aria-hidden="true">/</span>
                <span>
                  A <span className="text-[#C9D1D9]">{quote.ask.toFixed(meta.pricePrecision)}</span>
                </span>
              </div>
            )}
          </div>

          <div className="hidden md:block h-3.5 w-px bg-[#222938]" />

          {/* Provider Feed Telemetry */}
          <div className="hidden md:flex items-center gap-2 text-[11px] text-[#8B949E] whitespace-nowrap shrink-0">
            <span className="text-[#C9D1D9]">{provider?.providerName ?? 'Connecting...'}</span>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5 font-mono">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  conn === 'CONNECTED' && socketConnected
                    ? 'bg-[#0ECB81]'
                    : conn === 'CREDENTIALS_REQUIRED' || conn === 'DELAYED' || conn === 'RECONNECTING'
                      ? 'bg-[#F59E0B]'
                      : 'bg-[#F6465D]'
                }`}
              />
              <span
                className={
                  conn === 'CONNECTED'
                    ? 'text-[#0ECB81]'
                    : conn === 'CREDENTIALS_REQUIRED'
                      ? 'text-[#F59E0B]'
                      : 'text-[#C9D1D9]'
                }
              >
                {conn}
              </span>
            </span>
            {(provider?.feedDelaySeconds ?? 0) > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[#F59E0B] tabular-nums">
                  {provider?.feedDelaySeconds}s delay
                </span>
              </>
            )}
          </div>
        </div>

        {/* Right Utility & Account Bar */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5 shrink-0">
          <div className="flex items-center border border-[#222938] bg-[#0B0E14] px-2 py-0.5 font-mono text-[11px] text-[#C9D1D9] tabular-nums">
            <span>{timeFormatted}</span>
            <select
              aria-label="Timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="ml-1.5 bg-transparent text-[#38BDF8] outline-none cursor-pointer"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id} className="bg-[#12161F] text-[#E6EDF3]">
                  {tz.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            title={soundEnabled ? 'Mute Alert Sound' : 'Enable Alert Sound'}
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-[#38BDF8]" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={onToggleFullscreen}
            title="Toggle Terminal Fullscreen"
            className="border border-[#222938] bg-[#0B0E14] p-1 text-[#8B949E] hover:text-[#E6EDF3] cursor-pointer"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>

          <div className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] pl-2 pr-1 py-0.5">
            {user?.email && (
              <span
                className="hidden sm:inline max-w-[160px] truncate font-mono text-[11px] text-[#8B949E]"
                title={user.email}
              >
                {user.email}
              </span>
            )}
            <button
              type="button"
              onClick={() => void logout()}
              title={user?.email ? `Sign out (${user.email})` : 'Logout'}
              aria-label="Logout"
              className="flex items-center gap-1 border border-[#F6465D]/50 bg-[#F6465D]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#F6465D] hover:border-[#F6465D] hover:bg-[#F6465D]/25 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="h-3 w-3" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>

      {/* Row 2: Guided Workflow Navigation & Execution Controls */}
      <nav
        aria-label="Main terminal navigation"
        className="flex flex-wrap items-center justify-between gap-2 bg-[#0F131B] px-3 py-1.5"
      >
        {/* Left: Workspace Switcher + 1. Filter Strategies -> 2. Main Signals + Strategy Lab */}
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <div className="flex items-center border border-[#222938] bg-[#0B0E14]">
            {onSelectSimple && (
              <button
                type="button"
                onClick={onSelectSimple}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
                  simpleActive
                    ? 'bg-[#0ECB81]/15 text-[#0ECB81] font-semibold'
                    : 'text-[#C9D1D9] hover:text-[#0ECB81]'
                }`}
              >
                <LayoutDashboard className="h-3.5 w-3.5 text-[#0ECB81]" />
                <span>Desk</span>
              </button>
            )}
            {onSelectSimple && onSelectStrategyManager && (
              <div className="h-4 w-px bg-[#222938]" />
            )}
            {onSelectStrategyManager && (
              <button
                type="button"
                onClick={onSelectStrategyManager}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
                  strategyManagerActive
                    ? 'bg-[#161B26] text-[#0ECB81] font-semibold'
                    : 'text-[#C9D1D9] hover:text-[#0ECB81]'
                }`}
              >
                <ShieldCheck className="h-3.5 w-3.5 text-[#0ECB81]" />
                <span>Strategy Manager</span>
                <span className="font-mono text-[11px] tabular-nums">({armedStrategyCount})</span>
              </button>
            )}
            {(onSelectSimple || onSelectStrategyManager) && onSelectTerminal && (
              <div className="h-4 w-px bg-[#222938]" />
            )}
            {onSelectTerminal && (
              <button
                type="button"
                onClick={onSelectTerminal}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
                  terminalActive
                    ? 'bg-[#161B26] text-[#38BDF8] font-semibold'
                    : 'text-[#C9D1D9] hover:text-[#38BDF8]'
                }`}
              >
                <CandlestickChart className="h-3.5 w-3.5 text-[#38BDF8]" />
                <span>Pro Chart</span>
              </button>
            )}
          </div>

          {onOpenSignalFilters && (
            <button
              type="button"
              onClick={onOpenSignalFilters}
              title="Filter and add winning strategies directly into Main Signals"
              className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
                armedStrategyCount > 0
                  ? 'border-[#38BDF8]/60 bg-[#38BDF8]/10 text-[#38BDF8] hover:border-[#38BDF8]'
                  : 'border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B] hover:border-[#F59E0B]'
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              <span>1. Filter Strategies</span>
              <span className="font-mono tabular-nums">({armedStrategyCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenSignals}
            title="View live Main Signals generated by your armed strategies"
            className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
              openSignalCount > 0
                ? 'border-[#0ECB81]/60 bg-[#1C2331] text-[#0ECB81] hover:border-[#0ECB81]'
                : 'border-[#222938] bg-[#0B0E14] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>{onOpenSignalFilters ? '2. Main Signals' : 'Signals'}</span>
            <span className="font-mono tabular-nums">{openSignalCount}</span>
          </button>

          {/* Grouped Research & Testing Menu */}
          <div className="relative" ref={strategyLabRef}>
            <button
              type="button"
              onClick={() => setStrategyLabOpen((o) => !o)}
              aria-expanded={strategyLabOpen}
              className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
                strategyLabActive
                  ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8] font-semibold'
                  : 'border-[#222938] bg-[#0B0E14] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#38BDF8]'
              }`}
            >
              <FlaskConical className="h-3.5 w-3.5 text-[#38BDF8]" />
              <span>{strategyLabLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-80" />
            </button>

            {strategyLabOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 w-64 border border-[#2B3548] bg-[#12161F] shadow-xl py-1">
                <button
                  type="button"
                  onClick={() => {
                    setStrategyLabOpen(false);
                    onToggleDiscovery();
                  }}
                  className={`w-full flex items-start justify-between gap-2 px-3 py-2 text-xs text-left hover:bg-[#1A202C] cursor-pointer ${
                    discoveryActive ? 'text-[#38BDF8]' : 'text-[#E6EDF3]'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <Compass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#38BDF8]" />
                    <span>
                      <span className="block font-medium">Discovery Scanner</span>
                      <span className="block text-[10px] text-[#8B949E]">
                        Backtest & filter winning winners
                      </span>
                    </span>
                  </span>
                  {discoveryActive && <span className="font-mono text-[10px]">ACTIVE</span>}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStrategyLabOpen(false);
                    onToggleLiveStrategy();
                  }}
                  className={`w-full flex items-start justify-between gap-2 px-3 py-2 text-xs text-left hover:bg-[#1A202C] cursor-pointer ${
                    liveStrategyActive ? 'text-[#0ECB81]' : 'text-[#E6EDF3]'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0ECB81]" />
                    <span>
                      <span className="block font-medium">Live Market Strategy</span>
                      <span className="block text-[10px] text-[#8B949E]">
                        Match setups to current regime
                      </span>
                    </span>
                  </span>
                  {liveStrategyActive && <span className="font-mono text-[10px]">ACTIVE</span>}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStrategyLabOpen(false);
                    onOpenBacktest();
                  }}
                  className="w-full flex items-start gap-2 px-3 py-2 text-xs text-left text-[#E6EDF3] hover:bg-[#1A202C] cursor-pointer"
                >
                  <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#38BDF8]" />
                  <span>
                    <span className="block font-medium">Backtest Engine</span>
                    <span className="block text-[10px] text-[#8B949E]">
                      Test custom historical runs
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStrategyLabOpen(false);
                    onToggleSimulator();
                  }}
                  className={`w-full flex items-start justify-between gap-2 px-3 py-2 text-xs text-left hover:bg-[#1A202C] cursor-pointer ${
                    simulatorActive ? 'text-[#0ECB81]' : 'text-[#E6EDF3]'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <Calculator className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0ECB81]" />
                    <span>
                      <span className="block font-medium">Trade Simulator</span>
                      <span className="block text-[10px] text-[#8B949E]">
                        Risk, lot size & profit planner
                      </span>
                    </span>
                  </span>
                  {simulatorActive && <span className="font-mono text-[10px]">ACTIVE</span>}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Execution, Risk, Journal & System Controls */}
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={onOpenMt5Execution}
            title="MT5 Bridge Status, Auto-Trade Rules & Active Positions"
            className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
              mt5ExecutionSettings?.enabled
                ? 'border-[#38BDF8]/70 bg-[#38BDF8]/15 text-[#38BDF8] hover:border-[#38BDF8]'
                : 'border-[#222938] bg-[#0B0E14] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#38BDF8]'
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
            <Bot className="h-3.5 w-3.5 text-[#38BDF8]" />
            <span>MT5</span>
            <span className="font-mono text-[10px] text-[#8B949E]">
              {mt5State === 'CONNECTED' ? 'LIVE' : mt5State === 'STALE' ? 'STALE' : 'OFFLINE'}
            </span>
            <span
              className={`border px-1 py-0 text-[10px] font-mono ${
                mt5ExecBadge === 'AUTO'
                  ? 'border-[#0ECB81]/50 bg-[#0ECB81]/15 text-[#0ECB81]'
                  : mt5ExecBadge === 'ARMED'
                    ? 'border-[#38BDF8]/50 bg-[#38BDF8]/15 text-[#38BDF8]'
                    : 'border-[#222938] text-[#8B949E]'
              }`}
            >
              {mt5ExecBadge}
            </span>
            {openMt5Count > 0 && (
              <span className="font-mono tabular-nums">({openMt5Count})</span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenPaperRisk}
            className="flex items-center gap-1.5 border border-[#0ECB81]/40 bg-[#0ECB81]/10 px-2.5 py-1 text-xs text-[#0ECB81] hover:border-[#0ECB81] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Zap className="h-3.5 w-3.5" />
            <span>Paper & Risk</span>
            {openPaperCount > 0 && (
              <span className="font-mono tabular-nums">({openPaperCount})</span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenJournal}
            className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <BookOpen className="h-3.5 w-3.5 text-[#38BDF8]" />
            <span>Journal</span>
          </button>

          <button
            type="button"
            onClick={onOpenAlerts}
            title={
              alertsEnabled
                ? 'Real-Time Alerts Active — click to manage rules'
                : 'Alerts OFF by default — click to tick & enable alerts'
            }
            className={`flex items-center gap-1.5 border px-2.5 py-1 text-xs whitespace-nowrap shrink-0 cursor-pointer ${
              alertsEnabled
                ? 'border-[#38BDF8]/60 bg-[#38BDF8]/10 text-[#38BDF8] hover:border-[#38BDF8]'
                : 'border-[#222938] bg-[#0B0E14] text-[#8B949E] hover:border-[#38BDF8] hover:text-white'
            }`}
          >
            <Bell className="h-3.5 w-3.5" />
            <span>{alertsEnabled ? 'Alerts' : 'Alerts OFF'}</span>
            {alertsEnabled && (
              <span className="font-mono tabular-nums">{alerts.length}</span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-2.5 py-1 text-xs text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Settings</span>
          </button>
        </div>
      </nav>
    </header>
  );
}
