import { DEFAULT_MT5_EXECUTION_SETTINGS, getContractSpec } from '../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  MT5BridgeStatus,
  MT5CommandType,
  MT5ExecutionSettings,
  MT5ManagedTrade,
  MT5OpenPosition,
  MT5TradeCommand,
  TradingSignal,
} from '../shared/types/index.ts';

const VALID_SYMBOLS = new Set<InstrumentSymbol>(['XAUUSD', 'XAGUSD', 'BTCUSDT', 'ETHUSDT']);
const CLOSED_SIGNAL_STATES = new Set(['TP3_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED', 'CANCELLED']);

function clampNum(val: unknown, fallback: number, min: number, max: number): number {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return Number(value.toFixed(4));
  const decimals = Math.max(0, Math.min(6, Math.round(-Math.log10(step))));
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(decimals));
}

function floorToStep(value: number, step: number): number {
  if (step <= 0) return Number(value.toFixed(4));
  const decimals = Math.max(0, Math.min(6, Math.round(-Math.log10(step))));
  const floored = Math.floor((value + 1e-12) / step) * step;
  return Number(floored.toFixed(decimals));
}

export function sanitizeMt5ExecutionSettings(
  input: Partial<MT5ExecutionSettings>,
  base: MT5ExecutionSettings = DEFAULT_MT5_EXECUTION_SETTINGS
): MT5ExecutionSettings {
  const allowedSymbols = Array.isArray(input.allowedSymbols)
    ? input.allowedSymbols.filter((s): s is InstrumentSymbol => VALID_SYMBOLS.has(s))
    : base.allowedSymbols;

  const symbolMapping: Record<InstrumentSymbol, string> = {
    XAUUSD:
      typeof input.symbolMapping?.XAUUSD === 'string' && input.symbolMapping.XAUUSD.trim()
        ? input.symbolMapping.XAUUSD.trim()
        : base.symbolMapping.XAUUSD,
    XAGUSD:
      typeof input.symbolMapping?.XAGUSD === 'string' && input.symbolMapping.XAGUSD.trim()
        ? input.symbolMapping.XAGUSD.trim()
        : base.symbolMapping.XAGUSD,
    BTCUSDT:
      typeof input.symbolMapping?.BTCUSDT === 'string' && input.symbolMapping.BTCUSDT.trim()
        ? input.symbolMapping.BTCUSDT.trim()
        : base.symbolMapping.BTCUSDT,
    ETHUSDT:
      typeof input.symbolMapping?.ETHUSDT === 'string' && input.symbolMapping.ETHUSDT.trim()
        ? input.symbolMapping.ETHUSDT.trim()
        : base.symbolMapping.ETHUSDT,
  };

  const initialTp =
    input.initialTpLevel === 1 || input.initialTpLevel === 2 || input.initialTpLevel === 3
      ? input.initialTpLevel
      : base.initialTpLevel;

  const sizingMode =
    input.sizingMode === 'FIXED_LOT' || input.sizingMode === 'RISK_PERCENT'
      ? input.sizingMode
      : base.sizingMode;

  const breakevenTrigger =
    input.breakevenTrigger === 'R_MULTIPLE' || input.breakevenTrigger === 'TP1_HIT'
      ? input.breakevenTrigger
      : base.breakevenTrigger;

  const trailingMode =
    input.trailingMode === 'NONE' ||
    input.trailingMode === 'TP_STEP' ||
    input.trailingMode === 'FIXED_R' ||
    input.trailingMode === 'ATR_MULTIPLE'
      ? input.trailingMode
      : base.trailingMode;

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    autoExecuteSignals:
      typeof input.autoExecuteSignals === 'boolean'
        ? input.autoExecuteSignals
        : base.autoExecuteSignals,
    demoAccountOnly:
      typeof input.demoAccountOnly === 'boolean' ? input.demoAccountOnly : base.demoAccountOnly,
    allowWatchingSignals:
      typeof input.allowWatchingSignals === 'boolean'
        ? input.allowWatchingSignals
        : base.allowWatchingSignals,
    minSignalScore: Math.round(clampNum(input.minSignalScore, base.minSignalScore, 40, 99)),
    allowedSymbols: allowedSymbols.length > 0 ? allowedSymbols : [...base.allowedSymbols],
    sizingMode,
    riskPercentPerTrade: clampNum(input.riskPercentPerTrade, base.riskPercentPerTrade, 0.05, 10),
    fixedLotSize: clampNum(input.fixedLotSize, base.fixedLotSize, 0.001, 50),
    maxLotSize: clampNum(input.maxLotSize, base.maxLotSize, 0.01, 50),
    maxOpenPositionsTotal: Math.round(
      clampNum(input.maxOpenPositionsTotal, base.maxOpenPositionsTotal, 1, 20)
    ),
    maxOpenPositionsPerSymbol: Math.round(
      clampNum(input.maxOpenPositionsPerSymbol, base.maxOpenPositionsPerSymbol, 1, 10)
    ),
    magicNumber: Math.round(clampNum(input.magicNumber, base.magicNumber, 1, 2_147_483_647)),
    deviationPoints: Math.round(clampNum(input.deviationPoints, base.deviationPoints, 0, 500)),
    symbolMapping,
    initialTpLevel: initialTp,
    partialCloseEnabled:
      typeof input.partialCloseEnabled === 'boolean'
        ? input.partialCloseEnabled
        : base.partialCloseEnabled,
    tp1ClosePercent: Math.round(clampNum(input.tp1ClosePercent, base.tp1ClosePercent, 0, 100)),
    tp2ClosePercent: Math.round(clampNum(input.tp2ClosePercent, base.tp2ClosePercent, 0, 100)),
    moveSlToBreakeven:
      typeof input.moveSlToBreakeven === 'boolean'
        ? input.moveSlToBreakeven
        : base.moveSlToBreakeven,
    breakevenTrigger,
    breakevenTriggerR: clampNum(input.breakevenTriggerR, base.breakevenTriggerR, 0.2, 5),
    breakevenOffsetPoints: Math.round(
      clampNum(input.breakevenOffsetPoints, base.breakevenOffsetPoints, 0, 500)
    ),
    trailSlToTp1OnTp2:
      typeof input.trailSlToTp1OnTp2 === 'boolean'
        ? input.trailSlToTp1OnTp2
        : base.trailSlToTp1OnTp2,
    trailingMode,
    trailingActivationR: clampNum(input.trailingActivationR, base.trailingActivationR, 0.3, 10),
    trailingDistanceR: clampNum(input.trailingDistanceR, base.trailingDistanceR, 0.1, 5),
    trailingAtrMultiplier: clampNum(
      input.trailingAtrMultiplier,
      base.trailingAtrMultiplier,
      0.2,
      6
    ),
    trailingMinStepPoints: Math.round(
      clampNum(input.trailingMinStepPoints, base.trailingMinStepPoints, 1, 500)
    ),
  };
}

