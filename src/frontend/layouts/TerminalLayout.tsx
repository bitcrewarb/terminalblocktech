import { useEffect, useRef, useState } from 'react';
import { BacktestModal } from '../backtest/BacktestModal.tsx';
import { TerminalChart } from '../charts/TerminalChart.tsx';
import { AlertsModal } from '../components/AlertsModal.tsx';
import { ObjectInspectorDrawer } from '../components/ObjectInspectorDrawer.tsx';
import { TerminalHeader } from '../components/TerminalHeader.tsx';
import { StrategyDiscoveryPage } from '../discovery/StrategyDiscoveryPage.tsx';
import { MT5ExecutionModal } from '../execution/MT5ExecutionModal.tsx';
import { PaperRiskControlModal } from '../execution/PaperRiskControlModal.tsx';
import { SimpleAutopilotView } from '../execution/SimpleAutopilotView.tsx';
import { TradeJournalModal } from '../journal/TradeJournalModal.tsx';
import { LiveMarketStrategyPage } from '../live-strategy/LiveMarketStrategyPage.tsx';
import { BottomEventsPanel } from '../panels/BottomEventsPanel.tsx';
import { MarketWatchPanel } from '../panels/MarketWatchPanel.tsx';
import { MtfMatrixModal } from '../panels/MtfMatrixModal.tsx';
import { RightAnalysisSidebar } from '../panels/RightAnalysisSidebar.tsx';
import { SettingsModal } from '../settings/SettingsModal.tsx';
import { SignalCenterModal, type SignalCenterTab } from '../signals/SignalCenterModal.tsx';
import { StrategyManagerDashboard } from '../signals/StrategyManagerDashboard.tsx';
import { TradeSimulatorPage } from '../simulator/TradeSimulatorPage.tsx';
import { useTerminal } from '../state/terminal-context.tsx';

type WorkspaceMode =
  | 'simple'
  | 'strategy-manager'
  | 'terminal'
  | 'discovery'
  | 'live-strategy'
  | 'simulator';
const WORKSPACE_STORAGE_KEY = 'gbt_workspace_mode';

