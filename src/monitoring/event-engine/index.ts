import type {
  AnalysisSnapshot,
  ZoneInteractionEvent,
} from '../../shared/types/index.ts';

/**
 * In-memory live technical event ledger (BOS, CHoCH, Liquidity Sweeps, Zone Touches, Breakouts, Retests).
 * Deduplicated by deterministic event IDs, capped in memory, zero persistent storage.
 */
export class InMemoryEventEngine {
  private readonly events: ZoneInteractionEvent[] = [];
  private readonly seenIds = new Set<string>();
  private readonly maxEvents = 150;

  public pushEvents(items: ZoneInteractionEvent[]): ZoneInteractionEvent[] {
    const added: ZoneInteractionEvent[] = [];
    for (const item of items) {
      if (this.seenIds.has(item.id)) continue;
      this.seenIds.add(item.id);
      this.events.push(item);
      added.push(item);
    }
    if (added.length > 0) {
      this.events.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
      while (this.events.length > this.maxEvents) {
        const removed = this.events.pop();
        if (removed) this.seenIds.delete(removed.id);
      }
      added.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    }
    return added;
  }

  /**
   * Extracts structural events from an AnalysisSnapshot (BOS, CHoCH, Liquidity Sweeps, Pattern Breakouts).
   */
  public ingestSnapshotEvents(snapshot: AnalysisSnapshot): ZoneInteractionEvent[] {
    const derived: ZoneInteractionEvent[] = [];
    const currentPrice =
      snapshot.quote?.price ?? snapshot.candles[snapshot.candles.length - 1]?.close ?? 0;

    for (const br of snapshot.marketStructure.breaks.slice(-8)) {
      derived.push({
        id: `${br.id}:event`,
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        objectId: br.id,
        objectCategory: 'market_structure',
        objectLabel: `${br.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${br.type} (${br.scope})`,
        currentPrice,
        upperBound: br.levelPrice,
        lowerBound: br.levelPrice,
        distancePercent: Number(
          ((Math.abs(currentPrice - br.levelPrice) / Math.max(1e-8, currentPrice)) * 100).toFixed(3)
        ),
        status: 'Confirmed Breakout',
        touchMethod: br.breakMethod,
        timestamp: br.breakTime * 1000,
      });
    }

    for (const liq of snapshot.liquidityPools.filter((l) => l.swept && l.sweepTime).slice(-6)) {
      derived.push({
        id: `${liq.id}:sweep:${liq.sweepTime}`,
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        objectId: liq.id,
        objectCategory: 'liquidity',
        objectLabel: `${liq.label} ${liq.sweepType === 'stop_hunt' ? 'Stop Hunt' : 'Sweep'}`,
        currentPrice,
        upperBound: liq.upper,
        lowerBound: liq.lower,
        distancePercent: 0,
        status: 'Mitigated',
        timestamp: (liq.sweepTime ?? 0) * 1000,
      });
    }

    for (const cp of snapshot.chartPatterns.filter(
      (p) => p.status === 'Breakout' || p.status === 'Retest'
    )) {
      derived.push({
        id: `${cp.id}:${cp.status}`,
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        objectId: cp.id,
        objectCategory: 'chart_pattern',
        objectLabel: `${cp.name} (${cp.status})`,
        currentPrice,
        upperBound: cp.breakoutLevel,
        lowerBound: cp.breakoutLevel,
        distancePercent: 0,
        status: cp.status === 'Retest' ? 'Retesting' : 'Confirmed Breakout',
        timestamp: ((cp.retestTime ?? cp.breakoutTime ?? cp.detectionTime) || 0) * 1000,
      });
    }

    return this.pushEvents(derived.sort((a, b) => b.timestamp - a.timestamp));
  }

  public getEvents(symbol?: string, limit = 60): ZoneInteractionEvent[] {
    const filtered = symbol ? this.events.filter((e) => e.symbol === symbol) : this.events;
    return filtered.slice(0, limit);
  }
}
