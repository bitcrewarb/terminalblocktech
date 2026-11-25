import { runDeterministicAnalysis } from '../analysis/engine.ts';
import {
  DEFAULT_TECHNICAL_SETTINGS,
  getInstrumentMeta,
  TIMEFRAME_SECONDS,
} from '../shared/constants/index.ts';
import type {
  AnalysisSnapshot,
  BacktestEquityPoint,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  BacktestStrategyMetrics,
  BacktestTradeExitReason,
  BacktestTradeTarget,
  BasketBacktestConfig,
  BasketBacktestResult,
  BasketStrategyContribution,
  BasketTradeRecord,
  Candle,
  LiveQuote,
  ProviderStatus,
  TechnicalSettings,
} from '../shared/types/index.ts';
import { buildCorrelationMatrix } from './correlation.ts';
import { buildDefaultBacktestConfig, resolveDefaultHtfTimeframe } from './engine.ts';
import { StrategyPortfolioSimulator } from './simulator/index.ts';
import {
  BACKTEST_STRATEGY_DEFINITIONS,
  evaluateStrategiesOnBar,
  type StrategySignalCandidate,
} from './strategies/index.ts';

interface PendingBasketOrder {
  definition: BacktestStrategyDefinition;
  candidate: StrategySignalCandidate;
  signalTime: number;
  signalBarIndex: number;
  expiresAtBarIndex: number;
}

interface ActiveBasketPosition {
  tradeNumber: number;
  definition: BacktestStrategyDefinition;
  candidate: StrategySignalCandidate;
  signalTime: number;
  entryTime: number;
  entryBarIndex: number;
  rawEntryPrice: number;
  effectiveEntryPrice: number;
  currentStopLoss: number;
  initialStopLoss: number;
  unitsTotal: number;
  unitsRemaining: number;
  riskPerUnit: number;
  riskAmount: number;
  entryFee: number;
  realizedGrossPnl: number;
  realizedFees: number;
  slippageCost: number;
  takeProfits: BacktestTradeTarget[];
  tpWeights: number[];
  mfeR: number;
  maeR: number;
  movedToBreakeven: boolean;
  concurrentPositionsAtEntry: number;
  portfolioHeatAtEntry: number;
}

export interface RunBasketPortfolioBacktestInput {
  config: Partial<BasketBacktestConfig> & { strategyIds: BacktestStrategyId[] };
  execCandles: Candle[];
  htfCandles: Candle[];
  dailyCandles: Candle[];
  providerName: string;
  technicalSettings?: TechnicalSettings;
}

