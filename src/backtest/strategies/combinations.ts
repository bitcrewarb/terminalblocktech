import type {
  AnalysisSnapshot,
  BacktestConfig,
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
  BacktestStrategyId,
  Candle,
  CandlestickPattern,
  ChartPattern,
  FairValueGap,
  LiquidityPool,
  OrderBlock,
  SDZone,
  SignalDirection,
  SRZone,
  StructureBreak,
  Trendline,
} from '../../shared/types/index.ts';

export type Direction = 'BUY' | 'SELL';
const DIRS: readonly Direction[] = ['BUY', 'SELL'];

export interface ComboBarContext {
  execSnap: AnalysisSnapshot;
  htfSnap: AnalysisSnapshot | null;
  bar: Candle;
  prevBar: Candle;
  candles: Candle[];
  atr: number;
  tfSec: number;
  precision: number;
  price: number;
  htfTrend: 'bullish' | 'bearish' | 'consolidation';
  execTrend: 'bullish' | 'bearish' | 'consolidation';
  barRange: number;
  barBody: number;
  upperWick: number;
  lowerWick: number;
  isBullBar: boolean;
  isBearBar: boolean;
  displacementSigned: number;
  volRatio: number;
  ema20: number;
  ema20Prev: number;
  ema50: number;
  donchianHigh20: number;
  donchianLow20: number;
  donchianHigh10: number;
  donchianLow10: number;
  nr4: boolean;
  nr7: boolean;
  coil3: boolean;
  prevConsecBull: number;
  prevConsecBear: number;
  recent3High: number;
  recent3Low: number;
  confirmedBreaks: StructureBreak[];
  confirmedCandles: CandlestickPattern[];
  activeObs: OrderBlock[];
  activeFvgs: FairValueGap[];
  activeSds: SDZone[];
  activeSrs: SRZone[];
  brokenOrRetestSrs: SRZone[];
  activeTrendlines: Trendline[];
  activeChartPatterns: ChartPattern[];
  recentSweeps: LiquidityPool[];
}

export interface ComboBuildPlanParams {
  strategyId: BacktestStrategyId;
  direction: SignalDirection;
  entryMode: 'market_close' | 'limit_retest';
  entryPrice?: number;
  entryZone?: { lower: number; upper: number };
  invalidationLevel: number | null;
  atrMultiplier?: number;
  minRiskReward?: number;
  confluenceScore: number;
  entryRationale: string[];
  extraTarget?: { price: number; label: string } | null;
}

export interface ComboEvalDeps<TPlan> {
  ctx: ComboBarContext;
  config: BacktestConfig;
  findProtectedInvalidation: (
    direction: SignalDirection,
    entryPrice: number,
    atr: number,
    execSnap: AnalysisSnapshot,
    extraAnchor?: number
  ) => number | null;
  buildPlan: (
    ctx: ComboBarContext,
    config: BacktestConfig,
    params: ComboBuildPlanParams
  ) => TPlan | null;
}

type DriverId =
  // SMC Drivers (16)
  | 'SWEEP_ANY'
  | 'SWEEP_EQ'
  | 'SWEEP_PDHL'
  | 'SWEEP_PWHL'
  | 'OB_UNMIT'
  | 'OB_DISP'
  | 'BREAKER'
  | 'MITIGATION'
  | 'FVG_ANY'
  | 'FVG_CE'
  | 'IFVG'
  | 'SD_FRESH'
  | 'SD_CONT'
  | 'OTE_705'
  | 'MSS_BOS'
  | 'SMC_VOL_IMB'
  // Price Action & Candlestick Drivers (20)
  | 'PA_ENGULF'
  | 'PA_PINBAR'
  | 'PA_STAR'
  | 'PA_INSIDE'
  | 'PA_FAKEY'
  | 'PA_MARUBOZU'
  | 'PA_TWEEZER'
  | 'PA_RAIL'
  | 'PA_THREE_SOLDIERS_CROWS'
  | 'PA_PIERCING_DARKCLOUD'
  | 'PA_HARAMI'
  | 'PA_OUTSIDE_BAR'
  | 'PA_EMA20'
  | 'PA_EMA50'
  | 'PA_DONCHIAN20'
  | 'PA_TURTLE_SOUP'
  | 'PA_NR7_COIL'
  | 'DYN_ATR_EXPANSION'
  | 'DYN_EMA_CROSS'
  | 'DYN_DAILY_BIAS'
  // Chart Pattern & Trendline Drivers (12 — includes dedicated W & M patterns)
  | 'CP_W_PATTERN'
  | 'CP_M_PATTERN'
  | 'CP_DOUBLE_TB'
  | 'CP_TRIPLE_TB'
  | 'CP_HS_IHS'
  | 'CP_SYM_TRI'
  | 'CP_DIR_TRI'
  | 'CP_FLAG_PEN'
  | 'CP_WEDGE'
  | 'CP_CUP_ROUND'
  | 'CP_TL_BOUNCE'
  | 'CP_TL_BREAK'
  // Support & Resistance Drivers (10)
  | 'SR_MAJOR'
  | 'SR_VERIFIED'
  | 'SR_FLIP'
  | 'SR_BREAKOUT'
  | 'SR_PDHL'
  | 'SR_PWHL'
  | 'SR_PIVOT'
  | 'SR_SESSION'
  | 'SR_SPRING'
  | 'SR_NESTED_HTF';

type FilterId =
  | 'HTF_STRICT'
  | 'HTF_NONOPP'
  | 'MSS_SHIFT'
  | 'BOS_CONT'
  | 'FVG_CONF'
  | 'OB_CONF'
  | 'SR_NEAR'
  | 'SWEEP_CONF'
  | 'OTE_QUAD'
  | 'VOL_125'
  | 'VOL_145'
  | 'DISP_STRONG'
  | 'CANDLE_REV'
  | 'EMA_SLOPE'
  | 'EMA_STACK'
  | 'EXHAUST_3'
  | 'CONSOL_REGIME'
  | 'TREND_REGIME'
  | 'WICK_ABSORB'
  | 'TL_NEAR'
  | 'VOL_EXPAND'
  | 'VOL_COMPRESS'
  | 'PRICE_EMA20'
  | 'DAILY_BIAS'
  | 'SD_CONFLUENCE'
  | 'FVG_OR_OB';

type ExecProfileId =
  | 'MARKET_STD'
  | 'MARKET_TIGHT'
  | 'MARKET_RUNNER'
  | 'LIMIT_RETEST';

interface ComboSpec {
  id: string;
  name: string;
  category: BacktestStrategyCategory;
  driver: DriverId;
  filter: FilterId;
  secondFilter?: FilterId;
  exec: ExecProfileId;
  scoreBonus: number;
  summary: string;
  entryRules: string[];
  riskRules: string[];
}

interface DriverHit {
  invalidation: number | null;
  limitEntry?: number;
  entryZone?: { lower: number; upper: number };
  extraTarget?: { price: number; label: string } | null;
  score: number;
  reason: string;
}

const DRIVER_META: Record<DriverId, { label: string; rule: string }> = {
  SWEEP_ANY: { label: 'SSL/BSL Sweep', rule: 'Recent liquidity pool sweep (<=16 bars)' },
  SWEEP_EQ: { label: 'EQH/EQL Sweep', rule: 'Swept Equal Highs/Lows pool (<=12 bars)' },
  SWEEP_PDHL: { label: 'PDH/PDL Raid', rule: 'Swept Previous Day High/Low (<=22 bars)' },
  SWEEP_PWHL: { label: 'PWH/PWL Raid', rule: 'Swept Previous Week High/Low (<=28 bars)' },
  OB_UNMIT: { label: 'Unmitigated OB', rule: 'Fresh unmitigated Order Block within 2.5x ATR' },
  OB_DISP: { label: 'High-Disp OB', rule: 'Order Block with displacement >= 1.7x ATR' },
  BREAKER: { label: 'Breaker Block', rule: 'Institutional Breaker Block within 2.5x ATR' },
  MITIGATION: { label: 'Mitigation Block', rule: 'Institutional Mitigation Block within 2.5x ATR' },
  FVG_ANY: { label: 'Fair Value Gap', rule: 'Unfilled Fair Value Gap within 2.5x ATR' },
  FVG_CE: { label: 'FVG 50% CE', rule: 'FVG 50% Consequent Encroachment midpoint' },
  IFVG: { label: 'Inverse FVG Flip', rule: 'Inverted FVG polarity flip within 2.5x ATR' },
  SD_FRESH: { label: 'Fresh Supply/Demand', rule: 'Fresh unmitigated Supply/Demand origin' },
  SD_CONT: { label: 'RBR/DBD S/D Zone', rule: 'RBR/DBD continuation Supply/Demand zone' },
  OTE_705: { label: 'OTE 70.5% Pocket', rule: 'Price inside 62%–79% Dealing Range OTE pocket' },
  MSS_BOS: { label: 'Confirmed MSS/BOS', rule: 'Confirmed MSS/CHoCH/BOS structural break (<=10 bars)' },
  SMC_VOL_IMB: { label: 'Vol Imbalance / Rej Block', rule: 'Volume Imbalance or Rejection Block within 2.5x ATR' },
  PA_ENGULF: { label: 'Engulfing Candle', rule: 'Confirmed Bullish/Bearish Engulfing pattern' },
  PA_PINBAR: { label: 'Pin Bar / Hammer', rule: 'Confirmed Hammer / Shooting Star / Doji rejection' },
  PA_STAR: { label: 'Morning/Evening Star', rule: 'Confirmed 3-bar Morning or Evening Star' },
  PA_INSIDE: { label: 'Inside Bar Break', rule: 'Confirmed Inside Bar directional breakout' },
  PA_FAKEY: { label: 'Fakey Trap', rule: 'False inside-bar breakout reversal (Fakey)' },
  PA_MARUBOZU: { label: 'Marubozu Impulse', rule: 'High-body Marubozu directional candle' },
  PA_TWEEZER: { label: 'Tweezer H/L', rule: 'Confirmed Tweezer Top or Tweezer Bottom' },
  PA_RAIL: { label: 'Rail-Track 2-Bar', rule: '2-bar Rail-Track opposing expansion reversal' },
  PA_THREE_SOLDIERS_CROWS: { label: '3 Soldiers / Crows', rule: '3-bar Three White Soldiers / Black Crows momentum' },
  PA_PIERCING_DARKCLOUD: { label: 'Piercing / Dark Cloud', rule: '2-bar Piercing Pattern / Dark Cloud Cover reversal' },
  PA_HARAMI: { label: 'Harami Compression', rule: 'Confirmed Bullish or Bearish Harami reversal' },
  PA_OUTSIDE_BAR: { label: 'Outside Reversal Bar', rule: 'Engulfing Outside Bar key range reversal' },
  PA_EMA20: { label: '20 EMA Pullback', rule: 'Dynamic pullback bounce off 20 EMA' },
  PA_EMA50: { label: '50 EMA Pullback', rule: 'Dynamic trend pullback off 50 EMA' },
  PA_DONCHIAN20: { label: 'Donchian 20 Break', rule: 'Close beyond prior 20-bar Donchian High/Low' },
  PA_TURTLE_SOUP: { label: 'Turtle Soup Trap', rule: 'Failed 20-bar Donchian breakout snapback' },
  PA_NR7_COIL: { label: 'NR7 / Coil Break', rule: 'NR7 or 3-bar compression expansion breakout' },
  DYN_ATR_EXPANSION: { label: 'Dynamic ATR Expansion', rule: 'Volatility compression expanding >=1.35x ATR through 10-bar range' },
  DYN_EMA_CROSS: { label: 'Dynamic 20/50 EMA Cross', rule: 'Dual 20/50 EMA cross or dynamic double-EMA reclaim' },
  DYN_DAILY_BIAS: { label: 'Daily Open Reclaim', rule: 'Intraday Daily Open sweep & directional reclaim' },
  CP_W_PATTERN: { label: 'W Pattern (Bullish)', rule: 'W Pattern double-bottom leg2 reversal or neckline break (BUY)' },
  CP_M_PATTERN: { label: 'M Pattern (Bearish)', rule: 'M Pattern double-top leg2 rejection or neckline break (SELL)' },
  CP_DOUBLE_TB: { label: 'Double Top/Bottom', rule: 'Double Top/Bottom breakout or neckline retest' },
  CP_TRIPLE_TB: { label: 'Triple Top/Bottom', rule: 'Triple Top/Bottom breakout or neckline retest' },
  CP_HS_IHS: { label: 'H&S / Inv H&S', rule: 'Head & Shoulders / Inverse H&S neckline break' },
  CP_SYM_TRI: { label: 'Symmetrical Triangle', rule: 'Symmetrical Triangle compression breakout' },
  CP_DIR_TRI: { label: 'Asc/Desc Triangle', rule: 'Ascending/Descending Triangle breakout' },
  CP_FLAG_PEN: { label: 'Flag / Pennant', rule: 'Bull/Bear Flag or Pennant continuation break' },
  CP_WEDGE: { label: 'Rising/Falling Wedge', rule: 'Rising/Falling Wedge breakout or retest' },
  CP_CUP_ROUND: { label: 'Cup & Handle / Round', rule: 'Cup & Handle or Rounding Bottom breakout' },
  CP_TL_BOUNCE: { label: 'Trendline Bounce', rule: '3-touch diagonal Trendline bounce' },
  CP_TL_BREAK: { label: 'Trendline Break/Retest', rule: 'Broken diagonal Trendline or retest' },
  SR_MAJOR: { label: 'Major S/R Cluster', rule: 'Major S/R cluster (strength >= 60)' },
  SR_VERIFIED: { label: 'Verified S/R (>=2)', rule: 'Multi-rejection S/R zone (rejections >= 2)' },
  SR_FLIP: { label: 'S/R Polarity Flip', rule: 'Broken S/R level retested as new Support/Resistance' },
  SR_BREAKOUT: { label: 'S/R Impulse Break', rule: 'Clean close breakout across horizontal S/R' },
  SR_PDHL: { label: 'PDH/PDL Level', rule: 'Previous Day High/Low bounce or sweep reaction' },
  SR_PWHL: { label: 'PWH/PWL Level', rule: 'Previous Week High/Low macro reaction' },
  SR_PIVOT: { label: 'Floor Pivot S1/R1', rule: 'Daily Floor Pivot (S1/R1/PP) reaction' },
  SR_SESSION: { label: 'Session High/Low', rule: 'Active Session High/Low boundary reaction' },
  SR_SPRING: { label: 'S/R Spring/Upthrust', rule: 'Wyckoff Spring/Upthrust false break across S/R' },
  SR_NESTED_HTF: { label: 'HTF+Exec S/R Overlap', rule: 'Execution S/R overlapping HTF S/R within 0.85x ATR' },
};

