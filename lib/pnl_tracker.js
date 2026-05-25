/**
 * Internal P&L tracker — independent dari Meridian.
 * Menyimpan log setiap deploy dan close ke file JSON lokal.
 * Bisa dipakai di dry run maupun live.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { applyPoolCooldown, recordPoolDeploy } from "../pool-memory.js";
import { getAIUsageSummary } from "../ai-budget.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "..", "data");
const LOG_FILE   = path.join(DATA_DIR, "pnl_log.json");

// ── Live SOL Price (dari CoinGecko, cache 60 detik) ────────────────
let _solPriceCache = 180;
let _solPriceCacheTime = 0;
let _solPricePromise = null;
const SOL_PRICE_CACHE_TTL_MS = 60_000;

/** Warm the SOL price cache on module load. */
function _warmSolPrice() {
  if (_solPricePromise) return _solPricePromise;
  _solPricePromise = fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
    .then((json) => {
      const price = Number(json?.solana?.usd);
      if (Number.isFinite(price) && price > 0) {
        _solPriceCache = price;
        _solPriceCacheTime = Date.now();
      }
    })
    .catch(() => {
      // Reset promise agar retry selanjutnya fetch ulang
      _solPricePromise = null;
    });
  return _solPricePromise;
}

/**
 * Refresh SOL price dari CoinGecko (cache 60 detik).
 * Panggil fire-and-forget dari fungsi publik agar price selalu fresh.
 */
function _refreshSolPrice() {
  const now = Date.now();
  if (now - _solPriceCacheTime < SOL_PRICE_CACHE_TTL_MS) return;
  _warmSolPrice();
}

// Warm cache di startup
_warmSolPrice();

// ── Struktur data ────────────────────────────────────────────────────────────
function emptyStore() {
  return {
    initial_sol:     getConfiguredInitialSol() ?? 0.5,   // bisa diubah via resetBalance()
    trades:          [],    // array of trade records
    created_at:      new Date().toISOString(),
    last_updated:    new Date().toISOString(),
  };
}

function getConfiguredInitialSol() {
  const n = Number(config.dryRunWallet);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getInitialSol(store) {
  const stored = Number(store.initial_sol);
  return getConfiguredInitialSol() ?? (Number.isFinite(stored) && stored > 0 ? stored : 0.5);
}

// ── File I/O ─────────────────────────────────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOG_FILE)) return emptyStore();
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch {
    return emptyStore();
  }
}

