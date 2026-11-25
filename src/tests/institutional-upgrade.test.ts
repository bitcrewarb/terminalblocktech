import { describe, it, expect, beforeEach } from 'vitest';
import { PlatformSqliteStore } from '../storage/platform-db.ts';
import { CentralizedRiskEngine, type PersistedRiskState } from '../risk/engine.ts';
import { ExecutionGateway } from '../execution/gateway.ts';
import { MT5ExecutionAdapter } from '../execution/mt5-adapter.ts';
import { evaluateMarketDataIntegrity } from '../market-data/integrity/index.ts';
import { calibrateSignalStrategyPerformance } from '../signals/calibration/index.ts';
import { computeSignalPerformance } from '../signals/performance/index.ts';
import { SignalEngine } from '../signals/engine.ts';
import { computeWalkForwardFolds } from '../backtest/discovery/engine.ts';
import { DEFAULT_RISK_SETTINGS } from '../shared/constants/index.ts';
import { TradeJournalService } from '../journal/service.ts';
import type { BacktestTradeRecord, TradingSignal, PaperPosition } from '../shared/types/index.ts';

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: 'sig:test:1',
    symbol: 'XAUUSD',
    entryTimeframe: '5m',
    setupTimeframe: '15m',
    direction: 'BUY',
    state: 'CONFIRMED',
    provisional: false,
    score: 85,
    classification: 'Strong',
    scoreBreakdown: {} as any,
    htfBias: {} as any,
    entryPrice: 2000,
    entryZone: { lower: 1998, upper: 2000 },
    stopLoss: 1990,
    invalidationLevel: 1988,
    atrBuffer: 2,
    takeProfits: [{ level: 1, price: 2020, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null }],
    primaryRR: 2.0,
    maxRR: 2.0,
    confluenceReasons: ['Test confluence'],
    timeframeSummary: 'Test',
    strategyId: 'smc_bos_retest',
    strategyName: 'BOS Retest',
    strategyVersion: 'v1.0',
    createdAt: Date.now(),
    confirmedAt: Date.now(),
    activatedAt: null,
    closedAt: null,
    candleTime: Date.now(),
    realizedR: null,
    highestFavorableR: 0,
    maxAdverseR: 0,
    timeline: [],
    ...overrides,
  };
}

