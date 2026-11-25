import { ChevronDown, ChevronRight, RefreshCw, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SmcSignalCriteriaConfig } from '../../shared/types/index.ts';
import { useTerminal } from '../state/terminal-context.tsx';

type SmcCriterionKey = keyof SmcSignalCriteriaConfig;

interface CriterionDescriptor {
  key: SmcCriterionKey;
  label: string;
  shortLabel: string;
  description: string;
  liveSummary: string;
  availableCount: number;
}

export function SignalConfigurationPanel({
  variant = 'sidebar',
  onOpenSignalCenter,
  onOpenSignalFilters,
}: {
  variant?: 'sidebar' | 'inline';
  onOpenSignalCenter?: () => void;
  onOpenSignalFilters?: () => void;
}) {
  const {
    symbol,
    timeframe,
    snapshot,
    signalSettings,
    updateSignalSettings,
    evaluateSignals,
    evaluatingSignals,
  } = useTerminal();

  const [isOpen, setIsOpen] = useState(true);
  const [savingKey, setSavingKey] = useState<SmcCriterionKey | 'reset' | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const smcCriteria: SmcSignalCriteriaConfig = signalSettings.smcCriteria ?? {
    requireOrderBlock: false,
    requireFairValueGap: false,
    requireLiquiditySweep: false,
  };

  const liveCounts = useMemo(() => {
    const validObs = (snapshot?.orderBlocks ?? []).filter(
      (ob) => ob.valid && ob.mitigated !== true
    );
    const bullOb = validObs.filter(
      (ob) => ob.kind === 'bullish_ob' || ob.kind === 'breaker_block'
    ).length;
    const bearOb = validObs.filter(
      (ob) => ob.kind === 'bearish_ob' || ob.kind === 'breaker_block'
    ).length;

    const activeFvgs = (snapshot?.fairValueGaps ?? []).filter(
      (f) =>
        f.status !== 'fully_filled' &&
        f.status !== 'inverted' &&
        (f.kind === 'bullish_fvg' || f.kind === 'bearish_fvg')
    );
    const bullFvg = activeFvgs.filter((f) => f.kind === 'bullish_fvg').length;
    const bearFvg = activeFvgs.filter((f) => f.kind === 'bearish_fvg').length;

    const sweptPools = (snapshot?.liquidityPools ?? []).filter(
      (l) => l.swept === true && l.sweepTime !== null
    );
    const sslSwept = sweptPools.filter(
      (l) =>
        l.kind === 'sell_side' ||
        l.kind === 'equal_lows' ||
        l.kind === 'pdl' ||
        l.kind === 'pwl' ||
        l.label.toLowerCase().includes('low') ||
        l.label.toLowerCase().includes('ssl')
    ).length;
    const bslSwept = sweptPools.filter(
      (l) =>
        l.kind === 'buy_side' ||
        l.kind === 'equal_highs' ||
        l.kind === 'pdh' ||
        l.kind === 'pwh' ||
        l.label.toLowerCase().includes('high') ||
        l.label.toLowerCase().includes('bsl')
    ).length;

    return {
      obTotal: validObs.length,
      obText: `${validObs.length} valid (${bullOb} Bull · ${bearOb} Bear)`,
      fvgTotal: activeFvgs.length,
      fvgText: `${activeFvgs.length} active (${bullFvg} Bull · ${bearFvg} Bear)`,
      sweepTotal: sweptPools.length,
      sweepText: `${sweptPools.length} swept (${sslSwept} SSL · ${bslSwept} BSL)`,
    };
  }, [snapshot]);

  const criteriaItems: CriterionDescriptor[] = [
    {
      key: 'requireOrderBlock',
      label: 'Order Blocks',
      shortLabel: 'Order Block',
      description: 'Require a valid unmitigated directional OB before BUY/SELL triggers.',
      liveSummary: snapshot ? `${timeframe}: ${liveCounts.obText}` : 'Syncing snapshot...',
      availableCount: liveCounts.obTotal,
    },
    {
      key: 'requireFairValueGap',
      label: 'Fair Value Gaps',
      shortLabel: 'Fair Value Gap',
      description: 'Require an unfilled or partial directional FVG before BUY/SELL triggers.',
      liveSummary: snapshot ? `${timeframe}: ${liveCounts.fvgText}` : 'Syncing snapshot...',
      availableCount: liveCounts.fvgTotal,
    },
    {
      key: 'requireLiquiditySweep',
      label: 'Liquidity Sweeps',
      shortLabel: 'Liquidity Sweep',
      description: 'Require a recent opposing SSL/BSL sweep before BUY/SELL triggers.',
      liveSummary: snapshot ? `${timeframe}: ${liveCounts.sweepText}` : 'Syncing snapshot...',
      availableCount: liveCounts.sweepTotal,
    },
  ];

  const activeNames = criteriaItems
    .filter((item) => smcCriteria[item.key])
    .map((item) => item.shortLabel);
  const activeCount = activeNames.length;

  const handleToggle = async (key: SmcCriterionKey) => {
    setSavingKey(key);
    setErrorText(null);
    const nextCriteria: SmcSignalCriteriaConfig = {
      ...smcCriteria,
      [key]: !smcCriteria[key],
    };
    try {
      await updateSignalSettings({ smcCriteria: nextCriteria });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Unable to save Signal Configuration.');
    } finally {
      setSavingKey(null);
    }
  };

  const handleReset = async () => {
    setSavingKey('reset');
    setErrorText(null);
    try {
      await updateSignalSettings({
        smcCriteria: {
          requireOrderBlock: false,
          requireFairValueGap: false,
          requireLiquiditySweep: false,
        },
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Unable to reset SMC criteria.');
    } finally {
      setSavingKey(null);
    }
  };

  const renderSwitch = (checked: boolean, busy: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Toggle ${label} pre-trigger requirement`}
      disabled={busy}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center border transition-colors cursor-pointer disabled:opacity-50 ${
        checked
          ? 'border-[#0ECB81] bg-[#0ECB81]/20'
          : 'border-[#2B3548] bg-[#0B0E14] hover:border-[#38BDF8]'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transition-transform ${
          checked ? 'translate-x-[18px] bg-[#0ECB81]' : 'translate-x-[2px] bg-[#6E7681]'
        }`}
      />
    </button>
  );

  if (variant === 'inline') {
    return (
      <section
        aria-label="Signal Configuration"
        className="border border-[#222938] bg-[#12161F] p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1D2432] pb-3">
          <div>
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#38BDF8] shrink-0" />
              <h2 className="text-xs font-semibold text-[#E6EDF3]">Pre-Trigger SMC Signal Gates</h2>
              <span className="font-mono text-[11px] text-[#8B949E] tabular-nums">
                · {activeCount}/3 Gates Active
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[#8B949E]">
              Toggle required Smart Money Concepts criteria that must align before any BUY/SELL signal triggers.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onOpenSignalFilters && (
              <button
                type="button"
                onClick={onOpenSignalFilters}
                className="border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Filter Strategies
              </button>
            )}
            {activeCount > 0 && (
              <button
                type="button"
                disabled={savingKey !== null}
                onClick={() => void handleReset()}
                className="flex items-center gap-1 border border-[#222938] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#E6EDF3] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Clear Gates</span>
              </button>
            )}
            <button
              type="button"
              disabled={evaluatingSignals}
              onClick={() => void evaluateSignals()}
              className="flex items-center gap-1.5 border border-[#2B3548] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${evaluatingSignals ? 'animate-spin' : ''}`} />
              <span>{evaluatingSignals ? 'Scanning...' : 'Apply & Scan'}</span>
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {criteriaItems.map((item) => {
            const enabled = smcCriteria[item.key];
            const busy = savingKey === item.key || savingKey === 'reset';
            return (
              <div
                key={item.key}
                className={`flex flex-col justify-between border p-3 transition-colors ${
                  enabled
                    ? 'border-[#0ECB81]/60 bg-[#0ECB81]/5'
                    : 'border-[#1D2432] bg-[#0B0E14]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-[#E6EDF3]">{item.label}</div>
                    <p className="mt-1 text-[11px] leading-snug text-[#8B949E]">
                      {item.description}
                    </p>
                  </div>
                  {renderSwitch(enabled, busy, item.label, () => void handleToggle(item.key))}
                </div>

                <div className="mt-2.5 flex items-center justify-between border-t border-[#1D2432] pt-2 font-mono text-[10px] tabular-nums">
                  <span className={enabled ? 'font-semibold text-[#0ECB81]' : 'text-[#8B949E]'}>
                    {enabled ? 'REQUIRED' : 'OPTIONAL'}
                  </span>
                  <span className="text-[#C9D1D9] truncate ml-2">
                    {symbol} {item.liveSummary}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {errorText && (
          <div className="mt-2.5 border border-[#F6465D]/50 bg-[#F6465D]/10 px-3 py-1.5 text-[11px] text-[#F6465D]">
            {errorText}
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Signal Configuration"
      className="border-b border-[#222938] bg-[#12161F]"
    >
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between border-b border-[#222938] bg-[#161B26] px-3 py-2 text-left text-xs font-semibold text-[#E6EDF3] hover:bg-[#1C2331] cursor-pointer"
      >
        <span className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-[#8B949E]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[#8B949E]" />
          )}
          <SlidersHorizontal className="h-3 w-3 text-[#38BDF8]" />
          <span>Signal Configuration</span>
        </span>
        <span
          className={`font-mono text-[11px] tabular-nums ${
            activeCount > 0 ? 'font-semibold text-[#0ECB81]' : 'font-normal text-[#8B949E]'
          }`}
        >
          {activeCount > 0 ? `${activeCount}/3 Required` : '0/3 Gates'}
        </span>
      </button>

      {isOpen && (
        <div className="divide-y divide-[#1D2432] bg-[#0B0E14]/40">
          <div className="px-3 py-2 text-[11px] text-[#8B949E]">
            Pre-trigger SMC gates enforced before BUY/SELL signals fire:
          </div>

          {criteriaItems.map((item) => {
            const enabled = smcCriteria[item.key];
            const busy = savingKey === item.key || savingKey === 'reset';
            return (
              <div
                key={item.key}
                className={`flex items-start justify-between gap-2.5 px-3 py-2.5 transition-colors ${
                  enabled ? 'bg-[#0ECB81]/5' : 'hover:bg-[#161B26]/60'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[#E6EDF3]">{item.label}</span>
                    <span
                      className={`font-mono text-[10px] tabular-nums ${
                        enabled ? 'text-[#0ECB81]' : 'text-[#6E7681]'
                      }`}
                    >
                      · {enabled ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] leading-snug text-[#8B949E]">
                    {item.description}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[#C9D1D9] tabular-nums">
                    {item.liveSummary}
                  </div>
                </div>

                <div className="pt-0.5">
                  {renderSwitch(enabled, busy, item.label, () => void handleToggle(item.key))}
                </div>
              </div>
            );
          })}

          {errorText && (
            <div className="bg-[#F6465D]/10 px-3 py-1.5 text-[11px] text-[#F6465D]">
              {errorText}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 bg-[#12161F] px-3 py-2">
            <div className="min-w-0 truncate font-mono text-[10px] text-[#8B949E] tabular-nums">
              {activeCount > 0 ? `Gate: ${activeNames.join(' + ')}` : 'Gate: Strategy / Score Default'}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {activeCount > 0 && (
                <button
                  type="button"
                  disabled={savingKey !== null}
                  onClick={() => void handleReset()}
                  title="Clear SMC pre-trigger filters"
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#E6EDF3] cursor-pointer disabled:opacity-50"
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                disabled={evaluatingSignals}
                onClick={() => void evaluateSignals(symbol)}
                className="border border-[#2B3548] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#38BDF8] hover:border-[#38BDF8] cursor-pointer disabled:opacity-50"
              >
                {evaluatingSignals ? 'Scanning...' : 'Scan'}
              </button>
              {onOpenSignalCenter && (
                <button
                  type="button"
                  onClick={onOpenSignalCenter}
                  className="border border-[#222938] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#C9D1D9] hover:border-[#38BDF8] hover:text-white cursor-pointer"
                >
                  Rules
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
