import type { BacktestTradeRecord } from '../../shared/types/index.ts';

export type PositionSizingMode = 'compounding' | 'fixed_risk';

export interface CapitalSimulationParams {
  initialCapital: number;
  riskPerTradePercent: number;
  sizingMode: PositionSizingMode;
}

export interface SimulatedTradeRow {
  index: number;
  trade: BacktestTradeRecord;
  riskUsd: number;
  pnlUsd: number;
  balanceBefore: number;
  balanceAfter: number;
  drawdownUsd: number;
  drawdownPercent: number;
}

export interface CapitalReplayPoint {
  step: number;
  time: number;
  label: string;
  balance: number;
  drawdownPercent: number;
  pnlUsd: number;
  realizedR: number;
}

export interface CapitalProjectionResult {
  initialCapital: number;
  endingCapital: number;
  netProfitUsd: number;
  netReturnPercent: number;
  riskPerTradePercent: number;
  initialRiskUsd: number;
  sizingMode: PositionSizingMode;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePercent: number;
  avgWinR: number;
  avgLossR: number;
  rewardToRiskRatio: number;
  expectancyR: number;
  avgDollarPerTrade: number;
  profitFactor: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  peakBalance: number;
  maxWinStreak: number;
  maxLossStreak: number;
  fiveLossStreakUsd: number;
  tenLossStreakUsd: number;
  rows: SimulatedTradeRow[];
  curve: CapitalReplayPoint[];
}

export interface RiskTierComparison {
  riskPercent: number;
  initialRiskUsd: number;
  endingCapital: number;
  netProfitUsd: number;
  netReturnPercent: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  tenLossStreakUsd: number;
}

