export type InstrumentSymbol = 'XAUUSD' | 'XAGUSD' | 'BTCUSDT' | 'ETHUSDT';

export type Timeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1H'
  | '2H'
  | '4H'
  | '6H'
  | '12H'
  | '1D'
  | '1W'
  | '1M';

export type AssetClass = 'METALS' | 'CRYPTO';

export type Direction = 'bullish' | 'bearish' | 'neutral';

export type ConnectionStatus =
  | 'CONNECTED'
  | 'CONNECTING'
  | 'RECONNECTING'
  | 'STALE'
  | 'DELAYED'
  | 'CREDENTIALS_REQUIRED'
  | 'ERROR'
  | 'MARKET_CLOSED'
  | 'DISCONNECTED';

export interface Candle {
  /** Unix epoch in seconds (UTC), aligned to timeframe open */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface LiveQuote {
  symbol: InstrumentSymbol;
  price: number;
  bid?: number;
  ask?: number;
  spread?: number;
  change24h: number;
  changePercent24h: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  direction: Direction;
  provider: string;
  feedDelaySeconds: number;
  connectionStatus: ConnectionStatus;
  marketOpen: boolean;
  lastUpdateTime: number; // epoch ms
  providerTimestamp: number; // epoch ms
  stale: boolean;
  errorMessage?: string;
}

export interface ProviderStatus {
  symbol: InstrumentSymbol;
  assetClass: AssetClass;
  providerName: string;
  hasHistoricalCredentials: boolean;
  hasStreamingFeed: boolean;
  connectionStatus: ConnectionStatus;
  lastUpdateTime: number | null;
  feedDelaySeconds: number;
  missingCredentialsReason?: string;
  supportedEnvVars?: string[];
  errorMessage?: string;
}

export interface TechnicalSettings {
  swingSensitivity: number; // left/right pivot lookback (e.g. 5)
  pivotConfirmationCandles: number; // bars required after pivot to confirm (non-repainting)
  patternSensitivity: number; // 1..10 (controls body/wick ratios & tolerances)
  minChartPatternBars: number; // min bars for chart patterns (e.g. 12)
  srClusteringAtrMultiplier: number; // ATR multiplier to merge S/R levels
  zoneTouchToleranceAtr: number; // ATR fraction for Approaching/Near/Touch
  fvgMinSizeAtr: number; // min FVG gap as fraction of ATR
  obRequireDisplacement: boolean;
  obMinDisplacementAtr: number;
  liquidityToleranceAtr: number; // Equal highs/lows tolerance in ATR
  trendlineMinTouches: number;
  breakoutConfirmation: 'close' | 'wick';
  volumeFilterMultiplier: number; // min relative volume for breakouts/OB
  showProvisional: boolean;
}

export type ConfirmationStatus = 'confirmed' | 'provisional' | 'invalidated';

export type TechnicalCategory =
  | 'market_structure'
  | 'candle_pattern'
  | 'chart_pattern'
  | 'support_resistance'
  | 'supply_demand'
  | 'liquidity'
  | 'order_block'
  | 'fvg'
  | 'trendline'
  | 'premium_discount'
  | 'session';

export interface TechnicalLifecycle {
  formationTime: number;
  confirmationTime: number | null;
  detectionTime: number;
  invalidationTime: number | null;
  confirmationStatus: ConfirmationStatus;
}

export interface SwingPoint extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind: 'high' | 'low';
  structureLabel: 'HH' | 'HL' | 'LH' | 'LL' | 'SH' | 'SL';
  scope: 'external' | 'internal';
  price: number;
  candleTime: number;
  candleIndex: number;
}

export interface StructureBreak extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  type: 'BOS' | 'CHoCH' | 'MSS';
  direction: 'bullish' | 'bearish';
  scope: 'external' | 'internal';
  levelPrice: number;
  originTime: number;
  breakTime: number;
  breakMethod: 'close' | 'wick';
  swingPointId: string;
}

export interface MarketStructureState {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  trend: 'bullish' | 'bearish' | 'consolidation';
  internalTrend: 'bullish' | 'bearish' | 'consolidation';
  lastExternalLabel: 'HH' | 'HL' | 'LH' | 'LL' | 'NONE';
  lastInternalLabel: 'HH' | 'HL' | 'LH' | 'LL' | 'NONE';
  swings: SwingPoint[];
  breaks: StructureBreak[];
  currentRangeHigh: number | null;
  currentRangeLow: number | null;
  bosCount?: number;
  chochCount?: number;
}

export type ZoneLifecycleState =
  | 'Far Away'
  | 'Approaching'
  | 'Near'
  | 'Entered Zone'
  | 'Touched'
  | 'Rejected'
  | 'Breaking'
  | 'Confirmed Breakout'
  | 'Retesting'
  | 'Mitigated'
  | 'Invalidated';

export type SRStatus =
  | 'Active'
  | 'Approaching'
  | 'Near'
  | 'Touched'
  | 'Rejected'
  | 'Breaking'
  | 'Broken'
  | 'Retesting'
  | 'Invalidated';

export interface SRZone extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind: 'support' | 'resistance';
  source:
    | 'swing_cluster'
    | 'pivot'
    | 'pdh_pdl'
    | 'pwh_pwl'
    | 'pmh_pml'
    | 'session_hl';
  label: string;
  upper: number;
  lower: number;
  midpoint: number;
  touches: number;
  rejections: number;
  breakouts: number;
  strengthScore: number; // 0..100
  firstDetection: number;
  lastTest: number | null;
  distancePercent: number;
  status: SRStatus;
  interactionState: ZoneLifecycleState;
  touchMethod?: 'wick' | 'close';
  lastTouchPrice?: number;
}

export interface SDZone extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind: 'demand' | 'supply';
  patternType: 'RBR' | 'DBD' | 'RBD' | 'DBR';
  proximal: number;
  distal: number;
  midpoint: number;
  width: number;
  originCandleTime: number;
  departureStrength: number; // ATR multiple
  touches: number;
  mitigationPercent: number; // 0..100
  freshness: 'fresh' | 'tested' | 'partially_mitigated' | 'fully_mitigated' | 'invalidated';
  htfAligned: boolean;
  distancePercent: number;
  interactionState: ZoneLifecycleState;
  lastTouchTime: number | null;
  lastTouchPrice?: number;
}

export interface OrderBlock extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind: 'bullish_ob' | 'bearish_ob' | 'breaker_block' | 'mitigation_block';
  upper: number;
  lower: number;
  midpoint: number;
  originTime: number;
  displacementAtr: number;
  valid: boolean;
  mitigated: boolean;
  mitigationPercent: number;
  touches: number;
  interactionState: ZoneLifecycleState;
}

export interface FairValueGap extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind: 'bullish_fvg' | 'bearish_fvg' | 'inverse_fvg' | 'volume_imbalance' | 'rejection_block';
  upper: number;
  lower: number;
  consequentEncroachment: number; // 50% midpoint
  originTime: number;
  fillPercent: number; // 0..100
  status: 'unfilled' | 'partially_filled' | 'fully_filled' | 'inverted';
  interactionState: ZoneLifecycleState;
}

