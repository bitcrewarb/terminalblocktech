import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  InstrumentSymbol,
  SignalDeleteScope,
  SignalDirection,
  SignalLifecycleState,
  SignalNotification,
  Timeframe,
  TradingSignal,
} from '../../shared/types/index.ts';

export interface SignalQueryFilters {
  symbol?: InstrumentSymbol;
  direction?: SignalDirection;
  state?: SignalLifecycleState;
  limit?: number;
}

const CLOSED_STATES: SignalLifecycleState[] = [
  'TP3_HIT',
  'STOPPED',
  'INVALIDATED',
  'EXPIRED',
  'CANCELLED',
];

/**
 * Persistent SQLite store for institutional BUY/SELL signals and signal notifications.
 * Uses Node's built-in node:sqlite (DatabaseSync) with WAL mode for crash-safe durability.
 */
export class SignalSqliteStore {
  private readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ??
      process.env.SIGNAL_DB_PATH ??
      path.resolve(process.cwd(), 'data', 'signals.sqlite');

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

      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        entry_timeframe TEXT NOT NULL,
        setup_timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        provisional INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL,
        classification TEXT NOT NULL,
        entry_price REAL NOT NULL,
        entry_zone_lower REAL NOT NULL,
        entry_zone_upper REAL NOT NULL,
        stop_loss REAL NOT NULL,
        invalidation_level REAL NOT NULL,
        primary_rr REAL NOT NULL,
        max_rr REAL NOT NULL,
        realized_r REAL,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        activated_at INTEGER,
        closed_at INTEGER,
        candle_time INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        generation_summary TEXT,
        outcome_summary TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals(symbol, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_state ON signals(state);

      CREATE TABLE IF NOT EXISTS signal_notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        price REAL NOT NULL,
        score INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signotif_timestamp ON signal_notifications(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_signotif_signal_id ON signal_notifications(signal_id);
    `);

    const sigCols = this.db
      .prepare('PRAGMA table_info(signals)')
      .all() as Array<{ name: string }>;
    if (!sigCols.some((c) => c.name === 'generation_summary')) {
      this.db.exec('ALTER TABLE signals ADD COLUMN generation_summary TEXT');
    }
    if (!sigCols.some((c) => c.name === 'outcome_summary')) {
      this.db.exec('ALTER TABLE signals ADD COLUMN outcome_summary TEXT');
    }

    // Safe migration if table existed without type column
    const cols = this.db
      .prepare('PRAGMA table_info(signal_notifications)')
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'type')) {
      this.db.exec("ALTER TABLE signal_notifications ADD COLUMN type TEXT NOT NULL DEFAULT 'signal_confirmed'");
    }
  }

  public upsertSignal(signal: TradingSignal): void {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        id, symbol, entry_timeframe, setup_timeframe, direction, state,
        provisional, score, classification, entry_price, entry_zone_lower,
        entry_zone_upper, stop_loss, invalidation_level, primary_rr, max_rr,
        realized_r, created_at, confirmed_at, activated_at, closed_at,
        candle_time, updated_at, generation_summary, outcome_summary, payload_json
      ) VALUES (
        @id, @symbol, @entryTimeframe, @setupTimeframe, @direction, @state,
        @provisional, @score, @classification, @entryPrice, @entryZoneLower,
        @entryZoneUpper, @stopLoss, @invalidationLevel, @primaryRR, @maxRR,
        @realizedR, @createdAt, @confirmedAt, @activatedAt, @closedAt,
        @candleTime, @updatedAt, @generationSummary, @outcomeSummary, @payloadJson
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        provisional = excluded.provisional,
        score = excluded.score,
        classification = excluded.classification,
        entry_price = excluded.entry_price,
        entry_zone_lower = excluded.entry_zone_lower,
        entry_zone_upper = excluded.entry_zone_upper,
        stop_loss = excluded.stop_loss,
        invalidation_level = excluded.invalidation_level,
        primary_rr = excluded.primary_rr,
        max_rr = excluded.max_rr,
        realized_r = excluded.realized_r,
        confirmed_at = excluded.confirmed_at,
        activated_at = excluded.activated_at,
        closed_at = excluded.closed_at,
        candle_time = excluded.candle_time,
        updated_at = excluded.updated_at,
        generation_summary = excluded.generation_summary,
        outcome_summary = excluded.outcome_summary,
        payload_json = excluded.payload_json
    `);

    stmt.run({
      id: signal.id,
      symbol: signal.symbol,
      entryTimeframe: signal.entryTimeframe,
      setupTimeframe: signal.setupTimeframe,
      direction: signal.direction,
      state: signal.state,
      provisional: signal.provisional ? 1 : 0,
      score: signal.score,
      classification: signal.classification,
      entryPrice: signal.entryPrice,
      entryZoneLower: signal.entryZone.lower,
      entryZoneUpper: signal.entryZone.upper,
      stopLoss: signal.stopLoss,
      invalidationLevel: signal.invalidationLevel,
      primaryRR: signal.primaryRR,
      maxRR: signal.maxRR,
      realizedR: signal.realizedR,
      createdAt: signal.createdAt,
      confirmedAt: signal.confirmedAt,
      activatedAt: signal.activatedAt,
      closedAt: signal.closedAt,
      candleTime: signal.candleTime,
      updatedAt: Date.now(),
      generationSummary: signal.generationSummary ?? null,
      outcomeSummary: signal.outcomeSummary ?? null,
      payloadJson: JSON.stringify(signal),
    });
  }

