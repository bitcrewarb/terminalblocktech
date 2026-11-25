import type {
  BacktestStrategyCategory,
  BacktestStrategyDefinition,
} from '../../shared/types/index.ts';
import { COMBO_STRATEGY_DEFINITIONS } from './combinations.ts';

function def(
  id: string,
  name: string,
  category: BacktestStrategyCategory,
  summary: string,
  entryRules: string[],
  riskRules: string[]
): BacktestStrategyDefinition {
  return { id, name, category, summary, entryRules, riskRules };
}

/**
 * 1,150+ Institutional Backtest Strategies spanning SMC, Price Action, Chart Patterns (W/M),
 * Candlestick Patterns, Support & Resistance, Dynamic Regimes, and Multi-Pillar Hybrid Confluences.
 */
export const BACKTEST_STRATEGY_DEFINITIONS: BacktestStrategyDefinition[] = [
  // =========================================================================
  // 1–30: SMART MONEY CONCEPTS (SMC)
  // =========================================================================
  def(
    'SMC_LIQ_SWEEP_MSS',
    'SMC Liquidity Sweep + MSS/CHoCH',
    'SMC',
    'Captures institutional stop-hunts where SSL/BSL liquidity is swept and followed by a confirmed Market Structure Shift (MSS/CHoCH).',
    ['Recent SSL/BSL sweep within 18 bars', 'Confirmed MSS or CHoCH within 8 bars', 'Not strictly counter-HTF'],
    ['SL beyond swept liquidity extreme + 0.5x ATR', 'Targets opposing liquidity & HTF swings']
  ),
  def(
    'SMC_OB_FVG_CONFLUENCE',
    'Order Block + FVG Confluence Retest',
    'SMC',
    'Limit retest entries into unmitigated institutional Order Blocks paired with Fair Value Gaps or BOS flow.',
    ['Unmitigated OB within 2.5x ATR', 'Unfilled FVG or confirmed BOS alignment', 'Limit entry at OB edge'],
    ['SL beyond OB distal edge + 0.45x ATR', 'Targets opposing liquidity & S/R clusters']
  ),
  def(
    'SMC_OTE_RETRACEMENT',
    'OTE Fib Discount / Premium Pullback',
    'SMC',
    'Buys deep Discount retracements (61.8%–78.6%) and sells Premium OTE rallies with reversal candle or BOS trigger.',
    ['Price inside Dealing Range Discount/Premium (>=55%)', 'HTF or Exec structure aligned', 'Confirmed candle or BOS trigger'],
    ['SL beyond swing invalidation + 0.45x ATR', 'Targets Dealing Range High/Low & liquidity']
  ),
  def(
    'SMC_BOS_SD_CONTINUATION',
    'BOS + Supply/Demand Continuation',
    'SMC',
    'HTF trend-continuation trading fresh or tested Supply/Demand zones following confirmed Breaks of Structure.',
    ['Strict HTF trend alignment', 'Confirmed BOS within 16 bars', 'Fresh/tested S/D zone limit pullback'],
    ['SL beyond S/D distal edge + 0.45x ATR', 'Targets opposing supply/demand & liquidity']
  ),
  def(
    'SMC_EQUAL_HL_SWEEP_REVERSAL',
    'Equal Highs/Lows Sweep Reversal',
    'SMC',
    'Targets engineered Equal Lows (EQL) and Equal Highs (EQH) stop runs followed by immediate counter-displacement.',
    ['Swept equal_lows or equal_highs pool within 10 bars', 'Opposite displacement close >= 0.35x ATR', 'HTF not opposing'],
    ['SL beyond equal H/L sweep extreme + 0.45x ATR', 'Targets opposing swing & liquidity pools']
  ),
  def(
    'SMC_PDH_PDL_SWEEP_MSS',
    'PDH / PDL Liquidity Sweep + MSS',
    'SMC',
    'Trades institutional raids of Previous Day Low (Buy) or Previous Day High (Sell) confirmed by MSS/CHoCH.',
    ['Swept PDL (Buy) or PDH (Sell) within 20 bars', 'Confirmed MSS or CHoCH in reversal direction', 'Valid structural invalidation'],
    ['SL beyond PDH/PDL raid extreme + 0.5x ATR', 'Targets opposing daily/session liquidity']
  ),
  def(
    'SMC_PWH_PWL_SWEEP_REVERSAL',
    'PWH / PWL Weekly Liquidity Raid',
    'SMC',
    'Macro stop-run reversal on Previous Week High or Previous Week Low confirmed by strong rejection candlestick.',
    ['Swept PWL (Buy) or PWH (Sell) within 24 bars', 'Confirmed directional candlestick trigger', 'Macro liquidity reversal setup'],
    ['SL beyond PWH/PWL sweep + 0.55x ATR', 'Targets weekly/swing opposing liquidity']
  ),
  def(
    'SMC_INDUCEMENT_SWEEP_BOS',
    'Inducement Sweep + External BOS',
    'SMC',
    'Waits for internal inducement liquidity to get cleared before joining the external Break of Structure impulse.',
    ['Swept inducement or internal liquidity within 16 bars', 'Confirmed external BOS within 12 bars', 'HTF structure supports direction'],
    ['SL beyond inducement low/high + 0.45x ATR', 'Targets external swing high/low']
  ),
  def(
    'SMC_HIGH_DISP_OB_LIMIT',
    'High-Displacement Order Block (>=1.8 ATR)',
    'SMC',
    'Selects only high-impulse institutional Order Blocks spawned with displacement >= 1.8x ATR via limit retest.',
    ['Valid unmitigated OB with displacement >= 1.8x ATR', 'Price within 2.8x ATR of proximal edge', 'Limit fill at proximal edge'],
    ['SL beyond OB distal + 0.4x ATR', 'Targets opposing liquidity & HTF levels']
  ),
  def(
    'SMC_BREAKER_BLOCK_RETEST',
    'Institutional Breaker Block Flip',
    'SMC',
    'Trades failed order blocks turned into Breaker Blocks as institutions mitigate trapped breakout positions.',
    ['Active breaker_block within 2.5x ATR', 'Recent MSS/CHoCH structural shift', 'Limit retest at breaker boundary'],
    ['SL beyond breaker distal + 0.45x ATR', 'Targets opposing structural pools']
  ),
  def(
    'SMC_MITIGATION_BLOCK_ENTRY',
    'Mitigation Block Trend Pullback',
    'SMC',
    'Captures secondary trend continuations on confirmed institutional Mitigation Blocks.',
    ['Active mitigation_block within 2.5x ATR', 'HTF trend or Exec trend aligned', 'Limit entry at mitigation boundary'],
    ['SL beyond mitigation zone + 0.45x ATR', 'Targets trend continuation swings']
  ),
  def(
    'SMC_FVG_CE_MIDPOINT_LIMIT',
    'FVG 50% Consequent Encroachment',
    'SMC',
    'Precision limit order positioned at the 50% Consequent Encroachment midpoint of unfilled Fair Value Gaps.',
    ['Unfilled/partially filled FVG within 2.5x ATR', 'Limit price set at FVG 50% CE midpoint', 'Structure aligned'],
    ['SL beyond FVG outer edge + 0.45x ATR', 'Targets opposing FVG/liquidity']
  ),
  def(
    'SMC_INVERSE_FVG_FLIP',
    'Inverted FVG (IFVG) Polarity Flip',
    'SMC',
    'Trades former Fair Value Gaps that failed and inverted into opposing institutional support or resistance.',
    ['Inverted FVG within 2.2x ATR', 'Close confirmed reversal in new flow direction', 'Structure supports new leg'],
    ['SL beyond IFVG boundary + 0.45x ATR', 'Targets opposing liquidity pools']
  ),
  def(
    'SMC_VOLUME_IMBALANCE_FILL',
    'Volume Imbalance Continuation Fill',
    'SMC',
    'Limit pullback entry into body-to-body Volume Imbalance gaps left by aggressive institutional execution.',
    ['Active volume_imbalance zone within 2.2x ATR', 'HTF or Exec trend aligned', 'Limit fill inside imbalance'],
    ['SL beyond imbalance extreme + 0.4x ATR', 'Targets prior impulse extreme & beyond']
  ),
  def(
    'SMC_REJECTION_BLOCK_ENTRY',
    'SMC Wick Rejection Block Setup',
    'SMC',
    'Enters on long-wick institutional Rejection Blocks aligned with prevailing higher-timeframe order flow.',
    ['Active rejection_block within 2.2x ATR', 'Strict HTF trend alignment', 'Confirmed close or zone touch'],
    ['SL beyond rejection wick + 0.45x ATR', 'Targets opposing liquidity & S/R']
  ),
  def(
    'SMC_ASIAN_SWEEP_KILLZONE',
    'Asian Range Sweep Killzone Turn',
    'SMC',
    'Trades London/NY reversals after price sweeps the Asian session High or Low and snaps back.',
    ['Asian session sweptPrevHigh or sweptPrevLow', 'Opposing directional candle displacement', 'Reversal away from Asian boundary'],
    ['SL beyond Asian sweep extreme + 0.5x ATR', 'Targets opposite side of Asian range & PDH/PDL']
  ),
  def(
    'SMC_LONDON_NY_SWEEP',
    'London / NY Session Liquidity Sweep',
    'SMC',
    'Captures intraday stop-hunts when London or New York sessions sweep prior session extremes with MSS.',
    ['London or NY session sweep detected', 'Confirmed MSS/CHoCH or directional bar close', 'Structural invalidation intact'],
    ['SL beyond session extreme + 0.5x ATR', 'Targets opposing session high/low']
  ),
  def(
    'SMC_INTERNAL_CHOCH_SCALP',
    'Internal CHoCH + Discount/Premium',
    'SMC',
    'Fast internal Change of Character confirmation triggered inside favorable Discount or Premium territory.',
    ['Confirmed internal CHoCH within 6 bars', 'Discount (Buy) or Premium (Sell) positioning', 'Tight structural SL'],
    ['SL beyond internal pivot + 0.4x ATR', 'Targets dealing range midpoint & extreme']
  ),
  def(
    'SMC_EXTERNAL_BOS_PULLBACK',
    'External BOS Equilibrium Pullback',
    'SMC',
    'Joins major external structure breaks on pullbacks toward the 50% Dealing Range equilibrium.',
    ['Confirmed external BOS within 14 bars', 'Price retraced near/beyond 50% equilibrium', 'Exec trend matches BOS direction'],
    ['SL beyond protected swing + 0.5x ATR', 'Targets external swing expansion']
  ),
  def(
    'SMC_DOUBLE_FVG_STACK',
    'Stacked Dual-FVG Imbalance Zone',
    'SMC',
    'High-conviction limit setup requiring at least two active same-direction Fair Value Gaps near current price.',
    ['>= 2 active same-direction FVGs within 3.5x ATR', 'Trend or HTF not counter-trend', 'Limit fill at nearest FVG'],
    ['SL beyond outer FVG edge + 0.45x ATR', 'Targets opposing structural liquidity']
  ),
  def(
    'SMC_HTF_BIAS_DISCOUNT_OB',
    'HTF Aligned + Discount/Premium OB',
    'SMC',
    'Combines strict HTF market structure, favorable Dealing Range quadrant, and unmitigated Order Block limit.',
    ['Strict HTF trend match', 'Discount (Buy) or Premium (Sell) position', 'Valid unmitigated OB limit retest'],
    ['SL beyond OB distal + 0.45x ATR', 'Targets HTF liquidity & range boundary']
  ),
  def(
    'SMC_FRESH_RBR_DBD_ZONE',
    'Fresh RBR / DBD Base Continuation',
    'SMC',
    'Trades untouched Rally-Base-Rally Demand or Drop-Base-Drop Supply continuation bases.',
    ['Fresh RBR (Buy) or DBD (Sell) zone within 2.5x ATR', 'Departure strength >= 1.5x ATR', 'Limit retest at proximal edge'],
    ['SL beyond distal base + 0.45x ATR', 'Targets trend expansion liquidity']
  ),
  def(
    'SMC_FRESH_DBR_RBD_TURN',
    'Fresh DBR / RBD Reversal Base',
    'SMC',
    'Trades untouched Drop-Base-Rally Demand or Rally-Base-Drop Supply reversal origin zones.',
    ['Fresh DBR (Buy) or RBD (Sell) zone within 2.5x ATR', 'Confirmed shift or candle trigger', 'Limit retest at proximal'],
    ['SL beyond distal extreme + 0.5x ATR', 'Targets opposing supply/demand']
  ),
  def(
    'SMC_SWEEP_FVG_MARKET',
    'Liquidity Sweep + FVG Market Snap',
    'SMC',
    'Market-close execution after a recent liquidity sweep immediately prints an aligned Fair Value Gap.',
    ['Recent SSL/BSL sweep within 12 bars', 'Fresh aligned FVG formed near current price', 'Strong displacement candle close'],
    ['SL beyond sweep low/high + 0.5x ATR', 'Targets opposing liquidity pool']
  ),
  def(
    'SMC_DAILY_OPEN_JUDAS_SWING',
    'Daily Open Judas Swing Reversal',
    'SMC',
    'Captures classic false breaks across the Daily Open anchor followed by an opposing structure shift.',
    ['Wick/prior bar crossed Daily Open then closed opposite', 'Confirmed MSS/CHoCH or strong displacement', 'Daily open acts as springboard'],
    ['SL beyond Judas extreme + 0.5x ATR', 'Targets PDH/PDL & liquidity pools']
  ),
  def(
    'SMC_WEEKLY_OPEN_DISCOUNT_OB',
    'Weekly Open Alignment + Order Block',
    'SMC',
    'Filters Order Block entries using institutional Weekly Open bias (Discount below WO / Premium above WO).',
    ['Price favorable vs Weekly Open', 'Valid OB within 2.5x ATR', 'HTF structure not opposing'],
    ['SL beyond OB distal + 0.45x ATR', 'Targets weekly liquidity levels']
  ),
  def(
    'SMC_OTE_705_SNIPER',
    'OTE 70.5% Optimal Pocket Limit',
    'SMC',
    'Rests precision limit orders inside the 61.8%–78.6% OTE Fib pocket targeting the Dealing Range extreme.',
    ['HTF or Exec trend directional', 'Strict OTE 70.5% retracement zone limit fill', 'Valid swing protection'],
    ['SL beyond Dealing Range extreme + 0.4x ATR', 'Targets Range High/Low + extensions']
  ),
  def(
    'SMC_HTF_TREND_DISCOUNT_BOS',
    'HTF Trend + Discount/Premium + BOS',
    'SMC',
    'Joins confirmed Breaks of Structure strictly in HTF trend direction while still priced in Discount/Premium.',
    ['Strict HTF trend alignment', 'Confirmed BOS within 10 bars', 'Price in Discount (Buy) or Premium (Sell)'],
    ['SL beyond protected swing + 0.45x ATR', 'Targets opposing HTF liquidity']
  ),
  def(
    'SMC_LIQ_POOL_MAGNET_EXPANSION',
    'Unswept Liquidity Magnet Expansion',
    'SMC',
    'Enters on confirmed MSS/BOS specifically when high-R:R (>= 2.0) unswept external/BSL/SSL pools sit overhead/below.',
    ['Confirmed BOS/MSS within 8 bars', 'Unswept external/BSL/SSL pool >= 2.0R away', 'HTF bias supportive'],
    ['SL beyond pivot swing + 0.45x ATR', 'Min TP1 R:R >= 2.0 targeting liquidity']
  ),
  def(
    'SMC_PARTIAL_MITIGATED_OB',
    'Partially Mitigated OB Second Tap',
    'SMC',
    'Captures institutional continuation when price re-taps a partially mitigated Order Block in trend.',
    ['OB mitigationPercent between 10% and 65%', 'Confirmed trend aligned with OB', 'Rejection close near OB'],
    ['SL beyond OB distal + 0.45x ATR', 'Targets opposing swing & S/R']
  ),

  // =========================================================================
  // 31–60: PRICE ACTION & CANDLESTICK STRATEGIES
  // =========================================================================
  def(
    'PA_SR_REJECTION_CANDLE',
    'S/R Rejection + Reversal Candle',
    'Price Action',
    'Classic price action entries at S/R clusters (strength >= 55) confirmed by Engulfing, Pin Bar, Star, or Tweezer.',
    ['S/R zone strength >= 55 within 1.1x ATR', 'Confirmed reversal candlestick within 3 bars', 'Protected swing stop'],
    ['SL beyond pattern/S/R wick + 0.5x ATR', 'Targets opposing S/R clusters']
  ),
  def(
    'PA_ENGULFING_VOLUME',
    'Volume-Backed Engulfing Momentum',
    'Price Action',
    'Trades confirmed Bullish/Bearish Engulfing bars backed by above-average volume expansion (>= 1.2x).',
    ['Confirmed Bullish or Bearish Engulfing', 'Bar volume >= 1.2x 20-bar average', 'Body >= 0.4x ATR'],
    ['SL beyond engulfing pattern + 0.45x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'PA_ENGULFING_PULLBACK',
    'Trend-Pullback Engulfing Trigger',
    'Price Action',
    'Waits for 2+ counter-trend pullback bars in an active trend, entering on the confirmed engulfing resumption.',
    ['Exec or HTF trend aligned', 'At least 2 prior counter-candles before engulfing', 'Confirmed Engulfing bar close'],
    ['SL beyond engulfing extreme + 0.45x ATR', 'Targets trend continuation highs/lows']
  ),
  def(
    'PA_HAMMER_SHOOTING_STAR',
    'Pin Bar / Hammer / Shooting Star',
    'Price Action',
    'Trades institutional wick rejection bars (Hammer, Inverted Hammer, Shooting Star, Hanging Man).',
    ['Confirmed Hammer/Shooting Star pattern within 2 bars', 'Long rejection wick vs small body', 'HTF bias not strictly opposed'],
    ['SL beyond rejection wick tip + 0.45x ATR', 'Targets opposing S/R & swing levels']
  ),
  def(
    'PA_MORNING_EVENING_STAR',
    'Morning Star / Evening Star 3-Bar Turn',
    'Price Action',
    'High-conviction 3-candle reversal sequence signaling exhausted momentum and directional shift.',
    ['Confirmed Morning Star (Buy) or Evening Star (Sell)', 'Triggered within last 2 bars', 'Valid structural protection'],
    ['SL beyond 3-bar star extreme + 0.5x ATR', 'Targets opposing S/R & swings']
  ),
  def(
    'PA_INSIDE_BAR_BREAKOUT',
    'Inside Bar Coil Breakout',
    'Price Action',
    'Enters on directional breakout closes from tight Inside Bar volatility contractions.',
    ['Confirmed Inside Bar within last 3 bars', 'Current bar closes beyond mother bar high/low', 'Directional momentum >= 0.3x ATR'],
    ['SL beyond mother bar opposite end + 0.4x ATR', 'Targets swing & liquidity levels']
  ),
  def(
    'PA_OUTSIDE_BAR_EXPANSION',
    'Outside Bar Range Expansion',
    'Price Action',
    'Captures aggressive directional expansion bars that engulf the entire high-low range of the prior candle.',
    ['Confirmed Outside Bar pattern', 'Close finishes in outer 30% of bar range', 'Volume >= 1.0x average'],
    ['SL beyond outside bar opposite tip + 0.45x ATR', 'Targets opposing S/R levels']
  ),
  def(
    'PA_FAKEY_TRAP',
    'Fakey Inside-Bar False Breakout Trap',
    'Price Action',
    'Identifies inside bars that briefly fake-break one side on a wick before snapping back and closing through the other side.',
    ['Recent Inside Bar followed by false wick breach', 'Strong reversal close back across inside range', 'Trap reversal displacement'],
    ['SL beyond false-break wick + 0.45x ATR', 'Targets opposing swing liquidity']
  ),
  def(
    'PA_THREE_SOLDIERS_CROWS',
    'Three White Soldiers / Black Crows',
    'Price Action',
    'Strong 3-bar institutional trend continuation signal confirming sustained directional pressure.',
    ['Confirmed Three White Soldiers or Three Black Crows', 'Aligned with Exec or HTF momentum', 'Follow-through volume intact'],
    ['SL beyond 3-bar origin low/high + 0.5x ATR', 'Targets HTF opposing resistance/support']
  ),
  def(
    'PA_MARUBOZU_IMPULSE',
    'Marubozu Institutional Impulse',
    'Price Action',
    'Joins full-bodied Marubozu candles with minimal wicks reflecting pure one-sided order flow.',
    ['Confirmed Marubozu pattern within 2 bars', 'Aligned with HTF or Exec trend', 'Volume >= 1.1x average'],
    ['SL beyond Marubozu origin + 0.45x ATR', 'Targets next S/R or liquidity pool']
  ),
  def(
    'PA_TWEEZER_REVERSAL',
    'Tweezer Top / Tweezer Bottom Turn',
    'Price Action',
    'Double-bar extreme rejection where consecutive candles fail at virtually the exact same high or low.',
    ['Confirmed Tweezer Bottom (Buy) or Tweezer Top (Sell)', 'Triggered within 2 bars', 'Near swing or S/R extreme'],
    ['SL beyond matching tweezer wick + 0.45x ATR', 'Targets opposing S/R & swing']
  ),
  def(
    'PA_PIERCING_DARK_CLOUD',
    'Piercing Pattern & Dark Cloud Cover',
    'Price Action',
    'Two-bar deep-penetration counter-attack reversal piercing > 50% into the prior impulse candle.',
    ['Confirmed Piercing Pattern or Dark Cloud Cover', 'Within last 2 bars', 'Counter-trend extreme setup'],
    ['SL beyond 2-bar extreme + 0.45x ATR', 'Targets prior swing midpoint & opposing S/R']
  ),
  def(
    'PA_HARAMI_BREAK',
    'Harami Compression Reversal',
    'Price Action',
    'Bullish or Bearish Harami signaling momentum stall followed by directional expansion close.',
    ['Confirmed Bullish/Bearish Harami within 3 bars', 'Follow-through bar closes in signal direction', 'Not counter-HTF trend'],
    ['SL beyond Harami mother extreme + 0.45x ATR', 'Targets opposing structural levels']
  ),
  def(
    'PA_DRAGONFLY_GRAVESTONE_DOJI',
    'Dragonfly & Gravestone Doji Rejection',
    'Price Action',
    'Extreme single-bar tail rejections closing right back at the open/close edge.',
    ['Confirmed Dragonfly Doji (Buy) or Gravestone Doji (Sell)', 'Triggered within 2 bars', 'Rejection wick >= 0.6x ATR'],
    ['SL beyond Doji tail + 0.45x ATR', 'Targets opposing S/R & swing levels']
  ),
  def(
    'PA_DOJI_CONFIRM_FLIP',
    'Indecision Doji + Momentum Confirm',
    'Price Action',
    'Waits for an indecision Doji followed immediately by a decisive directional confirmation bar.',
    ['Confirmed Doji on prior 1–2 bars', 'Current bar closes strongly >= 0.4x ATR in direction', 'Volume expands on confirm bar'],
    ['SL beyond Doji/confirm low/high + 0.45x ATR', 'Targets opposing liquidity & S/R']
  ),
  def(
    'PA_EMA20_PULLBACK',
    '20-EMA Dynamic Pullback Bounce',
    'Price Action',
    'Pullback trend strategy buying/selling bounces off the causal 20-period exponential moving average.',
    ['Slope & close aligned with 20-EMA', 'Prior/current bar touches or dips near 20-EMA', 'Strong directional rejection close'],
    ['SL beyond local pullback swing + 0.45x ATR', 'Targets trend continuation highs/lows']
  ),
  def(
    'PA_EMA20_50_TREND_CROSS',
    '20/50 EMA Trend Alignment Pullback',
    'Price Action',
    'Strict dual moving-average regime strategy trading pullbacks when 20-EMA > 50-EMA (Buy) or 20-EMA < 50-EMA (Sell).',
    ['20-EMA and 50-EMA cleanly stacked in direction', 'Price pulls back to 20–50 EMA ribbon', 'Bullish/Bearish close resumes trend'],
    ['SL beyond 50-EMA / swing invalidation + 0.5x ATR', 'Targets trend expansion liquidity']
  ),
  def(
    'PA_DONCHIAN_20_BREAKOUT',
    '20-Bar Donchian Channel Breakout',
    'Price Action',
    'Classic trend-following breakout closing cleanly above the highest high or below the lowest low of the last 20 bars.',
    ['Close exceeds prior 20-bar High (Buy) or Low (Sell)', 'Bar body >= 0.45x ATR', 'Volume >= 1.1x average'],
    ['SL anchored at 10-bar midpoint/swing + 0.5x ATR', 'Targets HTF liquidity pools']
  ),
  def(
    'PA_DONCHIAN_TURTLE_SOUP',
    'Turtle Soup 20-Bar False Breakout',
    'Price Action',
    'Mean-reversion trap fading failed 20-bar breakouts that sweep the 20-bar high/low and close back inside.',
    ['Bar wicks beyond prior 20-bar High/Low', 'Close reverses firmly back inside 20-bar channel', 'Rejection wick >= 0.35x ATR'],
    ['SL beyond false-breakout spike + 0.45x ATR', 'Targets 20-bar channel midpoint & opposite boundary']
  ),
  def(
    'PA_NR4_VOLATILITY_BREAK',
    'NR4 Volatility Contraction Breakout',
    'Price Action',
    'Enters on directional breakouts immediately following a Narrowest-Range-4 compression candle.',
    ['Prior bar was narrowest range of last 4 bars (< 0.75 ATR)', 'Current bar breaks NR4 high/low on close', 'Momentum >= 0.4x ATR'],
    ['SL beyond NR4 opposite bound + 0.45x ATR', 'Targets opposing liquidity & S/R']
  ),
  def(
    'PA_NR7_VOLATILITY_BREAK',
    'NR7 Deep Compression Breakout',
    'Price Action',
    'Captures explosive range expansions out of Narrowest-Range-7 tight volatility coils.',
    ['Prior bar was narrowest range of last 7 bars (< 0.7 ATR)', 'Current bar closes cleanly beyond NR7 extreme', 'Volume expansion >= 1.1x'],
    ['SL beyond NR7 opposite bound + 0.45x ATR', 'Targets major S/R & liquidity targets']
  ),
  def(
    'PA_TWO_BAR_RAIL_REVERSAL',
    'Two-Bar Rail-Track Rejection',
    'Price Action',
    'Trades paired consecutive opposing full-bodied candles signaling sudden institutional absorption.',
    ['Prior bar strong directional impulse (>= 0.6 ATR)', 'Current bar equally strong opposing close reclaiming >= 80%', 'Volume >= 1.1x'],
    ['SL beyond 2-bar rail extreme + 0.45x ATR', 'Targets opposing swings & S/R']
  ),
  def(
    'PA_EXHAUSTION_5BAR_FADE',
    '5-Bar Exhaustion Snapback Reversal',
    'Price Action',
    'Fades overextended 4–5 consecutive unidirectional runs when a decisive opposing reversal candle closes.',
    ['>= 4 prior consecutive unidirectional closes', 'Current bar prints strong opposing reversal (> 0.5x ATR)', 'Not mid-consolidation'],
    ['SL beyond exhaustion extreme + 0.5x ATR', 'Targets pullback equilibrium & S/R']
  ),
  def(
    'PA_HTF_ALIGNED_PINBAR',
    'HTF-Aligned Pin Bar Continuation',
    'Price Action',
    'Filters Hammer/Shooting Star/Doji tail rejections strictly through the lens of Higher-Timeframe trend.',
    ['Strict HTF trend match', 'Confirmed tail rejection candlestick within 2 bars', 'Price in trend pullback'],
    ['SL beyond pin bar wick + 0.45x ATR', 'Targets HTF liquidity & swing highs/lows']
  ),
  def(
    'PA_BODY_DOMINANCE_75',
    '75%+ Body-Dominance Momentum Surge',
    'Price Action',
    'Rides ultra-clean impulse candles where open-to-close body accounts for >= 75% of total bar range.',
    ['Candle body >= 75% of high-low range', 'Candle size >= 1.1x ATR', 'Aligned with Exec trend'],
    ['SL beyond impulse bar origin + 0.45x ATR', 'Targets opposing liquidity pools']
  ),
  def(
    'PA_SWING_HL_LH_BOUNCE',
    'Confirmed HL / LH Structure Bounce',
    'Price Action',
    'Buys confirmed Higher Lows (HL) in uptrends and sells Lower Highs (LH) in downtrends with bounce confirmation.',
    ['Latest confirmed swing labeled HL (Buy) or LH (Sell)', 'Price holds above/below swing + bullish/bearish bar', 'Exec trend aligned'],
    ['SL beyond HL/LH swing + 0.45x ATR', 'Targets prior HH/LL & extensions']
  ),
  def(
    'PA_SWEEP_WICK_SNAPBACK',
    'Prior-3-Bar Wick Sweep Snapback',
    'Price Action',
    'Captures liquidity grabs where a bar sweeps the previous 3-bar extreme and closes with a >= 50% rejection wick.',
    ['Pierces min/max of prior 3 bars', 'Rejection wick >= 50% of bar range', 'Close finishes on reversal side'],
    ['SL beyond wick spike + 0.45x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'PA_BACK_TO_BACK_PATTERNS',
    'Double Candlestick Pattern Cluster',
    'Price Action',
    'Requires two distinct confirmed same-direction candlestick signals firing within a tight 4-bar window.',
    ['>= 2 confirmed same-direction candle patterns in 4 bars', 'Momentum confirms direction', 'Valid structural SL'],
    ['SL beyond pattern cluster + 0.5x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'PA_VOLUME_CLIMAX_TURN',
    'High-Volume Climax Exhaustion Turn',
    'Price Action',
    'Detects >= 1.9x average volume climax spikes with long exhaustion wicks signaling capitulation.',
    ['Bar or prior bar volume >= 1.9x 20-bar avg', 'Wick rejection or opposite reversal close', 'Swing invalidation intact'],
    ['SL beyond climax extreme + 0.5x ATR', 'Targets mean-reversion S/R clusters']
  ),
  def(
    'PA_MULTI_BAR_COMPRESSION_RELEASE',
    '3-Bar Tight Coil Volatility Release',
    'Price Action',
    'Identifies 3 consecutive tight bars (< 0.75 ATR each) released by an expanding >= 1.1 ATR directional candle.',
    ['3 prior bars all have range < 0.8x ATR', 'Current bar range >= 1.05x ATR breaking coil', 'Strong close near bar extreme'],
    ['SL beyond 3-bar coil opposite edge + 0.45x ATR', 'Targets opposing swing liquidity']
  ),

  // =========================================================================
  // 61–87: CHART PATTERNS & TRENDLINES
  // =========================================================================
  def(
    'PA_TRENDLINE_PATTERN_BREAK',
    'Trendline & Chart Pattern Breakout',
    'Chart Patterns',
    'Trades confirmed structural breakouts and retests of dynamic Trendlines and classical Chart Patterns.',
    ['Broken/retested trendline or Chart Pattern breakout <=6b', 'Displacement >= 0.25x ATR', 'Clear structural invalidation'],
    ['SL beyond pattern/pivot invalidation + 0.45x ATR', 'Targets pattern measured move & opposing S/R']
  ),
  def(
    'CP_DOUBLE_TOP_BOTTOM_BREAK',
    'Double Top / Double Bottom Breakout',
    'Chart Patterns',
    'Classical M-top breakdown and W-bottom breakout across confirmed neckline resistance or support.',
    ['Confirmed Double Bottom (Buy) or Double Top (Sell)', 'Status Breakout or Retest within 8 bars', 'Close confirmed beyond neckline'],
    ['SL beyond right shoulder/pivot + 0.5x ATR', 'Targets full Double Top/Bottom measured height']
  ),
  def(
    'CP_DOUBLE_TOP_BOTTOM_RETEST',
    'Double Top / Double Bottom Retest',
    'Chart Patterns',
    'Conservative pullback entry after Double Top/Bottom neckline breakout retests broken neckline cleanly.',
    ['Double Top or Double Bottom in Retest status', 'Price retesting neckline within tolerance', 'Directional close holds neckline'],
    ['SL beyond neckline invalidation + 0.45x ATR', 'Targets measured pattern objective']
  ),
  def(
    'CP_TRIPLE_TOP_BOTTOM_BREAK',
    'Triple Top / Triple Bottom Breakout',
    'Chart Patterns',
    'High-conviction 3-peak/3-trough exhaustion structure breaking out across the confirmed neckline.',
    ['Triple Top or Triple Bottom in Breakout/Retest', 'Volume or displacement confirms break', 'Structural stop anchored cleanly'],
    ['SL beyond pattern invalidation + 0.5x ATR', 'Targets triple pattern measured move']
  ),
  def(
    'CP_HEAD_SHOULDERS_BREAK',
    'Head & Shoulders / Inverse H&S Break',
    'Chart Patterns',
    'Institutional trend-reversal neckline breakout of Head & Shoulders and Inverse Head & Shoulders structures.',
    ['Head and Shoulders or Inverse H&S Breakout', 'Triggered within 8 bars', 'Strong directional close past neckline'],
    ['SL beyond right shoulder invalidation + 0.5x ATR', 'Targets head-to-neckline measured target']
  ),
  def(
    'CP_HEAD_SHOULDERS_RETEST',
    'Head & Shoulders Neckline Retest',
    'Chart Patterns',
    'Second-chance retest entry as price pulls back to kiss the broken H&S or Inverse H&S neckline.',
    ['H&S or Inverse H&S in Retest status', 'Bar rejects neckline zone', 'Reversal momentum confirms'],
    ['SL beyond neckline/shoulder invalidation + 0.45x ATR', 'Targets measured H&S objective']
  ),
  def(
    'CP_ASCENDING_TRIANGLE_BREAK',
    'Ascending Triangle Upward Breakout',
    'Chart Patterns',
    'Bullish accumulation coil with rising higher lows breaking upward through flat horizontal resistance.',
    ['Ascending Triangle Breakout or Retest', 'Bullish close above flat resistance', 'Valid rising-trendline invalidation'],
    ['SL below ascending base + 0.45x ATR', 'Targets triangle height measured projection']
  ),
  def(
    'CP_DESCENDING_TRIANGLE_BREAK',
    'Descending Triangle Breakdown',
    'Chart Patterns',
    'Bearish distribution pattern with lower highs breaking down through horizontal support.',
    ['Descending Triangle Breakout or Retest', 'Bearish close below horizontal support', 'Valid descending invalidation'],
    ['SL above descending base + 0.45x ATR', 'Targets triangle height downside target']
  ),
  def(
    'CP_SYMMETRICAL_TRIANGLE_BREAK',
    'Symmetrical Triangle Apex Breakout',
    'Chart Patterns',
    'Converging volatility contraction breaking decisively upward or downward near triangle apex.',
    ['Symmetrical Triangle Breakout or Retest', 'Displacement close >= 0.3x ATR', 'Clear apex invalidation'],
    ['SL beyond opposite triangle leg + 0.45x ATR', 'Targets triangle mouth measured target']
  ),
  def(
    'CP_RISING_WEDGE_BREAKDOWN',
    'Rising Wedge Bearish Breakdown',
    'Chart Patterns',
    'Exhaustion rising wedge breaking down through lower ascending support line.',
    ['Rising Wedge in Breakout/Retest status', 'Bearish close below lower wedge trendline', 'Volume or momentum confirms'],
    ['SL above upper wedge high + 0.5x ATR', 'Targets wedge base origin']
  ),
  def(
    'CP_FALLING_WEDGE_BREAKOUT',
    'Falling Wedge Bullish Breakout',
    'Chart Patterns',
    'Exhausted downward drift breaking upward out of a converging Falling Wedge formation.',
    ['Falling Wedge in Breakout/Retest status', 'Bullish close above upper wedge resistance', 'Protected wedge low'],
    ['SL below lower wedge trough + 0.5x ATR', 'Targets wedge top origin']
  ),
  def(
    'CP_FLAG_BREAKOUT',
    'Bullish & Bearish Flag Breakout',
    'Chart Patterns',
    'Continuation breakout from orderly counter-trend Flag channels following strong impulsive poles.',
    ['Bullish Flag or Bearish Flag Breakout <=6b', 'Close clears flag channel boundary', 'HTF or Exec flow supportive'],
    ['SL beyond flag counter-pivot + 0.45x ATR', 'Targets flagpole measured projection']
  ),
  def(
    'CP_FLAG_RETEST',
    'Bullish & Bearish Flag Retest',
    'Chart Patterns',
    'Pullback retest onto the broken Flag trendline for high-R:R trend continuation.',
    ['Bullish Flag or Bearish Flag in Retest status', 'Hold at broken flag boundary', 'Trend continuation bar close'],
    ['SL beyond flag invalidation + 0.45x ATR', 'Targets flagpole measured projection']
  ),
  def(
    'CP_PENNANT_BREAKOUT',
    'Bullish & Bearish Pennant Expansion',
    'Chart Patterns',
    'Tight symmetrical Pennant continuation breakout extending the prior impulsive pole.',
    ['Bullish Pennant or Bearish Pennant Breakout/Retest', 'Strong momentum bar close', 'Valid pennant invalidation'],
    ['SL beyond pennant extreme + 0.45x ATR', 'Targets pennant measured target']
  ),
  def(
    'CP_RECTANGLE_BREAKOUT',
    'Rectangle Consolidation Box Break',
    'Chart Patterns',
    'Range expansion breakout cleanly escaping horizontal Rectangle accumulation/distribution boxes.',
    ['Rectangle pattern Breakout or Retest', 'Close beyond box boundary', 'Displacement >= 0.3x ATR'],
    ['SL inside/beyond opposite rectangle boundary + 0.45x ATR', 'Targets rectangle height measured move']
  ),
  def(
    'CP_CUP_HANDLE_BREAKOUT',
    'Cup & Handle Rim Breakout',
    'Chart Patterns',
    'Bullish accumulation saucer + handle consolidation breaking decisively above horizontal rim resistance.',
    ['Cup and Handle in Confirmed/Breakout/Retest', 'Bullish close above rim neckline', 'Handle low invalidation intact'],
    ['SL below handle low + 0.45x ATR', 'Targets cup depth measured upside']
  ),
  def(
    'CP_ROUNDING_REVERSAL',
    'Rounding Bottom / Top Macro Turn',
    'Chart Patterns',
    'Gradual curved accumulation (Rounding Bottom) or distribution (Rounding Top) neckline breakout.',
    ['Rounding Bottom or Rounding Top Breakout/Retest', 'Confirmed directional close', 'Clean bowl invalidation'],
    ['SL beyond pattern invalidation + 0.5x ATR', 'Targets bowl depth measured target']
  ),
  def(
    'CP_HIGH_SCORE_PATTERN_78',
    'High-Quality Chart Patterns (>=78)',
    'Chart Patterns',
    'Filters all classical chart pattern breakouts strictly for structural qualityScore >= 78.',
    ['Any Chart Pattern Breakout/Retest <=8b', 'Pattern qualityScore >= 78', 'Directional bar confirmation'],
    ['SL beyond pattern invalidation + 0.45x ATR', 'Targets pattern measured objective']
  ),
  def(
    'CP_HTF_ALIGNED_PATTERN',
    'HTF-Aligned Chart Pattern Breakout',
    'Chart Patterns',
    'Trades only Chart Pattern breakouts whose direction strictly matches Higher-Timeframe trend.',
    ['Any Chart Pattern Breakout/Retest <=8b', 'Strict HTF trend matches pattern direction', 'Clean invalidation level'],
    ['SL beyond pattern invalidation + 0.45x ATR', 'Targets pattern measured move + HTF liquidity']
  ),
  def(
    'CP_VOLUME_CONFIRMED_PATTERN',
    'Volume-Surging Chart Pattern Break',
    'Chart Patterns',
    'Requires >= 1.25x average volume confirmation on classical Chart Pattern breakouts to filter false breaks.',
    ['Any Chart Pattern Breakout <=6b', 'Volume >= 1.25x 20-bar average', 'Full directional bar close'],
    ['SL beyond pattern invalidation + 0.45x ATR', 'Targets measured move & S/R']
  ),
  def(
    'CP_FORMING_BOUNDARY_TURN',
    'Confirmed Pattern Boundary Bounce',
    'Chart Patterns',
    'Enters on confirmed chart patterns near boundary support/resistance before full breakout completes.',
    ['Chart Pattern in Confirmed status (quality >= 70)', 'Price touching pattern invalidation boundary + reversal bar', 'High R:R inside pattern'],
    ['SL beyond pattern boundary + 0.45x ATR', 'Targets opposite boundary & breakout level']
  ),
  def(
    'CP_TRENDLINE_3TOUCH_BOUNCE',
    '3+ Touch Trendline Bounce',
    'Chart Patterns',
    'Bounces off well-validated dynamic diagonal Trendlines tested at least 3 distinct times.',
    ['Confirmed trendline with >= 3 touches', 'Price within 0.75x ATR of projected trendline', 'Directional rejection close'],
    ['SL beyond trendline touch extreme + 0.45x ATR', 'Targets opposing swings & liquidity']
  ),
  def(
    'CP_TRENDLINE_BREAK_CLOSE',
    'Diagonal Trendline Breakout',
    'Chart Patterns',
    'Direct momentum breakout closing across multi-touch dynamic support or resistance trendlines.',
    ['Trendline status === broken within 4 bars', 'Displacement >= 0.35x ATR in breakout direction', 'Valid structural stop'],
    ['SL beyond breakout candle/swing + 0.45x ATR', 'Targets opposing S/R & swing levels']
  ),
  def(
    'CP_TRENDLINE_RETEST_FLIP',
    'Broken Trendline Polarity Retest',
    'Chart Patterns',
    'Classic kiss-goodbye retest of a broken diagonal trendline turning prior support into resistance (or inverse).',
    ['Trendline status === retested within 6 bars', 'Price holding broken trendline flip side', 'Directional bar confirm'],
    ['SL beyond retest extreme + 0.45x ATR', 'Targets opposing liquidity & swings']
  ),
  def(
    'CP_CHANNEL_MEAN_REVERSION',
    'Dynamic Channel Boundary Bounce',
    'Chart Patterns',
    'Trades mean-reversion swings between upper and lower rails of Ascending/Descending/Parallel Channels.',
    ['Active ascending/descending/parallel channel trendline', 'Price near lower/upper rail with rejection close', 'Valid channel stop'],
    ['SL outside channel rail + 0.45x ATR', 'Targets opposite channel rail']
  ),
  def(
    'CP_CHANNEL_BREAKOUT',
    'Parallel & Trend Channel Breakout',
    'Chart Patterns',
    'Captures acceleration when price breaks cleanly out of a sustained Ascending/Descending/Parallel Channel.',
    ['Channel trendline broken or retested within 5 bars', 'Displacement >= 0.35x ATR', 'Volume >= 1.0x average'],
    ['SL beyond channel midpoint/origin + 0.45x ATR', 'Targets channel width projection']
  ),
  def(
    'CP_PATTERN_WITH_CANDLE',
    'Chart Pattern + Reversal Candlestick',
    'Chart Patterns',
    'Dual confirmation combining a Confirmed/Breakout/Retest Chart Pattern with an aligned Candlestick signal.',
    ['Chart Pattern Confirmed/Breakout/Retest <=8b', 'Aligned confirmed Candlestick pattern <=3b', 'Valid structural invalidation'],
    ['SL beyond pattern/candle extreme + 0.45x ATR', 'Targets measured move & S/R']
  ),

  // =========================================================================
  // 88–111: SUPPORT & RESISTANCE (S/R) STRATEGIES
  // =========================================================================
  def(
    'SR_MAJOR_CLUSTER_70',
    'Major S/R Cluster (>=70 Strength) Bounce',
    'Support & Resistance',
    'Trades high-weight multi-source Support/Resistance zones (strengthScore >= 70) with clean bounce confirmation.',
    ['Active S/R zone with strengthScore >= 70 within 1.0x ATR', 'Bullish close off Support / Bearish close off Resistance', 'No broken status'],
    ['SL beyond S/R outer boundary + 0.45x ATR', 'Targets opposing major S/R cluster']
  ),
  def(
    'SR_MULTI_TOUCH_3PLUS',
    'Multi-Touch Fortified S/R (3+ Touches)',
    'Support & Resistance',
    'Enters at battle-tested horizontal S/R levels defended at least 3 times by institutional resting liquidity.',
    ['S/R zone with touches >= 3 within 1.0x ATR', 'Rejection close away from level', 'Valid SL behind zone'],
    ['SL beyond fortified S/R edge + 0.45x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'SR_BREAKOUT_RETEST_FLIP',
    'S/R Polarity Flip Retest',
    'Support & Resistance',
    'Classic Support-turned-Resistance / Resistance-turned-Support retest after confirmed horizontal breakout.',
    ['S/R zone in Retesting status (or recently Broken)', 'Price pulling back onto flipped level', 'Continuation bar closes cleanly'],
    ['SL beyond flipped S/R level + 0.45x ATR', 'Targets next major S/R & liquidity']
  ),
  def(
    'SR_IMPULSE_BREAKOUT',
    'S/R High-Momentum Breakout',
    'Support & Resistance',
    'Captures explosive breakouts slicing cleanly through horizontal Support or Resistance with displacement.',
    ['S/R zone Breaking/Broken on current/recent bar', 'Bar displacement >= 0.55x ATR through zone', 'Volume >= 1.15x avg'],
    ['SL behind broken S/R zone + 0.5x ATR', 'Targets next structural S/R level']
  ),
  def(
    'SR_PDH_PDL_REJECTION',
    'Previous Day High/Low (PDH/PDL) Defense',
    'Support & Resistance',
    'Fades rejections at Previous Day High resistance and Previous Day Low support anchors.',
    ['PDH/PDL S/R zone near price (within 1.0x ATR)', 'Wick rejection / directional close off anchor', 'HTF not overwhelmingly counter'],
    ['SL beyond PDH/PDL boundary + 0.45x ATR', 'Targets Daily Open & opposite daily extreme']
  ),
  def(
    'SR_PDH_PDL_BREAK_CONTINUATION',
    'PDH / PDL Breakout Trend Continuation',
    'Support & Resistance',
    'Joins sustained directional expansion once price breaks and holds cleanly beyond PDH or PDL.',
    ['Close breaks cleanly past PDH (Buy) or PDL (Sell)', 'HTF trend or momentum aligned', 'Body >= 0.35x ATR'],
    ['SL behind PDH/PDL anchor + 0.5x ATR', 'Targets PWH/PWL & HTF liquidity']
  ),
  def(
    'SR_PWH_PWL_DEFENSE',
    'Previous Week High/Low (PWH/PWL) Turn',
    'Support & Resistance',
    'Institutional reaction trades at high-weight Weekly High/Low S/R zones.',
    ['PWH/PWL S/R zone within 1.2x ATR', 'Directional reversal candle or rejection', 'Clean risk/reward to opposing S/R'],
    ['SL beyond PWH/PWL zone + 0.5x ATR', 'Targets weekly open & opposing S/R']
  ),
  def(
    'SR_PMH_PML_MACRO_REACTION',
    'Previous Month High/Low (PMH/PML) Level',
    'Support & Resistance',
    'Macro structural defense plays when price tests Previous Month High or Low horizontal boundaries.',
    ['PMH/PML S/R zone within 1.4x ATR', 'Directional rejection close', 'Opposing structural targets >= min R:R'],
    ['SL beyond PMH/PML zone + 0.55x ATR', 'Targets multi-day S/R clusters']
  ),
  def(
    'SR_DAILY_FLOOR_PIVOT',
    'Daily Floor Pivot (PP / S1 / R1) Bounce',
    'Support & Resistance',
    'Algorithmic mean-reversion reactions at institutional Floor Pivot Point, S1, and R1 levels.',
    ['Floor Pivot S/R zone (source pivot) within 1.0x ATR', 'Confirmed bounce candle or close', 'Valid pivot stop'],
    ['SL beyond pivot zone + 0.45x ATR', 'Targets adjacent pivot / PDH-PDL']
  ),
  def(
    'SR_SESSION_HL_DEFENSE',
    'Session High/Low Horizontal Defense',
    'Support & Resistance',
    'Intraday S/R bounces off completed Asian, London, or New York session high/low clusters.',
    ['Session H/L S/R zone (source session_hl) within 1.0x ATR', 'Rejection close away from session edge', 'Risk/reward >= min R:R'],
    ['SL beyond session S/R edge + 0.45x ATR', 'Targets opposing session high/low']
  ),
  def(
    'SR_SWING_CLUSTER_SUPPORT',
    'Swing-Cluster Support Long Engine',
    'Support & Resistance',
    'Dedicated bullish strategy buying high-integrity swing-cluster support floors on upward confirmation.',
    ['Active swing_cluster Support zone within 1.0x ATR', 'Bullish candle close above support midpoint', 'HTF not strongly bearish'],
    ['SL below support cluster lower edge + 0.45x ATR', 'Targets nearest resistance & BSL']
  ),
  def(
    'SR_SWING_CLUSTER_RESISTANCE',
    'Swing-Cluster Resistance Short Engine',
    'Support & Resistance',
    'Dedicated bearish strategy shorting verified swing-cluster resistance ceilings on downward rejection.',
    ['Active swing_cluster Resistance zone within 1.0x ATR', 'Bearish candle close below resistance midpoint', 'HTF not strongly bullish'],
    ['SL above resistance cluster upper edge + 0.45x ATR', 'Targets nearest support & SSL']
  ),
  def(
    'SR_HTF_ALIGNED_BOUNCE',
    'HTF Trend-Aligned S/R Pullback',
    'Support & Resistance',
    'Trades horizontal Support in HTF uptrends and horizontal Resistance in HTF downtrends.',
    ['Strict HTF trend matches S/R side', 'Price testing active S/R within 1.0x ATR', 'Trend-resuming bar close'],
    ['SL beyond S/R boundary + 0.45x ATR', 'Targets HTF swing & liquidity']
  ),
  def(
    'SR_WICK_ABSORPTION',
    'S/R Wick Absorption Pin Bounce',
    'Support & Resistance',
    'Captures aggressive limit absorption when candle wicks pierce inside an S/R zone and reject outward.',
    ['Bar low/high penetrates active S/R band', 'Close finishes cleanly outside zone on safe side', 'Rejection wick >= 40% of range'],
    ['SL beyond absorption wick tip + 0.45x ATR', 'Targets opposing S/R zone']
  ),
  def(
    'SR_LIMIT_MIDPOINT_PASSIVE',
    'Passive S/R Midpoint Limit Order',
    'Support & Resistance',
    'Places passive limit orders at the exact midpoint of nearby major S/R zones (strength >= 60).',
    ['Major S/R (strength >= 60) within 2.4x ATR', 'HTF structure not opposing trade side', 'Limit entry resting at zone midpoint'],
    ['SL beyond S/R distal + 0.45x ATR', 'Targets opposing S/R cluster']
  ),
  def(
    'SR_RANGE_BOUND_FADE',
    'Consolidation Regime S/R Mean-Reversion',
    'Support & Resistance',
    'Thrives in sideways/ranging markets by buying Support and selling Resistance during consolidation.',
    ['Exec trend === consolidation', 'Price touching active Support or Resistance', 'Opposite close confirmation'],
    ['SL outside S/R range boundary + 0.45x ATR', 'Targets range equilibrium & opposite wall']
  ),
  def(
    'SR_EQUILIBRIUM_OVERLAP',
    '50% Equilibrium + S/R Pivot Flip',
    'Support & Resistance',
    'Trades S/R zones aligned within 0.6x ATR of the Dealing Range 50% Equilibrium line.',
    ['Active S/R within 0.6x ATR of Dealing Range equilibrium', 'Directional momentum aligned', 'Bounce close off overlap'],
    ['SL beyond S/R overlap + 0.45x ATR', 'Targets Dealing Range High/Low']
  ),
  def(
    'SR_HIGH_VOLUME_HOLD',
    'Volume-Surging S/R Defense (>=1.3x)',
    'Support & Resistance',
    'Requires >= 1.3x average volume footprint validating genuine buyer/seller absorption at horizontal S/R.',
    ['Active S/R touch/near within 1.0x ATR', 'Volume >= 1.3x 20-bar average', 'Directional close holds level'],
    ['SL beyond S/R boundary + 0.45x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'SR_VERIFIED_REJECTION_HOLD',
    'Proven Multi-Rejection S/R Hold (>=2)',
    'Support & Resistance',
    'Selects only S/R zones that have already produced >= 2 verified historical price rejections.',
    ['S/R zone with rejections >= 2', 'Price re-testing within 1.0x ATR', 'Confirmed bounce candle'],
    ['SL beyond S/R boundary + 0.45x ATR', 'Targets opposing S/R cluster']
  ),
  def(
    'SR_MTF_HTF_CONFLUENCE',
    'HTF + Exec Multi-Timeframe S/R Overlap',
    'Support & Resistance',
    'High-probability horizontal reactions where an Execution S/R zone overlaps an HTF S/R zone within 0.8x ATR.',
    ['Exec S/R overlaps HTF S/R within 0.8x ATR', 'Price testing nested S/R zone', 'Directional confirmation close'],
    ['SL beyond nested S/R zone + 0.5x ATR', 'Targets next HTF S/R zone']
  ),
  def(
    'SR_FALSE_BREAK_SNAPBACK',
    'S/R Spring / Upthrust False Break Trap',
    'Support & Resistance',
    'Wyckoff-style Spring & Upthrust trapping breakout traders beyond S/R before snapping back inside.',
    ['Wick breaches S/R outer boundary', 'Bar closes back firmly inside safe side of S/R', 'Strong reversal body >= 0.35x ATR'],
    ['SL beyond false-breakout spike + 0.45x ATR', 'Targets opposite S/R boundary']
  ),
  def(
    'SR_TRENDLINE_CONFLUENCE',
    'Horizontal S/R + Diagonal Trendline Cross',
    'Support & Resistance',
    'Enters at geometric intersections where an active horizontal S/R band meets a confirmed diagonal trendline.',
    ['Active S/R within 0.9x ATR of projected trendline', 'Price reacting at intersection', 'Directional close confirms'],
    ['SL beyond S/R + trendline vertex + 0.45x ATR', 'Targets opposing structural targets']
  ),
  def(
    'SR_COMPRESSION_BREAKOUT',
    'S/R Tight-Coil Breakout Release',
    'Support & Resistance',
    'Spots tight range-compressed candles coiling immediately beneath Resistance or above Support before breaking.',
    ['2+ prior tight bars near S/R boundary', 'Current bar >= 0.75x ATR breaks past S/R level', 'Volume >= 1.05x avg'],
    ['SL behind broken S/R coil + 0.45x ATR', 'Targets next major S/R level']
  ),
  def(
    'SR_DAILY_OPEN_ANCHOR_SR',
    'Daily Open + S/R Dual Anchor Bounce',
    'Support & Resistance',
    'Combines the institutional Daily Open line with an overlapping S/R zone within 0.9x ATR.',
    ['Active S/R within 0.9x ATR of Daily Open', 'Price testing dual anchor', 'Directional bounce close'],
    ['SL beyond dual anchor + 0.45x ATR', 'Targets PDH/PDL & opposing S/R']
  ),

  // =========================================================================
  // 112–120: HYBRID SMC / PRICE ACTION / CHART PATTERNS / S&R CONFLUENCE
  // =========================================================================
  def(
    'SMC_INSTITUTIONAL_CONSENSUS',
    'Institutional Multi-Confluence Consensus',
    'Hybrid SMC/PA',
    'High-selectivity institutional model requiring >= 4 simultaneous pillars: HTF Bias + Structure Break + Sweep/OB-FVG-SD/OTE.',
    ['Strict HTF alignment', 'Confirmed MSS/CHoCH/BOS within 12 bars', 'At least 2 extra pillars (Sweep, OB/FVG/SD, Discount/Premium)'],
    ['Min TP1 R:R >= max(1.8, config)', 'SL beyond protected swing + 0.5x ATR']
  ),
  def(
    'HYBRID_SWEEP_SR_CANDLE',
    'Liquidity Sweep + Major S/R + Candle',
    'Hybrid SMC/PA',
    'Tri-factor reversal uniting an institutional stop-hunt, Major S/R cluster, and confirmed Reversal Candlestick.',
    ['Recent SSL/BSL sweep within 14 bars', 'Active S/R zone (strength >= 55) near price', 'Confirmed reversal candle <= 3 bars'],
    ['SL beyond sweep/S/R extreme + 0.5x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'HYBRID_OB_SR_LIMIT',
    'Order Block + S/R Cluster Overlap Limit',
    'Hybrid SMC/PA',
    'Limit retest positioned where an unmitigated SMC Order Block overlaps an active horizontal S/R zone.',
    ['Valid unmitigated OB within 2.5x ATR', 'Active S/R overlaps OB within 0.8x ATR', 'Limit order at OB proximal edge'],
    ['SL beyond OB/S/R outer edge + 0.45x ATR', 'Targets opposing S/R & liquidity']
  ),
  def(
    'HYBRID_FVG_SD_LIMIT',
    'Fair Value Gap + Supply/Demand Overlap',
    'Hybrid SMC/PA',
    'Combines an unfilled institutional FVG inside or adjacent to a Fresh/Tested Supply or Demand origin zone.',
    ['Fresh/tested S/D zone within 2.5x ATR', 'Unfilled FVG overlapping S/D within 0.9x ATR', 'Limit fill at proximal boundary'],
    ['SL beyond S/D distal + 0.45x ATR', 'Targets opposing liquidity & S/D']
  ),
  def(
    'HYBRID_HTF_OB_ENGULF',
    'HTF Trend + Exec OB + Engulfing Trigger',
    'Hybrid SMC/PA',
    'Waits for price inside/near a valid Order Block in HTF trend direction and enters strictly on a confirmed Engulfing.',
    ['Strict HTF trend alignment', 'Valid OB within 1.2x ATR', 'Confirmed Engulfing candlestick <= 2 bars'],
    ['SL beyond OB distal + 0.45x ATR', 'Targets HTF swings & liquidity']
  ),
  def(
    'HYBRID_PATTERN_OB_ORIGIN',
    'Chart Pattern Breakout + OB Origin',
    'Hybrid SMC/PA',
    'Trades Classical Chart Pattern breakouts backed by an aligned institutional Order Block origin behind the break.',
    ['Chart Pattern Breakout/Retest <= 8 bars', 'Valid aligned OB behind breakout within 3.5x ATR', 'Clean measured target'],
    ['SL beyond pattern/OB invalidation + 0.5x ATR', 'Targets measured pattern move']
  ),
  def(
    'HYBRID_TRENDLINE_FVG_SNAP',
    'Trendline Break + FVG Displacement',
    'Hybrid SMC/PA',
    'Captures diagonal Trendline breaks/retests backed by newly created Fair Value Gap institutional displacement.',
    ['Trendline broken or retested within 6 bars', 'Aligned FVG within 2.5x ATR', 'Strong close displacement'],
    ['SL beyond trendline pivot + 0.45x ATR', 'Targets opposing liquidity & S/R']
  ),
  def(
    'HYBRID_OTE_SR_PINBAR',
    'OTE Fib Pocket + S/R + Pin Bar Sniper',
    'Hybrid SMC/PA',
    'Precision confluence uniting 62–79% OTE Fib zone, horizontal S/R overlap, and Hammer/Shooting Star/Doji rejection.',
    ['Price in Discount/Premium OTE zone', 'S/R zone near price', 'Confirmed Pin Bar / Hammer / Star <= 3 bars'],
    ['SL beyond S/R + OTE extreme + 0.45x ATR', 'Targets Dealing Range extreme']
  ),
  def(
    'HYBRID_QUADRUPLE_TRIFECTA',
    'HTF + BOS/MSS + Volume Surge + PA Candle',
    'Hybrid SMC/PA',
    'Institutional momentum confirmation demanding HTF alignment, BOS/MSS break, >= 1.2x volume, and confirmed candle pattern.',
    ['Strict HTF trend match', 'Confirmed BOS/MSS within 10 bars', 'Volume >= 1.2x avg + confirmed candle pattern'],
    ['SL beyond protected swing + 0.5x ATR', 'Targets opposing liquidity pools']
  ),
  ...COMBO_STRATEGY_DEFINITIONS,
];
