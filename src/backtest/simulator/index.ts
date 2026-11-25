import { getInstrumentMeta, TIMEFRAME_SECONDS } from '../../shared/constants/index.ts';
import type {
  BacktestConfig,
  BacktestEquityPoint,
  BacktestStrategyDefinition,
  BacktestStrategyMetrics,
  BacktestStrategyResult,
  BacktestTradeExitReason,
  BacktestTradeRecord,
  BacktestTradeTarget,
  Candle,
} from '../../shared/types/index.ts';
import type { StrategySignalCandidate } from '../strategies/index.ts';

interface PendingOrder {
  candidate: StrategySignalCandidate;
  signalTime: number;
  signalBarIndex: number;
  expiresAtBarIndex: number;
}

interface ActivePosition {
  tradeNumber: number;
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

export class StrategyPortfolioSimulator {
  public readonly definition: BacktestStrategyDefinition;
  private readonly config: BacktestConfig;
  private readonly precision: number;

  private equity: number;
  private peakEquity: number;
  private pending: PendingOrder | null = null;
  private active: ActivePosition | null = null;
  private tradeCounter = 0;

  private readonly trades: BacktestTradeRecord[] = [];
  private readonly equityCurve: BacktestEquityPoint[] = [];

  constructor(definition: BacktestStrategyDefinition, config: BacktestConfig, startTime: number) {
    this.definition = definition;
    this.config = config;
    this.precision = getInstrumentMeta(config.symbol).pricePrecision;
    this.equity = config.initialCapital;
    this.peakEquity = config.initialCapital;
    this.equityCurve.push({
      time: startTime,
      equity: roundNum(this.equity, 2),
      drawdownPercent: 0,
    });
  }

  public hasOpenOrPending(): boolean {
    return this.active !== null || this.pending !== null;
  }

  public submitSignal(candidate: StrategySignalCandidate, barIndex: number, signalTime: number): void {
    if (this.hasOpenOrPending()) return;
    this.pending = {
      candidate,
      signalTime,
      signalBarIndex: barIndex,
      expiresAtBarIndex: candidate.entryMode === 'market_close' ? barIndex + 1 : barIndex + 8,
    };
  }

  public onBar(bar: Candle, barIndex: number): void {
    // 1. Manage existing active position first
    if (this.active) {
      this.processActivePositionOnBar(bar, barIndex);
    }

    // 2. Check pending order fill if no active position
    if (!this.active && this.pending) {
      this.processPendingOrderOnBar(bar, barIndex);
    }

    // 3. Track mark-to-market equity point on curve (sampled cleanly)
    let markEquity = this.equity;
    if (this.active) {
      const isBuy = this.active.candidate.direction === 'BUY';
      const unrealized = isBuy
        ? (bar.close - this.active.effectiveEntryPrice) * this.active.unitsRemaining
        : (this.active.effectiveEntryPrice - bar.close) * this.active.unitsRemaining;
      markEquity = Math.max(0, this.equity + unrealized);
    }
    this.peakEquity = Math.max(this.peakEquity, markEquity);
    const ddPct = this.peakEquity > 0 ? ((this.peakEquity - markEquity) / this.peakEquity) * 100 : 0;

    this.equityCurve.push({
      time: bar.time,
      equity: roundNum(markEquity, 2),
      drawdownPercent: roundNum(ddPct, 2),
    });
  }