describe('Institutional Terminal Upgrade Tests', () => {
  let platformStore: PlatformSqliteStore;
  let riskEngine: CentralizedRiskEngine;
  let journalService: TradeJournalService;

  beforeEach(() => {
    platformStore = new PlatformSqliteStore(':memory:');
    riskEngine = new CentralizedRiskEngine(DEFAULT_RISK_SETTINGS);
    journalService = new TradeJournalService(platformStore);
  });

  it('evaluates market data integrity correctly and blocks when stale or invalid', () => {
    const report = evaluateMarketDataIntegrity(
      'XAUUSD',
      '5m',
      [],
      null,
      {
        symbol: 'XAUUSD',
        assetClass: 'METALS',
        providerName: 'TestFeed',
        hasHistoricalCredentials: true,
        hasStreamingFeed: true,
        connectionStatus: 'ERROR',
        lastUpdateTime: Date.now(),
        feedDelaySeconds: 45,
      },
      DEFAULT_SIGNAL_SETTINGS_MOCK(),
      Date.now()
    );

    expect(report.healthy).toBe(false);
    expect(report.blocked).toBe(true);
    expect(report.anomalies.length).toBeGreaterThan(0);
  });

  it('enforces centralized risk rules, kill switch, and instrument-specific lot sizing', () => {
    const signal = makeSignal();
    const approval = riskEngine.evaluateTradeRisk({
      signal,
      openPositions: [],
    });

    expect(approval.approved).toBe(true);
    expect(approval.calculatedVolume).toBeGreaterThan(0);
    expect(approval.riskAmountUsd).toBe(25); // 0.25% of $10,000 equity

    // Emergency kill switch must immediately block all new trade approvals
    riskEngine.engageKillSwitch('Abnormal volatility test');
    const blocked = riskEngine.evaluateTradeRisk({
      signal,
      openPositions: [],
    });
    expect(blocked.approved).toBe(false);
    expect(blocked.rejectionReasons[0]).toContain('Emergency Kill Switch');
  });

  it('locks live MT5 execution permanently in paper mode and rejects duplicate idempotency instructions', () => {
    const mt5 = new MT5ExecutionAdapter();
    expect(mt5.liveOrderExecutionDisabled).toBe(true);
    expect(mt5.isPaperOnly).toBe(true);

    const gateway = new ExecutionGateway(riskEngine);
    const sig = makeSignal();

    const liveAttempt = gateway.executeSignal(sig, 2000, 'MT5');
    expect(liveAttempt.success).toBe(false);
    expect(liveAttempt.rejectionReason).toContain('LIVE EXECUTION LOCKED');

    const paperAttempt = gateway.executeSignal(sig, 2000, 'PAPER');
    expect(paperAttempt.success).toBe(true);
    expect(paperAttempt.order?.status).toBe('FILLED');
    expect(paperAttempt.position?.status).toBe('OPEN');

    // Second execution on the exact same signal/instrument must fail risk/max open positions check
    const duplicateAttempt = gateway.executeSignal(sig, 2000, 'PAPER');
    expect(duplicateAttempt.success).toBe(false);
  });

  it('never counts an open TP1_HIT trade as a final closed winner in signal performance', () => {
    const openTp1Signal = makeSignal({
      id: 'sig:open:tp1',
      state: 'TP1_HIT',
      activatedAt: Date.now() - 10_000,
      closedAt: null,
      realizedR: 0.7,
      takeProfits: [{ level: 1, price: 2020, riskReward: 2.0, sourceLabel: 'TP1', hit: true, hitTime: Date.now() }],
    });
    const closedLossSignal = makeSignal({
      id: 'sig:closed:sl',
      state: 'STOPPED',
      activatedAt: Date.now() - 20_000,
      closedAt: Date.now() - 5_000,
      realizedR: -1.0,
    });

    const perf = computeSignalPerformance([openTp1Signal, closedLossSignal]);
    expect(perf.closedCount).toBe(1);
    expect(perf.winningSignals).toBe(0);
    expect(perf.losingSignals).toBe(1);
    expect(perf.winRate).toBe(0);
    expect(perf.tp1HitRate).toBe(50);
  });

  it('purges boundary-crossing trades and applies embargo in computeWalkForwardFolds', () => {
    const startTime = 1_700_000_000;
    const oosEndTime = startTime + 1000 * 900; // 1000 x 15m bars
    const fold1TestStart = Math.floor(startTime + (oosEndTime - startTime) * 0.4);
    const fold1TestEnd = Math.floor(startTime + (oosEndTime - startTime) * 0.55);

    const makeTrade = (id: string, signalTime: number, entryTime: number, exitTime: number, realizedR: number): BacktestTradeRecord => ({
      id,
      tradeNumber: 1,
      strategyId: 'smc_bos_retest',
      direction: 'BUY',
      entryMode: 'market_close',
      signalTime,
      entryTime,
      exitTime,
      barsHeld: 2,
      entryPrice: 100,
      stopLoss: 99,
      initialStopLoss: 99,
      invalidationLevel: 98,
      exitPrice: realizedR > 0 ? 102 : 99,
      takeProfits: [],
      tp1Hit: realizedR > 0,
      tp2Hit: false,
      tp3Hit: false,
      exitReason: realizedR > 0 ? 'TP1_FULL' : 'STOP_LOSS',
      units: 1,
      riskAmount: 100,
      grossPnl: realizedR * 100,
      feesAndSlippage: 0,
      netPnl: realizedR * 100,
      returnPercent: realizedR,
      realizedR,
      mfeR: Math.max(0, realizedR),
      maeR: Math.min(0, realizedR),
      equityAfter: 10000 + realizedR * 100,
      confluenceScore: 80,
      entryRationale: [],
      exitNote: 'test',
    });

    // Trade 1: crosses train -> test boundary inside embargo (must be purged from train & excluded from test)
    const leakingTrainTrade = makeTrade('t-leak-train', fold1TestStart - 1800, fold1TestStart - 900, fold1TestStart + 900, 3.0);
    // Trade 2: crosses testEndTime into next fold (must be excluded from fold 1 test metrics)
    const leakingTestTrade = makeTrade('t-leak-test', fold1TestStart + 900, fold1TestStart + 1800, fold1TestEnd + 3600, 4.0);
    // Trade 3: strictly inside fold 1 test window [fold1TestStart, fold1TestEnd]
    const cleanTestTrade = makeTrade('t-clean-test', fold1TestStart + 900, fold1TestStart + 1800, fold1TestStart + 3600, 1.5);

    const wf = computeWalkForwardFolds(
      [leakingTrainTrade, leakingTestTrade, cleanTestTrade],
      startTime,
      oosEndTime,
      1.0,
      '15m',
      'BTCUSDT'
    );

    expect(wf.folds[0].trainMetrics.trades).toBe(0);
    expect(wf.folds[0].testMetrics.trades).toBe(1);
    expect(wf.folds[0].testMetrics.expectancyR).toBe(1.5);
  });

  it('calibrates probabilities with Wilson score interval and refuses with low sample size', () => {
    const fewSignals = Array.from({ length: 5 }, (_, idx) =>
      makeSignal({ id: `s:${idx}`, closedAt: Date.now(), realizedR: 2.0 })
    );
    const low = calibrateSignalStrategyPerformance('smc_bos_retest', fewSignals);
    expect(low.sufficientEvidence).toBe(false);
    expect(low.calibratedWinRatePercent).toBeNull();
    expect(low.message).toContain('Not enough evidence');

    const manySignals = Array.from({ length: 25 }, (_, idx) =>
      makeSignal({ id: `s2:${idx}`, closedAt: Date.now(), realizedR: idx < 15 ? 2.0 : -1.0 })
    );
    const high = calibrateSignalStrategyPerformance('smc_bos_retest', manySignals);
    expect(high.sufficientEvidence).toBe(true);
    expect(high.calibratedWinRatePercent).toBe(60);
    expect(high.ciLowerPercent).toBeLessThan(60);
    expect(high.ciUpperPercent).toBeGreaterThan(60);
  });

  it('persists, updates reflection notes, and deletes trade journal entries securely', () => {
    const mockPos: PaperPosition = {
      id: 'pos:1',
      orderId: 'ord:1',
      signalId: 'sig:1',
      journalId: 'jnl:1',
      strategyId: 'smc_bos_retest',
      strategyName: 'BOS Retest',
      strategyVersion: 'v1.0',
      symbol: 'XAUUSD',
      timeframe: '5m',
      direction: 'BUY',
      entryPrice: 2000,
      currentPrice: 2020,
      stopLoss: 1990,
      initialStopLoss: 1990,
      takeProfits: [],
      volumeTotal: 0.1,
      volumeRemaining: 0,
      riskAmountUsd: 10,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 20,
      realizedR: 2.0,
      feesUsd: 1.4,
      slippageUsd: 0.2,
      status: 'CLOSED',
      exitPrice: 2020,
      exitReason: 'TP1',
      openedAt: Date.now() - 3600000,
      closedAt: Date.now(),
    };

    const sigStub = makeSignal({
      id: 'sig:1',
      generationSummary: 'Bullish BOS retest',
      confluenceReasons: ['BOS'],
    });

    const entry = journalService.createEntryFromPosition(sigStub, mockPos);
    expect(entry.id).toBeDefined();

    const updated = journalService.updateEntry(entry.id, {
      reflectionNotes: 'Clean structure entry.',
      lessonsLearned: 'Hold until TP2 when HTF aligned.',
      rating: 5,
    });
    expect(updated?.reflectionNotes).toBe('Clean structure entry.');
    expect(updated?.rating).toBe(5);

    const all = journalService.getAllEntries();
    expect(all.length).toBe(1);

    const deleted = journalService.deleteEntry(entry.id);
    expect(deleted).toBe(true);
    expect(journalService.getAllEntries().length).toBe(0);
  });

  it('tracks live M2M unrealized PnL, TP1 partial + breakeven trail, TP2 full exit, manual close, and updates RiskEngine & Journal', () => {
    const gateway = new ExecutionGateway(riskEngine);
    const sig = makeSignal({
      id: 'sig:paper:lifecycle',
      entryPrice: 2000,
      stopLoss: 1990,
      takeProfits: [
        { level: 1, price: 2020, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null },
        { level: 2, price: 2040, riskReward: 4.0, sourceLabel: 'TP2', hit: false, hitTime: null },
      ],
    });

    const exec = gateway.executeSignal(sig, 2000, 'PAPER');
    expect(exec.success).toBe(true);
    expect(exec.position).toBeTruthy();
    const pos = exec.position!;
    const entry = journalService.createEntryFromPosition(sig, pos);
    expect(entry.outcome).toBe('OPEN');
    expect(entry.status).toBe('OPEN');

    // 1. Live price moves favorably -> positive unrealized PnL
    const midUpdate = gateway.processPriceUpdate('XAUUSD', { price: 2010, bid: 2010, ask: 2010.5 }, Date.now());
    expect(midUpdate.updatedPositions.length).toBe(1);
    expect(midUpdate.closedPositions.length).toBe(0);
    expect(midUpdate.updatedPositions[0].unrealizedPnlUsd).toBeGreaterThan(0);

    // 2. Price reaches TP1 -> partial exit + Stop Loss moves to breakeven (entryPrice)
    const tp1Update = gateway.processPriceUpdate(
      'XAUUSD',
      { price: 2020, bid: 2020, ask: 2020.4, high: 2020.5, low: 2012 },
      Date.now() + 1000
    );
    expect(tp1Update.updatedPositions[0].status).toBe('PARTIAL');
    expect(tp1Update.updatedPositions[0].stopLoss).toBe(tp1Update.updatedPositions[0].entryPrice);
    expect(tp1Update.updatedPositions[0].volumeRemaining).toBeLessThan(pos.volumeTotal);
    const syncedPartial = journalService.syncPositionToJournal(tp1Update.updatedPositions[0]);
    expect(syncedPartial?.status).toBe('PARTIAL');

    // 3. Price hits TP2 -> closes remaining volume cleanly and updates RiskEngine equity + Journal
    const startingEquity = riskEngine.getCurrentEquity();
    const tp2Update = gateway.processPriceUpdate(
      'XAUUSD',
      { price: 2041, bid: 2041, ask: 2041.4, high: 2041.5, low: 2022 },
      Date.now() + 2000
    );
    expect(tp2Update.closedPositions.length).toBe(1);
    const closed = tp2Update.closedPositions[0];
    expect(closed.status).toBe('CLOSED');
    expect(closed.exitReason).toBe('TP2_FULL');
    expect(closed.realizedPnlUsd).toBeGreaterThan(0);
    expect(riskEngine.getCurrentEquity()).toBeCloseTo(startingEquity + closed.realizedPnlUsd, 2);

    const syncedClosed = journalService.syncPositionToJournal(closed);
    expect(syncedClosed?.status).toBe('CLOSED');
    expect(syncedClosed?.outcome).toBe('WIN');
    expect(syncedClosed?.exitReason).toBe('TP2_FULL');

    // 4. Execute a second signal and close manually
    const sig2 = makeSignal({
      id: 'sig:paper:manual',
      entryPrice: 2050,
      stopLoss: 2040,
      takeProfits: [
        { level: 1, price: 2070, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null },
      ],
    });
    const exec2 = gateway.executeSignal(sig2, 2050, 'PAPER');
    expect(exec2.success).toBe(true);
    const manualClosed = gateway.closePositionManually(exec2.position!.id, 2055, Date.now() + 3000);
    expect(manualClosed?.status).toBe('CLOSED');
    expect(manualClosed?.exitReason).toBe('MANUAL_CLOSE');
    expect(manualClosed?.exitPrice).toBe(2055);
  });

  it('persists and rehydrates paper orders, positions, risk state, and MT5 bridge snapshot in SQLite', () => {
    const gateway = new ExecutionGateway(riskEngine);
    const sig = makeSignal({ id: 'sig:persist:1' });
    const exec = gateway.executeSignal(sig, 2000, 'PAPER');
    expect(exec.success).toBe(true);

    platformStore.upsertPaperOrder(exec.order!);
    platformStore.upsertPaperPosition(exec.position!);
    platformStore.saveRiskEngineState(riskEngine.exportState());

    platformStore.saveMt5BridgeSnapshot({
      connected: true,
      statusLabel: 'CONNECTED',
      terminalVersion: '1.1',
      accountNumber: 5029182,
      broker: 'MetaQuotes-Demo',
      server: 'MetaQuotes-Demo',
      currency: 'USD',
      leverage: 100,
      balance: 10000,
      equity: 10125.5,
      margin: 250,
      freeMargin: 9875.5,
      latencyMs: 14,
      lastHeartbeat: Date.now(),
      lastTickAt: Date.now(),
      messagesReceived: 42,
      paperMode: true,
      requiresApiToken: false,
      openPositions: [],
      syncedTicks: [],
      lastError: null,
    });

    const loadedOrders = platformStore.getAllPaperOrders();
    const loadedPositions = platformStore.getAllPaperPositions();
    const loadedRisk = platformStore.loadRiskEngineState<PersistedRiskState>();
    const loadedMt5 = platformStore.loadMt5BridgeSnapshot();

    expect(loadedOrders.length).toBe(1);
    expect(loadedPositions.length).toBe(1);
    expect(loadedRisk?.tradesTodayCount).toBe(1);
    expect(loadedMt5?.broker).toBe('MetaQuotes-Demo');
    expect(loadedMt5?.accountNumber).toBe(5029182);

    // Rehydrate fresh RiskEngine + Gateway from SQLite
    const freshRisk = new CentralizedRiskEngine(DEFAULT_RISK_SETTINGS);
    freshRisk.hydrateState(loadedRisk);
    const freshGateway = new ExecutionGateway(freshRisk);
    freshGateway.hydrate(loadedOrders, loadedPositions);

    expect(freshGateway.getOpenPositions().length).toBe(1);
    expect(freshGateway.hasExecutedSignal('sig:persist:1')).toBe(true);

    // Duplicate signal id execution must be rejected cleanly
    const dup = freshGateway.executeSignal(sig, 2000, 'PAPER');
    expect(dup.success).toBe(false);
    expect(dup.rejectionReason).toContain('already executed');
  });

  it('ingests MT5 bridge payloads via API router without session cookies and serves configured EA', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { AuthService } = await import('../auth/service.ts');
    const { createApiRouter } = await import('../backend/routes/api.ts');

    const authService = new AuthService(platformStore);
    const gateway = new ExecutionGateway(riskEngine);

    let mt5State: import('../shared/types/index.ts').MT5BridgeStatus = {
      connected: false,
      statusLabel: 'DISCONNECTED',
      latencyMs: 0,
      lastHeartbeat: 0,
      lastTickAt: null,
      messagesReceived: 0,
      paperMode: true,
      requiresApiToken: false,
      openPositions: [],
      syncedTicks: [],
      lastError: null,
    };

    const mockService = {
      authService,
      marketData: {
        getAllProviderStatuses: () => [],
        getAllQuotes: () => [],
      },
      getPaperPositions: () => gateway.getAllPositions(),
      getPaperOrders: () => gateway.getOrders(),
      getRiskSnapshot: () => riskEngine.getAccountSnapshot(0, 0),
      updateRiskSettings: (patch: Record<string, unknown>) => {
        riskEngine.updateSettings(patch);
        return riskEngine.getAccountSnapshot(0, 0);
      },
      resetPaperAccount: (eq?: number) => {
        gateway.clearPaperState();
        riskEngine.resetAccount(eq);
        return {
          positions: [],
          orders: [],
          riskSnapshot: riskEngine.getAccountSnapshot(0, 0),
        };
      },
      handleMt5Ingest: (payload: Record<string, unknown>) => {
        mt5State = {
          ...mt5State,
          connected: true,
          statusLabel: 'CONNECTED',
          broker: String(payload.company ?? mt5State.broker ?? ''),
          accountNumber: Number(payload.login ?? mt5State.accountNumber ?? 0),
          lastHeartbeat: Date.now(),
          messagesReceived: mt5State.messagesReceived + 1,
        };
        return mt5State;
      },
      getMt5Status: () => mt5State,
    } as any;

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(mockService));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. MT5 EA posts heartbeat WITHOUT browser session cookie -> must succeed 200 OK
      const ingestRes = await fetch(`${baseUrl}/api/mt5/bridge/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'heartbeat',
          login: 123456,
          company: 'TestBroker',
          balance: 10000,
          equity: 10050,
        }),
      });
      expect(ingestRes.status).toBe(200);
      const ingestJson = (await ingestRes.json()) as { ok: boolean; connected: boolean };
      expect(ingestJson.ok).toBe(true);
      expect(ingestJson.connected).toBe(true);

      // 2. Unauthenticated browser request to /api/mt5/status must return 401
      const unauthStatus = await fetch(`${baseUrl}/api/mt5/status`);
      expect(unauthStatus.status).toBe(401);

      // 3. Authenticated browser session gets live MT5 status, test-ping, and configured EA download
      const loginRes = authService.login('maswaeecom@gmail.com', 'Admin@12345');
      expect(loginRes).toBeTruthy();
      const headers = { Authorization: `Bearer ${loginRes!.token}` };

      const statusRes = await fetch(`${baseUrl}/api/mt5/status`, { headers });
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        connected: boolean;
        broker: string;
        accountNumber: number;
      };
      expect(statusJson.connected).toBe(true);
      expect(statusJson.broker).toBe('TestBroker');
      expect(statusJson.accountNumber).toBe(123456);

      const pingRes = await fetch(`${baseUrl}/api/mt5/test-ping`, {
        method: 'POST',
        headers,
      });
      expect(pingRes.status).toBe(200);
      const pingJson = (await pingRes.json()) as { endpointReachable: boolean; ingestUrl: string };
      expect(pingJson.endpointReachable).toBe(true);
      expect(pingJson.ingestUrl).toContain(`/api/mt5/bridge/ingest`);

      const eaRes = await fetch(`${baseUrl}/api/mt5/ea/download`, { headers });
      expect(eaRes.status).toBe(200);
      const eaSource = await eaRes.text();
      expect(eaSource).toContain(`127.0.0.1:${addr.port}/api/mt5/bridge/ingest`);
      expect(eaSource).toContain('ArrayResize(post, len - 1)');
    } finally {
      server.close();
    }
  });

  it('evaluates all 14 alert rule types accurately, enforces filters, and persists rules/history in SQLite', async () => {
    const { DEFAULT_ALERT_RULES } = await import('../shared/constants/index.ts');
    const { InMemoryAlertEngine } = await import('../monitoring/alerts/index.ts');
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { AuthService } = await import('../auth/service.ts');
    const { createApiRouter } = await import('../backend/routes/api.ts');

    // 1. DEFAULT_ALERT_RULES covers all 14 AlertType values and defaults OFF
    expect(DEFAULT_ALERT_RULES.length).toBe(14);
    const ruleTypes = new Set(DEFAULT_ALERT_RULES.map((r) => r.type));
    expect(ruleTypes.size).toBe(14);
    expect(DEFAULT_ALERT_RULES.every((r) => r.enabled === false)).toBe(true);

    // 2. Engine is disabled by default until user opts in
    const engine = new InMemoryAlertEngine();
    expect(engine.isEnabled()).toBe(false);
    expect(engine.evaluate({ symbol: 'XAUUSD', timeframe: '15m', candles: [], supportResistance: [], supplyDemand: [], marketStructure: { breaks: [] }, liquidityPools: [], orderBlocks: [], fairValueGaps: [], candlestickPatterns: [], chartPatterns: [], trendlines: [] } as any, [], true)).toHaveLength(0);

    // User opts in and enables the alert rules (except htf_alignment first)
    engine.setEnabled(true);
    engine.updateRules(
      engine.getRules().map((r) => ({
        ...r,
        enabled: r.type !== 'htf_alignment',
      }))
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const snapshot: any = {
      symbol: 'XAUUSD',
      timeframe: '15m',
      candles: [{ time: nowSec, open: 2640, high: 2655, low: 2638, close: 2650, volume: 1200, isClosed: true }],
      quote: { symbol: 'XAUUSD', price: 2650, bid: 2649.8, ask: 2650.2, timestamp: Date.now(), source: 'test' },
      supportResistance: [
        { id: 'sr-sup', kind: 'support' },
        { id: 'sr-res', kind: 'resistance' },
      ],
      supplyDemand: [],
      marketStructure: {
        trend: 'bullish',
        breaks: [
          { id: 'br-1', type: 'BOS', direction: 'bullish', scope: 'swing', levelPrice: 2645, breakTime: nowSec - 120 },
          { id: 'br-2', type: 'CHoCH', direction: 'bearish', scope: 'internal', levelPrice: 2652, breakTime: nowSec - 60 },
        ],
      },
      liquidityPools: [
        { id: 'liq-1', kind: 'sell_side', label: 'Session Low', price: 2635, swept: true, sweepTime: nowSec - 180, sweepType: 'stop_hunt' },
      ],
      orderBlocks: [
        { id: 'ob-1', kind: 'bullish_ob', upper: 2644, lower: 2640, originTime: nowSec - 300, displacementAtr: 2.1, valid: true, mitigated: false },
      ],
      fairValueGaps: [
        { id: 'fvg-1', kind: 'bullish_fvg', upper: 2648, lower: 2645, originTime: nowSec - 300, status: 'unfilled' },
      ],
      candlestickPatterns: [
        { id: 'cp-1', name: 'Bullish Engulfing', direction: 'bullish', confirmationStatus: 'confirmed', detectionTime: nowSec - 300, formationPrice: 2649 },
      ],
      chartPatterns: [
        { id: 'chp-1', name: 'Ascending Triangle', status: 'Breakout', direction: 'bullish', detectionTime: nowSec - 1800, breakoutTime: nowSec - 300, breakoutLevel: 2647 },
      ],
      trendlines: [
        { id: 'tl-1', kind: 'bearish_resistance', status: 'broken', detectionTime: nowSec - 1800, breakoutTime: nowSec - 300, currentProjectedPrice: 2646 },
      ],
    };

    const interactions: any[] = [
      {
        id: 'ev-sr-approach',
        objectId: 'sr-sup',
        objectCategory: 'support_resistance',
        objectLabel: 'Support S1',
        status: 'Approaching',
        distancePercent: 0.12,
        lowerBound: 2646,
        upperBound: 2648,
      },
      {
        id: 'ev-sr-touch',
        objectId: 'sr-res',
        objectCategory: 'support_resistance',
        objectLabel: 'Resistance R1',
        status: 'Touched',
        distancePercent: 0.01,
        lowerBound: 2650,
        upperBound: 2652,
      },
      {
        id: 'ev-demand',
        objectId: 'sd-dem',
        objectCategory: 'supply_demand',
        objectLabel: 'Demand Zone (DBR)',
        status: 'Entered Zone',
        distancePercent: 0.0,
        lowerBound: 2645,
        upperBound: 2651,
      },
      {
        id: 'ev-supply',
        objectId: 'sd-sup',
        objectCategory: 'supply_demand',
        objectLabel: 'Supply Zone (RBD)',
        status: 'Approaching',
        distancePercent: 0.9, // Exceeds default 0.25% threshold -> should NOT trigger
        lowerBound: 2672,
        upperBound: 2676,
      },
    ];

    const emitted = engine.evaluate(snapshot, interactions, true);
    const emittedTypes = new Set(emitted.map((a) => a.type));

    expect(emittedTypes.has('approaching_support')).toBe(true);
    expect(emittedTypes.has('touching_resistance')).toBe(true);
    expect(emittedTypes.has('demand_entry')).toBe(true);
    expect(emittedTypes.has('supply_entry')).toBe(false); // filtered by distanceThresholdPercent
    expect(emittedTypes.has('bullish_bos')).toBe(true);
    expect(emittedTypes.has('bearish_choch')).toBe(true);
    expect(emittedTypes.has('liquidity_sweep')).toBe(true);
    expect(emittedTypes.has('ob_formation')).toBe(true);
    expect(emittedTypes.has('fvg_formation')).toBe(true);
    expect(emittedTypes.has('pattern_confirmation')).toBe(true);
    expect(emittedTypes.has('trendline_breakout')).toBe(true);
    // htf_alignment is disabled by default so it shouldn't fire yet
    expect(emittedTypes.has('htf_alignment')).toBe(false);

    // Enable htf_alignment & verify it fires on next pass
    const updatedRules = engine.getRules().map((r) =>
      r.type === 'htf_alignment' ? { ...r, enabled: true } : r
    );
    engine.updateRules(updatedRules);
    const htfEmitted = engine.evaluate(snapshot, [], true);
    expect(htfEmitted.some((a) => a.type === 'htf_alignment')).toBe(true);

    // 3. Verify SQLite persistence & rehydration
    platformStore.saveAlertRules(engine.getRules());
    for (const a of [...emitted, ...htfEmitted]) {
      platformStore.saveAlertNotification(a);
    }
    const loadedRules = platformStore.loadAlertRules();
    const loadedHistory = platformStore.getAlertHistory(50);
    expect(loadedRules?.find((r) => r.type === 'htf_alignment')?.enabled).toBe(true);
    expect(loadedHistory.length).toBe(emitted.length + htfEmitted.length);

    platformStore.clearAlertHistory();
    expect(platformStore.getAlertHistory(50)).toHaveLength(0);

    // 4. Verify Express /api/alerts routes end-to-end
    const authService = new AuthService(platformStore);
    const alertEngineForHttp = new InMemoryAlertEngine();
    const mockService: any = {
      authService,
      marketData: {
        getAllProviderStatuses: () => [],
        getAllQuotes: () => [],
      },
      getAlertSystemEnabled: () => alertEngineForHttp.isEnabled(),
      setAlertSystemEnabled: (enabled: boolean) => {
        const next = alertEngineForHttp.setEnabled(enabled);
        platformStore.setAlertSystemEnabled(next);
        return next;
      },
      getAlertRules: () => alertEngineForHttp.getRules(),
      getAlertHistory: () => alertEngineForHttp.getHistory(),
      updateAlertRules: (rules: any[]) => {
        const res = alertEngineForHttp.updateRules(rules);
        platformStore.saveAlertRules(res);
        return res;
      },
      resetAlertRules: () => {
        const res = alertEngineForHttp.resetDefaultRules();
        platformStore.saveAlertRules(res);
        return res;
      },
      clearAlertHistory: () => {
        alertEngineForHttp.clearHistory();
        platformStore.clearAlertHistory();
      },
      triggerTestAlert: (sym: any, tf: any, ruleId?: string) => {
        const alert = alertEngineForHttp.triggerTestAlert(sym, tf, 2650, ruleId);
        platformStore.saveAlertNotification(alert);
        return alert;
      },
    };

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(mockService));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const loginRes = authService.login('maswaeecom@gmail.com', 'Admin@12345');
      const headers = {
        Authorization: `Bearer ${loginRes!.token}`,
        'Content-Type': 'application/json',
      };

      const getRes = await fetch(`${baseUrl}/api/alerts`, { headers });
      expect(getRes.status).toBe(200);
      const getJson = (await getRes.json()) as { enabled: boolean; rules: any[]; history: any[] };
      expect(getJson.enabled).toBe(false);
      expect(getJson.rules.length).toBe(14);

      const toggleRes = await fetch(`${baseUrl}/api/alerts/enabled`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(toggleRes.status).toBe(200);
      const toggleJson = (await toggleRes.json()) as { ok: boolean; enabled: boolean };
      expect(toggleJson.enabled).toBe(true);

      const testRes = await fetch(`${baseUrl}/api/alerts/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'XAUUSD', timeframe: '15m' }),
      });
      expect(testRes.status).toBe(200);
      const testJson = (await testRes.json()) as { ok: boolean; alert: { title: string } };
      expect(testJson.ok).toBe(true);
      expect(testJson.alert.title).toContain('TEST ALERT');

      const customRules = [
        {
          id: 'rule:custom:test',
          type: 'liquidity_sweep',
          label: 'Custom Gold Sweep',
          enabled: true,
          symbols: ['XAUUSD'],
          timeframes: ['15m'],
          distanceThresholdPercent: 0.5,
          browserNotify: false,
          soundEnabled: true,
        },
      ];
      const putRes = await fetch(`${baseUrl}/api/alerts/rules`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ rules: customRules }),
      });
      expect(putRes.status).toBe(200);
      const putJson = (await putRes.json()) as { rules: any[] };
      expect(putJson.rules).toHaveLength(1);
      expect(putJson.rules[0].label).toBe('Custom Gold Sweep');

      const resetRes = await fetch(`${baseUrl}/api/alerts/rules/reset`, {
        method: 'POST',
        headers,
      });
      expect(resetRes.status).toBe(200);
      const resetJson = (await resetRes.json()) as { rules: any[] };
      expect(resetJson.rules.length).toBe(14);

      const delRes = await fetch(`${baseUrl}/api/alerts/history`, {
        method: 'DELETE',
        headers,
      });
      expect(delRes.status).toBe(200);
      expect(alertEngineForHttp.getHistory()).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('enforces Demo-Only guard, executes MT5 signals, performs TP1 partial + Breakeven + SL-to-TP1 trailing, and persists commands/trades', async () => {
    const { MT5DemoTradeManager } = await import('../execution/mt5-trade-bridge.ts');
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { AuthService } = await import('../auth/service.ts');
    const { createApiRouter } = await import('../backend/routes/api.ts');

    const manager = new MT5DemoTradeManager();
    const signal = makeSignal({
      id: 'sig:mt5:exec:1',
      symbol: 'XAUUSD',
      direction: 'BUY',
      entryPrice: 2000,
      stopLoss: 1990,
      takeProfits: [
        { level: 1, price: 2020, riskReward: 2.0, sourceLabel: 'TP1', hit: false, hitTime: null },
        { level: 2, price: 2040, riskReward: 4.0, sourceLabel: 'TP2', hit: false, hitTime: null },
        { level: 3, price: 2060, riskReward: 6.0, sourceLabel: 'TP3', hit: false, hitTime: null },
      ],
    });

    const baseMt5Status: import('../shared/types/index.ts').MT5BridgeStatus = {
      connected: true,
      statusLabel: 'CONNECTED',
      tradeMode: 'REAL',
      accountNumber: 900112,
      broker: 'MetaQuotes',
      balance: 10000,
      equity: 10000,
      latencyMs: 12,
      lastHeartbeat: Date.now(),
      lastTickAt: Date.now(),
      messagesReceived: 5,
      paperMode: false,
      requiresApiToken: false,
      openPositions: [],
      syncedTicks: [
        {
          rawSymbol: 'XAUUSD.m',
          normalizedSymbol: 'XAUUSD',
          bid: 2000.0,
          ask: 2000.3,
          last: 2000.1,
          time: Math.floor(Date.now() / 1000),
          receivedAt: Date.now(),
        },
      ],
      lastError: null,
    };

    // 1. Demo-Only Safety Guard must block REAL accounts
    const blockedReal = manager.dispatchSignalTrade({
      signal,
      mt5Status: baseMt5Status,
      currentPrice: 2000.3,
      isAuto: false,
    });
    expect(blockedReal.success).toBe(false);
    expect(blockedReal.rejectionReason).toContain('Demo-Only Safety Guard');

    // 2. Demo account succeeds, resolves broker symbol XAUUSD.m, calculates risk volume, and queues OPEN_ORDER
    const demoStatus = { ...baseMt5Status, tradeMode: 'DEMO' as const };
    const opened = manager.dispatchSignalTrade({
      signal,
      mt5Status: demoStatus,
      currentPrice: 2000.3,
      isAuto: false,
      now: 1_700_000_000_000,
    });
    expect(opened.success).toBe(true);
    expect(opened.trade?.brokerSymbol).toBe('XAUUSD.m');
    expect(opened.trade?.requestedVolume).toBeGreaterThan(0);
    expect(opened.command?.type).toBe('OPEN_ORDER');

    // Duplicate signal dispatch must be rejected
    const dup = manager.dispatchSignalTrade({
      signal,
      mt5Status: demoStatus,
      currentPrice: 2000.3,
    });
    expect(dup.success).toBe(false);

    // 3. Dispatch command to EA and acknowledge fill with MT5 ticket
    const batch1 = manager.collectPendingCommands(1_700_000_000_100);
    expect(batch1.commandsToSend).toHaveLength(1);
    expect(batch1.commandsToSend[0].status).toBe('DISPATCHED');

    const acked = manager.processCommandAck(
      {
        commandId: batch1.commandsToSend[0].id,
        success: true,
        ticket: '778899',
        executedPrice: 2000.3,
        executedVolume: opened.trade!.requestedVolume,
        retcode: 10009,
      },
      1_700_000_000_500
    );
    expect(acked.trade?.status).toBe('OPEN');
    expect(acked.trade?.mt5Ticket).toBe('778899');

    // Ensure multi-lot for partial close test by adjusting openVolume >= 0.04 if needed
    acked.trade!.openVolume = 0.1;

    // 4. Price hits TP1 (2020) -> Partial Close 50% + Move SL to Breakeven (2000.3 + 10*0.01 = 2000.40)
    const tp1Eval = manager.evaluatePriceUpdate(
      'XAUUSD',
      { price: 2020.5, bid: 2020.5, ask: 2020.8 },
      3.0,
      1_700_000_010_000
    );
    expect(tp1Eval.createdCommands.some((c) => c.type === 'CLOSE_PARTIAL' && c.volume === 0.05)).toBe(true);
    const beCmd = tp1Eval.createdCommands.find((c) => c.type === 'MODIFY_SLTP');
    expect(beCmd).toBeDefined();
    expect(beCmd!.stopLoss).toBeCloseTo(2000.4, 2);
    expect(beCmd!.reason).toContain('Breakeven');

    // Ack TP1 commands before TP2
    for (const c of tp1Eval.createdCommands) {
      manager.processCommandAck({
        commandId: c.id,
        success: true,
        executedVolume: c.volume,
      });
    }

    // 5. Price hits TP2 (2040) -> Trail SL to TP1 (2020) + Partial Close TP2
    const tp2Eval = manager.evaluatePriceUpdate(
      'XAUUSD',
      { price: 2041.0, bid: 2041.0, ask: 2041.3 },
      3.0,
      1_700_000_020_000
    );
    const trailTp1Cmd = tp2Eval.createdCommands.find((c) => c.type === 'MODIFY_SLTP');
    expect(trailTp1Cmd).toBeDefined();
    expect(trailTp1Cmd!.stopLoss).toBe(2020);
    expect(trailTp1Cmd!.reason).toContain('TP1');

    // 6. Verify SQLite persistence for settings, commands, and managed trades
    platformStore.saveMt5ExecutionSettings(manager.getSettings());
    for (const c of manager.getCommands(50)) platformStore.upsertMt5TradeCommand(c);
    for (const t of manager.getManagedTrades()) platformStore.upsertMt5ManagedTrade(t);

    expect(platformStore.loadMt5ExecutionSettings()?.demoAccountOnly).toBe(true);
    expect(platformStore.getMt5TradeCommands(50).length).toBeGreaterThanOrEqual(4);
    expect(platformStore.getAllMt5ManagedTrades()).toHaveLength(1);

    // 7. Verify HTTP routes (/api/mt5/execution/* and command delivery in /api/mt5/bridge/ingest)
    const authService = new AuthService(platformStore);
    const mockService: any = {
      authService,
      marketData: {
        getAllProviderStatuses: () => [],
        getAllQuotes: () => [],
      },
      handleMt5Ingest: () => demoStatus,
      collectPendingMt5Commands: () => manager.collectPendingCommands().commandsToSend,
      getMt5Status: () => demoStatus,
      getMt5ExecutionOverview: () => ({
        settings: manager.getSettings(),
        managedTrades: manager.getManagedTrades(),
        commands: manager.getCommands(),
        bridgeStatus: demoStatus,
      }),
      updateMt5ExecutionSettings: (patch: Record<string, unknown>) => manager.updateSettings(patch),
      executeSignalMt5: () => ({ success: false, rejectionReason: 'Signal check' }),
      moveMt5TradeToBreakeven: () => ({ success: true }),
      trailMt5TradeToTp1: () => ({ success: true }),
      closeMt5Trade: (id: string) => manager.closeTradeManual(id),
      closeAllMt5Trades: () => manager.closeAllTrades(),
      cancelMt5Command: () => null,
    };

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(mockService));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const loginRes = authService.login('maswaeecom@gmail.com', 'Admin@12345');
      const headers = {
        Authorization: `Bearer ${loginRes!.token}`,
        'Content-Type': 'application/json',
      };

      const execRes = await fetch(`${baseUrl}/api/mt5/execution`, { headers });
      expect(execRes.status).toBe(200);
      const execJson = (await execRes.json()) as { managedTrades: any[]; commands: any[] };
      expect(execJson.managedTrades).toHaveLength(1);

      const settingsRes = await fetch(`${baseUrl}/api/mt5/execution/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          enabled: true,
          autoExecuteSignals: true,
          trailSlToTp1OnTp2: true,
          moveSlToBreakeven: true,
        }),
      });
      expect(settingsRes.status).toBe(200);
      const settingsJson = (await settingsRes.json()) as { settings: { enabled: boolean; autoExecuteSignals: boolean } };
      expect(settingsJson.settings.enabled).toBe(true);
      expect(settingsJson.settings.autoExecuteSignals).toBe(true);

      // Ingest endpoint returns pending commands directly to the MT5 EA
      const ingestRes = await fetch(`${baseUrl}/api/mt5/bridge/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'heartbeat', tradeMode: 'DEMO', login: 900112 }),
      });
      expect(ingestRes.status).toBe(200);
      const ingestJson = (await ingestRes.json()) as { commands: any[] };
      expect(Array.isArray(ingestJson.commands)).toBe(true);
      expect(ingestJson.commands.length).toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
    }
  });

  it('applies MT5_EXECUTION_PRESETS cleanly and keeps Safe Micro lot sizing within 0.01–0.05', async () => {
    const { MT5_EXECUTION_PRESETS } = await import('../shared/constants/index.ts');
    const { MT5DemoTradeManager } = await import('../execution/mt5-trade-bridge.ts');

    expect(MT5_EXECUTION_PRESETS.length).toBe(3);
    const manager = new MT5DemoTradeManager();
    const signal = makeSignal({
      symbol: 'XAUUSD',
      entryPrice: 2600,
      stopLoss: 2595,
    });

    for (const preset of MT5_EXECUTION_PRESETS) {
      const updated = manager.updateSettings(preset.patch);
      expect(updated.demoAccountOnly).toBe(true);
      expect(updated.moveSlToBreakeven).toBe(true);
      expect(updated.trailSlToTp1OnTp2).toBe(true);
    }

    const safeMicro = MT5_EXECUTION_PRESETS.find((p) => p.id === 'safe_micro')!;
    const safeSettings = manager.updateSettings(safeMicro.patch);
    expect(safeSettings.sizingMode).toBe('FIXED_LOT');
    expect(safeSettings.fixedLotSize).toBe(0.01);
    expect(safeSettings.maxLotSize).toBe(0.05);

    const calcVol = manager.calculateLotVolume(signal, 25000);
    expect(calcVol).toBe(0.01);
    expect(calcVol).toBeGreaterThanOrEqual(0.01);
    expect(calcVol).toBeLessThanOrEqual(0.05);
  });

  it('defaults to Strategy-Only signals (allowDefaultSignals=false) and enforces Auto-Trade strategy accuracy filters', async () => {
    const { DEFAULT_SIGNAL_SETTINGS } = await import('../shared/constants/index.ts');
    const { SignalEngine } = await import('../signals/engine.ts');

    expect(DEFAULT_SIGNAL_SETTINGS.allowDefaultSignals).toBe(false);
    expect(DEFAULT_SIGNAL_SETTINGS.requireRegimeCompatibility).toBe(true);
    expect(DEFAULT_SIGNAL_SETTINGS.requireHtfAlignmentForStrategy).toBe(true);
    expect(DEFAULT_SIGNAL_SETTINGS.minStrategyConfluenceScore).toBeGreaterThanOrEqual(75);

    const engine = new SignalEngine();
    expect(engine.getSettings().allowDefaultSignals).toBe(false);

    // Record Strategy-Only diagnostic when no strategies are armed
    const diag = engine.recordStrategyOnlyDiagnostic('XAUUSD', '15m', {}, false);
    expect(diag.status).toBe('NO_TRADE');
    expect(diag.rejectionReasons.some((r) => r.includes('Default generic signals disabled'))).toBe(true);

    // Validate accuracy gating on evaluateBasketCandidates: low confluence / counter-HTF blocked
    const nowSec = Math.floor(Date.now() / 1000);
    const candles = Array.from({ length: 30 }, (_, idx) => {
      const t = nowSec - (30 - idx) * 900;
      const base = 2600 + idx * 0.5;
      return {
        time: t,
        open: base - 0.5,
        high: base + 1.5,
        low: base - 1.5,
        close: base + 0.8,
        volume: 1000,
        isClosed: true,
      };
    });
    const lastBar = candles[candles.length - 1];
    const snaps: any = {
      '15m': {
        symbol: 'XAUUSD',
        timeframe: '15m',
        candles,
        marketStructure: { trend: 'bearish', breaks: [] },
        supportResistance: [],
        supplyDemand: [],
        liquidityPools: [],
        orderBlocks: [],
        fairValueGaps: [],
        candlestickPatterns: [],
        chartPatterns: [],
        trendlines: [],
        premiumDiscount: { zone: 'equilibrium' },
      },
      '1H': {
        symbol: 'XAUUSD',
        timeframe: '1H',
        candles,
        marketStructure: { trend: 'bearish', breaks: [] },
        supportResistance: [],
        supplyDemand: [],
        liquidityPools: [],
        orderBlocks: [],
        fairValueGaps: [],
        candlestickPatterns: [],
        chartPatterns: [],
        trendlines: [],
        premiumDiscount: { zone: 'equilibrium' },
      },
    };

    const testQuote: any = {
      symbol: 'XAUUSD',
      price: lastBar.close,
      bid: lastBar.close - 0.1,
      ask: lastBar.close + 0.1,
      timestamp: nowSec * 1000,
      stale: false,
      source: 'test',
    };
    const testProvider: any = {
      symbol: 'XAUUSD',
      providerName: 'test',
      connectionStatus: 'CONNECTED',
      marketStatus: 'OPEN',
    };
    const strategyMeta = {
      id: 'bos_continuation',
      name: 'BOS Continuation',
      category: 'SMC' as const,
    };

    const rejected = engine.evaluateBasketCandidates({
      symbol: 'XAUUSD',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: lastBar.time,
      atrBuffer: 1.0,
      snapshots: snaps,
      quote: testQuote,
      providerStatus: testProvider,
      maxConcurrentPositions: 4,
      minConfluenceScore: 75,
      requireHtfAlignment: true,
      marketRegime: 'Trending',
      candidates: [
        {
          strategy: strategyMeta,
          candidate: {
            strategyId: 'bos_continuation',
            direction: 'BUY',
            entryMode: 'market_close',
            entryPrice: lastBar.close,
            entryZone: { lower: lastBar.close - 0.5, upper: lastBar.close + 0.5 },
            stopLoss: lastBar.close - 5,
            invalidationLevel: lastBar.close - 6,
            takeProfits: [
              { level: 1, price: lastBar.close + 10, riskReward: 2, sourceLabel: 'TP1', hit: false, hitTime: null },
            ],
            confluenceScore: 55, // below 75
            entryRationale: ['Weak confluence test'],
          },
        },
        {
          strategy: strategyMeta,
          candidate: {
            strategyId: 'bos_continuation',
            direction: 'BUY', // counter to 1H bearish
            entryMode: 'market_close',
            entryPrice: lastBar.close,
            entryZone: { lower: lastBar.close - 0.5, upper: lastBar.close + 0.5 },
            stopLoss: lastBar.close - 5,
            invalidationLevel: lastBar.close - 6,
            takeProfits: [
              { level: 1, price: lastBar.close + 10, riskReward: 2, sourceLabel: 'TP1', hit: false, hitTime: null },
            ],
            confluenceScore: 85,
            entryRationale: ['Counter HTF test'],
          },
        },
      ],
    });
    expect(rejected.emittedSignals).toHaveLength(0);

    const accepted = engine.evaluateBasketCandidates({
      symbol: 'XAUUSD',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: lastBar.time,
      atrBuffer: 1.0,
      snapshots: snaps,
      quote: testQuote,
      providerStatus: testProvider,
      maxConcurrentPositions: 4,
      minConfluenceScore: 75,
      requireHtfAlignment: true,
      marketRegime: 'Trending',
      candidates: [
        {
          strategy: strategyMeta,
          candidate: {
            strategyId: 'bos_continuation',
            direction: 'SELL', // aligned with 1H bearish
            entryMode: 'market_close',
            entryPrice: lastBar.close,
            entryZone: { lower: lastBar.close - 0.5, upper: lastBar.close + 0.5 },
            stopLoss: lastBar.close + 5,
            invalidationLevel: lastBar.close + 6,
            takeProfits: [
              { level: 1, price: lastBar.close - 10, riskReward: 2, sourceLabel: 'TP1', hit: false, hitTime: null },
            ],
            confluenceScore: 86,
            entryRationale: ['Bearish BOS continuation aligned with 1H'],
          },
        },
      ],
    });
    expect(accepted.emittedSignals).toHaveLength(1);
    expect(accepted.emittedSignals[0].source).toBe('strategy_basket');
    expect(accepted.emittedSignals[0].marketRegime).toBe('Trending');
  });

  it('enforces toggled SMC pre-trigger criteria (OB, FVG, Liquidity Sweep) on strategy basket signals and persists settings', () => {
    const engine = new SignalEngine();
    const nowSec = Math.floor(Date.now() / 1000);
    const candles = Array.from({ length: 50 }, (_, idx) => {
      const base = 2400 - idx * 1.2;
      return {
        time: nowSec - (50 - idx) * 900,
        open: base,
        high: base + 1.5,
        low: base - 1.5,
        close: base - 0.8,
        volume: 1000,
        isClosed: true,
      };
    });
    const lastBar = candles[candles.length - 1];
    const snaps: any = {
      '15m': {
        symbol: 'XAUUSD',
        timeframe: '15m',
        candles,
        marketStructure: { trend: 'bearish', breaks: [] },
        supportResistance: [],
        supplyDemand: [],
        liquidityPools: [],
        orderBlocks: [],
        fairValueGaps: [],
        candlestickPatterns: [],
        chartPatterns: [],
        trendlines: [],
        dealingRange: null,
      },
      '1H': {
        symbol: 'XAUUSD',
        timeframe: '1H',
        candles,
        marketStructure: { trend: 'bearish', breaks: [] },
        supportResistance: [],
        supplyDemand: [],
        liquidityPools: [],
        orderBlocks: [],
        fairValueGaps: [],
        candlestickPatterns: [],
        chartPatterns: [],
        trendlines: [],
        dealingRange: null,
      },
    };

    const testQuote: any = {
      symbol: 'XAUUSD',
      price: lastBar.close,
      stale: false,
    };
    const testProvider: any = {
      symbol: 'XAUUSD',
      providerName: 'test',
      connectionStatus: 'CONNECTED',
      hasHistoricalCredentials: true,
    };
    const strategyMeta = {
      id: 'bos_continuation',
      name: 'BOS Continuation',
      category: 'SMC' as const,
    };
    const sellCandidate = {
      strategy: strategyMeta,
      candidate: {
        strategyId: 'bos_continuation',
        direction: 'SELL' as const,
        entryMode: 'market_close' as const,
        entryPrice: lastBar.close,
        entryZone: { lower: lastBar.close - 0.5, upper: lastBar.close + 0.5 },
        stopLoss: lastBar.close + 5,
        invalidationLevel: lastBar.close + 6,
        takeProfits: [
          { level: 1 as const, price: lastBar.close - 10, riskReward: 2, sourceLabel: 'TP1', hit: false, hitTime: null },
        ],
        confluenceScore: 86,
        entryRationale: ['Bearish BOS continuation'],
      },
    };

    // Turn ON all three SMC pre-trigger criteria
    engine.updateSettings({
      smcCriteria: {
        requireOrderBlock: true,
        requireFairValueGap: true,
        requireLiquiditySweep: true,
      },
    });

    const blockedRes = engine.evaluateBasketCandidates({
      symbol: 'XAUUSD',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: lastBar.time,
      atrBuffer: 1.0,
      snapshots: snaps,
      quote: testQuote,
      providerStatus: testProvider,
      maxConcurrentPositions: 4,
      minConfluenceScore: 75,
      requireHtfAlignment: true,
      marketRegime: 'Trending',
      candidates: [sellCandidate],
    });
    expect(blockedRes.emittedSignals).toHaveLength(0);
    expect(blockedRes.smcFilteredReasons?.[0]).toContain('Order Block');
    expect(blockedRes.smcFilteredReasons?.[0]).toContain('Fair Value Gap');
    expect(blockedRes.smcFilteredReasons?.[0]).toContain('Liquidity Sweep');

    // Add valid bearish OB, unfilled bearish FVG, and swept buy-side liquidity pool
    snaps['15m'].orderBlocks.push({
      id: 'ob-bear-15m',
      symbol: 'XAUUSD',
      timeframe: '15m',
      kind: 'bearish_ob',
      upper: lastBar.close + 4,
      lower: lastBar.close + 1,
      midpoint: lastBar.close + 2.5,
      originTime: lastBar.time - 1800,
      displacementAtr: 2.0,
      valid: true,
      mitigated: false,
      mitigationPercent: 0,
      touches: 0,
      interactionState: 'Near',
    });
    snaps['15m'].fairValueGaps.push({
      id: 'fvg-bear-15m',
      symbol: 'XAUUSD',
      timeframe: '15m',
      kind: 'bearish_fvg',
      upper: lastBar.close + 3,
      lower: lastBar.close + 0.5,
      consequentEncroachment: lastBar.close + 1.75,
      originTime: lastBar.time - 900,
      fillPercent: 0,
      status: 'unfilled',
      interactionState: 'Near',
    });
    snaps['15m'].liquidityPools.push({
      id: 'liq-bsl-15m',
      symbol: 'XAUUSD',
      timeframe: '15m',
      kind: 'buy_side',
      label: 'BSL High',
      price: lastBar.close + 5,
      upper: lastBar.close + 5.5,
      lower: lastBar.close + 4.5,
      originTimes: [lastBar.time - 3600],
      swept: true,
      sweepTime: lastBar.time - 900,
      sweepType: 'stop_hunt',
      interactionState: 'Confirmed Breakout',
    });

    const allowedRes = engine.evaluateBasketCandidates({
      symbol: 'XAUUSD',
      entryTimeframe: '15m',
      setupTimeframe: '1H',
      closedCandleTime: lastBar.time,
      atrBuffer: 1.0,
      snapshots: snaps,
      quote: testQuote,
      providerStatus: testProvider,
      maxConcurrentPositions: 4,
      minConfluenceScore: 75,
      requireHtfAlignment: true,
      marketRegime: 'Trending',
      candidates: [sellCandidate],
    });
    expect(allowedRes.emittedSignals).toHaveLength(1);

    // Verify PlatformSqliteStore persists smcCriteria across saves/reloads
    platformStore.saveSignalSettings(engine.getSettings());
    const reloaded = platformStore.loadSignalSettings();
    expect(reloaded?.smcCriteria).toEqual({
      requireOrderBlock: true,
      requireFairValueGap: true,
      requireLiquiditySweep: true,
    });
  });
});