export class MT5DemoTradeManager {
  private settings: MT5ExecutionSettings = structuredClone(DEFAULT_MT5_EXECUTION_SETTINGS);
  private commands = new Map<string, MT5TradeCommand>();
  private trades = new Map<string, MT5ManagedTrade>();

  public hydrate(
    settings: MT5ExecutionSettings | null,
    commands: MT5TradeCommand[],
    trades: MT5ManagedTrade[]
  ): void {
    if (settings) {
      this.settings = sanitizeMt5ExecutionSettings(settings);
    }
    this.commands.clear();
    for (const cmd of commands) {
      this.commands.set(cmd.id, cmd);
    }
    this.trades.clear();
    for (const trade of trades) {
      this.trades.set(trade.id, trade);
    }
  }

  public getSettings(): MT5ExecutionSettings {
    return {
      ...this.settings,
      allowedSymbols: [...this.settings.allowedSymbols],
      symbolMapping: { ...this.settings.symbolMapping },
    };
  }

  public updateSettings(patch: Partial<MT5ExecutionSettings>): MT5ExecutionSettings {
    this.settings = sanitizeMt5ExecutionSettings(patch, this.settings);
    return this.getSettings();
  }

  public getCommands(limit = 100): MT5TradeCommand[] {
    return Array.from(this.commands.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  public getManagedTrades(): MT5ManagedTrade[] {
    return Array.from(this.trades.values()).sort((a, b) => b.openedAt - a.openedAt);
  }

  public getActiveManagedTrades(): MT5ManagedTrade[] {
    return this.getManagedTrades().filter(
      (t) => t.status === 'QUEUED' || t.status === 'OPEN' || t.status === 'PARTIAL'
    );
  }

  public hasActiveOrExecutedSignal(signalId: string): boolean {
    for (const t of this.trades.values()) {
      if (t.signalId === signalId && t.status !== 'FAILED') {
        return true;
      }
    }
    return false;
  }

  public resolveBrokerSymbol(symbol: InstrumentSymbol, mt5Status?: MT5BridgeStatus | null): string {
    const mapped = this.settings.symbolMapping[symbol]?.trim() || symbol;
    const ticks = mt5Status?.syncedTicks ?? [];
    if (ticks.some((t) => t.rawSymbol === mapped)) {
      return mapped;
    }
    const syncedMatch = ticks.find((t) => t.normalizedSymbol === symbol);
    if (syncedMatch) {
      return syncedMatch.rawSymbol;
    }
    return mapped;
  }

  public calculateLotVolume(signal: TradingSignal, accountEquity: number): number {
    const spec = getContractSpec(signal.symbol);
    const maxCap = Math.min(spec.maxVolume, this.settings.maxLotSize);

    let raw = this.settings.fixedLotSize;
    if (this.settings.sizingMode === 'RISK_PERCENT') {
      const stopDist = Math.abs(signal.entryPrice - signal.stopLoss);
      const effectiveEquity = accountEquity > 0 ? accountEquity : 10_000;
      const riskUsd = effectiveEquity * (this.settings.riskPercentPerTrade / 100);
      raw = stopDist > 0 ? riskUsd / (stopDist * spec.contractSize) : spec.minVolume;
    }

    const floored = floorToStep(Math.min(maxCap, Math.max(spec.minVolume, raw)), spec.volumeStep);
    return Math.max(spec.minVolume, Math.min(maxCap, floored));
  }

  public dispatchSignalTrade(params: {
    signal: TradingSignal;
    mt5Status: MT5BridgeStatus;
    currentPrice: number;
    isAuto?: boolean;
    now?: number;
  }): {
    success: boolean;
    trade?: MT5ManagedTrade;
    command?: MT5TradeCommand;
    rejectionReason?: string;
  } {
    const { signal, mt5Status, currentPrice, isAuto = false, now = Date.now() } = params;

    if (!mt5Status.connected) {
      return {
        success: false,
        rejectionReason: `MT5 Bridge is ${mt5Status.statusLabel}. Attach GoldBtcTerminalBridge.mq5 to your MT5 chart first.`,
      };
    }

    if (this.settings.demoAccountOnly && mt5Status.tradeMode === 'REAL') {
      return {
        success: false,
        rejectionReason:
          'Blocked by Demo-Only Safety Guard: connected MT5 account is REAL. Switch to an MT5 Demo account or disable Demo-Only Guard.',
      };
    }

    if (isAuto && (!this.settings.enabled || !this.settings.autoExecuteSignals)) {
      return {
        success: false,
        rejectionReason: 'MT5 Auto-Execution is currently disabled.',
      };
    }

    if (CLOSED_SIGNAL_STATES.has(signal.state)) {
      return {
        success: false,
        rejectionReason: `Signal is already closed (${signal.state}).`,
      };
    }

    if (signal.state === 'WATCHING' && !this.settings.allowWatchingSignals) {
      return {
        success: false,
        rejectionReason:
          'Signal is still WATCHING. Wait for CONFIRMED status or enable Allow WATCHING Signals.',
      };
    }

    if (signal.score < this.settings.minSignalScore) {
      return {
        success: false,
        rejectionReason: `Signal score (${signal.score}) is below MT5 minimum score (${this.settings.minSignalScore}).`,
      };
    }

    if (!this.settings.allowedSymbols.includes(signal.symbol)) {
      return {
        success: false,
        rejectionReason: `${signal.symbol} is disabled in MT5 Allowed Instruments.`,
      };
    }

    if (this.hasActiveOrExecutedSignal(signal.id)) {
      return {
        success: false,
        rejectionReason: `Signal ${signal.symbol} (${signal.entryTimeframe}) has already been sent to MT5.`,
      };
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return {
        success: false,
        rejectionReason: `Invalid live market price (${currentPrice}).`,
      };
    }

    const isBuy = signal.direction === 'BUY';
    if (isBuy && currentPrice <= signal.stopLoss) {
      return {
        success: false,
        rejectionReason: `Current market price (${currentPrice}) is at or below BUY SL (${signal.stopLoss}).`,
      };
    }
    if (!isBuy && currentPrice >= signal.stopLoss) {
      return {
        success: false,
        rejectionReason: `Current market price (${currentPrice}) is at or above SELL SL (${signal.stopLoss}).`,
      };
    }

    const activeTrades = this.getActiveManagedTrades();
    if (activeTrades.length >= this.settings.maxOpenPositionsTotal) {
      return {
        success: false,
        rejectionReason: `Max total open MT5 trades (${this.settings.maxOpenPositionsTotal}) reached.`,
      };
    }
    const symbolOpenCount = activeTrades.filter((t) => t.symbol === signal.symbol).length;
    if (symbolOpenCount >= this.settings.maxOpenPositionsPerSymbol) {
      return {
        success: false,
        rejectionReason: `Max open MT5 trades for ${signal.symbol} (${this.settings.maxOpenPositionsPerSymbol}) reached.`,
      };
    }

    const sortedTps = [...signal.takeProfits].sort((a, b) => a.level - b.level);
    const tp1 = sortedTps[0];
    if (!tp1) {
      return {
        success: false,
        rejectionReason: 'Signal has no valid Take Profit level.',
      };
    }
    const tp2 = sortedTps[1] ?? null;
    const tp3 = sortedTps[2] ?? null;

    const chosenTp =
      sortedTps.find((t) => t.level === this.settings.initialTpLevel) ??
      sortedTps[sortedTps.length - 1];

    const equity = mt5Status.equity ?? mt5Status.balance ?? 10_000;
    const volume = this.calculateLotVolume(signal, equity);
    const brokerSymbol = this.resolveBrokerSymbol(signal.symbol, mt5Status);
    const spec = getContractSpec(signal.symbol);
    const slPrice = roundToStep(signal.stopLoss, spec.tickSize);
    const tpPrice = roundToStep(chosenTp.price, spec.tickSize);

    const shortTag = Math.abs(
      signal.id.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)
    )
      .toString(36)
      .slice(0, 6);
    const commentTag = `GBT_${shortTag}_${now.toString(36).slice(-4)}`;
    const tradeId = `mt5tr:${signal.id}:${now}`;
    const cmdId = `mt5cmd:open:${signal.id}:${now}`;

    const trade: MT5ManagedTrade = {
      id: tradeId,
      signalId: signal.id,
      strategyId: signal.strategyId ?? 'signal_engine',
      strategyName: signal.strategyName ?? 'Signal Engine',
      symbol: signal.symbol,
      brokerSymbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      mt5Ticket: null,
      commentTag,
      magicNumber: this.settings.magicNumber,
      status: 'QUEUED',
      requestedVolume: volume,
      openVolume: volume,
      entryPrice: currentPrice,
      currentPrice,
      initialStopLoss: slPrice,
      currentStopLoss: slPrice,
      brokerTakeProfit: tpPrice,
      tp1Price: roundToStep(tp1.price, spec.tickSize),
      tp2Price: tp2 ? roundToStep(tp2.price, spec.tickSize) : null,
      tp3Price: tp3 ? roundToStep(tp3.price, spec.tickSize) : null,
      tp1Done: false,
      tp2Done: false,
      breakevenDone: false,
      slAtTp1Done: false,
      highestFavorablePrice: currentPrice,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      lastManagementNote: isAuto ? 'Auto-queued from signal' : 'Manually queued to MT5 EA',
      openedAt: now,
      closedAt: null,
    };

    const command: MT5TradeCommand = {
      id: cmdId,
      idempotencyKey: `idem:mt5:open:${signal.id}:${now}`,
      type: 'OPEN_ORDER',
      signalId: signal.id,
      managedTradeId: tradeId,
      mt5Ticket: null,
      symbol: signal.symbol,
      brokerSymbol,
      side: signal.direction,
      volume,
      entryPrice: currentPrice,
      stopLoss: slPrice,
      takeProfit: tpPrice,
      magicNumber: this.settings.magicNumber,
      deviationPoints: this.settings.deviationPoints,
      comment: commentTag,
      reason: `Open ${signal.direction} ${brokerSymbol} (${volume} lot) per ${trade.strategyName}`,
      status: 'PENDING',
      createdAt: now,
      dispatchedAt: null,
      completedAt: null,
    };

    this.trades.set(trade.id, trade);
    this.commands.set(command.id, command);

    return { success: true, trade, command };
  }

  public collectPendingCommands(now = Date.now()): {
    commandsToSend: MT5TradeCommand[];
    expiredCommands: MT5TradeCommand[];
    updatedTrades: MT5ManagedTrade[];
  } {
    const expiredCommands: MT5TradeCommand[] = [];
    const updatedTrades: MT5ManagedTrade[] = [];
    const commandsToSend: MT5TradeCommand[] = [];

    for (const cmd of this.commands.values()) {
      if (cmd.status === 'DISPATCHED' && cmd.dispatchedAt && now - cmd.dispatchedAt > 45_000) {
        cmd.status = 'EXPIRED';
        cmd.completedAt = now;
        cmd.errorMessage = 'EA did not acknowledge command within 45s';
        expiredCommands.push(cmd);

        if (cmd.type === 'OPEN_ORDER' && cmd.managedTradeId) {
          const trade = this.trades.get(cmd.managedTradeId);
          if (trade && trade.status === 'QUEUED') {
            trade.status = 'FAILED';
            trade.closedAt = now;
            trade.lastManagementNote = 'Order expired before MT5 EA confirmation';
            updatedTrades.push(trade);
          }
        }
      }
    }

    const pending = Array.from(this.commands.values())
      .filter((c) => c.status === 'PENDING')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 10);

    for (const cmd of pending) {
      cmd.status = 'DISPATCHED';
      cmd.dispatchedAt = now;
      commandsToSend.push(cmd);
    }

    return { commandsToSend, expiredCommands, updatedTrades };
  }

