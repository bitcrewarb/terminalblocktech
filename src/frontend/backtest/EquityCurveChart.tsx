import { useMemo, useState } from 'react';
import type { BacktestEquityPoint, BacktestStrategyResult } from '../../shared/types/index.ts';

const COMPARE_COLORS = [
  '#0ECB81',
  '#38BDF8',
  '#F59E0B',
  '#A78BFA',
  '#FB7185',
];

export function EquityCurveChart({
  selectedResult,
  allResults,
  initialCapital,
  timezone,
}: {
  selectedResult: BacktestStrategyResult;
  allResults: BacktestStrategyResult[];
  initialCapital: number;
  timezone: string;
}) {
  const [compareMode, setCompareMode] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const primaryCurve = selectedResult.equityCurve;
  const topCompare = useMemo(
    () =>
      allResults
        .filter((r) => r.equityCurve.length >= 2 && r.metrics.totalTrades > 0)
        .slice(0, 5),
    [allResults]
  );

  const activeSeriesList = useMemo(() => {
    if (!compareMode || topCompare.length <= 1) {
      return [
        {
          id: selectedResult.strategy.id,
          name: selectedResult.strategy.name,
          color:
            selectedResult.metrics.netProfit >= 0 ? '#0ECB81' : '#F6465D',
          curve: primaryCurve,
        },
      ];
    }
    return topCompare.map((r, idx) => ({
      id: r.strategy.id,
      name: r.strategy.name,
      color: COMPARE_COLORS[idx % COMPARE_COLORS.length],
      curve: r.equityCurve,
    }));
  }, [compareMode, topCompare, selectedResult, primaryCurve]);

  const { minEq, maxEq, maxDd, maxLen } = useMemo(() => {
    let lo = initialCapital;
    let hi = initialCapital;
    let ddMax = 1;
    let longest = 2;
    for (const s of activeSeriesList) {
      longest = Math.max(longest, s.curve.length);
      for (const pt of s.curve) {
        if (pt.equity < lo) lo = pt.equity;
        if (pt.equity > hi) hi = pt.equity;
        if (pt.drawdownPercent > ddMax) ddMax = pt.drawdownPercent;
      }
    }
    const pad = Math.max((hi - lo) * 0.12, initialCapital * 0.01);
    return {
      minEq: Math.max(0, lo - pad),
      maxEq: hi + pad,
      maxDd: Math.max(2, Math.ceil(ddMax * 1.15)),
      maxLen: longest,
    };
  }, [activeSeriesList, initialCapital]);

  const width = 920;
  const eqHeight = 200;
  const ddHeight = 68;
  const padL = 68;
  const padR = 16;
  const padT = 14;
  const eqBottom = padT + eqHeight;
  const ddTop = eqBottom + 18;
  const ddBottom = ddTop + ddHeight;
  const plotW = width - padL - padR;

  const toX = (idx: number, total: number) => {
    if (total <= 1) return padL;
    return padL + (idx / (total - 1)) * plotW;
  };
  const toEqY = (eq: number) => {
    const span = Math.max(1e-6, maxEq - minEq);
    return eqBottom - ((eq - minEq) / span) * eqHeight;
  };
  const toDdY = (ddPct: number) => {
    const ratio = Math.min(1, Math.max(0, ddPct / maxDd));
    return ddTop + ratio * ddHeight;
  };

  const buildLinePath = (curve: BacktestEquityPoint[]) => {
    if (curve.length === 0) return '';
    return curve
      .map((pt, idx) => {
        const x = toX(idx, curve.length).toFixed(1);
        const y = toEqY(pt.equity).toFixed(1);
        return `${idx === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
  };

  const buildAreaPath = (curve: BacktestEquityPoint[]) => {
    if (curve.length === 0) return '';
    const line = buildLinePath(curve);
    const lastX = toX(curve.length - 1, curve.length).toFixed(1);
    const firstX = toX(0, curve.length).toFixed(1);
    return `${line} L${lastX},${eqBottom} L${firstX},${eqBottom} Z`;
  };

  const buildDdPath = (curve: BacktestEquityPoint[]) => {
    if (curve.length === 0) return '';
    const topLine = curve
      .map((pt, idx) => {
        const x = toX(idx, curve.length).toFixed(1);
        const y = toDdY(pt.drawdownPercent).toFixed(1);
        return `${idx === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
    const lastX = toX(curve.length - 1, curve.length).toFixed(1);
    const firstX = toX(0, curve.length).toFixed(1);
    return `${topLine} L${lastX},${ddTop} L${firstX},${ddTop} Z`;
  };

  const fmtTime = (sec: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(sec * 1000));

  const inspectedIdx =
    hoverIdx !== null
      ? Math.min(primaryCurve.length - 1, Math.max(0, hoverIdx))
      : primaryCurve.length - 1;
  const inspectedPt = primaryCurve[inspectedIdx];

  const baseLineY = toEqY(initialCapital);
  const yTicks = [maxEq, (maxEq + minEq) / 2, minEq];

  return (
    <div className="border border-[#222938] bg-[#0B0E14] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold text-[#E6EDF3]">Equity & Drawdown Curve</span>
          {inspectedPt && (
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums text-[#8B949E]">
              <span>{fmtTime(inspectedPt.time)}</span>
              <span>
                Equity:{' '}
                <strong className="text-[#E6EDF3]">
                  ${inspectedPt.equity.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </strong>
              </span>
              <span>
                Return:{' '}
                <strong
                  className={
                    inspectedPt.equity >= initialCapital ? 'text-[#0ECB81]' : 'text-[#F6465D]'
                  }
                >
                  {inspectedPt.equity >= initialCapital ? '+' : ''}
                  {(((inspectedPt.equity - initialCapital) / Math.max(1, initialCapital)) * 100).toFixed(2)}%
                </strong>
              </span>
              <span>
                DD:{' '}
                <strong className="text-[#F6465D]">
                  -{inspectedPt.drawdownPercent.toFixed(2)}%
                </strong>
              </span>
            </div>
          )}
        </div>

        {topCompare.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCompareMode(false)}
              className={`border px-2 py-0.5 text-[11px] cursor-pointer ${
                !compareMode
                  ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                  : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
              }`}
            >
              Selected Only
            </button>
            <button
              type="button"
              onClick={() => setCompareMode(true)}
              className={`border px-2 py-0.5 text-[11px] cursor-pointer ${
                compareMode
                  ? 'border-[#38BDF8] bg-[#161B26] text-[#38BDF8]'
                  : 'border-[#222938] bg-[#12161F] text-[#8B949E] hover:text-white'
              }`}
            >
              Overlay Top {topCompare.length}
            </button>
          </div>
        )}
      </div>

      {compareMode && activeSeriesList.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px]">
          {activeSeriesList.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-[#C9D1D9]">
              <span className="inline-block h-2 w-3" style={{ backgroundColor: s.color }} />
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}

      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${ddBottom + 18}`}
          className="h-auto w-full select-none"
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            if (primaryCurve.length <= 1) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
            const ratio = Math.min(1, Math.max(0, (relX - padL) / plotW));
            setHoverIdx(Math.round(ratio * (primaryCurve.length - 1)));
          }}
        >
          <defs>
            <linearGradient id="btEqFillGreen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ECB81" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#0ECB81" stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id="btEqFillRed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F6465D" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#F6465D" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal grid ticks */}
          {yTicks.map((val, i) => {
            const y = toEqY(val);
            return (
              <g key={i}>
                <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#1B2230" strokeWidth="1" />
                <text
                  x={padL - 8}
                  y={y + 3}
                  textAnchor="end"
                  fill="#6E7681"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  ${Math.round(val).toLocaleString('en-US')}
                </text>
              </g>
            );
          })}

          {/* Initial Capital baseline */}
          <line
            x1={padL}
            y1={baseLineY}
            x2={width - padR}
            y2={baseLineY}
            stroke="#3B475E"
            strokeDasharray="4 4"
            strokeWidth="1"
          />

          {/* Single-strategy fill */}
          {!compareMode && primaryCurve.length >= 2 && (
            <path
              d={buildAreaPath(primaryCurve)}
              fill={
                selectedResult.metrics.netProfit >= 0
                  ? 'url(#btEqFillGreen)'
                  : 'url(#btEqFillRed)'
              }
            />
          )}

          {/* Equity curves */}
          {activeSeriesList.map((s) => (
            <path
              key={s.id}
              d={buildLinePath(s.curve)}
              fill="none"
              stroke={s.color}
              strokeWidth={compareMode ? 1.75 : 2.1}
            />
          ))}

          {/* Drawdown separator & label */}
          <line x1={padL} y1={ddTop} x2={width - padR} y2={ddTop} stroke="#222938" strokeWidth="1" />
          <line
            x1={padL}
            y1={ddBottom}
            x2={width - padR}
            y2={ddBottom}
            stroke="#1B2230"
            strokeWidth="1"
          />
          <text
            x={padL - 8}
            y={ddTop + 10}
            textAnchor="end"
            fill="#6E7681"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            DD 0%
          </text>
          <text
            x={padL - 8}
            y={ddBottom}
            textAnchor="end"
            fill="#F6465D"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            -{maxDd}%
          </text>

          {/* Selected strategy drawdown area */}
          {primaryCurve.length >= 2 && (
            <path d={buildDdPath(primaryCurve)} fill="#F6465D" fillOpacity="0.25" />
          )}

          {/* Hover crosshair */}
          {hoverIdx !== null && inspectedPt && maxLen > 1 && (
            <g>
              <line
                x1={toX(inspectedIdx, primaryCurve.length)}
                y1={padT}
                x2={toX(inspectedIdx, primaryCurve.length)}
                y2={ddBottom}
                stroke="#38BDF8"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <circle
                cx={toX(inspectedIdx, primaryCurve.length)}
                cy={toEqY(inspectedPt.equity)}
                r="3.5"
                fill="#38BDF8"
              />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
