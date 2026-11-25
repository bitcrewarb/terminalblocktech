import { HelpCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface TermExplanation {
  term: string;
  simpleName: string;
  explanation: string;
}

export const DISCOVERY_GLOSSARY: Record<string, TermExplanation> = {
  is: {
    term: 'In-Sample (IS)',
    simpleName: 'Training Period (First 50%)',
    explanation:
      'The older half of price history used as a baseline check to see how the strategy behaves initially.',
  },
  oos: {
    term: 'Out-of-Sample (OOS)',
    simpleName: 'Unseen Test Period (Next 25%)',
    explanation:
      'Newer price data kept separate from the baseline. Performing well here proves the strategy works on fresh data rather than just getting lucky in the past.',
  },
  oosScore: {
    term: 'Test Score (OOS)',
    simpleName: 'Overall Quality Score (0–100)',
    explanation:
      'A combined 0 to 100 rating measuring profit, average reward per trade, time consistency, win rate, and safety on unseen test data.',
  },
  oosExp: {
    term: 'Avg Profit / Trade (R)',
    simpleName: 'Average Return per Risk Unit',
    explanation:
      'Your average gain or loss per trade measured against 1 risk unit (1R). For example, +0.40R means each trade averages +0.40× your stop-loss risk.',
  },
  riskReward: {
    term: 'Risk : Reward Ratio (1 : X)',
    simpleName: 'Average Win Size vs Average Loss Size',
    explanation:
      'Shows how much your winning trades earn compared to losing trades. 1 : 2.0 means when a loss is -1, your average win is +2.',
  },
  oosPf: {
    term: 'Profit Factor',
    simpleName: 'Total Wins ÷ Total Losses',
    explanation:
      'Total profit from winning trades divided by total loss from losing trades. 1.00 = breakeven, 1.50+ = solid, 2.00+ = very strong.',
  },
  oosRet: {
    term: 'Test Profit %',
    simpleName: 'Net Account Growth %',
    explanation:
      'Total percentage account growth earned during the Unseen Test after fees and slippage.',
  },
  winRate: {
    term: 'Win Rate %',
    simpleName: 'Winning Trades Percentage',
    explanation:
      'Out of every 100 trades taken, how many closed in profit (e.g. 8 Won / 9 Lost = 47% Win Rate).',
  },
  maxDd: {
    term: 'Max Drop (Drawdown)',
    simpleName: 'Worst Peak-to-Bottom Dip',
    explanation:
      'The biggest drop from a high balance to a low balance during the test. Smaller % means smoother, safer growth.',
  },
  tradesCount: {
    term: 'Trades (Older / Test)',
    simpleName: 'Number of Completed Trades',
    explanation:
      'How many trades happened in Older Past vs Unseen Test. More trades means more reliable proof.',
  },
  wfCons: {
    term: 'Consistency Across Time',
    simpleName: 'Walk-Forward Windows Won',
    explanation:
      'Splits history into 4 separate time windows and checks how many stayed profitable. High % means it works steadily over time, not just one lucky week.',
  },
  holdout: {
    term: 'Final Proof (Holdout)',
    simpleName: 'Locked Newest 25% of Candles',
    explanation:
      'The newest 25% of candles kept locked away while picking winners. If a strategy stays profitable here too, it is truly Production Ready.',
  },
  regime: {
    term: 'Market Condition',
    simpleName: 'Market Regime',
    explanation:
      'What the market is doing when the trade opens: Trending (strong direction), Ranging (sideways), High Volatility (big swings), Low Volatility (quiet), or Transitional (shifting).',
  },
  validation: {
    term: 'Trust Level',
    simpleName: 'Validation Status',
    explanation:
      'Verified Winner = passed every test & consistency rule. Promising = profitable, needs a bit more data. Too Few Trades = sample too small. Failed Test = lost money on unseen data.',
  },
  costs: {
    term: 'Fees / Slippage (bps)',
    simpleName: 'Realistic Trading Costs',
    explanation:
      'Broker fees and price slippage in basis points (10 bps = 0.10%). Subtracted from every simulated trade.',
  },
  minRrSample: {
    term: 'Min R:R / Min Test Trades',
    simpleName: 'Target & Sample Rules',
    explanation:
      'Min R:R = minimum reward-to-risk ratio required for a trade. Min Test Trades = minimum unseen test trades needed before a strategy can be marked Verified.',
  },
  sharpe: {
    term: 'Smoothness Score (Sharpe)',
    simpleName: 'Return vs Risk Bumps',
    explanation:
      'Measures how smoothly profits grew compared to daily ups and downs. Above 1.0 is good, above 2.0 is very smooth.',
  },
  sessionTime: {
    term: 'Best Trading Time (UTC Session)',
    simpleName: 'Time-of-Day Session Edge',
    explanation:
      'Breaks trades into 5 global market sessions (Asian, London Open, London/NY Overlap, NY Afternoon, Rollover) using pre-holdout data so you know which hours to trade and which hours to avoid.',
  },
  edgeConfidence: {
    term: 'Edge Confidence %',
    simpleName: 'Statistical Certainty (Not Luck)',
    explanation:
      'Calculates from pre-holdout trade R-multiples how likely the strategy average profit is truly positive rather than random luck. 85%+ with 8+ trades is strong.',
  },
  productionReadiness: {
    term: 'Production Readiness',
    simpleName: 'Survived Every Test Including Final Check',
    explanation:
      'Production Ready = Verified Winner that ALSO stayed profitable in the untouched Final Check. Overfit / Decayed = looked good in test but lost money in Final Check — skip these.',
  },
};

export function HintBadge({
  termKey,
  align = 'center',
}: {
  termKey: keyof typeof DISCOVERY_GLOSSARY;
  align?: 'left' | 'center' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const info = DISCOVERY_GLOSSARY[termKey];

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const tooltipW = 264;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

      let left =
        align === 'left'
          ? rect.left
          : align === 'right'
            ? rect.right - tooltipW
            : rect.left + rect.width / 2 - tooltipW / 2;

      left = Math.max(12, Math.min(left, vw - tooltipW - 12));
      const preferAbove = rect.bottom + 150 > vh && rect.top > 150;
      const top = preferAbove ? Math.max(12, rect.top - 132) : rect.bottom + 6;
      setCoords({ top, left });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, align]);

  if (!info) return null;

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Explain ${info.term}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center text-[#8B949E] hover:text-[#38BDF8] cursor-pointer focus:outline-none"
      >
        <HelpCircle className="h-3 w-3" />
      </button>

      {open && coords && (
        <div
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          style={{ top: coords.top, left: coords.left, width: 264 }}
          className="fixed z-[80] border border-[#30363D] bg-[#0B0E14] p-2.5 text-left shadow-2xl normal-case tracking-normal font-sans pointer-events-none"
        >
          <div className="text-[11px] font-semibold text-[#38BDF8]">{info.term}</div>
          <div className="text-[10px] font-medium text-[#E6EDF3] mt-0.5">{info.simpleName}</div>
          <div className="mt-1 text-[11px] leading-snug text-[#C9D1D9] font-normal">
            {info.explanation}
          </div>
        </div>
      )}
    </span>
  );
}

