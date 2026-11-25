import { TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  Candle,
  InstrumentSymbol,
  LiveQuote,
  MarketDataAnomalyCode,
  MarketDataIntegrityReport,
  ProviderStatus,
  SignalSettings,
  Timeframe,
} from '../../shared/types/index.ts';

const MAX_PRICE_JUMP_ATR_MULTIPLIER = 8.0;

export function evaluateMarketDataIntegrity(
  symbol: InstrumentSymbol,
  timeframe: Timeframe,
  candles: Candle[],
  quote: LiveQuote | null,
  providerStatus: ProviderStatus | null,
  settings: SignalSettings,
  nowMs = Date.now()
): MarketDataIntegrityReport {
  const anomalies: Array<{
    code: MarketDataAnomalyCode;
    severity: 'warning' | 'critical';
    message: string;
  }> = [];

  let duplicatesRemoved = 0;
  let outOfOrderFixed = 0;
  let missingIntervalsCount = 0;

  const lastCandle = candles[candles.length - 1];
  const providerEventTime = quote?.providerTimestamp ?? (lastCandle ? lastCandle.time * 1000 : null);
  const receiveTime = quote?.lastUpdateTime ?? nowMs;
  const providerLatencyMs = providerEventTime !== null ? Math.max(0, receiveTime - providerEventTime) : null;

  // 1. Check Broker Disconnected / Status
  if (!providerStatus || providerStatus.connectionStatus === 'ERROR' || providerStatus.connectionStatus === 'DISCONNECTED') {
    anomalies.push({
      code: 'BROKER_DISCONNECTED',
      severity: 'critical',
      message: `Broker connection status is ${providerStatus?.connectionStatus ?? 'UNAVAILABLE'} for ${symbol}`,
    });
  }

  // 2. Check Stale Feed
  if (quote && quote.stale) {
    anomalies.push({
      code: 'STALE_PROVIDER_EVENT',
      severity: 'critical',
      message: `Live quote feed for ${symbol} is flagged stale (delay: ${quote.feedDelaySeconds}s)`,
    });
  }

  if (providerEventTime !== null && nowMs - providerEventTime > 30000) {
    anomalies.push({
      code: 'STALE_CANDLE_STREAM',
      severity: 'warning',
      message: `Provider event timestamp is ${Math.round((nowMs - providerEventTime) / 1000)}s behind system clock`,
    });
  }

  // 3. Inspect Candle Array Integrity
  if (candles.length === 0) {
    anomalies.push({
      code: 'INCOMPLETE_HISTORY',
      severity: 'critical',
      message: `Zero historical candles available for ${symbol} on ${timeframe}`,
    });
  } else {
    const tfSec = TIMEFRAME_SECONDS[timeframe] || 900;
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];

      // Invalid OHLC check
      if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) {
        anomalies.push({
          code: 'INVALID_OHLC',
          severity: 'critical',
          message: `Invalid OHLC relationship at candle time ${c.time} (O:${c.open} H:${c.high} L:${c.low} C:${c.close})`,
        });
      }

      if (i > 0) {
        const prev = sorted[i - 1];
        const timeDiff = c.time - prev.time;

        // Duplicate candles
        if (timeDiff === 0) {
          duplicatesRemoved += 1;
          anomalies.push({
            code: 'DUPLICATE_CANDLES',
            severity: 'warning',
            message: `Duplicate candle timestamp detected at ${c.time}`,
          });
        }

        // Out of order candles
        if (timeDiff < 0) {
          outOfOrderFixed += 1;
          anomalies.push({
            code: 'OUT_OF_ORDER_CANDLES',
            severity: 'critical',
            message: `Out of order candle sequence at index ${i} (time ${c.time} < prev ${prev.time})`,
          });
        }

        // Missing intervals / gaps
        if (timeDiff > tfSec * 2.5 && quote?.marketOpen !== false) {
          missingIntervalsCount += 1;
        }

        // Unexpected price jumps (> 8x ATR or > 12% single bar move)
        const barMovePct = Math.abs(c.close - prev.close) / prev.close;
        if (barMovePct > 0.12 && symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') {
          anomalies.push({
            code: 'UNEXPECTED_PRICE_JUMP',
            severity: 'warning',
            message: `Unusual price jump of ${(barMovePct * 100).toFixed(1)}% between candles at ${c.time}`,
          });
        }
      }
    }
  }

  const criticalErrors = anomalies.filter((a) => a.severity === 'critical');
  const healthy = criticalErrors.length === 0;
  const blocked = !healthy;

  return {
    symbol,
    timeframe,
    healthy,
    blocked,
    checkedAt: nowMs,
    providerEventTime,
    receiveTime,
    providerLatencyMs,
    candleCount: candles.length,
    duplicatesRemoved,
    outOfOrderFixed,
    missingIntervalsCount,
    anomalies,
  };
}