  public getAllSignals(filters: SignalQueryFilters = {}): TradingSignal[] {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};

    if (filters.symbol) {
      clauses.push('symbol = @symbol');
      params.symbol = filters.symbol;
    }
    if (filters.direction) {
      clauses.push('direction = @direction');
      params.direction = filters.direction;
    }
    if (filters.state) {
      clauses.push('state = @state');
      params.state = filters.state;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = filters.limit && filters.limit > 0 ? `LIMIT ${Math.floor(filters.limit)}` : '';

    const rows = this.db
      .prepare(`SELECT payload_json FROM signals ${where} ORDER BY created_at DESC ${limitClause}`)
      .all(params) as Array<{ payload_json: string }>;

    const signals: TradingSignal[] = [];
    for (const row of rows) {
      try {
        signals.push(JSON.parse(row.payload_json) as TradingSignal);
      } catch {
        // Ignore malformed legacy payload rows
      }
    }
    return signals;
  }

  public getSignalById(id: string): TradingSignal | null {
    const row = this.db
      .prepare('SELECT payload_json FROM signals WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as TradingSignal;
    } catch {
      return null;
    }
  }

  public deleteSignalById(id: string): boolean {
    const res = this.db.prepare('DELETE FROM signals WHERE id = ?').run(id);
    if (Number(res.changes) > 0) {
      this.db.prepare('DELETE FROM signal_notifications WHERE signal_id = ?').run(id);
      return true;
    }
    return false;
  }

  public deleteSignalsByIds(ids: string[]): string[] {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return [];

    const deletedIds: string[] = [];
    const checkStmt = this.db.prepare('SELECT id FROM signals WHERE id = ?');
    const delSigStmt = this.db.prepare('DELETE FROM signals WHERE id = ?');
    const delNotifStmt = this.db.prepare('DELETE FROM signal_notifications WHERE signal_id = ?');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of unique) {
        const exists = checkStmt.get(id) as { id: string } | undefined;
        if (exists) {
          delSigStmt.run(id);
          delNotifStmt.run(id);
          deletedIds.push(id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return deletedIds;
  }

  public deleteAllSignals(scope: SignalDeleteScope = 'all'): string[] {
    let targetIds: Array<{ id: string }> = [];
    if (scope === 'all') {
      targetIds = this.db.prepare('SELECT id FROM signals').all() as Array<{ id: string }>;
    } else if (scope === 'watching') {
      targetIds = this.db
        .prepare("SELECT id FROM signals WHERE state = 'WATCHING'")
        .all() as Array<{ id: string }>;
    } else {
      const placeholders = CLOSED_STATES.map(() => '?').join(',');
      targetIds = this.db
        .prepare(`SELECT id FROM signals WHERE state IN (${placeholders})`)
        .all(...CLOSED_STATES) as Array<{ id: string }>;
    }

    const ids = targetIds.map((r) => r.id);
    return this.deleteSignalsByIds(ids);
  }

  public upsertNotification(notif: SignalNotification): void {
    this.db
      .prepare(
        `
        INSERT INTO signal_notifications (
          id, type, signal_id, symbol, timeframe, direction, state,
          title, message, price, score, timestamp
        ) VALUES (
          @id, @type, @signalId, @symbol, @timeframe, @direction, @state,
          @title, @message, @price, @score, @timestamp
        )
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          state = excluded.state,
          title = excluded.title,
          message = excluded.message,
          price = excluded.price,
          score = excluded.score,
          timestamp = excluded.timestamp
      `
      )
      .run({
        id: notif.id,
        type: notif.type,
        signalId: notif.signalId,
        symbol: notif.symbol,
        timeframe: notif.timeframe,
        direction: notif.direction,
        state: notif.state,
        title: notif.title,
        message: notif.message,
        price: notif.price,
        score: notif.score,
        timestamp: notif.timestamp,
      });
  }

  public getNotifications(limit = 120): SignalNotification[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, type, signal_id, symbol, timeframe, direction, state, title, message, price, score, timestamp
        FROM signal_notifications
        ORDER BY timestamp DESC
        LIMIT ?
      `
      )
      .all(Math.max(1, limit)) as Array<{
      id: string;
      type: SignalNotification['type'];
      signal_id: string;
      symbol: InstrumentSymbol;
      timeframe: Timeframe;
      direction: SignalDirection;
      state: SignalLifecycleState;
      title: string;
      message: string;
      price: number;
      score: number;
      timestamp: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      signalId: r.signal_id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      state: r.state,
      title: r.title,
      message: r.message,
      price: r.price,
      score: r.score,
      timestamp: r.timestamp,
    }));
  }

  public close(): void {
    this.db.close();
  }
}