  public processCommandAck(
    ack: {
      commandId: string;
      success: boolean;
      ticket?: string;
      executedPrice?: number;
      executedVolume?: number;
      retcode?: number;
      errorMessage?: string;
    },
    now = Date.now()
  ): {
    command: MT5TradeCommand | null;
    trade: MT5ManagedTrade | null;
  } {
    const cmd = this.commands.get(ack.commandId);
    if (!cmd) return { command: null, trade: null };

    cmd.status = ack.success ? 'EXECUTED' : 'FAILED';
    cmd.completedAt = now;
    cmd.retcode = ack.retcode ?? null;
    cmd.executedPrice = ack.executedPrice ?? null;
    cmd.executedVolume = ack.executedVolume ?? null;
    cmd.errorMessage = ack.success ? null : ack.errorMessage || 'MT5 execution error';

    let trade: MT5ManagedTrade | null = null;
    if (cmd.managedTradeId && this.trades.has(cmd.managedTradeId)) {
      trade = this.trades.get(cmd.managedTradeId)!;
      if (cmd.type === 'OPEN_ORDER') {
        if (ack.success) {
          trade.status = 'OPEN';
          if (ack.ticket) trade.mt5Ticket = String(ack.ticket);
          if (ack.executedPrice && ack.executedPrice > 0) {
            trade.entryPrice = ack.executedPrice;
            trade.currentPrice = ack.executedPrice;
            trade.highestFavorablePrice = ack.executedPrice;
          }
          if (ack.executedVolume && ack.executedVolume > 0) {
            trade.openVolume = ack.executedVolume;
          }
          trade.lastManagementNote = `Filled on MT5 Demo (#${trade.mt5Ticket ?? 'pending ticket'}) @ ${trade.entryPrice}`;
        } else {
          trade.status = 'FAILED';
          trade.closedAt = now;
          trade.lastManagementNote = `MT5 rejected: ${cmd.errorMessage}`;
        }
      } else if (cmd.type === 'MODIFY_SLTP') {
        if (ack.success) {
          if (cmd.stopLoss > 0) trade.currentStopLoss = cmd.stopLoss;
          if (cmd.takeProfit > 0) trade.brokerTakeProfit = cmd.takeProfit;
          trade.lastManagementNote = `${cmd.reason} (confirmed on MT5)`;
        } else {
          trade.lastManagementNote = `Modify failed: ${cmd.errorMessage}`;
        }
      } else if (cmd.type === 'CLOSE_PARTIAL') {
        if (ack.success) {
          const closedVol = ack.executedVolume && ack.executedVolume > 0 ? ack.executedVolume : cmd.volume;
          const spec = getContractSpec(trade.symbol);
          const rem = roundToStep(Math.max(0, trade.openVolume - closedVol), spec.volumeStep);
          trade.openVolume = rem;
          trade.status = rem <= 0 ? 'CLOSED' : 'PARTIAL';
          if (rem <= 0) trade.closedAt = now;
          trade.lastManagementNote = `${cmd.reason} (closed ${closedVol} lot)`;
        } else {
          trade.lastManagementNote = `Partial close failed: ${cmd.errorMessage}`;
        }
      } else if (cmd.type === 'CLOSE_POSITION') {
        if (ack.success) {
          trade.openVolume = 0;
          trade.status = 'CLOSED';
          trade.closedAt = now;
          if (ack.executedPrice && ack.executedPrice > 0) {
            trade.currentPrice = ack.executedPrice;
          }
          trade.lastManagementNote = `${cmd.reason} @ ${trade.currentPrice}`;
        } else {
          trade.lastManagementNote = `Close failed: ${cmd.errorMessage}`;
        }
      }
    }

    return { command: cmd, trade };
  }

