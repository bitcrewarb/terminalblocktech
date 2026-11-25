import type { ProductionReadinessStatus } from './types/index.ts';

export interface ProductionAuditInput {
  validationStatus: string;
  isMetrics: { expectancyR: number };
  oosMetrics: { trades: number; expectancyR: number };
  holdoutMetrics: {
    trades: number;
    expectancyR: number;
    netReturnPercent: number;
    profitFactor: number | null;
  };
  productionAudit?: {
    readiness: ProductionReadinessStatus;
    holdoutConfirmed: boolean;
    edgeConfidencePercent: number;
    isOosDecayRatio: number | null;
    summaryNote: string;
  };
}

export interface ProductionAuditOutput {
  readiness: ProductionReadinessStatus;
  holdoutConfirmed: boolean;
  edgeConfidencePercent: number;
  isOosDecayRatio: number | null;
  summaryNote: string;
}

export function deriveProductionAudit(combo: ProductionAuditInput): ProductionAuditOutput {
  if (combo.productionAudit) {
    return combo.productionAudit;
  }
  const { validationStatus, isMetrics, oosMetrics, holdoutMetrics } = combo;
  const isOosDecayRatio =
    isMetrics.expectancyR > 0.02
      ? Math.round((oosMetrics.expectancyR / isMetrics.expectancyR) * 100) / 100
      : null;

  const holdoutConfirmed =
    holdoutMetrics.trades >= 3 &&
    holdoutMetrics.expectancyR > 0 &&
    holdoutMetrics.netReturnPercent > 0 &&
    (holdoutMetrics.profitFactor ?? 0) >= 1.05;

  const holdoutCollapsed =
    holdoutMetrics.trades >= 3 &&
    (holdoutMetrics.expectancyR <= 0 || holdoutMetrics.netReturnPercent <= 0);

  if (validationStatus === 'Validated' && holdoutConfirmed && oosMetrics.trades >= 5) {
    return {
      readiness: 'Production Ready',
      holdoutConfirmed: true,
      edgeConfidencePercent: Math.min(95, 65 + oosMetrics.trades * 2),
      isOosDecayRatio,
      summaryNote: `Passed IS + OOS + Walk-Forward AND stayed profitable on ${holdoutMetrics.trades} untouched Final Check trades (+${holdoutMetrics.netReturnPercent}%).`,
    };
  }

  if (
    (validationStatus === 'Validated' || validationStatus === 'Preliminary Candidate') &&
    holdoutCollapsed
  ) {
    return {
      readiness: 'Overfit / Decayed',
      holdoutConfirmed: false,
      edgeConfidencePercent: Math.min(80, 50 + oosMetrics.trades * 2),
      isOosDecayRatio,
      summaryNote: `Looked strong in Unseen Test, but lost ${holdoutMetrics.netReturnPercent}% across ${holdoutMetrics.trades} Final Check trades. Skip live trading.`,
    };
  }

  if (validationStatus === 'Validated' || validationStatus === 'Preliminary Candidate') {
    return {
      readiness: 'Verify Paper',
      holdoutConfirmed: false,
      edgeConfidencePercent: Math.min(85, 55 + oosMetrics.trades * 2),
      isOosDecayRatio,
      summaryNote:
        holdoutMetrics.trades < 3
          ? `Strong pre-holdout edge, only ${holdoutMetrics.trades} Final Check trades so far. Verify on paper first.`
          : 'Profitable overall, borderline sample or confidence.',
    };
  }

  return {
    readiness: 'Not Ready',
    holdoutConfirmed: false,
    edgeConfidencePercent: 0,
    isOosDecayRatio,
    summaryNote: 'Insufficient unseen trades or negative test expectancy.',
  };
}
