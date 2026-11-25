import { describe, expect, it } from 'vitest';
import { BACKTEST_STRATEGY_DEFINITIONS } from '../backtest/strategies/index.ts';
import {
  buildRiskComparisonTiers,
  runDeterministicForwardProjection,
  simulateCapitalProjection,
} from '../frontend/simulator/projection.ts';
import type { BacktestTradeRecord } from '../shared/types/index.ts';

function makeSimTrade(
  id: string,
  tradeNumber: number,
  realizedR: number,
  entryTime: number
): BacktestTradeRecord {
  return {
    id,
    tradeNumber,
    strategyId: BACKTEST_STRATEGY_DEFINITIONS[0].id,
    direction: 'BUY',
    entryMode: 'market_close',
    signalTime: entryTime - 900,
    entryTime,
    exitTime: entryTime + 1800,
    barsHeld: 2,
    entryPrice: 100,
    stopLoss: 99,
    initialStopLoss: 99,
    invalidationLevel: 98.5,
    exitPrice: realizedR > 0 ? 102 : 99,
    takeProfits: [],
    tp1Hit: realizedR > 0,
    tp2Hit: false,
    tp3Hit: false,
    exitReason: realizedR > 0 ? 'TP1_FULL' : 'STOP_LOSS',
    units: 100,
    riskAmount: 100,
    grossPnl: realizedR * 100,
    feesAndSlippage: 0,
    netPnl: realizedR * 100,
    returnPercent: realizedR,
    realizedR,
    mfeR: Math.max(0.2, realizedR),
    maeR: -0.2,
    equityAfter: 10000 + realizedR * 100,
    confluenceScore: 80,
    entryRationale: [],
    exitNote: '',
  };
}

describe('Interactive Trade Simulator Projection Engine', () => {
  const sampleTrades: BacktestTradeRecord[] = [
    makeSimTrade('t1', 1, 2.0, 1000),
    makeSimTrade('t2', 2, -1.0, 4000),
    makeSimTrade('t3', 3, -1.0, 7000),
    makeSimTrade('t4', 4, 3.0, 10000),
  ];

  it('replays historical trades accurately in fixed_risk and compounding modes', () => {
    // Fixed $ risk: $10,000 start, 2% risk = $200/trade
    // +2R (+400 -> 10400), -1R (-200 -> 10200), -1R (-200 -> 10000), +3R (+600 -> 10600)
    const fixed = simulateCapitalProjection(sampleTrades, {
      initialCapital: 10000,
      riskPerTradePercent: 2.0,
      sizingMode: 'fixed_risk',
    });

    expect(fixed.totalTrades).toBe(4);
    expect(fixed.wins).toBe(2);
    expect(fixed.losses).toBe(2);
    expect(fixed.winRatePercent).toBe(50);
    expect(fixed.avgWinR).toBe(2.5);
    expect(fixed.avgLossR).toBe(1.0);
    expect(fixed.rewardToRiskRatio).toBe(2.5);
    expect(fixed.endingCapital).toBe(10600);
    expect(fixed.netProfitUsd).toBe(600);
    expect(fixed.maxDrawdownUsd).toBe(400);
    expect(fixed.maxLossStreak).toBe(2);
    expect(fixed.tenLossStreakUsd).toBe(2000);

    // Compounding 2% risk:
    // 10000 * 1.04 = 10400 -> * 0.98 = 10192 -> * 0.98 = 9988.16 -> * 1.06 = 10587.45
    const comp = simulateCapitalProjection(sampleTrades, {
      initialCapital: 10000,
      riskPerTradePercent: 2.0,
      sizingMode: 'compounding',
    });
    expect(comp.endingCapital).toBeCloseTo(10587.45, 2);
    expect(comp.tenLossStreakUsd).toBeLessThan(2000);
  });

  it('builds monotonically scaling risk comparison tiers across 0.5% to 3.0%', () => {
    const tiers = buildRiskComparisonTiers(sampleTrades, 25000, 'fixed_risk');
    expect(tiers).toHaveLength(5);
    expect(tiers[0].riskPercent).toBe(0.5);
    expect(tiers[4].riskPercent).toBe(3.0);
    expect(tiers[4].netProfitUsd).toBeGreaterThan(tiers[0].netProfitUsd);
    expect(tiers[4].maxDrawdownUsd).toBeGreaterThan(tiers[0].maxDrawdownUsd);
  });

  it('computes deterministic reproducible forward sequence projections with ordered percentile bands', () => {
    const run1 = runDeterministicForwardProjection(sampleTrades, {
      initialCapital: 10000,
      riskPerTradePercent: 1.5,
      sizingMode: 'compounding',
      horizonTrades: 50,
      strategyId: 'smc_fvg_ob_sweep',
      paths: 150,
    });
    const run2 = runDeterministicForwardProjection(sampleTrades, {
      initialCapital: 10000,
      riskPerTradePercent: 1.5,
      sizingMode: 'compounding',
      horizonTrades: 50,
      strategyId: 'smc_fvg_ob_sweep',
      paths: 150,
    });

    expect(run1).toEqual(run2);
    expect(run1.steps).toHaveLength(51);
    const last = run1.steps[50];
    expect(last.p10).toBeLessThanOrEqual(last.p25);
    expect(last.p25).toBeLessThanOrEqual(last.p50);
    expect(last.p50).toBeLessThanOrEqual(last.p75);
    expect(last.p75).toBeLessThanOrEqual(last.p90);
    expect(run1.probabilityOfProfitPercent).toBeGreaterThan(50);
  });

  it('handles zero-trade history safely', () => {
    const empty = simulateCapitalProjection([], {
      initialCapital: 5000,
      riskPerTradePercent: 1.0,
      sizingMode: 'compounding',
    });
    expect(empty.totalTrades).toBe(0);
    expect(empty.endingCapital).toBe(5000);
    expect(empty.curve).toHaveLength(1);
  });
});