  public reconcileBrokerPositions(openPositions: MT5OpenPosition[], now = Date.now()): MT5ManagedTrade[] {
    const updated: MT5ManagedTrade[] = [];
    const byTicket = new Map<string, MT5OpenPosition>();
    for (const p of openPositions) {
      if (p.ticket) byTicket.set(String(p.ticket), p);
    }

    for (const trade of this.trades.values()) {
      if (trade.status !== 'QUEUED' && trade.status !== 'OPEN' && trade.status !== 'PARTIAL') {
        continue;
      }

      let matched: MT5OpenPosition | undefined;
      if (trade.mt5Ticket) {
        matched = byTicket.get(String(trade.mt5Ticket));
      }
      if (!matched) {
        matched = openPositions.find(
          (p) =>
            (p.comment && p.comment === trade.commentTag) ||
            (p.magic === trade.magicNumber &&
              p.symbol === trade.brokerSymbol &&
              p.type === trade.direction &&
              !Array.from(this.trades.values()).some(
                (other) => other.id !== trade.id && other.mt5Ticket === String(p.ticket)
              ))
        );
      }

      if (matched) {
        const hadTicket = Boolean(trade.mt5Ticket);
        trade.mt5Ticket = String(matched.ticket);
        if (trade.status === 'QUEUED') {
          trade.status = 'OPEN';
          trade.entryPrice = matched.openPrice > 0 ? matched.openPrice : trade.entryPrice;
          trade.highestFavorablePrice = trade.entryPrice;
        }
        trade.openVolume = matched.volume;
        if (matched.currentPrice > 0) trade.currentPrice = matched.currentPrice;
        trade.unrealizedPnlUsd = Number((matched.profit ?? 0).toFixed(2));
        if (!this.hasInFlightCommand(trade.id, 'MODIFY_SLTP') && matched.sl > 0) {
          trade.currentStopLoss = matched.sl;
        }
        if (!hadTicket) {
          trade.lastManagementNote = `Synced with MT5 ticket #${matched.ticket}`;
        }
        updated.push(trade);
      } else if (
        (trade.status === 'OPEN' || trade.status === 'PARTIAL') &&
        trade.mt5Ticket &&
        now - trade.openedAt > 5000 &&
        !this.hasInFlightCommand(trade.id, 'OPEN_ORDER')
      ) {
        trade.status = 'CLOSED';
        trade.openVolume = 0;
        trade.unrealizedPnlUsd = 0;
        trade.closedAt = now;
        trade.lastManagementNote = 'Position closed on MT5 broker (SL/TP or manual)';
        updated.push(trade);
      }
    }

    return updated;
  }

