import { getContractSpec } from '../shared/constants/index.ts';
import type {
  ExecutionInstruction,
  InstrumentSymbol,
  PaperFill,
  PaperOrder,
  PaperPosition,
  TradingSignal,
} from '../shared/types/index.ts';

function roundVolume(vol: number, step: number): number {
  if (step <= 0) return Number(vol.toFixed(4));
  const rounded = Math.round(vol / step) * step;
  return Number(rounded.toFixed(4));
}

export class PaperExecutionAdapter {
  private orders = new Map<string, PaperOrder>();
  private positions = new Map<string, PaperPosition>();
  private fills: PaperFill[] = [];
  private idempotencyKeys = new Set<string>();

  public hydrate(orders: PaperOrder[], positions: PaperPosition[]): void {
    this.orders.clear();
    this.positions.clear();
    this.idempotencyKeys.clear();

    for (const ord of orders) {
      this.orders.set(ord.id, ord);
      if (ord.idempotencyKey) {
        this.idempotencyKeys.add(ord.idempotencyKey);
      }
    }
    for (const pos of positions) {
      this.positions.set(pos.id, pos);
    }
  }

  public clearAll(): void {
    this.orders.clear();
    this.positions.clear();
    this.fills = [];
    this.idempotencyKeys.clear();
  }

  public hasIdempotencyKey(key: string): boolean {
    return this.idempotencyKeys.has(key);
  }

  public execute(
    instruction: ExecutionInstruction,
    signal: TradingSignal,
    approvedVolume: number,
    currentPrice: number
  ): {
    order: PaperOrder;
    position: PaperPosition | null;
    fill: PaperFill | null;
  } {
    const now = Date.now();
    if (this.idempotencyKeys.has(instruction.idempotencyKey)) {
      throw new Error(`Duplicate idempotency key rejected: ${instruction.idempotencyKey}`);
    }
    this.idempotencyKeys.add(instruction.idempotencyKey);

    const contract = getContractSpec(signal.symbol);
    const isBuy = signal.direction === 'BUY';
    const slipBps = contract.slippageBps;
    const fillPrice = isBuy
      ? currentPrice * (1 + slipBps / 10000)
      : currentPrice * (1 - slipBps / 10000);

    const orderId = `ord:paper:${signal.id}:${now}`;
    const positionId = `pos:paper:${signal.id}:${now}`;

    const spreadCostUsd =
      approvedVolume * contract.contractSize * fillPrice * (contract.defaultSpreadBps / 10000);
    const commissionUsd = approvedVolume * contract.commissionPerLotUsd;
    const slippageUsd = Math.abs(fillPrice - currentPrice) * approvedVolume * contract.contractSize;
    const totalFeesUsd = Number((commissionUsd + spreadCostUsd).toFixed(2));

    const order: PaperOrder = {
      id: orderId,
      idempotencyKey: instruction.idempotencyKey,
      signalId: signal.id,
      strategyId: signal.strategyId ?? 'unknown',
      strategyName: signal.strategyName ?? 'Strategy Signal',
      strategyVersion: signal.strategyVersion ?? 'v1.0',
      symbol: signal.symbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      volume: approvedVolume,
      requestedPrice: currentPrice,
      fillPrice,
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits.map((tp) => ({ ...tp })),
      plannedRR: signal.primaryRR,
      status: 'FILLED',
      spreadCostUsd: Number(spreadCostUsd.toFixed(2)),
      commissionUsd: Number(commissionUsd.toFixed(2)),
      slippageUsd: Number(slippageUsd.toFixed(2)),
      createdAt: now,
      filledAt: now,
    };

    const actualRiskUsd = Number(
      (Math.abs(fillPrice - signal.stopLoss) * approvedVolume * contract.contractSize).toFixed(2)
    );

    const position: PaperPosition = {
      id: positionId,
      orderId,
      signalId: signal.id,
      journalId: `jnl:${positionId}`,
      strategyId: signal.strategyId ?? 'unknown',
      strategyName: signal.strategyName ?? 'Strategy Signal',
      strategyVersion: signal.strategyVersion ?? 'v1.0',
      symbol: signal.symbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      stopLoss: signal.stopLoss,
      initialStopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits.map((tp) => ({ ...tp })),
      volumeTotal: approvedVolume,
      volumeRemaining: approvedVolume,
      riskAmountUsd: actualRiskUsd,
      unrealizedPnlUsd: -totalFeesUsd,
      realizedPnlUsd: 0,
      realizedR: 0,
      feesUsd: totalFeesUsd,
      slippageUsd: Number(slippageUsd.toFixed(2)),
      status: 'OPEN',
      exitPrice: null,
      exitReason: null,
      openedAt: now,
      closedAt: null,
    };

    const fill: PaperFill = {
      id: `fill:${orderId}:entry`,
      orderId,
      positionId,
      symbol: signal.symbol,
      direction: signal.direction,
      fillKind: 'ENTRY',
      price: fillPrice,
      volume: approvedVolume,
      grossPnlUsd: 0,
      feeUsd: totalFeesUsd,
      slippageUsd: Number(slippageUsd.toFixed(2)),
      netPnlUsd: -totalFeesUsd,
      timestamp: now,
    };

    this.orders.set(orderId, order);
    this.positions.set(positionId, position);
    this.fills.push(fill);

    return { order, position, fill };
  }

