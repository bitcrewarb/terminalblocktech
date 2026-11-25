import { describe, expect, it } from 'vitest';
import { InMemoryCandleSeries } from '../market-data/candle-builder/index.ts';
import { fetchBinanceHistoricalCandles } from '../market-data/providers/binance.ts';
import { fetchTradingViewHistoricalCandles } from '../market-data/providers/tradingview.ts';
import { sanitizeAndInspectCandles } from '../shared/validators/index.ts';
import fixtureCandles from './btcusdt_15m_fixture.json' with { type: 'json' };

describe('Candle Construction, Synchronization & Data Integrity', () => {
  it('deduplicates duplicate timestamps and fixes out-of-order candles', () => {
    const base = fixtureCandles.slice(0, 10);
    const unsortedWithDup = [base[3], base[1], base[0], base[1], base[2]];
    const res = sanitizeAndInspectCandles(unsortedWithDup, '15m', true);

    expect(res.candles.length).toBe(4);
    expect(res.duplicatesRemoved).toBe(1);
    expect(res.outOfOrderFixed).toBeGreaterThan(0);
    expect(res.candles[0].time).toBeLessThan(res.candles[1].time);
  });

  it('detects missing candle intervals in 24/7 crypto series', () => {
    const base = fixtureCandles.slice(0, 10);
    const withGap = [...base.slice(0, 4), ...base.slice(6)];
    const res = sanitizeAndInspectCandles(withGap, '15m', true);
    expect(res.missingIntervals.length).toBe(2);
  });

  it('rejects out-of-order live candle updates and prevents duplicates in InMemoryCandleSeries', () => {
    const series = new InMemoryCandleSeries('15m', true, 500);
    series.setHistorical(fixtureCandles.slice(0, 20));
    const last = series.getLatest()!;

    // Out-of-order older candle must be rejected
    const olderRes = series.applyCandle({
      ...fixtureCandles[5],
      close: fixtureCandles[5].close + 10,
    });
    expect(olderRes.rejectedReason).toContain('Out-of-order');

    // Same-timestamp live update merges cleanly without duplicating bar
    const sameRes = series.applyCandle({
      time: last.time,
      open: last.open,
      high: last.high + 5,
      low: last.low,
      close: last.close + 2,
      volume: last.volume + 1,
      isClosed: false,
    });
    expect(sameRes.rejectedReason).toBeUndefined();
    expect(sameRes.candles.length).toBe(20);
    expect(sameRes.updatedCandle.high).toBe(last.high + 5);
  });

  it('fetches genuine historical BTCUSDT from Binance and XAUUSD/XAGUSD OHLCV from TradingView', async () => {
    const btc = await fetchBinanceHistoricalCandles('BTCUSDT', '15m', 25);
    expect(btc.length).toBe(25);
    expect(btc[0].close).toBeGreaterThan(1000);

    const xau = await fetchTradingViewHistoricalCandles('XAUUSD', '15m', 25);
    expect(xau.length).toBeGreaterThanOrEqual(20);
    expect(xau[0].close).toBeGreaterThan(500);

    const xag = await fetchTradingViewHistoricalCandles('XAGUSD', '15m', 25);
    expect(xag.length).toBeGreaterThanOrEqual(20);
    expect(xag[0].close).toBeGreaterThan(5);
  });
});