const FILTER_META: Record<FilterId, { label: string; rule: string }> = {
  HTF_STRICT: { label: 'HTF Aligned', rule: 'Strict Higher-Timeframe trend alignment' },
  HTF_NONOPP: { label: 'HTF Non-Opposing', rule: 'Higher-Timeframe trend not opposing direction' },
  MSS_SHIFT: { label: 'MSS/CHoCH Shift', rule: 'Confirmed MSS or CHoCH within 10 bars' },
  BOS_CONT: { label: 'BOS Continuation', rule: 'Confirmed Break of Structure within 16 bars' },
  FVG_CONF: { label: 'FVG Confluence', rule: 'Aligned Fair Value Gap within 3.0x ATR' },
  OB_CONF: { label: 'OB Origin', rule: 'Valid aligned Order Block within 3.0x ATR' },
  SR_NEAR: { label: 'S/R Confluence', rule: 'Active horizontal S/R zone within 1.5x ATR' },
  SWEEP_CONF: { label: 'Sweep Confluence', rule: 'Liquidity pool sweep within 18 bars' },
  OTE_QUAD: { label: 'Discount/Premium', rule: 'Price positioned in Discount (Buy) / Premium (Sell)' },
  VOL_125: { label: 'Vol >= 1.25x', rule: 'Bar volume >= 1.25x 20-bar average' },
  VOL_145: { label: 'Vol Climax >= 1.45x', rule: 'Climax volume >= 1.45x 20-bar average' },
  DISP_STRONG: { label: 'Displacement >= 0.4 ATR', rule: 'Directional body >= 0.40x ATR' },
  CANDLE_REV: { label: 'Candle Trigger', rule: 'Confirmed directional candlestick pattern (<=3 bars)' },
  EMA_SLOPE: { label: 'EMA20 Slope', rule: '20 EMA sloping in trade direction' },
  EMA_STACK: { label: 'EMA 20/50 Stack', rule: '20 EMA aligned above/below 50 EMA' },
  EXHAUST_3: { label: '3-Bar Exhaustion', rule: 'Preceded by >= 3 opposing consecutive bars' },
  CONSOL_REGIME: { label: 'Range Regime', rule: 'Execution market structure in consolidation' },
  TREND_REGIME: { label: 'Trend Regime', rule: 'Execution market structure trending in direction' },
  WICK_ABSORB: { label: 'Rejection Wick', rule: 'Opposing rejection wick >= 32% of bar range' },
  TL_NEAR: { label: 'Trendline Support', rule: 'Active aligned diagonal trendline within 1.4x ATR' },
  VOL_EXPAND: { label: 'ATR Expansion >= 1.15x', rule: 'Bar range >= 1.15x ATR dynamic volatility surge' },
  VOL_COMPRESS: { label: 'Prior Compression', rule: 'Preceded by NR4/NR7 or tight range squeeze (<0.85x ATR)' },
  PRICE_EMA20: { label: 'Dynamic 20 EMA Side', rule: 'Close aligned above/below 20 EMA' },
  DAILY_BIAS: { label: 'Daily Open Bias', rule: 'Price aligned with intraday Daily Open session bias' },
  SD_CONFLUENCE: { label: 'S/D Zone Confluence', rule: 'Fresh/tested Supply or Demand zone within 2.8x ATR' },
  FVG_OR_OB: { label: 'SMC Zone (OB/FVG)', rule: 'Valid aligned Order Block or Fair Value Gap within 3.0x ATR' },
};

const EXEC_META: Record<
  ExecProfileId,
  { tag: string; mode: 'market_close' | 'limit_retest'; atrMult: number; minRrFloor: number; riskRule: string }
> = {
  MARKET_STD: {
    tag: 'Standard Close',
    mode: 'market_close',
    atrMult: 0.45,
    minRrFloor: 1.4,
    riskRule: 'Market next-open fill · 0.45x ATR SL buffer · Config Min R:R',
  },
  MARKET_TIGHT: {
    tag: 'Tight SL',
    mode: 'market_close',
    atrMult: 0.32,
    minRrFloor: 1.8,
    riskRule: 'Tight 0.32x ATR structural SL · Min 1.8R TP1 target',
  },
  MARKET_RUNNER: {
    tag: 'Swing Runner',
    mode: 'market_close',
    atrMult: 0.55,
    minRrFloor: 2.2,
    riskRule: 'Wide 0.55x ATR SL buffer · High-RR >= 2.2R structural target',
  },
  LIMIT_RETEST: {
    tag: 'Limit Retest',
    mode: 'limit_retest',
    atrMult: 0.4,
    minRrFloor: 1.7,
    riskRule: 'Limit order at zone/50% bar retest · 0.40x ATR SL · Min 1.7R',
  },
};

