import type {
  AnalysisSnapshot,
  InstrumentSymbol,
  LiveQuote,
  ProviderStatus,
  SignalDirection,
  SignalHtfBiasSummary,
  SignalScoreBreakdown,
  SignalSettings,
  SignalTakeProfit,
  Timeframe,
} from '../shared/types/index.ts';

export interface SignalGenerationInput {
  symbol: InstrumentSymbol;
  snapshots: Partial<Record<Timeframe, AnalysisSnapshot | null>>;
  quote: LiveQuote | null;
  providerStatus: ProviderStatus | null;
  settings?: SignalSettings;
  nowMs?: number;
}

export interface TradePlanResult {
  valid: boolean;
  entryPrice: number;
  entryZone: { lower: number; upper: number };
  stopLoss: number;
  invalidationLevel: number;
  atrBuffer: number;
  takeProfits: SignalTakeProfit[];
  primaryRR: number;
  maxRR: number;
  rejectionReason?: string;
  planNotes: string[];
}

export interface DirectionalCandidate {
  direction: SignalDirection;
  preRiskScoreBreakdown: SignalScoreBreakdown;
  finalScoreBreakdown: SignalScoreBreakdown;
  tradePlan: TradePlanResult;
  hasLiquiditySweep: boolean;
  hasStructuralConfirmation: boolean;
  hasClosedCandleConfirmation: boolean;
  hasConfluenceZone: boolean;
  hasStrongConflict: boolean;
  conflictReasons: string[];
  confluenceReasons: string[];
  anchorCandleTime: number;
  htfBias: SignalHtfBiasSummary;
}

export interface ValidationOutcome {
  accepted: boolean;
  provisionalOnly: boolean;
  rejectionReasons: string[];
}