function loadInitialWorkspaceMode(): WorkspaceMode {
  try {
    const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (
      saved === 'simple' ||
      saved === 'strategy-manager' ||
      saved === 'terminal' ||
      saved === 'discovery' ||
      saved === 'live-strategy' ||
      saved === 'simulator'
    ) {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return 'simple';
}

export function TerminalLayout() {
  const { alerts, alertsEnabled, signalNotifications, selectSymbol } = useTerminal();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [signalCenterTab, setSignalCenterTab] = useState<SignalCenterTab>('active');
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [paperRiskOpen, setPaperRiskOpen] = useState(false);
  const [paperRiskTab, setPaperRiskTab] = useState<'paper' | 'mt5'>('paper');
  const [mt5ExecutionOpen, setMt5ExecutionOpen] = useState(false);
  const [mt5ExecutionTab, setMt5ExecutionTab] = useState<'desk' | 'trades' | 'settings' | 'guide'>(
    'desk'
  );
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(loadInitialWorkspaceMode);
  const [mtfOpen, setMtfOpen] = useState(false);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const [dismissedToastId, setDismissedToastId] = useState<string | null>(null);
  const [dismissedSignalToastId, setDismissedSignalToastId] = useState<string | null>(null);

  const openSignalCenter = (tab: SignalCenterTab = 'active') => {
    setSignalCenterTab(tab);
    setSignalsOpen(true);
  };

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceMode);
    } catch {
      // ignore storage errors
    }
  }, [workspaceMode]);

  const toggleAppFullscreen = () => {
    if (!document.fullscreenElement) {
      void rootRef.current?.requestFullscreen?.().then(() => setAppFullscreen(true)).catch(() => {});
    } else {
      void document.exitFullscreen?.().then(() => setAppFullscreen(false)).catch(() => {});
    }
  };

  const latestAlert = alerts[0];
  const showToast =
    latestAlert &&
    (alertsEnabled || latestAlert.id.startsWith('alert:test:')) &&
    latestAlert.id !== dismissedToastId &&
    Date.now() - latestAlert.timestamp < 8000;

  const latestSignalNotif = signalNotifications[0];
  const showSignalToast =
    latestSignalNotif &&
    latestSignalNotif.id !== dismissedSignalToastId &&
    Date.now() - latestSignalNotif.timestamp < 10000;

  return (
    <div
      ref={rootRef}
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#0B0E14] text-[#E6EDF3]"
    >
      <TerminalHeader
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAlerts={() => setAlertsOpen(true)}
        onOpenSignals={() => openSignalCenter('active')}
        onOpenSignalFilters={() => openSignalCenter('strategies')}
        onOpenBacktest={() => setBacktestOpen(true)}
        onOpenJournal={() => setJournalOpen(true)}
        onOpenPaperRisk={() => {
          setPaperRiskTab('paper');
          setPaperRiskOpen(true);
        }}
        onOpenMt5Bridge={() => {
          setPaperRiskTab('mt5');
          setPaperRiskOpen(true);
        }}
        onOpenMt5Execution={() => {
          setMt5ExecutionTab('desk');
          setMt5ExecutionOpen(true);
        }}
        simpleActive={workspaceMode === 'simple'}
        onSelectSimple={() => setWorkspaceMode('simple')}
        strategyManagerActive={workspaceMode === 'strategy-manager'}
        onSelectStrategyManager={() => setWorkspaceMode('strategy-manager')}
        terminalActive={workspaceMode === 'terminal'}
        onSelectTerminal={() => setWorkspaceMode('terminal')}
        discoveryActive={workspaceMode === 'discovery'}
        onToggleDiscovery={() =>
          setWorkspaceMode((m) => (m === 'discovery' ? 'simple' : 'discovery'))
        }
        liveStrategyActive={workspaceMode === 'live-strategy'}
        onToggleLiveStrategy={() =>
          setWorkspaceMode((m) => (m === 'live-strategy' ? 'simple' : 'live-strategy'))
        }
        simulatorActive={workspaceMode === 'simulator'}
        onToggleSimulator={() =>
          setWorkspaceMode((m) => (m === 'simulator' ? 'simple' : 'simulator'))
        }
        isFullscreen={appFullscreen}
        onToggleFullscreen={toggleAppFullscreen}
      />

      {workspaceMode === 'simple' ? (
        <SimpleAutopilotView
          onSwitchToProChart={(sym) => {
            if (sym) selectSymbol(sym);
            setWorkspaceMode('terminal');
          }}
          onOpenSignalCenter={() => openSignalCenter('active')}
          onOpenSignalFilters={() => openSignalCenter('strategies')}
          onOpenStrategyManager={() => setWorkspaceMode('strategy-manager')}
          onOpenDiscovery={() => setWorkspaceMode('discovery')}
          onOpenLiveStrategy={() => setWorkspaceMode('live-strategy')}
          onOpenMt5Modal={(t = 'desk') => {
            setMt5ExecutionTab(t);
            setMt5ExecutionOpen(true);
          }}
        />
      ) : workspaceMode === 'strategy-manager' ? (
        <StrategyManagerDashboard
          variant="page"
          onBackToDesk={() => setWorkspaceMode('simple')}
          onOpenFilterStrategies={() => openSignalCenter('strategies')}
          onOpenMainSignals={() => openSignalCenter('active')}
          onOpenDiscovery={() => setWorkspaceMode('discovery')}
          onOpenLiveStrategy={() => setWorkspaceMode('live-strategy')}
          onSwitchToChart={() => setWorkspaceMode('terminal')}
        />
      ) : workspaceMode === 'discovery' ? (
        <StrategyDiscoveryPage
          onBackToTerminal={() => setWorkspaceMode('terminal')}
          onOpenSignals={() => openSignalCenter('active')}
        />
      ) : workspaceMode === 'live-strategy' ? (
        <LiveMarketStrategyPage
          onBackToTerminal={() => setWorkspaceMode('terminal')}
          onOpenDiscovery={() => setWorkspaceMode('discovery')}
          onOpenSimulator={() => setWorkspaceMode('simulator')}
          onOpenBacktest={() => setBacktestOpen(true)}
        />
      ) : workspaceMode === 'simulator' ? (
        <TradeSimulatorPage
          onBackToTerminal={() => setWorkspaceMode('terminal')}
          onOpenDiscovery={() => setWorkspaceMode('discovery')}
        />
      ) : (
        <>
          {/* Core Institutional Terminal Grid */}
          <div className="flex flex-1 min-h-0 flex-col lg:flex-row overflow-hidden">
        {/* Left Market Watch */}
        {!chartFullscreen && (
          <div className="w-full shrink-0 lg:w-64 xl:w-72 max-h-56 lg:max-h-none overflow-y-auto">
            <MarketWatchPanel
              onOpenMtfModal={() => setMtfOpen(true)}
              onOpenSignalCenter={() => openSignalCenter('active')}
              onOpenBacktest={() => setBacktestOpen(true)}
            />
          </div>
        )}

        {/* Center Chart + Bottom Events */}
        <div className="flex flex-1 min-w-0 min-h-0 flex-col">
          <div className="relative flex flex-1 min-h-[360px] flex-col">
            <TerminalChart
              onOpenSettings={() => setSettingsOpen(true)}
              isFullscreen={chartFullscreen}
              onToggleFullscreen={() => setChartFullscreen((f) => !f)}
            />
            <ObjectInspectorDrawer />

            {showSignalToast && (
              <div
                className={`absolute right-4 top-12 z-30 flex max-w-sm items-start justify-between gap-3 border bg-[#12161F]/95 px-3 py-2 text-xs shadow-xl ${
                  latestSignalNotif.direction === 'BUY'
                    ? 'border-[#0ECB81]/60'
                    : 'border-[#F6465D]/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openSignalCenter('active')}
                  className="text-left cursor-pointer"
                >
                  <div
                    className={`font-semibold ${
                      latestSignalNotif.direction === 'BUY' ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                    }`}
                  >
                    {latestSignalNotif.title}
                  </div>
                  <div className="mt-0.5 text-[#C9D1D9]">{latestSignalNotif.message}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedSignalToastId(latestSignalNotif.id)}
                  className="text-[#8B949E] hover:text-white cursor-pointer"
                >
                  ×
                </button>
              </div>
            )}

            {showToast && !showSignalToast && (
              <div className="absolute right-4 top-12 z-30 flex max-w-sm items-start justify-between gap-3 border border-[#38BDF8]/50 bg-[#12161F]/95 px-3 py-2 text-xs shadow-xl">
                <div>
                  <div className="font-semibold text-[#38BDF8]">{latestAlert.title}</div>
                  <div className="mt-0.5 text-[#C9D1D9]">{latestAlert.message}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setDismissedToastId(latestAlert.id)}
                  className="text-[#8B949E] hover:text-white cursor-pointer"
                >
                  ×
                </button>
              </div>
            )}
          </div>

          {!chartFullscreen && (
            <div className="h-44 shrink-0 lg:h-52">
              <BottomEventsPanel onOpenSignalCenter={() => openSignalCenter('active')} />
            </div>
          )}
        </div>

        {/* Right Signal Config + 11-Section Analysis Sidebar */}
        {!chartFullscreen && (
          <div className="w-full shrink-0 lg:w-80 xl:w-[340px] max-h-72 lg:max-h-none overflow-hidden">
            <RightAnalysisSidebar
              onOpenMtfModal={() => setMtfOpen(true)}
              onOpenSignalCenter={() => openSignalCenter('active')}
            />
          </div>
        )}
          </div>
        </>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {alertsOpen && <AlertsModal onClose={() => setAlertsOpen(false)} />}
      {signalsOpen && (
        <SignalCenterModal initialTab={signalCenterTab} onClose={() => setSignalsOpen(false)} />
      )}
      {backtestOpen && <BacktestModal onClose={() => setBacktestOpen(false)} />}
      {journalOpen && <TradeJournalModal onClose={() => setJournalOpen(false)} />}
      {paperRiskOpen && (
        <PaperRiskControlModal
          initialTab={paperRiskTab}
          onClose={() => setPaperRiskOpen(false)}
        />
      )}
      {mt5ExecutionOpen && (
        <MT5ExecutionModal
          initialTab={mt5ExecutionTab}
          onClose={() => setMt5ExecutionOpen(false)}
        />
      )}
      {mtfOpen && <MtfMatrixModal onClose={() => setMtfOpen(false)} />}
    </div>
  );
}

