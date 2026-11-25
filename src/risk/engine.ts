import { getContractSpec } from '../shared/constants/index.ts';
import type {
  InstrumentSymbol,
  RiskAccountSnapshot,
  RiskApprovalResult,
  RiskSettings,
  TradingSignal,
} from '../shared/types/index.ts';

export interface PersistedRiskState {
  settings: RiskSettings;
  currentEquity: number;
  dailyRealizedPnlUsd: number;
  weeklyRealizedPnlUsd: number;
  tradesTodayCount: number;
  lastResetDay: string;
  lastResetWeek: string;
}

function getUtcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function getUtcWeekKey(now = Date.now()): string {
  const d = new Date(now);
  const utcDay = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - utcDay);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export class CentralizedRiskEngine {
  private settings: RiskSettings;
  private currentEquity: number;
  private dailyRealizedPnlUsd = 0;
  private weeklyRealizedPnlUsd = 0;
  private tradesTodayCount = 0;
  private lastResetDay = getUtcDayKey();
  private lastResetWeek = getUtcWeekKey();

  constructor(initialSettings: RiskSettings) {
    this.settings = structuredClone(initialSettings);
    this.currentEquity = initialSettings.accountEquity;
  }

  private checkDateRollover(now = Date.now()): void {
    const dayKey = getUtcDayKey(now);
    const weekKey = getUtcWeekKey(now);
    if (dayKey !== this.lastResetDay) {
      this.dailyRealizedPnlUsd = 0;
      this.tradesTodayCount = 0;
      this.lastResetDay = dayKey;
    }
    if (weekKey !== this.lastResetWeek) {
      this.weeklyRealizedPnlUsd = 0;
      this.lastResetWeek = weekKey;
    }
  }

  public exportState(): PersistedRiskState {
    this.checkDateRollover();
    return {
      settings: structuredClone(this.settings),
      currentEquity: Number(this.currentEquity.toFixed(2)),
      dailyRealizedPnlUsd: Number(this.dailyRealizedPnlUsd.toFixed(2)),
      weeklyRealizedPnlUsd: Number(this.weeklyRealizedPnlUsd.toFixed(2)),
      tradesTodayCount: this.tradesTodayCount,
      lastResetDay: this.lastResetDay,
      lastResetWeek: this.lastResetWeek,
    };
  }

  public hydrateState(state: PersistedRiskState | null): void {
    if (!state) return;
    if (state.settings) {
      this.settings = { ...this.settings, ...state.settings };
    }
    if (typeof state.currentEquity === 'number' && Number.isFinite(state.currentEquity) && state.currentEquity > 0) {
      this.currentEquity = state.currentEquity;
    }
    if (typeof state.dailyRealizedPnlUsd === 'number' && Number.isFinite(state.dailyRealizedPnlUsd)) {
      this.dailyRealizedPnlUsd = state.dailyRealizedPnlUsd;
    }
    if (typeof state.weeklyRealizedPnlUsd === 'number' && Number.isFinite(state.weeklyRealizedPnlUsd)) {
      this.weeklyRealizedPnlUsd = state.weeklyRealizedPnlUsd;
    }
    if (typeof state.tradesTodayCount === 'number' && Number.isFinite(state.tradesTodayCount)) {
      this.tradesTodayCount = state.tradesTodayCount;
    }
    if (state.lastResetDay) this.lastResetDay = state.lastResetDay;
    if (state.lastResetWeek) this.lastResetWeek = state.lastResetWeek;
    this.checkDateRollover();
  }

  public getSettings(): RiskSettings {
    return this.settings;
  }

  public getCurrentEquity(): number {
    return Number(this.currentEquity.toFixed(2));
  }

  public updateSettings(next: Partial<RiskSettings>): RiskSettings {
    const prevBase = this.settings.accountEquity;
    this.settings = { ...this.settings, ...next };
    if (
      typeof next.accountEquity === 'number' &&
      Number.isFinite(next.accountEquity) &&
      next.accountEquity >= 100 &&
      Math.abs(this.currentEquity - prevBase) < 0.01
    ) {
      this.currentEquity = next.accountEquity;
    }
    return this.settings;
  }

  public resetAccount(startingEquity?: number): void {
    const equity =
      typeof startingEquity === 'number' && Number.isFinite(startingEquity) && startingEquity >= 100
        ? startingEquity
        : this.settings.accountEquity;
    this.settings.accountEquity = equity;
    this.currentEquity = equity;
    this.dailyRealizedPnlUsd = 0;
    this.weeklyRealizedPnlUsd = 0;
    this.tradesTodayCount = 0;
    this.lastResetDay = getUtcDayKey();
    this.lastResetWeek = getUtcWeekKey();
  }

  public engageKillSwitch(reason: string): void {
    this.settings.killSwitchEngaged = true;
    this.settings.killSwitchReason = reason;
  }

  public disengageKillSwitch(): void {
    this.settings.killSwitchEngaged = false;
    this.settings.killSwitchReason = undefined;
  }

  public recordTradeOpened(): void {
    this.checkDateRollover();
    this.tradesTodayCount += 1;
  }

  public recordTradeClosed(netPnlUsd: number): void {
    this.checkDateRollover();
    this.dailyRealizedPnlUsd += netPnlUsd;
    this.weeklyRealizedPnlUsd += netPnlUsd;
    this.currentEquity = Math.max(0, this.currentEquity + netPnlUsd);
  }

  public evaluateTradeRisk(params: {
    signal: TradingSignal;
    openPositions: Array<{ symbol: InstrumentSymbol; riskAmountUsd: number }>;
  }): RiskApprovalResult {
    this.checkDateRollover();
    const { signal, openPositions } = params;
    const rejectionReasons: string[] = [];
    const warnings: string[] = [];
    const now = Date.now();

    // 1. Kill switch check
    if (this.settings.killSwitchEngaged) {
      rejectionReasons.push(
        `Emergency Kill Switch engaged: ${this.settings.killSwitchReason ?? 'Manual lock'}`
      );
      return this.buildRejection(rejectionReasons, warnings, now);
    }

    // 2. Daily Loss Limit
    const dailyLossLimitUsd = this.currentEquity * (this.settings.maxDailyLossPercent / 100);
    if (this.dailyRealizedPnlUsd <= -dailyLossLimitUsd && dailyLossLimitUsd > 0) {
      rejectionReasons.push(
        `Daily loss limit reached (-$${Math.abs(this.dailyRealizedPnlUsd).toFixed(2)} vs limit -$${dailyLossLimitUsd.toFixed(2)})`
      );
    }

    // 3. Weekly Loss Limit
    const weeklyLossLimitUsd = this.currentEquity * (this.settings.maxWeeklyLossPercent / 100);
    if (this.weeklyRealizedPnlUsd <= -weeklyLossLimitUsd && weeklyLossLimitUsd > 0) {
      rejectionReasons.push(
        `Weekly loss limit reached (-$${Math.abs(this.weeklyRealizedPnlUsd).toFixed(2)})`
      );
    }

    // 4. Max Daily Trades
    if (this.tradesTodayCount >= this.settings.maxDailyTrades) {
      rejectionReasons.push(
        `Max daily trades limit reached (${this.tradesTodayCount}/${this.settings.maxDailyTrades})`
      );
    }

    // 5. Max Open Positions per Instrument
    const sameSymbolOpen = openPositions.filter((p) => p.symbol === signal.symbol).length;
    if (sameSymbolOpen >= this.settings.maxOpenPositionsPerInstrument) {
      rejectionReasons.push(
        `Max open positions per instrument reached (${sameSymbolOpen}/${this.settings.maxOpenPositionsPerInstrument} for ${signal.symbol})`
      );
    }

    // 6. Minimum Planned R:R
    if (signal.primaryRR < this.settings.minPlannedNetRR) {
      rejectionReasons.push(
        `Planned R:R 1:${signal.primaryRR.toFixed(2)} below minimum 1:${this.settings.minPlannedNetRR}`
      );
    }

    // 7. Calculate Position Sizing using Instrument Contract Spec
    const contract = getContractSpec(signal.symbol);
    const riskPct = Math.min(this.settings.maxRiskPerTradePercent, this.settings.riskPerTradePercent);
    const riskAmountUsd = this.currentEquity * (riskPct / 100);

    const priceDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    if (!Number.isFinite(priceDistance) || priceDistance <= 0) {
      rejectionReasons.push('Invalid entry price or stop-loss distance');
      return this.buildRejection(rejectionReasons, warnings, now);
    }

    const ticksAtRisk = priceDistance / contract.tickSize;
    const riskPerLot = ticksAtRisk * contract.tickValuePerLot;

    let calculatedVolume = riskPerLot > 0 ? riskAmountUsd / riskPerLot : contract.minVolume;
    calculatedVolume = Math.max(contract.minVolume, Math.min(contract.maxVolume, calculatedVolume));

    const step = contract.volumeStep;
    calculatedVolume = Math.round(calculatedVolume / step) * step;
    calculatedVolume = Math.max(contract.minVolume, Number(calculatedVolume.toFixed(4)));

    // Total open risk check
    const existingOpenRiskUsd = openPositions.reduce((acc, p) => acc + p.riskAmountUsd, 0);
    const totalOpenRiskAfterUsd = existingOpenRiskUsd + riskAmountUsd;
    const totalOpenRiskAfterPercent =
      this.currentEquity > 0 ? (totalOpenRiskAfterUsd / this.currentEquity) * 100 : 100;

    if (totalOpenRiskAfterPercent > this.settings.maxTotalOpenRiskPercent) {
      rejectionReasons.push(
        `Total open risk ${totalOpenRiskAfterPercent.toFixed(2)}% would exceed max allowed ${this.settings.maxTotalOpenRiskPercent}%`
      );
    }

    const estimatedSpreadCostUsd =
      calculatedVolume * contract.contractSize * signal.entryPrice * (contract.defaultSpreadBps / 10000);
    const estimatedCommissionUsd = calculatedVolume * contract.commissionPerLotUsd;
    const estimatedSlippageUsd =
      calculatedVolume * priceDistance * (contract.slippageBps / 10000);

    const approved = rejectionReasons.length === 0;

    return {
      approved,
      rejectionReasons,
      warnings,
      calculatedVolume: Number(calculatedVolume.toFixed(3)),
      riskAmountUsd: Number(riskAmountUsd.toFixed(2)),
      riskPercent: riskPct,
      estimatedSpreadCostUsd: Number(estimatedSpreadCostUsd.toFixed(2)),
      estimatedCommissionUsd: Number(estimatedCommissionUsd.toFixed(2)),
      estimatedSlippageUsd: Number(estimatedSlippageUsd.toFixed(2)),
      plannedNetRR: signal.primaryRR,
      totalOpenRiskAfterPercent: Number(totalOpenRiskAfterPercent.toFixed(2)),
      checkedAt: now,
    };
  }

  private buildRejection(
    rejectionReasons: string[],
    warnings: string[],
    now: number
  ): RiskApprovalResult {
    return {
      approved: false,
      rejectionReasons,
      warnings,
      calculatedVolume: 0,
      riskAmountUsd: 0,
      riskPercent: 0,
      estimatedSpreadCostUsd: 0,
      estimatedCommissionUsd: 0,
      estimatedSlippageUsd: 0,
      plannedNetRR: 0,
      totalOpenRiskAfterPercent: 0,
      checkedAt: now,
    };
  }

  public getAccountSnapshot(
    openPositionsCount: number,
    totalOpenRiskPercent?: number
  ): RiskAccountSnapshot {
    this.checkDateRollover();
    const dailyLossPct =
      this.currentEquity > 0
        ? (Math.abs(Math.min(0, this.dailyRealizedPnlUsd)) / this.currentEquity) * 100
        : 0;
    const weeklyLossPct =
      this.currentEquity > 0
        ? (Math.abs(Math.min(0, this.weeklyRealizedPnlUsd)) / this.currentEquity) * 100
        : 0;
    const tradingLocked =
      this.settings.killSwitchEngaged || dailyLossPct >= this.settings.maxDailyLossPercent;
    const lockReasons: string[] = [];
    if (this.settings.killSwitchEngaged) {
      lockReasons.push(`Kill switch: ${this.settings.killSwitchReason ?? 'Engaged'}`);
    }
    if (dailyLossPct >= this.settings.maxDailyLossPercent) {
      lockReasons.push(`Daily loss limit reached (${dailyLossPct.toFixed(2)}%)`);
    }

    return {
      settings: this.settings,
      currentEquity: Number(this.currentEquity.toFixed(2)),
      openPositionsCount,
      totalOpenRiskPercent: Number((totalOpenRiskPercent ?? 0).toFixed(2)),
      dailyRealizedPnlUsd: Number(this.dailyRealizedPnlUsd.toFixed(2)),
      dailyLossPercent: Number(dailyLossPct.toFixed(2)),
      weeklyRealizedPnlUsd: Number(this.weeklyRealizedPnlUsd.toFixed(2)),
      weeklyLossPercent: Number(weeklyLossPct.toFixed(2)),
      tradesTodayCount: this.tradesTodayCount,
      tradingLocked,
      lockReasons,
    };
  }
}
