import { RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_TECHNICAL_SETTINGS } from '../../shared/constants/index.ts';
import type { TechnicalSettings } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useTerminal();
  const [draft, setDraft] = useState<TechnicalSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const numField = (
    key: keyof TechnicalSettings,
    label: string,
    min: number,
    max: number,
    step: number
  ) => (
    <label className="flex items-center justify-between gap-4 border-b border-[#1D2432] py-2 text-xs">
      <span className="text-[#C9D1D9]">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft[key] as number}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
        className="w-24 border border-[#222938] bg-[#0B0E14] px-2 py-1 text-right font-mono text-xs text-[#E6EDF3] tabular-nums outline-none focus:border-[#38BDF8]"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col border border-[#2B3548] bg-[#12161F]">
        <div className="flex items-center justify-between border-b border-[#222938] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#E6EDF3]">
              Deterministic Technical Analysis Settings
            </h2>
            <p className="text-xs text-[#8B949E]">
              Applied consistently across all pattern, zone, structure, and monitoring engines
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-[#222938] bg-[#0B0E14] p-1.5 text-[#8B949E] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {numField('swingSensitivity', 'Swing Lookback Sensitivity (bars)', 2, 20, 1)}
          {numField('pivotConfirmationCandles', 'Pivot Confirmation Candles (right bars)', 1, 10, 1)}
          {numField('patternSensitivity', 'Candlestick Pattern Sensitivity (1–10)', 1, 10, 1)}
          {numField('minChartPatternBars', 'Minimum Chart Pattern Size (bars)', 8, 60, 1)}
          {numField('srClusteringAtrMultiplier', 'S/R Clustering Distance (ATR ×)', 0.2, 2.5, 0.05)}
          {numField('zoneTouchToleranceAtr', 'Zone Touch Tolerance (ATR ×)', 0.05, 1.0, 0.05)}
          {numField('fvgMinSizeAtr', 'FVG Minimum Gap Size (ATR ×)', 0.05, 1.5, 0.05)}
          {numField('obMinDisplacementAtr', 'Order Block Min Displacement (ATR ×)', 0.5, 4.0, 0.1)}
          {numField('liquidityToleranceAtr', 'Liquidity Equal H/L Tolerance (ATR ×)', 0.05, 1.0, 0.05)}
          {numField('trendlineMinTouches', 'Trendline Minimum Touches', 2, 5, 1)}
          {numField('volumeFilterMultiplier', 'Volume Filter Multiplier', 0.0, 3.0, 0.1)}

          <label className="flex items-center justify-between gap-4 border-b border-[#1D2432] py-2.5 text-xs">
            <span className="text-[#C9D1D9]">Breakout Confirmation Method</span>
            <select
              value={draft.breakoutConfirmation}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  breakoutConfirmation: e.target.value as 'close' | 'wick',
                }))
              }
              className="border border-[#222938] bg-[#0B0E14] px-2 py-1 font-mono text-xs text-[#E6EDF3] outline-none cursor-pointer"
            >
              <option value="close">Candle Close</option>
              <option value="wick">Wick Penetration</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-4 border-b border-[#1D2432] py-2.5 text-xs cursor-pointer">
            <span className="text-[#C9D1D9]">Require OB Displacement</span>
            <input
              type="checkbox"
              checked={draft.obRequireDisplacement}
              onChange={(e) =>
                setDraft((d) => ({ ...d, obRequireDisplacement: e.target.checked }))
              }
              className="accent-[#38BDF8]"
            />
          </label>

          <label className="flex items-center justify-between gap-4 py-2.5 text-xs cursor-pointer">
            <span className="text-[#C9D1D9]">Show Provisional Unconfirmed Detections</span>
            <input
              type="checkbox"
              checked={draft.showProvisional}
              onChange={(e) =>
                setDraft((d) => ({ ...d, showProvisional: e.target.checked }))
              }
              className="accent-[#38BDF8]"
            />
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-[#222938] px-4 py-3">
          <button
            type="button"
            onClick={() => setDraft({ ...DEFAULT_TECHNICAL_SETTINGS })}
            className="flex items-center gap-1.5 border border-[#222938] bg-[#0B0E14] px-3 py-1.5 text-xs text-[#8B949E] hover:text-white cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-[#222938] bg-[#0B0E14] px-3.5 py-1.5 text-xs text-[#C9D1D9] hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-[#38BDF8] px-4 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#7DD3FC] cursor-pointer"
            >
              {saving ? 'Applying...' : 'Apply Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