function save(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    store.last_updated = new Date().toISOString();
    fs.writeFileSync(LOG_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error("[PNL_TRACKER] Save error:", e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Catat saat posisi dibuka (deploy berhasil).
 */
export function recordDeploy({
  poolAddress,
  poolName,
  positionAddress,
  amountSol,
  isDryRun = true,
  binsBelow,
  activeBin,
  lowerBin,
  upperBin,
  entryPrice,
  priceRange,
  strategy,
  feeTvlRatio,
  baseMint,
  binStep,
  volatility,
  organicScore,
  holderCount,
}) {
  const store = load();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  // Gunakan positionAddress (LP position) sebagai key matching — lebih unik dari poolAddress
  // Dry run tidak punya positionAddress nyata, buat sentinel agar tidak tabrakan
  const trackingKey = positionAddress ?? (isDryRun ? `dry_${id}` : poolAddress ?? `unknown_${id}`);
  store.trades.push({
    id,
    pool_address:    poolAddress   ?? null,
    position_address: trackingKey,
    pool_name:       poolName     ?? poolAddress?.slice(0, 8) ?? "unknown",
    base_mint:       baseMint     ?? null,
    amount_sol:     amountSol   ?? 0,
    is_dry_run:     isDryRun,
    strategy:       strategy    ?? null,
    bins_below:     binsBelow   ?? null,
    entry_bin:      activeBin   ?? null,
    active_bin:     activeBin   ?? null,
    lower_bin:      lowerBin    ?? null,
    upper_bin:      upperBin    ?? null,
    entry_price:    entryPrice  ?? null,
    price_range:    priceRange  ?? null,
    fee_tvl_ratio:  feeTvlRatio ?? null,
    bin_step:       binStep     ?? null,
    volatility:     volatility  ?? null,
    organic_score:  organicScore ?? null,
    holder_count:   holderCount ?? null,
    deploy_time:    new Date().toISOString(),
    close_time:     null,
    pnl_pct:        null,
    pnl_usd:        null,
    fees_usd:       null,
    close_reason:   null,
    status:         "open",
    paper_fee_sol:  0,
    paper_unrealized_pnl_sol: 0,
    paper_unrealized_pnl_pct: 0,
    paper_mark_time: null,
    minutes_out_of_range: 0,
  });
  save(store);
  return id;
}

/**
 * Update record saat posisi ditutup.
 * Cari by pool_address (paling reliable) atau pool_name + status=open.
 */
export function recordClose({ poolAddress, positionAddress, poolName, pnlPct, pnlUsd, feesUsd, closeReason, solPrice }) {
  const store = load();

  // Prioritas matching: positionAddress (paling unik) → poolAddress → poolName → last open
  let trade = positionAddress
    ? store.trades.find(t => t.status === "open" && t.position_address === positionAddress)
    : null;
  if (!trade && poolAddress) {
    trade = store.trades.filter(t => t.status === "open" && t.pool_address === poolAddress).at(-1);
  }
  if (!trade && poolName) {
    trade = store.trades.filter(t => t.status === "open" && t.pool_name === poolName).at(-1);
  }
  if (!trade) {
    trade = store.trades.filter(t => t.status === "open").at(-1);
  }

  if (trade) {
    trade.close_time   = new Date().toISOString();
    trade.pnl_pct      = pnlPct    ?? null;
    trade.pnl_usd      = pnlUsd    ?? null;
    // pnl_sol = P&L dalam SOL sejati: pnl_usd / harga SOL saat close
    trade.pnl_sol      = (pnlUsd != null && solPrice > 0)
                           ? Math.round((pnlUsd / solPrice) * 1e6) / 1e6
                           : null;
    trade.fees_usd     = feesUsd   ?? null;
    trade.close_reason = closeReason ?? null;
    trade.status       = "closed";
  }

  save(store);
  return trade ?? null;
}

// Box-Muller transform → angka random distribusi normal
function _randNormal(mean = 0, stdev = 1) {
  const u1 = Math.max(1e-12, Math.random());
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdev;
}

// Durasi hold realistis (log-normal): median ~50m, mean ~60m, clip [min,max]
function _randHoldMinutes(min = 15, max = 180) {
  const mu     = Math.log(50);
  const sigma  = 0.55;
  const z      = _randNormal(0, 1);
  const value  = Math.exp(mu + sigma * z);
  return Math.max(min, Math.min(max, Math.round(value)));
}

function _clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function _estimatedRoundTripTxCostUsd() {
  const n = Number(config.costs?.estimatedRoundTripTxCostUsd ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _aiCostUsd() {
  if (config.costs?.includeAICostInNetPnl === false) return 0;
  try {
    return Number(getAIUsageSummary()?.month?.cost_usd ?? 0) || 0;
  } catch {
    return 0;
  }
}

function _dryRunMeanPct(trade) {
  const feeRatio = Number(trade.fee_tvl_ratio);
  const bins = Number(trade.bins_below);
  const volatility = Number(trade.volatility);
  const organic = Number(trade.organic_score);

  let mean = 0.2;

  if (Number.isFinite(feeRatio)) {
    mean += _clamp((feeRatio - 0.02) * 20, -1.0, 2.0);
  }

  if (Number.isFinite(bins)) {
    if (bins < 40) mean -= 0.6;
    else if (bins <= 55) mean += 0.25;
    else mean -= 0.45;
  }

  if (Number.isFinite(volatility)) {
    if (volatility > 5) mean -= 1.2;
    else if (volatility >= 2 && volatility <= 4) mean += 0.25;
    else if (volatility < 1) mean -= 0.25;
  }

  if (Number.isFinite(organic)) {
    if (organic >= 85) mean += 0.45;
    else if (organic >= 75) mean += 0.2;
    else if (organic < 70) mean -= 0.6;
  }

  return _clamp(mean, -2.5, 4.0);
}

function _recordDryRunCloseToPoolMemory(trade) {
  if (!trade?.pool_address || trade.pnl_pct == null) return;

  try {
    recordPoolDeploy(trade.pool_address, {
      pool_name: trade.pool_name,
      base_mint: trade.base_mint,
      deployed_at: trade.deploy_time,
      closed_at: trade.close_time,
      pnl_pct: trade.pnl_pct,
      pnl_usd: trade.pnl_usd,
      fees_earned_usd: trade.fees_usd,
      range_efficiency: null,
      minutes_held: trade.minutes_held,
      close_reason: trade.close_reason,
      strategy: "dry_run",
      bin_step: trade.bin_step,
      volatility: trade.volatility,
      fee_tvl_ratio: trade.fee_tvl_ratio,
      organic_score: trade.organic_score,
    });

    if (config.management.lossTriggeredCooldown) {
      const threshold = config.management.lossCooldownThresholdPct ?? -15;
      if (Number.isFinite(trade.pnl_pct) && trade.pnl_pct < threshold) {
        const severity = Math.min(4, Math.ceil(Math.abs(trade.pnl_pct) / Math.abs(threshold)));
        const cooldownHrs = (config.management.lossCooldownHours ?? 6) * severity;
        applyPoolCooldown(trade.pool_address, cooldownHrs, `dry_run_loss: pnl=${trade.pnl_pct.toFixed(1)}%`);
      }
    }
  } catch (e) {
    console.error("[PNL_TRACKER] Pool memory update error:", e.message);
  }
}

/**
 * Auto-close semua dry-run open positions yang sudah berumur >= minAgeMs.
 * P&L diambil dari distribusi normal realistis dan disimpan persis seperti
 * close beneran (pnl_pct, pnl_sol, pnl_usd) — agar dashboard/badge bergerak.
 *
 * Defaults: minAgeMs=5 menit, mean +1%, stdev 5%, clip [-25%, +20%].
 * Return jumlah trade yang ditutup.
 */
// Tidak perlu tulis ke decision-log.json — bot punya cap MAX_DECISIONS=100
// yang bisa evict simulated close entries. Dashboard sudah saya ubah agar
// baca langsung dari pnl_log.json.
 
function _num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _round(n, digits = 6) {
  const m = 10 ** digits;
  return Math.round((Number(n) || 0) * m) / m;
}

function _timeframeMinutes(tf = "30m") {
  const map = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440 };
  return map[tf] ?? 30;
}

async function _markDryRunTrade(trade, now) {
  if (!trade.pool_address) throw new Error("paper mark skipped: missing pool_address");
  const [{ getActiveBin }, { getPoolDetail }] = await Promise.all([
    import("../tools/dlmm.js"),
    import("../tools/screening.js"),
  ]);

  const active = await getActiveBin({ pool_address: trade.pool_address });
  const timeframe = config.screening?.timeframe || "30m";
  const detail = await getPoolDetail({ pool_address: trade.pool_address, timeframe }).catch(() => null);

  const amountSol = _num(trade.amount_sol, 0);
  const entryBin = _num(trade.entry_bin ?? trade.active_bin);
  const currentBin = _num(active?.binId);
  const binStep = _num(trade.bin_step ?? detail?.dlmm_params?.bin_step, 80);
  if (entryBin == null || currentBin == null || amountSol <= 0) {
    throw new Error("paper mark skipped: missing entry/current bin or amount");
  }

  const lowerBin = _num(trade.lower_bin, entryBin - _num(trade.bins_below, 0));
  const upperBin = _num(trade.upper_bin, entryBin);
  const widthBins = Math.max(1, upperBin - lowerBin + 1);
  const binDelta = currentBin - entryBin;
  const priceRatio = Math.pow(1 + (binStep / 10000), binDelta);
  const pricePnlPct = currentBin >= entryBin
    ? 0
    : (priceRatio - 1) * 100 * Math.min(1, Math.abs(binDelta) / Math.max(1, entryBin - lowerBin));

  const lastMarkMs = Number.isFinite(new Date(trade.paper_mark_time).getTime())
    ? new Date(trade.paper_mark_time).getTime()
    : new Date(trade.deploy_time).getTime();
  const elapsedMinutes = Math.max(0, (now - lastMarkMs) / 60000);
  const feeRatio = _num(detail?.fee_active_tvl_ratio ?? trade.fee_tvl_ratio, 0);
  const inRange = currentBin >= lowerBin && currentBin <= upperBin;
  const aboveRange = currentBin > upperBin;
  const belowRange = currentBin < lowerBin;
  const feeCaptureFactor = inRange ? Math.min(1, 8 / widthBins) : 0;
  const feeSolDelta = amountSol * feeRatio * (elapsedMinutes / _timeframeMinutes(timeframe)) * feeCaptureFactor;
  const paperFeeSol = _round(_num(trade.paper_fee_sol, 0) + Math.max(0, feeSolDelta), 9);
  const pricePnlSol = amountSol * (pricePnlPct / 100);
  const pnlSol = _round(pricePnlSol + paperFeeSol, 6);
  const pnlPct = amountSol > 0 ? _round((pnlSol / amountSol) * 100, 2) : 0;
  const lastOor = _num(trade.minutes_out_of_range, 0);
  const minutesOutOfRange = (aboveRange || belowRange) ? _round(lastOor + elapsedMinutes, 2) : 0;
  const dailyFeePct = feeRatio * (1440 / _timeframeMinutes(timeframe)) * 100 * feeCaptureFactor;

  return {
    pnlSol,
    pnlPct,
    fields: {
      active_bin: currentBin,
      current_price: _num(active?.price),
      paper_mark_time: new Date(now).toISOString(),
      paper_fee_sol: paperFeeSol,
      paper_price_pnl_pct: _round(pricePnlPct, 2),
      paper_unrealized_pnl_sol: pnlSol,
      paper_unrealized_pnl_pct: pnlPct,
      fee_per_tvl_24h: _round(dailyFeePct, 2),
      in_range: inRange,
      minutes_out_of_range: minutesOutOfRange,
      out_of_range_side: aboveRange ? "above" : belowRange ? "below" : null,
      paper_last_error: null,
    },
  };
}

function _paperCloseReason(trade, ageMinutes, pnlPct, maxMinutes) {
  const m = config.management ?? {};
  const peak = Math.max(_num(trade.peak_pnl_pct, pnlPct), pnlPct);
  trade.peak_pnl_pct = _round(peak, 2);

  if (_num(m.stopLossPct) != null && pnlPct <= Number(m.stopLossPct)) return "paper stop-loss";
  if (m.trailingTakeProfit && peak >= _num(m.trailingTriggerPct, 3) && pnlPct <= peak - _num(m.trailingDropPct, 1.5)) {
    return "paper trailing take-profit";
  }
  if (_num(m.takeProfitPct) != null && pnlPct >= Number(m.takeProfitPct)) return "paper take-profit";
  if (trade.out_of_range_side && _num(trade.minutes_out_of_range, 0) >= _num(m.outOfRangeWaitMinutes, 20)) {
    return `paper out-of-range ${trade.out_of_range_side}`;
  }
  if (
    ageMinutes >= _num(m.minAgeBeforeYieldCheck, 90) &&
    _num(trade.fee_per_tvl_24h) != null &&
    _num(trade.fee_per_tvl_24h) < _num(m.minFeePerTvl24h, 0)
  ) {
    return "paper low-yield";
  }
  if (maxMinutes != null && ageMinutes >= Number(maxMinutes)) return "paper max-hold";
  return null;
}

export async function simulateDryRunCloses({
  // Harga SOL live dari CoinGecko — agar pnl_usd akurat
  // Kalau gagal fetch, fallback ke cache (default $180).
  solPrice   = null,
  maxMinutes = null,
} = {}) {
  _refreshSolPrice(); // fire-and-forget — cache tetap sync (_solPriceCache)
  const store = load();
  const now   = Date.now();
  let closedCount = 0;
  let touched     = false;

  for (const t of store.trades) {
    if (t.status !== "open") continue;
    if (!t.is_dry_run) continue;
    const openMs = new Date(t.deploy_time).getTime();
    if (!Number.isFinite(openMs)) continue;

    // Assign target hold time sekali (persist di record) — log-normal mean ~60m
    const ageMinutes = (now - openMs) / 60000;
    const mark = await _markDryRunTrade(t, now).catch((error) => {
      t.paper_last_error = error.message;
      return null;
    });
    if (!mark) {
      touched = true;
      continue;
    }

    Object.assign(t, mark.fields);
    touched = true;

    const amountSol = Number(t.amount_sol ?? 0);
    const price     = (Number.isFinite(solPrice) && solPrice > 0) ? solPrice : _solPriceCache;
    const grossPnlSol = mark.pnlSol;
    const grossPct = mark.pnlPct;
    const txCostUsd = _estimatedRoundTripTxCostUsd();
    const txCostSol = price > 0 ? txCostUsd / price : 0;
    const pnlSol    = Math.round((grossPnlSol - txCostSol) * 1e6) / 1e6;
    const pct       = amountSol > 0 ? Math.round((pnlSol / amountSol) * 10000) / 100 : 0;
    const pnlUsd    = price > 0 ? Math.round(pnlSol * price * 100) / 100 : null;
    const closeReason = _paperCloseReason(t, ageMinutes, pct, maxMinutes);
    if (!closeReason) continue;

    t.close_time   = new Date().toISOString();
    t.pnl_pct      = pct;
    t.pnl_sol      = pnlSol;
    t.pnl_usd      = pnlUsd;
    t.gross_pnl_pct = grossPct;
    t.gross_pnl_sol = grossPnlSol;
    t.gross_pnl_usd = price > 0 ? Math.round(grossPnlSol * price * 100) / 100 : null;
    t.costs_usd     = txCostUsd;
    t.costs_note    = "estimated round-trip transaction cost";
    t.costs_included_in_pnl = true;
    t.close_reason = closeReason;
    t.status       = "closed";
    t.minutes_held = Math.floor(ageMinutes);
    _recordDryRunCloseToPoolMemory(t);
    closedCount++;
    touched = true;
  }
  if (touched) save(store);
  return closedCount;
}

/**
 * Hitung ringkasan dari semua trade tercatat.
 */
export function getSummary() {
  _refreshSolPrice();
  const store  = load();
  const initialSol = getInitialSol(store);
  const closed = store.trades.filter(t => t.status === "closed");
  const open   = store.trades.filter(t => t.status === "open");

  const wins   = closed.filter(t => (t.pnl_pct ?? 0) > 0);
  const losses = closed.filter(t => (t.pnl_pct ?? 0) <= 0);

  const totalPnlPct  = closed.reduce((s, t) => s + (t.pnl_pct ?? 0), 0);
  const totalPnlUsd  = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const totalFeesUsd = closed.reduce((s, t) => s + (t.fees_usd ?? 0), 0);
  const implicitTxCostUsd = closed.reduce((s, t) =>
    s + (t.costs_included_in_pnl ? 0 : _estimatedRoundTripTxCostUsd()), 0);
  const explicitTxCostUsd = closed.reduce((s, t) => s + (Number(t.costs_usd ?? 0) || 0), 0);
  const aiCostUsd = _aiCostUsd();

  const bestTrade  = closed.length ? closed.reduce((a, b) => (b.pnl_pct ?? -Infinity) > (a.pnl_pct ?? -Infinity) ? b : a, closed[0]) : null;
  const worstTrade = closed.length ? closed.reduce((a, b) => (b.pnl_pct ?? Infinity) < (a.pnl_pct ?? Infinity) ? b : a, closed[0]) : null;

  // Estimasi balance SOL sederhana: initial ± pnl per trade (gunakan pnl_pct dari amount_sol)
  // Gunakan pnl_sol (SOL sejati dari pnl_usd/sol_price) bila tersedia,
  // fallback ke estimasi dari pnl_pct × amount_sol untuk record lama.
  const estimatedPnlSolGross = closed.reduce((s, t) =>
    s + (t.pnl_sol != null ? t.pnl_sol : ((t.pnl_pct ?? 0) / 100) * (t.amount_sol ?? 0)), 0);
  const costSol = _solPriceCache > 0 ? (implicitTxCostUsd + aiCostUsd) / _solPriceCache : 0;
  const estimatedPnlSol = estimatedPnlSolGross - costSol;

  // 🔴 BUG FIX: Kurangi SOL yang masih terkunci di posisi open dari balance.
  // Tanpa ini, currentSol selalu = initialSol + PnL, sehingga saldo terlihat
  // seolah-olah tidak pernah terpakai untuk deploy → screening cycle deploy terus.
  const lockedInOpen   = open.reduce((s, t) => s + (t.amount_sol ?? 0), 0);
  const currentSol     = initialSol + estimatedPnlSol - lockedInOpen;

  return {
    initial_sol:    initialSol,
    current_sol:    +currentSol.toFixed(4),
    sol_price:      _solPriceCache,
    net_pnl_sol:    +estimatedPnlSol.toFixed(4),
    // 🔴 BUG FIX: Gunakan initialSol (resolved — bisa dari config.dryRunWallet)
    // Bukan store.initial_sol (nilai persist yang mungkin beda).
    net_pnl_pct:    initialSol > 0 ? +((estimatedPnlSol / initialSol) * 100).toFixed(2) : 0,
    total_trades:   closed.length,
    open_positions: open.length,
    wins:           wins.length,
    losses:         losses.length,
    win_rate:       closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : 0,
    avg_pnl_pct:    closed.length ? +(totalPnlPct / closed.length).toFixed(2) : 0,
    total_pnl_usd:  +(totalPnlUsd - implicitTxCostUsd - aiCostUsd).toFixed(2),
    gross_pnl_usd:  +totalPnlUsd.toFixed(2),
    ai_cost_usd:    +aiCostUsd.toFixed(4),
    tx_cost_usd:    +(implicitTxCostUsd + explicitTxCostUsd).toFixed(4),
    net_after_cost_usd: +(totalPnlUsd - implicitTxCostUsd - aiCostUsd).toFixed(2),
    total_fees_usd: +totalFeesUsd.toFixed(2),
    best_trade:     bestTrade  ? { pool: bestTrade.pool_name,  pnl: bestTrade.pnl_pct }  : null,
    worst_trade:    worstTrade ? { pool: worstTrade.pool_name, pnl: worstTrade.pnl_pct } : null,
    by_reason:      _countByReason(closed),
    last_updated:   store.last_updated,
  };
}

export function getOpenTrades() {
  const store = load();
  return store.trades
    .filter(t => t.status === "open")
    .map(t => ({ ...t }));
}

/**
 * Reset balance ke initial_sol baru (hapus semua history).
 */
export function resetBalance(initialSol = 0.5) {
  const fresh = emptyStore();
  fresh.initial_sol = initialSol;
  save(fresh);
  return fresh;
}

/**
 * Format summary sebagai teks Telegram.
 */
export function formatSummaryTelegram(isDryRun = true) {
  const s   = getSummary();
  const tag = isDryRun ? " [DRY RUN]" : "";
  const sign = s.net_pnl_sol >= 0 ? "+" : "";
  const solPriceLine = s.sol_price > 0
    ? `◎ SOL: <b>$${s.sol_price}</b>`
    : "";

  const lines = [
    `📊 <b>P&amp;L Summary${tag}</b>`,
    solPriceLine,
    ``,
    `◎ Balance: <b>${s.current_sol} SOL</b>  (${sign}${s.net_pnl_pct}%)`,
    `  Awal: ${s.initial_sol} SOL  |  Net: ${sign}${s.net_pnl_sol} SOL`,
    s.total_pnl_usd ? `  PnL USD: ${sign}$${s.total_pnl_usd}` : "",
    (s.ai_cost_usd || s.tx_cost_usd) ? `  Costs: AI $${s.ai_cost_usd} | tx est. $${s.tx_cost_usd}` : "",
    ``,
    `📈 Trades tertutup: <b>${s.total_trades}</b>  |  Terbuka: ${s.open_positions}`,
    `  ✅ Win: ${s.wins}  ❌ Loss: ${s.losses}  |  Win rate: <b>${s.win_rate}%</b>`,
    `  Avg PnL: ${s.avg_pnl_pct >= 0 ? "+" : ""}${s.avg_pnl_pct}%`,
    s.total_fees_usd ? `  Total fees earned: $${s.total_fees_usd}` : "",
    ``,
    s.best_trade  ? `🏆 Best:  <b>${s.best_trade.pool}</b>  ${s.best_trade.pnl >= 0 ? "+" : ""}${s.best_trade.pnl}%` : "",
    s.worst_trade ? `💀 Worst: <b>${s.worst_trade.pool}</b>  ${s.worst_trade.pnl >= 0 ? "+" : ""}${s.worst_trade.pnl}%` : "",
    ``,
    _reasonLine(s.by_reason),
  ].filter(l => l !== "");

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _countByReason(closed) {
  return closed.reduce((acc, t) => {
    const r = t.close_reason ?? "unknown";
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
}

function _reasonLine(byReason) {
  if (!Object.keys(byReason).length) return "";
  const parts = Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}×${n}`)
    .join("  ");
  return `Exit: ${parts}`;
}