  private hasInFlightCommand(managedTradeId: string, type: MT5CommandType): boolean {
    for (const cmd of this.commands.values()) {
      if (
        cmd.managedTradeId === managedTradeId &&
        cmd.type === type &&
        (cmd.status === 'PENDING' || cmd.status === 'DISPATCHED')
      ) {
        return true;
      }
    }
    return false;
  }

  private enqueueTradeCommand(params: {
    trade: MT5ManagedTrade;
    type: MT5CommandType;
    volume?: number;
    stopLoss?: number;
    takeProfit?: number;
    reason: string;
    now: number;
  }): MT5TradeCommand {
    const { trade, type, reason, now } = params;
    const cmd: MT5TradeCommand = {
      id: `mt5cmd:${type.toLowerCase()}:${trade.id}:${now}:${Math.random().toString(36).slice(2, 6)}`,
      idempotencyKey: `idem:${type}:${trade.id}:${params.stopLoss ?? 0}:${params.volume ?? 0}:${Math.floor(now / 1000)}`,
      type,
      signalId: trade.signalId,
      managedTradeId: trade.id,
      mt5Ticket: trade.mt5Ticket,
      symbol: trade.symbol,
      brokerSymbol: trade.brokerSymbol,
      side: trade.direction,
      volume: params.volume ?? trade.openVolume,
      entryPrice: trade.entryPrice,
      stopLoss: params.stopLoss ?? trade.currentStopLoss,
      takeProfit: params.takeProfit ?? trade.brokerTakeProfit,
      magicNumber: trade.magicNumber,
      deviationPoints: this.settings.deviationPoints,
      comment: trade.commentTag,
      reason,
      status: 'PENDING',
      createdAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.commands.set(cmd.id, cmd);
    return cmd;
  }

  public evaluatePriceUpdate(
    symbol: InstrumentSymbol,
    priceInfo: { price: number; bid?: number; ask?: number },
    atr: number,
    now = Date.now()
  ): {
    updatedTrades: MT5ManagedTrade[];
    createdCommands: MT5TradeCommand[];
  } {
    const updatedTrades: MT5ManagedTrade[] = [];
    const createdCommands: MT5TradeCommand[] = [];
    const spec = getContractSpec(symbol);

    for (const trade of this.trades.values()) {
      if (trade.symbol !== symbol) continue;
      if (trade.status !== 'OPEN' && trade.status !== 'PARTIAL') continue;
      if (!trade.mt5Ticket) continue;

      const isBuy = trade.direction === 'BUY';
      const marketPrice = isBuy
        ? (priceInfo.bid ?? priceInfo.price)
        : (priceInfo.ask ?? priceInfo.price);

      if (!Number.isFinite(marketPrice) || marketPrice <= 0) continue;

      trade.currentPrice = marketPrice;
      trade.highestFavorablePrice = isBuy
        ? Math.max(trade.highestFavorablePrice, marketPrice)
        : Math.min(trade.highestFavorablePrice, marketPrice);

      const initialRisk = Math.abs(trade.entryPrice - trade.initialStopLoss);
      const favorableMove = isBuy
        ? trade.highestFavorablePrice - trade.entryPrice
        : trade.entryPrice - trade.highestFavorablePrice;
      const currentR = initialRisk > 0 ? favorableMove / initialRisk : 0;

      const tp1Reached = isBuy ? marketPrice >= trade.tp1Price : marketPrice <= trade.tp1Price;
      const tp2Reached =
        trade.tp2Price !== null &&
        (isBuy ? marketPrice >= trade.tp2Price : marketPrice <= trade.tp2Price);

      let desiredSl: number | null = null;
      let slReason = '';

      // 1. TP1 Hit & Partial Take Profit
      if (!trade.tp1Done && tp1Reached) {
        trade.tp1Done = true;
        updatedTrades.push(trade);

        if (
          this.settings.partialCloseEnabled &&
          this.settings.tp1ClosePercent > 0 &&
          trade.openVolume > spec.minVolume &&
          !this.hasInFlightCommand(trade.id, 'CLOSE_PARTIAL')
        ) {
          const closeVol = floorToStep(
            trade.openVolume * (this.settings.tp1ClosePercent / 100),
            spec.volumeStep
          );
          const remaining = roundToStep(trade.openVolume - closeVol, spec.volumeStep);
          if (closeVol >= spec.minVolume && remaining >= spec.minVolume) {
            const cmd = this.enqueueTradeCommand({
              trade,
              type: 'CLOSE_PARTIAL',
              volume: closeVol,
              reason: `Partial Close ${this.settings.tp1ClosePercent}% at TP1`,
              now,
            });
            createdCommands.push(cmd);
            trade.lastManagementNote = cmd.reason;
          }
        }
      }

      // 2. Breakeven Stop Move (at TP1 Hit or R-Multiple)
      const shouldMoveBe =
        this.settings.moveSlToBreakeven &&
        !trade.breakevenDone &&
        ((this.settings.breakevenTrigger === 'TP1_HIT' && trade.tp1Done) ||
          (this.settings.breakevenTrigger === 'R_MULTIPLE' &&
            currentR >= this.settings.breakevenTriggerR));

      if (shouldMoveBe) {
        const offset = this.settings.breakevenOffsetPoints * spec.tickSize;
        const beSl = roundToStep(
          isBuy ? trade.entryPrice + offset : trade.entryPrice - offset,
          spec.tickSize
        );
        desiredSl = beSl;
        slReason =
          this.settings.breakevenTrigger === 'TP1_HIT'
            ? 'Move SL to Breakeven (TP1 Hit)'
            : `Move SL to Breakeven (+${this.settings.breakevenTriggerR}R)`;
        trade.breakevenDone = true;
        updatedTrades.push(trade);
      }

      // 3. TP2 Hit -> Partial Close + Trail SL to TP1
      if (!trade.tp2Done && tp2Reached && trade.tp2Price !== null) {
        trade.tp2Done = true;
        updatedTrades.push(trade);

        if (
          this.settings.partialCloseEnabled &&
          this.settings.tp2ClosePercent > 0 &&
          trade.tp3Price !== null &&
          trade.openVolume > spec.minVolume &&
          !this.hasInFlightCommand(trade.id, 'CLOSE_PARTIAL')
        ) {
          const closeVol = floorToStep(
            trade.openVolume * (this.settings.tp2ClosePercent / 100),
            spec.volumeStep
          );
          const remaining = roundToStep(trade.openVolume - closeVol, spec.volumeStep);
          if (closeVol >= spec.minVolume && remaining >= spec.minVolume) {
            const cmd = this.enqueueTradeCommand({
              trade,
              type: 'CLOSE_PARTIAL',
              volume: closeVol,
              reason: `Partial Close ${this.settings.tp2ClosePercent}% at TP2`,
              now,
            });
            createdCommands.push(cmd);
            trade.lastManagementNote = cmd.reason;
          }
        }
      }

      if (this.settings.trailSlToTp1OnTp2 && trade.tp2Done && !trade.slAtTp1Done) {
        const tp1Sl = roundToStep(trade.tp1Price, spec.tickSize);
        if (
          desiredSl === null ||
          (isBuy ? tp1Sl > desiredSl : tp1Sl < desiredSl)
        ) {
          desiredSl = tp1Sl;
          slReason = 'Trail SL to TP1 (TP2 Hit)';
        }
        trade.slAtTp1Done = true;
        trade.breakevenDone = true;
        updatedTrades.push(trade);
      }

      // 4. Dynamic Trailing Stop (FIXED_R or ATR_MULTIPLE)
      if (
        (this.settings.trailingMode === 'FIXED_R' ||
          this.settings.trailingMode === 'ATR_MULTIPLE') &&
        currentR >= this.settings.trailingActivationR
      ) {
        const trailDist =
          this.settings.trailingMode === 'FIXED_R'
            ? this.settings.trailingDistanceR * initialRisk
            : atr > 0
              ? this.settings.trailingAtrMultiplier * atr
              : 0;
        if (trailDist > 0) {
          const rawTrailSl = roundToStep(
            isBuy
              ? trade.highestFavorablePrice - trailDist
              : trade.highestFavorablePrice + trailDist,
            spec.tickSize
          );
          const minStep = this.settings.trailingMinStepPoints * spec.tickSize;
          const improvesCurrent = isBuy
            ? rawTrailSl >= trade.currentStopLoss + minStep
            : rawTrailSl <= trade.currentStopLoss - minStep;
          if (
            improvesCurrent &&
            (desiredSl === null || (isBuy ? rawTrailSl > desiredSl : rawTrailSl < desiredSl))
          ) {
            desiredSl = rawTrailSl;
            slReason = `Auto Trail SL (${this.settings.trailingMode === 'FIXED_R' ? `${this.settings.trailingDistanceR}R` : `${this.settings.trailingAtrMultiplier}x ATR`})`;
          }
        }
      }

      // Dispatch SL modification if strictly tighter and safe relative to live market price
      if (desiredSl !== null && !this.hasInFlightCommand(trade.id, 'MODIFY_SLTP')) {
        const minGap = spec.tickSize * 2;
        const isTighter = isBuy
          ? desiredSl > trade.currentStopLoss + spec.tickSize * 0.5
          : desiredSl < trade.currentStopLoss - spec.tickSize * 0.5;
        const isSafeSide = isBuy
          ? desiredSl < marketPrice - minGap
          : desiredSl > marketPrice + minGap;

        if (isTighter && isSafeSide) {
          const cmd = this.enqueueTradeCommand({
            trade,
            type: 'MODIFY_SLTP',
            stopLoss: desiredSl,
            takeProfit: trade.brokerTakeProfit,
            reason: slReason,
            now,
          });
          createdCommands.push(cmd);
          trade.lastManagementNote = `${slReason} queued (${desiredSl})`;
          updatedTrades.push(trade);
        }
      }
    }

    return {
      updatedTrades: Array.from(new Map(updatedTrades.map((t) => [t.id, t])).values()),
      createdCommands,
    };
  }

  public moveTradeToBreakevenManual(
    tradeId: string,
    now = Date.now()
  ): { success: boolean; command?: MT5TradeCommand; trade?: MT5ManagedTrade; error?: string } {
    const trade = this.trades.get(tradeId);
    if (!trade || (trade.status !== 'OPEN' && trade.status !== 'PARTIAL') || !trade.mt5Ticket) {
      return { success: false, error: 'Active MT5 trade with ticket not found' };
    }
    const spec = getContractSpec(trade.symbol);
    const isBuy = trade.direction === 'BUY';
    const offset = this.settings.breakevenOffsetPoints * spec.tickSize;
    const beSl = roundToStep(
      isBuy ? trade.entryPrice + offset : trade.entryPrice - offset,
      spec.tickSize
    );
    const isSafe = isBuy ? beSl < trade.currentPrice : beSl > trade.currentPrice;
    if (!isSafe) {
      return {
        success: false,
        error: `Current price (${trade.currentPrice}) has not cleared Breakeven (${beSl}).`,
      };
    }
    trade.breakevenDone = true;
    const cmd = this.enqueueTradeCommand({
      trade,
      type: 'MODIFY_SLTP',
      stopLoss: beSl,
      takeProfit: trade.brokerTakeProfit,
      reason: 'Manual Move SL to Breakeven',
      now,
    });
    trade.lastManagementNote = `Manual SL → Breakeven (${beSl}) queued`;
    return { success: true, command: cmd, trade };
  }

  public trailTradeToTp1Manual(
    tradeId: string,
    now = Date.now()
  ): { success: boolean; command?: MT5TradeCommand; trade?: MT5ManagedTrade; error?: string } {
    const trade = this.trades.get(tradeId);
    if (!trade || (trade.status !== 'OPEN' && trade.status !== 'PARTIAL') || !trade.mt5Ticket) {
      return { success: false, error: 'Active MT5 trade with ticket not found' };
    }
    const spec = getContractSpec(trade.symbol);
    const isBuy = trade.direction === 'BUY';
    const tp1Sl = roundToStep(trade.tp1Price, spec.tickSize);
    const isSafe = isBuy ? tp1Sl < trade.currentPrice : tp1Sl > trade.currentPrice;
    if (!isSafe) {
      return {
        success: false,
        error: `Current price (${trade.currentPrice}) must be beyond TP1 (${tp1Sl}) before moving SL to TP1.`,
      };
    }
    trade.slAtTp1Done = true;
    trade.breakevenDone = true;
    const cmd = this.enqueueTradeCommand({
      trade,
      type: 'MODIFY_SLTP',
      stopLoss: tp1Sl,
      takeProfit: trade.brokerTakeProfit,
      reason: 'Manual Trail SL to TP1',
      now,
    });
    trade.lastManagementNote = `Manual SL → TP1 (${tp1Sl}) queued`;
    return { success: true, command: cmd, trade };
  }

  public closeTradeManual(
    tradeId: string,
    now = Date.now()
  ): { success: boolean; command?: MT5TradeCommand; trade?: MT5ManagedTrade; error?: string } {
    const trade = this.trades.get(tradeId);
    if (!trade || (trade.status !== 'OPEN' && trade.status !== 'PARTIAL' && trade.status !== 'QUEUED')) {
      return { success: false, error: 'Active MT5 trade not found' };
    }
    if (!trade.mt5Ticket) {
      trade.status = 'CLOSED';
      trade.openVolume = 0;
      trade.closedAt = now;
      trade.lastManagementNote = 'Cancelled queued order before MT5 fill';
      for (const cmd of this.commands.values()) {
        if (cmd.managedTradeId === trade.id && cmd.status === 'PENDING') {
          cmd.status = 'CANCELLED';
          cmd.completedAt = now;
        }
      }
      return { success: true, trade };
    }
    const cmd = this.enqueueTradeCommand({
      trade,
      type: 'CLOSE_POSITION',
      volume: trade.openVolume,
      reason: 'Manual Close from Terminal',
      now,
    });
    trade.lastManagementNote = 'Close command queued to MT5 EA';
    return { success: true, command: cmd, trade };
  }

  public closeAllTrades(now = Date.now()): {
    closedTrades: MT5ManagedTrade[];
    createdCommands: MT5TradeCommand[];
  } {
    const closedTrades: MT5ManagedTrade[] = [];
    const createdCommands: MT5TradeCommand[] = [];
    for (const trade of this.getActiveManagedTrades()) {
      const res = this.closeTradeManual(trade.id, now);
      if (res.success && res.trade) closedTrades.push(res.trade);
      if (res.command) createdCommands.push(res.command);
    }
    return { closedTrades, createdCommands };
  }

  public cancelPendingCommand(commandId: string, now = Date.now()): MT5TradeCommand | null {
    const cmd = this.commands.get(commandId);
    if (!cmd || cmd.status !== 'PENDING') return null;
    cmd.status = 'CANCELLED';
    cmd.completedAt = now;
    if (cmd.type === 'OPEN_ORDER' && cmd.managedTradeId) {
      const trade = this.trades.get(cmd.managedTradeId);
      if (trade && trade.status === 'QUEUED') {
        trade.status = 'FAILED';
        trade.closedAt = now;
        trade.lastManagementNote = 'Cancelled by operator before EA dispatch';
      }
    }
    return cmd;
  }
}
