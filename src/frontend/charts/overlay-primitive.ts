import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type {
  AnalysisSnapshot,
  ChartVisibilityConfig,
  TechnicalCategory,
  TradingSignal,
} from '../../shared/types/index.ts';

export interface HitBox extends PrimitiveHoveredItem {
  id: string;
  category: TechnicalCategory | 'signal';
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface OverlayState {
  snapshot: AnalysisSnapshot | null;
  signals: TradingSignal[];
  visibility: ChartVisibilityConfig;
  hoveredId: string | null;
  selectedId: string | null;
  precision: number;
}

class OverlayPaneRenderer implements IPrimitivePaneRenderer {
  private readonly getState: () => OverlayState;
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<SeriesType>;
  private readonly onHitBoxesUpdated: (boxes: HitBox[]) => void;

  constructor(
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    getState: () => OverlayState,
    onHitBoxesUpdated: (boxes: HitBox[]) => void
  ) {
    this.chart = chart;
    this.series = series;
    this.getState = getState;
    this.onHitBoxesUpdated = onHitBoxesUpdated;
  }

  public draw(target: { useMediaCoordinateSpace: (cb: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) => void }): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const state = this.getState();
      const snap = state.snapshot;
      if (!snap || snap.candles.length === 0) {
        this.onHitBoxesUpdated([]);
        return;
      }

      const timeScale = this.chart.timeScale();
      const width = mediaSize.width;
      const height = mediaSize.height;
      const hitBoxes: HitBox[] = [];
      const vis = state.visibility;
      const placedLabelRects: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