export function SimpleValidationLabel(status: string): string {
  switch (status) {
    case 'Validated':
      return 'Verified Winner';
    case 'Preliminary Candidate':
      return 'Promising';
    case 'Insufficient Evidence':
      return 'Too Few Trades';
    case 'Failed Validation':
      return 'Failed Test';
    default:
      return status;
  }
}

export {
  deriveProductionAudit,
  type ProductionAuditInput,
  type ProductionAuditOutput,
} from '../../shared/production-audit.ts';

export function formatRiskRewardRatio(metrics: {
  trades: number;
  wins: number;
  losses: number;
  profitFactor: number | null;
  expectancyR: number;
  avgWinR?: number;
  avgLossR?: number;
  rewardToRiskRatio?: number;
}): {
  ratioText: string;
  ratioValue: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
} {
  if (metrics.trades === 0) {
    return { ratioText: '—', ratioValue: null, avgWinR: null, avgLossR: null };
  }
  if (
    typeof metrics.rewardToRiskRatio === 'number' &&
    metrics.rewardToRiskRatio > 0 &&
    typeof metrics.avgWinR === 'number' &&
    typeof metrics.avgLossR === 'number'
  ) {
    if (metrics.losses === 0 && metrics.wins > 0) {
      return {
        ratioText: `1 : ${metrics.avgWinR.toFixed(1)} (All Wins)`,
        ratioValue: metrics.avgWinR,
        avgWinR: metrics.avgWinR,
        avgLossR: 0,
      };
    }
    return {
      ratioText: `1 : ${metrics.rewardToRiskRatio.toFixed(2)}`,
      ratioValue: metrics.rewardToRiskRatio,
      avgWinR: metrics.avgWinR,
      avgLossR: metrics.avgLossR,
    };
  }

  if (metrics.wins > 0 && metrics.losses === 0) {
    const estWin = Math.max(0.1, metrics.expectancyR);
    return {
      ratioText: `1 : ${estWin.toFixed(1)} (All Wins)`,
      ratioValue: estWin,
      avgWinR: estWin,
      avgLossR: 0,
    };
  }

  if (metrics.wins === 0) {
    return { ratioText: '0 : 1', ratioValue: 0, avgWinR: 0, avgLossR: 1 };
  }

  if (metrics.profitFactor !== null && metrics.profitFactor > 0) {
    const payoff = Math.round(metrics.profitFactor * (metrics.losses / metrics.wins) * 100) / 100;
    return {
      ratioText: `1 : ${payoff.toFixed(2)}`,
      ratioValue: payoff,
      avgWinR: null,
      avgLossR: null,
    };
  }

  return { ratioText: '—', ratioValue: null, avgWinR: null, avgLossR: null };
}