function roundNum(val: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function applyEntrySlippage(price: number, direction: 'BUY' | 'SELL', slippageBps: number): number {
  const slip = slippageBps / 10000;
  return direction === 'BUY' ? price * (1 + slip) : price * (1 - slip);
}

function applyExitSlippage(price: number, direction: 'BUY' | 'SELL', slippageBps: number): number {
  const slip = slippageBps / 10000;
  return direction === 'BUY' ? price * (1 - slip) : price * (1 + slip);
}

function getTpWeights(count: number): number[] {
  if (count <= 1) return [1.0];
  if (count === 2) return [0.5, 0.5];
  return [0.4, 0.35, 0.25];
}

function normalizeClosedSeries(candles: Candle[]): Candle[] {
  const sorted = [...candles]
    .filter(
      (c) =>
        c.isClosed !== false &&
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  const deduped: Candle[] = [];
  for (const c of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === c.time) {
      deduped[deduped.length - 1] = { ...c, isClosed: true };
    } else {
      deduped.push({ ...c, isClosed: true });
    }
  }
  return deduped;
}

function computeOpenRiskDollars(pos: ActiveBasketPosition): number {
  const isBuy = pos.candidate.direction === 'BUY';
  const slDist = isBuy
    ? Math.max(0, pos.effectiveEntryPrice - pos.currentStopLoss)
    : Math.max(0, pos.currentStopLoss - pos.effectiveEntryPrice);
  return slDist * pos.unitsRemaining;
}

function computePortfolioMetrics(
  config: BasketBacktestConfig,
  endingEquity: number,
  trades: BasketTradeRecord[],
  fullEquityCurve: BacktestEquityPoint[]
): BacktestStrategyMetrics {
  const startCap = config.initialCapital;
  const endEq = roundNum(endingEquity, 2);
  const netProfit = roundNum(endEq - startCap, 2);
  const netReturnPercent = startCap > 0 ? roundNum((netProfit / startCap) * 100, 2) : 0;

  const total = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0.01);
  const losses = trades.filter((t) => t.netPnl < -0.01);
  const breakevens = trades.filter((t) => Math.abs(t.netPnl) <= 0.01);

  const longs = trades.filter((t) => t.direction === 'BUY');
  const shorts = trades.filter((t) => t.direction === 'SELL');
  const longWins = longs.filter((t) => t.netPnl > 0.01);
  const shortWins = shorts.filter((t) => t.netPnl > 0.01);

  const grossProfit = roundNum(wins.reduce((s, t) => s + t.netPnl, 0), 2);
  const grossLoss = roundNum(Math.abs(losses.reduce((s, t) => s + t.netPnl, 0)), 2);
  const totalFeesAndSlippage = roundNum(
    trades.reduce((s, t) => s + t.feesAndSlippage, 0),
    2
  );

  const profitFactor =
    grossLoss > 0 ? roundNum(grossProfit / grossLoss, 2) : grossProfit > 0 ? 99.9 : null;
  const winRate = total > 0 ? roundNum((wins.length / total) * 100, 1) : 0;
  const expectancyR =
    total > 0 ? roundNum(trades.reduce((s, t) => s + t.realizedR, 0) / total, 2) : 0;
  const expectancyDollar = total > 0 ? roundNum(netProfit / total, 2) : 0;

  const avgWinR =
    wins.length > 0 ? roundNum(wins.reduce((s, t) => s + t.realizedR, 0) / wins.length, 2) : 0;
  const avgLossR =
    losses.length > 0
      ? roundNum(Math.abs(losses.reduce((s, t) => s + t.realizedR, 0) / losses.length), 2)
      : 0;
  const avgWinDollar = wins.length > 0 ? roundNum(grossProfit / wins.length, 2) : 0;
  const avgLossDollar = losses.length > 0 ? roundNum(grossLoss / losses.length, 2) : 0;
  const bestTradeR = total > 0 ? roundNum(Math.max(...trades.map((t) => t.realizedR)), 2) : 0;
  const worstTradeR = total > 0 ? roundNum(Math.min(...trades.map((t) => t.realizedR)), 2) : 0;

  let peak = startCap;
  let maxDdDollar = 0;
  let maxDdPct = 0;
  for (const pt of fullEquityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const ddD = peak - pt.equity;
    const ddP = peak > 0 ? (ddD / peak) * 100 : 0;
    if (ddD > maxDdDollar) maxDdDollar = ddD;
    if (ddP > maxDdPct) maxDdPct = ddP;
  }

  const recoveryFactor =
    maxDdDollar > 0 ? roundNum(netProfit / maxDdDollar, 2) : netProfit > 0 ? 99.9 : null;

  const barReturns: number[] = [];
  for (let i = 1; i < fullEquityCurve.length; i++) {
    const prev = fullEquityCurve[i - 1].equity;
    const curr = fullEquityCurve[i].equity;
    if (prev > 0) barReturns.push((curr - prev) / prev);
  }
  const tfSec = TIMEFRAME_SECONDS[config.timeframe] || 900;
  const isCrypto = config.symbol === 'BTCUSDT' || config.symbol === 'ETHUSDT';
  const tradingDaysPerYear = isCrypto ? 365 : 252;
  const barsPerYear = tradingDaysPerYear * (86400 / tfSec);

  let sharpeRatio = 0;
  let sortinoRatio = 0;
  if (barReturns.length > 5 && total >= 2) {
    const mean = barReturns.reduce((s, r) => s + r, 0) / barReturns.length;
    const variance =
      barReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / barReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 1e-9) {
      sharpeRatio = roundNum((mean / stdDev) * Math.sqrt(barsPerYear), 2);
    }
    const downsideSquares = barReturns.filter((r) => r < 0).map((r) => r * r);
    const downDev =
      downsideSquares.length > 0
        ? Math.sqrt(downsideSquares.reduce((s, v) => s + v, 0) / barReturns.length)
        : 0;
    if (downDev > 1e-9) {
      sortinoRatio = roundNum((mean / downDev) * Math.sqrt(barsPerYear), 2);
    } else if (mean > 0) {
      sortinoRatio = roundNum(Math.min(10, sharpeRatio * 1.5), 2);
    }
  }

  let maxConsecW = 0;
  let maxConsecL = 0;
  let curW = 0;
  let curL = 0;
  for (const t of trades) {
    if (t.netPnl > 0.01) {
      curW += 1;
      curL = 0;
      if (curW > maxConsecW) maxConsecW = curW;
    } else if (t.netPnl < -0.01) {
      curL += 1;
      curW = 0;
      if (curL > maxConsecL) maxConsecL = curL;
    }
  }

  const avgBarsHeld =
    total > 0 ? roundNum(trades.reduce((s, t) => s + t.barsHeld, 0) / total, 1) : 0;

  const tp1HitRate =
    total > 0 ? roundNum((trades.filter((t) => t.tp1Hit).length / total) * 100, 1) : 0;
  const tp2Trades = trades.filter((t) => t.takeProfits.length >= 2);
  const tp2HitRate =
    tp2Trades.length > 0
      ? roundNum((tp2Trades.filter((t) => t.tp2Hit).length / tp2Trades.length) * 100, 1)
      : 0;
  const tp3Trades = trades.filter((t) => t.takeProfits.length >= 3);
  const tp3HitRate =
    tp3Trades.length > 0
      ? roundNum((tp3Trades.filter((t) => t.tp3Hit).length / tp3Trades.length) * 100, 1)
      : 0;
  const slHitRate =
    total > 0
      ? roundNum(
          (trades.filter((t) => t.exitReason === 'STOP_LOSS').length / total) * 100,
          1
        )
      : 0;

  let compositeScore = 0;
  if (total > 0) {
    const sampleWeight = Math.min(1, total / 8);
    const pfScore = Math.min(25, ((profitFactor ?? 0) / 2.5) * 25);
    const retScore = Math.max(-15, Math.min(25, netReturnPercent * 1.25));
    const expScore = Math.max(-15, Math.min(20, expectancyR * 20));
    const winScore = (winRate / 100) * 15;
    const sharpeScore = Math.max(-5, Math.min(15, sharpeRatio * 5));
    const ddPenalty = Math.min(25, maxDdPct * 1.1);
    const rawComposite =
      (pfScore + retScore + expScore + winScore + sharpeScore - ddPenalty) *
      (0.45 + 0.55 * sampleWeight);
    compositeScore = Math.max(0, Math.min(100, roundNum(rawComposite, 1)));
  }

  return {
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    breakevenTrades: breakevens.length,
    winRate,
    longTrades: longs.length,
    longWinRate: longs.length > 0 ? roundNum((longWins.length / longs.length) * 100, 1) : 0,
    shortTrades: shorts.length,
    shortWinRate: shorts.length > 0 ? roundNum((shortWins.length / shorts.length) * 100, 1) : 0,
    startingCapital: startCap,
    endingEquity: endEq,
    netProfit,
    netReturnPercent,
    grossProfit,
    grossLoss,
    totalFeesAndSlippage,
    profitFactor,
    expectancyR,
    expectancyDollar,
    avgWinR,
    avgLossR,
    avgWinDollar,
    avgLossDollar,
    bestTradeR,
    worstTradeR,
    maxDrawdownDollar: roundNum(maxDdDollar, 2),
    maxDrawdownPercent: roundNum(maxDdPct, 2),
    recoveryFactor,
    sharpeRatio,
    sortinoRatio,
    maxConsecutiveWins: maxConsecW,
    maxConsecutiveLosses: maxConsecL,
    avgBarsHeld,
    tp1HitRate,
    tp2HitRate,
    tp3HitRate,
    slHitRate,
    compositeScore,
  };
}

