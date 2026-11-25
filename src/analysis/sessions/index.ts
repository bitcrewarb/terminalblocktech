import type {
  Candle,
  InstrumentSymbol,
  SessionAnchors,
  TradingSessionBox,
} from '../../shared/types/index.ts';

const tzFormatters = new Map<string, Intl.DateTimeFormat>();
const localTimeCache = new Map<string, { hour: number; minute: number; dateKey: string }>();

function getTzFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = tzFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    tzFormatters.set(timeZone, fmt);
  }
  return fmt;
}

function getLocalHourMinute(
  epochSec: number,
  timeZone: string
): { hour: number; minute: number; dateKey: string } {
  const cacheKey = `${timeZone}:${epochSec}`;
  const cached = localTimeCache.get(cacheKey);
  if (cached) return cached;

  const fmt = getTzFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(epochSec * 1000));
  let year = '0000';
  let month = '00';
  let day = '00';
  let hourStr = '00';
  let minStr = '00';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hourStr = p.value;
    else if (p.type === 'minute') minStr = p.value;
  }

  const res = {
    hour: Number(hourStr) % 24,
    minute: Number(minStr),
    dateKey: `${year}-${month}-${day}`,
  };
  if (localTimeCache.size > 60000) {
    localTimeCache.clear();
  }
  localTimeCache.set(cacheKey, res);
  return res;
}

/**
 * Computes DST-aware trading session ranges (Asian, London, New York, London/NY Overlap),
 * session highs/lows, session liquidity sweeps, and Daily/Weekly/Monthly open/high/low anchors.
 */
export function analyzeTradingSessions(
  candles: Candle[],
  dailyCandles: Candle[],
  symbol: InstrumentSymbol
): { sessions: TradingSessionBox[]; anchors: SessionAnchors } {
  const sessions: TradingSessionBox[] = [];
  if (candles.length === 0) {
    return {
      sessions,
      anchors: {
        dailyOpen: null,
        dailyOpenTime: null,
        weeklyOpen: null,
        weeklyOpenTime: null,
        prevDayHigh: null,
        prevDayLow: null,
        prevWeekHigh: null,
        prevWeekLow: null,
        prevMonthHigh: null,
        prevMonthLow: null,
      },
    };
  }

  // Only render session boxes on intraday charts (<= 4H) where sessions are meaningful
  const recent = candles.slice(-300);

  type SessionDef = {
    name: TradingSessionBox['session'];
    tz: string;
    startHour: number;
    endHour: number;
  };

  const defs: SessionDef[] = [
    { name: 'Asian', tz: 'Asia/Tokyo', startHour: 9, endHour: 18 }, // 09:00-18:00 JST (00:00-09:00 UTC)
    { name: 'London', tz: 'Europe/London', startHour: 8, endHour: 16 }, // 08:00-16:00 London (DST-aware)
    { name: 'New York', tz: 'America/New_York', startHour: 8, endHour: 17 }, // 08:00-17:00 ET (DST-aware)
    { name: 'London/NY Overlap', tz: 'America/New_York', startHour: 8, endHour: 11 }, // Overlap window (DST-aware)
  ];

  for (const def of defs) {
    const buckets = new Map<string, Candle[]>();
    for (const c of recent) {
      const { hour, dateKey } = getLocalHourMinute(c.time, def.tz);
      if (hour >= def.startHour && hour < def.endHour) {
        const arr = buckets.get(dateKey) ?? [];
        arr.push(c);
        buckets.set(dateKey, arr);
      }
    }

    const keys = Array.from(buckets.keys()).sort().slice(-4);
    let prevHigh: number | null = null;
    let prevLow: number | null = null;

    for (let idx = 0; idx < keys.length; idx++) {
      const bars = buckets.get(keys[idx])!;
      if (bars.length === 0) continue;
      const highPrice = Math.max(...bars.map((b) => b.high));
      const lowPrice = Math.min(...bars.map((b) => b.low));
      const sweptPrevHigh = prevHigh !== null && highPrice > prevHigh;
      const sweptPrevLow = prevLow !== null && lowPrice < prevLow;
      const isActive = idx === keys.length - 1 && !bars[bars.length - 1].isClosed;

      sessions.push({
        id: `${symbol}:session:${def.name}:${keys[idx]}`,
        symbol,
        session: def.name,
        startTime: bars[0].time,
        endTime: bars[bars.length - 1].time,
        openPrice: bars[0].open,
        highPrice,
        lowPrice,
        closePrice: bars[bars.length - 1].close,
        sweptPrevHigh,
        sweptPrevLow,
        isActive,
      });

      prevHigh = highPrice;
      prevLow = lowPrice;
    }
  }

  // Compute Daily, Weekly, Monthly anchors from dailyCandles (or fallback to current candles)
  const refDaily = dailyCandles.length >= 2 ? dailyCandles : candles;
  const lastDay = refDaily[refDaily.length - 1];
  const prevDay = refDaily.length >= 2 ? refDaily[refDaily.length - 2] : null;

  // Find current UTC week start (Monday 00:00 UTC)
  const latestSec = candles[candles.length - 1].time;
  const latestDate = new Date(latestSec * 1000);
  const utcDay = latestDate.getUTCDay();
  const diffToMon = (utcDay + 6) % 7;
  const thisWeekStartSec = Math.floor(
    Date.UTC(
      latestDate.getUTCFullYear(),
      latestDate.getUTCMonth(),
      latestDate.getUTCDate() - diffToMon
    ) / 1000
  );
  const prevWeekStartSec = thisWeekStartSec - 7 * 86400;

  const thisWeekBars = refDaily.filter((c) => c.time >= thisWeekStartSec);
  const prevWeekBars = refDaily.filter(
    (c) => c.time >= prevWeekStartSec && c.time < thisWeekStartSec
  );

  const thisMonthStartSec = Math.floor(
    Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), 1) / 1000
  );
  const prevMonthStartSec = Math.floor(
    Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth() - 1, 1) / 1000
  );
  const prevMonthBars = refDaily.filter(
    (c) => c.time >= prevMonthStartSec && c.time < thisMonthStartSec
  );

  const anchors: SessionAnchors = {
    dailyOpen: lastDay ? lastDay.open : null,
    dailyOpenTime: lastDay ? lastDay.time : null,
    weeklyOpen: thisWeekBars.length > 0 ? thisWeekBars[0].open : null,
    weeklyOpenTime: thisWeekBars.length > 0 ? thisWeekBars[0].time : null,
    prevDayHigh: prevDay ? prevDay.high : null,
    prevDayLow: prevDay ? prevDay.low : null,
    prevWeekHigh:
      prevWeekBars.length > 0 ? Math.max(...prevWeekBars.map((b) => b.high)) : null,
    prevWeekLow:
      prevWeekBars.length > 0 ? Math.min(...prevWeekBars.map((b) => b.low)) : null,
    prevMonthHigh:
      prevMonthBars.length > 0 ? Math.max(...prevMonthBars.map((b) => b.high)) : null,
    prevMonthLow:
      prevMonthBars.length > 0 ? Math.min(...prevMonthBars.map((b) => b.low)) : null,
  };

  return { sessions, anchors };
}