  private processPendingOrderOnBar(bar: Candle, barIndex: number): void {
    const ord = this.pending;
    if (!ord) return;

    if (barIndex > ord.expiresAtBarIndex) {
      this.pending = null;
      return;
    }

    const c = ord.candidate;
    const isBuy = c.direction === 'BUY';

    // Invalidation before fill
    const invalidated = isBuy ? bar.low <= c.stopLoss : bar.high >= c.stopLoss;
    if (c.entryMode === 'limit_retest' && invalidated) {
      // If bar already gapped past SL at open, never fill
      const gappedPastSl = isBuy ? bar.open <= c.stopLoss : bar.open >= c.stopLoss;
      const reachedEntryFirst = isBuy
        ? bar.open >= c.entryPrice && bar.low <= c.entryPrice
        : bar.open <= c.entryPrice && bar.high >= c.entryPrice;
      if (gappedPastSl || !reachedEntryFirst) {
        this.pending = null;
        return;
      }
    }

    let rawFill: number | null = null;
    if (c.entryMode === 'market_close') {
      // Enter at next bar's open unless open already gapped beyond SL
      if ((isBuy && bar.open <= c.stopLoss) || (!isBuy && bar.open >= c.stopLoss)) {
        this.pending = null;
        return;
      }
      rawFill = bar.open;
    } else {
      // Strict OHLC limit retest fill: price must genuinely trade to or beyond c.entryPrice
      const reachedEntry = isBuy ? bar.low <= c.entryPrice : bar.high >= c.entryPrice;
      if (reachedEntry) {
        if (isBuy) {
          rawFill = bar.open <= c.entryPrice ? bar.open : c.entryPrice;
        } else {
          rawFill = bar.open >= c.entryPrice ? bar.open : c.entryPrice;
        }
        if ((isBuy && rawFill <= c.stopLoss) || (!isBuy && rawFill >= c.stopLoss)) {
          this.pending = null;
          return;
        }
      }
    }

    if (rawFill === null) return;

    const effectiveEntry = applyEntrySlippage(rawFill, c.direction, this.config.slippageBps);
    const riskPerUnit = isBuy ? effectiveEntry - c.stopLoss : c.stopLoss - effectiveEntry;
    if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0 || this.equity <= 0) {
      this.pending = null;
      return;
    }

    const desiredRiskAmount = this.equity * (this.config.riskPerTradePercent / 100);
    const rawUnits = desiredRiskAmount / riskPerUnit;
    const maxNotionalUnits = (this.equity * 10) / effectiveEntry; // Cap at 10x leverage
    const units = Math.min(rawUnits, maxNotionalUnits);
    const actualRiskAmount = units * riskPerUnit;

    const entryNotional = units * effectiveEntry;
    const entryFee = entryNotional * (this.config.commissionBps / 10000);
    const entrySlipCost = Math.abs(effectiveEntry - rawFill) * units;

    this.equity -= entryFee;
    this.tradeCounter += 1;

    this.active = {
      tradeNumber: this.tradeCounter,
      candidate: c,
      signalTime: ord.signalTime,
      entryTime: bar.time,
      entryBarIndex: barIndex,
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
    };

    this.pending = null;

    // Conservative intrabar check on fill bar: if SL is breached on the exact same fill bar, stop out immediately
    const slHitSameBar = isBuy ? bar.low <= this.active.currentStopLoss : bar.high >= this.active.currentStopLoss;
    if (slHitSameBar) {
      this.closeRemainingPosition(
        this.active.currentStopLoss,
        bar.time,
        barIndex,
        'STOP_LOSS',
        `Stop Loss ${this.active.currentStopLoss.toFixed(this.precision)} hit on entry bar`
      );
    }
  }

