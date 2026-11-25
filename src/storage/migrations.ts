import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface PlatformDbSchemaMigration {
  version: number;
  description: string;
  sql: string;
}

const PLATFORM_MIGRATIONS: PlatformDbSchemaMigration[] = [
  {
    version: 1,
    description: 'Create initial platform schema for broker connections, health, risk, orders, positions, fills, and trade journal',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS broker_connections (
        id TEXT PRIMARY KEY,
        broker_name TEXT NOT NULL,
        server TEXT NOT NULL,
        login TEXT NOT NULL,
        is_demo INTEGER NOT NULL,
        connected INTEGER NOT NULL,
        read_only INTEGER NOT NULL,
        last_heartbeat_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_data_health (
        symbol TEXT PRIMARY KEY,
        timeframe TEXT NOT NULL,
        healthy INTEGER NOT NULL,
        blocked INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        provider_event_time INTEGER,
        receive_time INTEGER,
        latency_ms INTEGER,
        anomaly_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signal_evidence (
        signal_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        strategy_id TEXT,
        strategy_version TEXT,
        market_regime TEXT,
        score INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_versions (
        strategy_id TEXT PRIMARY KEY,
        strategy_name TEXT NOT NULL,
        version TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calibration_models (
        strategy_id TEXT PRIMARY KEY,
        sample_size INTEGER NOT NULL,
        win_rate_pct REAL,
        ci_lower REAL,
        ci_upper REAL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_orders (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        signal_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        volume REAL NOT NULL,
        requested_price REAL NOT NULL,
        fill_price REAL,
        stop_loss REAL NOT NULL,
        take_profits_json TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        filled_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS paper_positions (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        journal_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profits_json TEXT NOT NULL,
        volume_total REAL NOT NULL,
        volume_remaining REAL NOT NULL,
        risk_amount_usd REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL,
        realized_r REAL NOT NULL,
        status TEXT NOT NULL,
        exit_price REAL,
        exit_reason TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS trade_journal (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_name TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        market_regime TEXT,
        entry_price REAL NOT NULL,
        exit_price REAL,
        stop_loss REAL NOT NULL,
        take_profit_1 REAL NOT NULL,
        volume REAL NOT NULL,
        risk_amount_usd REAL NOT NULL,
        realized_pnl_usd REAL,
        realized_r REAL,
        fees_usd REAL NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        entry_reason TEXT NOT NULL,
        exit_reason TEXT,
        reflection_notes TEXT NOT NULL,
        lessons_learned TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        rating INTEGER,
        executed_at INTEGER NOT NULL,
        closed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details TEXT NOT NULL,
        severity TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'Create users and auth_sessions tables for terminal authentication',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
    `,
  },
  {
    version: 3,
    description: 'Create persistent storage for paper orders, paper positions, risk engine state, and MT5 bridge status',
    sql: `
      CREATE TABLE IF NOT EXISTS paper_order_records (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_position_records (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_engine_state (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mt5_bridge_state (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    description: 'Create persistent storage for user alert rules and triggered alert history',
    sql: `
      CREATE TABLE IF NOT EXISTS alert_rules_state (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_history_records (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history_records(timestamp DESC);
    `,
  },
  {
    version: 5,
    description: 'Create persistent storage for MT5 Demo Execution settings, command queue, and managed trades',
    sql: `
      CREATE TABLE IF NOT EXISTS mt5_execution_settings (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mt5_trade_commands (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        signal_id TEXT,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mt5_commands_created ON mt5_trade_commands(created_at DESC);

      CREATE TABLE IF NOT EXISTS mt5_managed_trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mt5_trades_opened ON mt5_managed_trades(opened_at DESC);
    `,
  },
  {
    version: 6,
    description: 'Create persistent platform_settings table for alert opt-in and signal engine configuration',
    sql: `
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

export function runPlatformMigrations(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);');
  
  const stmt = db.prepare('SELECT MAX(version) as max_v FROM schema_migrations');
  const res = stmt.get() as { max_v: number | null };
  const currentVersion = res?.max_v ?? 0;

  for (const m of PLATFORM_MIGRATIONS) {
    if (m.version > currentVersion) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(m.sql);
        const insert = db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)');
        insert.run(m.version, m.description, Date.now());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`Failed to apply platform migration v${m.version}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