function DEFAULT_SIGNAL_SETTINGS_MOCK() {
  return {
    enabled: true,
    allowDefaultSignals: false,
    requireRegimeCompatibility: true,
    requireHtfAlignmentForStrategy: true,
    minStrategyConfluenceScore: 75,
    minConfirmedScore: 75,
    minWatchingScore: 65,
    minTp1RiskReward: 1.5,
    atrStopBufferMultiplier: 0.35,
    maxWatchingMinutes: 60,
    maxPendingConfirmedMinutes: 720,
    allowIntrabarWatching: true,
    require1HAlignment: false,
    require1MRefinement: false,
    smcCriteria: {
      requireOrderBlock: false,
      requireFairValueGap: false,
      requireLiquiditySweep: false,
    },
    timeframes: {
      majorDirectionTf: '1D' as any,
      primaryBiasTf: '4H' as any,
      secondaryConfirmTf: '1H' as any,
      setupTf: '15m' as any,
      entryTf: '5m' as any,
      refinementTf: '1m' as any,
    },
    weights: {
      htfAlignment: 20,
      liquiditySweep: 15,
      structureConfirmation: 20,
      obFvgConfluence: 15,
      premiumDiscount: 10,
      volumeMomentum: 10,
      riskRewardQuality: 10,
    },
  };
}
