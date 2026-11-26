import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BacktestRunResult,
  BacktestRunSummary,
  BacktestStrategyId,
  DiscoveryRunSummary,
  DiscoveryScanRun,
  InstrumentSymbol,
  LiveStrategyBasketConfig,
  Timeframe,
} from '../../shared/types/index.ts';

/**
 * Persistent SQLite archive for completed multi-strategy backtest runs
 * and the active auto-running live strategy basket.
 */
export class BacktestSqliteStore {
  private readonly db: DatabaseSync;
  public readonly dbPath: string;
  private cachedDiscoveryRuns: { limit: number; runs: DiscoveryScanRun[] } | null = null;
  private cachedBacktestRuns: { limit: number; runs: BacktestRunResult[] } | null = null;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ??
      process.env.BACKTEST_DB_PATH ??
      path.resolve(process.cwd(), 'data', 'backtests.sqlite');

    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS backtest_runs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        bars INTEGER NOT NULL,
        best_strategy_id TEXT,
        best_strategy_name TEXT,
        best_net_return_percent REAL,
        best_profit_factor REAL,
        best_win_rate REAL,
        strategy_count INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol ON backtest_runs(symbol, created_at DESC);

      CREATE TABLE IF NOT EXISTS live_strategy_basket (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_runs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        strategies_count INTEGER NOT NULL,
        instruments_count INTEGER NOT NULL,
        timeframes_count INTEGER NOT NULL,
        validated_count INTEGER NOT NULL,
        preliminary_count INTEGER NOT NULL,
        total_combinations INTEGER NOT NULL,
        top_combo_label TEXT,
        top_combo_oos_score REAL,
        top_combo_oos_return_percent REAL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_runs_created ON discovery_runs(created_at DESC);
    `);
  }

  public saveRun(run: BacktestRunResult): void {
    const best = run.bestStrategyId
      ? run.strategies.find((s) => s.strategy.id === run.bestStrategyId) ?? run.strategies[0]
      : run.strategies[0];

    const stmt = this.db.prepare(`
      INSERT INTO backtest_runs (
        id, created_at, duration_ms, symbol, timeframe, bars,
        best_strategy_id, best_strategy_name, best_net_return_percent,
        best_profit_factor, best_win_rate, strategy_count, payload_json
      ) VALUES (
        @id, @createdAt, @durationMs, @symbol, @timeframe, @bars,
        @bestStrategyId, @bestStrategyName, @bestNetReturnPercent,
        @bestProfitFactor, @bestWinRate, @strategyCount, @payloadJson
      )
      ON CONFLICT(id) DO UPDATE SET
        duration_ms = excluded.duration_ms,
        best_strategy_id = excluded.best_strategy_id,
        best_strategy_name = excluded.best_strategy_name,
        best_net_return_percent = excluded.best_net_return_percent,
        best_profit_factor = excluded.best_profit_factor,
        best_win_rate = excluded.best_win_rate,
        strategy_count = excluded.strategy_count,
        payload_json = excluded.payload_json
    `);

    stmt.run({
      id: run.id,
      createdAt: run.createdAt,
      durationMs: run.durationMs,
      symbol: run.config.symbol,
      timeframe: run.config.timeframe,
      bars: run.dataRange.totalBars,
      bestStrategyId: best?.strategy.id ?? null,
      bestStrategyName: best?.strategy.name ?? null,
      bestNetReturnPercent: best?.metrics.netReturnPercent ?? null,
      bestProfitFactor: best?.metrics.profitFactor ?? null,
      bestWinRate: best?.metrics.winRate ?? null,
      strategyCount: run.strategies.length,
      payloadJson: JSON.stringify(run),
    });
    this.db.exec(`
      DELETE FROM backtest_runs
      WHERE id NOT IN (SELECT id FROM backtest_runs ORDER BY created_at DESC LIMIT 25)
    `);
    this.cachedBacktestRuns = null;
  }

  public listRuns(limit = 40): BacktestRunSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          id, created_at, duration_ms, symbol, timeframe, bars,
          best_strategy_id, best_strategy_name, best_net_return_percent,
          best_profit_factor, best_win_rate, strategy_count
        FROM backtest_runs
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(Math.max(1, limit)) as Array<{
      id: string;
      created_at: number;
      duration_ms: number;
      symbol: InstrumentSymbol;
      timeframe: Timeframe;
      bars: number;
      best_strategy_id: BacktestStrategyId | null;
      best_strategy_name: string | null;
      best_net_return_percent: number | null;
      best_profit_factor: number | null;
      best_win_rate: number | null;
      strategy_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      durationMs: r.duration_ms,
      symbol: r.symbol,
      timeframe: r.timeframe,
      bars: r.bars,
      bestStrategyId: r.best_strategy_id,
      bestStrategyName: r.best_strategy_name,
      bestNetReturnPercent: r.best_net_return_percent,
      bestProfitFactor: r.best_profit_factor,
      bestWinRate: r.best_win_rate,
      strategyCount: r.strategy_count,
    }));
  }

  public getRunById(id: string): BacktestRunResult | null {
    const row = this.db
      .prepare('SELECT payload_json FROM backtest_runs WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as BacktestRunResult;
    } catch {
      return null;
    }
  }

  public deleteRun(id: string): boolean {
    const res = this.db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(id);
    this.cachedBacktestRuns = null;
    return Number(res.changes) > 0;
  }

  public clearRuns(): number {
    const res = this.db.prepare('DELETE FROM backtest_runs').run();
    this.cachedBacktestRuns = null;
    return Number(res.changes);
  }

  public getLiveBasket(): LiveStrategyBasketConfig | null {
    const row = this.db
      .prepare('SELECT payload_json FROM live_strategy_basket WHERE id = 1')
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as LiveStrategyBasketConfig;
    } catch {
      return null;
    }
  }

  public saveLiveBasket(basket: LiveStrategyBasketConfig): void {
    this.db
      .prepare(
        `
        INSERT INTO live_strategy_basket (id, updated_at, payload_json)
        VALUES (1, @updatedAt, @payloadJson)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `
      )
      .run({
        updatedAt: basket.updatedAt,
        payloadJson: JSON.stringify(basket),
      });
  }

  public clearLiveBasket(): void {
    this.db.prepare('DELETE FROM live_strategy_basket WHERE id = 1').run();
  }

  public saveDiscoveryRun(run: DiscoveryScanRun): void {
    const top = run.combinations[0];
    const topLabel = top
      ? `${top.strategy.name} · ${top.symbol} ${top.timeframe} · ${top.regime}`
      : null;

    this.db
      .prepare(
        `
        INSERT INTO discovery_runs (
          id, created_at, duration_ms, strategies_count,
          instruments_count, timeframes_count, validated_count,
          preliminary_count, total_combinations, top_combo_label,
          top_combo_oos_score, top_combo_oos_return_percent, payload_json
        ) VALUES (
          @id, @createdAt, @durationMs, @strategiesCount,
          @instrumentsCount, @timeframesCount, @validatedCount,
          @preliminaryCount, @totalCombinations, @topComboLabel,
          @topComboOosScore, @topComboOosReturnPercent, @payloadJson
        )
        ON CONFLICT(id) DO UPDATE SET
          duration_ms = excluded.duration_ms,
          validated_count = excluded.validated_count,
          preliminary_count = excluded.preliminary_count,
          total_combinations = excluded.total_combinations,
          top_combo_label = excluded.top_combo_label,
          top_combo_oos_score = excluded.top_combo_oos_score,
          top_combo_oos_return_percent = excluded.top_combo_oos_return_percent,
          payload_json = excluded.payload_json
      `
      )
      .run({
        id: run.id,
        createdAt: run.createdAt,
        durationMs: run.durationMs,
        strategiesCount: run.strategiesEvaluatedCount,
        instrumentsCount: run.config.symbols.length,
        timeframesCount: run.config.timeframes.length,
        validatedCount: run.summaryStats.validatedCount,
        preliminaryCount: run.summaryStats.preliminaryCount,
        totalCombinations: run.combinations.length,
        topComboLabel: topLabel,
        topComboOosScore: top?.oosScore ?? null,
        topComboOosReturnPercent: top?.oosMetrics.netReturnPercent ?? null,
        payloadJson: JSON.stringify(run),
      });
    this.db.exec(`
      DELETE FROM discovery_runs
      WHERE id NOT IN (SELECT id FROM discovery_runs ORDER BY created_at DESC LIMIT 15)
    `);
    this.cachedDiscoveryRuns = null;
  }

  public listDiscoveryRuns(limit = 25): DiscoveryRunSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          id, created_at, duration_ms, strategies_count,
          instruments_count, timeframes_count, validated_count,
          preliminary_count, total_combinations, top_combo_label,
          top_combo_oos_score, top_combo_oos_return_percent
        FROM discovery_runs
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(Math.max(1, limit)) as Array<{
      id: string;
      created_at: number;
      duration_ms: number;
      strategies_count: number;
      instruments_count: number;
      timeframes_count: number;
      validated_count: number;
      preliminary_count: number;
      total_combinations: number;
      top_combo_label: string | null;
      top_combo_oos_score: number | null;
      top_combo_oos_return_percent: number | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      durationMs: r.duration_ms,
      strategiesEvaluatedCount: r.strategies_count,
      instrumentsCount: r.instruments_count,
      timeframesCount: r.timeframes_count,
      validatedCount: r.validated_count,
      preliminaryCount: r.preliminary_count,
      totalCombinations: r.total_combinations,
      topComboLabel: r.top_combo_label,
      topComboOosScore: r.top_combo_oos_score,
      topComboOosReturnPercent: r.top_combo_oos_return_percent,
    }));
  }

  public getDiscoveryRunById(id: string): DiscoveryScanRun | null {
    const row = this.db
      .prepare('SELECT payload_json FROM discovery_runs WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as DiscoveryScanRun;
    } catch {
      return null;
    }
  }

  public deleteDiscoveryRun(id: string): boolean {
    const res = this.db.prepare('DELETE FROM discovery_runs WHERE id = ?').run(id);
    this.cachedDiscoveryRuns = null;
    return Number(res.changes) > 0;
  }

  public getCachedDiscoveryRuns(limit = 10): DiscoveryScanRun[] {
    const safeLimit = Math.max(1, limit);
    if (this.cachedDiscoveryRuns && this.cachedDiscoveryRuns.limit >= safeLimit) {
      return this.cachedDiscoveryRuns.runs.slice(0, safeLimit);
    }
    const rows = this.db
      .prepare(
        `
        SELECT payload_json
        FROM discovery_runs
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(safeLimit) as Array<{ payload_json: string }>;

    const parsed: DiscoveryScanRun[] = [];
    for (const r of rows) {
      try {
        parsed.push(JSON.parse(r.payload_json) as DiscoveryScanRun);
      } catch {
        // Ignore malformed legacy row
      }
    }
    this.cachedDiscoveryRuns = { limit: safeLimit, runs: parsed };
    return parsed;
  }

  public getCachedBacktestRuns(limit = 25): BacktestRunResult[] {
    const safeLimit = Math.max(1, limit);
    if (this.cachedBacktestRuns && this.cachedBacktestRuns.limit >= safeLimit) {
      return this.cachedBacktestRuns.runs.slice(0, safeLimit);
    }
    const rows = this.db
      .prepare(
        `
        SELECT payload_json
        FROM backtest_runs
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(safeLimit) as Array<{ payload_json: string }>;

    const parsed: BacktestRunResult[] = [];
    for (const r of rows) {
      try {
        parsed.push(JSON.parse(r.payload_json) as BacktestRunResult);
      } catch {
        // Ignore malformed legacy row
      }
    }
    this.cachedBacktestRuns = { limit: safeLimit, runs: parsed };
    return parsed;
  }

  public close(): void {
    this.db.close();
  }
}
