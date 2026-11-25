import type { SignalCalibrationSummary, TradingSignal } from '../../shared/types/index.ts';

const MIN_REQUIRED_SAMPLES = 20;

export function calibrateSignalStrategyPerformance(
  strategyId: string,
  closedHistoricalSignals: TradingSignal[]
): SignalCalibrationSummary {
  const matching = closedHistoricalSignals.filter(
    (s) => s.strategyId === strategyId && s.closedAt !== null && s.realizedR !== null
  );

  const sampleSize = matching.length;
  if (sampleSize < MIN_REQUIRED_SAMPLES) {
    return {
      sampleSize,
      minRequiredSamples: MIN_REQUIRED_SAMPLES,
      sufficientEvidence: false,
      calibratedWinRatePercent: null,
      ciLowerPercent: null,
      ciUpperPercent: null,
      avgRealizedR: null,
      message: `Not enough evidence (${sampleSize}/${MIN_REQUIRED_SAMPLES} closed out-of-sample trades recorded).`,
    };
  }

  const wins = matching.filter((s) => (s.realizedR ?? 0) > 0).length;
  const winRate = (wins / sampleSize) * 100;
  const avgRealizedR = matching.reduce((acc, s) => acc + (s.realizedR ?? 0), 0) / sampleSize;

  // Wilson Score interval 95% confidence
  const z = 1.96;
  const p = wins / sampleSize;
  const denominator = 1 + (z * z) / sampleSize;
  const center = p + (z * z) / (2 * sampleSize);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * sampleSize)) / sampleSize);

  const ciLower = Math.max(0, ((center - spread) / denominator) * 100);
  const ciUpper = Math.min(100, ((center + spread) / denominator) * 100);

  return {
    sampleSize,
    minRequiredSamples: MIN_REQUIRED_SAMPLES,
    sufficientEvidence: true,
    calibratedWinRatePercent: Number(winRate.toFixed(1)),
    ciLowerPercent: Number(ciLower.toFixed(1)),
    ciUpperPercent: Number(ciUpper.toFixed(1)),
    avgRealizedR: Number(avgRealizedR.toFixed(2)),
    message: `Calibrated from ${sampleSize} OOS trades (Wilson 95% CI: [${ciLower.toFixed(1)}% – ${ciUpper.toFixed(1)}%])`,
  };
}