  private processActivePositionOnBar(bar: Candle, barIndex: number): void {
    const pos = this.active;
    if (!pos) return;
    const isBuy = pos.candidate.direction === 'BUY';

    // Update MFE / MAE in R
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

    // 1. Conservative ordering: check Stop Loss FIRST (including gap-through open fills)
    const slGapped = isBuy ? bar.open <= pos.currentStopLoss : bar.open >= pos.currentStopLoss;
    const slHit = slGapped || (isBuy ? bar.low <= pos.currentStopLoss : bar.high >= pos.currentStopLoss);
    if (slHit) {
      const fillStopPrice = slGapped ? bar.open : pos.currentStopLoss;
      const reason: BacktestTradeExitReason = pos.movedToBreakeven ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
      const tpHitsCount = pos.takeProfits.filter((t) => t.hit).length;
      const note = slGapped
        ? `Stop Loss gapped at open (${fillStopPrice.toFixed(this.precision)} vs SL ${pos.currentStopLoss.toFixed(this.precision)})`
        : pos.movedToBreakeven
          ? `Remainder closed at Breakeven (${pos.currentStopLoss.toFixed(this.precision)}) after securing ${tpHitsCount} TP(s)`
          : tpHitsCount > 0
            ? `Secured ${tpHitsCount} TP(s) before remainder stopped @ ${pos.currentStopLoss.toFixed(this.precision)}`
            : `Stopped out @ ${pos.currentStopLoss.toFixed(this.precision)} (Invalidation ${pos.candidate.invalidationLevel.toFixed(this.precision)} breached)`;
      this.closeRemainingPosition(fillStopPrice, bar.time, barIndex, reason, note);
      return;
    }

    // 2. Check Take Profit levels sequentially
    for (let idx = 0; idx < pos.takeProfits.length; idx++) {
      const tp = pos.takeProfits[idx];
      if (tp.hit) continue;
      const reached = isBuy ? bar.high >= tp.price : bar.low <= tp.price;
      if (!reached) break;

      tp.hit = true;
      tp.hitTime = bar.time;

      const isLast = idx === pos.takeProfits.length - 1;
      const weight = pos.tpWeights[idx] ?? 1 / pos.takeProfits.length;
      const exitUnits = isLast ? pos.unitsRemaining : Math.min(pos.unitsRemaining, pos.unitsTotal * weight);

      const exitPrice = applyExitSlippage(tp.price, pos.candidate.direction, this.config.slippageBps);
      const grossLeg = isBuy
        ? (exitPrice - pos.effectiveEntryPrice) * exitUnits
        : (pos.effectiveEntryPrice - exitPrice) * exitUnits;
      const feeLeg = exitUnits * exitPrice * (this.config.commissionBps / 10000);
      const slipLeg = Math.abs(exitPrice - tp.price) * exitUnits;

      pos.realizedGrossPnl += grossLeg;
      pos.realizedFees += feeLeg;
      pos.slippageCost += slipLeg;
      pos.unitsRemaining = Math.max(0, pos.unitsRemaining - exitUnits);
      this.equity += grossLeg - feeLeg;

      if (idx === 0 && !isLast && this.config.moveStopToBreakevenAfterTp1) {
        pos.currentStopLoss = roundNum(pos.effectiveEntryPrice, this.precision);
        pos.movedToBreakeven = true;
      }

      if (isLast || pos.unitsRemaining <= 1e-10) {
        const exitReason: BacktestTradeExitReason =
          tp.level === 1 ? 'TP1_FULL' : tp.level === 2 ? 'TP2_FULL' : 'TP3_FULL';
        this.finalizeTrade(
          tp.price,
          bar.time,
          barIndex,
          exitReason,
          `Target TP${tp.level} reached @ ${tp.price.toFixed(this.precision)} (${tp.sourceLabel})`
        );
        return;
      }
    }
  }

  private closeRemainingPosition(
    rawExitPrice: number,
    exitTime: number,
    barIndex: number,
    exitReason: BacktestTradeExitReason,
    exitNote: string
  ): void {
    const pos = this.active;
    if (!pos) return;
    const isBuy = pos.candidate.direction === 'BUY';

    const exitPrice = applyExitSlippage(rawExitPrice, pos.candidate.direction, this.config.slippageBps);
    const grossLeg = isBuy
      ? (exitPrice - pos.effectiveEntryPrice) * pos.unitsRemaining
      : (pos.effectiveEntryPrice - exitPrice) * pos.unitsRemaining;
    const feeLeg = pos.unitsRemaining * exitPrice * (this.config.commissionBps / 10000);
    const slipLeg = Math.abs(exitPrice - rawExitPrice) * pos.unitsRemaining;

    pos.realizedGrossPnl += grossLeg;
    pos.realizedFees += feeLeg;
    pos.slippageCost += slipLeg;
    pos.unitsRemaining = 0;
    this.equity += grossLeg - feeLeg;

    this.finalizeTrade(rawExitPrice, exitTime, barIndex, exitReason, exitNote);
  }

  private finalizeTrade(
    exitPrice: number,
    exitTime: number,
    barIndex: number,
    exitReason: BacktestTradeExitReason,
    exitNote: string
  ): void {
    const pos = this.active;
    if (!pos) return;

    // Net PnL = gross across all legs minus all commissions (entryFee was deducted on entry, exitFees on exit)
    const netPnl = pos.realizedGrossPnl - pos.realizedFees;
    const realizedR = pos.riskAmount > 0 ? netPnl / pos.riskAmount : 0;
    const equityBefore = this.equity - netPnl;
    const returnPct = equityBefore > 0 ? (netPnl / equityBefore) * 100 : 0;

    this.peakEquity = Math.max(this.peakEquity, this.equity);

    this.trades.push({
      id: `${this.definition.id}-T${pos.tradeNumber}`,
      tradeNumber: pos.tradeNumber,
      strategyId: this.definition.id,
      direction: pos.candidate.direction,
      entryMode: pos.candidate.entryMode,
      signalTime: pos.signalTime,
      entryTime: pos.entryTime,
      exitTime,
      barsHeld: Math.max(1, barIndex - pos.entryBarIndex),
      entryPrice: roundNum(pos.effectiveEntryPrice, this.precision),
      stopLoss: roundNum(pos.currentStopLoss, this.precision),
      initialStopLoss: roundNum(pos.initialStopLoss, this.precision),
      invalidationLevel: roundNum(pos.candidate.invalidationLevel, this.precision),
      exitPrice: roundNum(exitPrice, this.precision),
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
      equityAfter: roundNum(this.equity, 2),
      confluenceScore: pos.candidate.confluenceScore,
      entryRationale: pos.candidate.entryRationale,
      exitNote,
    });

    this.active = null;
  }