function buildComboSpecs(): ComboSpec[] {
  const specs: ComboSpec[] = [];
  const usedIds = new Set<string>();

  const pushSpec = (
    category: BacktestStrategyCategory,
    driver: DriverId,
    filter: FilterId,
    exec: ExecProfileId,
    secondFilter?: FilterId
  ) => {
    const id = secondFilter
      ? `CMB_${driver}_${filter}_${secondFilter}_${exec}`
      : `CMB_${driver}_${filter}_${exec}`;
    if (usedIds.has(id)) return;
    usedIds.add(id);

    const dm = DRIVER_META[driver];
    const fm = FILTER_META[filter];
    const sm = secondFilter ? FILTER_META[secondFilter] : null;
    const em = EXEC_META[exec];

    const name = sm
      ? `${dm.label} + ${fm.label} + ${sm.label} (${em.tag})`
      : `${dm.label} + ${fm.label} (${em.tag})`;

    const entryRules = sm ? [dm.rule, fm.rule, sm.rule] : [dm.rule, fm.rule];

    specs.push({
      id,
      name,
      category,
      driver,
      filter,
      secondFilter,
      exec,
      scoreBonus: sm ? 7 : 3,
      summary: `${category} combination pairing ${dm.label} with ${fm.label}${sm ? ` and ${sm.label}` : ''} using ${em.tag} execution.`,
      entryRules,
      riskRules: [em.riskRule, 'Structure-backed TP1–TP3 scaling & ATR invalidation buffer'],
    });
  };

  // -------------------------------------------------------------------------
  // 1. SMC COMBINATIONS: 115 strategies (total SMC = 30 + 115 = 145)
  // -------------------------------------------------------------------------
  const smcCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    ['SWEEP_ANY', ['HTF_STRICT', 'MSS_SHIFT', 'FVG_CONF', 'OB_CONF', 'VOL_125', 'CANDLE_REV', 'OTE_QUAD'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['SWEEP_EQ', ['HTF_NONOPP', 'MSS_SHIFT', 'FVG_CONF', 'CANDLE_REV', 'VOL_125'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['SWEEP_PDHL', ['HTF_NONOPP', 'MSS_SHIFT', 'OB_CONF', 'CANDLE_REV'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SWEEP_PWHL', ['HTF_NONOPP', 'MSS_SHIFT', 'CANDLE_REV'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['OB_UNMIT', ['HTF_STRICT', 'FVG_CONF', 'OTE_QUAD', 'SWEEP_CONF', 'CANDLE_REV', 'VOL_125'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['OB_DISP', ['HTF_STRICT', 'FVG_CONF', 'OTE_QUAD', 'BOS_CONT', 'VOL_125'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['BREAKER', ['HTF_NONOPP', 'FVG_CONF', 'MSS_SHIFT', 'CANDLE_REV', 'VOL_125'], ['LIMIT_RETEST', 'MARKET_STD']],
    ['MITIGATION', ['HTF_STRICT', 'BOS_CONT', 'OTE_QUAD', 'CANDLE_REV'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['FVG_ANY', ['HTF_STRICT', 'BOS_CONT', 'OB_CONF', 'OTE_QUAD', 'VOL_125', 'CANDLE_REV'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['FVG_CE', ['HTF_STRICT', 'MSS_SHIFT', 'OTE_QUAD', 'SWEEP_CONF', 'CANDLE_REV'], ['LIMIT_RETEST']],
    ['IFVG', ['HTF_NONOPP', 'MSS_SHIFT', 'SWEEP_CONF', 'VOL_125', 'CANDLE_REV'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['SD_FRESH', ['HTF_STRICT', 'BOS_CONT', 'FVG_CONF', 'OTE_QUAD', 'CANDLE_REV'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['SD_CONT', ['HTF_STRICT', 'BOS_CONT', 'EMA_STACK', 'VOL_125'], ['LIMIT_RETEST', 'MARKET_STD']],
    ['OTE_705', ['HTF_STRICT', 'OB_CONF', 'FVG_CONF', 'SWEEP_CONF', 'CANDLE_REV'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['MSS_BOS', ['HTF_STRICT', 'OTE_QUAD', 'FVG_CONF', 'VOL_125'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
  ];
  let smcCount = 0;
  outerSmc: for (const [drv, flts, execs] of smcCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (smcCount >= 145) break outerSmc;
        pushSpec('SMC', drv, flt, ex);
        smcCount += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. PRICE ACTION COMBINATIONS: up to 120 strategies
  // -------------------------------------------------------------------------
  const paCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    ['PA_ENGULF', ['HTF_STRICT', 'EMA_SLOPE', 'EMA_STACK', 'VOL_125', 'OTE_QUAD', 'EXHAUST_3'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_PINBAR', ['HTF_STRICT', 'EMA_SLOPE', 'VOL_125', 'OTE_QUAD', 'EXHAUST_3', 'WICK_ABSORB'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_STAR', ['HTF_NONOPP', 'VOL_125', 'OTE_QUAD', 'EMA_SLOPE'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_INSIDE', ['HTF_STRICT', 'EMA_STACK', 'VOL_125', 'TREND_REGIME'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_FAKEY', ['HTF_NONOPP', 'VOL_125', 'OTE_QUAD', 'WICK_ABSORB'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_MARUBOZU', ['HTF_STRICT', 'VOL_145', 'EMA_STACK', 'BOS_CONT'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_TWEEZER', ['HTF_NONOPP', 'OTE_QUAD', 'EXHAUST_3', 'VOL_125'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['PA_RAIL', ['HTF_NONOPP', 'EXHAUST_3', 'VOL_125', 'OTE_QUAD'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_EMA20', ['HTF_STRICT', 'EMA_STACK', 'VOL_125', 'WICK_ABSORB', 'DISP_STRONG'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_EMA50', ['HTF_STRICT', 'EMA_SLOPE', 'VOL_125', 'WICK_ABSORB'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_DONCHIAN20', ['HTF_STRICT', 'VOL_145', 'EMA_STACK', 'DISP_STRONG'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_TURTLE_SOUP', ['HTF_NONOPP', 'VOL_125', 'OTE_QUAD', 'WICK_ABSORB'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['PA_NR7_COIL', ['HTF_STRICT', 'EMA_STACK', 'VOL_125', 'DISP_STRONG'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
  ];
  let paCount = 0;
  outerPa: for (const [drv, flts, execs] of paCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (paCount >= 120) break outerPa;
        pushSpec('Price Action', drv, flt, ex);
        paCount += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. CHART PATTERNS COMBINATIONS: 80 strategies
  // -------------------------------------------------------------------------
  const cpCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    ['CP_DOUBLE_TB', ['HTF_NONOPP', 'VOL_125', 'CANDLE_REV', 'DISP_STRONG'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_TRIPLE_TB', ['HTF_NONOPP', 'VOL_125', 'CANDLE_REV', 'DISP_STRONG'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_HS_IHS', ['HTF_NONOPP', 'VOL_125', 'CANDLE_REV', 'EMA_SLOPE'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_SYM_TRI', ['HTF_STRICT', 'VOL_125', 'EMA_STACK', 'DISP_STRONG'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_DIR_TRI', ['HTF_STRICT', 'VOL_125', 'EMA_STACK', 'CANDLE_REV'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_FLAG_PEN', ['HTF_STRICT', 'VOL_125', 'EMA_STACK', 'BOS_CONT'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_WEDGE', ['HTF_NONOPP', 'VOL_125', 'CANDLE_REV', 'OTE_QUAD'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_CUP_ROUND', ['HTF_STRICT', 'VOL_125', 'EMA_STACK', 'DISP_STRONG'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_TL_BOUNCE', ['HTF_STRICT', 'CANDLE_REV', 'VOL_125', 'EMA_SLOPE'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_TL_BREAK', ['HTF_STRICT', 'VOL_125', 'DISP_STRONG', 'BOS_CONT'], ['MARKET_STD', 'LIMIT_RETEST']],
  ];
  let cpCount = 0;
  outerCp: for (const [drv, flts, execs] of cpCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (cpCount >= 80) break outerCp;
        pushSpec('Chart Patterns', drv, flt, ex);
        cpCount += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. SUPPORT & RESISTANCE COMBINATIONS: 82 strategies
  // -------------------------------------------------------------------------
  const srCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    ['SR_MAJOR', ['HTF_STRICT', 'CONSOL_REGIME', 'CANDLE_REV', 'VOL_125', 'WICK_ABSORB'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['SR_VERIFIED', ['HTF_NONOPP', 'CANDLE_REV', 'VOL_125', 'WICK_ABSORB'], ['LIMIT_RETEST', 'MARKET_STD']],
    ['SR_FLIP', ['HTF_STRICT', 'CANDLE_REV', 'VOL_125', 'TREND_REGIME'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['SR_BREAKOUT', ['HTF_STRICT', 'VOL_145', 'DISP_STRONG', 'EMA_STACK'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_PDHL', ['HTF_NONOPP', 'CANDLE_REV', 'VOL_125', 'WICK_ABSORB'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['SR_PWHL', ['HTF_NONOPP', 'CANDLE_REV', 'VOL_125', 'OTE_QUAD'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_PIVOT', ['HTF_NONOPP', 'CONSOL_REGIME', 'CANDLE_REV', 'VOL_125'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['SR_SESSION', ['HTF_NONOPP', 'CANDLE_REV', 'WICK_ABSORB', 'VOL_125'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['SR_SPRING', ['HTF_NONOPP', 'WICK_ABSORB', 'VOL_125', 'CANDLE_REV'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_NESTED_HTF', ['HTF_STRICT', 'CANDLE_REV', 'VOL_125', 'WICK_ABSORB'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
  ];
  let srCount = 0;
  outerSr: for (const [drv, flts, execs] of srCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (srCount >= 82) break outerSr;
        pushSpec('Support & Resistance', drv, flt, ex);
        srCount += 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. HYBRID MULTI-PILLAR COMBINATIONS: 80 strategies
  // -------------------------------------------------------------------------
  const hybridTriples: Array<[DriverId, FilterId, FilterId, ExecProfileId[]]> = [
    ['SWEEP_ANY', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT', 'LIMIT_RETEST']],
    ['SWEEP_ANY', 'SR_NEAR', 'OB_CONF', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SWEEP_ANY', 'SR_NEAR', 'FVG_CONF', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SWEEP_ANY', 'TL_NEAR', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_RUNNER']],
    ['SWEEP_PDHL', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'MARKET_RUNNER']],
    ['SWEEP_PDHL', 'OB_CONF', 'MSS_SHIFT', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SWEEP_EQ', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT']],
    ['OB_UNMIT', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['OB_UNMIT', 'SR_NEAR', 'HTF_STRICT', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['OB_UNMIT', 'TL_NEAR', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['OB_DISP', 'SR_NEAR', 'VOL_125', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['OB_DISP', 'EMA_STACK', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['FVG_ANY', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['FVG_ANY', 'TL_NEAR', 'HTF_STRICT', ['MARKET_STD', 'LIMIT_RETEST']],
    ['FVG_CE', 'SR_NEAR', 'HTF_STRICT', ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['BREAKER', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['BREAKER', 'FVG_CONF', 'VOL_125', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SD_FRESH', 'SR_NEAR', 'CANDLE_REV', ['LIMIT_RETEST', 'MARKET_STD']],
    ['SD_FRESH', 'TL_NEAR', 'HTF_STRICT', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['OTE_705', 'SR_NEAR', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['OTE_705', 'OB_CONF', 'EMA_SLOPE', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['PA_ENGULF', 'OB_CONF', 'HTF_STRICT', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_ENGULF', 'FVG_CONF', 'SWEEP_CONF', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_PINBAR', 'OB_CONF', 'OTE_QUAD', ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_PINBAR', 'SWEEP_CONF', 'SR_NEAR', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_DONCHIAN20', 'BOS_CONT', 'OB_CONF', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_DONCHIAN20', 'FVG_CONF', 'VOL_125', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_NR7_COIL', 'FVG_CONF', 'BOS_CONT', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_NR7_COIL', 'OB_CONF', 'HTF_STRICT', ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_TL_BREAK', 'OB_CONF', 'HTF_STRICT', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_TL_BREAK', 'FVG_CONF', 'VOL_125', ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_TL_BOUNCE', 'OB_CONF', 'OTE_QUAD', ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['CP_DOUBLE_TB', 'SWEEP_CONF', 'FVG_CONF', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_FLAG_PEN', 'OB_CONF', 'HTF_STRICT', ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['SR_FLIP', 'OB_CONF', 'HTF_STRICT', ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['SR_FLIP', 'FVG_CONF', 'VOL_125', ['LIMIT_RETEST', 'MARKET_STD']],
    ['SR_SPRING', 'SWEEP_CONF', 'FVG_CONF', ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_MAJOR', 'OTE_QUAD', 'OB_CONF', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['PA_TURTLE_SOUP', 'SWEEP_CONF', 'SR_NEAR', ['MARKET_TIGHT', 'MARKET_STD']],
    ['SR_NESTED_HTF', 'OB_CONF', 'CANDLE_REV', ['LIMIT_RETEST', 'MARKET_RUNNER']],
  ];

  let hybCount = 0;
  outerHyb: for (const [drv, f1, f2, execs] of hybridTriples) {
    for (const ex of execs) {
      if (hybCount >= 80) break outerHyb;
      pushSpec('Hybrid SMC/PA', drv, f1, ex, f2);
      hybCount += 1;
    }
  }

  // -------------------------------------------------------------------------
  // 6. EXPANSION WAVE (+540+ MIX, DYNAMIC, W/M PATTERN & CANDLE STRATEGIES)
  // -------------------------------------------------------------------------
  // 6A. Dedicated W-Pattern, M-Pattern & Expanded Chart Patterns (+140)
  const cpExpandCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    [
      'CP_W_PATTERN',
      [
        'HTF_NONOPP',
        'HTF_STRICT',
        'MSS_SHIFT',
        'FVG_CONF',
        'OB_CONF',
        'SR_NEAR',
        'SWEEP_CONF',
        'CANDLE_REV',
        'VOL_125',
        'DISP_STRONG',
        'EMA_SLOPE',
        'OTE_QUAD',
        'VOL_EXPAND',
        'DAILY_BIAS',
        'SD_CONFLUENCE',
        'WICK_ABSORB',
      ],
      ['MARKET_STD', 'MARKET_TIGHT', 'LIMIT_RETEST', 'MARKET_RUNNER'],
    ],
    [
      'CP_M_PATTERN',
      [
        'HTF_NONOPP',
        'HTF_STRICT',
        'MSS_SHIFT',
        'FVG_CONF',
        'OB_CONF',
        'SR_NEAR',
        'SWEEP_CONF',
        'CANDLE_REV',
        'VOL_125',
        'DISP_STRONG',
        'EMA_SLOPE',
        'OTE_QUAD',
        'VOL_EXPAND',
        'DAILY_BIAS',
        'SD_CONFLUENCE',
        'WICK_ABSORB',
      ],
      ['MARKET_STD', 'MARKET_TIGHT', 'LIMIT_RETEST', 'MARKET_RUNNER'],
    ],
    ['CP_DOUBLE_TB', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'OTE_QUAD', 'SWEEP_CONF'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_TRIPLE_TB', ['VOL_EXPAND', 'OTE_QUAD', 'SD_CONFLUENCE', 'WICK_ABSORB'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['CP_HS_IHS', ['VOL_EXPAND', 'DAILY_BIAS', 'OTE_QUAD', 'SWEEP_CONF'], ['MARKET_RUNNER', 'MARKET_TIGHT']],
    ['CP_SYM_TRI', ['VOL_COMPRESS', 'PRICE_EMA20', 'DAILY_BIAS', 'BOS_CONT'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_DIR_TRI', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'BOS_CONT'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_FLAG_PEN', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SD_CONFLUENCE'], ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_WEDGE', ['VOL_EXPAND', 'SWEEP_CONF', 'WICK_ABSORB', 'DAILY_BIAS'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_CUP_ROUND', ['VOL_EXPAND', 'PRICE_EMA20', 'OTE_QUAD'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_TL_BOUNCE', ['PRICE_EMA20', 'DAILY_BIAS', 'WICK_ABSORB', 'OTE_QUAD'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_TL_BREAK', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SD_CONFLUENCE'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
  ];
  let cpExpandCount = 0;
  outerCpExp: for (const [drv, flts, execs] of cpExpandCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (cpExpandCount >= 145) break outerCpExp;
        const before = specs.length;
        pushSpec('Chart Patterns', drv, flt, ex);
        if (specs.length > before) cpExpandCount += 1;
      }
    }
  }

  // 6B. Expanded Candlestick Patterns & Dynamic Volatility/EMA Strategies (+125)
  const paExpandCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    [
      'PA_THREE_SOLDIERS_CROWS',
      ['HTF_NONOPP', 'HTF_STRICT', 'VOL_125', 'EMA_STACK', 'PRICE_EMA20', 'DAILY_BIAS', 'VOL_EXPAND', 'BOS_CONT'],
      ['MARKET_STD', 'MARKET_TIGHT', 'MARKET_RUNNER'],
    ],
    [
      'PA_PIERCING_DARKCLOUD',
      ['HTF_NONOPP', 'OTE_QUAD', 'EXHAUST_3', 'VOL_125', 'SR_NEAR', 'WICK_ABSORB', 'DAILY_BIAS'],
      ['MARKET_STD', 'LIMIT_RETEST', 'MARKET_TIGHT'],
    ],
    [
      'PA_HARAMI',
      ['HTF_NONOPP', 'VOL_COMPRESS', 'OTE_QUAD', 'SR_NEAR', 'EMA_SLOPE', 'DAILY_BIAS'],
      ['MARKET_TIGHT', 'LIMIT_RETEST', 'MARKET_STD'],
    ],
    [
      'PA_OUTSIDE_BAR',
      ['HTF_NONOPP', 'VOL_125', 'VOL_EXPAND', 'SR_NEAR', 'WICK_ABSORB', 'PRICE_EMA20'],
      ['MARKET_STD', 'MARKET_RUNNER', 'MARKET_TIGHT'],
    ],
    [
      'DYN_ATR_EXPANSION',
      ['HTF_STRICT', 'VOL_125', 'VOL_145', 'EMA_STACK', 'PRICE_EMA20', 'DAILY_BIAS', 'BOS_CONT'],
      ['MARKET_STD', 'MARKET_TIGHT', 'MARKET_RUNNER'],
    ],
    [
      'DYN_EMA_CROSS',
      ['HTF_STRICT', 'VOL_125', 'VOL_EXPAND', 'DAILY_BIAS', 'DISP_STRONG', 'TREND_REGIME'],
      ['MARKET_STD', 'LIMIT_RETEST', 'MARKET_RUNNER'],
    ],
    [
      'DYN_DAILY_BIAS',
      ['HTF_NONOPP', 'VOL_125', 'WICK_ABSORB', 'PRICE_EMA20', 'CANDLE_REV', 'DISP_STRONG'],
      ['MARKET_STD', 'MARKET_TIGHT', 'MARKET_RUNNER'],
    ],
    ['PA_ENGULF', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SR_NEAR'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['PA_PINBAR', ['VOL_COMPRESS', 'PRICE_EMA20', 'DAILY_BIAS', 'SR_NEAR'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['PA_EMA20', ['DAILY_BIAS', 'OTE_QUAD', 'VOL_COMPRESS'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['PA_DONCHIAN20', ['VOL_EXPAND', 'VOL_COMPRESS', 'DAILY_BIAS'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['PA_NR7_COIL', ['DAILY_BIAS', 'PRICE_EMA20', 'SR_NEAR'], ['MARKET_STD', 'LIMIT_RETEST']],
  ];
  let paExpandCount = 0;
  outerPaExp: for (const [drv, flts, execs] of paExpandCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (paExpandCount >= 125) break outerPaExp;
        const before = specs.length;
        pushSpec('Price Action', drv, flt, ex);
        if (specs.length > before) paExpandCount += 1;
      }
    }
  }

  // 6C. Expanded SMC Volume Imbalance, Rejection & Dynamic Regimes (+95)
  const smcExpandCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    [
      'SMC_VOL_IMB',
      ['HTF_NONOPP', 'HTF_STRICT', 'MSS_SHIFT', 'BOS_CONT', 'OTE_QUAD', 'SWEEP_CONF', 'VOL_125', 'PRICE_EMA20'],
      ['LIMIT_RETEST', 'MARKET_STD', 'MARKET_TIGHT'],
    ],
    ['SWEEP_ANY', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'WICK_ABSORB', 'SD_CONFLUENCE'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['SWEEP_EQ', ['VOL_EXPAND', 'OTE_QUAD', 'PRICE_EMA20', 'WICK_ABSORB'], ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['SWEEP_PDHL', ['VOL_EXPAND', 'WICK_ABSORB', 'OTE_QUAD', 'FVG_OR_OB'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['OB_UNMIT', ['VOL_COMPRESS', 'PRICE_EMA20', 'DAILY_BIAS', 'SD_CONFLUENCE'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['OB_DISP', ['VOL_EXPAND', 'DAILY_BIAS', 'WICK_ABSORB', 'SD_CONFLUENCE'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['BREAKER', ['VOL_EXPAND', 'OTE_QUAD', 'PRICE_EMA20', 'DAILY_BIAS'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['FVG_ANY', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SWEEP_CONF'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['FVG_CE', ['PRICE_EMA20', 'DAILY_BIAS', 'VOL_COMPRESS', 'SD_CONFLUENCE'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['IFVG', ['VOL_EXPAND', 'OTE_QUAD', 'PRICE_EMA20', 'DAILY_BIAS'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['SD_FRESH', ['VOL_COMPRESS', 'PRICE_EMA20', 'DAILY_BIAS', 'SWEEP_CONF'], ['MARKET_TIGHT', 'MARKET_STD']],
    ['OTE_705', ['VOL_COMPRESS', 'DAILY_BIAS', 'MSS_SHIFT', 'WICK_ABSORB'], ['MARKET_STD', 'MARKET_TIGHT']],
    ['MSS_BOS', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SD_CONFLUENCE'], ['MARKET_STD', 'LIMIT_RETEST']],
  ];
  let smcExpandCount = 0;
  outerSmcExp: for (const [drv, flts, execs] of smcExpandCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (smcExpandCount >= 95) break outerSmcExp;
        const before = specs.length;
        pushSpec('SMC', drv, flt, ex);
        if (specs.length > before) smcExpandCount += 1;
      }
    }
  }

  // 6D. Expanded Support & Resistance Dynamic Pairs (+65)
  const srExpandCombos: Array<[DriverId, FilterId[], ExecProfileId[]]> = [
    ['SR_MAJOR', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'SD_CONFLUENCE'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_VERIFIED', ['OTE_QUAD', 'PRICE_EMA20', 'DAILY_BIAS', 'VOL_COMPRESS'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['SR_FLIP', ['VOL_EXPAND', 'PRICE_EMA20', 'DAILY_BIAS', 'OTE_QUAD'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_BREAKOUT', ['PRICE_EMA20', 'DAILY_BIAS', 'VOL_COMPRESS', 'SD_CONFLUENCE'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['SR_PDHL', ['OTE_QUAD', 'PRICE_EMA20', 'VOL_EXPAND', 'SD_CONFLUENCE'], ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['SR_PWHL', ['PRICE_EMA20', 'VOL_EXPAND', 'MSS_SHIFT'], ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['SR_PIVOT', ['PRICE_EMA20', 'DAILY_BIAS', 'WICK_ABSORB'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_SESSION', ['DAILY_BIAS', 'OTE_QUAD', 'VOL_EXPAND'], ['MARKET_STD', 'MARKET_RUNNER']],
    ['SR_SPRING', ['OTE_QUAD', 'PRICE_EMA20', 'DAILY_BIAS'], ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['SR_NESTED_HTF', ['OTE_QUAD', 'PRICE_EMA20', 'SD_CONFLUENCE'], ['MARKET_STD', 'MARKET_TIGHT']],
  ];
  let srExpandCount = 0;
  outerSrExp: for (const [drv, flts, execs] of srExpandCombos) {
    for (const flt of flts) {
      for (const ex of execs) {
        if (srExpandCount >= 65) break outerSrExp;
        const before = specs.length;
        pushSpec('Support & Resistance', drv, flt, ex);
        if (specs.length > before) srExpandCount += 1;
      }
    }
  }

  // 6E. Expanded 3-Pillar Dynamic + W/M Pattern + Candle + SMC Hybrids (+140)
  const hybridExpandTriples: Array<[DriverId, FilterId, FilterId, ExecProfileId[]]> = [
    ['CP_W_PATTERN', 'SWEEP_CONF', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_W_PATTERN', 'OB_CONF', 'HTF_NONOPP', ['MARKET_STD', 'LIMIT_RETEST', 'MARKET_RUNNER']],
    ['CP_W_PATTERN', 'FVG_CONF', 'VOL_125', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_W_PATTERN', 'SR_NEAR', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_W_PATTERN', 'OTE_QUAD', 'WICK_ABSORB', ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_W_PATTERN', 'PRICE_EMA20', 'VOL_EXPAND', ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_M_PATTERN', 'SWEEP_CONF', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_M_PATTERN', 'OB_CONF', 'HTF_NONOPP', ['MARKET_STD', 'LIMIT_RETEST', 'MARKET_RUNNER']],
    ['CP_M_PATTERN', 'FVG_CONF', 'VOL_125', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_M_PATTERN', 'SR_NEAR', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_TIGHT', 'MARKET_RUNNER']],
    ['CP_M_PATTERN', 'OTE_QUAD', 'WICK_ABSORB', ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['CP_M_PATTERN', 'PRICE_EMA20', 'VOL_EXPAND', ['MARKET_STD', 'MARKET_RUNNER']],
    ['DYN_ATR_EXPANSION', 'FVG_OR_OB', 'HTF_STRICT', ['MARKET_STD', 'MARKET_TIGHT']],
    ['DYN_ATR_EXPANSION', 'BOS_CONT', 'EMA_STACK', ['MARKET_STD', 'MARKET_RUNNER']],
    ['DYN_ATR_EXPANSION', 'SR_NEAR', 'VOL_125', ['MARKET_STD', 'MARKET_TIGHT']],
    ['DYN_EMA_CROSS', 'FVG_OR_OB', 'VOL_125', ['MARKET_STD', 'LIMIT_RETEST']],
    ['DYN_EMA_CROSS', 'HTF_STRICT', 'OTE_QUAD', ['MARKET_STD', 'MARKET_RUNNER']],
    ['DYN_EMA_CROSS', 'SD_CONFLUENCE', 'DISP_STRONG', ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['DYN_DAILY_BIAS', 'SWEEP_CONF', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_TIGHT']],
    ['DYN_DAILY_BIAS', 'FVG_CONF', 'SR_NEAR', ['MARKET_STD', 'LIMIT_RETEST']],
    ['DYN_DAILY_BIAS', 'OB_CONF', 'CANDLE_REV', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_THREE_SOLDIERS_CROWS', 'FVG_OR_OB', 'HTF_STRICT', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_THREE_SOLDIERS_CROWS', 'BOS_CONT', 'VOL_125', ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['PA_THREE_SOLDIERS_CROWS', 'DAILY_BIAS', 'EMA_STACK', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_PIERCING_DARKCLOUD', 'SWEEP_CONF', 'SR_NEAR', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_PIERCING_DARKCLOUD', 'OB_CONF', 'OTE_QUAD', ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_HARAMI', 'OB_CONF', 'HTF_NONOPP', ['MARKET_TIGHT', 'LIMIT_RETEST']],
    ['PA_HARAMI', 'FVG_CONF', 'VOL_COMPRESS', ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_OUTSIDE_BAR', 'SWEEP_CONF', 'FVG_OR_OB', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_OUTSIDE_BAR', 'SR_NEAR', 'HTF_NONOPP', ['MARKET_STD', 'MARKET_TIGHT']],
    ['SMC_VOL_IMB', 'MSS_SHIFT', 'HTF_NONOPP', ['LIMIT_RETEST', 'MARKET_STD']],
    ['SMC_VOL_IMB', 'SR_NEAR', 'CANDLE_REV', ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['SMC_VOL_IMB', 'SWEEP_CONF', 'OTE_QUAD', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['SWEEP_ANY', 'MSS_SHIFT', 'VOL_EXPAND', ['MARKET_STD', 'MARKET_TIGHT']],
    ['SWEEP_ANY', 'FVG_CONF', 'PRICE_EMA20', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SWEEP_PDHL', 'FVG_CONF', 'DAILY_BIAS', ['MARKET_STD', 'MARKET_RUNNER']],
    ['OB_UNMIT', 'MSS_SHIFT', 'DAILY_BIAS', ['LIMIT_RETEST', 'MARKET_STD']],
    ['OB_DISP', 'FVG_CONF', 'PRICE_EMA20', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['FVG_ANY', 'MSS_SHIFT', 'PRICE_EMA20', ['MARKET_STD', 'LIMIT_RETEST']],
    ['FVG_CE', 'SWEEP_CONF', 'CANDLE_REV', ['LIMIT_RETEST', 'MARKET_TIGHT']],
    ['BREAKER', 'SWEEP_CONF', 'PRICE_EMA20', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SD_FRESH', 'SWEEP_CONF', 'DISP_STRONG', ['LIMIT_RETEST', 'MARKET_RUNNER']],
    ['OTE_705', 'SWEEP_CONF', 'MSS_SHIFT', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_HS_IHS', 'FVG_OR_OB', 'VOL_125', ['MARKET_STD', 'LIMIT_RETEST']],
    ['CP_WEDGE', 'FVG_OR_OB', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_TIGHT']],
    ['CP_DIR_TRI', 'FVG_OR_OB', 'VOL_EXPAND', ['MARKET_STD', 'MARKET_RUNNER']],
    ['CP_TL_BREAK', 'SD_CONFLUENCE', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT']],
    ['CP_TL_BOUNCE', 'SWEEP_CONF', 'CANDLE_REV', ['MARKET_STD', 'LIMIT_RETEST']],
    ['SR_FLIP', 'MSS_SHIFT', 'PRICE_EMA20', ['LIMIT_RETEST', 'MARKET_STD']],
    ['SR_SPRING', 'OB_CONF', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT']],
    ['SR_PDHL', 'SWEEP_CONF', 'MSS_SHIFT', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_ENGULF', 'SWEEP_CONF', 'DAILY_BIAS', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_PINBAR', 'FVG_CONF', 'DAILY_BIAS', ['MARKET_STD', 'LIMIT_RETEST']],
    ['PA_STAR', 'OB_CONF', 'SWEEP_CONF', ['MARKET_STD', 'MARKET_RUNNER']],
    ['PA_FAKEY', 'SR_NEAR', 'FVG_OR_OB', ['MARKET_TIGHT', 'MARKET_RUNNER']],
    ['PA_TURTLE_SOUP', 'OB_CONF', 'CANDLE_REV', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_RAIL', 'SR_NEAR', 'SWEEP_CONF', ['MARKET_STD', 'MARKET_TIGHT']],
    ['PA_NR7_COIL', 'TL_NEAR', 'VOL_125', ['MARKET_TIGHT', 'MARKET_RUNNER']],
  ];

  let hybExpandCount = 0;
  outerHybExp: for (const [drv, f1, f2, execs] of hybridExpandTriples) {
    for (const ex of execs) {
      if (hybExpandCount >= 145) break outerHybExp;
      const before = specs.length;
      pushSpec('Hybrid SMC/PA', drv, f1, ex, f2);
      if (specs.length > before) hybExpandCount += 1;
    }
  }

  return specs;
}

export const COMBO_STRATEGY_SPECS: ComboSpec[] = buildComboSpecs();

export const COMBO_STRATEGY_DEFINITIONS: BacktestStrategyDefinition[] =
  COMBO_STRATEGY_SPECS.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    summary: s.summary,
    entryRules: s.entryRules,
    riskRules: s.riskRules,
  }));

const COMBO_SPEC_MAP = new Map<string, ComboSpec>(
  COMBO_STRATEGY_SPECS.map((s) => [s.id, s])
);

function trendLabel(d: Direction): 'bullish' | 'bearish' {
  return d === 'BUY' ? 'bullish' : 'bearish';
}

function oppTrend(d: Direction): 'bullish' | 'bearish' {
  return d === 'BUY' ? 'bearish' : 'bullish';
}

function evaluateDriver(
  driver: DriverId,
  d: Direction,
  deps: ComboEvalDeps<unknown>
): DriverHit | null {
  const { ctx, findProtectedInvalidation } = deps;
  const { execSnap, htfSnap, bar, prevBar, atr, tfSec, precision: p, price } = ctx;
  const isBuy = d === 'BUY';
  const tgt = trendLabel(d);
  const dr = execSnap.dealingRange;
  const anchors = execSnap.sessionAnchors;

  const dirCloseOk = (minBodyAtr = 0.1) =>
    isBuy ? ctx.displacementSigned >= minBodyAtr : ctx.displacementSigned <= -minBodyAtr;

  const recentSweeps = (maxBars: number, kinds?: LiquidityPool['kind'][]) => {
    const allowed = kinds
      ? new Set(kinds)
      : new Set<LiquidityPool['kind']>(
          isBuy
            ? ['sell_side', 'equal_lows', 'pdl', 'pwl', 'inducement', 'internal', 'external']
            : ['buy_side', 'equal_highs', 'pdh', 'pwh', 'inducement', 'internal', 'external']
        );
    return ctx.recentSweeps.filter(
      (l) =>
        l.sweepTime !== null &&
        bar.time - l.sweepTime <= tfSec * maxBars &&
        allowed.has(l.kind)
    );
  };

  const recentObs = (
    maxAtr: number,
    opts?: { unmitigatedOnly?: boolean; minDisp?: number; kinds?: OrderBlock['kind'][] }
  ) =>
    ctx.activeObs
      .filter((ob) => {
        if (opts?.unmitigatedOnly && ob.mitigated) return false;
        if (opts?.minDisp && ob.displacementAtr < opts.minDisp) return false;
        if (opts?.kinds) {
          if (!opts.kinds.includes(ob.kind)) return false;
        } else if (isBuy ? ob.kind !== 'bullish_ob' : ob.kind !== 'bearish_ob') {
          return false;
        }
        return isBuy
          ? ob.upper <= price + atr * 0.35 && price - ob.upper <= atr * maxAtr
          : ob.lower >= price - atr * 0.35 && ob.lower - price <= atr * maxAtr;
      })
      .sort((a, b) => Math.abs(a.midpoint - price) - Math.abs(b.midpoint - price));

  const recentFvgs = (maxAtr: number, kinds?: FairValueGap['kind'][], allowFilled = false) =>
    ctx.activeFvgs
      .filter((f) => {
        if (!allowFilled && (f.status === 'fully_filled' || f.status === 'inverted')) return false;
        if (kinds && !kinds.includes(f.kind)) return false;
        if (!kinds && (isBuy ? f.kind !== 'bullish_fvg' : f.kind !== 'bearish_fvg')) return false;
        return Math.abs(f.consequentEncroachment - price) <= atr * maxAtr;
      })
      .sort((a, b) => Math.abs(a.consequentEncroachment - price) - Math.abs(b.consequentEncroachment - price));

  const recentSrs = (
    maxAtr: number,
    opts?: {
      minStrength?: number;
      minRejections?: number;
      sources?: SRZone['source'][];
      includeBroken?: boolean;
    }
  ) => {
    const pool = opts?.includeBroken ? [...ctx.activeSrs, ...ctx.brokenOrRetestSrs] : ctx.activeSrs;
    return pool
      .filter((sr) => {
        if (!opts?.includeBroken && sr.kind !== (isBuy ? 'support' : 'resistance')) return false;
        if (opts?.minStrength && sr.strengthScore < opts.minStrength) return false;
        if (opts?.minRejections && sr.rejections < opts.minRejections) return false;
        if (opts?.sources && !opts.sources.includes(sr.source)) return false;
        return price >= sr.lower - atr * maxAtr && price <= sr.upper + atr * maxAtr;
      })
      .sort((a, b) => b.strengthScore - a.strengthScore);
  };

  const recentCandles = (maxBars: number, names?: CandlestickPattern['name'][]) => {
    const nSet = names ? new Set(names) : null;
    return ctx.confirmedCandles.filter(
      (c) => c.direction === tgt && bar.time - c.detectionTime <= tfSec * maxBars && (!nSet || nSet.has(c.name))
    );
  };

  const recentPatterns = (names: ChartPattern['name'][], maxBars = 10) => {
    const nSet = new Set(names);
    return ctx.activeChartPatterns
      .filter(
        (cp) =>
          cp.direction === tgt &&
          nSet.has(cp.name) &&
          (cp.status === 'Breakout' || cp.status === 'Retest') &&
          (cp.breakoutTime === null || bar.time - cp.breakoutTime <= tfSec * maxBars)
      )
      .sort((a, b) => b.qualityScore - a.qualityScore);
  };

  switch (driver) {
    case 'SWEEP_ANY': {
      const sw = recentSweeps(16).pop();
      if (!sw || !dirCloseOk(0.08)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sw.lower : sw.upper),
        score: 77,
        reason: `Liquidity sweep (${sw.label})`,
      };
    }
    case 'SWEEP_EQ': {
      const sw = recentSweeps(12, [isBuy ? 'equal_lows' : 'equal_highs']).pop();
      if (!sw || !dirCloseOk(0.15)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sw.lower : sw.upper),
        score: 79,
        reason: `Equal ${isBuy ? 'Lows' : 'Highs'} sweep (${sw.label})`,
      };
    }
    case 'SWEEP_PDHL': {
      const sw = recentSweeps(22, [isBuy ? 'pdl' : 'pdh']).pop();
      if (!sw || !dirCloseOk(0.08)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sw.lower : sw.upper),
        score: 80,
        reason: `Swept ${isBuy ? 'PDL' : 'PDH'} (${sw.price.toFixed(p)})`,
      };
    }
    case 'SWEEP_PWHL': {
      const sw = recentSweeps(28, [isBuy ? 'pwl' : 'pwh']).pop();
      if (!sw || !dirCloseOk(0.08)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sw.lower : sw.upper),
        score: 82,
        reason: `Swept Weekly ${isBuy ? 'PWL' : 'PWH'}`,
      };
    }
    case 'OB_UNMIT': {
      const ob = recentObs(2.5, { unmitigatedOnly: true })[0];
      if (!ob) return null;
      return {
        invalidation: isBuy ? ob.lower : ob.upper,
        limitEntry: price >= ob.lower && price <= ob.upper ? price : isBuy ? ob.upper : ob.lower,
        entryZone: { lower: ob.lower, upper: ob.upper },
        score: 77,
        reason: `Unmitigated OB [${ob.lower.toFixed(p)}–${ob.upper.toFixed(p)}]`,
      };
    }
    case 'OB_DISP': {
      const ob = recentObs(2.5, { unmitigatedOnly: true, minDisp: 1.7 })[0];
      if (!ob) return null;
      return {
        invalidation: isBuy ? ob.lower : ob.upper,
        limitEntry: price >= ob.lower && price <= ob.upper ? price : isBuy ? ob.upper : ob.lower,
        entryZone: { lower: ob.lower, upper: ob.upper },
        score: 81,
        reason: `High-Disp OB (${ob.displacementAtr.toFixed(1)}x ATR)`,
      };
    }
    case 'BREAKER': {
      const brk = recentObs(2.5, { kinds: ['breaker_block'] })[0];
      if (!brk) return null;
      const validSide = isBuy ? price >= brk.lower - atr * 0.4 : price <= brk.upper + atr * 0.4;
      if (!validSide) return null;
      return {
        invalidation: isBuy ? brk.lower : brk.upper,
        limitEntry: price >= brk.lower && price <= brk.upper ? price : brk.midpoint,
        entryZone: { lower: brk.lower, upper: brk.upper },
        score: 79,
        reason: `Breaker Block [${brk.lower.toFixed(p)}–${brk.upper.toFixed(p)}]`,
      };
    }
    case 'MITIGATION': {
      const mit = recentObs(2.5, { kinds: ['mitigation_block'] })[0];
      if (!mit) return null;
      return {
        invalidation: isBuy ? mit.lower : mit.upper,
        limitEntry: price >= mit.lower && price <= mit.upper ? price : mit.midpoint,
        entryZone: { lower: mit.lower, upper: mit.upper },
        score: 77,
        reason: `Mitigation Block [${mit.lower.toFixed(p)}–${mit.upper.toFixed(p)}]`,
      };
    }
    case 'FVG_ANY': {
      const fvg = recentFvgs(2.5)[0];
      if (!fvg) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? fvg.lower : fvg.upper),
        limitEntry: price >= fvg.lower && price <= fvg.upper ? price : isBuy ? fvg.upper : fvg.lower,
        entryZone: { lower: fvg.lower, upper: fvg.upper },
        score: 76,
        reason: `Unfilled FVG [${fvg.lower.toFixed(p)}–${fvg.upper.toFixed(p)}]`,
      };
    }
    case 'FVG_CE': {
      const fvg = recentFvgs(2.5)[0];
      if (!fvg) return null;
      return {
        invalidation: isBuy ? fvg.lower : fvg.upper,
        limitEntry: fvg.consequentEncroachment,
        entryZone: { lower: fvg.lower, upper: fvg.upper },
        score: 79,
        reason: `FVG 50% CE @ ${fvg.consequentEncroachment.toFixed(p)}`,
      };
    }
    case 'IFVG': {
      const invFvg = ctx.activeFvgs
        .filter((f) => (f.kind === 'inverse_fvg' || f.status === 'inverted') && Math.abs(f.consequentEncroachment - price) <= atr * 2.5)
        .filter((f) => (isBuy ? price >= f.lower - atr * 0.25 : price <= f.upper + atr * 0.25))[0];
      if (!invFvg) return null;
      return {
        invalidation: isBuy ? invFvg.lower : invFvg.upper,
        limitEntry: invFvg.consequentEncroachment,
        entryZone: { lower: invFvg.lower, upper: invFvg.upper },
        score: 78,
        reason: `Inverted FVG Flip [${invFvg.lower.toFixed(p)}–${invFvg.upper.toFixed(p)}]`,
      };
    }
    case 'SD_FRESH': {
      const sd = ctx.activeSds.find(
        (z) => z.freshness === 'fresh' && z.kind === (isBuy ? 'demand' : 'supply') && Math.abs(z.proximal - price) <= atr * 2.4
      );
      if (!sd) return null;
      const lo = Math.min(sd.proximal, sd.distal);
      const hi = Math.max(sd.proximal, sd.distal);
      return {
        invalidation: sd.distal,
        limitEntry: price >= lo && price <= hi ? price : sd.proximal,
        entryZone: { lower: lo, upper: hi },
        score: 79,
        reason: `Fresh ${sd.patternType} ${sd.kind} zone`,
      };
    }
    case 'SD_CONT': {
      const wantPat = isBuy ? 'RBR' : 'DBD';
      const sd = ctx.activeSds.find(
        (z) => z.patternType === wantPat && z.kind === (isBuy ? 'demand' : 'supply') && Math.abs(z.proximal - price) <= atr * 2.4
      );
      if (!sd) return null;
      const lo = Math.min(sd.proximal, sd.distal);
      const hi = Math.max(sd.proximal, sd.distal);
      return {
        invalidation: sd.distal,
        limitEntry: price >= lo && price <= hi ? price : sd.proximal,
        entryZone: { lower: lo, upper: hi },
        score: 77,
        reason: `${wantPat} Continuation ${sd.kind}`,
      };
    }
    case 'OTE_705': {
      if (!dr) return null;
      const ok = isBuy
        ? dr.currentPosition === 'discount' && dr.retracementPercent >= 58 && dr.retracementPercent <= 84
        : dr.currentPosition === 'premium' && dr.retracementPercent >= 58 && dr.retracementPercent <= 84;
      if (!ok) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? dr.rangeLow : dr.rangeHigh),
        limitEntry: dr.ote705,
        entryZone: { lower: Math.min(dr.fib62, dr.fib79), upper: Math.max(dr.fib62, dr.fib79) },
        extraTarget: { price: isBuy ? dr.rangeHigh : dr.rangeLow, label: 'Dealing Range Extreme' },
        score: 80,
        reason: `OTE 70.5% Pocket (${dr.retracementPercent}%)`,
      };
    }
    case 'MSS_BOS': {
      const brk = ctx.confirmedBreaks.find(
        (b) => b.direction === tgt && bar.time - b.breakTime <= tfSec * 10
      );
      if (!brk || !dirCloseOk(0.1)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, brk.levelPrice),
        score: 78,
        reason: `Confirmed ${brk.type} @ ${brk.levelPrice.toFixed(p)}`,
      };
    }
    case 'PA_ENGULF': {
      const cp = recentCandles(2, [isBuy ? 'Bullish Engulfing' : 'Bearish Engulfing'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 76,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_PINBAR': {
      const cp = recentCandles(3, ['Hammer', 'Inverted Hammer', 'Shooting Star', 'Hanging Man', 'Dragonfly Doji', 'Gravestone Doji'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 77,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_STAR': {
      const cp = recentCandles(3, [isBuy ? 'Morning Star' : 'Evening Star'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 80,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_INSIDE': {
      const cp = recentCandles(3, ['Inside Bar'])[0];
      const ibOk = cp || (dirCloseOk(0.15) && (isBuy ? bar.close > prevBar.high : bar.close < prevBar.low));
      if (!ibOk) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp ? (isBuy ? cp.lowBound : cp.highBound) : (isBuy ? prevBar.low : prevBar.high)),
        score: 76,
        reason: cp ? `Confirmed ${cp.name} Breakout` : 'Inside Bar Breakout',
      };
    }
    case 'PA_FAKEY': {
      const cp = recentCandles(4, ['Inside Bar', 'Outside Bar'])[0];
      if (!cp || !dirCloseOk(0.15)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 79,
        reason: `Fakey Trap (${cp.name})`,
      };
    }
    case 'PA_MARUBOZU': {
      const cp = recentCandles(2, ['Marubozu'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 76,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_TWEEZER': {
      const cp = recentCandles(3, [isBuy ? 'Tweezer Bottom' : 'Tweezer Top'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 76,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_RAIL': {
      const prevBody = Math.abs(prevBar.close - prevBar.open);
      const ok = isBuy
        ? prevBar.close < prevBar.open && ctx.isBullBar && prevBody >= atr * 0.45 && ctx.barBody >= atr * 0.45 && bar.close >= prevBar.open - atr * 0.1
        : prevBar.close > prevBar.open && ctx.isBearBar && prevBody >= atr * 0.45 && ctx.barBody >= atr * 0.45 && bar.close <= prevBar.open + atr * 0.1;
      if (!ok) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? Math.min(bar.low, prevBar.low) : Math.max(bar.high, prevBar.high)),
        score: 77,
        reason: '2-Bar Rail-Track Reversal',
      };
    }
    case 'PA_EMA20': {
      const touched = isBuy
        ? bar.low <= ctx.ema20 + atr * 0.28 && bar.close > ctx.ema20 && ctx.isBullBar
        : bar.high >= ctx.ema20 - atr * 0.28 && bar.close < ctx.ema20 && ctx.isBearBar;
      if (!touched) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 76,
        reason: `20 EMA Pullback (${ctx.ema20.toFixed(p)})`,
      };
    }
    case 'PA_EMA50': {
      const touched = isBuy
        ? bar.low <= ctx.ema50 + atr * 0.35 && bar.close > ctx.ema50 && ctx.isBullBar
        : bar.high >= ctx.ema50 - atr * 0.35 && bar.close < ctx.ema50 && ctx.isBearBar;
      if (!touched) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 77,
        reason: `50 EMA Pullback (${ctx.ema50.toFixed(p)})`,
      };
    }
    case 'PA_DONCHIAN20': {
      if (!Number.isFinite(ctx.donchianHigh20) || !Number.isFinite(ctx.donchianLow20)) return null;
      const ok = isBuy ? bar.close > ctx.donchianHigh20 && prevBar.close <= ctx.donchianHigh20 : bar.close < ctx.donchianLow20 && prevBar.close >= ctx.donchianLow20;
      if (!ok) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? ctx.recent3Low : ctx.recent3High),
        score: 78,
        reason: `20-Bar Donchian ${isBuy ? 'High' : 'Low'} Breakout`,
      };
    }
    case 'PA_TURTLE_SOUP': {
      if (!Number.isFinite(ctx.donchianHigh20) || !Number.isFinite(ctx.donchianLow20)) return null;
      const ok = isBuy
        ? bar.low < ctx.donchianLow20 && bar.close > ctx.donchianLow20 && ctx.isBullBar
        : bar.high > ctx.donchianHigh20 && bar.close < ctx.donchianHigh20 && ctx.isBearBar;
      if (!ok) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 80,
        reason: `Turtle Soup Failed 20-Bar ${isBuy ? 'Breakdown' : 'Breakout'}`,
      };
    }
    case 'PA_NR7_COIL': {
      if (!ctx.nr7 && !ctx.coil3) return null;
      const ok = isBuy ? bar.close > prevBar.high && dirCloseOk(0.25) : bar.close < prevBar.low && dirCloseOk(0.25);
      if (!ok) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? prevBar.low : prevBar.high),
        score: 78,
        reason: ctx.nr7 ? 'NR7 Volatility Breakout' : '3-Bar Compression Release',
      };
    }
    case 'CP_DOUBLE_TB': {
      const cp = recentPatterns([isBuy ? 'Double Bottom' : 'Double Top'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 79,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_TRIPLE_TB': {
      const cp = recentPatterns([isBuy ? 'Triple Bottom' : 'Triple Top'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 80,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_HS_IHS': {
      const cp = recentPatterns([isBuy ? 'Inverse Head and Shoulders' : 'Head and Shoulders'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 81,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_SYM_TRI': {
      const cp = recentPatterns(['Symmetrical Triangle'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'Sym Triangle Target' } : null,
        score: 78,
        reason: `Symmetrical Triangle ${tgt}`,
      };
    }
    case 'CP_DIR_TRI': {
      const cp = recentPatterns([isBuy ? 'Ascending Triangle' : 'Descending Triangle'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 80,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_FLAG_PEN': {
      const cp = recentPatterns([isBuy ? 'Bullish Flag' : 'Bearish Flag', isBuy ? 'Bullish Pennant' : 'Bearish Pennant'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 80,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_WEDGE': {
      const cp = recentPatterns(['Falling Wedge', 'Rising Wedge'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 78,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_CUP_ROUND': {
      const cp = recentPatterns(['Cup and Handle', 'Rounding Bottom', 'Rounding Top', 'Rectangle'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
        extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: `${cp.name} Target` } : null,
        score: 79,
        reason: `${cp.name} (${cp.status})`,
      };
    }
    case 'CP_TL_BOUNCE': {
      const tl = ctx.activeTrendlines.find(
        (t) =>
          t.touches >= 3 &&
          t.status !== 'broken' &&
          (isBuy ? t.kind === 'bullish_support' : t.kind === 'bearish_resistance') &&
          Math.abs(t.currentProjectedPrice - price) <= atr * 0.9
      );
      if (!tl || !dirCloseOk(0.08)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, tl.currentProjectedPrice),
        score: 79,
        reason: `${tl.touches}-Touch Trendline Bounce`,
      };
    }
    case 'CP_TL_BREAK': {
      const tl = ctx.activeTrendlines.find(
        (t) =>
          (t.status === 'broken' || t.status === 'retested') &&
          t.breakoutTime !== null &&
          bar.time - t.breakoutTime <= tfSec * 8 &&
          (isBuy ? t.kind === 'bearish_resistance' : t.kind === 'bullish_support')
      );
      if (!tl) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, tl.currentProjectedPrice),
        score: 78,
        reason: `Trendline ${tl.status}`,
      };
    }
    case 'SR_MAJOR': {
      const sr = recentSrs(1.2, { minStrength: 60 })[0];
      if (!sr) return null;
      return {
        invalidation: isBuy ? sr.lower : sr.upper,
        limitEntry: price >= sr.lower && price <= sr.upper ? price : isBuy ? sr.upper : sr.lower,
        entryZone: { lower: sr.lower, upper: sr.upper },
        score: 78,
        reason: `Major ${sr.label} (${sr.strengthScore})`,
      };
    }
    case 'SR_VERIFIED': {
      const sr = recentSrs(1.1, { minRejections: 2 })[0];
      if (!sr) return null;
      return {
        invalidation: isBuy ? sr.lower : sr.upper,
        limitEntry: sr.midpoint,
        entryZone: { lower: sr.lower, upper: sr.upper },
        score: 79,
        reason: `Verified ${sr.label} (${sr.rejections} rej)`,
      };
    }
    case 'SR_FLIP': {
      const flipped = ctx.brokenOrRetestSrs.find((sr) => {
        const flipMatch = isBuy ? sr.kind === 'resistance' : sr.kind === 'support';
        const near = price >= sr.lower - atr * 0.9 && price <= sr.upper + atr * 0.9;
        return flipMatch && near && (isBuy ? price >= sr.lower : price <= sr.upper);
      });
      if (!flipped) return null;
      return {
        invalidation: isBuy ? flipped.lower : flipped.upper,
        limitEntry: flipped.midpoint,
        entryZone: { lower: flipped.lower, upper: flipped.upper },
        score: 80,
        reason: `Polarity Flip ${flipped.label}`,
      };
    }
    case 'SR_BREAKOUT': {
      const broken = ctx.brokenOrRetestSrs.find(
        (sr) =>
          (isBuy ? sr.kind === 'resistance' : sr.kind === 'support') &&
          (isBuy ? bar.close > sr.upper && prevBar.close <= sr.upper : bar.close < sr.lower && prevBar.close >= sr.lower)
      );
      if (!broken || !dirCloseOk(0.3)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, broken.midpoint),
        score: 79,
        reason: `S/R Breakout across ${broken.label}`,
      };
    }
    case 'SR_PDHL': {
      const sr = recentSrs(1.1, { sources: ['pdh_pdl'] })[0];
      if (!sr) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sr.lower : sr.upper),
        limitEntry: sr.midpoint,
        entryZone: { lower: sr.lower, upper: sr.upper },
        score: 79,
        reason: `Daily Anchor ${sr.label}`,
      };
    }
    case 'SR_PWHL': {
      const sr = recentSrs(1.2, { sources: ['pwh_pwl'] })[0];
      if (!sr) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? sr.lower : sr.upper),
        limitEntry: sr.midpoint,
        entryZone: { lower: sr.lower, upper: sr.upper },
        score: 81,
        reason: `Weekly Anchor ${sr.label}`,
      };
    }
    case 'SR_PIVOT': {
      const sr = recentSrs(1.1, { sources: ['pivot'] })[0];
      if (!sr) return null;
      return {
        invalidation: isBuy ? sr.lower : sr.upper,
        limitEntry: sr.midpoint,
        entryZone: { lower: sr.lower, upper: sr.upper },
        score: 76,
        reason: `Floor Pivot ${sr.label}`,
      };
    }
    case 'SR_SESSION': {
      const sessSr = recentSrs(1.1, { sources: ['session_hl'] })[0];
      const activeBox = execSnap.sessions.find((s) => s.isActive) ?? execSnap.sessions[execSnap.sessions.length - 1];
      const lvl = sessSr
        ? sessSr.midpoint
        : activeBox
          ? isBuy
            ? activeBox.lowPrice
            : activeBox.highPrice
          : anchors.dailyOpen;
      if (lvl === null || Math.abs(price - lvl) > atr * 1.1) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, sessSr ? (isBuy ? sessSr.lower : sessSr.upper) : lvl),
        limitEntry: lvl,
        entryZone: sessSr
          ? { lower: sessSr.lower, upper: sessSr.upper }
          : { lower: lvl - atr * 0.15, upper: lvl + atr * 0.15 },
        score: 76,
        reason: sessSr ? `Session ${sessSr.label}` : `Session Boundary ${lvl.toFixed(p)}`,
      };
    }
    case 'SR_SPRING': {
      const sr = ctx.activeSrs.find(
        (z) =>
          z.kind === (isBuy ? 'support' : 'resistance') &&
          (isBuy ? bar.low < z.lower && bar.close > z.lower : bar.high > z.upper && bar.close < z.upper)
      );
      if (!sr || !dirCloseOk(0.25)) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 80,
        reason: `${isBuy ? 'Spring' : 'Upthrust'} trap across ${sr.label}`,
      };
    }
    case 'SR_NESTED_HTF': {
      if (!htfSnap) return null;
      const execZone = recentSrs(1.1)[0];
      if (!execZone) return null;
      const htfZone = htfSnap.supportResistance.find(
        (hz) =>
          hz.status !== 'Invalidated' &&
          hz.status !== 'Broken' &&
          hz.kind === execZone.kind &&
          Math.abs(hz.midpoint - execZone.midpoint) <= atr * 0.9
      );
      if (!htfZone) return null;
      return {
        invalidation: isBuy ? Math.min(execZone.lower, htfZone.lower) : Math.max(execZone.upper, htfZone.upper),
        limitEntry: execZone.midpoint,
        entryZone: { lower: execZone.lower, upper: execZone.upper },
        score: 83,
        reason: `HTF+Exec Nested ${execZone.label}`,
      };
    }
    case 'SMC_VOL_IMB': {
      const vi = recentFvgs(2.5, ['volume_imbalance', 'rejection_block'])[0];
      if (!vi) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? vi.lower : vi.upper),
        limitEntry: vi.consequentEncroachment,
        entryZone: { lower: vi.lower, upper: vi.upper },
        score: 78,
        reason: `${vi.kind === 'rejection_block' ? 'Rejection Block' : 'Volume Imbalance'} @ ${vi.consequentEncroachment.toFixed(p)}`,
      };
    }
    case 'PA_THREE_SOLDIERS_CROWS': {
      const cp = recentCandles(3, [isBuy ? 'Three White Soldiers' : 'Three Black Crows'])[0];
      const nC = ctx.candles.length;
      const b1 = ctx.candles[nC - 3];
      const b2 = ctx.candles[nC - 2];
      const b3 = bar;
      const seqOk = Boolean(
        b1 &&
          b2 &&
          (isBuy
            ? b1.close > b1.open &&
              b2.close > b2.open &&
              b3.close > b3.open &&
              b2.close > b1.close &&
              b3.close > b2.close &&
              b3.close - b3.open >= atr * 0.35
            : b1.close < b1.open &&
              b2.close < b2.open &&
              b3.close < b3.open &&
              b2.close < b1.close &&
              b3.close < b2.close &&
              b1.open - b1.close >= atr * 0.25 &&
              b3.open - b3.close >= atr * 0.35)
      );
      if (!cp && !seqOk) return null;
      return {
        invalidation: findProtectedInvalidation(
          d,
          price,
          atr,
          execSnap,
          cp ? (isBuy ? cp.lowBound : cp.highBound) : isBuy ? b1.low : b1.high
        ),
        score: 79,
        reason: cp ? `Confirmed ${cp.name}` : isBuy ? 'Three White Soldiers Impulse' : 'Three Black Crows Impulse',
      };
    }
    case 'PA_PIERCING_DARKCLOUD': {
      const cp = recentCandles(2, [isBuy ? 'Piercing Pattern' : 'Dark Cloud Cover'])[0];
      const prevBody = Math.abs(prevBar.close - prevBar.open);
      const midPrev = (prevBar.open + prevBar.close) / 2;
      const classic = isBuy
        ? prevBar.close < prevBar.open &&
          prevBody >= atr * 0.45 &&
          ctx.isBullBar &&
          bar.low <= prevBar.low + atr * 0.08 &&
          bar.close > midPrev
        : prevBar.close > prevBar.open &&
          prevBody >= atr * 0.45 &&
          ctx.isBearBar &&
          bar.high >= prevBar.high - atr * 0.08 &&
          bar.close < midPrev;
      if (!cp && !classic) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 78,
        reason: cp ? `Confirmed ${cp.name}` : isBuy ? 'Piercing Line Reversal' : 'Dark Cloud Cover Reversal',
      };
    }
    case 'PA_HARAMI': {
      const cp = recentCandles(2, [isBuy ? 'Bullish Harami' : 'Bearish Harami'])[0];
      if (!cp) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? cp.lowBound : cp.highBound),
        score: 76,
        reason: `Confirmed ${cp.name}`,
      };
    }
    case 'PA_OUTSIDE_BAR': {
      const cp = recentCandles(2, ['Outside Bar'])[0];
      const outOk =
        bar.high > prevBar.high &&
        bar.low < prevBar.low &&
        dirCloseOk(0.3);
      if (!cp && !outOk) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 78,
        reason: cp ? `Outside Bar Reversal (${cp.name})` : 'Key Outside Bar Reversal',
      };
    }
    case 'DYN_ATR_EXPANSION': {
      if (!Number.isFinite(ctx.donchianHigh10) || !Number.isFinite(ctx.donchianLow10)) return null;
      const prevSmall = prevBar.high - prevBar.low <= atr * 1.05;
      const expand = ctx.barRange >= atr * 1.35 && dirCloseOk(0.5);
      const brk = isBuy ? bar.close > ctx.donchianHigh10 : bar.close < ctx.donchianLow10;
      if (!prevSmall || !expand || !brk) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? prevBar.low : prevBar.high),
        score: 80,
        reason: `ATR Volatility Expansion (${(ctx.barRange / atr).toFixed(1)}x ATR)`,
      };
    }
    case 'DYN_EMA_CROSS': {
      const emaCap = Math.max(ctx.ema20, ctx.ema50);
      const emaFloor = Math.min(ctx.ema20, ctx.ema50);
      const reclaim = isBuy
        ? ctx.ema20 >= ctx.ema50 * 0.999 &&
          ctx.ema20 > ctx.ema20Prev &&
          prevBar.close <= emaCap &&
          bar.close > emaCap &&
          dirCloseOk(0.15)
        : ctx.ema20 <= ctx.ema50 * 1.001 &&
          ctx.ema20 < ctx.ema20Prev &&
          prevBar.close >= emaFloor &&
          bar.close < emaFloor &&
          dirCloseOk(0.15);
      if (!reclaim) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 78,
        reason: `Dynamic 20/50 EMA Cross Reclaim (${ctx.ema20.toFixed(p)})`,
      };
    }
    case 'DYN_DAILY_BIAS': {
      const dOpen = anchors.dailyOpen;
      if (dOpen === null) return null;
      const flip = isBuy
        ? bar.low <= dOpen && bar.close > dOpen && dirCloseOk(0.2)
        : bar.high >= dOpen && bar.close < dOpen && dirCloseOk(0.2);
      if (!flip) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, isBuy ? bar.low : bar.high),
        score: 79,
        reason: `Daily Open (${dOpen.toFixed(p)}) ${isBuy ? 'Reclaim' : 'Rejection'}`,
      };
    }
    case 'CP_W_PATTERN': {
      if (!isBuy) return null;
      const cp = recentPatterns(['Double Bottom'], 12)[0];
      if (cp) {
        return {
          invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
          extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'W Pattern Target' } : null,
          score: 81,
          reason: `W Pattern Double Bottom (${cp.status})`,
        };
      }
      // Causal swing-structure W Pattern (L1 -> Peak -> L2 symmetry/sweep -> neckline break or leg-2 rebound)
      const confirmedSwings = execSnap.marketStructure.swings.filter((s) => s.confirmationStatus === 'confirmed');
      const lows = confirmedSwings.filter((s) => s.kind === 'low');
      if (lows.length < 2) return null;
      const l2 = lows[lows.length - 1];
      const l1 = lows[lows.length - 2];
      const midHigh = confirmedSwings.find(
        (s) => s.kind === 'high' && s.candleTime > l1.candleTime && s.candleTime < l2.candleTime
      );
      if (!midHigh) return null;
      const bottomBase = Math.min(l1.price, l2.price);
      const wHeight = midHigh.price - bottomBase;
      if (wHeight < atr * 1.1) return null;
      if (Math.abs(l2.price - l1.price) > atr * 1.5) return null;
      const necklineBreak = bar.close > midHigh.price && prevBar.close <= midHigh.price + atr * 0.2 && dirCloseOk(0.15);
      const leg2Bounce =
        bar.close > l2.price &&
        bar.close <= midHigh.price + atr * 0.25 &&
        price - bottomBase <= wHeight * 0.85 &&
        dirCloseOk(0.25);
      if (!necklineBreak && !leg2Bounce) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, bottomBase),
        extraTarget: { price: midHigh.price + wHeight, label: 'W Pattern Measured Target' },
        score: necklineBreak ? 82 : 79,
        reason: necklineBreak
          ? `W Pattern Neckline Break @ ${midHigh.price.toFixed(p)}`
          : `W Pattern Leg-2 Rebound [${l1.price.toFixed(p)}/${l2.price.toFixed(p)}]`,
      };
    }
    case 'CP_M_PATTERN': {
      if (isBuy) return null;
      const cp = recentPatterns(['Double Top'], 12)[0];
      if (cp) {
        return {
          invalidation: findProtectedInvalidation(d, price, atr, execSnap, cp.invalidationLevel),
          extraTarget: cp.measuredTarget ? { price: cp.measuredTarget, label: 'M Pattern Target' } : null,
          score: 81,
          reason: `M Pattern Double Top (${cp.status})`,
        };
      }
      // Causal swing-structure M Pattern (H1 -> Valley -> H2 symmetry/sweep -> neckline break or leg-2 rejection)
      const confirmedSwings = execSnap.marketStructure.swings.filter((s) => s.confirmationStatus === 'confirmed');
      const highs = confirmedSwings.filter((s) => s.kind === 'high');
      if (highs.length < 2) return null;
      const h2 = highs[highs.length - 1];
      const h1 = highs[highs.length - 2];
      const midLow = confirmedSwings.find(
        (s) => s.kind === 'low' && s.candleTime > h1.candleTime && s.candleTime < h2.candleTime
      );
      if (!midLow) return null;
      const topPeak = Math.max(h1.price, h2.price);
      const mHeight = topPeak - midLow.price;
      if (mHeight < atr * 1.1) return null;
      if (Math.abs(h2.price - h1.price) > atr * 1.5) return null;
      const necklineBreak = bar.close < midLow.price && prevBar.close >= midLow.price - atr * 0.2 && dirCloseOk(0.15);
      const leg2Reject =
        bar.close < h2.price &&
        bar.close >= midLow.price - atr * 0.25 &&
        topPeak - price <= mHeight * 0.85 &&
        dirCloseOk(0.25);
      if (!necklineBreak && !leg2Reject) return null;
      return {
        invalidation: findProtectedInvalidation(d, price, atr, execSnap, topPeak),
        extraTarget: { price: midLow.price - mHeight, label: 'M Pattern Measured Target' },
        score: necklineBreak ? 82 : 79,
        reason: necklineBreak
          ? `M Pattern Neckline Break @ ${midLow.price.toFixed(p)}`
          : `M Pattern Leg-2 Rejection [${h1.price.toFixed(p)}/${h2.price.toFixed(p)}]`,
      };
    }
  }
}

function evaluateFilter(
  filter: FilterId,
  d: Direction,
  ctx: ComboBarContext
): boolean {
  const { execSnap, bar, prevBar, atr, tfSec, price, htfTrend, execTrend } = ctx;
  const isBuy = d === 'BUY';
  const tgt = trendLabel(d);
  const opp = oppTrend(d);
  const dr = execSnap.dealingRange;
  const anchors = execSnap.sessionAnchors;

  switch (filter) {
    case 'HTF_STRICT':
      return htfTrend === tgt;
    case 'HTF_NONOPP':
      return htfTrend !== opp;
    case 'MSS_SHIFT':
      return ctx.confirmedBreaks.some(
        (b) => b.direction === tgt && (b.type === 'MSS' || b.type === 'CHoCH') && bar.time - b.breakTime <= tfSec * 10
      );
    case 'BOS_CONT':
      return ctx.confirmedBreaks.some(
        (b) => b.direction === tgt && b.type === 'BOS' && bar.time - b.breakTime <= tfSec * 16
      );
    case 'FVG_CONF':
      return ctx.activeFvgs.some(
        (f) =>
          f.status !== 'fully_filled' &&
          f.status !== 'inverted' &&
          f.kind === (isBuy ? 'bullish_fvg' : 'bearish_fvg') &&
          Math.abs(f.consequentEncroachment - price) <= atr * 3.0
      );
    case 'OB_CONF':
      return ctx.activeObs.some(
        (ob) =>
          ob.kind === (isBuy ? 'bullish_ob' : 'bearish_ob') &&
          Math.abs(ob.midpoint - price) <= atr * 3.0
      );
    case 'SR_NEAR':
      return ctx.activeSrs.some(
        (sr) =>
          sr.kind === (isBuy ? 'support' : 'resistance') &&
          price >= sr.lower - atr * 1.5 &&
          price <= sr.upper + atr * 1.5
      );
    case 'SWEEP_CONF': {
      const allowed = isBuy
        ? new Set(['sell_side', 'equal_lows', 'pdl', 'pwl', 'inducement', 'internal'])
        : new Set(['buy_side', 'equal_highs', 'pdh', 'pwh', 'inducement', 'internal']);
      return ctx.recentSweeps.some(
        (l) => l.sweepTime !== null && bar.time - l.sweepTime <= tfSec * 18 && allowed.has(l.kind)
      );
    }
    case 'OTE_QUAD':
      return Boolean(
        dr && (isBuy ? dr.currentPosition === 'discount' : dr.currentPosition === 'premium')
      );
    case 'VOL_125':
      return ctx.volRatio >= 1.25;
    case 'VOL_145':
      return ctx.volRatio >= 1.45;
    case 'DISP_STRONG':
      return isBuy ? ctx.displacementSigned >= 0.4 : ctx.displacementSigned <= -0.4;
    case 'CANDLE_REV':
      return ctx.confirmedCandles.some(
        (c) => c.direction === tgt && bar.time - c.detectionTime <= tfSec * 3
      );
    case 'EMA_SLOPE':
      return isBuy ? ctx.ema20 > ctx.ema20Prev && price >= ctx.ema20 : ctx.ema20 < ctx.ema20Prev && price <= ctx.ema20;
    case 'EMA_STACK':
      return isBuy ? ctx.ema20 > ctx.ema50 : ctx.ema20 < ctx.ema50;
    case 'EXHAUST_3':
      return isBuy ? ctx.prevConsecBear >= 3 : ctx.prevConsecBull >= 3;
    case 'CONSOL_REGIME':
      return execTrend === 'consolidation';
    case 'TREND_REGIME':
      return execTrend === tgt;
    case 'WICK_ABSORB':
      return isBuy
        ? ctx.lowerWick / ctx.barRange >= 0.32 && ctx.bar.close >= ctx.bar.low + ctx.barRange * 0.45
        : ctx.upperWick / ctx.barRange >= 0.32 && ctx.bar.close <= ctx.bar.high - ctx.barRange * 0.45;
    case 'TL_NEAR':
      return ctx.activeTrendlines.some(
        (t) =>
          t.status !== 'broken' &&
          (isBuy ? t.kind === 'bullish_support' : t.kind === 'bearish_resistance') &&
          Math.abs(t.currentProjectedPrice - price) <= atr * 1.4
      );
    case 'VOL_EXPAND':
      return ctx.barRange >= atr * 1.15;
    case 'VOL_COMPRESS':
      return ctx.nr4 || ctx.nr7 || ctx.coil3 || prevBar.high - prevBar.low <= atr * 0.85;
    case 'PRICE_EMA20':
      return isBuy ? price > ctx.ema20 : price < ctx.ema20;
    case 'DAILY_BIAS':
      return anchors.dailyOpen === null || (isBuy ? price > anchors.dailyOpen : price < anchors.dailyOpen);
    case 'SD_CONFLUENCE':
      return ctx.activeSds.some(
        (z) => z.kind === (isBuy ? 'demand' : 'supply') && Math.abs(z.proximal - price) <= atr * 2.8
      );
    case 'FVG_OR_OB':
      return (
        ctx.activeObs.some(
          (ob) => ob.kind === (isBuy ? 'bullish_ob' : 'bearish_ob') && Math.abs(ob.midpoint - price) <= atr * 3.0
        ) ||
        ctx.activeFvgs.some(
          (f) =>
            f.status !== 'fully_filled' &&
            f.status !== 'inverted' &&
            f.kind === (isBuy ? 'bullish_fvg' : 'bearish_fvg') &&
            Math.abs(f.consequentEncroachment - price) <= atr * 3.0
        )
      );
  }
}

export function evaluateComboStrategiesOnBar<TPlan>(
  enabledIds: Set<BacktestStrategyId>,
  deps: ComboEvalDeps<TPlan>
): TPlan[] {
  const results: TPlan[] = [];
  const filterCache = new Map<string, boolean>();
  const driverCache = new Map<string, DriverHit | null>();

  const getFilter = (f: FilterId, d: Direction): boolean => {
    const k = `${f}:${d}`;
    let hit = filterCache.get(k);
    if (hit === undefined) {
      hit = evaluateFilter(f, d, deps.ctx);
      filterCache.set(k, hit);
    }
    return hit;
  };

  const getDriver = (drv: DriverId, d: Direction): DriverHit | null => {
    const k = `${drv}:${d}`;
    if (driverCache.has(k)) return driverCache.get(k) ?? null;
    const hit = evaluateDriver(drv, d, deps);
    driverCache.set(k, hit);
    return hit;
  };

  for (const id of enabledIds) {
    const spec = COMBO_SPEC_MAP.get(id);
    if (!spec) continue;

    for (const d of DIRS) {
      if (!getFilter(spec.filter, d)) continue;
      if (spec.secondFilter && !getFilter(spec.secondFilter, d)) continue;

      const hit = getDriver(spec.driver, d);
      if (!hit || hit.invalidation === null) continue;

      const execMeta = EXEC_META[spec.exec];
      const isLimit = execMeta.mode === 'limit_retest';
      const midBar = (deps.ctx.bar.high + deps.ctx.bar.low) / 2;

      const entryPrice = isLimit
        ? hit.limitEntry ?? (d === 'BUY' ? Math.min(deps.ctx.price, midBar) : Math.max(deps.ctx.price, midBar))
        : deps.ctx.price;

      const entryZone = isLimit
        ? hit.entryZone ?? {
            lower: entryPrice - deps.ctx.atr * 0.15,
            upper: entryPrice + deps.ctx.atr * 0.15,
          }
        : undefined;

      const rationale = [
        hit.reason,
        FILTER_META[spec.filter].label,
        ...(spec.secondFilter ? [FILTER_META[spec.secondFilter].label] : []),
        execMeta.tag,
      ];

      const plan = deps.buildPlan(deps.ctx, deps.config, {
        strategyId: spec.id,
        direction: d,
        entryMode: execMeta.mode,
        entryPrice,
        entryZone,
        invalidationLevel: hit.invalidation,
        atrMultiplier: execMeta.atrMult,
        minRiskReward: Math.max(deps.config.minRiskReward, execMeta.minRrFloor),
        confluenceScore: hit.score + spec.scoreBonus,
        entryRationale: rationale,
        extraTarget: hit.extraTarget,
      });

      if (plan) {
        results.push(plan);
        break;
      }
    }
  }

  return results;
}