      const timeToX = (t: number): number | null => {
        const coord = timeScale.timeToCoordinate(t as Time);
        if (coord !== null) return coord;
        const candles = snap.candles;
        const first = candles[0].time;
        const last = candles[candles.length - 1].time;
        if (t < first) return -20;
        if (t > last) return width - 10;
        // Binary search nearest candle timestamp so gap/interpolated times still map cleanly
        let lo = 0;
        let hi = candles.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candles[mid].time < t) lo = mid + 1;
          else hi = mid;
        }
        const nearest =
          lo > 0 && Math.abs(candles[lo - 1].time - t) < Math.abs(candles[lo].time - t)
            ? candles[lo - 1].time
            : candles[lo].time;
        return timeScale.timeToCoordinate(nearest as Time);
      };

      const priceToY = (p: number): number | null => {
        return this.series.priceToCoordinate(p);
      };

      const isActive = (id: string) => id === state.hoveredId || id === state.selectedId;

      const drawLabelNoOverlap = (
        text: string,
        x: number,
        y: number,
        color: string,
        bg = 'rgba(11, 14, 20, 0.85)',
        align: 'left' | 'right' = 'left',
        force = false
      ) => {
        ctx.font = force ? '700 11px "JetBrains Mono", monospace' : '600 10px "JetBrains Mono", monospace';
        const m = ctx.measureText(text);
        const padX = force ? 6 : 4;
        const h = force ? 16 : 14;
        const w = m.width + padX * 2;
        const rx = Math.max(4, Math.min(width - w - 4, align === 'right' ? x - w : x));
        let ry = Math.max(4, Math.min(height - h - 4, y - h / 2));

        if (!force) {
          // Nudge vertically if colliding with an existing label
          for (let attempt = 0; attempt < 4; attempt++) {
            const overlaps = placedLabelRects.some(
              (r) => !(rx + w < r.x1 || rx > r.x2 || ry + h < r.y1 || ry > r.y2)
            );
            if (!overlaps) break;
            ry += h + 2;
          }
          if (ry + h > height - 2) return;
        }

        placedLabelRects.push({ x1: rx, y1: ry, x2: rx + w, y2: ry + h });
        ctx.fillStyle = bg;
        ctx.fillRect(rx, ry, w, h);
        if (force) {
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = 1;
          ctx.strokeRect(rx, ry, w, h);
        }
        ctx.fillStyle = color;
        ctx.fillText(text, rx + padX, ry + (force ? 11.5 : 10.5));
      };

      const drawZoneBox = (
        id: string,
        category: TechnicalCategory,
        label: string,
        startTime: number,
        upper: number,
        lower: number,
        fillColor: string,
        strokeColor: string,
        textColor: string,
        extendRight = true,
        endTime?: number
      ) => {
        const x1Raw = timeToX(startTime);
        const x2Raw = extendRight ? width : timeToX(endTime ?? startTime);
        const y1 = priceToY(upper);
        const y2 = priceToY(lower);
        if (y1 === null || y2 === null) return;

        const x1 = Math.max(0, x1Raw ?? 0);
        const x2 = Math.min(width, x2Raw ?? width);
        if (x2 <= x1 + 2) return;

        const top = Math.min(y1, y2);
        const boxH = Math.max(3, Math.abs(y2 - y1));
        const active = isActive(id);

        ctx.save();
        ctx.fillStyle = active ? 'rgba(56, 189, 248, 0.22)' : fillColor;
        ctx.fillRect(x1, top, x2 - x1, boxH);
        ctx.lineWidth = active ? 2.5 : 1;
        ctx.strokeStyle = active ? '#38BDF8' : strokeColor;
        ctx.strokeRect(x1, top, x2 - x1, boxH);
        ctx.restore();

        drawLabelNoOverlap(
          label,
          Math.max(x1 + 4, width - 6),
          top + boxH / 2,
          active ? '#E0F2FE' : textColor,
          active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.88)',
          'right',
          active
        );
        hitBoxes.push({ id, externalId: id, zOrder: 'top', category, label, x1, y1: top, x2, y2: top + boxH });
      };

      // 1. Trading Sessions (Background subtle shading)
      if (vis.sessions) {
        const sessColors: Record<string, string> = {
          Asian: 'rgba(148, 163, 184, 0.05)',
          London: 'rgba(56, 189, 248, 0.06)',
          'New York': 'rgba(16, 185, 129, 0.06)',
          'London/NY Overlap': 'rgba(245, 158, 11, 0.08)',
        };
        for (const sess of snap.sessions) {
          const x1 = timeToX(sess.startTime);
          const x2 = timeToX(sess.endTime);
          const y1 = priceToY(sess.highPrice);
          const y2 = priceToY(sess.lowPrice);
          if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
          const left = Math.max(0, x1);
          const right = Math.min(width, x2);
          if (right <= left + 2) continue;
          const top = Math.min(y1, y2);
          const boxH = Math.max(4, Math.abs(y2 - y1));

          ctx.save();
          ctx.fillStyle = sessColors[sess.session] ?? 'rgba(148,163,184,0.05)';
          ctx.fillRect(left, top, right - left, boxH);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(left, top, right - left, boxH);
          ctx.restore();
          drawLabelNoOverlap(sess.session, left + 4, top + 8, '#94A3B8', 'rgba(11,14,20,0.65)', 'left');
        }
      }

      // 2. Premium / Discount & OTE Dealing Range
      if (vis.premiumDiscount && snap.dealingRange) {
        const dr = snap.dealingRange;
        const levels: Array<{ price: number; label: string; color: string; dash: number[] }> = [
          { price: dr.rangeHigh, label: `Range High (${dr.rangeHigh.toFixed(state.precision)})`, color: 'rgba(239, 68, 68, 0.55)', dash: [4, 4] },
          { price: dr.equilibrium, label: `EQ 50% (${dr.equilibrium.toFixed(state.precision)})`, color: 'rgba(56, 189, 248, 0.7)', dash: [5, 3] },
          { price: dr.fib62, label: `0.62`, color: 'rgba(245, 158, 11, 0.45)', dash: [2, 4] },
          { price: dr.ote705, label: `OTE 0.705`, color: 'rgba(245, 158, 11, 0.7)', dash: [2, 3] },
          { price: dr.fib79, label: `0.79`, color: 'rgba(245, 158, 11, 0.45)', dash: [2, 4] },
          { price: dr.rangeLow, label: `Range Low (${dr.rangeLow.toFixed(state.precision)})`, color: 'rgba(16, 185, 129, 0.55)', dash: [4, 4] },
        ];
        const xStart = Math.max(0, timeToX(Math.min(dr.highTime, dr.lowTime)) ?? 0);
        for (const lv of levels) {
          const y = priceToY(lv.price);
          if (y === null || y < 0 || y > height) continue;
          ctx.save();
          ctx.strokeStyle = lv.color;
          ctx.lineWidth = 1;
          ctx.setLineDash(lv.dash);
          ctx.beginPath();
          ctx.moveTo(xStart, y);
          ctx.lineTo(width, y);
          ctx.stroke();
          ctx.restore();
          drawLabelNoOverlap(lv.label, xStart + 4, y, lv.color.replace(/[\d.]+\)$/, '1)'), 'rgba(11,14,20,0.75)', 'left');
        }
      }

      // 3. Support & Resistance Zones
      for (const sr of snap.supportResistance) {
        const active = isActive(sr.id);
        if (!active && (!vis.supportResistance || sr.status === 'Invalidated')) continue;
        const alpha = 0.08 + (sr.strengthScore / 100) * 0.14;
        const isSup = sr.kind === 'support';
        const fill = isSup ? `rgba(16, 185, 129, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
        const stroke = isSup ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)';
        const textCol = isSup ? '#34D399' : '#F87171';
        drawZoneBox(
          sr.id,
          'support_resistance',
          `${sr.label} · ${sr.midpoint.toFixed(state.precision)} (${sr.status})`,
          sr.firstDetection,
          sr.upper,
          sr.lower,
          fill,
          stroke,
          textCol,
          true
        );
      }

      // 4. Supply & Demand Zones
      for (const sd of snap.supplyDemand) {
        const active = isActive(sd.id);
        if (!active && (!vis.supplyDemand || sd.freshness === 'invalidated')) continue;
        const alpha = sd.freshness === 'fresh' ? 0.2 : sd.freshness === 'tested' ? 0.12 : 0.07;
        const isDem = sd.kind === 'demand';
        const fill = isDem ? `rgba(16, 185, 129, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
        const stroke = isDem ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)';
        const textCol = isDem ? '#6EE7B7' : '#FCA5A5';
        drawZoneBox(
          sd.id,
          'supply_demand',
          `${sd.patternType} ${sd.kind.toUpperCase()} · ${sd.freshness}`,
          sd.originCandleTime,
          Math.max(sd.proximal, sd.distal),
          Math.min(sd.proximal, sd.distal),
          fill,
          stroke,
          textCol,
          true
        );
      }

      // 5. Order Blocks
      for (const ob of snap.orderBlocks) {
        const active = isActive(ob.id);
        if (!active && (!vis.orderBlocks || !ob.valid)) continue;
        const isBull = ob.kind === 'bullish_ob' || ob.kind === 'breaker_block';
        const fill = isBull ? 'rgba(56, 189, 248, 0.14)' : 'rgba(249, 115, 22, 0.14)';
        const stroke = isBull ? 'rgba(56, 189, 248, 0.75)' : 'rgba(249, 115, 22, 0.75)';
        const textCol = isBull ? '#7DD3FC' : '#FDBA74';
        drawZoneBox(
          ob.id,
          'order_block',
          `${ob.kind.replace('_', ' ').toUpperCase()} (${ob.displacementAtr}x ATR)`,
          ob.originTime,
          ob.upper,
          ob.lower,
          fill,
          stroke,
          textCol,
          true
        );
      }

      // 6. Fair Value Gaps
      for (const fvg of snap.fairValueGaps) {
        const active = isActive(fvg.id);
        if (!active && (!vis.fairValueGaps || fvg.status === 'fully_filled' || fvg.status === 'inverted')) {
          continue;
        }
        const isBull = fvg.kind === 'bullish_fvg';
        const fill = isBull ? 'rgba(34, 211, 238, 0.11)' : 'rgba(244, 63, 94, 0.11)';
        const stroke = isBull ? 'rgba(34, 211, 238, 0.5)' : 'rgba(244, 63, 94, 0.5)';
        drawZoneBox(
          fvg.id,
          'fvg',
          `${fvg.kind === 'bullish_fvg' ? 'Bull FVG' : fvg.kind === 'bearish_fvg' ? 'Bear FVG' : 'Vol Imb'} (${fvg.fillPercent}%)`,
          fvg.originTime,
          fvg.upper,
          fvg.lower,
          fill,
          stroke,
          isBull ? '#67E8F9' : '#FDA4AF',
          true
        );

        // Draw Consequent Encroachment (50%) dotted line
        const ceY = priceToY(fvg.consequentEncroachment);
        const x1 = Math.max(0, timeToX(fvg.originTime) ?? 0);
        if (ceY !== null) {
          ctx.save();
          ctx.strokeStyle = active ? 'rgba(56, 189, 248, 0.8)' : 'rgba(226, 232, 240, 0.35)';
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(x1, ceY);
          ctx.lineTo(width, ceY);
          ctx.stroke();
          ctx.restore();
        }
      }

      // 7. Liquidity Pools & Liquidity Sweeps
      const liqTotal = snap.liquidityPools.length;
      for (let li = 0; li < liqTotal; li++) {
        const liq = snap.liquidityPools[li];
        const active = isActive(liq.id);
        const showPool = active || (vis.liquidity && li >= liqTotal - 24);
        const showSweep =
          (active || vis.liquiditySweeps || vis.liquidity) &&
          liq.swept &&
          liq.sweepTime !== null &&
          (active || li >= liqTotal - 18);

        if (!showPool && !showSweep) continue;
        const y = priceToY(liq.price);
        if (y === null || y < 0 || y > height) continue;

        const x1 = Math.max(0, timeToX(liq.originTimes[0] ?? snap.candles[0].time) ?? 0);
        const sweepX = liq.sweepTime !== null ? timeToX(liq.sweepTime) : null;

        if (showPool) {
          const col = liq.swept ? '#64748B' : '#FACC15';
          ctx.save();
          ctx.strokeStyle = active ? '#38BDF8' : col;
          ctx.lineWidth = active ? 2.5 : 1;
          ctx.setLineDash(liq.swept ? [2, 4] : [6, 4]);
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(width, y);
          ctx.stroke();
          ctx.restore();

          drawLabelNoOverlap(
            `${liq.label}${liq.swept ? ' [SWEPT]' : ''} ${liq.price.toFixed(state.precision)}`,
            width - 6,
            y,
            active ? '#E0F2FE' : col,
            active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.85)',
            'right',
            active
          );
          hitBoxes.push({
            id: liq.id,
            externalId: liq.id,
            zOrder: 'top',
            category: 'liquidity',
            label: liq.label,
            x1,
            y1: y - 6,
            x2: width,
            y2: y + 6,
          });
        }

        if (showSweep && sweepX !== null && sweepX >= -10 && sweepX <= width + 10) {
          const sweepCol = active
            ? '#38BDF8'
            : liq.sweepType === 'stop_hunt'
              ? '#EF4444'
              : liq.sweepType === 'liquidity_run'
                ? '#A855F7'
                : '#F59E0B';
          const sweepTag =
            liq.sweepType === 'stop_hunt'
              ? 'STOP HUNT'
              : liq.sweepType === 'liquidity_run'
                ? 'LIQ RUN'
                : 'SWEEP';

          // Connect origin liquidity level to sweep candle when full pool lines are hidden
          if (!showPool && sweepX > x1) {
            ctx.save();
            ctx.strokeStyle = active ? '#38BDF8' : 'rgba(245, 158, 11, 0.65)';
            ctx.lineWidth = active ? 2.2 : 1.2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(sweepX, y);
            ctx.stroke();
            ctx.restore();
          }

          // Diamond sweep marker at exact (sweepTime, pool price)
          const r = active ? 6.5 : 5;
          ctx.save();
          ctx.fillStyle = '#0B0E14';
          ctx.strokeStyle = sweepCol;
          ctx.lineWidth = active ? 2.5 : 1.8;
          ctx.beginPath();
          ctx.moveTo(sweepX, y - r);
          ctx.lineTo(sweepX + r, y);
          ctx.lineTo(sweepX, y + r);
          ctx.lineTo(sweepX - r, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = sweepCol;
          ctx.beginPath();
          ctx.arc(sweepX, y, 1.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          const isBuySide =
            liq.kind === 'buy_side' ||
            liq.kind === 'equal_highs' ||
            liq.kind === 'pdh' ||
            liq.kind === 'pwh';
          const shortPoolLabel = liq.label
            .replace(/\s*\((Buy-Side|Sell-Side)\)/g, '')
            .replace(/\s*Liquidity/g, '');
          drawLabelNoOverlap(
            active ? `${sweepTag} · ${liq.label}` : `${sweepTag} · ${shortPoolLabel}`,
            sweepX + 8,
            isBuySide ? y - 12 : y + 12,
            active ? '#E0F2FE' : sweepCol,
            active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.88)',
            'left',
            active
          );

          if (!showPool) {
            hitBoxes.push({
              id: liq.id,
              externalId: liq.id,
              zOrder: 'top',
              category: 'liquidity',
              label: `${sweepTag}: ${liq.label}`,
              x1: Math.min(x1, sweepX - 10),
              y1: y - 10,
              x2: sweepX + 14,
              y2: y + 10,
            });
          }
        }
      }

      // 8. Market Structure BOS / CHoCH / MSS horizontal break lines
      const brTotal = snap.marketStructure.breaks.length;
      for (let bi = 0; bi < brTotal; bi++) {
        const br = snap.marketStructure.breaks[bi];
        const active = isActive(br.id);
        if (!active && (bi < brTotal - 20 || !vis.marketStructure)) continue;
        if (!active && !vis.provisional && br.confirmationStatus === 'provisional') continue;
        const x1 = timeToX(br.originTime);
        const x2 = timeToX(br.breakTime);
        const y = priceToY(br.levelPrice);
        if (x1 === null || x2 === null || y === null) continue;
        const col = br.direction === 'bullish' ? '#10B981' : '#EF4444';

        ctx.save();
        ctx.strokeStyle = active ? '#38BDF8' : col;
        ctx.lineWidth = active ? 2.8 : br.scope === 'external' ? 1.8 : 1.1;
        if (br.scope === 'internal') ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.restore();

        const midX = (x1 + x2) / 2;
        drawLabelNoOverlap(
          `${br.direction === 'bullish' ? 'Bull' : 'Bear'} ${br.type}`,
          midX,
          y - 10,
          active ? '#E0F2FE' : col,
          active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.8)',
          'left',
          active
        );
        hitBoxes.push({
          id: br.id,
          externalId: br.id,
          zOrder: 'top',
          category: 'market_structure',
          label: `${br.direction} ${br.type}`,
          x1: Math.min(x1, x2),
          y1: y - 10,
          x2: Math.max(x1, x2),
          y2: y + 10,
        });
      }

      // 9. Automatic Trendlines & Channels
      if (snap.trendlines.length > 0) {
        const lastTime = snap.candles[snap.candles.length - 1].time;
        for (const tl of snap.trendlines) {
          const active = isActive(tl.id);
          if (!active && !vis.trendlines) continue;
          if (!active && !vis.provisional && tl.status === 'provisional') continue;
          const x1 = timeToX(tl.p1Time);
          const y1 = priceToY(tl.p1Price);
          const x2 = timeToX(lastTime);
          const y2 = priceToY(tl.currentProjectedPrice);
          if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

          const col =
            tl.status === 'broken' || tl.status === 'retested'
              ? '#F59E0B'
              : tl.kind.includes('bullish') || tl.kind === 'ascending_channel'
                ? '#10B981'
                : '#EF4444';

          ctx.save();
          ctx.strokeStyle = active ? '#38BDF8' : col;
          ctx.lineWidth = active ? 2.8 : 1.6;
          if (tl.status === 'provisional' || tl.status === 'broken') ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(width, y1 + ((y2 - y1) / Math.max(1, x2 - x1)) * (width - x1));
          ctx.stroke();
          ctx.restore();

          drawLabelNoOverlap(
            `${tl.kind.replace('_', ' ')} (${tl.touches}T)`,
            Math.max(0, x1 + 6),
            y1 - 8,
            active ? '#E0F2FE' : col,
            active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.8)',
            'left',
            active
          );

          hitBoxes.push({
            id: tl.id,
            externalId: tl.id,
            zOrder: 'top',
            category: 'trendline',
            label: tl.kind,
            x1: Math.min(x1, x2),
            y1: Math.min(y1, y2) - 8,
            x2: width,
            y2: Math.max(y1, y2) + 8,
          });
        }
      }

      // 10. Chart Patterns (Boundaries, Neckline, Shaded Region, Breakout & Target)
      for (const cp of snap.chartPatterns) {
        const active = isActive(cp.id);
        if (!active && (!vis.chartPatterns || cp.status === 'Invalidated')) continue;
        const col =
          cp.direction === 'bullish'
            ? '#34D399'
            : cp.direction === 'bearish'
              ? '#F87171'
              : '#94A3B8';

        const drawPoly = (pts: { time: number; price: number }[], dashed = false) => {
          if (pts.length < 2) return;
          ctx.save();
          ctx.strokeStyle = active ? '#38BDF8' : col;
          ctx.lineWidth = active ? 2.6 : 1.6;
          if (dashed) ctx.setLineDash([5, 4]);
          ctx.beginPath();
          let started = false;
          for (const pt of pts) {
            const x = timeToX(pt.time);
            const y = priceToY(pt.price);
            if (x === null || y === null) continue;
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
          ctx.restore();
        };

        const sx = timeToX(cp.startTime);
        const ex = timeToX(cp.endTime);
        const topP = Math.max(
          ...cp.upperBoundary.map((p) => p.price),
          ...cp.lowerBoundary.map((p) => p.price)
        );
        const botP = Math.min(
          ...cp.upperBoundary.map((p) => p.price),
          ...cp.lowerBoundary.map((p) => p.price)
        );
        const sy = priceToY(topP);
        const ey = priceToY(botP);

        // When hovered/selected, highlight the full formation area clearly
        if (active && sx !== null && ex !== null && sy !== null && ey !== null) {
          const left = Math.min(sx, ex);
          const right = Math.max(sx, ex);
          const top = Math.min(sy, ey);
          const bot = Math.max(sy, ey);
          ctx.save();
          ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
          ctx.fillRect(left, top, Math.max(8, right - left), Math.max(8, bot - top));
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(left, top, Math.max(8, right - left), Math.max(8, bot - top));
          ctx.restore();

          // Also highlight Breakout Level and Measured Target when active
          const boY = priceToY(cp.breakoutLevel);
          if (boY !== null) {
            ctx.save();
            ctx.strokeStyle = '#F59E0B';
            ctx.lineWidth = 1.4;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(left, boY);
            ctx.lineTo(Math.min(width, right + 60), boY);
            ctx.stroke();
            ctx.restore();
          }
          if (cp.measuredTarget) {
            const tgtY = priceToY(cp.measuredTarget);
            if (tgtY !== null) {
              ctx.save();
              ctx.strokeStyle = col;
              ctx.lineWidth = 1.4;
              ctx.setLineDash([2, 3]);
              ctx.beginPath();
              ctx.moveTo(left, tgtY);
              ctx.lineTo(Math.min(width, right + 60), tgtY);
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        drawPoly(cp.upperBoundary, cp.status === 'Forming');
        drawPoly(cp.lowerBoundary, cp.status === 'Forming');
        if (cp.neckline) drawPoly(cp.neckline, true);

        if (sx !== null && ex !== null && sy !== null && ey !== null) {
          drawLabelNoOverlap(
            `${cp.name} [${cp.status}]`,
            Math.max(4, Math.min(sx, ex) + 4),
            Math.min(sy, ey) - 12,
            active ? '#E0F2FE' : col,
            active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.88)',
            'left',
            active
          );
          hitBoxes.push({
            id: cp.id,
            externalId: cp.id,
            zOrder: 'top',
            category: 'chart_pattern',
            label: cp.name,
            x1: Math.min(sx, ex),
            y1: Math.min(sy, ey),
            x2: Math.max(sx, ex),
            y2: Math.max(sy, ey),
          });
        }
      }

      // 11. Candlestick Patterns (Boxes around exact candles)
      for (const pat of snap.candlestickPatterns) {
        const active = isActive(pat.id);
        if (!active && !vis.candlestickPatterns) continue;
        if (!active && !vis.provisional && pat.confirmationStatus === 'provisional') continue;
        const x1Raw = timeToX(pat.startTime);
        const x2Raw = timeToX(pat.endTime);
        const y1 = priceToY(pat.highBound);
        const y2 = priceToY(pat.lowBound);
        if (x1Raw === null || x2Raw === null || y1 === null || y2 === null) continue;

        const padX = active ? 10 : 7;
        const padY = active ? 8 : 4;
        const left = Math.min(x1Raw, x2Raw) - padX;
        const right = Math.max(x1Raw, x2Raw) + padX;
        const top = Math.min(y1, y2) - padY;
        const bot = Math.max(y1, y2) + padY;
        const boxW = Math.max(16, right - left);
        const boxH = Math.max(12, bot - top);

        const col =
          pat.direction === 'bullish'
            ? '#10B981'
            : pat.direction === 'bearish'
              ? '#EF4444'
              : '#F59E0B';
        const fill = active
          ? 'rgba(56, 189, 248, 0.24)'
          : pat.direction === 'bullish'
            ? 'rgba(16, 185, 129, 0.12)'
            : pat.direction === 'bearish'
              ? 'rgba(239, 68, 68, 0.12)'
              : 'rgba(245, 158, 11, 0.12)';

        ctx.save();
        if (active) {
          // Vertical guide spotlight so the candle(s) stand out immediately
          ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
          ctx.fillRect(left, 0, boxW, height);
        }
        ctx.fillStyle = fill;
        ctx.fillRect(left, top, boxW, boxH);
        ctx.strokeStyle = active ? '#38BDF8' : col;
        ctx.lineWidth = active ? 2.5 : 1;
        ctx.strokeRect(left, top, boxW, boxH);
        ctx.restore();

        if (active || pat.qualityScore >= 74) {
          drawLabelNoOverlap(
            active ? `${pat.name} (${pat.direction.toUpperCase()})` : pat.name,
            left,
            pat.direction === 'bullish' ? bot + 12 : top - 12,
            active ? '#E0F2FE' : col,
            active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(11,14,20,0.88)',
            'left',
            active
          );
        }

        hitBoxes.push({
          id: pat.id,
          externalId: pat.id,
          zOrder: 'top',
          category: 'candle_pattern',
          label: pat.name,
          x1: left,
          y1: top,
          x2: left + boxW,
          y2: top + boxH,
        });
      }

      // 12. Institutional BUY / SELL Signal Trade Plans (Entry Zone, SL, TP1, TP2, TP3)
      for (const sig of state.signals ?? []) {
        if (sig.symbol !== snap.symbol) continue;
        const active = isActive(sig.id);
        const isOpen =
          sig.state === 'WATCHING' ||
          sig.state === 'CONFIRMED' ||
          sig.state === 'ACTIVE' ||
          sig.state === 'PARTIAL' ||
          sig.state === 'TP1_HIT' ||
          sig.state === 'TP2_HIT';
        if (!active && (!vis.signals || !isOpen)) continue;
        if (!active && !vis.provisional && sig.state === 'WATCHING') continue;

        const isBuy = sig.direction === 'BUY';
        const xStartRaw = timeToX(sig.candleTime);
        const xStart = Math.max(24, Math.min(width - 140, xStartRaw ?? 24));
        const p = state.precision;

        // Entry Zone Box
        const ezY1 = priceToY(sig.entryZone.upper);
        const ezY2 = priceToY(sig.entryZone.lower);
        const entryY = priceToY(sig.entryPrice);
        if (ezY1 !== null && ezY2 !== null) {
          const top = Math.min(ezY1, ezY2);
          const boxH = Math.max(4, Math.abs(ezY2 - ezY1));
          const ezFill = active
            ? 'rgba(56, 189, 248, 0.22)'
            : isBuy
              ? 'rgba(14, 203, 129, 0.14)'
              : 'rgba(246, 70, 93, 0.14)';
          const ezStroke = active
            ? '#38BDF8'
            : isBuy
              ? 'rgba(14, 203, 129, 0.7)'
              : 'rgba(246, 70, 93, 0.7)';
          ctx.save();
          ctx.fillStyle = ezFill;
          ctx.fillRect(xStart, top, width - xStart, boxH);
          ctx.strokeStyle = ezStroke;
          ctx.lineWidth = active ? 2 : 1;
          if (sig.state === 'WATCHING') ctx.setLineDash([4, 3]);
          ctx.strokeRect(xStart, top, width - xStart, boxH);
          ctx.restore();

          hitBoxes.push({
            id: sig.id,
            externalId: sig.id,
            zOrder: 'top',
            category: 'signal',
            label: `${sig.direction} ${sig.score}/100 (${sig.state})`,
            x1: xStart,
            y1: top - 4,
            x2: width,
            y2: top + boxH + 4,
          });
        }

        if (entryY !== null && entryY >= 0 && entryY <= height) {
          const entryCol = isBuy ? '#0ECB81' : '#F6465D';
          ctx.save();
          ctx.strokeStyle = active ? '#38BDF8' : entryCol;
          ctx.lineWidth = active ? 2 : 1.4;
          if (sig.state === 'WATCHING') ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(xStart, entryY);
          ctx.lineTo(width, entryY);
          ctx.stroke();
          ctx.restore();

          drawLabelNoOverlap(
            `${sig.direction} ENTRY ${sig.entryPrice.toFixed(p)} · ${sig.score}/100 ${sig.state}`,
            width - 6,
            entryY,
            active ? '#E0F2FE' : entryCol,
            'rgba(11, 14, 20, 0.92)',
            'right',
            true
          );
        }

        // Stop-Loss Line
        const slY = priceToY(sig.stopLoss);
        if (slY !== null && slY >= 0 && slY <= height) {
          ctx.save();
          ctx.strokeStyle = '#EF4444';
          ctx.lineWidth = active ? 2 : 1.4;
          ctx.setLineDash([6, 3]);
          ctx.beginPath();
          ctx.moveTo(xStart, slY);
          ctx.lineTo(width, slY);
          ctx.stroke();
          ctx.restore();

          drawLabelNoOverlap(
            `SL ${sig.stopLoss.toFixed(p)}`,
            width - 6,
            slY,
            '#FCA5A5',
            'rgba(11, 14, 20, 0.92)',
            'right',
            active
          );
        }

        // Take-Profit Lines (TP1, TP2, TP3)
        for (const tp of sig.takeProfits) {
          const tpY = priceToY(tp.price);
          if (tpY === null || tpY < 0 || tpY > height) continue;
          const tpCol = tp.hit ? '#38BDF8' : tp.level === 1 ? '#10B981' : tp.level === 2 ? '#34D399' : '#6EE7B7';
          ctx.save();
          ctx.strokeStyle = tpCol;
          ctx.lineWidth = active ? 2 : 1.3;
          ctx.setLineDash(tp.hit ? [] : [5, 3]);
          ctx.beginPath();
          ctx.moveTo(xStart, tpY);
          ctx.lineTo(width, tpY);
          ctx.stroke();
          ctx.restore();

          drawLabelNoOverlap(
            `TP${tp.level}${tp.hit ? ' [HIT]' : ''} ${tp.price.toFixed(p)} (1:${tp.riskReward})`,
            width - 6,
            tpY,
            tpCol,
            'rgba(11, 14, 20, 0.92)',
            'right',
            active
          );
        }
      }

      this.onHitBoxesUpdated(hitBoxes);
    });
  }
}