export interface ForwardProjectionStep {
  tradeNumber: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface ForwardProjectionSummary {
  horizonTrades: number;
  pathsSimulated: number;
  medianEndingCapital: number;
  medianProfitUsd: number;
  medianReturnPercent: number;
  conservativeCapitalP25: number;
  optimisticCapitalP75: number;
  tailFloorP10: number;
  tailUpsideP90: number;
  probabilityOfProfitPercent: number;
  medianMaxDrawdownPercent: number;
  worst95DrawdownPercent: number;
  steps: ForwardProjectionStep[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function createMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str: string, length: number, horizon: number): number {
  let h = 2166136261 ^ length ^ (horizon * 131);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function simulateCapitalProjection(
  trades: BacktestTradeRecord[],
  params: CapitalSimulationParams
): CapitalProjectionResult {
  const initialCapital = Math.max(100, Number.isFinite(params.initialCapital) ? params.initialCapital : 10000);
  const riskPerTradePercent = Math.min(
    10,
    Math.max(0.1, Number.isFinite(params.riskPerTradePercent) ? params.riskPerTradePercent : 1.0)
  );
  const riskFrac = riskPerTradePercent / 100;
  const initialRiskUsd = round2(initialCapital * riskFrac);

  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  if (ordered.length === 0) {
    return {
      initialCapital,
      endingCapital: initialCapital,
      netProfitUsd: 0,
      netReturnPercent: 0,
      riskPerTradePercent,
      initialRiskUsd,
      sizingMode: params.sizingMode,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRatePercent: 0,
      avgWinR: 0,
      avgLossR: 0,
      rewardToRiskRatio: 0,
      expectancyR: 0,
      avgDollarPerTrade: 0,
      profitFactor: null,
      maxDrawdownUsd: 0,
      maxDrawdownPercent: 0,
      peakBalance: initialCapital,
      maxWinStreak: 0,
      maxLossStreak: 0,
      fiveLossStreakUsd: computeStreakLoss(initialCapital, riskFrac, 5, params.sizingMode),
      tenLossStreakUsd: computeStreakLoss(initialCapital, riskFrac, 10, params.sizingMode),
      rows: [],
      curve: [
        {
          step: 0,
          time: Math.floor(Date.now() / 1000),
          label: 'Start',
          balance: initialCapital,
          drawdownPercent: 0,
          pnlUsd: 0,
          realizedR: 0,
        },
      ],
    };
  }

  let balance = initialCapital;
  let peak = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPercent = 0;

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let grossWinR = 0;
  let grossLossR = 0;
  let sumR = 0;

  let curWinStreak = 0;
  let curLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  const rows: SimulatedTradeRow[] = [];
  const curve: CapitalReplayPoint[] = [
    {
      step: 0,
      time: ordered[0].entryTime,
      label: 'Start',
      balance: round2(initialCapital),
      drawdownPercent: 0,
      pnlUsd: 0,
      realizedR: 0,
    },
  ];

  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    const r = Number.isFinite(t.realizedR) ? t.realizedR : 0;
    sumR += r;

    if (r > 0.02) {
      wins += 1;
      grossWinR += r;
      curWinStreak += 1;
      curLossStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (r < -0.02) {
      losses += 1;
      grossLossR += Math.abs(r);
      curLossStreak += 1;
      curWinStreak = 0;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      breakevens += 1;
      curWinStreak = 0;
      curLossStreak = 0;
    }

    const balanceBefore = balance;
    const riskUsd =
      balanceBefore <= 0
        ? 0
        : params.sizingMode === 'compounding'
          ? balanceBefore * riskFrac
          : Math.min(balanceBefore, initialRiskUsd);
    const pnlUsd = riskUsd * r;
    balance = Math.max(0, balanceBefore + pnlUsd);

    if (balance > peak) peak = balance;
    const ddUsd = Math.max(0, peak - balance);
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
    if (ddPct > maxDrawdownPercent) maxDrawdownPercent = ddPct;

    rows.push({
      index: i + 1,
      trade: t,
      riskUsd: round2(riskUsd),
      pnlUsd: round2(pnlUsd),
      balanceBefore: round2(balanceBefore),
      balanceAfter: round2(balance),
      drawdownUsd: round2(ddUsd),
      drawdownPercent: round2(ddPct),
    });

    curve.push({
      step: i + 1,
      time: t.exitTime,
      label: `#${i + 1}`,
      balance: round2(balance),
      drawdownPercent: round2(ddPct),
      pnlUsd: round2(pnlUsd),
      realizedR: round2(r),
    });
  }

  const totalTrades = ordered.length;
  const endingCapital = round2(balance);
  const netProfitUsd = round2(endingCapital - initialCapital);
  const netReturnPercent = round2(((endingCapital - initialCapital) / initialCapital) * 100);
  const winRatePercent = round2((wins / totalTrades) * 100);
  const avgWinR = wins > 0 ? round2(grossWinR / wins) : 0;
  const avgLossR = losses > 0 ? round2(grossLossR / losses) : 0;
  const rewardToRiskRatio =
    avgLossR > 0 ? round2(avgWinR / avgLossR) : avgWinR > 0 ? round2(avgWinR) : 0;
  const expectancyR = round2(sumR / totalTrades);
  const avgDollarPerTrade = round2(netProfitUsd / totalTrades);
  const profitFactor =
    grossLossR > 0 ? round2(grossWinR / grossLossR) : grossWinR > 0 ? 9.9 : null;

  return {
    initialCapital: round2(initialCapital),
    endingCapital,
    netProfitUsd,
    netReturnPercent,
    riskPerTradePercent,
    initialRiskUsd,
    sizingMode: params.sizingMode,
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePercent,
    avgWinR,
    avgLossR,
    rewardToRiskRatio,
    expectancyR,
    avgDollarPerTrade,
    profitFactor,
    maxDrawdownUsd: round2(maxDrawdownUsd),
    maxDrawdownPercent: round2(maxDrawdownPercent),
    peakBalance: round2(peak),
    maxWinStreak,
    maxLossStreak,
    fiveLossStreakUsd: computeStreakLoss(initialCapital, riskFrac, 5, params.sizingMode),
    tenLossStreakUsd: computeStreakLoss(initialCapital, riskFrac, 10, params.sizingMode),
    rows,
    curve,
  };
}

function computeStreakLoss(
  initialCapital: number,
  riskFrac: number,
  losses: number,
  sizingMode: PositionSizingMode
): number {
  if (sizingMode === 'fixed_risk') {
    return round2(Math.min(initialCapital, initialCapital * riskFrac * losses));
  }
  const remaining = initialCapital * Math.pow(1 - riskFrac, losses);
  return round2(initialCapital - remaining);
}

export function buildRiskComparisonTiers(
  trades: BacktestTradeRecord[],
  initialCapital: number,
  sizingMode: PositionSizingMode,
  riskTiers: number[] = [0.5, 1.0, 1.5, 2.0, 3.0]
): RiskTierComparison[] {
  return riskTiers.map((riskPercent) => {
    const sim = simulateCapitalProjection(trades, {
      initialCapital,
      riskPerTradePercent: riskPercent,
      sizingMode,
    });
    return {
      riskPercent,
      initialRiskUsd: sim.initialRiskUsd,
      endingCapital: sim.endingCapital,
      netProfitUsd: sim.netProfitUsd,
      netReturnPercent: sim.netReturnPercent,
      maxDrawdownUsd: sim.maxDrawdownUsd,
      maxDrawdownPercent: sim.maxDrawdownPercent,
      tenLossStreakUsd: sim.tenLossStreakUsd,
    };
  });
}

export function runDeterministicForwardProjection(
  trades: BacktestTradeRecord[],
  params: CapitalSimulationParams & {
    horizonTrades: number;
    strategyId: string;
    paths?: number;
  }
): ForwardProjectionSummary {
  const initialCapital = Math.max(100, Number.isFinite(params.initialCapital) ? params.initialCapital : 10000);
  const riskFrac =
    Math.min(10, Math.max(0.1, Number.isFinite(params.riskPerTradePercent) ? params.riskPerTradePercent : 1.0)) /
    100;
  const horizon = Math.max(10, Math.min(300, Math.round(params.horizonTrades)));
  const numPaths = Math.max(50, Math.min(400, params.paths ?? 250));

  const rOutcomes = trades.map((t) => (Number.isFinite(t.realizedR) ? t.realizedR : 0));
  if (rOutcomes.length === 0) {
    const emptySteps: ForwardProjectionStep[] = Array.from({ length: horizon + 1 }, (_, i) => ({
      tradeNumber: i,
      p10: initialCapital,
      p25: initialCapital,
      p50: initialCapital,
      p75: initialCapital,
      p90: initialCapital,
    }));
    return {
      horizonTrades: horizon,
      pathsSimulated: 0,
      medianEndingCapital: initialCapital,
      medianProfitUsd: 0,
      medianReturnPercent: 0,
      conservativeCapitalP25: initialCapital,
      optimisticCapitalP75: initialCapital,
      tailFloorP10: initialCapital,
      tailUpsideP90: initialCapital,
      probabilityOfProfitPercent: 0,
      medianMaxDrawdownPercent: 0,
      worst95DrawdownPercent: 0,
      steps: emptySteps,
    };
  }

  const rng = createMulberry32(hashSeed(params.strategyId, rOutcomes.length, horizon));
  const stepBuckets: number[][] = Array.from({ length: horizon + 1 }, () => []);
  const endingBalances: number[] = [];
  const pathMaxDds: number[] = [];
  let profitablePaths = 0;

  const fixedRiskUsd = initialCapital * riskFrac;

  for (let p = 0; p < numPaths; p++) {
    let bal = initialCapital;
    let peak = initialCapital;
    let maxDd = 0;
    stepBuckets[0].push(bal);

    for (let step = 1; step <= horizon; step++) {
      const sampleIdx = Math.floor(rng() * rOutcomes.length);
      const r = rOutcomes[sampleIdx];
      const riskUsd =
        bal <= 0
          ? 0
          : params.sizingMode === 'compounding'
            ? bal * riskFrac
            : Math.min(bal, fixedRiskUsd);
      bal = Math.max(0, bal + riskUsd * r);
      if (bal > peak) peak = bal;
      const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
      stepBuckets[step].push(bal);
    }

    endingBalances.push(bal);
    pathMaxDds.push(maxDd);
    if (bal > initialCapital) profitablePaths += 1;
  }

  const steps: ForwardProjectionStep[] = stepBuckets.map((vals, tradeNumber) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      tradeNumber,
      p10: round2(percentile(sorted, 0.1)),
      p25: round2(percentile(sorted, 0.25)),
      p50: round2(percentile(sorted, 0.5)),
      p75: round2(percentile(sorted, 0.75)),
      p90: round2(percentile(sorted, 0.9)),
    };
  });

  const sortedEnd = [...endingBalances].sort((a, b) => a - b);
  const sortedDd = [...pathMaxDds].sort((a, b) => a - b);
  const medianEnd = round2(percentile(sortedEnd, 0.5));

  return {
    horizonTrades: horizon,
    pathsSimulated: numPaths,
    medianEndingCapital: medianEnd,
    medianProfitUsd: round2(medianEnd - initialCapital),
    medianReturnPercent: round2(((medianEnd - initialCapital) / initialCapital) * 100),
    conservativeCapitalP25: round2(percentile(sortedEnd, 0.25)),
    optimisticCapitalP75: round2(percentile(sortedEnd, 0.75)),
    tailFloorP10: round2(percentile(sortedEnd, 0.1)),
    tailUpsideP90: round2(percentile(sortedEnd, 0.9)),
    probabilityOfProfitPercent: round2((profitablePaths / numPaths) * 100),
    medianMaxDrawdownPercent: round2(percentile(sortedDd, 0.5)),
    worst95DrawdownPercent: round2(percentile(sortedDd, 0.95)),
    steps,
  };
}