export interface LiquidityPool extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind:
    | 'buy_side'
    | 'sell_side'
    | 'equal_highs'
    | 'equal_lows'
    | 'internal'
    | 'external'
    | 'inducement'
    | 'pdh'
    | 'pdl'
    | 'pwh'
    | 'pwl';
  label: string;
  price: number;
  upper: number;
  lower: number;
  originTimes: number[];
  swept: boolean;
  sweepTime: number | null;
  sweepType: 'sweep' | 'stop_hunt' | 'liquidity_run' | null;
  interactionState: ZoneLifecycleState;
}

export interface Trendline extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  kind:
    | 'bullish_support'
    | 'bearish_resistance'
    | 'ascending_channel'
    | 'descending_channel'
    | 'parallel_channel';
  p1Time: number;
  p1Price: number;
  p2Time: number;
  p2Price: number;
  channelOffset?: number;
  slopePerSecond: number;
  touches: number;
  touchTimes: number[];
  status: 'confirmed' | 'provisional' | 'broken' | 'retested' | 'invalidated';
  breakoutTime: number | null;
  retestTime: number | null;
  currentProjectedPrice: number;
}

export interface CandlestickPattern extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  name:
    | 'Bullish Engulfing'
    | 'Bearish Engulfing'
    | 'Morning Star'
    | 'Evening Star'
    | 'Hammer'
    | 'Inverted Hammer'
    | 'Shooting Star'
    | 'Hanging Man'
    | 'Doji'
    | 'Dragonfly Doji'
    | 'Gravestone Doji'
    | 'Piercing Pattern'
    | 'Dark Cloud Cover'
    | 'Three White Soldiers'
    | 'Three Black Crows'
    | 'Tweezer Top'
    | 'Tweezer Bottom'
    | 'Inside Bar'
    | 'Outside Bar'
    | 'Marubozu'
    | 'Bullish Harami'
    | 'Bearish Harami';
  category: 'reversal' | 'continuation' | 'indecision';
  direction: Direction;
  startTime: number;
  endTime: number;
  highBound: number;
  lowBound: number;
  formationPrice: number;
  invalidationLevel: number;
  qualityScore: number; // 0..100
  candleTimes: number[];
  description: string;
}

export type ChartPatternStatus = 'Forming' | 'Confirmed' | 'Breakout' | 'Retest' | 'Invalidated';

export interface ChartPatternPoint {
  time: number;
  price: number;
  label?: string;
}

export interface ChartPattern extends TechnicalLifecycle {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  name:
    | 'Head and Shoulders'
    | 'Inverse Head and Shoulders'
    | 'Double Top'
    | 'Double Bottom'
    | 'Triple Top'
    | 'Triple Bottom'
    | 'Ascending Triangle'
    | 'Descending Triangle'
    | 'Symmetrical Triangle'
    | 'Rising Wedge'
    | 'Falling Wedge'
    | 'Bullish Flag'
    | 'Bearish Flag'
    | 'Bullish Pennant'
    | 'Bearish Pennant'
    | 'Rectangle'
    | 'Cup and Handle'
    | 'Rounding Bottom'
    | 'Rounding Top';
  direction: 'bullish' | 'bearish' | 'neutral';
  status: ChartPatternStatus;
  startTime: number;
  endTime: number;
  upperBoundary: ChartPatternPoint[];
  lowerBoundary: ChartPatternPoint[];
  neckline?: ChartPatternPoint[];
  breakoutLevel: number;
  breakoutTime: number | null;
  retestTime: number | null;
  invalidationLevel: number;
  measuredTarget: number | null;
  keyPoints: ChartPatternPoint[];
  qualityScore: number;
}

export interface DealingRange {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  sourceTimeframe: Timeframe;
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number; // 50%
  fib62: number;
  ote705: number; // 70.5%
  fib79: number;
  highTime: number;
  lowTime: number;
  currentPosition: 'premium' | 'discount' | 'equilibrium';
  retracementPercent: number;
  inOteZone: boolean;
}

export interface TradingSessionBox {
  id: string;
  symbol: InstrumentSymbol;
  session: 'Asian' | 'London' | 'New York' | 'London/NY Overlap';
  startTime: number;
  endTime: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  sweptPrevHigh: boolean;
  sweptPrevLow: boolean;
  isActive: boolean;
}

export interface SessionAnchors {
  dailyOpen: number | null;
  dailyOpenTime: number | null;
  weeklyOpen: number | null;
  weeklyOpenTime: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  prevWeekHigh: number | null;
  prevWeekLow: number | null;
  prevMonthHigh: number | null;
  prevMonthLow: number | null;
}

export interface TimeframeAnalysisSummary {
  timeframe: Timeframe;
  available: boolean;
  candleCount: number;
  trend: 'bullish' | 'bearish' | 'consolidation';
  structure: string;
  lastSequence: string;
  bosCount: number;
  chochCount: number;
  mssCount: number;
  activeOrderBlocks: number;
  activeFvgs: number;
  nearestSupport: number | null;
  nearestResistance: number | null;
  nearestDemand: number | null;
  nearestSupply: number | null;
  nearestImportantZone: string;
  liquidityTarget: string;
  premiumDiscount: 'premium' | 'discount' | 'equilibrium' | 'n/a';
  momentum: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  alignment: 'bullish_aligned' | 'bearish_aligned' | 'conflicting' | 'neutral';
  lastUpdated: number;
}

export interface MultiTimeframeSummary {
  symbol: InstrumentSymbol;
  htfBias: 'bullish' | 'bearish' | 'mixed';
  ltfBias: 'bullish' | 'bearish' | 'mixed';
  overallAlignment: 'Bullish Alignment' | 'Bearish Alignment' | 'Conflicting Structures' | 'Neutral';
  potentialReversalCondition: string | null;
  rows: TimeframeAnalysisSummary[];
}

export interface ZoneInteractionEvent {
  id: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  objectId: string;
  objectCategory: TechnicalCategory;
  objectLabel: string;
  currentPrice: number;
  upperBound: number;
  lowerBound: number;
  distancePercent: number;
  status: ZoneLifecycleState;
  touchMethod?: 'wick' | 'close';
  timestamp: number;
}

export type AlertType =
  | 'approaching_support'
  | 'touching_resistance'
  | 'demand_entry'
  | 'supply_entry'
  | 'bullish_bos'
  | 'bearish_bos'
  | 'bullish_choch'
  | 'bearish_choch'
  | 'liquidity_sweep'
  | 'ob_formation'
  | 'fvg_formation'
  | 'pattern_confirmation'
  | 'trendline_breakout'
  | 'htf_alignment';