  public processPriceUpdate(
    symbol: InstrumentSymbol,
    priceInfo: {
      price: number;
      bid?: number;
      ask?: number;
      high?: number;
      low?: number;
    },
    now = Date.now()
  ): {
    updatedPositions: PaperPosition[];
    closedPositions: PaperPosition[];
  } {
    const updatedPositions: PaperPosition[] = [];
    const closedPositions: PaperPosition[] = [];
    const contract = getContractSpec(symbol);

    for (const pos of this.positions.values()) {
      if (pos.symbol !== symbol) continue;
      if (pos.status !== 'OPEN' && pos.status !== 'PARTIAL') continue;

      const isBuy = pos.direction === 'BUY';
      const markPrice = isBuy
        ? (priceInfo.bid ?? priceInfo.price)
        : (priceInfo.ask ?? priceInfo.price);

      if (!Number.isFinite(markPrice) || markPrice <= 0) continue;

      const checkLow = priceInfo.low !== undefined ? Math.min(markPrice, priceInfo.low) : markPrice;
      const checkHigh = priceInfo.high !== undefined ? Math.max(markPrice, priceInfo.high) : markPrice;

      pos.currentPrice = markPrice;
      let changed = true;

      // 1. Conservative Stop-Loss check first
      const slHit = isBuy ? checkLow <= pos.stopLoss : checkHigh >= pos.stopLoss;
      if (slHit) {
        const exitSlipFactor = 1 + (contract.slippageBps / 10000) * 0.5;
        const exitPrice = isBuy
          ? Math.min(pos.stopLoss, markPrice) / exitSlipFactor
          : Math.max(pos.stopLoss, markPrice) * exitSlipFactor;
        const isBreakeven = Math.abs(pos.stopLoss - pos.entryPrice) <= contract.tickSize * 2;
        this.closeRemainingVolume(
          pos,
          exitPrice,
          isBreakeven ? 'BREAKEVEN_STOP' : 'STOP_LOSS',
          contract.contractSize,
          now
        );
        updatedPositions.push(pos);
        closedPositions.push(pos);
        continue;
      }

      // 2. Check Take Profit levels in order (TP1 -> TP2 -> TP3)
      const sortedTps = [...pos.takeProfits].sort((a, b) => a.level - b.level);
      for (let idx = 0; idx < sortedTps.length; idx++) {
        const tp = sortedTps[idx];
        if (tp.hit) continue;

        const tpHit = isBuy ? checkHigh >= tp.price : checkLow <= tp.price;
        if (!tpHit) break;

        tp.hit = true;
        tp.hitTime = now;
        const hasMoreTps = idx < sortedTps.length - 1;

        if (!hasMoreTps) {
          this.closeRemainingVolume(
            pos,
            tp.price,
            `TP${tp.level}_FULL`,
            contract.contractSize,
            now
          );
          closedPositions.push(pos);
          break;
        } else {
          // Partial take profit on TP1/TP2 + move Stop Loss to breakeven
          const halfVol = roundVolume(pos.volumeRemaining * 0.5, contract.volumeStep);
          const remAfterSplit = Number((pos.volumeRemaining - halfVol).toFixed(4));
          const canSplit =
            halfVol >= contract.minVolume &&
            remAfterSplit >= contract.minVolume;

          if (canSplit) {
            this.realizePartialLeg(
              pos,
              tp.price,
              halfVol,
              `PARTIAL_TP${tp.level}`,
              contract.contractSize,
              now
            );
          }

          // Move SL to breakeven on TP1, or TP1 price on TP2
          if (tp.level === 1) {
            if (isBuy && pos.stopLoss < pos.entryPrice) {
              pos.stopLoss = pos.entryPrice;
            } else if (!isBuy && pos.stopLoss > pos.entryPrice) {
              pos.stopLoss = pos.entryPrice;
            }
          } else if (tp.level === 2 && sortedTps[0]) {
            if (isBuy && pos.stopLoss < sortedTps[0].price) {
              pos.stopLoss = sortedTps[0].price;
            } else if (!isBuy && pos.stopLoss > sortedTps[0].price) {
              pos.stopLoss = sortedTps[0].price;
            }
          }
          pos.status = 'PARTIAL';
        }
      }

      if (pos.status === 'OPEN' || pos.status === 'PARTIAL') {
        const grossOpen =
          (isBuy ? markPrice - pos.entryPrice : pos.entryPrice - markPrice) *
          pos.volumeRemaining *
          contract.contractSize;
        const remainingFeeShare =
          pos.volumeTotal > 0 ? pos.feesUsd * (pos.volumeRemaining / pos.volumeTotal) : 0;
        pos.unrealizedPnlUsd = Number((grossOpen - remainingFeeShare).toFixed(2));
      }

      if (changed) {
        updatedPositions.push(pos);
      }
    }

    return { updatedPositions, closedPositions };
  }

