import type { InstrumentSymbol } from '../../shared/types/index.ts';

export type MetalsSymbol = Extract<InstrumentSymbol, 'XAUUSD' | 'XAGUSD'>;

/**
 * Spot metals market session calendar (Sunday 22:00 UTC to Friday 22:00 UTC).
 */
export function isMetalsMarketOpen(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;
  return true;
}
