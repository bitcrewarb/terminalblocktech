import type {
  ExecutionInstruction,
  InstrumentSymbol,
  PaperOrder,
  PaperPosition,
  TradingSignal,
} from '../shared/types/index.ts';
import type { CentralizedRiskEngine } from '../risk/engine.ts';
import { PaperExecutionAdapter } from './paper-adapter.ts';
import { MT5ExecutionAdapter } from './mt5-adapter.ts';

const CLOSED_SIGNAL_STATES = new Set([
  'TP3_HIT',
  'STOPPED',
  'INVALIDATED',
  'EXPIRED',
  'CANCELLED',
]);

export class ExecutionGateway {
  private readonly paperAdapter = new PaperExecutionAdapter();
  private readonly mt5Adapter = new MT5ExecutionAdapter();
  private readonly riskEngine: CentralizedRiskEngine;

  constructor(riskEngine: CentralizedRiskEngine) {
    this.riskEngine = riskEngine;
  }

  public hydrate(orders: PaperOrder[], positions: PaperPosition[]): void {
    this.paperAdapter.hydrate(orders, positions);
  }

  public clearPaperState(): void {
    this.paperAdapter.clearAll();
  }

  public hasExecutedSignal(signalId: string): boolean {
    return this.paperAdapter.hasIdempotencyKey(`idem:${signalId}`);
  }

  public executeSignal(
    signal: TradingSignal,
    currentPrice: number,
    adapter: 'PAPER' | 'MT5' = 'PAPER'
  ): {
    success: boolean;
    order?: PaperOrder;
    position?: PaperPosition | null;
    rejectionReason?: string;
  } {
    if (CLOSED_SIGNAL_STATES.has(signal.state)) {
      return {
        success: false,
        rejectionReason: `Signal is already closed (${signal.state}) and cannot be executed`,
      };
    }

    const idempotencyKey = `idem:${signal.id}`;
    if (this.paperAdapter.hasIdempotencyKey(idempotencyKey)) {
      return {
        success: false,
        rejectionReason: `Paper trade already executed for signal ${signal.symbol} (${signal.entryTimeframe})`,
      };
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return {
        success: false,
        rejectionReason: `Invalid current market price (${currentPrice})`,
      };
    }

    const isBuy = signal.direction === 'BUY';
    if (isBuy && currentPrice <= signal.stopLoss) {
      return {
        success: false,
        rejectionReason: `Current market price (${currentPrice}) is already at or below BUY stop-loss (${signal.stopLoss})`,
      };
    }
    if (!isBuy && currentPrice >= signal.stopLoss) {
      return {
        success: false,
        rejectionReason: `Current market price (${currentPrice}) is already at or above SELL stop-loss (${signal.stopLoss})`,
      };
    }

    const openPositions = this.paperAdapter.getOpenPositions().map((p) => ({
      symbol: p.symbol,
      riskAmountUsd: p.riskAmountUsd,
    }));

    const riskApproval = this.riskEngine.evaluateTradeRisk({
      signal,
      openPositions,
    });

    if (!riskApproval.approved) {
      return {
        success: false,
        rejectionReason: riskApproval.rejectionReasons.join('; '),
      };
    }

    const instruction: ExecutionInstruction = {
      id: `exec:${signal.id}:${Date.now()}`,
      idempotencyKey,
      signalId: signal.id,
      symbol: signal.symbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      strategyId: signal.strategyId ?? 'unknown',
      strategyName: signal.strategyName ?? 'Strategy Signal',
      adapter,
      status: 'ACCEPTED',
      createdAt: Date.now(),
    };

    if (adapter === 'MT5') {
      try {
        this.mt5Adapter.executeLiveOrder(instruction, signal);
      } catch (err) {
        return {
          success: false,
          rejectionReason: err instanceof Error ? err.message : 'Live execution disabled',
        };
      }
    }

    const res = this.paperAdapter.execute(
      instruction,
      signal,
      riskApproval.calculatedVolume,
      currentPrice
    );
    this.riskEngine.recordTradeOpened();

    return {
      success: true,
      order: res.order,
      position: res.position,
    };
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
  ) {
    const result = this.paperAdapter.processPriceUpdate(symbol, priceInfo, now);
    for (const closed of result.closedPositions) {
      this.riskEngine.recordTradeClosed(closed.realizedPnlUsd);
    }
    return result;
  }

  public closePositionManually(positionId: string, marketPrice: number, now = Date.now()): PaperPosition | null {
    const closed = this.paperAdapter.closePositionManually(positionId, marketPrice, now);
    if (closed) {
      this.riskEngine.recordTradeClosed(closed.realizedPnlUsd);
    }
    return closed;
  }

  public getOpenPositions(): PaperPosition[] {
    return this.paperAdapter.getOpenPositions();
  }

  public getAllPositions(): PaperPosition[] {
    return this.paperAdapter.getAllPositions();
  }

  public getOrders(): PaperOrder[] {
    return this.paperAdapter.getOrders();
  }
}