  public closePositionManually(positionId: string, marketPrice: number, now = Date.now()): PaperPosition | null {
    const pos = this.positions.get(positionId);
    if (!pos || (pos.status !== 'OPEN' && pos.status !== 'PARTIAL')) {
      return null;
    }
    const contract = getContractSpec(pos.symbol);
    this.closeRemainingVolume(pos, marketPrice, 'MANUAL_CLOSE', contract.contractSize, now);
    return pos;
  }

  private realizePartialLeg(
    pos: PaperPosition,
    exitPrice: number,
    volumeToClose: number,
    reason: string,
    contractSize: number,
    now: number
  ): void {
    const isBuy = pos.direction === 'BUY';
    const grossPnl =
      (isBuy ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) *
      volumeToClose *
      contractSize;
    const feeShare = pos.volumeTotal > 0 ? pos.feesUsd * (volumeToClose / pos.volumeTotal) : 0;
    const netLegPnl = grossPnl - feeShare;

    pos.volumeRemaining = Number(Math.max(0, pos.volumeRemaining - volumeToClose).toFixed(4));
    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + netLegPnl).toFixed(2));
    pos.realizedR =
      pos.riskAmountUsd > 0 ? Number((pos.realizedPnlUsd / pos.riskAmountUsd).toFixed(2)) : 0;

    this.fills.push({
      id: `fill:${pos.orderId}:${reason}:${now}`,
      orderId: pos.orderId,
      positionId: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      fillKind: 'PARTIAL_TP',
      price: exitPrice,
      volume: volumeToClose,
      grossPnlUsd: Number(grossPnl.toFixed(2)),
      feeUsd: Number(feeShare.toFixed(2)),
      slippageUsd: 0,
      netPnlUsd: Number(netLegPnl.toFixed(2)),
      timestamp: now,
    });
  }

  private closeRemainingVolume(
    pos: PaperPosition,
    exitPrice: number,
    exitReason: string,
    contractSize: number,
    now: number
  ): void {
    const isBuy = pos.direction === 'BUY';
    const vol = pos.volumeRemaining;
    const grossPnl =
      (isBuy ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) * vol * contractSize;
    const feeShare = pos.volumeTotal > 0 ? pos.feesUsd * (vol / pos.volumeTotal) : 0;
    const netLegPnl = grossPnl - feeShare;

    pos.volumeRemaining = 0;
    pos.currentPrice = exitPrice;
    pos.exitPrice = exitPrice;
    pos.exitReason = exitReason;
    pos.unrealizedPnlUsd = 0;
    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + netLegPnl).toFixed(2));
    pos.realizedR =
      pos.riskAmountUsd > 0 ? Number((pos.realizedPnlUsd / pos.riskAmountUsd).toFixed(2)) : 0;
    pos.status = 'CLOSED';
    pos.closedAt = now;

    this.fills.push({
      id: `fill:${pos.orderId}:exit:${now}`,
      orderId: pos.orderId,
      positionId: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      fillKind: 'EXIT',
      price: exitPrice,
      volume: vol,
      grossPnlUsd: Number(grossPnl.toFixed(2)),
      feeUsd: Number(feeShare.toFixed(2)),
      slippageUsd: 0,
      netPnlUsd: Number(netLegPnl.toFixed(2)),
      timestamp: now,
    });
  }

  public getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === 'OPEN' || p.status === 'PARTIAL'
    );
  }

  public getAllPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).sort((a, b) => b.openedAt - a.openedAt);
  }

  public getOrders(): PaperOrder[] {
    return Array.from(this.orders.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getFills(): PaperFill[] {
    return this.fills;
  }
}