export interface AlertRule {
  id: string;
  type: AlertType;
  label: string;
  enabled: boolean;
  symbols: InstrumentSymbol[];
  timeframes: Timeframe[];
  distanceThresholdPercent: number;
  browserNotify: boolean;
  soundEnabled: boolean;
}

export interface AlertNotification {
  id: string;
  type: AlertType;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  title: string;
  message: string;
  direction: Direction;
  price: number;
  objectId?: string;
  timestamp: number;
}

export interface AnalysisSnapshot {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  candles: Candle[];
  quote: LiveQuote | null;
  providerStatus: ProviderStatus;
  atr: number;
  marketStructure: MarketStructureState;
  candlestickPatterns: CandlestickPattern[];
  chartPatterns: ChartPattern[];
  supportResistance: SRZone[];
  supplyDemand: SDZone[];
  liquidityPools: LiquidityPool[];
  liquiditySweeps?: any[];
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  trendlines: Trendline[];
  dealingRange: DealingRange | null;
  sessions: TradingSessionBox[];
  sessionAnchors: SessionAnchors;
  zoneInteractions: ZoneInteractionEvent[];
  liveEvents: ZoneInteractionEvent[];
  lastAnalyzedAt: number;
}

export interface ChartVisibilityConfig {
  candlestickPatterns: boolean;
  chartPatterns: boolean;
  supportResistance: boolean;
  supplyDemand: boolean;
  marketStructure: boolean;
  orderBlocks: boolean;
  fairValueGaps: boolean;
  liquidity: boolean;
  liquiditySweeps: boolean;
  trendlines: boolean;
  premiumDiscount: boolean;
  sessions: boolean;
  volume: boolean;
  provisional: boolean;
  signals: boolean;
}

// ============================================================================
// Institutional BUY / SELL Signal System Types
// ============================================================================

export type SignalDirection = 'BUY' | 'SELL';

export type SignalClassification = 'Excellent' | 'Strong' | 'Moderate' | 'No Trade';

export type SignalLifecycleState =
  | 'WATCHING'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'PARTIAL'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'STOPPED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface SignalScoringWeights {
  htfAlignment: number;
  liquiditySweep: number;
  structureConfirmation: number;
  obFvgConfluence: number;
  premiumDiscount: number;
  volumeMomentum: number;
  riskRewardQuality: number;
}

export interface SignalTimeframeConfig {
  majorDirectionTf: Timeframe;
  primaryBiasTf: Timeframe;
  secondaryConfirmTf: Timeframe;
  setupTf: Timeframe;
  entryTf: Timeframe;
  refinementTf: Timeframe;
}

export interface SmcSignalCriteriaConfig {
  requireOrderBlock: boolean;
  requireFairValueGap: boolean;
  requireLiquiditySweep: boolean;
}

export interface SignalSettings {
  enabled: boolean;
  allowDefaultSignals: boolean;
  requireRegimeCompatibility: boolean;
  requireHtfAlignmentForStrategy: boolean;
  minStrategyConfluenceScore: number;
  minConfirmedScore: number;
  minWatchingScore: number;
  minTp1RiskReward: number;
  atrStopBufferMultiplier: number;
  maxWatchingMinutes: number;
  maxPendingConfirmedMinutes: number;
  allowIntrabarWatching: boolean;
  require1HAlignment: boolean;
  require1MRefinement: boolean;
  smcCriteria: SmcSignalCriteriaConfig;
  timeframes: SignalTimeframeConfig;
  weights: SignalScoringWeights;
}

export interface SignalScoreCategory {
  score: number;
  maxScore: number;
  met: boolean;
  detail: string;
}

export interface SignalScoreBreakdown {
  htfAlignment: SignalScoreCategory;
  liquiditySweep: SignalScoreCategory;
  structureConfirmation: SignalScoreCategory;
  obFvgConfluence: SignalScoreCategory;
  premiumDiscount: SignalScoreCategory;
  volumeMomentum: SignalScoreCategory;
  riskRewardQuality: SignalScoreCategory;
  totalScore: number;
  classification: SignalClassification;
}

export interface SignalTakeProfit {
  level: 1 | 2 | 3;
  price: number;
  riskReward: number;
  sourceLabel: string;
  hit: boolean;
  hitTime: number | null;
}

export interface SignalTimelineEvent {
  state: SignalLifecycleState;
  timestamp: number;
  price: number;
  note: string;
}

export interface SignalHtfBiasSummary {
  d1: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
  h4: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
  h1: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
  m15: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
  m5: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
  m1?: 'bullish' | 'bearish' | 'consolidation' | 'unavailable';
}

export interface TradingSignal {
  id: string;
  symbol: InstrumentSymbol;
  entryTimeframe: Timeframe;
  setupTimeframe: Timeframe;
  direction: SignalDirection;
  state: SignalLifecycleState;
  provisional: boolean;
  score: number;
  classification: SignalClassification;
  scoreBreakdown: SignalScoreBreakdown;
  htfBias: SignalHtfBiasSummary;
  entryPrice: number;
  entryZone: {
    lower: number;
    upper: number;
  };
  stopLoss: number;
  invalidationLevel: number;
  atrBuffer: number;
  takeProfits: SignalTakeProfit[];
  primaryRR: number;
  maxRR: number;
  confluenceReasons: string[];
  generationSummary?: string;
  outcomeSummary?: string;
  failureReasons?: string[];
  timeframeSummary: string;
  source?: 'institutional_engine' | 'strategy_basket';
  strategyId?: BacktestStrategyId;
  strategyName?: string;
  strategyCategory?: BacktestStrategyCategory;
  strategyVersion?: string;
  marketRegime?: string;
  createdAt: number;
  confirmedAt: number | null;
  activatedAt: number | null;
  closedAt: number | null;
  candleTime: number;
  realizedR: number | null;
  highestFavorableR: number;
  maxAdverseR: number;
  timeline: SignalTimelineEvent[];
}

export interface SignalEvaluationDiagnostic {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  evaluatedAt: number;
  status: 'SIGNAL_GENERATED' | 'WATCHING_CANDIDATE' | 'NO_TRADE';
  buyScore: number;
  sellScore: number;
  dominantDirection: SignalDirection | 'NEUTRAL';
  rejectionReasons: string[];
  htfBias: SignalHtfBiasSummary;
  signalId?: string;
}

export type SignalNotificationType =
  | 'signal_buy_new'
  | 'signal_sell_new'
  | 'signal_confirmed'
  | 'signal_entry_reached'
  | 'signal_tp_hit'
  | 'signal_sl_hit'
  | 'signal_invalidated';

export interface SignalNotification {
  id: string;
  type: SignalNotificationType;
  signalId: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  state: SignalLifecycleState;
  title: string;
  message: string;
  price: number;
  score: number;
  timestamp: number;
}

export interface SignalInstrumentStats {
  total: number;
  buy: number;
  sell: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
}

export interface SignalTimeframeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
}

