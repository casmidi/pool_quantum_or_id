import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { scorePool, applyDarwinWeights } from "../strategy/pool-scorer.js";
import { planDlmmEntry } from "../strategy/dlmm-edge.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// PVP_SHORTLIST_LIMIT removed — enrichPvpRisk now accepts an explicit limit param
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

// ── Concurrency limiter — prevents API burst (429 / timeout storm) ───────────
// Returns an array in the same settled format as Promise.allSettled.
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = { status: "fulfilled", value: await mapper(items[i], i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

// ── Cached Darwin scorer weights with TTL (5 min) ────────────────────────────
const DARWIN_CACHE_TTL_MS = 5 * 60 * 1000;
let _darwinScorerWeightsCache = null;
let _darwinCacheTimestamp = 0;
async function loadDarwinScorerWeights() {
  if (_darwinScorerWeightsCache && Date.now() - _darwinCacheTimestamp < DARWIN_CACHE_TTL_MS) {
    return _darwinScorerWeightsCache;
  }
  try {
    const { getDarwinScorerWeights } = await import("../signal-weights.js");
    _darwinScorerWeightsCache = getDarwinScorerWeights();
  } catch {
    _darwinScorerWeightsCache = {};
  }
  _darwinCacheTimestamp = Date.now();
  return _darwinScorerWeightsCache;
}
/** Force-refresh Darwin weights cache (call after recalculation completes). */
export function invalidateDarwinCache() {
  _darwinScorerWeightsCache = null;
  _darwinCacheTimestamp = 0;
}

// ── Lightweight circuit breaker — prevents retry-storm when a provider is down ──
// After CIRCUIT_FAILURE_THRESHOLD consecutive cycle-level failures, the provider is cooled
// down for CIRCUIT_COOLDOWN_MS.  Resets automatically after the cooldown expires.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const _providerHealth = new Map(); // provider → { failures, openUntil }

function isCircuitOpen(provider) {
  const h = _providerHealth.get(provider);
  if (!h?.openUntil) return false;
  if (Date.now() < h.openUntil) return true;
  // Cooldown expired — reset and allow through
  _providerHealth.delete(provider);
  return false;
}

function recordProviderSuccess(provider) {
  _providerHealth.delete(provider); // full reset on any success
}

function recordProviderFailure(provider) {
  const h = _providerHealth.get(provider) || { failures: 0, openUntil: null };
  h.failures++;
  if (h.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    h.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    log("screening", `Circuit breaker OPEN for ${provider} — ${h.failures} consecutive failures, cooldown 5 min`);
  }
  _providerHealth.set(provider, h);
}

/**
 * Wrap a single OKX endpoint call with per-endpoint circuit tracking.
 * Returns { _skipped: true, endpointKey } (fulfilled) when circuit is open,
 * allowing callers to distinguish circuit-open skips from real API failures
 * in telemetry without adding per-call log noise.
 */
async function callOkxEndpoint(endpointKey, fn) {
  if (isCircuitOpen(endpointKey)) return { _skipped: true, endpointKey }; // circuit already logged on open
  try {
    const result = await fn();
    recordProviderSuccess(endpointKey);
    return result;
  } catch (err) {
    recordProviderFailure(endpointKey);
    throw err; // re-throw so Promise.allSettled records status "rejected"
  }
}

/**
 * Unwrap an OKX settled result into a plain value or null.
 * Treats both API failures (status "rejected") and circuit-open skips
 * ({ _skipped: true }) as null, keeping consumer logic uniform.
 */
function okxResult(settled, fallback = null) {
  if (settled.status !== "fulfilled") return fallback;
  if (settled.value?._skipped) return fallback;
  return settled.value ?? fallback;
}

// ── OKX per-mint cache — TTL 5 min — avoids re-enriching same mint every cycle ──
const OKX_CACHE_TTL_MS = 5 * 60 * 1000;
const OKX_CACHE_MAX    = 300; // cap entries; oldest evicted on overflow
const _okxCache = new Map(); // mint → { data, ts }

function getOkxCached(mint) {
  const entry = _okxCache.get(mint);
  if (entry && Date.now() - entry.ts < OKX_CACHE_TTL_MS) return entry.data;
  return null;
}

function setOkxCached(mint, data) {
  if (_okxCache.size >= OKX_CACHE_MAX) {
    // Lazy sweep: delete ALL expired entries before falling back to oldest-entry eviction —
    // prevents stale entries accumulating when cache is near capacity
    const now = Date.now();
    for (const [k, v] of _okxCache) {
      if (now - v.ts >= OKX_CACHE_TTL_MS) _okxCache.delete(k);
    }
    if (_okxCache.size >= OKX_CACHE_MAX) _okxCache.delete(_okxCache.keys().next().value);
  }
  _okxCache.set(mint, { data, ts: Date.now() });
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  const feeTvl     = Number(pool.fee_active_tvl_ratio || 0);
  const organic    = Number(pool.organic_score || pool.base?.organic || 0);
  const volume     = Math.log10(Number(pool.volume_window || 0) + 1);
  const holders    = Math.log10(Number(pool.holders || 0) + 1);
  const activePct  = Number(pool.active_pct || 0);
  const volatility = Number(pool.volatility || 0);
  const tvl        = Number(pool.tvl || pool.active_tvl || 0);

  let score = 0;
  // Cap feeTvl at 0.3 (300pts max) — prevents fee spikes on micro-TVL pools dominating ranking
  score += Math.min(feeTvl, 0.3) * 1000;
  score += organic * 3;
  score += volume * 20;
  score += holders * 10;
  score += activePct * 0.5;
  if (!Number.isFinite(volatility) || volatility <= 0) score -= 100;
  if (volatility > 20) score -= 50;
  if (tvl < 5_000) score -= 30;  // penalize micro-TVL pools for stability
  return score;
}

// ── Config validator — pastikan nilai numerik tidak undefined/null sebelum query API ──
function normalizeScreeningConfig(raw = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid config: screening config is missing or not an object");
  }
  function req(name, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid screening config: ${name}=${value}`);
    return n;
  }
  function opt(name, value) {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid screening config: ${name}=${value}`);
    return n;
  }
  const timeframe = raw.timeframe || MIN_VOLATILITY_TIMEFRAME;
  if (!TIMEFRAME_MINUTES[timeframe]) {
    throw new Error(`Invalid screening config: timeframe=${timeframe} (valid: ${Object.keys(TIMEFRAME_MINUTES).join(", ")})`);
  }
  const cfg = {
    ...raw,
    timeframe,
    minMcap:              req("minMcap",              raw.minMcap),
    maxMcap:              raw.maxMcap  == null ? null : req("maxMcap",  raw.maxMcap),
    minHolders:           req("minHolders",           raw.minHolders),
    minVolume:            req("minVolume",             raw.minVolume),
    minVolumeTvlRatio:    opt("minVolumeTvlRatio",     raw.minVolumeTvlRatio),
    minTvl:               req("minTvl",               raw.minTvl),
    maxTvl:               raw.maxTvl   == null ? null : req("maxTvl",   raw.maxTvl),
    minBinStep:           req("minBinStep",            raw.minBinStep),
    maxBinStep:           req("maxBinStep",            raw.maxBinStep),
    minFeeActiveTvlRatio: req("minFeeActiveTvlRatio",  raw.minFeeActiveTvlRatio),
    minOrganic:           req("minOrganic",            raw.minOrganic),
    minQuoteOrganic:      req("minQuoteOrganic",       raw.minQuoteOrganic),
    minActivePct:         opt("minActivePct",          raw.minActivePct),
    maxAbsPriceChangePct: opt("maxAbsPriceChangePct",  raw.maxAbsPriceChangePct),
    minFeeChangePct:      opt("minFeeChangePct",       raw.minFeeChangePct),
    minVolumeChangePct:   opt("minVolumeChangePct",    raw.minVolumeChangePct),
  };
  // Relational validation — catch inverted ranges before they silently return 0 results
  if (cfg.maxMcap != null && cfg.maxMcap < cfg.minMcap)
    throw new Error(`Invalid screening config: maxMcap (${cfg.maxMcap}) < minMcap (${cfg.minMcap})`);
  if (cfg.maxTvl != null && cfg.maxTvl < cfg.minTvl)
    throw new Error(`Invalid screening config: maxTvl (${cfg.maxTvl}) < minTvl (${cfg.minTvl})`);
  if (cfg.maxBinStep < cfg.minBinStep)
    throw new Error(`Invalid screening config: maxBinStep (${cfg.maxBinStep}) < minBinStep (${cfg.minBinStep})`);
  return cfg;
}

