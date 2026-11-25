# GOLD BTC TERMINAL — Production Deployment & MT5 Setup Guide

## 1. Overview
The GOLD BTC TERMINAL is an institutional-grade trading platform featuring:
- Real-time market intelligence & ICT/SMC analysis.
- Multi-dimensional market state classification.
- Strategy Discovery & backtesting engine with walk-forward isolation and zero data leakage.
- Professional BUY/SELL signal engine with closed-candle confirmation.
- Centralized risk management engine enforcing strict account protection rules.
- Paper trading gateway with realistic fees, slippage, and spread modeling.
- Trade journal logging module with post-trade reflections.
- Secure MQL5 WebRequest Expert Advisor bridge for MT5 data synchronization.

---

## 2. Windows MT5 Terminal & EA Installation
1. Install MetaTrader 5 on a compatible Windows VPS or workstation.
2. Ensure **Allow WebRequest for listed URL** is enabled under **Tools > Options > Expert Advisors**:
   - Add `http://localhost:3000` (or your production server domain).
3. Copy `/mt5/GoldBtcTerminalBridge.mq5` into your MT5 terminal's `MQL5/Experts/` folder.
4. Compile `GoldBtcTerminalBridge.mq5` in MetaEditor.
5. Attach the EA to your chart (e.g., XAUUSD 5M) and configure inputs:
   - `InpServerUrl`: `http://your-server-ip:3000/api/mt5/bridge/ingest`
   - `InpApiToken`: Matching `TERMINAL_API_TOKEN` set in your `.env` file.

---

## 3. Environment Configuration
Copy `.env.example` to `.env` and set:
```env
APP_URL="https://your-domain.com"
TERMINAL_API_TOKEN="your_secure_random_bearer_token"
PORT=3000
NODE_ENV="production"
```

---

## 4. Database Backup & Restore
- The terminal stores platform state, audit logs, trade journal entries, and backtest results in `./data/platform.sqlite`, `./data/signals.sqlite`, and `./data/backtests.sqlite`.
- **Backup**:
  ```bash
  sqlite3 data/platform.sqlite ".backup 'backup_platform_$(date +%Y%m%d).sqlite'"
  ```
- **Restore**:
  ```bash
  cp backup_platform_20261122.sqlite data/platform.sqlite
  ```

---

## 5. Troubleshooting & Health Monitoring
- Check health endpoint: `GET /api/health`
- Check market data integrity: `GET /api/integrity/XAUUSD/5m`
- Verify audit logs and risk limits in the Paper & Risk Control modal.