export interface SignalPerformanceStats {
  totalSignals: number;
  watchingCount: number;
  activeCount: number;
  closedCount: number;
  buyCount: number;
  sellCount: number;
  winningSignals: number;
  losingSignals: number;
  winRate: number;
  tp1HitRate: number;
  tp2HitRate: number;
  tp3HitRate: number;
  slHitRate: number;
  avgRMultiple: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  byInstrument: Record<InstrumentSymbol, SignalInstrumentStats>;
  byTimeframe: Record<string, SignalTimeframeStats>;
}

export type SignalDeleteScope = 'all' | 'closed' | 'watching';

// ============================================================================
// Multi-Strategy SMC & Price Action Backtesting Types
// ============================================================================

export type BacktestStrategyId = string;

export type BacktestStrategyCategory =
  | 'SMC'
  | 'Price Action'
  | 'Chart Patterns'
  | 'Support & Resistance'
  | 'Hybrid SMC/PA';

export interface BacktestStrategyDefinition {
  id: BacktestStrategyId;
  name: string;
  category: BacktestStrategyCategory;
  summary: string;
  entryRules: string[];
  riskRules: string[];
}

export interface BacktestConfig {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  bars: number;
  initialCapital: number;
  riskPerTradePercent: number;
  commissionBps: number;
  slippageBps: number;
  minRiskReward: number;
  moveStopToBreakevenAfterTp1: boolean;
  strategyIds?: BacktestStrategyId[];
}

export type BacktestTradeExitReason =
  | 'TP1_FULL'
  | 'TP2_FULL'
  | 'TP3_FULL'
  | 'STOP_LOSS'
  | 'BREAKEVEN_STOP'
  | 'END_OF_DATA';

export interface BacktestTradeTarget {
  level: 1 | 2 | 3;
  price: number;
  riskReward: number;
  sourceLabel: string;
  hit: boolean;
  hitTime: number | null;
}

export interface BacktestTradeRecord {
  id: string;
  tradeNumber: number;
  strategyId: BacktestStrategyId;
  direction: SignalDirection;
  entryMode: 'market_close' | 'limit_retest';
  signalTime: number; // unix sec
  entryTime: number; // unix sec
  exitTime: number; // unix sec
  barsHeld: number;
  entryPrice: number;
  stopLoss: number;
  initialStopLoss: number;
  invalidationLevel: number;
  exitPrice: number;
  takeProfits: BacktestTradeTarget[];
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  exitReason: BacktestTradeExitReason;
  units: number;
  riskAmount: number;
  grossPnl: number;
  feesAndSlippage: number;
  netPnl: number;
  returnPercent: number;
  realizedR: number;
  mfeR: number;
  maeR: number;
  equityAfter: number;
  confluenceScore: number;
  entryRationale: string[];
  exitNote: string;
}

export interface BacktestEquityPoint {
  time: number; // unix sec
  equity: number;
  drawdownPercent: number;
  tradeNumber?: number;
}

export interface BacktestStrategyMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevenTrades: number;
  winRate: number;
  longTrades: number;
  longWinRate: number;
  shortTrades: number;
  shortWinRate: number;
  startingCapital: number;
  endingEquity: number;
  netProfit: number;
  netReturnPercent: number;
  grossProfit: number;
  grossLoss: number;
  totalFeesAndSlippage: number;
  profitFactor: number | null;
  expectancyR: number;
  expectancyDollar: number;
  avgWinR: number;
  avgLossR: number;
  avgWinDollar: number;
  avgLossDollar: number;
  bestTradeR: number;
  worstTradeR: number;
  maxDrawdownDollar: number;
  maxDrawdownPercent: number;
  recoveryFactor: number | null;
  sharpeRatio: number;
  sortinoRatio: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgBarsHeld: number;
  tp1HitRate: number;
  tp2HitRate: number;
  tp3HitRate: number;
  slHitRate: number;
  compositeScore: number;
}

export interface BacktestStrategyResult {
  strategy: BacktestStrategyDefinition;
  rank: number;
  metrics: BacktestStrategyMetrics;
  trades: BacktestTradeRecord[];
  equityCurve: BacktestEquityPoint[];
  verdict: string;
  strengths: string[];
  weaknesses: string[];
}

export interface BacktestRunResult {
  id: string;
  createdAt: number;
  durationMs: number;
  config: BacktestConfig;
  dataRange: {
    startTime: number;
    endTime: number;
    totalBars: number;
    evaluatedBars: number;
    htfBars: number;
    provider: string;
  };
  bestStrategyId: BacktestStrategyId | null;
  bestStrategyReason: string;
  strategies: BacktestStrategyResult[];
}

export interface BacktestRunSummary {
  id: string;
  createdAt: number;
  durationMs: number;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  bars: number;
  bestStrategyId: BacktestStrategyId | null;
  bestStrategyName: string | null;
  bestNetReturnPercent: number | null;
  bestProfitFactor: number | null;
  bestWinRate: number | null;
  strategyCount: number;
}

// ============================================================================
// Shared-Capital Uncorrelated Basket Portfolio & Live Auto-Run Types
// ============================================================================

export interface BasketBacktestConfig extends BacktestConfig {
  strategyIds: BacktestStrategyId[];
  maxConcurrentPositions: number;
  maxPortfolioHeatPercent: number;
}

export interface BasketStrategyContribution {
  strategy: BacktestStrategyDefinition;
  tradesExecuted: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  avgR: number;
  skippedByConcurrentCap: number;
  skippedByHeatCap: number;
}

export interface BasketTradeRecord extends BacktestTradeRecord {
  strategyName: string;
  strategyCategory: BacktestStrategyCategory;
  concurrentPositionsAtEntry: number;
  portfolioHeatAtEntry: number;
}

export interface BasketBacktestResult {
  id: string;
  createdAt: number;
  durationMs: number;
  config: BasketBacktestConfig;
  dataRange: {
    startTime: number;
    endTime: number;
    totalBars: number;
    evaluatedBars: number;
    htfBars: number;
    provider: string;
  };
  metrics: BacktestStrategyMetrics;
  equityCurve: BacktestEquityPoint[];
  trades: BasketTradeRecord[];
  contributions: BasketStrategyContribution[];
  totalSignalsGenerated: number;
  totalTradesExecuted: number;
  skippedByConcurrentCap: number;
  skippedByHeatCap: number;
  avgConcurrentPositions: number;
  peakConcurrentPositions: number;
  peakPortfolioHeatPercent: number;
  avgPairwiseCorrelation: number;
  standaloneAvgMaxDdPercent: number;
  drawdownReductionPercent: number;
}

export interface LiveStrategyBasketStrategyRef {
  id: BacktestStrategyId;
  name: string;
  category: BacktestStrategyCategory;
}

export interface LiveStrategyBasketSlot {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  strategies: LiveStrategyBasketStrategyRef[];
  sourceRunId?: string;
  readiness?: ProductionReadinessStatus;
  bestRegime?: MarketRegimeType;
  poorRegimes?: MarketRegimeType[];
  avoidSessions?: TradingSessionName[];
  oosWinRate?: number;
  oosProfitFactor?: number | null;
  oosExpectancyR?: number;
  oosScore?: number;
  lastClosedBarTime?: number | null;
}

