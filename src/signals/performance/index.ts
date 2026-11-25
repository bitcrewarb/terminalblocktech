import { INSTRUMENTS } from '../../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  SignalInstrumentStats,
  SignalPerformanceStats,
  SignalTimeframeStats,
  TradingSignal,
} from '../../shared/types/index.ts';
import { isLiveActionableState } from '../lifecycle/index.ts';

/**
 * Computes genuine signal performance metrics strictly from recorded signal outcomes.
 * Never fabricates historical trades or simulated profitability.
 */
export function computeSignalPerformance(signals: TradingSignal[]): SignalPerformanceStats {
  const watchingCount = signals.filter((s) => s.state === 'WATCHING').length;
  const activeCount = signals.filter((s) => isLiveActionableState(s.state)).length;

  // Exclude unconfirmed provisional WATCHING signals from executed signal totals
  const confirmedSignals = signals.filter((s) => s.state !== 'WATCHING');
  const buyCount = confirmedSignals.filter((s) => s.direction === 'BUY').length;
  const sellCount = confirmedSignals.filter((s) => s.direction === 'SELL').length;

  // Signals that actually entered execution (ACTIVE or reached TP/SL)
  const executedSignals = confirmedSignals.filter(
    (s) =>
      s.activatedAt !== null ||
      s.state === 'TP1_HIT' ||
      s.state === 'TP2_HIT' ||
      s.state === 'TP3_HIT' ||
      s.state === 'STOPPED'
  );

  const isClosed = (s: TradingSignal) =>
    s.closedAt !== null || s.state === 'STOPPED' || s.state === 'TP3_HIT';

  const closedExecuted = executedSignals.filter(isClosed);

  // Institutional rule: Never count an open trade as a final winner merely because TP1 was reached.
  // Final win/loss classification and winRate come strictly from closed-trade outcomes.
  const isWin = (s: TradingSignal) =>
    isClosed(s) && (s.realizedR !== null ? s.realizedR > 0 : s.state === 'TP3_HIT');
  const isLoss = (s: TradingSignal) =>
    isClosed(s) && (s.realizedR !== null ? s.realizedR < 0 : s.state === 'STOPPED');

  const winningSignals = closedExecuted.filter(isWin).length;
  const losingSignals = closedExecuted.filter(isLoss).length;
  const resolvedCount = winningSignals + losingSignals;

  const tp1Hits = executedSignals.filter((s) => s.takeProfits[0]?.hit).length;
  const tp2Eligible = executedSignals.filter((s) => s.takeProfits.length >= 2).length;
  const tp2Hits = executedSignals.filter((s) => s.takeProfits[1]?.hit).length;
  const tp3Eligible = executedSignals.filter((s) => s.takeProfits.length >= 3).length;
  const tp3Hits = executedSignals.filter((s) => s.takeProfits[2]?.hit).length;
  const slHits = executedSignals.filter((s) => s.state === 'STOPPED').length;

  const rValues = closedExecuted
    .map((s) => s.realizedR)
    .filter((r): r is number => r !== null && Number.isFinite(r));

  const avgRMultiple =
    rValues.length > 0
      ? Number((rValues.reduce((a, b) => a + b, 0) / rValues.length).toFixed(2))
      : 0;

  const grossProfitR = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLossR = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor =
    grossLossR > 0
      ? Number((grossProfitR / grossLossR).toFixed(2))
      : grossProfitR > 0
        ? null
        : null;

  // Chronological equity curve in R for max drawdown calculation
  const chronological = [...closedExecuted]
    .filter((s) => s.realizedR !== null)
    .sort((a, b) => (a.closedAt ?? a.createdAt) - (b.closedAt ?? b.createdAt));

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const s of chronological) {
    equity += s.realizedR ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  const byInstrument = {} as Record<InstrumentSymbol, SignalInstrumentStats>;
  for (const inst of INSTRUMENTS) {
    const symConfirmed = confirmedSignals.filter((s) => s.symbol === inst.symbol);
    const symClosed = closedExecuted.filter((s) => s.symbol === inst.symbol);
    const wins = symClosed.filter(isWin).length;
    const losses = symClosed.filter(isLoss).length;
    const symR = symClosed.map((s) => s.realizedR).filter((r): r is number => r !== null);
    byInstrument[inst.symbol] = {
      total: symConfirmed.length,
      buy: symConfirmed.filter((s) => s.direction === 'BUY').length,
      sell: symConfirmed.filter((s) => s.direction === 'SELL').length,
      wins,
      losses,
      winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0,
      avgR: symR.length > 0 ? Number((symR.reduce((a, b) => a + b, 0) / symR.length).toFixed(2)) : 0,
    };
  }

  const byTimeframe: Record<string, SignalTimeframeStats> = {};
  const tfs = new Set(confirmedSignals.map((s) => s.entryTimeframe));
  for (const tf of tfs) {
    const tfConf = confirmedSignals.filter((s) => s.entryTimeframe === tf);
    const tfClosed = closedExecuted.filter((s) => s.entryTimeframe === tf);
    const wins = tfClosed.filter(isWin).length;
    const losses = tfClosed.filter(isLoss).length;
    const tfR = tfClosed.map((s) => s.realizedR).filter((r): r is number => r !== null);
    byTimeframe[tf] = {
      total: tfConf.length,
      wins,
      losses,
      winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0,
      avgR: tfR.length > 0 ? Number((tfR.reduce((a, b) => a + b, 0) / tfR.length).toFixed(2)) : 0,
    };
  }

  return {
    totalSignals: confirmedSignals.length,
    watchingCount,
    activeCount,
    closedCount: closedExecuted.length,
    buyCount,
    sellCount,
    winningSignals,
    losingSignals,
    winRate: resolvedCount > 0 ? Number(((winningSignals / resolvedCount) * 100).toFixed(1)) : 0,
    tp1HitRate: executedSignals.length > 0 ? Number(((tp1Hits / executedSignals.length) * 100).toFixed(1)) : 0,
    tp2HitRate: tp2Eligible > 0 ? Number(((tp2Hits / tp2Eligible) * 100).toFixed(1)) : 0,
    tp3HitRate: tp3Eligible > 0 ? Number(((tp3Hits / tp3Eligible) * 100).toFixed(1)) : 0,
    slHitRate: executedSignals.length > 0 ? Number(((slHits / executedSignals.length) * 100).toFixed(1)) : 0,
    avgRMultiple,
    profitFactor,
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    byInstrument,
    byTimeframe,
  };
}
