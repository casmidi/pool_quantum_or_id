/**
 * ranking/ranking-db.js
 * Smart Top 10 — Performance Database
 *
 * Stores historical wallet snapshots, ranking history, and per-wallet
 * performance tracking using a JSON file (consistent with existing
 * project persistence: state.json, pool-memory.json, etc.).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "ranking-db.json");

// ─── Internal State ───────────────────────────────────────────

let _cache = null;

function ensureDefault(db) {
  if (!db.wallets) db.wallets = {};
  if (!db.rankingHistory) db.rankingHistory = [];
  if (!db.snapshots) db.snapshots = [];
  if (!db.meta) db.meta = { lastUpdated: null, totalRankCycles: 0 };
  return db;
}

function load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    _cache = ensureDefault(JSON.parse(raw));
  } catch {
    _cache = ensureDefault({});
  }
  return _cache;
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(_cache, null, 2), "utf-8");
  } catch (err) {
    log("ranking_db", `Failed to save: ${err.message}`);
  }
}

// ─── Wallet Performance ───────────────────────────────────────

/**
 * Record or update a wallet's performance snapshot.
 * @param {string} address - Wallet address
 * @param {object} metrics - { pnl7d, pnl30d, feesEarned, winRate, maxDrawdownPct, daysActive30d, lpVolumeSol, source }
 */
export function recordWalletPerformance(address, metrics) {
  const db = load();
  if (!db.wallets[address]) {
    db.wallets[address] = {
      address,
      firstSeen: new Date().toISOString(),
      history: [],
      tags: [],
    };
  }

  const entry = db.wallets[address];
  entry.lastSeen = new Date().toISOString();
  entry.lastMetrics = metrics;

  // Append to history (keep last 90 entries)
  entry.history.push({
    ts: new Date().toISOString(),
    ...metrics,
  });
  if (entry.history.length > 90) {
    entry.history = entry.history.slice(-90);
  }

  save();
  return entry;
}

/**
 * Get stored performance data for a wallet.
 * @param {string} address
 * @returns {object|null}
 */
export function getWalletData(address) {
  const db = load();
  return db.wallets[address] || null;
}

/**
 * Get all tracked wallets with their latest metrics.
 * @returns {Array<object>}
 */
export function getAllTrackedWallets() {
  const db = load();
  return Object.values(db.wallets).map((w) => ({
    address: w.address,
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
    metrics: w.lastMetrics || null,
    historyCount: w.history?.length || 0,
    tags: w.tags || [],
  }));
}

/**
 * Tag a wallet (e.g., "whitelist", "blacklist", "manual_review").
 * @param {string} address
 * @param {string} tag
 */
export function tagWallet(address, tag) {
  const db = load();
  if (!db.wallets[address]) {
    db.wallets[address] = { address, firstSeen: new Date().toISOString(), history: [], tags: [] };
  }
  if (!db.wallets[address].tags.includes(tag)) {
    db.wallets[address].tags.push(tag);
  }
  save();
}

/**
 * Remove a tag from a wallet.
 */
export function untagWallet(address, tag) {
  const db = load();
  if (db.wallets[address]) {
    db.wallets[address].tags = (db.wallets[address].tags || []).filter((t) => t !== tag);
    save();
  }
}

// ─── Ranking Snapshots ────────────────────────────────────────

/**
 * Save a full ranking snapshot (top wallets with scores).
 * @param {Array<object>} rankedWallets - Output from rankWallets()
 * @param {string} strategyMode
 */
export function saveRankingSnapshot(rankedWallets, strategyMode) {
  const db = load();
  const snapshot = {
    ts: new Date().toISOString(),
    mode: strategyMode,
    count: rankedWallets.length,
    entries: rankedWallets.map((w) => ({
      rank: w.rank,
      address: w.address,
      label: w.label,
      score: w.score,
      grade: w.grade,
      pnl7d: w.rawData?.pnl7d ?? null,
      pnl30d: w.rawData?.pnl30d ?? null,
      feesEarned: w.rawData?.feesEarned ?? null,
      winRate: w.rawData?.winRate ?? null,
    })),
  };

  db.snapshots.push(snapshot);
  if (db.snapshots.length > 200) {
    db.snapshots = db.snapshots.slice(-200);
  }

  // Also update ranking history summary
  db.rankingHistory.push({
    ts: snapshot.ts,
    mode: snapshot.mode,
    topCount: snapshot.count,
    topScores: rankedWallets.slice(0, 3).map((w) => ({
      address: w.address,
      rank: w.rank,
      score: w.score,
      grade: w.grade,
    })),
  });
  if (db.rankingHistory.length > 365) {
    db.rankingHistory = db.rankingHistory.slice(-365);
  }

  db.meta.lastUpdated = snapshot.ts;
  db.meta.totalRankCycles = (db.meta.totalRankCycles || 0) + 1;

  save();
  return snapshot;
}

/**
 * Get the most recent ranking snapshot.
 * @returns {object|null}
 */
export function getLatestSnapshot() {
  const db = load();
  return db.snapshots.length > 0 ? db.snapshots[db.snapshots.length - 1] : null;
}

/**
 * Get ranking history for a date range.
 * @param {number} [days=7]
 * @returns {Array<object>}
 */
export function getRankingHistory(days = 7) {
  const db = load();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (db.rankingHistory || []).filter((h) => new Date(h.ts).getTime() >= cutoff);
}

/**
 * Compute wallet rank trend (up/down/stable over last N snapshots).
 * @param {string} address
 * @param {number} [lookback=5]
 * @returns {{ trend: string, ranks: number[] }}
 */
export function getWalletRankTrend(address, lookback = 5) {
  const db = load();
  const ranks = [];
  const snapshots = db.snapshots || [];
  const recent = snapshots.slice(-lookback);

  for (const snap of recent) {
    const entry = snap.entries.find((e) => e.address === address);
    ranks.push(entry ? entry.rank : null);
  }

  const valid = ranks.filter((r) => r != null);
  let trend = "stable";
  if (valid.length >= 2) {
    if (valid[0] > valid[valid.length - 1]) trend = "up";
    else if (valid[0] < valid[valid.length - 1]) trend = "down";
  }

  return { trend, ranks };
}

// ─── Meta ──────────────────────────────────────────────────────

export function getDbMeta() {
  const db = load();
  return db.meta;
}

/**
 * Reset all ranking data (dangerous).
 */
export function resetDb() {
  _cache = ensureDefault({});
  save();
  log("ranking_db", "Database reset");
}