export type LiveStrategyReadinessFilter =
  | 'PRODUCTION_READY_ONLY'
  | 'INCLUDE_VERIFY_PAPER'
  | 'VALIDATED_OR_PRELIM';

export interface LiveStrategyFilterCriteria {
  source?: 'discovery_best' | 'discovery_filtered' | 'live_strategy_match' | 'manual_basket';
  runId?: string;
  symbols?: InstrumentSymbol[];
  timeframes?: Timeframe[];
  categories?: BacktestStrategyCategory[];
  readinessMode?: LiveStrategyReadinessFilter;
  minWinRate?: number;
  minProfitFactor?: number;
  minExpectancyR?: number;
  minOosScore?: number;
  maxStrategiesPerSlot?: number;
  minRiskReward?: number;
  maxConcurrentPositions?: number;
  avoidPoorRegimes?: boolean;
  avoidWeakSessions?: boolean;
  requireHtfAlignment?: boolean;
}

export interface LiveStrategyBasketConfig {
  enabled: boolean;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  strategies: LiveStrategyBasketStrategyRef[];
  assignments?: LiveStrategyBasketSlot[];
  filters?: LiveStrategyFilterCriteria;
  selectionLabel?: string;
  maxConcurrentPositions: number;
  minRiskReward: number;
  sourceRunId?: string;
  updatedAt: number;
  lastEvaluatedAt: number | null;
  lastClosedBarTime: number | null;
  emittedSignalCount: number;
  lastStatusNote?: string;
}

// ============================================================================
// Best Strategy Discovery & Optimization Scanner Types (Deterministic Quant)
// ============================================================================

export type MarketRegimeType =
  | 'Trending'
  | 'Ranging'
  | 'High Volatility'
  | 'Low Volatility'
  | 'Transitional';

export type ValidationStatus =
  | 'Validated'
  | 'Preliminary Candidate'
  | 'Insufficient Evidence'
  | 'Failed Validation';

export type DiscoveryStrategyScope = 'core' | 'all' | 'category';

export type ChronologicalSplitLabel = 'IS' | 'OOS' | 'HOLDOUT';

export interface WindowSegmentMetrics {
  trades: number;
  wins: number;
  losses: number;
  breakevenTrades: number;
  winRate: number;
  netReturnPercent: number;
  profitFactor: number | null;
  expectancyR: number;
  avgR: number;
  avgWinR?: number;
  avgLossR?: number;
  rewardToRiskRatio?: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  avgBarsHeld: number;
}

export interface WalkForwardFoldResult {
  foldIndex: number;
  trainStartTime: number;
  trainEndTime: number;
  testStartTime: number;
  testEndTime: number;
  trainMetrics: WindowSegmentMetrics;
  testMetrics: WindowSegmentMetrics;
  active: boolean;
  profitable: boolean;
  positiveExpectancy: boolean;
}

export interface CombinationRegimePerformance {
  regime: MarketRegimeType;
  barsInRegime: number;
  isMetrics: WindowSegmentMetrics;
  oosMetrics: WindowSegmentMetrics;
  holdoutMetrics: WindowSegmentMetrics;
  fullPreHoldoutMetrics: WindowSegmentMetrics;
}

export interface PoorRegimeSummary {
  regime: MarketRegimeType;
  oosTrades: number;
  oosExpectancyR: number;
  oosProfitFactor: number | null;
  oosNetReturnPercent: number;
}

export type TradingSessionName =
  | 'Asian (00–07 UTC)'
  | 'London Open (07–12 UTC)'
  | 'London/NY Overlap (12–16 UTC)'
  | 'NY Afternoon (16–21 UTC)'
  | 'Late / Rollover (21–00 UTC)';

export interface SessionTimePerformance {
  session: TradingSessionName;
  utcStartHour: number;
  utcEndHour: number;
  preHoldoutTrades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  netReturnPercent: number;
  holdoutTrades: number;
  holdoutExpectancyR: number;
}

export type ProductionReadinessStatus =
  | 'Production Ready'
  | 'Verify Paper'
  | 'Overfit / Decayed'
  | 'Not Ready';

export interface ProductionAuditSummary {
  readiness: ProductionReadinessStatus;
  holdoutConfirmed: boolean;
  edgeConfidencePercent: number;
  isOosDecayRatio: number | null;
  summaryNote: string;
}

export interface StrategyDiscoveryCombination {
  comboKey: string;
  rank: number;
  strategy: BacktestStrategyDefinition;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  regime: MarketRegimeType;
  validationStatus: ValidationStatus;
  validationReasons: string[];
  oosScore: number;
  wfConsistencyPercent: number;
  wfProfitableFolds: number;
  wfActiveFolds: number;
  barsInRegime: number;
  totalIsOosTrades: number;
  isMetrics: WindowSegmentMetrics;
  oosMetrics: WindowSegmentMetrics;
  holdoutMetrics: WindowSegmentMetrics;
  poorRegimes: PoorRegimeSummary[];
  allRegimesBreakdown: CombinationRegimePerformance[];
  walkForwardFolds: WalkForwardFoldResult[];
  strengths: string[];
  weaknesses: string[];
  recommendedConditions: string[];
  bestSession?: TradingSessionName | null;
  bestUtcHours?: string | null;
  avoidSessions?: TradingSessionName[];
  sessionBreakdown?: SessionTimePerformance[];
  productionAudit?: ProductionAuditSummary;
}

export interface DiscoveryScanConfig {
  symbols: InstrumentSymbol[];
  timeframes: Timeframe[];
  barsPerTimeframe: number;
  initialCapital: number;
  riskPerTradePercent: number;
  commissionBps: number;
  slippageBps: number;
  minRiskReward: number;
  moveStopToBreakevenAfterTp1: boolean;
  strategyScope: DiscoveryStrategyScope;
  categories?: BacktestStrategyCategory[];
  minOosTradesForValidation: number;
  minTotalSampleForValidation: number;
  isRatio: number;
  oosRatio: number;
}

export interface DiscoveryMarketCoverage {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  totalBars: number;
  evaluatedBars: number;
  isBars: number;
  oosBars: number;
  holdoutBars: number;
  startTime: number;
  isEndTime: number;
  oosEndTime: number;
  endTime: number;
  provider: string;
  regimeDistribution: Record<MarketRegimeType, number>;
  error?: string;
}

export interface DiscoveryScanSummaryStats {
  totalCombinationsEvaluated: number;
  validatedCount: number;
  preliminaryCount: number;
  insufficientCount: number;
  failedCount: number;
  instrumentsScanned: InstrumentSymbol[];
  timeframesScanned: Timeframe[];
}

