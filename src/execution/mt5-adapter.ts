import type { ExecutionInstruction, TradingSignal } from '../shared/types/index.ts';

export class MT5ExecutionAdapter {
  public readonly isPaperOnly = true;
  public readonly liveOrderExecutionDisabled = true;

  public executeLiveOrder(_instruction: ExecutionInstruction, _signal: TradingSignal): never {
    throw new Error('LIVE EXECUTION LOCKED: MT5 adapter is operating in strict PAPER ONLY mode. Real broker orders are disabled.');
  }
}
