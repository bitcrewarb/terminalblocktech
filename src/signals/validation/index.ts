import { isMetalsMarketOpen } from '../../market-data/providers/metals.ts';
import { TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  SignalDirection,
  SignalSettings,
  SmcSignalCriteriaConfig,
  Timeframe,
  TradingSignal,
} from '../../shared/types/index.ts';
import type { DirectionalCandidate, ValidationOutcome } from '../types.ts';

const REQUIRED_MIN_BARS: Record<'1D' | '4H' | '1H' | '15m' | '5m', number> = {
  '1D': 20,
  '4H': 25,
  '1H': 30,
  '15m': 30,
  '5m': 35,
};

export interface DataIntegrityResult {
  ok: boolean;
  reasons: string[];
  currentPrice: number;
}

export function isInstrumentMarketClosed(
  symbol: InstrumentSymbol,
  quote: LiveQuote | null,
  providerStatus: ProviderStatus | null,
  nowMs = Date.now()
): boolean {
  const isMetals = symbol === 'XAUUSD' || symbol === 'XAGUSD';
  if (isMetals && !isMetalsMarketOpen(new Date(nowMs))) {
    return true;
  }
  if (providerStatus?.connectionStatus === 'MARKET_CLOSED') {
    return true;
  }
  if (quote && (quote.marketOpen === false || quote.connectionStatus === 'MARKET_CLOSED')) {
    return true;
  }
  return false;
}

/**
 * Checks market session open status, required timeframe availability, candle count,
 * staleness, and provider health before any signal candidate can be evaluated.
 */