/**
 * Simulates an uncorrelated strategy basket inside a single shared-capital portfolio,
 * enforcing concurrent position limits, max portfolio risk heat, conservative SL-before-TP,
 * partial TP scaling, and zero-lookahead causal signal execution.
 */
export function runBasketPortfolioBacktest(
  input: RunBasketPortfolioBacktestInput
): BasketBacktestResult {
  const startedAt = Date.now();
  const baseConfig = buildDefaultBacktestConfig({
    ...input.config,
    htfTimeframe:
      input.config.htfTimeframe ??
      resolveDefaultHtfTimeframe(input.config.timeframe ?? '15m'),
  });

  const uniqueRequestedIds = Array.from(new Set(input.config.strategyIds));
  const defMap = new Map(BACKTEST_STRATEGY_DEFINITIONS.map((d) => [d.id, d]));
  const selectedDefs = uniqueRequestedIds
    .map((id) => defMap.get(id))
    .filter((d): d is BacktestStrategyDefinition => Boolean(d));

  if (selectedDefs.length === 0) {
    throw new Error('Select at least one valid strategy for shared-capital basket simulation');
  }

  const config: BasketBacktestConfig = {
    ...baseConfig,
    strategyIds: selectedDefs.map((d) => d.id),
    maxConcurrentPositions: Math.max(
      1,
      Math.min(20, Math.round(input.config.maxConcurrentPositions ?? 4))
    ),
    maxPortfolioHeatPercent: Math.max(
      0.5,
      Math.min(50, Number(input.config.maxPortfolioHeatPercent ?? 4.0))
    ),
  };

  const techSettings = input.technicalSettings ?? DEFAULT_TECHNICAL_SETTINGS;
  const execCandles = normalizeClosedSeries(input.execCandles).slice(-config.bars);
  const htfCandles = normalizeClosedSeries(input.htfCandles);
  const dailyCandles = normalizeClosedSeries(input.dailyCandles);

  if (execCandles.length < 80) {
    throw new Error(
      `Insufficient historical candles for ${config.symbol} ${config.timeframe} (got ${execCandles.length}, need at least 80)`
    );
  }

  const precision = getInstrumentMeta(config.symbol).pricePrecision;
  const execSec = TIMEFRAME_SECONDS[config.timeframe];
  const htfSec = TIMEFRAME_SECONDS[config.htfTimeframe];
  const daySec = TIMEFRAME_SECONDS['1D'];

  const warmupBars = Math.min(60, Math.max(30, Math.floor(execCandles.length * 0.2)));
  const startTime = execCandles[warmupBars]?.time ?? execCandles[0].time;

  // Shared portfolio state
  let equity = config.initialCapital;
  let peakEquity = config.initialCapital;
  let tradeCounter = 0;
  let totalSignalsGenerated = 0;
  let skippedByConcurrentCap = 0;
  let skippedByHeatCap = 0;
  let peakConcurrentPositions = 0;
  let peakPortfolioHeatPercent = 0;
  let sumConcurrentBars = 0;
  let trackedBars = 0;

  const openPositions = new Map<BacktestStrategyId, ActiveBasketPosition>();
  const pendingOrders = new Map<BacktestStrategyId, PendingBasketOrder>();
  const trades: BasketTradeRecord[] = [];
  const fullEquityCurve: BacktestEquityPoint[] = [
    { time: startTime, equity: roundNum(equity, 2), drawdownPercent: 0 },
  ];

  // Track standalone baselines simultaneously for accurate diversification metrics
  const standaloneSims = new Map<BacktestStrategyId, StrategyPortfolioSimulator>();
  const contribCounters = new Map<
    BacktestStrategyId,
    {
      def: BacktestStrategyDefinition;
      tradesExecuted: number;
      wins: number;
      losses: number;
      netPnl: number;
      sumR: number;
      skippedByConcurrentCap: number;
      skippedByHeatCap: number;
    }
  >();

  for (const def of selectedDefs) {
    standaloneSims.set(def.id, new StrategyPortfolioSimulator(def, config, startTime));
    contribCounters.set(def.id, {
      def,
      tradesExecuted: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
      sumR: 0,
      skippedByConcurrentCap: 0,
      skippedByHeatCap: 0,
    });
  }

  const finalizePosition = (
    pos: ActiveBasketPosition,
    exitPrice: number,
    exitTime: number,
    barIndex: number,
    exitReason: BacktestTradeExitReason,
    exitNote: string
  ) => {
    const netPnl = pos.realizedGrossPnl - pos.realizedFees;
    const realizedR = pos.riskAmount > 0 ? netPnl / pos.riskAmount : 0;
    const equityBefore = equity - netPnl;
    const returnPct = equityBefore > 0 ? (netPnl / equityBefore) * 100 : 0;

    peakEquity = Math.max(peakEquity, equity);

    trades.push({
      id: `BASKET-${pos.definition.id}-T${pos.tradeNumber}`,
      tradeNumber: pos.tradeNumber,
      strategyId: pos.definition.id,
      strategyName: pos.definition.name,
      strategyCategory: pos.definition.category,
      concurrentPositionsAtEntry: pos.concurrentPositionsAtEntry,
      portfolioHeatAtEntry: pos.portfolioHeatAtEntry,
      direction: pos.candidate.direction,
      entryMode: pos.candidate.entryMode,
      signalTime: pos.signalTime,
      entryTime: pos.entryTime,
      exitTime,
      barsHeld: Math.max(1, barIndex - pos.entryBarIndex),
      entryPrice: roundNum(pos.effectiveEntryPrice, precision),
      stopLoss: roundNum(pos.currentStopLoss, precision),
      initialStopLoss: roundNum(pos.initialStopLoss, precision),
      invalidationLevel: roundNum(pos.candidate.invalidationLevel, precision),
      exitPrice: roundNum(exitPrice, precision),
      takeProfits: pos.takeProfits,
      tp1Hit: Boolean(pos.takeProfits[0]?.hit),
      tp2Hit: Boolean(pos.takeProfits[1]?.hit),
      tp3Hit: Boolean(pos.takeProfits[2]?.hit),
      exitReason,
      units: roundNum(pos.unitsTotal, 6),
      riskAmount: roundNum(pos.riskAmount, 2),
      grossPnl: roundNum(pos.realizedGrossPnl, 2),
      feesAndSlippage: roundNum(pos.realizedFees + pos.slippageCost, 2),
      netPnl: roundNum(netPnl, 2),
      returnPercent: roundNum(returnPct, 2),
      realizedR: roundNum(realizedR, 2),
      mfeR: roundNum(pos.mfeR, 2),
      maeR: roundNum(pos.maeR, 2),
      equityAfter: roundNum(equity, 2),
      confluenceScore: pos.candidate.confluenceScore,
      entryRationale: pos.candidate.entryRationale,
      exitNote,
    });

    const cStat = contribCounters.get(pos.definition.id);
    if (cStat) {
      cStat.tradesExecuted += 1;
      if (netPnl > 0.01) cStat.wins += 1;
      else if (netPnl < -0.01) cStat.losses += 1;
      cStat.netPnl += netPnl;
      cStat.sumR += realizedR;
    }

    openPositions.delete(pos.definition.id);
  };

  const closeRemainingPosition = (
    pos: ActiveBasketPosition,
    rawExitPrice: number,
    exitTime: number,
    barIndex: number,
    exitReason: BacktestTradeExitReason,
    exitNote: string
  ) => {
    const isBuy = pos.candidate.direction === 'BUY';
    const exitPrice = applyExitSlippage(rawExitPrice, pos.candidate.direction, config.slippageBps);
    const grossLeg = isBuy
      ? (exitPrice - pos.effectiveEntryPrice) * pos.unitsRemaining
      : (pos.effectiveEntryPrice - exitPrice) * pos.unitsRemaining;
    const feeLeg = pos.unitsRemaining * exitPrice * (config.commissionBps / 10000);
    const slipLeg = Math.abs(exitPrice - rawExitPrice) * pos.unitsRemaining;

    pos.realizedGrossPnl += grossLeg;
    pos.realizedFees += feeLeg;
    pos.slippageCost += slipLeg;
    pos.unitsRemaining = 0;
    equity += grossLeg - feeLeg;

    finalizePosition(pos, rawExitPrice, exitTime, barIndex, exitReason, exitNote);
  };

  const processOpenPositionOnBar = (
    pos: ActiveBasketPosition,
    bar: Candle,
    barIndex: number
  ) => {
    const isBuy = pos.candidate.direction === 'BUY';

    if (pos.riskPerUnit > 0) {
      const fav = isBuy
        ? bar.high - pos.effectiveEntryPrice
        : pos.effectiveEntryPrice - bar.low;
      const adv = isBuy
        ? pos.effectiveEntryPrice - bar.low
        : bar.high - pos.effectiveEntryPrice;
      pos.mfeR = Math.max(pos.mfeR, fav / pos.riskPerUnit);
      pos.maeR = Math.max(pos.maeR, adv / pos.riskPerUnit);
    }

    // 1. Conservative ordering: SL before TP
    const slHit = isBuy ? bar.low <= pos.currentStopLoss : bar.high >= pos.currentStopLoss;
    if (slHit) {
      const reason: BacktestTradeExitReason = pos.movedToBreakeven ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
      const tpHitsCount = pos.takeProfits.filter((t) => t.hit).length;
      const note = pos.movedToBreakeven
        ? `Remainder closed at Breakeven (${pos.currentStopLoss.toFixed(precision)}) after securing ${tpHitsCount} TP(s)`
        : tpHitsCount > 0
          ? `Secured ${tpHitsCount} TP(s) before remainder stopped @ ${pos.currentStopLoss.toFixed(precision)}`
          : `Stopped out @ ${pos.currentStopLoss.toFixed(precision)} (Invalidation ${pos.candidate.invalidationLevel.toFixed(precision)} breached)`;
      closeRemainingPosition(pos, pos.currentStopLoss, bar.time, barIndex, reason, note);
      return;
    }

    // 2. Partial Take Profits
    for (let idx = 0; idx < pos.takeProfits.length; idx++) {
      const tp = pos.takeProfits[idx];
      if (tp.hit) continue;
      const reached = isBuy ? bar.high >= tp.price : bar.low <= tp.price;
      if (!reached) break;

      tp.hit = true;
      tp.hitTime = bar.time;

      const isLast = idx === pos.takeProfits.length - 1;
      const weight = pos.tpWeights[idx] ?? 1 / pos.takeProfits.length;
      const exitUnits = isLast
        ? pos.unitsRemaining
        : Math.min(pos.unitsRemaining, pos.unitsTotal * weight);

      const exitPrice = applyExitSlippage(tp.price, pos.candidate.direction, config.slippageBps);
      const grossLeg = isBuy
        ? (exitPrice - pos.effectiveEntryPrice) * exitUnits
        : (pos.effectiveEntryPrice - exitPrice) * exitUnits;
      const feeLeg = exitUnits * exitPrice * (config.commissionBps / 10000);
      const slipLeg = Math.abs(exitPrice - tp.price) * exitUnits;

      pos.realizedGrossPnl += grossLeg;
      pos.realizedFees += feeLeg;
      pos.slippageCost += slipLeg;
      pos.unitsRemaining = Math.max(0, pos.unitsRemaining - exitUnits);
      equity += grossLeg - feeLeg;

      if (idx === 0 && !isLast && config.moveStopToBreakevenAfterTp1) {
        pos.currentStopLoss = roundNum(pos.effectiveEntryPrice, precision);
        pos.movedToBreakeven = true;
      }

      if (isLast || pos.unitsRemaining <= 1e-10) {
        const exitReason: BacktestTradeExitReason =
          tp.level === 1 ? 'TP1_FULL' : tp.level === 2 ? 'TP2_FULL' : 'TP3_FULL';
        finalizePosition(
          pos,
          tp.price,
          bar.time,
          barIndex,
          exitReason,
          `Target TP${tp.level} reached @ ${tp.price.toFixed(precision)} (${tp.sourceLabel})`
        );
        return;
      }
    }
  };

  const assetClass = getInstrumentMeta(config.symbol).assetClass;
  const mockProviderStatus: ProviderStatus = {
    symbol: config.symbol,
    assetClass,
    providerName: input.providerName,
    connectionStatus: 'CONNECTED',
    feedDelaySeconds: 0,
    lastUpdateTime: Date.now(),
    hasHistoricalCredentials: true,
    hasStreamingFeed: false,
  };

  let htfCursor = 0;
  let dayCursor = 0;
  let lastHtfComputedCount = -1;
  let cachedHtfSnap: AnalysisSnapshot | null = null;
  let evaluatedBars = 0;

  const selectedIdSet = new Set<BacktestStrategyId>(selectedDefs.map((d) => d.id));

  for (let i = warmupBars; i < execCandles.length; i++) {
    const bar = execCandles[i];
    const barCloseTime = bar.time + execSec;

    // Advance standalone baselines in parallel
    for (const sim of standaloneSims.values()) {
      sim.onBar(bar, i);
    }

    // 1. Advance all open basket positions FIRST
    for (const pos of Array.from(openPositions.values())) {
      processOpenPositionOnBar(pos, bar, i);
    }

    // 2. Process pending basket orders deterministically (highest confluenceScore first)
    const pendingList = Array.from(pendingOrders.values()).sort(
      (a, b) =>
        b.candidate.confluenceScore - a.candidate.confluenceScore ||
        a.signalBarIndex - b.signalBarIndex ||
        a.definition.id.localeCompare(b.definition.id)
    );

    for (const ord of pendingList) {
      const sid = ord.definition.id;
      if (i > ord.expiresAtBarIndex || openPositions.has(sid)) {
        pendingOrders.delete(sid);
        continue;
      }

      const c = ord.candidate;
      const isBuy = c.direction === 'BUY';

      const invalidated = isBuy ? bar.low <= c.stopLoss : bar.high >= c.stopLoss;
      if (c.entryMode === 'limit_retest' && invalidated) {
        const filledBeforeSl = isBuy
          ? bar.open >= c.entryPrice && bar.low <= c.entryPrice
          : bar.open <= c.entryPrice && bar.high >= c.entryPrice;
        if (!filledBeforeSl) {
          pendingOrders.delete(sid);
          continue;
        }
      }

      let rawFill: number | null = null;
      if (c.entryMode === 'market_close') {
        if ((isBuy && bar.open <= c.stopLoss) || (!isBuy && bar.open >= c.stopLoss)) {
          pendingOrders.delete(sid);
          continue;
        }
        rawFill = bar.open;
      } else {
        const zoneLo = Math.min(c.entryZone.lower, c.entryZone.upper);
        const zoneHi = Math.max(c.entryZone.lower, c.entryZone.upper);
        if (bar.low <= zoneHi && bar.high >= zoneLo) {
          if (isBuy) {
            rawFill = bar.open <= c.entryPrice ? bar.open : c.entryPrice;
          } else {
            rawFill = bar.open >= c.entryPrice ? bar.open : c.entryPrice;
          }
          if ((isBuy && rawFill <= c.stopLoss) || (!isBuy && rawFill >= c.stopLoss)) {
            pendingOrders.delete(sid);
            continue;
          }
        }
      }

      if (rawFill === null) continue;

      // Triggered fill! Enforce shared-capital concurrent and portfolio heat limits
      const cStat = contribCounters.get(sid);
      if (openPositions.size >= config.maxConcurrentPositions) {
        skippedByConcurrentCap += 1;
        if (cStat) cStat.skippedByConcurrentCap += 1;
        pendingOrders.delete(sid);
        continue;
      }

      let currentOpenRiskDollar = 0;
      for (const pOpen of openPositions.values()) {
        currentOpenRiskDollar += computeOpenRiskDollars(pOpen);
      }
      const currentHeatPct = equity > 0 ? (currentOpenRiskDollar / equity) * 100 : 100;
      if (currentHeatPct + config.riskPerTradePercent > config.maxPortfolioHeatPercent + 1e-6) {
        skippedByHeatCap += 1;
        if (cStat) cStat.skippedByHeatCap += 1;
        pendingOrders.delete(sid);
        continue;
      }

      const effectiveEntry = applyEntrySlippage(rawFill, c.direction, config.slippageBps);
      const riskPerUnit = isBuy ? effectiveEntry - c.stopLoss : c.stopLoss - effectiveEntry;
      if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0 || equity <= 0) {
        pendingOrders.delete(sid);
        continue;
      }

      const desiredRiskAmount = equity * (config.riskPerTradePercent / 100);
      const rawUnits = desiredRiskAmount / riskPerUnit;
      const maxNotionalUnits = (equity * 10) / effectiveEntry;
      const units = Math.min(rawUnits, maxNotionalUnits);
      const actualRiskAmount = units * riskPerUnit;

      const entryNotional = units * effectiveEntry;
      const entryFee = entryNotional * (config.commissionBps / 10000);
      const entrySlipCost = Math.abs(effectiveEntry - rawFill) * units;

      equity -= entryFee;
      tradeCounter += 1;
      const newHeatPct = roundNum(currentHeatPct + config.riskPerTradePercent, 2);

      const activePos: ActiveBasketPosition = {
        tradeNumber: tradeCounter,
        definition: ord.definition,
        candidate: c,
        signalTime: ord.signalTime,
        entryTime: bar.time,
        entryBarIndex: i,
        rawEntryPrice: rawFill,
        effectiveEntryPrice: effectiveEntry,
        currentStopLoss: c.stopLoss,
        initialStopLoss: c.stopLoss,
        unitsTotal: units,
        unitsRemaining: units,
        riskPerUnit,
        riskAmount: actualRiskAmount,
        entryFee,
        realizedGrossPnl: 0,
        realizedFees: entryFee,
        slippageCost: entrySlipCost,
        takeProfits: c.takeProfits.map((tp) => ({ ...tp, hit: false, hitTime: null })),
        tpWeights: getTpWeights(c.takeProfits.length),
        mfeR: 0,
        maeR: 0,
        movedToBreakeven: false,
        concurrentPositionsAtEntry: openPositions.size + 1,
        portfolioHeatAtEntry: newHeatPct,
      };

      openPositions.set(sid, activePos);
      pendingOrders.delete(sid);

      // Conservative intrabar check on fill bar
      const slHitSameBar = isBuy
        ? bar.low <= activePos.currentStopLoss
        : bar.high >= activePos.currentStopLoss;
      if (slHitSameBar) {
        closeRemainingPosition(
          activePos,
          activePos.currentStopLoss,
          bar.time,
          i,
          'STOP_LOSS',
          `Stop Loss ${activePos.currentStopLoss.toFixed(precision)} hit on entry bar`
        );
      }
    }

    // 3. Mark-to-market equity & concurrent/heat stats
    let unrealizedTotal = 0;
    let openRiskDollar = 0;
    for (const pos of openPositions.values()) {
      const isBuy = pos.candidate.direction === 'BUY';
      unrealizedTotal += isBuy
        ? (bar.close - pos.effectiveEntryPrice) * pos.unitsRemaining
        : (pos.effectiveEntryPrice - bar.close) * pos.unitsRemaining;
      openRiskDollar += computeOpenRiskDollars(pos);
    }

    const markEquity = Math.max(0, equity + unrealizedTotal);
    peakEquity = Math.max(peakEquity, markEquity);
    const ddPct = peakEquity > 0 ? ((peakEquity - markEquity) / peakEquity) * 100 : 0;
    const barHeatPct = markEquity > 0 ? (openRiskDollar / markEquity) * 100 : 0;

    peakConcurrentPositions = Math.max(peakConcurrentPositions, openPositions.size);
    peakPortfolioHeatPercent = Math.max(peakPortfolioHeatPercent, barHeatPct);
    sumConcurrentBars += openPositions.size;
    trackedBars += 1;

    fullEquityCurve.push({
      time: bar.time,
      equity: roundNum(markEquity, 2),
      drawdownPercent: roundNum(ddPct, 2),
    });

    if (i >= execCandles.length - 1) {
      break;
    }

    evaluatedBars += 1;

    // 4. Advance causal Daily & HTF windows
    while (
      dayCursor < dailyCandles.length &&
      dailyCandles[dayCursor].time + daySec <= barCloseTime
    ) {
      dayCursor += 1;
    }
    const causalDailyWindow = dailyCandles.slice(Math.max(0, dayCursor - 90), dayCursor);

    while (
      htfCursor < htfCandles.length &&
      htfCandles[htfCursor].time + htfSec <= barCloseTime
    ) {
      htfCursor += 1;
    }

    if (htfCursor >= 25 && htfCursor !== lastHtfComputedCount) {
      lastHtfComputedCount = htfCursor;
      const causalHtfWindow = htfCandles.slice(Math.max(0, htfCursor - 160), htfCursor);
      const htfLast = causalHtfWindow[causalHtfWindow.length - 1];
      const htfQuote: LiveQuote | null = htfLast
        ? {
            symbol: config.symbol,
            price: htfLast.close,
            change24h: 0,
            changePercent24h: 0,
            direction: htfLast.close >= htfLast.open ? 'bullish' : 'bearish',
            provider: input.providerName,
            lastUpdateTime: htfLast.time * 1000,
            providerTimestamp: htfLast.time * 1000,
            feedDelaySeconds: 0,
            connectionStatus: 'CONNECTED',
            marketOpen: true,
            stale: false,
          }
        : null;

      cachedHtfSnap = runDeterministicAnalysis({
        symbol: config.symbol,
        timeframe: config.htfTimeframe,
        candles: causalHtfWindow,
        dailyCandles: causalDailyWindow,
        htfTrend: 'consolidation',
        quote: htfQuote,
        providerStatus: mockProviderStatus,
        settings: techSettings,
      });
    }

    const readyBasketIds = new Set<BacktestStrategyId>();
    const readyStandaloneIds = new Set<BacktestStrategyId>();
    for (const id of selectedIdSet) {
      if (!openPositions.has(id) && !pendingOrders.has(id)) {
        readyBasketIds.add(id);
      }
      if (!standaloneSims.get(id)?.hasOpenOrPending()) {
        readyStandaloneIds.add(id);
      }
    }
    if (readyBasketIds.size === 0 && readyStandaloneIds.size === 0) continue;

    const unionReadyIds = new Set<BacktestStrategyId>([
      ...readyBasketIds,
      ...readyStandaloneIds,
    ]);

    const execWindow = execCandles.slice(Math.max(0, i - 160), i + 1);
    const barQuote: LiveQuote = {
      symbol: config.symbol,
      price: bar.close,
      change24h: 0,
      changePercent24h: 0,
      direction: bar.close >= bar.open ? 'bullish' : 'bearish',
      provider: input.providerName,
      lastUpdateTime: bar.time * 1000,
      providerTimestamp: bar.time * 1000,
      feedDelaySeconds: 0,
      connectionStatus: 'CONNECTED',
      marketOpen: true,
      stale: false,
    };

    const execSnap = runDeterministicAnalysis({
      symbol: config.symbol,
      timeframe: config.timeframe,
      candles: execWindow,
      dailyCandles: causalDailyWindow,
      htfTrend: cachedHtfSnap?.marketStructure.trend ?? 'consolidation',
      quote: barQuote,
      providerStatus: mockProviderStatus,
      settings: techSettings,
    });

    const candidates = evaluateStrategiesOnBar(
      unionReadyIds,
      execSnap,
      cachedHtfSnap,
      bar,
      config
    );

    for (const cand of candidates) {
      if (readyStandaloneIds.has(cand.strategyId)) {
        standaloneSims.get(cand.strategyId)?.submitSignal(cand, i, bar.time);
      }
      if (readyBasketIds.has(cand.strategyId)) {
        const def = defMap.get(cand.strategyId);
        if (def) {
          totalSignalsGenerated += 1;
          pendingOrders.set(cand.strategyId, {
            definition: def,
            candidate: cand,
            signalTime: bar.time,
            signalBarIndex: i,
            expiresAtBarIndex: cand.entryMode === 'market_close' ? i + 1 : i + 8,
          });
        }
      }
    }
  }

  // Finalize remaining open positions at end of data
  const lastBar = execCandles[execCandles.length - 1];
  const lastIndex = execCandles.length - 1;
  pendingOrders.clear();

  for (const pos of Array.from(openPositions.values())) {
    closeRemainingPosition(
      pos,
      lastBar.close,
      lastBar.time,
      lastIndex,
      'END_OF_DATA',
      `Marked-to-market at end of backtest window @ ${lastBar.close.toFixed(precision)}`
    );
  }
  if (fullEquityCurve.length > 0) {
    peakEquity = Math.max(peakEquity, equity);
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    fullEquityCurve[fullEquityCurve.length - 1] = {
      time: lastBar.time,
      equity: roundNum(equity, 2),
      drawdownPercent: roundNum(ddPct, 2),
    };
  }

  for (const sim of standaloneSims.values()) {
    sim.finalizeAtEndOfData(lastBar, lastIndex);
  }
  const standaloneResults = Array.from(standaloneSims.values()).map((s) => s.buildResult());
  const activeStandalone = standaloneResults.filter((s) => s.metrics.totalTrades > 0);
  const standaloneAvgMaxDdPercent =
    activeStandalone.length > 0
      ? roundNum(
          activeStandalone.reduce((sum, s) => sum + s.metrics.maxDrawdownPercent, 0) /
            activeStandalone.length,
          2
        )
      : 0;
  const corrMatrix =
    activeStandalone.length >= 2
      ? buildCorrelationMatrix(activeStandalone, config.initialCapital)
      : null;

  const metrics = computePortfolioMetrics(config, equity, trades, fullEquityCurve);
  const drawdownReductionPercent =
    standaloneAvgMaxDdPercent > 0
      ? roundNum(
          ((standaloneAvgMaxDdPercent - metrics.maxDrawdownPercent) / standaloneAvgMaxDdPercent) *
            100,
          1
        )
      : 0;

  let sampledCurve = fullEquityCurve;
  if (fullEquityCurve.length > 80) {
    const step = Math.ceil(fullEquityCurve.length / 74);
    const out: BacktestEquityPoint[] = [];
    let peakIdx = 0;
    let worstIdx = 0;
    for (let k = 0; k < fullEquityCurve.length; k++) {
      if (fullEquityCurve[k].equity > fullEquityCurve[peakIdx].equity) peakIdx = k;
      if (fullEquityCurve[k].drawdownPercent > fullEquityCurve[worstIdx].drawdownPercent) {
        worstIdx = k;
      }
    }
    for (let k = 0; k < fullEquityCurve.length; k++) {
      if (
        k === 0 ||
        k === fullEquityCurve.length - 1 ||
        k === peakIdx ||
        k === worstIdx ||
        k % step === 0
      ) {
        out.push(fullEquityCurve[k]);
      }
    }
    sampledCurve = out;
  }

  const contributions: BasketStrategyContribution[] = Array.from(contribCounters.values())
    .map((c) => ({
      strategy: c.def,
      tradesExecuted: c.tradesExecuted,
      wins: c.wins,
      losses: c.losses,
      winRate: c.tradesExecuted > 0 ? roundNum((c.wins / c.tradesExecuted) * 100, 1) : 0,
      netPnl: roundNum(c.netPnl, 2),
      avgR: c.tradesExecuted > 0 ? roundNum(c.sumR / c.tradesExecuted, 2) : 0,
      skippedByConcurrentCap: c.skippedByConcurrentCap,
      skippedByHeatCap: c.skippedByHeatCap,
    }))
    .sort((a, b) => b.netPnl - a.netPnl || b.tradesExecuted - a.tradesExecuted);

  return {
    id: `BASKET-${config.symbol}-${config.timeframe}-${startedAt}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    config,
    dataRange: {
      startTime: execCandles[0].time,
      endTime: lastBar.time,
      totalBars: execCandles.length,
      evaluatedBars,
      htfBars: htfCandles.length,
      provider: input.providerName,
    },
    metrics,
    equityCurve: sampledCurve,
    trades: [...trades].reverse().slice(0, 500),
    contributions,
    totalSignalsGenerated,
    totalTradesExecuted: trades.length,
    skippedByConcurrentCap,
    skippedByHeatCap,
    avgConcurrentPositions: trackedBars > 0 ? roundNum(sumConcurrentBars / trackedBars, 2) : 0,
    peakConcurrentPositions,
    peakPortfolioHeatPercent: roundNum(peakPortfolioHeatPercent, 2),
    avgPairwiseCorrelation: corrMatrix ? corrMatrix.avgPairwiseCorrelation : 0,
    standaloneAvgMaxDdPercent,
    drawdownReductionPercent,
  };
}
