import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type {
  BacktestStrategyCategory,
  BacktestStrategyId,
  DiscoveryStrategyScope,
  InstrumentSymbol,
  LiveConditionFilterMode,
  LiveStrategyBasketSlot,
  LiveStrategyFilterCriteria,
  LiveStrategyReadinessFilter,
  RiskSettings,
  Timeframe,
} from '../../shared/types/index.ts';
import { isValidInstrument, isValidTimeframe } from '../../shared/validators/index.ts';
import type { TerminalService } from '../server/terminal-service.ts';
import {
  authMiddleware,
  extractSessionToken,
  rateLimitMiddleware,
  securityHeadersMiddleware,
  SESSION_COOKIE_NAME,
  sessionAuthMiddleware,
} from '../middleware/index.ts';
import { evaluateMarketDataIntegrity } from '../../market-data/integrity/index.ts';

function buildSessionCookieString(token: string, maxAgeSec: number, isHttps: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

export function createApiRouter(service: TerminalService): Router {
  const router = Router();
  router.use(securityHeadersMiddleware);
  router.use(rateLimitMiddleware);

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      providers: service.marketData.getAllProviderStatuses(),
    });
  });

  // --- Authentication Endpoints (Public) ---
  router.post('/auth/login', (req, res) => {
    const emailRaw =
      typeof req.body?.email === 'string'
        ? req.body.email
        : typeof req.body?.username === 'string'
          ? req.body.username
          : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!emailRaw.trim() || !password) {
      res.status(400).json({ error: 'Username/email and password are required.' });
      return;
    }

    const result = service.authService.login(emailRaw, password);
    if (!result) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const maxAgeSec = Math.max(60, Math.floor((result.expiresAt - Date.now()) / 1000));
    res.setHeader('Set-Cookie', buildSessionCookieString(result.token, maxAgeSec, isHttps));

    res.json({
      ok: true,
      user: result.user,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  });

  router.post('/auth/logout', (req, res) => {
    const token = extractSessionToken(req);
    if (token) {
      service.authService.logout(token);
    }
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', buildSessionCookieString('', 0, isHttps));
    res.json({ ok: true });
  });

  router.get('/auth/session', (req, res) => {
    const token = extractSessionToken(req);
    const user = service.authService.verifySession(token);
    if (!user) {
      res.json({ authenticated: false, user: null });
      return;
    }
    res.json({ authenticated: true, user });
  });

  // --- Protected Terminal Endpoints ---
  router.use(sessionAuthMiddleware(service.authService));

  router.get('/providers/status', (_req, res) => {
    res.json({
      providers: service.marketData.getAllProviderStatuses(),
      quotes: service.marketData.getAllQuotes(),
    });
  });

  router.get('/overview', (_req, res) => {
    res.json(service.getOverview());
  });

  router.get('/snapshot/:symbol/:timeframe', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const timeframe = req.params.timeframe;
      if (!isValidInstrument(symbol) || !isValidTimeframe(timeframe)) {
        res.status(400).json({ error: 'Invalid instrument or timeframe' });
        return;
      }
      const force = req.query.force === '1';
      const snapshot = await service.getSnapshot(symbol, timeframe, force);
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  router.post('/dealing-range/:symbol/:timeframe', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const timeframe = req.params.timeframe;
    if (!isValidInstrument(symbol) || !isValidTimeframe(timeframe)) {
      res.status(400).json({ error: 'Invalid instrument or timeframe' });
      return;
    }
    const lookback = typeof req.body?.lookback === 'number' ? req.body.lookback : undefined;
    service.setDealingRangeLookback(symbol, timeframe, lookback);
    res.json({ ok: true });
  });

  router.get('/mtf/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!isValidInstrument(symbol)) {
        res.status(400).json({ error: 'Invalid instrument' });
        return;
      }
      const summary = await service.getMultiTimeframeSummary(symbol);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  router.get('/settings', (_req, res) => {
    res.json(service.getSettings());
  });

  router.put('/settings', (req, res) => {
    const updated = service.updateSettings(req.body ?? {});
    res.json(updated);
  });

  router.get('/alerts', (_req, res) => {
    res.json({
      enabled: service.getAlertSystemEnabled(),
      rules: service.getAlertRules(),
      history: service.getAlertHistory(),
    });
  });

  router.put('/alerts/enabled', (req, res) => {
    const enabled = service.setAlertSystemEnabled(Boolean(req.body?.enabled));
    res.json({ ok: true, enabled });
  });

  router.put('/alerts/rules', (req, res) => {
    if (!Array.isArray(req.body?.rules)) {
      res.status(400).json({ error: 'rules array required' });
      return;
    }
    const rules = service.updateAlertRules(req.body.rules);
    res.json({ rules });
  });

  router.post('/alerts/rules/reset', (_req, res) => {
    const rules = service.resetAlertRules();
    res.json({ rules });
  });

  router.delete('/alerts/history', (_req, res) => {
    service.clearAlertHistory();
    res.json({ ok: true, history: [] });
  });

  router.post('/alerts/test', (req, res) => {
    const symRaw = typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : 'XAUUSD';
    const tfRaw = typeof req.body?.timeframe === 'string' ? req.body.timeframe : '15m';
    const ruleId = typeof req.body?.ruleId === 'string' ? req.body.ruleId : undefined;
    const symbol = isValidInstrument(symRaw) ? symRaw : 'XAUUSD';
    const timeframe = isValidTimeframe(tfRaw) ? tfRaw : '15m';
    const alert = service.triggerTestAlert(symbol, timeframe, ruleId);
    res.json({ ok: true, alert });
  });

  router.get('/events', (req, res) => {
    const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined;
    const symbol = symbolRaw && isValidInstrument(symbolRaw) ? symbolRaw : undefined;
    res.json({ events: service.getLiveEvents(symbol) });
  });

  // ==========================================================================
  // Institutional BUY/SELL Signal System Endpoints
  // ==========================================================================

  router.get('/signals', (req, res) => {
    const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined;
    const symbol = symbolRaw && isValidInstrument(symbolRaw) ? symbolRaw : undefined;
    res.json({
      signals: service.getSignals(symbol),
      diagnostics: service.getSignalDiagnostics(),
      performance: service.getSignalPerformance(),
      settings: service.getSignalSettings(),
      notifications: service.getSignalNotifications(),
      liveStrategyBasket: service.getLiveStrategyBasket(),
    });
  });

  router.post('/signals/evaluate', async (req, res, next) => {
    try {
      const symbolRaw = typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : undefined;
      if (symbolRaw && isValidInstrument(symbolRaw)) {
        const diagnostic = await service.evaluateSignalsForSymbol(symbolRaw);
        res.json({
          signals: service.getSignals(symbolRaw),
          diagnostics: service.getSignalDiagnostics(),
          diagnostic,
          performance: service.getSignalPerformance(),
        });
        return;
      }
      const diagnostics = await service.evaluateAllInstrumentSignals();
      res.json({
        signals: service.getSignals(),
        diagnostics,
        performance: service.getSignalPerformance(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/signals/performance', (_req, res) => {
    res.json(service.getSignalPerformance());
  });

  router.get('/signals/settings', (_req, res) => {
    res.json(service.getSignalSettings());
  });

  router.put('/signals/settings', (req, res) => {
    const updated = service.updateSignalSettings(req.body ?? {});
    res.json(updated);
  });

  router.get('/signals/notifications', (_req, res) => {
    res.json({ notifications: service.getSignalNotifications() });
  });

  router.get('/signals/basket', (_req, res) => {
    res.json({ basket: service.getLiveStrategyBasket() });
  });

  router.put('/signals/basket', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const symbolRaw =
      typeof body.symbol === 'string' ? body.symbol.toUpperCase() : 'BTCUSDT';
    const timeframeRaw =
      typeof body.timeframe === 'string' ? body.timeframe : '15m';
    const htfRaw =
      typeof body.htfTimeframe === 'string' ? body.htfTimeframe : undefined;

    if (!isValidInstrument(symbolRaw) || !isValidTimeframe(timeframeRaw)) {
      res.status(400).json({ error: 'Invalid basket symbol or timeframe' });
      return;
    }
    if (htfRaw !== undefined && !isValidTimeframe(htfRaw)) {
      res.status(400).json({ error: 'Invalid basket higher timeframe' });
      return;
    }

    const strategyIds = Array.isArray(body.strategyIds)
      ? body.strategyIds.filter((x): x is BacktestStrategyId => typeof x === 'string')
      : [];

    if (strategyIds.length === 0) {
      res.status(400).json({ error: 'At least one strategyId is required for live basket' });
      return;
    }

    const rawAssignments = Array.isArray(body.assignments)
      ? body.assignments.filter((item): item is LiveStrategyBasketSlot => {
          if (!item || typeof item !== 'object') return false;
          const slot = item as Record<string, unknown>;
          return (
            typeof slot.symbol === 'string' &&
            isValidInstrument(slot.symbol.toUpperCase()) &&
            typeof slot.timeframe === 'string' &&
            isValidTimeframe(slot.timeframe) &&
            Array.isArray(slot.strategies) &&
            slot.strategies.length > 0
          );
        })
      : undefined;

    try {
      const basket = service.setLiveStrategyBasket({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        symbol: symbolRaw,
        timeframe: timeframeRaw,
        htfTimeframe: htfRaw,
        strategyIds,
        assignments: rawAssignments,
        filters:
          body.filters && typeof body.filters === 'object'
            ? (body.filters as LiveStrategyFilterCriteria)
            : undefined,
        selectionLabel:
          typeof body.selectionLabel === 'string' ? body.selectionLabel : undefined,
        maxConcurrentPositions:
          typeof body.maxConcurrentPositions === 'number' ? body.maxConcurrentPositions : 4,
        minRiskReward:
          typeof body.minRiskReward === 'number' ? body.minRiskReward : 1.5,
        sourceRunId: typeof body.sourceRunId === 'string' ? body.sourceRunId : undefined,
        mode: body.mode === 'merge' ? 'merge' : 'replace',
      });
      res.json({ basket });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid basket configuration' });
    }
  });

  router.post('/signals/basket/remove-item', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const symbolRaw = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : '';
    const timeframeRaw = typeof body.timeframe === 'string' ? body.timeframe : '';
    const strategyId = typeof body.strategyId === 'string' ? (body.strategyId as BacktestStrategyId) : undefined;
    if (!isValidInstrument(symbolRaw) || !isValidTimeframe(timeframeRaw)) {
      res.status(400).json({ error: 'Valid symbol and timeframe are required' });
      return;
    }
    const basket = service.removeLiveStrategyBasketItem(symbolRaw, timeframeRaw, strategyId);
    res.json({ ok: true, basket });
  });

  router.post('/signals/basket/arm-best', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const readinessMode: LiveStrategyReadinessFilter | undefined =
        body.readinessMode === 'PRODUCTION_READY_ONLY' ||
        body.readinessMode === 'INCLUDE_VERIFY_PAPER' ||
        body.readinessMode === 'VALIDATED_OR_PRELIM'
          ? body.readinessMode
          : undefined;
      const result = await service.armBestFilteredStrategies({
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        symbols: Array.isArray(body.symbols)
          ? body.symbols.filter((s): s is InstrumentSymbol => typeof s === 'string' && isValidInstrument(s.toUpperCase()))
          : undefined,
        timeframes: Array.isArray(body.timeframes)
          ? body.timeframes.filter((tf): tf is Timeframe => typeof tf === 'string' && isValidTimeframe(tf))
          : undefined,
        categories: Array.isArray(body.categories)
          ? body.categories.filter((c): c is BacktestStrategyCategory => typeof c === 'string')
          : undefined,
        readinessMode,
        avoidPoorRegimes:
          typeof body.avoidPoorRegimes === 'boolean' ? body.avoidPoorRegimes : undefined,
        requireHtfAlignment:
          typeof body.requireHtfAlignment === 'boolean' ? body.requireHtfAlignment : undefined,
        minRiskReward:
          typeof body.minRiskReward === 'number' ? body.minRiskReward : undefined,
        maxConcurrentPositions:
          typeof body.maxConcurrentPositions === 'number' ? body.maxConcurrentPositions : undefined,
        autoScanIfEmpty:
          typeof body.autoScanIfEmpty === 'boolean' ? body.autoScanIfEmpty : true,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/signals/basket', (_req, res) => {
    service.clearLiveStrategyBasket();
    res.json({ ok: true, basket: null });
  });

  router.post('/signals/delete-batch', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string')
      : null;
    const scopeRaw = req.body?.scope;

    let deletedIds: string[] = [];
    if (ids && ids.length > 0) {
      deletedIds = service.deleteSignals(ids);
    } else if (scopeRaw === 'all' || scopeRaw === 'closed' || scopeRaw === 'watching') {
      deletedIds = service.clearSignals(scopeRaw);
    } else {
      res.status(400).json({ error: 'Provide non-empty ids array or valid scope (all | closed | watching)' });
      return;
    }

    res.json({
      ok: true,
      deletedCount: deletedIds.length,
      deletedIds,
      signals: service.getSignals(),
      performance: service.getSignalPerformance(),
      diagnostics: service.getSignalDiagnostics(),
      notifications: service.getSignalNotifications(),
    });
  });

  router.post('/signals/:id/cancel', (req, res) => {
    const signal = service.cancelSignal(req.params.id);
    if (!signal) {
      res.status(404).json({ error: 'Active signal not found or already closed' });
      return;
    }
    res.json({
      signal,
      performance: service.getSignalPerformance(),
    });
  });

  router.delete('/signals/:id', (req, res) => {
    const deleted = service.deleteSignal(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Signal entry not found in SQLite database' });
      return;
    }
    res.json({
      ok: true,
      deletedId: req.params.id,
      signals: service.getSignals(),
      performance: service.getSignalPerformance(),
      diagnostics: service.getSignalDiagnostics(),
      notifications: service.getSignalNotifications(),
    });
  });

  router.delete('/signals', (req, res) => {
    const scopeRaw = typeof req.query.scope === 'string' ? req.query.scope : 'closed';
    const scope =
      scopeRaw === 'all' || scopeRaw === 'watching' || scopeRaw === 'closed'
        ? scopeRaw
        : 'closed';
    const deletedIds = service.clearSignals(scope);
    res.json({
      ok: true,
      deletedCount: deletedIds.length,
      deletedIds,
      signals: service.getSignals(),
      performance: service.getSignalPerformance(),
      diagnostics: service.getSignalDiagnostics(),
      notifications: service.getSignalNotifications(),
    });
  });

  // ==========================================================================
  // Multi-Strategy SMC & Price Action Backtesting Endpoints
  // ==========================================================================

  router.get('/backtest/strategies', (_req, res) => {
    res.json({ strategies: service.getBacktestStrategies() });
  });

  router.post('/backtest/run', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const symbolRaw =
        typeof body.symbol === 'string' ? body.symbol.toUpperCase() : 'BTCUSDT';
      const timeframeRaw =
        typeof body.timeframe === 'string' ? body.timeframe : '15m';
      const htfRaw =
        typeof body.htfTimeframe === 'string' ? body.htfTimeframe : undefined;

      if (!isValidInstrument(symbolRaw) || !isValidTimeframe(timeframeRaw)) {
        res.status(400).json({ error: 'Invalid backtest symbol or timeframe' });
        return;
      }
      let htfTimeframe: import('../../shared/types/index.ts').Timeframe | undefined;
      if (htfRaw !== undefined) {
        if (!isValidTimeframe(htfRaw)) {
          res.status(400).json({ error: 'Invalid higher timeframe' });
          return;
        }
        htfTimeframe = htfRaw;
      }

      const clampNum = (val: unknown, fallback: number, min: number, max: number) =>
        typeof val === 'number' && Number.isFinite(val)
          ? Math.min(max, Math.max(min, val))
          : fallback;

      const strategyIds = Array.isArray(body.strategyIds)
        ? body.strategyIds.filter((x): x is BacktestStrategyId => typeof x === 'string')
        : undefined;

      const saveToArchive = body.saveToArchive !== false;
      const result = await service.runBacktest(
        {
          symbol: symbolRaw,
          timeframe: timeframeRaw,
          htfTimeframe,
          bars: Math.round(clampNum(body.bars, 500, 120, 20000)),
          initialCapital: clampNum(body.initialCapital, 10000, 100, 100000000),
          riskPerTradePercent: clampNum(body.riskPerTradePercent, 1.0, 0.1, 10),
          commissionBps: clampNum(body.commissionBps, 4, 0, 50),
          slippageBps: clampNum(body.slippageBps, 2, 0, 50),
          minRiskReward: clampNum(body.minRiskReward, 1.5, 1.0, 5.0),
          moveStopToBreakevenAfterTp1:
            typeof body.moveStopToBreakevenAfterTp1 === 'boolean'
              ? body.moveStopToBreakevenAfterTp1
              : true,
          strategyIds,
        },
        { persist: saveToArchive }
      );

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/backtest/basket', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const symbolRaw =
        typeof body.symbol === 'string' ? body.symbol.toUpperCase() : 'BTCUSDT';
      const timeframeRaw =
        typeof body.timeframe === 'string' ? body.timeframe : '15m';
      const htfRaw =
        typeof body.htfTimeframe === 'string' ? body.htfTimeframe : undefined;

      if (!isValidInstrument(symbolRaw) || !isValidTimeframe(timeframeRaw)) {
        res.status(400).json({ error: 'Invalid basket backtest symbol or timeframe' });
        return;
      }
      let htfTimeframe: import('../../shared/types/index.ts').Timeframe | undefined;
      if (htfRaw !== undefined) {
        if (!isValidTimeframe(htfRaw)) {
          res.status(400).json({ error: 'Invalid higher timeframe' });
          return;
        }
        htfTimeframe = htfRaw;
      }

      const clampNum = (val: unknown, fallback: number, min: number, max: number) =>
        typeof val === 'number' && Number.isFinite(val)
          ? Math.min(max, Math.max(min, val))
          : fallback;

      const strategyIds = Array.isArray(body.strategyIds)
        ? body.strategyIds.filter((x): x is BacktestStrategyId => typeof x === 'string')
        : [];

      if (strategyIds.length === 0) {
        res.status(400).json({ error: 'Select at least one strategy for shared-capital basket simulation' });
        return;
      }

      const result = await service.runBasketBacktest({
        symbol: symbolRaw,
        timeframe: timeframeRaw,
        htfTimeframe,
        bars: Math.round(clampNum(body.bars, 500, 120, 20000)),
        initialCapital: clampNum(body.initialCapital, 10000, 100, 100000000),
        riskPerTradePercent: clampNum(body.riskPerTradePercent, 1.0, 0.1, 10),
        commissionBps: clampNum(body.commissionBps, 4, 0, 50),
        slippageBps: clampNum(body.slippageBps, 2, 0, 50),
        minRiskReward: clampNum(body.minRiskReward, 1.5, 1.0, 5.0),
        moveStopToBreakevenAfterTp1:
          typeof body.moveStopToBreakevenAfterTp1 === 'boolean'
            ? body.moveStopToBreakevenAfterTp1
            : true,
        strategyIds,
        maxConcurrentPositions: Math.round(clampNum(body.maxConcurrentPositions, 4, 1, 20)),
        maxPortfolioHeatPercent: clampNum(body.maxPortfolioHeatPercent, 4.0, 0.5, 50),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/backtest/runs', (_req, res) => {
    res.json({ runs: service.getBacktestRuns(40) });
  });

  router.get('/backtest/runs/:id', (req, res) => {
    const run = service.getBacktestRunById(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Backtest run not found' });
      return;
    }
    res.json(run);
  });

  router.delete('/backtest/runs/:id', (req, res) => {
    const deleted = service.deleteBacktestRun(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Backtest run not found' });
      return;
    }
    res.json({ ok: true, runs: service.getBacktestRuns(40) });
  });

  // ==========================================================================
  // Best Strategy Discovery & Optimization Scanner Endpoints
  // ==========================================================================

  router.get('/discovery/status', (_req, res) => {
    res.json({ progress: service.getDiscoveryProgress() });
  });

  router.post('/discovery/scan', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clampNum = (val: unknown, fallback: number, min: number, max: number) =>
      typeof val === 'number' && Number.isFinite(val)
        ? Math.min(max, Math.max(min, val))
        : fallback;

    const symbolsRaw = Array.isArray(body.symbols)
      ? body.symbols
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.toUpperCase())
          .filter((s): s is InstrumentSymbol => isValidInstrument(s))
      : [];

    const timeframesRaw = Array.isArray(body.timeframes)
      ? body.timeframes.filter(
          (tf): tf is Timeframe => typeof tf === 'string' && isValidTimeframe(tf)
        )
      : [];

    const scopeRaw = body.strategyScope;
    const strategyScope: DiscoveryStrategyScope =
      scopeRaw === 'all' || scopeRaw === 'category' || scopeRaw === 'core' ? scopeRaw : 'core';

    const validCategories = new Set<BacktestStrategyCategory>([
      'SMC',
      'Price Action',
      'Chart Patterns',
      'Support & Resistance',
      'Hybrid SMC/PA',
    ]);
    const categories = Array.isArray(body.categories)
      ? body.categories.filter(
          (c): c is BacktestStrategyCategory =>
            typeof c === 'string' && validCategories.has(c as BacktestStrategyCategory)
        )
      : undefined;

    const progress = service.startDiscoveryScan({
      symbols: symbolsRaw.length > 0 ? symbolsRaw : undefined,
      timeframes: timeframesRaw.length > 0 ? timeframesRaw : undefined,
      barsPerTimeframe: Math.round(clampNum(body.barsPerTimeframe, 900, 240, 20000)),
      initialCapital: clampNum(body.initialCapital, 10000, 100, 100000000),
      riskPerTradePercent: clampNum(body.riskPerTradePercent, 1.0, 0.1, 10),
      commissionBps: clampNum(body.commissionBps, 4, 0, 50),
      slippageBps: clampNum(body.slippageBps, 2, 0, 50),
      minRiskReward: clampNum(body.minRiskReward, 1.5, 1.0, 5.0),
      moveStopToBreakevenAfterTp1:
        typeof body.moveStopToBreakevenAfterTp1 === 'boolean'
          ? body.moveStopToBreakevenAfterTp1
          : true,
      strategyScope,
      categories: categories && categories.length > 0 ? categories : undefined,
      minOosTradesForValidation: Math.round(
        clampNum(body.minOosTradesForValidation, 4, 2, 30)
      ),
      minTotalSampleForValidation: Math.round(
        clampNum(body.minTotalSampleForValidation, 10, 6, 80)
      ),
    });

    res.status(202).json({ progress });
  });

  router.get('/discovery/runs', (_req, res) => {
    res.json({ runs: service.getDiscoveryRuns(25) });
  });

  router.get('/discovery/runs/:id', (req, res) => {
    const run = service.getDiscoveryRunById(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Discovery scan run not found' });
      return;
    }
    res.json(run);
  });

  router.delete('/discovery/runs/:id', (req, res) => {
    const deleted = service.deleteDiscoveryRun(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Discovery scan run not found' });
      return;
    }
    res.json({ ok: true, runs: service.getDiscoveryRuns(25) });
  });

  router.get('/discovery/runs/:id/combinations/:comboKey', async (req, res) => {
    try {
      const detail = await service.inspectDiscoveryCombination(
        req.params.id,
        decodeURIComponent(req.params.comboKey)
      );
      res.json(detail);
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Unable to load combination detail',
      });
    }
  });

  router.get('/live-market-strategy/:symbol/:timeframe', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const timeframe = req.params.timeframe;
      if (!isValidInstrument(symbol) || !isValidTimeframe(timeframe)) {
        res.status(400).json({ error: 'Invalid instrument or timeframe' });
        return;
      }
      const conditionFilter: LiveConditionFilterMode =
        req.query.filter === 'matched_conditions' ? 'matched_conditions' : 'all';
      const parsedLimit = Number(req.query.limit);
      const maxRecommendations = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.round(parsedLimit)))
        : 50;
      const report = await service.getLiveMarketStrategyReport(symbol, timeframe, {
        conditionFilter,
        maxRecommendations,
      });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // --- Trade Journal Endpoints ---
  router.get('/journal', (_req, res) => {
    res.json({ entries: service.getJournalEntries() });
  });

  router.patch('/journal/:id', (req, res) => {
    const updated = service.updateJournalEntry(req.params.id, req.body ?? {});
    if (!updated) {
      res.status(404).json({ error: 'Journal entry not found' });
      return;
    }
    res.json({ entry: updated, entries: service.getJournalEntries() });
  });

  router.delete('/journal/:id', (req, res) => {
    const deleted = service.deleteJournalEntry(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Journal entry not found' });
      return;
    }
    res.json({ ok: true, deletedId: req.params.id, entries: service.getJournalEntries() });
  });

  router.delete('/journal', (_req, res) => {
    const count = service.clearJournalEntries();
    res.json({ ok: true, deletedCount: count, entries: [] });
  });

  // --- Paper Execution & Risk Endpoints ---
  router.post('/paper/execute/:signalId', (req, res) => {
    const result = service.executeSignalPaper(req.params.signalId);
    if (!result.success) {
      res.status(400).json({ error: result.rejectionReason ?? 'Paper execution failed' });
      return;
    }
    res.json({
      ok: true,
      order: result.order,
      position: result.position,
      journalEntry: result.journalEntry,
      positions: service.getPaperPositions(),
      orders: service.getPaperOrders(),
      riskSnapshot: service.getRiskSnapshot(),
    });
  });

  router.post('/paper/positions/:id/close', (req, res) => {
    const result = service.closePaperPosition(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'Unable to close paper position' });
      return;
    }
    res.json({
      ok: true,
      position: result.position,
      journalEntry: result.journalEntry,
      positions: service.getPaperPositions(),
      orders: service.getPaperOrders(),
      riskSnapshot: service.getRiskSnapshot(),
    });
  });

  router.post('/paper/reset', (req, res) => {
    const startingEquity =
      typeof req.body?.startingEquity === 'number' && Number.isFinite(req.body.startingEquity)
        ? Math.max(100, Math.min(100_000_000, req.body.startingEquity))
        : undefined;
    const state = service.resetPaperAccount(startingEquity);
    res.json({ ok: true, ...state });
  });

  router.get('/paper/positions', (_req, res) => {
    res.json({ positions: service.getPaperPositions() });
  });

  router.get('/paper/orders', (_req, res) => {
    res.json({ orders: service.getPaperOrders() });
  });

  router.put('/risk/settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clamp = (val: unknown, min: number, max: number) =>
      typeof val === 'number' && Number.isFinite(val) ? Math.min(max, Math.max(min, val)) : undefined;

    const patch: Partial<RiskSettings> = {};
    const eq = clamp(body.accountEquity, 100, 100_000_000);
    if (eq !== undefined) patch.accountEquity = eq;
    const rpt = clamp(body.riskPerTradePercent, 0.05, 10);
    if (rpt !== undefined) patch.riskPerTradePercent = rpt;
    const maxRpt = clamp(body.maxRiskPerTradePercent, 0.05, 15);
    if (maxRpt !== undefined) patch.maxRiskPerTradePercent = maxRpt;
    const maxOpen = clamp(body.maxTotalOpenRiskPercent, 0.1, 25);
    if (maxOpen !== undefined) patch.maxTotalOpenRiskPercent = maxOpen;
    const maxDailyLoss = clamp(body.maxDailyLossPercent, 0.2, 25);
    if (maxDailyLoss !== undefined) patch.maxDailyLossPercent = maxDailyLoss;
    const maxInst = clamp(body.maxOpenPositionsPerInstrument, 1, 10);
    if (maxInst !== undefined) patch.maxOpenPositionsPerInstrument = Math.round(maxInst);
    const minRr = clamp(body.minPlannedNetRR, 0.5, 10);
    if (minRr !== undefined) patch.minPlannedNetRR = minRr;
    if (typeof body.autoExecuteConfirmedSignals === 'boolean') {
      patch.autoExecuteConfirmedSignals = body.autoExecuteConfirmedSignals;
    }

    const riskSnapshot = service.updateRiskSettings(patch);
    res.json({ ok: true, riskSnapshot });
  });

  router.post('/risk/kill-switch', (req, res) => {
    const engage = req.body?.engage !== false;
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Operator triggered emergency kill switch';
    const snapshot = engage ? service.engageKillSwitch(reason) : service.disengageKillSwitch();
    res.json({ ok: true, riskSnapshot: snapshot });
  });

  router.get('/risk/snapshot', (_req, res) => {
    res.json(service.getRiskSnapshot());
  });

  // --- MT5 Bridge Ingestion, Status & Execution Command Endpoints ---
  router.post('/mt5/bridge/ingest', authMiddleware, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = service.handleMt5Ingest(body);
    const commands =
      typeof (service as any).collectPendingMt5Commands === 'function'
        ? service.collectPendingMt5Commands()
        : [];
    res.json({
      ok: true,
      receivedType: typeof body.type === 'string' ? body.type : 'heartbeat',
      connected: status.connected,
      timestamp: Date.now(),
      commands,
    });
  });

  router.get('/mt5/status', (_req, res) => {
    res.json(service.getMt5Status());
  });

  router.get('/mt5/execution', (_req, res) => {
    res.json(service.getMt5ExecutionOverview());
  });

  router.put('/mt5/execution/settings', (req, res) => {
    const settings = service.updateMt5ExecutionSettings(req.body ?? {});
    res.json({
      ok: true,
      settings,
      overview: service.getMt5ExecutionOverview(),
    });
  });

  router.post('/mt5/execution/execute/:signalId', (req, res) => {
    const result = service.executeSignalMt5(req.params.signalId, false);
    if (!result.success) {
      res.status(400).json({ error: result.rejectionReason ?? 'MT5 signal execution rejected' });
      return;
    }
    res.json({
      ok: true,
      trade: result.trade,
      command: result.command,
      overview: service.getMt5ExecutionOverview(),
    });
  });

  router.post('/mt5/execution/trades/:id/breakeven', (req, res) => {
    const result = service.moveMt5TradeToBreakeven(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'Unable to move SL to breakeven' });
      return;
    }
    res.json({ ok: true, overview: service.getMt5ExecutionOverview() });
  });

  router.post('/mt5/execution/trades/:id/trail-tp1', (req, res) => {
    const result = service.trailMt5TradeToTp1(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'Unable to trail SL to TP1' });
      return;
    }
    res.json({ ok: true, overview: service.getMt5ExecutionOverview() });
  });

  router.post('/mt5/execution/trades/:id/close', (req, res) => {
    const result = service.closeMt5Trade(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'Unable to close MT5 trade' });
      return;
    }
    res.json({ ok: true, overview: service.getMt5ExecutionOverview() });
  });

  router.post('/mt5/execution/trades/close-all', (_req, res) => {
    service.closeAllMt5Trades();
    res.json({ ok: true, overview: service.getMt5ExecutionOverview() });
  });

  router.post('/mt5/execution/commands/:id/cancel', (req, res) => {
    const cmd = service.cancelMt5Command(req.params.id);
    if (!cmd) {
      res.status(404).json({ error: 'Pending command not found' });
      return;
    }
    res.json({ ok: true, command: cmd, overview: service.getMt5ExecutionOverview() });
  });

  router.post('/mt5/test-ping', (req, res) => {
    const proto =
      typeof req.headers['x-forwarded-proto'] === 'string'
        ? req.headers['x-forwarded-proto'].split(',')[0].trim()
        : req.protocol || 'http';
    const host = req.headers.host || 'localhost:3000';
    const origin = `${proto}://${host}`;
    res.json({
      ok: true,
      endpointReachable: true,
      allowedOrigin: origin,
      ingestUrl: `${origin}/api/mt5/bridge/ingest`,
      requiresApiToken: Boolean(process.env.TERMINAL_API_TOKEN),
      status: service.getMt5Status(),
      timestamp: Date.now(),
    });
  });

  router.get('/mt5/ea/download', (req, res) => {
    const eaPath = path.resolve(process.cwd(), 'mt5', 'GoldBtcTerminalBridge.mq5');
    if (!fs.existsSync(eaPath)) {
      res.status(404).json({ error: 'GoldBtcTerminalBridge.mq5 not found on server' });
      return;
    }
    const proto =
      typeof req.headers['x-forwarded-proto'] === 'string'
        ? req.headers['x-forwarded-proto'].split(',')[0].trim()
        : req.protocol || 'http';
    const host = req.headers.host || 'localhost:3000';
    const targetUrl = `${proto}://${host}/api/mt5/bridge/ingest`;

    const raw = fs.readFileSync(eaPath, 'utf8');
    const configured = raw.replace(
      'http://localhost:3000/api/mt5/bridge/ingest',
      targetUrl
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="GoldBtcTerminalBridge.mq5"');
    res.send(configured);
  });

  // --- Market Data Integrity Report Endpoint ---
  router.get('/integrity/:symbol/:timeframe', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const timeframe = req.params.timeframe;
    if (!isValidInstrument(symbol) || !isValidTimeframe(timeframe)) {
      res.status(400).json({ error: 'Invalid instrument or timeframe' });
      return;
    }
    const candles = await service.marketData.ensureHistory(symbol, timeframe);
    const quote = service.marketData.getQuote(symbol);
    const provider = service.marketData.getProviderStatus(symbol);
    const report = evaluateMarketDataIntegrity(
      symbol,
      timeframe,
      candles,
      quote,
      provider,
      service.getSignalSettings(),
      Date.now()
    );
    res.json(report);
  });

  return router;
}


