import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AlertNotification,
  AlertRule,
  AuditLogEntry,
  AuthSession,
  AuthUser,
  MT5BridgeStatus,
  MT5ExecutionSettings,
  MT5ManagedTrade,
  MT5TradeCommand,
  PaperOrder,
  PaperPosition,
  SignalSettings,
  TradeJournalEntry,
} from '../shared/types/index.ts';
import { runPlatformMigrations } from './migrations.ts';

export class PlatformSqliteStore {
  private db: DatabaseSync;

  constructor(dbPath = './data/platform.sqlite') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    runPlatformMigrations(this.db);
  }

  public close(): void {
    try {
      // DatabaseSync closes automatically or via GC
    } catch {
      // ignore
    }
  }

  // --- Trade Journal Persistence ---

  public getAllJournalEntries(): TradeJournalEntry[] {
    const rows = this.db.prepare('SELECT * FROM trade_journal ORDER BY executed_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToJournalEntry(r));
  }

  public getJournalEntryById(id: string): TradeJournalEntry | null {
    const row = this.db.prepare('SELECT * FROM trade_journal WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToJournalEntry(row) : null;
  }

  public upsertJournalEntry(entry: TradeJournalEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO trade_journal (
        id, signal_id, execution_id, position_id, symbol, timeframe, direction,
        strategy_id, strategy_name, strategy_version, market_regime, entry_price,
        exit_price, stop_loss, take_profit_1, volume, risk_amount_usd, realized_pnl_usd,
        realized_r, fees_usd, status, outcome, entry_reason, exit_reason, reflection_notes,
        lessons_learned, tags_json, rating, executed_at, closed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exit_price = excluded.exit_price,
        realized_pnl_usd = excluded.realized_pnl_usd,
        realized_r = excluded.realized_r,
        fees_usd = excluded.fees_usd,
        status = excluded.status,
        outcome = excluded.outcome,
        exit_reason = excluded.exit_reason,
        reflection_notes = excluded.reflection_notes,
        lessons_learned = excluded.lessons_learned,
        tags_json = excluded.tags_json,
        rating = excluded.rating,
        closed_at = excluded.closed_at,
        updated_at = excluded.updated_at
    `);

    (stmt.run as any)(
      entry.id,
      entry.signalId,
      entry.executionId,
      entry.positionId,
      entry.symbol,
      entry.timeframe,
      entry.direction,
      entry.strategyId,
      entry.strategyName,
      entry.strategyVersion,
      entry.marketRegime ?? null,
      entry.entryPrice,
      entry.exitPrice ?? null,
      entry.stopLoss,
      entry.takeProfit1,
      entry.volume,
      entry.riskAmountUsd,
      entry.realizedPnlUsd ?? null,
      entry.realizedR ?? null,
      entry.feesUsd,
      entry.status,
      entry.outcome,
      entry.entryReason,
      entry.exitReason ?? null,
      entry.reflectionNotes,
      entry.lessonsLearned,
      JSON.stringify(entry.tags),
      entry.rating ?? null,
      entry.executedAt,
      entry.closedAt ?? null,
      entry.updatedAt
    );
  }

  public deleteJournalEntry(id: string): boolean {
    const res = (this.db.prepare('DELETE FROM trade_journal WHERE id = ?').run as any)(id);
    return Number(res.changes) > 0;
  }

  public deleteAllJournalEntries(): number {
    const res = (this.db.prepare('DELETE FROM trade_journal').run as any)();
    return Number(res.changes);
  }

  private rowToJournalEntry(r: Record<string, unknown>): TradeJournalEntry {
    let tags: string[] = [];
    try {
      tags = JSON.parse(String(r.tags_json ?? '[]')) as string[];
    } catch {
      tags = [];
    }
    return {
      id: String(r.id),
      signalId: String(r.signal_id),
      executionId: String(r.execution_id),
      positionId: String(r.position_id),
      symbol: r.symbol as TradeJournalEntry['symbol'],
      timeframe: r.timeframe as TradeJournalEntry['timeframe'],
      direction: r.direction as TradeJournalEntry['direction'],
      strategyId: r.strategy_id as TradeJournalEntry['strategyId'],
      strategyName: String(r.strategy_name),
      strategyVersion: String(r.strategy_version),
      marketRegime: r.market_regime ? String(r.market_regime) : undefined,
      entryPrice: Number(r.entry_price),
      exitPrice: r.exit_price !== null && r.exit_price !== undefined ? Number(r.exit_price) : null,
      stopLoss: Number(r.stop_loss),
      takeProfit1: Number(r.take_profit_1),
      volume: Number(r.volume),
      riskAmountUsd: Number(r.risk_amount_usd),
      realizedPnlUsd: r.realized_pnl_usd !== null && r.realized_pnl_usd !== undefined ? Number(r.realized_pnl_usd) : null,
      realizedR: r.realized_r !== null && r.realized_r !== undefined ? Number(r.realized_r) : null,
      feesUsd: Number(r.fees_usd),
      status: r.status as TradeJournalEntry['status'],
      outcome: r.outcome as TradeJournalEntry['outcome'],
      entryReason: String(r.entry_reason),
      exitReason: r.exit_reason !== null && r.exit_reason !== undefined ? String(r.exit_reason) : null,
      reflectionNotes: String(r.reflection_notes ?? ''),
      lessonsLearned: String(r.lessons_learned ?? ''),
      tags,
      rating: r.rating !== null && r.rating !== undefined ? Number(r.rating) : null,
      executedAt: Number(r.executed_at),
      closedAt: r.closed_at !== null && r.closed_at !== undefined ? Number(r.closed_at) : null,
      updatedAt: Number(r.updated_at),
    };
  }

  // --- Audit Logs ---

  public logAudit(entry: AuditLogEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, category, action, actor, details, severity, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    (stmt.run as any)(entry.id, entry.category, entry.action, entry.actor, entry.details, entry.severity, entry.timestamp);
  }

  public getAuditLogs(limit = 100): AuditLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      category: r.category as AuditLogEntry['category'],
      action: String(r.action),
      actor: String(r.actor),
      details: String(r.details),
      severity: r.severity as AuditLogEntry['severity'],
      timestamp: Number(r.timestamp),
    }));
  }

  // --- Users & Sessions ---

  public getUserByEmail(email: string): (AuthUser & { passwordHash: string }) | null {
    const row = (this.db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get as any)(
      email.trim()
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      email: String(row.email),
      role: (row.role as AuthUser['role']) ?? 'trader',
      passwordHash: String(row.password_hash),
      createdAt: Number(row.created_at),
      lastLoginAt:
        row.last_login_at !== null && row.last_login_at !== undefined
          ? Number(row.last_login_at)
          : null,
    };
  }

  public createUser(user: AuthUser & { passwordHash: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (id, email, password_hash, role, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    (stmt.run as any)(
      user.id,
      user.email.trim().toLowerCase(),
      user.passwordHash,
      user.role,
      user.createdAt,
      user.lastLoginAt ?? null
    );
  }

  public updateUserLastLogin(userId: string, timestamp: number): void {
    (this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run as any)(
      timestamp,
      userId
    );
  }

  public createSession(session: AuthSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO auth_sessions (token, user_id, email, role, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    (stmt.run as any)(
      session.token,
      session.userId,
      session.email,
      session.role,
      session.createdAt,
      session.expiresAt
    );
  }

  public getSessionByToken(token: string): AuthSession | null {
    const row = (this.db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get as any)(
      token
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      token: String(row.token),
      userId: String(row.user_id),
      email: String(row.email),
      role: (row.role as AuthSession['role']) ?? 'trader',
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  public deleteSession(token: string): boolean {
    const res = (this.db.prepare('DELETE FROM auth_sessions WHERE token = ?').run as any)(token);
    return Number(res.changes) > 0;
  }

  public deleteExpiredSessions(nowMs = Date.now()): void {
    (this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run as any)(nowMs);
  }

  // --- Paper Orders & Positions Persistence ---

  public upsertPaperOrder(order: PaperOrder): void {
    const stmt = this.db.prepare(`
      INSERT INTO paper_order_records (id, signal_id, idempotency_key, status, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json
    `);
    (stmt.run as any)(
      order.id,
      order.signalId,
      order.idempotencyKey,
      order.status,
      order.createdAt,
      JSON.stringify(order)
    );
  }

  public getAllPaperOrders(): PaperOrder[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM paper_order_records ORDER BY created_at DESC')
      .all() as Array<{ payload_json: string }>;
    const out: PaperOrder[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload_json) as PaperOrder);
      } catch {
        // ignore malformed row
      }
    }
    return out;
  }

  public upsertPaperPosition(position: PaperPosition): void {
    const stmt = this.db.prepare(`
      INSERT INTO paper_position_records (id, signal_id, symbol, status, opened_at, closed_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        closed_at = excluded.closed_at,
        payload_json = excluded.payload_json
    `);
    (stmt.run as any)(
      position.id,
      position.signalId,
      position.symbol,
      position.status,
      position.openedAt,
      position.closedAt ?? null,
      JSON.stringify(position)
    );
  }

  public getAllPaperPositions(): PaperPosition[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM paper_position_records ORDER BY opened_at DESC')
      .all() as Array<{ payload_json: string }>;
    const out: PaperPosition[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload_json) as PaperPosition);
      } catch {
        // ignore malformed row
      }
    }
    return out;
  }

  public clearPaperOrdersAndPositions(): void {
    this.db.exec('DELETE FROM paper_order_records; DELETE FROM paper_position_records;');
  }

  // --- Risk Engine State Persistence ---

  public saveRiskEngineState(state: unknown): void {
    const stmt = this.db.prepare(`
      INSERT INTO risk_engine_state (id, payload_json, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify(state), Date.now());
  }

  public loadRiskEngineState<T>(): T | null {
    const row = this.db
      .prepare("SELECT payload_json FROM risk_engine_state WHERE id = 'default'")
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as T;
    } catch {
      return null;
    }
  }

  // --- MT5 Bridge Snapshot & Broker Connections ---

  public saveMt5BridgeSnapshot(status: MT5BridgeStatus): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO mt5_bridge_state (id, payload_json, updated_at)
      VALUES ('primary', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify(status), now);

    if (status.accountNumber) {
      const connStmt = this.db.prepare(`
        INSERT INTO broker_connections (
          id, broker_name, server, login, is_demo, connected, read_only, last_heartbeat_at, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          broker_name = excluded.broker_name,
          server = excluded.server,
          login = excluded.login,
          connected = excluded.connected,
          last_heartbeat_at = excluded.last_heartbeat_at
      `);
      (connStmt.run as any)(
        `mt5:${status.accountNumber}`,
        status.broker ?? 'MetaTrader 5',
        status.server ?? 'Unknown',
        String(status.accountNumber),
        status.connected ? 1 : 0,
        status.lastHeartbeat,
        now
      );
    }
  }

  public loadMt5BridgeSnapshot(): MT5BridgeStatus | null {
    const row = this.db
      .prepare("SELECT payload_json FROM mt5_bridge_state WHERE id = 'primary'")
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as MT5BridgeStatus;
    } catch {
      return null;
    }
  }

  // --- Alert Rules & Alert History Persistence ---

  public saveAlertRules(rules: AlertRule[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO alert_rules_state (id, payload_json, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify(rules), Date.now());
  }

  public loadAlertRules(): AlertRule[] | null {
    const row = this.db
      .prepare("SELECT payload_json FROM alert_rules_state WHERE id = 'default'")
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload_json);
      return Array.isArray(parsed) ? (parsed as AlertRule[]) : null;
    } catch {
      return null;
    }
  }

  public saveAlertNotification(alert: AlertNotification): void {
    const stmt = this.db.prepare(`
      INSERT INTO alert_history_records (id, symbol, type, timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        payload_json = excluded.payload_json
    `);
    (stmt.run as any)(
      alert.id,
      alert.symbol,
      alert.type,
      alert.timestamp,
      JSON.stringify(alert)
    );
    // Prune older entries beyond newest 200 rows
    this.db.exec(`
      DELETE FROM alert_history_records
      WHERE id NOT IN (
        SELECT id FROM alert_history_records ORDER BY timestamp DESC LIMIT 200
      )
    `);
  }

  public getAlertHistory(limit = 80): AlertNotification[] {
    const rows = (this.db
      .prepare('SELECT payload_json FROM alert_history_records ORDER BY timestamp DESC LIMIT ?')
      .all as any)(limit) as Array<{ payload_json: string }>;
    const out: AlertNotification[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload_json) as AlertNotification);
      } catch {
        // ignore malformed row
      }
    }
    return out;
  }

  public clearAlertHistory(): void {
    this.db.exec('DELETE FROM alert_history_records');
  }

  // --- MT5 Execution Settings, Trade Commands & Managed Trades ---

  public saveMt5ExecutionSettings(settings: MT5ExecutionSettings): void {
    const stmt = this.db.prepare(`
      INSERT INTO mt5_execution_settings (id, payload_json, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify(settings), Date.now());
  }

  public loadMt5ExecutionSettings(): MT5ExecutionSettings | null {
    const row = this.db
      .prepare("SELECT payload_json FROM mt5_execution_settings WHERE id = 'default'")
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as MT5ExecutionSettings;
    } catch {
      return null;
    }
  }

  public upsertMt5TradeCommand(cmd: MT5TradeCommand): void {
    const stmt = this.db.prepare(`
      INSERT INTO mt5_trade_commands (id, status, signal_id, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json
    `);
    (stmt.run as any)(cmd.id, cmd.status, cmd.signalId ?? null, cmd.createdAt, JSON.stringify(cmd));
    this.db.exec(`
      DELETE FROM mt5_trade_commands
      WHERE id NOT IN (
        SELECT id FROM mt5_trade_commands ORDER BY created_at DESC LIMIT 250
      )
    `);
  }

  public getMt5TradeCommands(limit = 120): MT5TradeCommand[] {
    const rows = (this.db
      .prepare('SELECT payload_json FROM mt5_trade_commands ORDER BY created_at DESC LIMIT ?')
      .all as any)(limit) as Array<{ payload_json: string }>;
    const out: MT5TradeCommand[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload_json) as MT5TradeCommand);
      } catch {
        // ignore malformed row
      }
    }
    return out;
  }

  public upsertMt5ManagedTrade(trade: MT5ManagedTrade): void {
    const stmt = this.db.prepare(`
      INSERT INTO mt5_managed_trades (id, signal_id, symbol, status, opened_at, closed_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        closed_at = excluded.closed_at,
        payload_json = excluded.payload_json
    `);
    (stmt.run as any)(
      trade.id,
      trade.signalId,
      trade.symbol,
      trade.status,
      trade.openedAt,
      trade.closedAt ?? null,
      JSON.stringify(trade)
    );
  }

  public getAllMt5ManagedTrades(): MT5ManagedTrade[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM mt5_managed_trades ORDER BY opened_at DESC LIMIT 200')
      .all() as Array<{ payload_json: string }>;
    const out: MT5ManagedTrade[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload_json) as MT5ManagedTrade);
      } catch {
        // ignore malformed row
      }
    }
    return out;
  }

  // --- Platform Preferences (Alert System Toggle & Signal Settings) ---

  public getAlertSystemEnabled(): boolean {
    const row = this.db
      .prepare("SELECT payload_json FROM platform_settings WHERE key = 'alert_system_enabled'")
      .get() as { payload_json: string } | undefined;
    if (!row) return false;
    try {
      const parsed = JSON.parse(row.payload_json) as { enabled?: unknown };
      return parsed?.enabled === true;
    } catch {
      return false;
    }
  }

  public setAlertSystemEnabled(enabled: boolean): void {
    const stmt = this.db.prepare(`
      INSERT INTO platform_settings (key, payload_json, updated_at)
      VALUES ('alert_system_enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify({ enabled: Boolean(enabled) }), Date.now());
  }

  public loadSignalSettings(): Partial<SignalSettings> | null {
    const row = this.db
      .prepare("SELECT payload_json FROM platform_settings WHERE key = 'signal_settings'")
      .get() as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload_json);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Partial<SignalSettings>;
      if (obj.smcCriteria && typeof obj.smcCriteria === 'object') {
        obj.smcCriteria = {
          requireOrderBlock: Boolean(obj.smcCriteria.requireOrderBlock),
          requireFairValueGap: Boolean(obj.smcCriteria.requireFairValueGap),
          requireLiquiditySweep: Boolean(obj.smcCriteria.requireLiquiditySweep),
        };
      }
      return obj;
    } catch {
      return null;
    }
  }

  public saveSignalSettings(settings: SignalSettings): void {
    const stmt = this.db.prepare(`
      INSERT INTO platform_settings (key, payload_json, updated_at)
      VALUES ('signal_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    (stmt.run as any)(JSON.stringify(settings), Date.now());
  }
}