// ── Safe limit normalizer ─────────────────────────────────────────────────────
function normalizeLimit(limit, fallback = 10, max = 50) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// ── Optional-with-default number validator — throws if value is non-numeric ──
function requiredFinite(name, value, fallback) {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid screening config: ${name}=${raw}`);
  return n;
}

// ── fetch helper dengan timeout + retry ──────────────────────────────────────
// Only 408/429/5xx and network errors are retried; 4xx client errors are thrown immediately.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
async function fetchJson(url, { timeoutMs = 8000, retries = 2, headers } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const err = new Error(`${res.status} ${res.statusText}`);
        err.status = res.status;
        // Non-retryable client errors — bail immediately, no point retrying
        if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) throw err;
        throw err;
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      // Don't retry if server said it's a client error (e.g. 400/401/403/404)
      if (err.status && err.status >= 400 && err.status < 500 && !RETRYABLE_STATUS.has(err.status)) break;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) + Math.random() * 300));
    }
  }
  throw lastError;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const activePct = numeric(pool?.active_positions_pct);
  const priceChangePct = numeric(pool?.pool_price_change_pct);
  const feeChangePct = numeric(pool?.fee_change_pct);
  const volumeChangePct = numeric(pool?.volume_change_pct);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (s.maxMcap != null && mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (s.minVolumeTvlRatio != null && tvl > 0 && volume / tvl < s.minVolumeTvlRatio) {
    return `volume/TVL ${(volume / tvl).toFixed(4)} below minVolumeTvlRatio ${s.minVolumeTvlRatio}`;
  }
  if (s.minActivePct != null && (activePct == null || activePct < s.minActivePct)) {
    return `active liquidity ${activePct ?? "unknown"}% below minActivePct ${s.minActivePct}%`;
  }
  if (s.maxAbsPriceChangePct != null && priceChangePct != null && Math.abs(priceChangePct) > s.maxAbsPriceChangePct) {
    return `price change ${priceChangePct}% exceeds maxAbsPriceChangePct ${s.maxAbsPriceChangePct}%`;
  }
  if (s.minFeeChangePct != null && feeChangePct != null && feeChangePct < s.minFeeChangePct) {
    return `fee change ${feeChangePct}% below minFeeChangePct ${s.minFeeChangePct}%`;
  }
  if (s.minVolumeChangePct != null && volumeChangePct != null && volumeChangePct < s.minVolumeChangePct) {
    return `volume change ${volumeChangePct}% below minVolumeChangePct ${s.minVolumeChangePct}%`;
  }
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (pool?.volatility_missing) {
    return `volatility unavailable for required timeframe ${pool.volatility_timeframe ?? MIN_VOLATILITY_TIMEFRAME}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0) {
    if (!launchpad) return "launchpad unknown while allow-list is enabled";
    if (!includesCaseInsensitive(s.allowedLaunchpads, launchpad)) {
      return `launchpad ${launchpad} not in allow-list`;
    }
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const data = await fetchJson(
    `${getAgentMeridianBase()}/signals/discord/candidates`,
    { headers: getAgentMeridianHeaders() }
  );
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    (category ? `&category=${encodeURIComponent(category)}` : "");

  return fetchJson(url);
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe, category }) {
  const cat = category ?? config.screening.category;
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}` +
    (cat ? `&category=${encodeURIComponent(cat)}` : "");

  const data = await fetchJson(url);
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  if (sourceTimeframe === volatilityTimeframe) {
    for (const pool of rawPools) {
      if (pool) pool.volatility_timeframe = volatilityTimeframe;
    }
    return rawPools;
  }

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const volatilityResults = await mapWithConcurrency(uniquePoolAddresses, 5, (poolAddress) =>
    fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
      .then((pool) => ({ poolAddress, volatility: numeric(pool?.volatility) }))
  );

  const volatilityByPool = new Map();
  for (const result of volatilityResults) {
    if (result.status !== "fulfilled") continue;
    if (result.value.volatility == null) continue;
    volatilityByPool.set(result.value.poolAddress, result.value.volatility);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    if (volatilityByPool.has(pool.pool_address)) {
      pool.volatility = volatilityByPool.get(pool.pool_address);
      pool.volatility_timeframe = volatilityTimeframe;
    } else {
      // Fetch failed — null volatility so filter rejects it, never silently use short-timeframe data
      pool.volatility = null;
      pool.volatility_timeframe = volatilityTimeframe;
      pool.volatility_missing = true;
    }
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const data = await fetchJson(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await mapWithConcurrency(uniqueMints, 5, async (mint) => {
    const assets = await searchAssetsBySymbol(mint);
    const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
    return { mint, asset };
  });

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const data = await fetchJson(url);
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

// ── PVP symbol cache — TTL 2 min, max 200 entries — bounded memory ──────────
const PVP_SYMBOL_CACHE_TTL_MS = 2 * 60 * 1000;
const PVP_SYMBOL_CACHE_MAX    = 200;
const _pvpSymbolCache = new Map(); // symbol → { assets, ts }

async function cachedSearchAssetsBySymbol(symbol) {
  const entry = _pvpSymbolCache.get(symbol);
  if (entry && Date.now() - entry.ts < PVP_SYMBOL_CACHE_TTL_MS) return entry.assets;
  const assets = await searchAssetsBySymbol(symbol).catch(() => []);
  if (_pvpSymbolCache.size >= PVP_SYMBOL_CACHE_MAX) {
    // Lazy sweep: delete ALL expired entries before falling back to oldest-entry eviction
    const now = Date.now();
    for (const [k, v] of _pvpSymbolCache) {
      if (now - v.ts >= PVP_SYMBOL_CACHE_TTL_MS) _pvpSymbolCache.delete(k);
    }
    if (_pvpSymbolCache.size >= PVP_SYMBOL_CACHE_MAX) {
      _pvpSymbolCache.delete(_pvpSymbolCache.keys().next().value);
    }
  }
  _pvpSymbolCache.set(symbol, { assets, ts: Date.now() });
  return assets;
}

// ── Periodic background cache sweep ──────────────────────────────────────────
// Insert-triggered lazy sweep only runs during active screening.  This timer
// catches expired entries in low-traffic windows (e.g. overnight, idle cycles).
//
// Singleton guard uses Symbol.for() — a global symbol registry that survives
// module re-evaluations, hot-reloads, and test-harness re-imports within the
// same process.  Safer than a plain string key because Symbol.for() is
// namespace-scoped by convention and cannot collide with string properties.
//
// .unref() ensures the timer never prevents the process from exiting cleanly.
// shutdownScreening() (exported below) provides an explicit teardown hook for
// graceful-shutdown callers (e.g. SIGTERM handler in index.js).
const _SWEEP_SINGLETON = Symbol.for("meridian.screening.cacheSweep");
let _cacheSweepTimer = null;
let _sweeping = false; // backpressure flag — skip interval tick if previous sweep is still running
if (!globalThis[_SWEEP_SINGLETON]) {
  globalThis[_SWEEP_SINGLETON] = true;
  const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  _cacheSweepTimer = setInterval(() => {
    if (_sweeping) return; // previous sweep not done — skip this tick
    _sweeping = true;
    try {
      const now = Date.now();
      let okxEvicted = 0;
      for (const [k, v] of _okxCache) {
        if (now - v.ts >= OKX_CACHE_TTL_MS) { _okxCache.delete(k); okxEvicted++; }
      }
      let pvpEvicted = 0;
      for (const [k, v] of _pvpSymbolCache) {
        if (now - v.ts >= PVP_SYMBOL_CACHE_TTL_MS) { _pvpSymbolCache.delete(k); pvpEvicted++; }
      }
      if (okxEvicted + pvpEvicted > 0) {
        log("screening", `Periodic cache sweep: evicted ${okxEvicted} OKX + ${pvpEvicted} PVP expired entries`);
      }
    } finally {
      _sweeping = false;
    }
  }, CACHE_SWEEP_INTERVAL_MS).unref();
}

/**
 * Gracefully tear down the periodic cache sweep timer.
 * Call this from your SIGTERM/SIGINT handler in index.js so the timer is
 * cleared before the process exits — avoids any last-tick sweep log noise
 * and releases the interval ref cleanly.
 */
export function shutdownScreening() {
  if (_cacheSweepTimer) {
    clearInterval(_cacheSweepTimer);
    _cacheSweepTimer = null;
  }
  // Reset singleton so a future re-import (e.g. in tests) can restart the timer
  globalThis[_SWEEP_SINGLETON] = false;
}

async function enrichPvpRisk(pools, { limit = pools.length } = {}) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, Math.min(limit, pools.length));

  if (shortlist.length === 0) return;

  // Pre-warm symbol cache sequentially for unique symbols — avoids N concurrent requests
  // for the same symbol when multiple pools share a ticker
  const uniqueSymbols = [...new Set(shortlist.map((p) => normalizeSymbol(p.base?.symbol)).filter(Boolean))];
  await mapWithConcurrency(uniqueSymbols, 3, async (symbol) => {
    await cachedSearchAssetsBySymbol(symbol);
  });

  // Now process pools with cache warm — max 3 concurrent (PVP is API-heavy per pool)
  await mapWithConcurrency(shortlist, 3, async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    const assets = await cachedSearchAssetsBySymbol(symbol);

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.pool_address || rivalPool.address || null;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  });
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const safePageSize = normalizeLimit(page_size, 50, 100);
  const s = normalizeScreeningConfig(config.screening);
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    s.maxMcap != null ? `base_token_market_cap<=${s.maxMcap}` : null,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size: safePageSize,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const rawCount = rawPools.length;
  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });
  const thresholdPassed = thresholdedRawPools.length;

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      filteredExamples.push({ name: p.name, reason: "blacklisted token" });
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      filteredExamples.push({ name: p.name, reason: "blocked deployer" });
      return false;
    }
    return true;
  });
  const afterInitialBlacklist = pools.length;

  const blFiltered = condensed.length - pools.length;
  if (blFiltered > 0) log("blacklist", `Filtered ${blFiltered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await mapWithConcurrency(missingDev, 5, (p) =>
        fetchJson(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(p.base.mint)}`)
          .then((d) => {
            // Match by exact mint ID — d[0] could be a different asset with same query prefix
            const arr = Array.isArray(d) ? d : [d];
            const token = arr.find((x) => x?.id === p.base.mint) || null;
            return { pool: p.pool, dev: token?.dev || null };
          })
          .catch(() => ({ pool: p.pool, dev: null }))
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          filteredExamples.push({ name: p.name, reason: "blocked deployer (Jupiter lookup)" });
          return false;
        }
        return true;
      });
    }
  }
  // Count AFTER Jupiter dev enrichment (more accurate than afterInitialBlacklist)
  const afterBlacklist = pools.length;

  return {
    api_total:        data.total,    // what the API says it has
    raw_count:        rawCount,      // how many came back in this page
    threshold_passed: thresholdPassed,
    after_blacklist:  afterBlacklist,        // after all blacklist/dev checks
    after_initial_blacklist: afterInitialBlacklist, // before Jupiter dev enrichment
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const safeLimit = normalizeLimit(limit);
  const s = normalizeScreeningConfig(config.screening);
  const discovery = await discoverPools({ page_size: 50 });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  let positions = [];
  if (config.dryRun === true || process.env.DRY_RUN === "true") {
    const { getOpenTrades } = await import("../lib/pnl_tracker.js");
    positions = getOpenTrades().map((trade) => ({
      pool: trade.pool_address,
      base_mint: trade.base_mint,
    }));
  } else {
    const { getMyPositions } = await import("./dlmm.js");
    ({ positions } = await getMyPositions());
  }
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = s.minTvl;
  const maxTvl = s.maxTvl;
  const minFeeActiveTvlRatio = s.minFeeActiveTvlRatio;

  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      const volume = Number(p.volume_window ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      if (s.minVolumeTvlRatio != null && tvl > 0 && volume / tvl < s.minVolumeTvlRatio) {
        pushFilteredReason(filteredOut, p, `volume/TVL ${(volume / tvl).toFixed(4)} below minVolumeTvlRatio ${s.minVolumeTvlRatio}`);
        return false;
      }
      if (s.minActivePct != null && (p.active_pct == null || Number(p.active_pct) < s.minActivePct)) {
        pushFilteredReason(filteredOut, p, `active liquidity ${p.active_pct ?? "unknown"}% below minActivePct ${s.minActivePct}%`);
        return false;
      }
      if (s.maxAbsPriceChangePct != null && p.price_change_pct != null && Math.abs(Number(p.price_change_pct)) > s.maxAbsPriceChangePct) {
        pushFilteredReason(filteredOut, p, `price change ${p.price_change_pct}% exceeds maxAbsPriceChangePct ${s.maxAbsPriceChangePct}%`);
        return false;
      }
      if (s.minFeeChangePct != null && p.fee_change_pct != null && Number(p.fee_change_pct) < s.minFeeChangePct) {
        pushFilteredReason(filteredOut, p, `fee change ${p.fee_change_pct}% below minFeeChangePct ${s.minFeeChangePct}%`);
        return false;
      }
      if (s.minVolumeChangePct != null && p.volume_change_pct != null && Number(p.volume_change_pct) < s.minVolumeChangePct) {
        pushFilteredReason(filteredOut, p, `volume change ${p.volume_change_pct}% below minVolumeChangePct ${s.minVolumeChangePct}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    // Take a wide shortlist so OKX/indicator filters can trim without running out of candidates.
    // Final trim to `safeLimit` happens after pool_score ranking below.
    .slice(0, Math.max(safeLimit * 3, 30));

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    // Check ALL eligible candidates — post-OKX/scorer ranking can promote any of them to final
    await enrichPvpRisk(eligible, {
      limit: Number(config.screening.pvpCheckLimit ?? eligible.length),
    });
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  // Per-endpoint circuit breakers (okx:advanced / okx:price / okx:cluster / okx:risk) open
  // independently after CIRCUIT_FAILURE_THRESHOLD consecutive failures for that endpoint,
  // so a single unstable endpoint doesn't kill the rest of the OKX layer.
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");

    // One-per-cycle observability log for open circuits — lets operators see partial degradation
    // without flooding logs with per-pool entries
    const openCircuits = ["okx:advanced", "okx:price", "okx:cluster", "okx:risk"].filter(isCircuitOpen);
    if (openCircuits.length > 0) {
      log("okx", `Partial degradation this cycle: circuits open for [${openCircuits.join(", ")}]`);
    }

    const okxResults = await mapWithConcurrency(eligible, 5, async (p) => {
      if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };

      // Return cached result if still fresh — avoids re-fetching same mint every 30-min cycle
      const cached = getOkxCached(p.base.mint);
      if (cached) return cached;

      const [adv, price, clusters, risk] = await Promise.allSettled([
        callOkxEndpoint("okx:advanced", () => getAdvancedInfo(p.base.mint)),
        callOkxEndpoint("okx:price",    () => getPriceInfo(p.base.mint)),
        callOkxEndpoint("okx:cluster",  () => getClusterList(p.base.mint)),
        callOkxEndpoint("okx:risk",     () => getRiskFlags(p.base.mint)),
      ]);

      const mintShort = p.base.mint.slice(0, 8);
      // Log only real API failures; circuit-open skips are already noted at cycle level above
      if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
      if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
      if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
      if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

      // okxResult() unwraps settled values — treats circuit-skipped ({ _skipped:true }) and
      // API failures (rejected) uniformly as null, keeping consumer logic identical in both cases
      const result = {
        adv:      okxResult(adv),
        price:    okxResult(price),
        clusters: okxResult(clusters, []),
        risk:     okxResult(risk),
      };
      // Cache only if we received at least some useful data
      if (result.adv || result.price || result.risk) setOkxCached(p.base.mint, result);
      return result;
    });
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // ── OKX fail-closed for live mode ───────────────────────────────────────
    // dry-run defaults to fail-open (don't block testing); live defaults to fail-closed
    const isDryRun = config.dryRun === true || process.env.DRY_RUN === "true";
    const failOpenRisk = config.screening.failOpenOnRiskDataUnavailable ?? isDryRun;
    if (!failOpenRisk) {
      const riskMissingBefore = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p, i) => {
        const r = okxResults[i];
        if (r.status !== "fulfilled") {
          pushFilteredReason(filteredOut, p, "OKX data fetch failed");
          return false;
        }
        const { adv, risk } = r.value;
        if (!adv) {
          pushFilteredReason(filteredOut, p, "OKX advanced risk unavailable");
          return false;
        }
        if (!risk) {
          pushFilteredReason(filteredOut, p, "OKX risk flags unavailable");
          return false;
        }
        return true;
      }));
      if (eligible.length < riskMissingBefore) {
        log("screening", `OKX fail-closed: removed ${riskMissingBefore - eligible.length} pool(s) with unavailable risk data`);
      }
    }

    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      // Clamp to [-100, 100] — prevents misconfig like athFilterPct=200 (passes everything)
      // or athFilterPct=-200 (fails everything) from silently breaking the filter
      const clampedAth = Math.min(Math.max(Number(athFilter), -100), 100);
      if (!Number.isFinite(clampedAth)) {
        log("screening", `ATH filter: skipped — athFilterPct=${athFilter} is not a valid number`);
      } else {
      const threshold = 100 + clampedAth; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      // failOpenOnAthDataUnavailable: true  → pool passes when price data is missing (dry-run default)
      // failOpenOnAthDataUnavailable: false → pool rejected when price data missing (live default)
      const failOpenAth = config.screening.failOpenOnAthDataUnavailable ?? isDryRun;
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) {
          if (failOpenAth) return true;
          log("screening", `ATH filter: dropped ${p.name} — ATH data unavailable`);
          pushFilteredReason(filteredOut, p, "ATH data unavailable");
          return false;
        }
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
      } // end else (valid clampedAth)
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);

    // ── Hard risk filters (OKX enriched fields) ─────────────────────────────
    const maxBundle     = requiredFinite("maxBundlePct",     config.screening.maxBundlePct,     30);
    const maxSniper     = requiredFinite("maxSniperPct",     config.screening.maxSniperPct,     30);
    const maxSuspicious = requiredFinite("maxSuspiciousPct", config.screening.maxSuspiciousPct, 30);
    // failClosedOnMissingRiskMetrics: true  → reject pool if bundle/sniper/suspicious_pct is null (live default)
    // failClosedOnMissingRiskMetrics: false → allow pool when metrics are absent (dry-run default)
    const failClosedMetrics = config.screening.failClosedOnMissingRiskMetrics ?? !isDryRun;
    const riskBefore    = eligible.length;
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_rugpull) {
        log("screening", `Risk filter: dropped ${p.name} — flagged as rugpull`);
        pushFilteredReason(filteredOut, p, "flagged as rugpull");
        return false;
      }
      if (p.risk_level === "high") {
        log("screening", `Risk filter: dropped ${p.name} — risk_level high`);
        pushFilteredReason(filteredOut, p, "risk_level high");
        return false;
      }
      if (p.bundle_pct == null) {
        if (failClosedMetrics) {
          log("screening", `Risk filter: dropped ${p.name} — bundle_pct missing (fail-closed)`);
          pushFilteredReason(filteredOut, p, "bundle_pct missing");
          return false;
        }
      } else if (Number.isFinite(Number(p.bundle_pct)) && Number(p.bundle_pct) > maxBundle) {
        log("screening", `Risk filter: dropped ${p.name} — bundle_pct ${p.bundle_pct} > ${maxBundle}`);
        pushFilteredReason(filteredOut, p, `bundle_pct ${p.bundle_pct} > limit ${maxBundle}`);
        return false;
      }
      if (p.sniper_pct == null) {
        if (failClosedMetrics) {
          log("screening", `Risk filter: dropped ${p.name} — sniper_pct missing (fail-closed)`);
          pushFilteredReason(filteredOut, p, "sniper_pct missing");
          return false;
        }
      } else if (Number.isFinite(Number(p.sniper_pct)) && Number(p.sniper_pct) > maxSniper) {
        log("screening", `Risk filter: dropped ${p.name} — sniper_pct ${p.sniper_pct} > ${maxSniper}`);
        pushFilteredReason(filteredOut, p, `sniper_pct ${p.sniper_pct} > limit ${maxSniper}`);
        return false;
      }
      if (p.suspicious_pct == null) {
        if (failClosedMetrics) {
          log("screening", `Risk filter: dropped ${p.name} — suspicious_pct missing (fail-closed)`);
          pushFilteredReason(filteredOut, p, "suspicious_pct missing");
          return false;
        }
      } else if (Number.isFinite(Number(p.suspicious_pct)) && Number(p.suspicious_pct) > maxSuspicious) {
        log("screening", `Risk filter: dropped ${p.name} — suspicious_pct ${p.suspicious_pct} > ${maxSuspicious}`);
        pushFilteredReason(filteredOut, p, `suspicious_pct ${p.suspicious_pct} > limit ${maxSuspicious}`);
        return false;
      }
      if (p.dev_sold_all === true && config.screening.blockDevSoldAll) {
        log("screening", `Risk filter: dropped ${p.name} — dev sold all tokens`);
        pushFilteredReason(filteredOut, p, "dev sold all tokens");
        return false;
      }
      return true;
    }));
    if (eligible.length < riskBefore) {
      log("screening", `Hard risk filter removed ${riskBefore - eligible.length} pool(s)`);
    }
  }

  if (config.indicators.enabled && eligible.length > 0) {
    // Limit indicator concurrency — TradingView/candle bridge can be slow; burst causes stale results
    const confirmationResults = await mapWithConcurrency(eligible, 5, async (pool) => {
      try {
        const confirmation = await confirmIndicatorPreset({
          mint: pool.base?.mint,
          side: "entry",
        });
        return { pool: pool.pool, confirmation };
      } catch (error) {
        // failOpenOnError: true  → let pool through when indicator service is down (permissive)
        // failOpenOnError: false → reject pool when indicator service is down (safe default for live)
        const failOpen = config.indicators?.failOpenOnError ?? false;
        return {
          pool: pool.pool,
          confirmation: {
            enabled: true,
            confirmed: failOpen,
            skipped: true,
            reason: `Indicator confirmation unavailable: ${error.message}`,
            intervals: [],
          },
        };
      }
    });
    // mapWithConcurrency wraps in settled format — mapper has try/catch so all are fulfilled
    const confirmations = confirmationResults.map((r) => r.value);
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  // Apply full pool-scorer scoring (with Darwin-adjusted weights) after all enrichment
  if (eligible.length > 0) {
    const darwinW = await loadDarwinScorerWeights();
    const scorerWeights = applyDarwinWeights(darwinW);
    const scoredEligible = [];
    for (const pool of eligible) {
      try {
        const scored = scorePool(pool, scorerWeights);
        pool.pool_score          = scored.score;
        pool.pool_grade          = scored.grade;
        pool.pool_recommendation = scored.recommendation;
        pool.volatility_zone     = scored.volatility_zone;
        pool.score_breakdown     = scored.breakdown;
        pool.dlmm_plan           = planDlmmEntry(pool, config);
        scoredEligible.push(pool);
      } catch (err) {
        log("screening", `Pool scorer failed for ${pool.name}: ${err.message}`);
        pushFilteredReason(filteredOut, pool, `pool scorer error: ${err.message}`);
      }
    }
    const minPoolScore = config.screening.minPoolScore;
    const scoreGatedEligible = scoredEligible.filter((pool) => {
      const score = Number(pool.pool_score ?? 0);
      // Unified gate: use minPoolScore as single threshold.
      // Removed separate SKIP recommendation gate — pool-scorer grade thresholds
      // now let C-grade pools (25+) through to the LLM for narrative+risk eval.
      // Only hard-SKIP on wash trading / dev-dump (overridden in pool-scorer).
      if (minPoolScore != null && Number.isFinite(minPoolScore) && score < minPoolScore) {
        pushFilteredReason(filteredOut, pool, `pool score ${score} below minPoolScore ${minPoolScore}`);
        log("screening", `Pool-score gate: dropped ${pool.name} — score ${score} < ${minPoolScore} (grade ${pool.pool_grade ?? "?"})`);
        return false;
      }
      if (pool.is_wash || pool.dev_sold_all) {
        pushFilteredReason(filteredOut, pool, `wash/dev-sold hard SKIP (score ${score})`);
        log("screening", `Pool-score gate: dropped ${pool.name} — wash/dev-sold (score ${score})`);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...scoreGatedEligible);
    eligible.sort((a, b) => (b.pool_score ?? 0) - (a.pool_score ?? 0));
    // Final trim to requested limit — done here, AFTER all risk/indicator filters
    eligible.splice(safeLimit);
    log("screening", `Pool-scorer ranked ${eligible.length} candidate(s) — top score: ${eligible[0]?.pool_score ?? 0}`);
    eligible.forEach((pool, i) => {
      const feeAtvl = ((Number(pool.fee_active_tvl_ratio)||0)*100).toFixed(3)+'%';
      const vol     = pool.volume_window > 1000 ? '$'+(pool.volume_window/1000).toFixed(1)+'k' : '$'+(Number(pool.volume_window||0).toFixed(0));
      const inRange = (Number(pool.active_pct||0)).toFixed(1)+'%';
      const organic = Math.round(Number(pool.organic_score||0));
      const score   = pool.pool_score ?? 0;
      const grade   = pool.pool_grade ?? 'D';
      log("screening", `[${i+1}] ${pool.name} fee/aTVL: ${feeAtvl} vol: ${vol} in-range: ${inRange} organic: ${organic} score: ${score} grade: ${grade}`);
    });
  }

  const debugLimit = normalizeLimit(config.screening.filteredExamplesLimit, 20, 200);
  const filterSummary = filteredOut.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});

  return {
    candidates: eligible,
    // Full funnel — helps agent and logs understand where pools dropped out
    api_total:         discovery.api_total,
    raw_count:         discovery.raw_count,
    threshold_passed:  discovery.threshold_passed,
    after_blacklist:   discovery.after_blacklist,
    total_screened:    pools.length,
    final_count:       eligible.length,
    filtered_examples: filteredOut.slice(0, debugLimit),
    filter_summary:    filterSummary,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe } = {}) {
  if (!pool_address) throw new Error("getPoolDetail: pool_address is required");
  const s = normalizeScreeningConfig(config.screening);
  const tf = timeframe ?? getVolatilityTimeframe(s.timeframe);
  if (!TIMEFRAME_MINUTES[tf]) throw new Error(`getPoolDetail: invalid timeframe=${tf}`);

  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe: tf, category: s.category });
  if (!pool) throw new Error(`Pool ${pool_address} not found`);
  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

// Ring-buffer cap — keeps the most recent MAX_FILTERED_OUT entries.
// Older entries are evicted so debug output always reflects the latest rejection wave,
// not stale early-cycle drops that may no longer be relevant.
const MAX_FILTERED_OUT = 500;
function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  if (list.length >= MAX_FILTERED_OUT) list.shift(); // evict oldest, keep ring fresh
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
