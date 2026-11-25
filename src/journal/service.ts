import type {
  PaperPosition,
  TradeJournalEntry,
  TradingSignal,
} from '../shared/types/index.ts';
import type { PlatformSqliteStore } from '../storage/platform-db.ts';

function deriveOutcome(position: PaperPosition): TradeJournalEntry['outcome'] {
  if (position.status !== 'CLOSED') return 'OPEN';
  if (position.realizedPnlUsd > 0.01) return 'WIN';
  if (position.realizedPnlUsd < -0.01) return 'LOSS';
  return 'BREAKEVEN';
}

export class TradeJournalService {
  private readonly store: PlatformSqliteStore;

  constructor(store: PlatformSqliteStore) {
    this.store = store;
  }

  public createEntryFromPosition(signal: TradingSignal, position: PaperPosition): TradeJournalEntry {
    const now = Date.now();
    const entry: TradeJournalEntry = {
      id: position.journalId || `jnl:${position.id}`,
      signalId: signal.id,
      executionId: position.orderId,
      positionId: position.id,
      symbol: signal.symbol,
      timeframe: signal.entryTimeframe,
      direction: signal.direction,
      strategyId: signal.strategyId ?? 'unknown',
      strategyName: signal.strategyName ?? 'Strategy Signal',
      strategyVersion: signal.strategyVersion ?? 'v1.0',
      marketRegime: signal.marketRegime ?? 'Transitional',
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice ?? null,
      stopLoss: position.stopLoss,
      takeProfit1:
        signal.takeProfits?.[0]?.price ??
        position.entryPrice * (signal.direction === 'BUY' ? 1.01 : 0.99),
      takeProfit2: signal.takeProfits?.[1]?.price ?? null,
      takeProfit3: signal.takeProfits?.[2]?.price ?? null,
      volume: position.volumeTotal,
      riskAmountUsd: position.riskAmountUsd,
      realizedPnlUsd: position.realizedPnlUsd,
      realizedR: position.realizedR,
      feesUsd: position.feesUsd,
      status: position.status,
      outcome: deriveOutcome(position),
      entryReason:
        signal.generationSummary ?? signal.confluenceReasons?.[0] ?? 'Strategy signal execution',
      exitReason: position.exitReason,
      reflectionNotes: '',
      lessonsLearned: '',
      tags: [signal.symbol, signal.direction, signal.strategyName ?? 'Strategy'],
      rating: null,
      executedAt: position.openedAt,
      closedAt: position.closedAt,
      updatedAt: now,
    };

    this.store.upsertJournalEntry(entry);
    return entry;
  }

  public syncPositionToJournal(position: PaperPosition): TradeJournalEntry | null {
    const id = position.journalId || `jnl:${position.id}`;
    const existing = this.store.getJournalEntryById(id);
    if (!existing) return null;

    existing.exitPrice = position.exitPrice ?? null;
    existing.stopLoss = position.stopLoss;
    existing.realizedPnlUsd = position.realizedPnlUsd;
    existing.realizedR = position.realizedR;
    existing.feesUsd = position.feesUsd;
    existing.status = position.status;
    existing.outcome = deriveOutcome(position);
    existing.exitReason = position.exitReason ?? null;
    existing.closedAt = position.closedAt ?? null;
    existing.updatedAt = Date.now();

    this.store.upsertJournalEntry(existing);
    return existing;
  }

  public updateEntry(
    id: string,
    updates: {
      reflectionNotes?: string;
      lessonsLearned?: string;
      tags?: string[];
      rating?: number | null;
    }
  ): TradeJournalEntry | null {
    const entry = this.store.getJournalEntryById(id);
    if (!entry) return null;

    if (updates.reflectionNotes !== undefined) entry.reflectionNotes = updates.reflectionNotes;
    if (updates.lessonsLearned !== undefined) entry.lessonsLearned = updates.lessonsLearned;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.rating !== undefined) entry.rating = updates.rating;
    entry.updatedAt = Date.now();

    this.store.upsertJournalEntry(entry);
    return entry;
  }

  public deleteEntry(id: string): boolean {
    return this.store.deleteJournalEntry(id);
  }

  public deleteAllEntries(): number {
    return this.store.deleteAllJournalEntries();
  }

  public getAllEntries(): TradeJournalEntry[] {
    return this.store.getAllJournalEntries();
  }
}
