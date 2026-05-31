import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function booleanConfig(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
// Gunakan = bukan ||=: string "false" adalah truthy sehingga ||= tidak override.
// user-config.json harus selalu menang atas .env untuk setting dryRun.
if (u.dryRun !== undefined) process.env.DRY_RUN = String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

// Intelligence API keys from user-config.json
if (u.gmgnApiKey)    process.env.GMGN_API_KEY    ||= u.gmgnApiKey;
if (u.duneApiKey)    process.env.DUNE_API_KEY    ||= u.duneApiKey;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Mode ────────────────────────────────
  // process.env.DRY_RUN sudah disync dari u.dryRun di atas, jadi cukup baca env var.
  // Fallback false (live mode) jika tidak ada konfigurasi sama sekali.
  dryRun: u.dryRun !== undefined ? booleanConfig(u.dryRun, true) : (process.env.DRY_RUN === "true"),
  dryRunWallet: numericConfig(u.dry_run_wallet ?? u.dryRunWallet ?? process.env.DRY_RUN_WALLET),

  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:         u.maxPositions         ?? 3,
    maxDeployAmount:      u.maxDeployAmount       ?? 50,
    // Portfolio-level breakers — pause deploy when trading is going badly.
    // maxConsecutiveLosses: pause after N consecutive losing closes (null = disabled).
    // maxDailyLossUsd: pause if total closed PnL in the last 24h falls below -X USD (null = disabled).
    maxConsecutiveLosses: u.maxConsecutiveLosses ?? 3,
    maxDailyLossUsd:      u.maxDailyLossUsd      ?? null,
    // Correlated exposure cap: refuse deploy if total SOL across open positions would exceed this.
    // null = disabled. Example: 3.0 means don't hold more than 3 SOL deployed at once.
    maxTotalSolExposure:  u.maxTotalSolExposure   ?? null,
    // Block new deploys if ALL open positions are currently out of range.
    // Prevents adding capital when the entire portfolio is losing alignment.
    blockDeployIfAllOOR:  u.blockDeployIfAllOOR   ?? false,
    // Portfolio heat engine: each open position contributes a heat score.
    // Heat per position = 1 (base) + 2 (if OOR) + 1 (if OOR >30min) + 1 (if pnl<-5%) + 1 (if pnl<-15%)
    // Refuse new deploy if total heat >= maxPortfolioHeat. null = disabled.
    // Example: maxPortfolioHeat=5 blocks deploy when two positions are OOR.
    maxPortfolioHeat:     u.maxPortfolioHeat      ?? null,
    // Consecutive OOR regime guard: pause deploy if last N closes were all out-of-range.
    // Detects strong trending markets where DLMM LP keeps losing alignment. null = disabled.
    // Example: 3 = block if last 3 closes were all OOR (within 48h window).
    maxConsecutiveOorCloses: u.maxConsecutiveOorCloses ?? null,
    // Wallet heat % gate (ke-15): block deploy if (deployed + new) / total wallet SOL > X%.
    // More conservative than maxTotalSolExposure — scales with wallet size. null = disabled.
    // Example: 70 = don't put more than 70% of total wallet into active DLMM positions.
    maxWalletHeatPct: u.maxWalletHeatPct ?? null,
    // Auto-flatten emergency threshold (ke-15): close ALL positions when portfolio heat reaches
    // this level during a management cycle (without waiting for LLM). null = disabled.
    // Uses same heat formula as maxPortfolioHeat. Set higher than maxPortfolioHeat to avoid
    // triggering too early. Example: 15 = flatten when heat is severely elevated.
    autoFlattenHeat: u.autoFlattenHeat ?? null,
    // Stale screener fallback (executor_01): if the Pool Discovery API fails at deploy time,
    // executor falls back to screener data in args. Set true to allow deploy even when screener
    // fields are missing or timestamp is >120s old. Default false = strict mode (safer).
    allowStaleScreenerFallback: u.allowStaleScreenerFallback ?? false,
  },

  // ─── Manual Approval ─────────────────────
  requireApproval: u.requireApproval ?? false,

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.02,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minVolumeTvlRatio: u.minVolumeTvlRatio ?? null,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minActivePct:      u.minActivePct      ?? null,
    maxAbsPriceChangePct: u.maxAbsPriceChangePct ?? null,
    minFeeChangePct:   u.minFeeChangePct   ?? null,
    minVolumeChangePct: u.minVolumeChangePct ?? null,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    // Market regime gate: refuse deploy if pool volatility exceeds this value.
    // Uses the 0–5+ volatility scale from screener. null = disabled.
    // Example: 4.0 blocks deploys during extreme volatility expansions.
    maxDeployVolatility: u.maxDeployVolatility ?? null,
    // Toxic regime gate: refuse re-deploy into pools with chronic OOR history.
    // If > this fraction of the pool's last 10 closes were out-of-range, block deploy.
    // null = disabled. Example: 0.7 = block if 70%+ of recent closes were OOR.
    maxOorRatioForRedeploy: u.maxOorRatioForRedeploy ?? null,
    // Historical pool win rate gate: block re-deploy into pools with a poor adjusted win rate.
    // Requires at least 3 samples. null = disabled. Example: 40 = block if win rate < 40%.
    minPoolWinRate: u.minPoolWinRate ?? null,
    // Hard scorer gate before LLM: candidates below this score are not shown to the agent.
    // This prevents narrative/LLM optimism from deploying C/D-grade pools.
    // null = disabled. Recommended dry-run/live profitability guard: 72+ (A-grade only).
    minPoolScore: u.minPoolScore ?? null,
    // Fee-vs-IL EV gate (ke-16): block deploys when projected daily net EV falls below this.
    // EV = (fee_tvl_ratio × periods/day × 100%) − (binStep IL proxy + volatility IL proxy).
    // blockNegativeEV=true + minNetEVPct=0 blocks any pool where IL estimate exceeds fee income.
    // null minNetEVPct = disabled even when blockNegativeEV=true. Example: minNetEVPct=0.1.
    blockNegativeEV: u.blockNegativeEV ?? false,
    minNetEVPct:     u.minNetEVPct     ?? null,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    dryRunMinHoldMinutes:  u.dryRunMinHoldMinutes  ?? 30, // keep simulated deploys visible before paper exits
    dryRunMaxFeePctPerHour: u.dryRunMaxFeePctPerHour ?? 3, // cap simulated fee accrual per position per hour
    dryRunMaxUnrealizedPnlPct: u.dryRunMaxUnrealizedPnlPct ?? 25, // sanity cap for open paper PnL
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Dynamic position sizing: scale deploy amount down as pool volatility increases.
    // When enabled: scaleFactor = 1 - min(0.4, volatility × 0.08)
    // Example: volatility=5 → deploy 60% of normal size. null/false = disabled.
    volatilityPositionScaling: u.volatilityPositionScaling ?? false,
    // Loss-triggered pool cooldown (ke-16): after a significant loss close, apply a cooldown
    // to the pool so it isn't immediately redeployed into. Duration scales with loss severity.
    // lossTriggeredCooldown: enable/disable. lossCooldownThresholdPct: trigger threshold (e.g. -15).
    // lossCooldownHours: base hours per severity unit (severity = ceil(|pnl| / |threshold|), max 4).
    lossTriggeredCooldown:      u.lossTriggeredCooldown      ?? false,
    lossCooldownThresholdPct:   u.lossCooldownThresholdPct   ?? -15,
    lossCooldownHours:          u.lossCooldownHours          ?? 6,
    // Pool quality adaptive sizing (ke-14): scale down for pools with poor historical win rate.
    // Uses adjusted_win_rate from pool-memory (excludes emergency closes). Requires ≥3 samples.
    // qualityFactor range: 0.75 (worst history) → 1.0 (good/no history). false = disabled.
    poolQualityPositionScaling: u.poolQualityPositionScaling ?? false,
    // Fee yield upscaling (ke-14): deploy proportionally more in high-yield proven pools.
    // Only activates when fee/TVL >= goodFeeMultiplier × minFeeActiveTvlRatio. Max +50%.
    // Hard-capped at risk.maxDeployAmount. false = disabled.
    feeYieldPositionScaling: u.feeYieldPositionScaling ?? false,
    // Multiplier above minFeeActiveTvlRatio that defines "excellent fee yield" for upscaling.
    // Example: 3.0 = a pool needs 3× the minimum fee/TVL before upscaling kicks in.
    goodFeeMultiplier: u.goodFeeMultiplier ?? 3.0,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash:free",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash:free",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash:free",
    reviewModel:     u.aiReviewModel ?? u.reviewModel ?? "anthropic/claude-haiku-4.5",
    hybridReviewEnabled: u.aiHybridReviewEnabled ?? true,
    reviewMinPoolScore:  u.aiReviewMinPoolScore  ?? 72,
    reviewMaxPerCycle:   u.aiReviewMaxPerCycle   ?? 1,
    reviewMaxTokens:     u.aiReviewMaxTokens     ?? 384,
    // AI spend guardrails. Keep monthlyBudgetUsd below the user's actual OpenRouter balance.
    monthlyBudgetUsd: u.aiMonthlyBudgetUsd ?? 8,
    dailyBudgetUsd:   u.aiDailyBudgetUsd   ?? 0.25,
    maxCallsPerDay:   u.aiMaxCallsPerDay   ?? 20,
    healthCheckEnabled: u.aiHealthCheckEnabled ?? false,
    defaultInputPricePer1M:  u.aiDefaultInputPricePer1M  ?? 0.30,
    defaultOutputPricePer1M: u.aiDefaultOutputPricePer1M ?? 1.20,
  },

  costs: {
    estimatedRoundTripTxCostUsd: u.estimatedRoundTripTxCostUsd ?? 0.04,
    includeAICostInNetPnl: u.includeAICostInNetPnl ?? true,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },

  // ─── Ranking System ────────────────────────
  ranking: {
    enabled:         u.rankingEnabled         ?? true,
    intervalMin:     u.rankingIntervalMin     ?? 60,    // how often to run ranking cycle
    topN:            u.rankingTopN            ?? 10,    // top N wallets to return
    strategyMode:    u.rankingStrategyMode    ?? "auto_top_10",
    birdeyeApiKey:   u.birdeyeApiKey          ?? process.env.BIRDEYE_API_KEY ?? "",
    heliusApiKey:    u.heliusApiKey           ?? process.env.HELIUS_API_KEY ?? "",
    maxWalletsToTrack: u.rankingMaxWallets    ?? 50,    // cap on tracked wallets
    discoveryPoolLimit: u.rankingDiscoveryPoolLimit ?? 5,
    topLpersPerPool: u.rankingTopLpersPerPool ?? 4,
  },

  // ─── Multi-Layer Scoring Engine ───────────────
  scoring: {
    enabled:             u.scoringEnabled             ?? true,
    defaultMode:         u.scoringDefaultMode         ?? "balanced",
    minScoreThreshold:   u.scoringMinScore            ?? 20,
    decayLookback:       u.scoringDecayLookback       ?? 3,
    decayThreshold:      u.scoringDecayThreshold      ?? -15,
    autoExcludeDecaying: u.scoringAutoExcludeDecaying ?? true,
    checkCorrelation:    u.scoringCheckCorrelation    ?? true,
    maxCorrelation:      u.scoringMaxCorrelation      ?? 0.85,
    // Whitelist / blacklist addresses
    whitelist:           u.scoringWhitelist           ?? [],
    blacklist:           u.scoringBlacklist           ?? [],
    // Factor threshold overrides (optional)
    thresholds: {
      pnl7dMin:          u.scoringPnl7dMin  ?? null,
      pnl30dMin:         u.scoringPnl30dMin ?? null,
      maxDrawdownMin:    u.scoringDDMin     ?? null,
      winRateTarget:     u.scoringWinRate   ?? null,
    },
  },

  // ─── Intelligence Fusion ───────────────────
  intelligence: {
    enabled: u.intelligenceEnabled ?? true,

    // Provider toggles
    useGmgn:     u.useGmgn     ?? true,
    useHelius:   u.useHelius   ?? true,    // already configured via HELIUS_API_KEY
    useDune:     u.useDune     ?? true,    // requires DUNE_API_KEY
    useFallback: u.useFallback ?? true,    // public APIs, always available

    // Cache TTL overrides (ms)
    cacheWalletTtl:  u.intelCacheWalletTtl  ?? 5 * 60 * 1000,   // 5 min
    cacheTopTtl:     u.intelCacheTopTtl     ?? 10 * 60 * 1000,  // 10 min
    cacheProviderTtl: u.intelCacheProviderTtl ?? 2 * 60 * 1000, // 2 min

    // Fusion strategy
    // "parallel" = run all providers simultaneously
    // "sequential" = try primary, fallback on failure
    fusionStrategy:   u.fusionStrategy   ?? "parallel",

    // Rate limiting
    rateLimits: {
      gmgn:      { rpm: u.gmgnRpm      ?? 30,  burst: 5  },
      dune:      { rpm: u.duneRpm      ?? 10,  burst: 2  },
      helius:    { rpm: u.heliusRpm    ?? 100, burst: 10 },
      birdeye:   { rpm: u.birdeyeRpm   ?? 30,  burst: 5  },
      dexscreener: { rpm: u.dexscreenerRpm ?? 60, burst: 8 },
      tracklp:   { rpm: u.tracklpRpm   ?? 20,  burst: 3  },
    },

    // Wallet discovery
    discoveryIntervalMin: u.intelDiscoveryIntervalMin ?? 120,  // scan for new wallets every 2h
    maxCandidates:        u.intelMaxCandidates        ?? 50,   // max candidate wallets to scan
  },

  allocation: {
    enabled: u.allocationEnabled ?? true,
    riskProfile: u.allocationRiskProfile ?? "moderate",
    sizingMode: u.allocationSizingMode ?? "score_scaled",
  },

  decision: {
    enabled: u.decisionLayerEnabled ?? true,
    enforce: u.decisionLayerEnforce ?? false,
    minScoreToCopy: u.decisionMinScoreToCopy ?? 45,
    minConfidence: u.decisionMinConfidence ?? 0.6,
    minRangeQuality: u.decisionMinRangeQuality ?? 50,
    maxVolatilityForCopy: u.decisionMaxVolatilityForCopy ?? 8,
    minFeeTvlForCopy: u.decisionMinFeeTvlForCopy ?? 0.02,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: if wallet < floor + reserve return 0, otherwise
 * clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.7 SOL wallet → 0 SOL deploy    (reserve protected)
 *   0.8 SOL wallet → 0.5 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const wallet   = Number(walletSol);
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  if (!Number.isFinite(wallet) || wallet < floor + reserve) return 0;
  const deployable = Math.max(0, wallet - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minVolumeTvlRatio !== undefined) s.minVolumeTvlRatio = fresh.minVolumeTvlRatio;
    if (fresh.minActivePct !== undefined) s.minActivePct = fresh.minActivePct;
    if (fresh.maxAbsPriceChangePct !== undefined) s.maxAbsPriceChangePct = fresh.maxAbsPriceChangePct;
    if (fresh.minFeeChangePct !== undefined) s.minFeeChangePct = fresh.minFeeChangePct;
    if (fresh.minVolumeChangePct !== undefined) s.minVolumeChangePct = fresh.minVolumeChangePct;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