export interface DiscoveryScanRun {
  id: string;
  createdAt: number;
  durationMs: number;
  config: DiscoveryScanConfig;
  strategiesEvaluatedCount: number;
  marketCoverage: DiscoveryMarketCoverage[];
  summaryStats: DiscoveryScanSummaryStats;
  combinations: StrategyDiscoveryCombination[];
}

export interface DiscoveryRunSummary {
  id: string;
  createdAt: number;
  durationMs: number;
  strategiesEvaluatedCount: number;
  instrumentsCount: number;
  timeframesCount: number;
  validatedCount: number;
  preliminaryCount: number;
  totalCombinations: number;
  topComboLabel: string | null;
  topComboOosScore: number | null;
  topComboOosReturnPercent: number | null;
}

export interface DiscoveryScanProgress {
  jobId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  completedSteps: number;
  totalSteps: number;
  currentSymbol?: InstrumentSymbol;
  currentTimeframe?: Timeframe;
  message: string;
  startedAt: number | null;
  runId?: string;
  error?: string;
}

export interface AnnotatedDiscoveryTrade extends BacktestTradeRecord {
  split: ChronologicalSplitLabel;
  entryRegime: MarketRegimeType;
}

export interface CombinationDetailResult {
  combination: StrategyDiscoveryCombination;
  backtestResult: BacktestStrategyResult;
  annotatedTrades: AnnotatedDiscoveryTrade[];
  splitBoundaries: {
    startTime: number;
    isEndTime: number;
    oosEndTime: number;
    endTime: number;
  };
  regimeTimeline: Array<{
    time: number;
    regime: MarketRegimeType;
    split: ChronologicalSplitLabel;
  }>;
  sessionBreakdown?: SessionTimePerformance[];
}

// ============================================================================
// LIVE MARKET Strategy — Live Condition Analysis & Backtest Database Matcher
// ============================================================================

export type LiveMarketRegimeLabel =
  | 'Trending'
  | 'Ranging'
  | 'Consolidating'
  | 'Transitioning';

export type LiveMarketDirectionLabel =
  | 'Strong Uptrend'
  | 'Weak Uptrend'
  | 'Strong Downtrend'
  | 'Weak Downtrend'
  | 'Sideways';

export type LiveVolatilityLevel =
  | 'Very Low'
  | 'Low'
  | 'Normal'
  | 'High'
  | 'Extreme';

export type LiveVolumeStrength =
  | 'Very Low'
  | 'Low'
  | 'Normal'
  | 'High'
  | 'Climax';

export type LiveBreakoutState =
  | 'Active Breakout'
  | 'Confirmed Retest'
  | 'False Breakout Trap'
  | 'Compression Coil'
  | 'Range Bound';

export type StrategyRecommendationStatus =
  | 'BEST MATCH'
  | 'GOOD MATCH'
  | 'MODERATE MATCH'
  | 'POOR MATCH'
  | 'INSUFFICIENT DATA';

export interface LiveMarketLevelSummary {
  label: string;
  price: number;
  lower: number;
  upper: number;
  strengthScore: number;
  distancePercent: number;
}

export interface LiveMarketConditionAnalysis {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  htfTimeframe: Timeframe;
  price: number;
  bid?: number;
  ask?: number;
  spread?: number;
  change24h: number;
  changePercent24h: number;
  marketOpen: boolean;
  connectionStatus: ConnectionStatus;
  providerName: string;
  analyzedAt: number;
  latestCandleTime: number;

  regime: LiveMarketRegimeLabel;
  discoveryRegimeMapping: MarketRegimeType;
  direction: LiveMarketDirectionLabel;
  volatility: LiveVolatilityLevel;
  trendStrengthScore: number; // 0..100
  trendStrengthLabel: 'Weak' | 'Developing' | 'Strong' | 'Very Strong';
  momentumStrengthScore: number; // 0..100
  momentumDirection: 'Bullish' | 'Bearish' | 'Neutral';
  momentumAtr: number;

  marketStructure: 'Bullish' | 'Bearish' | 'Neutral';
  htfStructure: 'Bullish' | 'Bearish' | 'Neutral';
  structureSequence: string;
  structureDetail: string;

  adx: number;
  adxCondition: string;
  atr: number;
  atrPercent: number;
  atrPercentile: number; // 0..100
  volRatio: number;
  atrCondition: string;
  efficiencyRatio: number;
  emaSeparationAtr: number;
  ema20: number;
  ema50: number;

  volumeStrength: LiveVolumeStrength;
  relativeVolume: number;
  unusualVolume: boolean;
  volumeAvailable: boolean;
  volumeNote: string;

  supportLevels: LiveMarketLevelSummary[];
  resistanceLevels: LiveMarketLevelSummary[];

  liquidityCondition: {
    summary: string;
    recentSweepsCount: number;
    unsweptBuySideCount: number;
    unsweptSellSideCount: number;
    sweepBias: 'Bullish Sweep' | 'Bearish Sweep' | 'Balanced' | 'Quiet';
    nearestBuySide: { label: string; price: number; distancePercent: number } | null;
    nearestSellSide: { label: string; price: number; distancePercent: number } | null;
  };

  breakoutCondition: {
    state: LiveBreakoutState;
    detail: string;
  };

  session: TradingSessionName;
  sessionShort: 'Asian' | 'London' | 'London/NY Overlap' | 'New York' | 'Late / Rollover';

  reversalCondition: {
    riskLevel: 'Low' | 'Moderate' | 'Elevated' | 'High';
    summary: string;
    signals: string[];
  };

  conditionSummary: string;
}

export interface StrategyMatchItem {
  rank: number;
  strategy: BacktestStrategyDefinition;
  matchingScore: number; // 0..100 historical condition similarity & validation fit (NOT win probability)
  status: StrategyRecommendationStatus;
  evidenceSource: 'discovery_combo' | 'backtest_run';
  sourceRunId: string;
  sourceComboKey?: string;
  matchedSymbol: InstrumentSymbol;
  matchedTimeframe: Timeframe;
  bestTimeframe: Timeframe;
  bestRegime: MarketRegimeType;
  bestConditions: string[];

  winRate: number;
  profitFactor: number | null;
  avgRMultiple: number;
  expectancyR: number;
  maxDrawdownPercent: number;
  tradesTested: number;
  unseenTestTrades: number;

  recentOosPerformance: {
    winRate: number;
    profitFactor: number | null;
    expectancyR: number;
    netReturnPercent: number;
    maxDrawdownPercent: number;
    trades: number;
    holdoutReturnPercent: number | null;
    holdoutTrades: number | null;
    wfConsistencyPercent: number | null;
  };

  validationStatus: ValidationStatus | 'Backtest Only';
  productionReadiness?: ProductionReadinessStatus;
  bestSession?: TradingSessionName | null;
  avoidSessions?: TradingSessionName[];

  matchReasons: string[];
  cautionNotes: string[];

  componentScores: {
    conditionFit: number; // 0..30
    validationQuality: number; // 0..30
    expectancyRisk: number; // 0..22
    timeframeSessionFit: number; // 0..18
  };