export function validateMarketDataIntegrity(
  symbol: InstrumentSymbol,
  snapshots: Partial<Record<Timeframe, AnalysisSnapshot | null>>,
  quote: LiveQuote | null,
  providerStatus: ProviderStatus | null,
  settings: SignalSettings,
  nowMs: number
): DataIntegrityResult {
  const reasons: string[] = [];
  const tfs = settings.timeframes;

  if (isInstrumentMarketClosed(symbol, quote, providerStatus, nowMs)) {
    reasons.push(
      `Market is currently closed for ${symbol} — signal generation and database saving are paused until the market reopens`
    );
  }

  if (!providerStatus || !providerStatus.hasHistoricalCredentials) {
    reasons.push(`Market data provider credentials unavailable for ${symbol}`);
  }
  if (
    providerStatus &&
    (providerStatus.connectionStatus === 'ERROR' ||
      providerStatus.connectionStatus === 'CREDENTIALS_REQUIRED' ||
      providerStatus.connectionStatus === 'STALE')
  ) {
    reasons.push(`Provider status is ${providerStatus.connectionStatus} for ${symbol}`);
  }
  if (quote && quote.stale) {
    reasons.push(`Live quote feed for ${symbol} is stale`);
  }

  const requiredPairs: Array<{ tf: Timeframe; minBars: number; role: string }> = [
    { tf: tfs.majorDirectionTf, minBars: REQUIRED_MIN_BARS['1D'], role: '1D major direction' },
    { tf: tfs.primaryBiasTf, minBars: REQUIRED_MIN_BARS['4H'], role: '4H primary bias' },
    { tf: tfs.secondaryConfirmTf, minBars: REQUIRED_MIN_BARS['1H'], role: '1H secondary confirmation' },
    { tf: tfs.setupTf, minBars: REQUIRED_MIN_BARS['15m'], role: '15m setup' },
    { tf: tfs.entryTf, minBars: REQUIRED_MIN_BARS['5m'], role: '5m primary execution' },
  ];

  const nowSec = Math.floor(nowMs / 1000);
  const marketClosed = isInstrumentMarketClosed(symbol, quote, providerStatus, nowMs);

  for (const req of requiredPairs) {
    const snap = snapshots[req.tf];
    if (!snap || snap.candles.length < req.minBars) {
      reasons.push(
        `Missing or insufficient ${req.role} (${req.tf}) data (${snap?.candles.length ?? 0}/${req.minBars} bars)`
      );
      continue;
    }
    if (snap.atr <= 0 || !Number.isFinite(snap.atr)) {
      reasons.push(`Invalid ATR on ${req.tf} for ${symbol}`);
    }
    // Check candle staleness when market is open
    if (!marketClosed) {
      const lastCandle = snap.candles[snap.candles.length - 1];
      const maxStalenessSec = Math.max(TIMEFRAME_SECONDS[req.tf] * 4, 900);
      if (nowSec - lastCandle.time > maxStalenessSec) {
        reasons.push(`${req.tf} candle stream is stale (${Math.round((nowSec - lastCandle.time) / 60)}m old)`);
      }
    }
  }

  const snap5m = snapshots[tfs.entryTf];
  const currentPrice =
    (quote && quote.price > 0 ? quote.price : undefined) ??
    snap5m?.candles[snap5m.candles.length - 1]?.close ??
    0;

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    reasons.push(`Invalid current market price for ${symbol}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    currentPrice,
  };
}

export interface SmcCriteriaGateResult {
  passed: boolean;
  missingCriteria: string[];
  matchedCriteria: string[];
  rejectionReason: string | null;
}

function isDirectionalSweptPool(direction: SignalDirection, kind: string, label: string): boolean {
  const isBuy = direction === 'BUY';
  const lowSideKinds = new Set(['sell_side', 'equal_lows', 'pdl', 'pwl']);
  const highSideKinds = new Set(['buy_side', 'equal_highs', 'pdh', 'pwh']);
  if (isBuy && lowSideKinds.has(kind)) return true;
  if (!isBuy && highSideKinds.has(kind)) return true;
  if (kind === 'inducement' || kind === 'internal' || kind === 'external') {
    const lower = label.toLowerCase();
    return isBuy
      ? lower.includes('low') || lower.includes('ssl') || lower.includes('sell')
      : lower.includes('high') || lower.includes('bsl') || lower.includes('buy');
  }
  return false;
}

/**
 * Evaluates whether required user-toggled SMC pre-trigger criteria (Order Blocks,
 * Fair Value Gaps, Liquidity Sweeps) are present for the given direction before
 * emitting a BUY or SELL signal.
 */
export function evaluateSmcCriteriaGate(
  direction: SignalDirection,
  snapshots: Partial<Record<Timeframe, AnalysisSnapshot | null>>,
  entryTf: Timeframe,
  setupTf: Timeframe,
  criteria?: Partial<SmcSignalCriteriaConfig> | null
): SmcCriteriaGateResult {
  const requireOb = Boolean(criteria?.requireOrderBlock);
  const requireFvg = Boolean(criteria?.requireFairValueGap);
  const requireSweep = Boolean(criteria?.requireLiquiditySweep);

  if (!requireOb && !requireFvg && !requireSweep) {
    return {
      passed: true,
      missingCriteria: [],
      matchedCriteria: [],
      rejectionReason: null,
    };
  }

  const scoped = [snapshots[entryTf], snapshots[setupTf]].filter(
    (s): s is AnalysisSnapshot => Boolean(s)
  );
  const targetSnapshots =
    scoped.length > 0
      ? Array.from(new Set(scoped))
      : Object.values(snapshots).filter((s): s is AnalysisSnapshot => Boolean(s));

  const isBuy = direction === 'BUY';
  const missingCriteria: string[] = [];
  const matchedCriteria: string[] = [];

  if (requireOb) {
    const hasOb = targetSnapshots.some((snap) =>
      (snap.orderBlocks ?? []).some(
        (ob) =>
          ob.valid &&
          ob.mitigated !== true &&
          (isBuy
            ? ob.kind === 'bullish_ob' || ob.kind === 'breaker_block'
            : ob.kind === 'bearish_ob' || ob.kind === 'breaker_block')
      )
    );
    if (hasOb) {
      matchedCriteria.push('Order Block');
    } else {
      missingCriteria.push('Order Block');
    }
  }

  if (requireFvg) {
    const hasFvg = targetSnapshots.some((snap) =>
      (snap.fairValueGaps ?? []).some(
        (fvg) =>
          fvg.status !== 'fully_filled' &&
          fvg.status !== 'inverted' &&
          (isBuy ? fvg.kind === 'bullish_fvg' : fvg.kind === 'bearish_fvg')
      )
    );
    if (hasFvg) {
      matchedCriteria.push('Fair Value Gap');
    } else {
      missingCriteria.push('Fair Value Gap');
    }
  }

  if (requireSweep) {
    const hasSweep = targetSnapshots.some((snap) => {
      const candles = snap.candles ?? [];
      const lastClosed = [...candles].reverse().find((c) => c.isClosed);
      const refTime = lastClosed?.time ?? candles[candles.length - 1]?.time ?? 0;
      const tfSec = TIMEFRAME_SECONDS[snap.timeframe] ?? TIMEFRAME_SECONDS[entryTf] ?? 300;
      const sweepWindow = tfSec * 36;
      return (snap.liquidityPools ?? []).some(
        (liq) =>
          liq.swept === true &&
          liq.sweepTime !== null &&
          (refTime === 0 || refTime - liq.sweepTime <= sweepWindow) &&
          isDirectionalSweptPool(direction, liq.kind, liq.label)
      );
    });
    if (hasSweep) {
      matchedCriteria.push('Liquidity Sweep');
    } else {
      missingCriteria.push('Liquidity Sweep');
    }
  }

  const passed = missingCriteria.length === 0;
  return {
    passed,
    missingCriteria,
    matchedCriteria,
    rejectionReason: passed
      ? null
      : `${direction}: Missing required SMC criteria (${missingCriteria.join(', ')})`,
  };
}

/**
 * Applies all hard rejection conditions to a scored directional candidate.
 */
export function validateDirectionalCandidate(
  candidate: DirectionalCandidate,
  activeSignalsForSymbol: TradingSignal[],
  settings: SignalSettings,
  snapshots?: Partial<Record<Timeframe, AnalysisSnapshot | null>>
): ValidationOutcome {
  const rejectionReasons: string[] = [];

  if (!settings.enabled) {
    rejectionReasons.push('Signal engine is disabled in signal settings');
  }

  if (snapshots) {
    const smcGate = evaluateSmcCriteriaGate(
      candidate.direction,
      snapshots,
      settings.timeframes.entryTf,
      settings.timeframes.setupTf,
      settings.smcCriteria
    );
    if (!smcGate.passed && smcGate.rejectionReason) {
      rejectionReasons.push(smcGate.rejectionReason);
    }
  }

  // 1. Liquidity sweep alone must never generate a signal
  if (!candidate.hasStructuralConfirmation) {
    if (candidate.hasLiquiditySweep) {
      rejectionReasons.push(
        `${candidate.direction}: Liquidity sweep detected without structural MSS/CHoCH/BOS confirmation`
      );
    } else {
      rejectionReasons.push(
        `${candidate.direction}: Missing structural confirmation (MSS/CHoCH/BOS) on 5m or 15m`
      );
    }
  }

  // 2. Trade plan (entry, SL, invalidation, TP1 R:R)
  if (!candidate.tradePlan.valid) {
    rejectionReasons.push(
      candidate.tradePlan.rejectionReason ??
        `${candidate.direction}: Invalid structural stop-loss or target geometry`
    );
  } else if (candidate.tradePlan.primaryRR < settings.minTp1RiskReward) {
    rejectionReasons.push(
      `${candidate.direction}: TP1 risk/reward 1:${candidate.tradePlan.primaryRR.toFixed(2)} below minimum 1:${settings.minTp1RiskReward.toFixed(2)}`
    );
  }

  // 3. Conflicting technical conditions
  if (candidate.hasStrongConflict) {
    for (const cr of candidate.conflictReasons) {
      rejectionReasons.push(`${candidate.direction} conflict: ${cr}`);
    }
  }

  // 4. Duplicate active signal check
  const duplicate = activeSignalsForSymbol.find(
    (s) =>
      s.direction === candidate.direction &&
      s.entryTimeframe === settings.timeframes.entryTf &&
      (s.state === 'CONFIRMED' ||
        s.state === 'ACTIVE' ||
        s.state === 'PARTIAL' ||
        s.state === 'TP1_HIT' ||
        s.state === 'TP2_HIT')
  );
  if (duplicate) {
    rejectionReasons.push(
      `Duplicate active ${candidate.direction} signal (${duplicate.state}) already tracked for ${duplicate.symbol}`
    );
  }

  // 5. Score threshold checks
  const score = candidate.finalScoreBreakdown.totalScore;
  const meetsConfirmedScore = score >= settings.minConfirmedScore;
  const meetsWatchingScore =
    settings.allowIntrabarWatching && score >= settings.minWatchingScore;

  if (!meetsConfirmedScore && !meetsWatchingScore) {
    rejectionReasons.push(
      `${candidate.direction} score ${score}/100 below minimum threshold (${settings.minWatchingScore} watching / ${settings.minConfirmedScore} confirmed)`
    );
    return { accepted: false, provisionalOnly: false, rejectionReasons };
  }

  if (rejectionReasons.length > 0) {
    return { accepted: false, provisionalOnly: false, rejectionReasons };
  }

  // 6. Closed-candle confirmation check
  if (!candidate.hasClosedCandleConfirmation || !meetsConfirmedScore) {
    if (!settings.allowIntrabarWatching) {
      rejectionReasons.push(
        `${candidate.direction}: Awaiting closed-candle confirmation and score >= ${settings.minConfirmedScore}`
      );
      return { accepted: false, provisionalOnly: false, rejectionReasons };
    }
    return {
      accepted: true,
      provisionalOnly: true,
      rejectionReasons: [
        `${candidate.direction}: Provisional WATCHING candidate (${score}/100) awaiting closed-candle confirmation / threshold ${settings.minConfirmedScore}`,
      ],
    };
  }

  return {
    accepted: true,
    provisionalOnly: false,
    rejectionReasons: [],
  };
}