  public finalizeAtEndOfData(lastBar: Candle, lastBarIndex: number): void {
    this.pending = null;
    if (this.active) {
      this.closeRemainingPosition(
        lastBar.close,
        lastBar.time,
        lastBarIndex,
        'END_OF_DATA',
        `Marked-to-market at end of backtest window @ ${lastBar.close.toFixed(this.precision)}`
      );
      this.peakEquity = Math.max(this.peakEquity, this.equity);
      const ddPct = this.peakEquity > 0 ? ((this.peakEquity - this.equity) / this.peakEquity) * 100 : 0;
      this.equityCurve.push({
        time: lastBar.time,
        equity: roundNum(this.equity, 2),
        drawdownPercent: roundNum(ddPct, 2),
      });
    }
  }

  public buildResult(): BacktestStrategyResult {
    const startCap = this.config.initialCapital;
    const endEq = roundNum(this.equity, 2);
    const netProfit = roundNum(endEq - startCap, 2);
    const netReturnPercent = startCap > 0 ? roundNum((netProfit / startCap) * 100, 2) : 0;

    const total = this.trades.length;
    const wins = this.trades.filter((t) => t.netPnl > 0.01);
    const losses = this.trades.filter((t) => t.netPnl < -0.01);
    const breakevens = this.trades.filter((t) => Math.abs(t.netPnl) <= 0.01);

    const longs = this.trades.filter((t) => t.direction === 'BUY');
    const shorts = this.trades.filter((t) => t.direction === 'SELL');
    const longWins = longs.filter((t) => t.netPnl > 0.01);
    const shortWins = shorts.filter((t) => t.netPnl > 0.01);

    const grossProfit = roundNum(
      wins.reduce((s, t) => s + t.netPnl, 0),
      2
    );
    const grossLoss = roundNum(
      Math.abs(losses.reduce((s, t) => s + t.netPnl, 0)),
      2
    );
    const totalFeesAndSlippage = roundNum(
      this.trades.reduce((s, t) => s + t.feesAndSlippage, 0),
      2
    );

    const profitFactor =
      grossLoss > 0 ? roundNum(grossProfit / grossLoss, 2) : grossProfit > 0 ? 99.9 : null;
    const winRate = total > 0 ? roundNum((wins.length / total) * 100, 1) : 0;

    const expectancyR =
      total > 0 ? roundNum(this.trades.reduce((s, t) => s + t.realizedR, 0) / total, 2) : 0;
    const expectancyDollar = total > 0 ? roundNum(netProfit / total, 2) : 0;

    const avgWinR =
      wins.length > 0 ? roundNum(wins.reduce((s, t) => s + t.realizedR, 0) / wins.length, 2) : 0;
    const avgLossR =
      losses.length > 0
        ? roundNum(Math.abs(losses.reduce((s, t) => s + t.realizedR, 0) / losses.length), 2)
        : 0;
    const avgWinDollar = wins.length > 0 ? roundNum(grossProfit / wins.length, 2) : 0;
    const avgLossDollar = losses.length > 0 ? roundNum(grossLoss / losses.length, 2) : 0;

    const bestTradeR =
      total > 0 ? roundNum(Math.max(...this.trades.map((t) => t.realizedR)), 2) : 0;
    const worstTradeR =
      total > 0 ? roundNum(Math.min(...this.trades.map((t) => t.realizedR)), 2) : 0;

    // Max Drawdown $ & % from equity curve
    let peak = startCap;
    let maxDdDollar = 0;
    let maxDdPct = 0;
    for (const pt of this.equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const ddD = peak - pt.equity;
      const ddP = peak > 0 ? (ddD / peak) * 100 : 0;
      if (ddD > maxDdDollar) maxDdDollar = ddD;
      if (ddP > maxDdPct) maxDdPct = ddP;
    }

    const recoveryFactor =
      maxDdDollar > 0 ? roundNum(netProfit / maxDdDollar, 2) : netProfit > 0 ? 99.9 : null;

    // Sharpe & Sortino from per-bar equity returns
    const barReturns: number[] = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      const prev = this.equityCurve[i - 1].equity;
      const curr = this.equityCurve[i].equity;
      if (prev > 0) barReturns.push((curr - prev) / prev);
    }
    const tfSec = TIMEFRAME_SECONDS[this.config.timeframe] || 900;
    const isCrypto = this.config.symbol === 'BTCUSDT' || this.config.symbol === 'ETHUSDT';
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
    for (const t of this.trades) {
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
      total > 0 ? roundNum(this.trades.reduce((s, t) => s + t.barsHeld, 0) / total, 1) : 0;

    const tp1HitRate =
      total > 0 ? roundNum((this.trades.filter((t) => t.tp1Hit).length / total) * 100, 1) : 0;
    const tp2Trades = this.trades.filter((t) => t.takeProfits.length >= 2);
    const tp2HitRate =
      tp2Trades.length > 0
        ? roundNum((tp2Trades.filter((t) => t.tp2Hit).length / tp2Trades.length) * 100, 1)
        : 0;
    const tp3Trades = this.trades.filter((t) => t.takeProfits.length >= 3);
    const tp3HitRate =
      tp3Trades.length > 0
        ? roundNum((tp3Trades.filter((t) => t.tp3Hit).length / tp3Trades.length) * 100, 1)
        : 0;
    const slHitRate =
      total > 0
        ? roundNum(
            (this.trades.filter((t) => t.exitReason === 'STOP_LOSS').length / total) * 100,
            1
          )
        : 0;

    // Composite Institutional Quant Score (0..100) balancing Expectancy, PF, Sharpe, Return, DD, and Sample Size
    let compositeScore = 0;
    if (total > 0) {
      const sampleWeight = Math.min(1, total / 8); // dampens tiny <8 trade samples
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

    const metrics: BacktestStrategyMetrics = {
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

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (total === 0) {
      weaknesses.push('No qualifying setups triggered within historical window');
    } else {
      if ((profitFactor ?? 0) >= 1.5) strengths.push(`Strong Profit Factor (${profitFactor})`);
      if (expectancyR > 0.2) strengths.push(`Positive Expectancy (+${expectancyR}R / trade)`);
      if (winRate >= 55) strengths.push(`High Win Rate (${winRate}%)`);
      if (maxDdPct <= 6) strengths.push(`Controlled Max Drawdown (${roundNum(maxDdPct, 2)}%)`);
      if (sharpeRatio >= 1.2) strengths.push(`Healthy Risk-Adjusted Return (Sharpe ${sharpeRatio})`);

      if (netProfit < 0) weaknesses.push(`Negative Net Return (${netReturnPercent}%)`);
      if ((profitFactor ?? 0) < 1.1 && total > 0) weaknesses.push(`Low Profit Factor (${profitFactor ?? 0})`);
      if (maxDdPct > 12) weaknesses.push(`Elevated Drawdown (${roundNum(maxDdPct, 2)}%)`);
      if (total < 5) weaknesses.push(`Small sample size (${total} trades) — test wider bar history`);
    }

    const verdict =
      total === 0
        ? 'No setups matched strict rules in window'
        : netProfit > 0 && (profitFactor ?? 0) >= 1.35 && total >= 4
          ? 'Profitable Edge'
          : netProfit > 0
            ? 'Marginal Positive'
            : 'Unprofitable on Window';

    let sampledCurve = this.equityCurve;
    if (this.equityCurve.length > 80) {
      const step = Math.ceil(this.equityCurve.length / 74);
      const out: BacktestEquityPoint[] = [];
      let peakEqIdx = 0;
      let worstDdIdx = 0;
      for (let i = 0; i < this.equityCurve.length; i++) {
        if (this.equityCurve[i].equity > this.equityCurve[peakEqIdx].equity) {
          peakEqIdx = i;
        }
        if (this.equityCurve[i].drawdownPercent > this.equityCurve[worstDdIdx].drawdownPercent) {
          worstDdIdx = i;
        }
      }
      for (let i = 0; i < this.equityCurve.length; i++) {
        if (
          i === 0 ||
          i === this.equityCurve.length - 1 ||
          i === peakEqIdx ||
          i === worstDdIdx ||
          i % step === 0
        ) {
          out.push(this.equityCurve[i]);
        }
      }
      sampledCurve = out;
    }

    return {
      strategy: this.definition,
      rank: 1,
      metrics,
      trades: [...this.trades].reverse(),
      equityCurve: sampledCurve,
      verdict,
      strengths,
      weaknesses,
    };
  }
}