  conditionMatches: {
    regimeMatch: boolean;
    trendMatch: boolean;
    volatilityMatch: boolean;
    regimeScore: number; // 0..100
    trendScore: number; // 0..100
    volatilityScore: number; // 0..100
    matchedCount: number; // 0..3 (Volatility, Trend, Regime)
  };

  performanceSeries: Array<{
    label: string;
    returnPercent: number;
    expectancyR: number;
    trades: number;
  }>;
}

export type LiveConditionFilterMode = 'all' | 'matched_conditions';

export interface LiveMarketRecommendationDecision {
  hasReliableMatch: boolean;
  bestStrategy: StrategyMatchItem | null;
  secondBestStrategy: StrategyMatchItem | null;
  topStrategies: StrategyMatchItem[];
  allEvaluatedCount: number;
  filterCriteria: {
    liveVolatility: LiveVolatilityLevel;
    liveTrendDirection: LiveMarketDirectionLabel;
    liveTrendStrength: LiveMarketConditionAnalysis['trendStrengthLabel'];
    liveRegime: LiveMarketRegimeLabel;
    mappedRegime: MarketRegimeType;
    conditionFilterMode: LiveConditionFilterMode;
    maxRecommendations: number;
  };
  filterCounts: {
    totalEvaluated: number;
    matchedConditionCount: number;
    regimeMatchedCount: number;
    trendMatchedCount: number;
    volatilityMatchedCount: number;
    bestMatchCount: number;
    goodMatchCount: number;
    moderateMatchCount: number;
    returnedCount: number;
  };
  strategiesAgree: boolean;
  agreementSummary: string;
  marketSuitability: 'TRADEABLE' | 'SELECTIVE' | 'WAIT';
  actionVerdict: 'TRADE NOW' | 'SELECTIVE SETUP' | 'WAIT';
  verdictReasons: string[];
}

export interface LiveMarketStrategyReport {
  condition: LiveMarketConditionAnalysis;
  decision: LiveMarketRecommendationDecision;
  databaseCoverage: {
    discoveryRunsCount: number;
    backtestRunsCount: number;
    uniqueStrategiesTested: number;
    matchingSymbolRecords: number;
    latestDiscoveryRunId: string | null;
    latestBacktestRunId: string | null;
  };
}

export interface MultiDimensionalMarketState {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  evaluatedAt: number;
  direction: 'Bullish' | 'Bearish' | 'Neutral';
  trendStrength: 'Weak' | 'Moderate' | 'Strong';
  volatility: 'Low' | 'Normal' | 'High' | 'Extreme';
  structure: 'BOS' | 'CHoCH' | 'MSS' | 'Consolidation';
  phase: 'Expansion' | 'Retracement' | 'Consolidation';
  liquidity: 'Liquidity Sweep' | 'BSL' | 'SSL' | 'Untouched';
  location: 'Premium' | 'Discount' | 'Equilibrium';
  tradingCondition: 'Favorable' | 'Caution' | 'No Trade';
  reasons: string[];
}

export interface TradeJournalEntry {
  id: string;
  signalId: string;
  executionId: string;
  positionId: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  strategyId: string;
  strategyName: string;
  strategyVersion: string;
  marketRegime?: string;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number | null;
  takeProfit3?: number | null;
  volume: number;
  riskAmountUsd: number;
  realizedPnlUsd: number | null;
  realizedR: number | null;
  feesUsd: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED' | 'CANCELLED';
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN';
  entryReason: string;
  exitReason: string | null;
  reflectionNotes: string;
  lessonsLearned: string;
  tags: string[];
  rating: number | null;
  executedAt: number;
  closedAt: number | null;
  updatedAt: number;
}

export interface ExecutionInstruction {
  id: string;
  idempotencyKey: string;
  signalId: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  strategyId: string;
  strategyName: string;
  adapter: 'PAPER' | 'MT5';
  status: 'ACCEPTED' | 'REJECTED' | 'EXECUTED';
  createdAt: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  size?: number;
  strategyVersion?: string;
}

export interface PaperOrder {
  id: string;
  idempotencyKey: string;
  signalId: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  volume: number;
  requestedPrice: number;
  fillPrice: number;
  stopLoss: number;
  takeProfits: SignalTakeProfit[];
  plannedRR: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  spreadCostUsd: number;
  commissionUsd: number;
  slippageUsd: number;
  createdAt: number;
  filledAt: number | null;
}

export interface PaperFill {
  id: string;
  orderId: string;
  positionId: string;
  symbol: InstrumentSymbol;
  direction: SignalDirection;
  fillKind: 'ENTRY' | 'PARTIAL_TP' | 'EXIT';
  price: number;
  volume: number;
  grossPnlUsd: number;
  feeUsd: number;
  slippageUsd: number;
  netPnlUsd: number;
  timestamp: number;
}

export interface PaperPosition {
  id: string;
  orderId: string;
  signalId: string;
  journalId: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: string;
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  initialStopLoss: number;
  takeProfits: SignalTakeProfit[];
  volumeTotal: number;
  volumeRemaining: number;
  riskAmountUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  realizedR: number;
  feesUsd: number;
  slippageUsd: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED' | 'CANCELLED';
  exitPrice: number | null;
  exitReason: string | null;
  openedAt: number;
  closedAt: number | null;
}

export type MarketDataAnomalyCode =
  | 'BROKER_DISCONNECTED'
  | 'STALE_PROVIDER_EVENT'
  | 'STALE_CANDLE_STREAM'
  | 'INCOMPLETE_HISTORY'
  | 'INVALID_OHLC'
  | 'DUPLICATE_CANDLES'
  | 'OUT_OF_ORDER_CANDLES'
  | 'UNEXPECTED_PRICE_JUMP';

export interface MarketDataIntegrityReport {
  symbol: InstrumentSymbol;
  timeframe: Timeframe;
  healthy: boolean;
  blocked: boolean;
  checkedAt: number;
  providerEventTime: number | null;
  receiveTime: number;
  providerLatencyMs: number | null;
  candleCount: number;
  duplicatesRemoved: number;
  outOfOrderFixed: number;
  missingIntervalsCount: number;
  anomalies: Array<{
    code: MarketDataAnomalyCode;
    severity: 'warning' | 'critical';
    message: string;
  }>;
}

export interface RiskAccountSnapshot {
  settings: RiskSettings;
  currentEquity: number;
  openPositionsCount: number;
  totalOpenRiskPercent: number;
  dailyRealizedPnlUsd: number;
  dailyLossPercent: number;
  weeklyRealizedPnlUsd: number;
  weeklyLossPercent: number;
  tradesTodayCount: number;
  tradingLocked: boolean;
  lockReasons: string[];
}

