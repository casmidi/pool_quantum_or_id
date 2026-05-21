/**
 * Internal P&L tracker — independent dari Meridian.
 * Menyimpan log setiap deploy dan close ke file JSON lokal.
 * Bisa dipakai di dry run maupun live.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

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
export function recordDeploy({ poolAddress, poolName, positionAddress, amountSol, isDryRun = true, binsBelow, activeBin, feeTvlRatio, baseMint }) {
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
    bins_below:     binsBelow   ?? null,
    active_bin:     activeBin   ?? null,
    fee_tvl_ratio:  feeTvlRatio ?? null,
    deploy_time:    new Date().toISOString(),
    close_time:     null,
    pnl_pct:        null,
    pnl_usd:        null,
    fees_usd:       null,
    close_reason:   null,
    status:         "open",
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

export function simulateDryRunCloses({
  meanPct    = 1,
  stdevPct   = 5,
  minPct     = -25,
  maxPct     = 20,
  // Harga SOL live dari CoinGecko — agar pnl_usd akurat
  // Kalau gagal fetch, fallback ke cache (default $180).
  solPrice   = null,
  minMinutes = 15,
  maxMinutes = 180,
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
    if (!Number.isFinite(t.target_close_minutes)) {
      t.target_close_minutes = _randHoldMinutes(minMinutes, maxMinutes);
      touched = true;
    }
    const ageMinutes = (now - openMs) / 60000;
    if (ageMinutes < t.target_close_minutes) continue;

    // P&L random
    let pct = _randNormal(meanPct, stdevPct);
    pct     = Math.max(minPct, Math.min(maxPct, pct));
    pct     = Math.round(pct * 100) / 100;

    const amountSol = t.amount_sol ?? 0;
    const pnlSol    = Math.round((pct / 100) * amountSol * 1e6) / 1e6;
    const price     = (Number.isFinite(solPrice) && solPrice > 0) ? solPrice : _solPriceCache;
    const pnlUsd    = price > 0 ? Math.round(pnlSol * price * 100) / 100 : null;

    t.close_time   = new Date().toISOString();
    t.pnl_pct      = pct;
    t.pnl_sol      = pnlSol;
    t.pnl_usd      = pnlUsd;
    t.close_reason = "simulated (dry run)";
    t.status       = "closed";
    t.minutes_held = Math.floor(ageMinutes);
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

  const bestTrade  = closed.length ? closed.reduce((a, b) => (b.pnl_pct ?? -Infinity) > (a.pnl_pct ?? -Infinity) ? b : a, closed[0]) : null;
  const worstTrade = closed.length ? closed.reduce((a, b) => (b.pnl_pct ?? Infinity) < (a.pnl_pct ?? Infinity) ? b : a, closed[0]) : null;

  // Estimasi balance SOL sederhana: initial ± pnl per trade (gunakan pnl_pct dari amount_sol)
  // Gunakan pnl_sol (SOL sejati dari pnl_usd/sol_price) bila tersedia,
  // fallback ke estimasi dari pnl_pct × amount_sol untuk record lama.
  const estimatedPnlSol = closed.reduce((s, t) =>
    s + (t.pnl_sol != null ? t.pnl_sol : ((t.pnl_pct ?? 0) / 100) * (t.amount_sol ?? 0)), 0);

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
    total_pnl_usd:  +totalPnlUsd.toFixed(2),
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