class OverlayPaneView implements IPrimitivePaneView {
  private readonly rendererImpl: OverlayPaneRenderer;

  constructor(rendererImpl: OverlayPaneRenderer) {
    this.rendererImpl = rendererImpl;
  }

  public zOrder(): 'top' {
    return 'top';
  }

  public renderer(): IPrimitivePaneRenderer {
    return this.rendererImpl;
  }
}

export class TerminalOverlayPrimitive implements ISeriesPrimitive<Time> {
  private state: OverlayState;
  private paneView: OverlayPaneView | null = null;
  private requestUpdate: (() => void) | null = null;
  private hitBoxes: HitBox[] = [];

  constructor(initialState: OverlayState) {
    this.state = initialState;
  }

  public attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
    const renderer = new OverlayPaneRenderer(
      param.chart,
      param.series,
      () => this.state,
      (boxes) => {
        this.hitBoxes = boxes;
      }
    );
    this.paneView = new OverlayPaneView(renderer);
    this.requestUpdate();
  }

  public detached(): void {
    this.requestUpdate = null;
    this.paneView = null;
    this.hitBoxes = [];
  }

  public updateState(next: OverlayState): void {
    this.state = next;
    this.requestUpdate?.();
  }

  public paneViews(): readonly IPrimitivePaneView[] {
    return this.paneView ? [this.paneView] : [];
  }

  public hitTest(x: number, y: number): HitBox | null {
    // Search in reverse order (topmost rendered shapes first)
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const b = this.hitBoxes[i];
      if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) {
        return b;
      }
    }
    return null;
  }
}