export interface RiskApprovalResult {
  approved: boolean;
  rejectionReasons: string[];
  warnings: string[];
  calculatedVolume: number;
  riskAmountUsd: number;
  riskPercent: number;
  estimatedSpreadCostUsd: number;
  estimatedCommissionUsd: number;
  estimatedSlippageUsd: number;
  plannedNetRR: number;
  totalOpenRiskAfterPercent: number;
  checkedAt: number;
}

export interface RiskSettings {
  accountEquity: number;
  riskPerTradePercent: number;
  maxRiskPerTradePercent: number;
  maxTotalOpenRiskPercent: number;
  maxDailyLossPercent: number;
  maxWeeklyLossPercent: number;
  maxDailyTrades: number;
  maxOpenPositionsPerInstrument: number;
  minPlannedNetRR: number;
  maxAllowedSpreadBps: number;
  allowMartingale: boolean;
  allowGrid: boolean;
  allowAveragingDown: boolean;
  killSwitchEngaged: boolean;
  killSwitchReason?: string;
  autoExecuteConfirmedSignals?: boolean;
}

export interface InstrumentContractSpec {
  symbol: InstrumentSymbol;
  assetClass: AssetClass;
  contractSize: number;
  tickSize: number;
  tickValuePerLot: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  commissionPerLotUsd: number;
  commissionBps: number;
  defaultSpreadBps: number;
  slippageBps: number;
  swapLongBpsPerDay: number;
  swapShortBpsPerDay: number;
  leverageLimit: number;
  maxAllowedSpreadPercent: number;
  defaultBrokerAliases: string[];
  notes: string;
}

export interface SignalCalibrationSummary {
  sampleSize: number;
  minRequiredSamples: number;
  sufficientEvidence: boolean;
  calibratedWinRatePercent: number | null;
  ciLowerPercent: number | null;
  ciUpperPercent: number | null;
  avgRealizedR: number | null;
  message: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  category: string;
  details: string;
  timestamp: number;
  actor?: string;
  severity?: 'info' | 'warning' | 'critical';
}

export type MT5AccountTradeMode = 'DEMO' | 'CONTEST' | 'REAL' | 'UNKNOWN';

export interface MT5OpenPosition {
  ticket: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  profit: number;
  magic?: number;
  comment?: string;
}

export interface MT5SymbolQuote {
  rawSymbol: string;
  normalizedSymbol: InstrumentSymbol | null;
  bid: number;
  ask: number;
  last: number;
  time: number;
  receivedAt: number;
}

export interface MT5BridgeStatus {
  connected: boolean;
  statusLabel: 'CONNECTED' | 'STALE' | 'DISCONNECTED';
  terminalVersion?: string;
  accountNumber?: number;
  broker?: string;
  server?: string;
  tradeMode?: MT5AccountTradeMode;
  currency?: string;
  leverage?: number;
  balance?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  latencyMs: number;
  lastHeartbeat: number;
  lastTickAt: number | null;
  messagesReceived: number;
  paperMode: boolean;
  requiresApiToken: boolean;
  openPositions: MT5OpenPosition[];
  syncedTicks: MT5SymbolQuote[];
  lastError?: string | null;
}

export type MT5SizingMode = 'RISK_PERCENT' | 'FIXED_LOT';
export type MT5BreakevenTrigger = 'TP1_HIT' | 'R_MULTIPLE';
export type MT5TrailingMode = 'NONE' | 'TP_STEP' | 'FIXED_R' | 'ATR_MULTIPLE';

export interface MT5ExecutionSettings {
  enabled: boolean;
  autoExecuteSignals: boolean;
  demoAccountOnly: boolean;
  allowWatchingSignals: boolean;
  minSignalScore: number;
  allowedSymbols: InstrumentSymbol[];
  sizingMode: MT5SizingMode;
  riskPercentPerTrade: number;
  fixedLotSize: number;
  maxLotSize: number;
  maxOpenPositionsTotal: number;
  maxOpenPositionsPerSymbol: number;
  magicNumber: number;
  deviationPoints: number;
  symbolMapping: Record<InstrumentSymbol, string>;
  initialTpLevel: 1 | 2 | 3;
  partialCloseEnabled: boolean;
  tp1ClosePercent: number;
  tp2ClosePercent: number;
  moveSlToBreakeven: boolean;
  breakevenTrigger: MT5BreakevenTrigger;
  breakevenTriggerR: number;
  breakevenOffsetPoints: number;
  trailSlToTp1OnTp2: boolean;
  trailingMode: MT5TrailingMode;
  trailingActivationR: number;
  trailingDistanceR: number;
  trailingAtrMultiplier: number;
  trailingMinStepPoints: number;
}

export type MT5ExecutionPresetId = 'safe_micro' | 'balanced_risk' | 'high_precision';

export interface MT5ExecutionPreset {
  id: MT5ExecutionPresetId;
  name: string;
  subtitle: string;
  recommended?: boolean;
  summary: string;
  patch: Partial<MT5ExecutionSettings>;
}

export type MT5CommandType = 'OPEN_ORDER' | 'MODIFY_SLTP' | 'CLOSE_PARTIAL' | 'CLOSE_POSITION';
export type MT5CommandStatus = 'PENDING' | 'DISPATCHED' | 'EXECUTED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export interface MT5TradeCommand {
  id: string;
  idempotencyKey: string;
  type: MT5CommandType;
  signalId: string | null;
  managedTradeId: string | null;
  mt5Ticket: string | null;
  symbol: InstrumentSymbol;
  brokerSymbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  magicNumber: number;
  deviationPoints: number;
  comment: string;
  reason: string;
  status: MT5CommandStatus;
  createdAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  executedPrice?: number | null;
  executedVolume?: number | null;
  retcode?: number | null;
  errorMessage?: string | null;
}

export interface MT5ManagedTrade {
  id: string;
  signalId: string;
  strategyId: string;
  strategyName: string;
  symbol: InstrumentSymbol;
  brokerSymbol: string;
  timeframe: Timeframe;
  direction: SignalDirection;
  mt5Ticket: string | null;
  commentTag: string;
  magicNumber: number;
  status: 'QUEUED' | 'OPEN' | 'PARTIAL' | 'CLOSED' | 'FAILED';
  requestedVolume: number;
  openVolume: number;
  entryPrice: number;
  currentPrice: number;
  initialStopLoss: number;
  currentStopLoss: number;
  brokerTakeProfit: number;
  tp1Price: number;
  tp2Price: number | null;
  tp3Price: number | null;
  tp1Done: boolean;
  tp2Done: boolean;
  breakevenDone: boolean;
  slAtTp1Done: boolean;
  highestFavorablePrice: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  lastManagementNote: string;
  openedAt: number;
  closedAt: number | null;
}

export interface MT5ExecutionOverview {
  settings: MT5ExecutionSettings;
  managedTrades: MT5ManagedTrade[];
  commands: MT5TradeCommand[];
  mt5Status: MT5BridgeStatus;
}

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'trader';
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AuthSession {
  token: string;
  userId: string;
  email: string;
  role: 'admin' | 'trader';
  createdAt: number;
  expiresAt: number;
}




