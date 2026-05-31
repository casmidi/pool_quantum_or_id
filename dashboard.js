import "dotenv/config";
/**
 * Pool Dashboard — Backend Server (PATCHED v2)
 * =============================================
 * Fix: extractBotInfo sekarang baca format log non-TTY PM2
 * Fix: SOL price fetch langsung dari CoinGecko API (bukan dari log)
 * Fix: SOL balance baca dari log CRON
 * Fix: screeningCount baca dari semua log files
 * Fix: running status deteksi dari aktivitas log terbaru
 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Berada di root meridian-bot — BOT_DIR = direktori ini sendiri
const BOT_DIR = __dirname;

const PATHS = {
  state: path.join(BOT_DIR, "state.json"),
  decisions: path.join(BOT_DIR, "decision-log.json"),
  userConfig: path.join(BOT_DIR, "user-config.json"),
  signals: path.join(BOT_DIR, "signal-weights.json"),
  logsDir: path.join(BOT_DIR, "logs"),
  dotenv: path.join(BOT_DIR, ".env"),
  pnlLog: path.join(BOT_DIR, "data", "pnl_log.json"),
  aiUsage: path.join(BOT_DIR, "data", "ai_usage.json"),
  aiProviderAlert: path.join(BOT_DIR, "data", "ai_provider_alert.json"),
  rankingDb: path.join(BOT_DIR, "ranking-db.json"),
};

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.use(express.json());

// ── Helper: fetch SOL price dari CoinGecko ────────────────────────────────────
let _solPriceCache = 0;
let _solPriceCacheTime = 0;

async function fetchSolPrice() {
  const now = Date.now();
  if (_solPriceCache > 0 && now - _solPriceCacheTime < 60_000) {
    return _solPriceCache;
  }
  return new Promise((resolve) => {
    exec(
      'curl -s "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"',
      (err, stdout) => {
        if (err) { resolve(_solPriceCache || 0); return; }
        try {
          const json = JSON.parse(stdout);
          _solPriceCache = json?.solana?.usd || 0;
          _solPriceCacheTime = Date.now();
          resolve(_solPriceCache);
        } catch {
          resolve(_solPriceCache || 0);
        }
      }
    );
  });
}

// ── Helper: baca JSON file ────────────────────────────────────────────────────
function readJSON(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`Failed to read ${filePath}:`, e.message);
    return fallback;
  }
}

// ── Helper: baca .env file sebagai key=value map ──────────────────────────────
function readDotenv(filePath) {
  const result = {};
  try {
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  } catch (_) { }
  return result;
}

// ── Helper: ambil semua log lines dari 2 file terbaru ────────────────────────
function getAllLogLines() {
  try {
    if (!fs.existsSync(PATHS.logsDir)) return [];
    const files = fs.readdirSync(PATHS.logsDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .slice(-2);
    const lines = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(PATHS.logsDir, f), "utf8");
      lines.push(...content.split("\n").filter(Boolean));
    }
    return lines;
  } catch {
    return [];
  }
}

// ── Helper: ambil log file terbaru saja ──────────────────────────────────────
function getLatestLog() {
  try {
    if (!fs.existsSync(PATHS.logsDir)) return [];
    const files = fs.readdirSync(PATHS.logsDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();
    if (!files.length) return [];
    const content = fs.readFileSync(path.join(PATHS.logsDir, files[0]), "utf8");
    return content.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ── Helper: parse log line ────────────────────────────────────────────────────
function parseLogLine(line) {
  const match = line.match(/^\[(.+?)\] \[(.+?)\] (.+)$/);
  if (!match) return null;
  return { ts: match[1], tag: match[2], msg: match[3] };
}

// ── Helper: ekstrak info bot dari log ────────────────────────────────────────
function extractBotInfo(lines) {
  let wallet = null;
  let mode = "DRY RUN";
  let model = "unknown";
  let solBalance = 0;
  let screeningCount = 0;
  let lastActivity = null;
  let lastScreening = null;

  const dotenv = readDotenv(PATHS.dotenv);
  const cfg = readJSON(PATHS.userConfig, {});
  // user-config.json dryRun wins over .env (mirrors config.js fix)
  if (cfg.dryRun !== undefined) {
    mode = cfg.dryRun === false ? "LIVE" : "DRY RUN";
  } else {
    mode = dotenv.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
  }
  if (cfg.screeningModel) model = cfg.screeningModel;

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;

    lastActivity = parsed.ts;

    if (parsed.tag === "INIT" && parsed.msg.includes("Wallet:")) {
      wallet = parsed.msg.replace("Wallet:", "").trim();
    }

    if (parsed.msg.includes("wallet:") && parsed.msg.includes("SOL")) {
      const m = parsed.msg.match(/wallet:\s*([\d.]+)\s*SOL/);
      if (m) solBalance = parseFloat(m[1]);
    }

    if (parsed.tag === "CRON" && parsed.msg.includes("Starting screening cycle")) {
      screeningCount++;
      lastScreening = parsed.ts;
    }
  }

  let isRunning = false;
  if (lastActivity) {
    isRunning = Date.now() - new Date(lastActivity).getTime() < 40 * 60 * 1000;
  }
  if (!isRunning && lastScreening) {
    isRunning = Date.now() - new Date(lastScreening).getTime() < 35 * 60 * 1000;
  }

  return { wallet, mode, model, solBalance, screeningCount, lastActivity, isRunning };
}

// ── Helper: ekstrak pool dari log ────────────────────────────────────────────
function extractPoolsFromLog(lines) {
  const candidates = new Map();
  const dropped = [];

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;

    const poolMatch = parsed.msg.match(/^POOL:\s+(\S+)\s+\((\S+)\)/);
    if (poolMatch) {
      candidates.set(poolMatch[1], {
        name: poolMatch[1],
        pool: poolMatch[2],
        status: "candidate",
        ts: parsed.ts,
      });
    }

    if (parsed.msg.includes("metrics:") && parsed.msg.includes("organic=")) {
      const lastPool = [...candidates.values()].pop();
      if (lastPool) {
        const organicMatch = parsed.msg.match(/organic=([\d.]+)/);
        const volMatch = parsed.msg.match(/vol=\$([\d.]+)/);
        const tvlMatch = parsed.msg.match(/tvl=\$([\d.]+)/);
        const feeTvlMatch = parsed.msg.match(/fee_tvl=([\d.]+)/);
        if (organicMatch) lastPool.organic = parseFloat(organicMatch[1]);
        if (volMatch) lastPool.vol_usd = parseFloat(volMatch[1]);
        if (tvlMatch) lastPool.tvl_usd = parseFloat(tvlMatch[1]);
        if (feeTvlMatch) lastPool.feeAtvl = `${(parseFloat(feeTvlMatch[1]) * 100).toFixed(2)}%`;
      }
    }

    if (parsed.tag === "SAFETY_BLOCK") {
      const m = parsed.msg.match(/([A-Z]+-[A-Z0-9]+)/);
      if (m) dropped.push({ name: m[1], reason: parsed.msg, status: "blocked", ts: parsed.ts });
    }

    const pvpMatch = parsed.msg.match(/PVP guard: (\S+) has active rival/);
    if (pvpMatch) {
      dropped.push({ name: pvpMatch[1], reason: "PVP guard blocked", status: "dropped", ts: parsed.ts });
    }

    const botMatch = parsed.msg.match(/Bot-holder filter: dropped (\S+).*bots ([\d.]+)% > (\d+)%/);
    if (botMatch) {
      dropped.push({
        name: botMatch[1],
        reason: `bots ${botMatch[2]}% > ${botMatch[3]}%`,
        status: "dropped",
        ts: parsed.ts
      });
    }

    const scoreMatch = parsed.msg.match(/Pool-score gate: dropped (\S+) — score (\d+) < (\d+)/);
    if (scoreMatch) {
      dropped.push({
        name: scoreMatch[1],
        reason: `score ${scoreMatch[2]} < ${scoreMatch[3]}`,
        status: "dropped",
        ts: parsed.ts
      });
    }
  }

  return { candidates: Array.from(candidates.values()), dropped: dropped.slice(-10) };
}

// ── Helper: hitung PnL per hari ──────────────────────────────────────────────
function calcDailyPnl(decisions) {
  const pnlByDay = {};
  for (const d of decisions) {
    if (!d.ts || !d.metrics) continue;
    const day = d.ts.slice(0, 10);
    const pnl = parseFloat(d.metrics.pnl_usd || d.metrics.pnl || 0);
    if (!pnlByDay[day]) pnlByDay[day] = 0;
    pnlByDay[day] += pnl;
  }
  return pnlByDay;
}

function getCurrentMonthAICostUsd() {
  const usage = readJSON(PATHS.aiUsage, { months: {} });
  const monthKey = new Date().toISOString().slice(0, 7);
  return Number(usage?.months?.[monthKey]?.cost_usd ?? 0) || 0;
}

function getAIBudgetStatus(config = {}) {
  const usage = readJSON(PATHS.aiUsage, { days: {}, months: {} });
  const providerAlert = readJSON(PATHS.aiProviderAlert, null);
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  const day = usage?.days?.[dayKey] || {};
  const month = usage?.months?.[monthKey] || {};
  const dayCalls = Number(day.calls || 0);
  const dayCostUsd = Number(day.cost_usd || 0);
  const monthCalls = Number(month.calls || 0);
  const monthCostUsd = Number(month.cost_usd || 0);
  const dailyBudgetUsd = Number(config.aiDailyBudgetUsd || 0);
  const monthlyBudgetUsd = Number(config.aiMonthlyBudgetUsd || 0);
  const maxCallsPerDay = Number(config.aiMaxCallsPerDay || 0);
  const dailyCostPct = dailyBudgetUsd > 0 ? (dayCostUsd / dailyBudgetUsd) * 100 : null;
  const monthlyCostPct = monthlyBudgetUsd > 0 ? (monthCostUsd / monthlyBudgetUsd) * 100 : null;
  const dailyCallPct = maxCallsPerDay > 0 ? (dayCalls / maxCallsPerDay) * 100 : null;

  const blockedReasons = [];
  const warnReasons = [];
  if (dailyBudgetUsd > 0 && dayCostUsd >= dailyBudgetUsd) {
    blockedReasons.push(`AI daily budget reached: $${dayCostUsd.toFixed(4)} >= $${dailyBudgetUsd}`);
  } else if (dailyCostPct != null && dailyCostPct >= 80) {
    warnReasons.push(`AI daily budget ${dailyCostPct.toFixed(0)}% used`);
  }
  if (monthlyBudgetUsd > 0 && monthCostUsd >= monthlyBudgetUsd) {
    blockedReasons.push(`AI monthly budget reached: $${monthCostUsd.toFixed(4)} >= $${monthlyBudgetUsd}`);
  } else if (monthlyCostPct != null && monthlyCostPct >= 80) {
    warnReasons.push(`AI monthly budget ${monthlyCostPct.toFixed(0)}% used`);
  }
  if (maxCallsPerDay > 0 && dayCalls >= maxCallsPerDay) {
    blockedReasons.push(`AI daily call cap reached: ${dayCalls} >= ${maxCallsPerDay}`);
  } else if (dailyCallPct != null && dailyCallPct >= 80) {
    warnReasons.push(`AI daily call cap ${dailyCallPct.toFixed(0)}% used`);
  }

  const providerAlertAgeMs = providerAlert?.ts ? now.getTime() - new Date(providerAlert.ts).getTime() : Infinity;
  if (providerAlert?.active && providerAlertAgeMs >= 0 && providerAlertAgeMs < 24 * 60 * 60 * 1000) {
    blockedReasons.push(providerAlert.reason || "OpenRouter budget/credits blocked");
  }

  const blocked = blockedReasons.length > 0;
  const warn = blocked || warnReasons.length > 0;
  return {
    blocked,
    warn,
    reason: blocked ? blockedReasons.join("; ") : warnReasons.join("; "),
    dayKey,
    monthKey,
    dayCalls,
    dayCostUsd: Math.round(dayCostUsd * 1000000) / 1000000,
    monthCalls,
    monthCostUsd: Math.round(monthCostUsd * 1000000) / 1000000,
    dailyBudgetUsd,
    monthlyBudgetUsd,
    maxCallsPerDay,
    dailyCostPct: dailyCostPct == null ? null : Math.round(dailyCostPct * 10) / 10,
    monthlyCostPct: monthlyCostPct == null ? null : Math.round(monthlyCostPct * 10) / 10,
    dailyCallPct: dailyCallPct == null ? null : Math.round(dailyCallPct * 10) / 10,
    providerAlert: providerAlert?.active && providerAlertAgeMs >= 0 && providerAlertAgeMs < 24 * 60 * 60 * 1000
      ? { type: providerAlert.type || "provider", ts: providerAlert.ts || null }
      : null,
  };
}

function calcPnlSummary(config = {}, solPrice = 0) {
  const pnl = readJSON(PATHS.pnlLog, { trades: [] });
  const allTrades = pnl.trades || [];
  // In LIVE mode only count real trades; in dry-run only count simulated trades
  // Check user-config first, then fallback to .env (mirrors config.js logic)
  const dotenvForMode = readDotenv(PATHS.dotenv);
  const isLiveMode = config.dryRun !== undefined
    ? (config.dryRun === false || config.dryRun === "false")
    : dotenvForMode.DRY_RUN !== "true";
  const trades = isLiveMode
    ? allTrades.filter(t => !t.is_dry_run)
    : allTrades.filter(t => t.is_dry_run !== false);
  const closed = trades.filter(t => t.status === "closed");
  const open = trades.filter(t => t.status === "open");
  const configuredInitial = Number(config.dry_run_wallet ?? config.dryRunWallet);
  const storedInitial = Number(pnl.initial_sol);
  const fallbackInitial = Number(config.deployAmountSol || 0.5) * Math.max(1, Number(config.maxPositions || 1));
  const initial = Number.isFinite(configuredInitial) && configuredInitial > 0
    ? configuredInitial
    : Number.isFinite(storedInitial) && storedInitial > 0
      ? storedInitial
      : fallbackInitial;
  const pnlSolRaw = closed.reduce((sum, t) => {
    const explicit = Number(t.pnl_sol);
    if (Number.isFinite(explicit)) return sum + explicit;
    return sum + (Number(t.pnl_pct || 0) / 100) * Number(t.amount_sol || 0);
  }, 0);
  const pnlUsd = closed.reduce((sum, t) => sum + Number(t.pnl_usd || 0), 0);
  const estimatedRoundTripCostUsd = Number(config.estimatedRoundTripTxCostUsd ?? 0.04);
  const implicitTxCostUsd = closed.reduce((sum, t) => (
    sum + (t.costs_included_in_pnl ? 0 : (Number.isFinite(estimatedRoundTripCostUsd) ? estimatedRoundTripCostUsd : 0))
  ), 0);
  const explicitTxCostUsd = closed.reduce((sum, t) => sum + Number(t.costs_usd || 0), 0);
  const aiCostUsd = config.includeAICostInNetPnl === false ? 0 : getCurrentMonthAICostUsd();
  const netCostUsd = implicitTxCostUsd + aiCostUsd;
  const netCostSol = solPrice > 0 ? netCostUsd / solPrice : 0;
  const pnlSol = pnlSolRaw - netCostSol;
  const netPnlUsd = pnlUsd - netCostUsd;
  const locked = open.reduce((sum, t) => sum + Number(t.amount_sol || 0), 0);
  const current = initial + pnlSol - locked;
  const wins = closed.filter(t => Number(t.pnl_pct || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl_pct || 0) <= 0);
  const daily = {};
  let lastClosedDay = null;
  for (const t of closed) {
    const day = String(t.close_time || t.deploy_time || "").slice(0, 10);
    if (!day) continue;
    lastClosedDay = day;
    const implicitCost = t.costs_included_in_pnl ? 0 : (Number.isFinite(estimatedRoundTripCostUsd) ? estimatedRoundTripCostUsd : 0);
    daily[day] = (daily[day] || 0) + Number(t.pnl_usd || 0) - implicitCost;
  }
  if (aiCostUsd > 0) {
    const costDay = lastClosedDay || pnl.last_updated?.slice?.(0, 10) || new Date().toISOString().slice(0, 10);
    daily[costDay] = (daily[costDay] || 0) - aiCostUsd;
  }
  return {
    initial: Math.round(initial * 10000) / 10000,
    current: Math.round(current * 10000) / 10000,
    pnl: Math.round(pnlSol * 10000) / 10000,
    pnlUsd: Math.round(netPnlUsd * 100) / 100,
    grossPnlUsd: Math.round(pnlUsd * 100) / 100,
    costsUsd: Math.round((netCostUsd + explicitTxCostUsd) * 10000) / 10000,
    aiCostUsd: Math.round(aiCostUsd * 10000) / 10000,
    txCostUsd: Math.round((implicitTxCostUsd + explicitTxCostUsd) * 10000) / 10000,
    locked: Math.round(locked * 10000) / 10000,
    total: closed.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    daily,
    lastUpdated: pnl.last_updated || null,
  };
}

function getModeFilteredTrades(config = {}) {
  const pnl = readJSON(PATHS.pnlLog, { trades: [] });
  const allTrades = Array.isArray(pnl.trades) ? pnl.trades : [];
  const dotenvForMode = readDotenv(PATHS.dotenv);
  const isLiveMode = config.dryRun !== undefined
    ? (config.dryRun === false || config.dryRun === "false")
    : dotenvForMode.DRY_RUN !== "true";
  return (isLiveMode
    ? allTrades.filter(t => !t.is_dry_run)
    : allTrades.filter(t => t.is_dry_run !== false)
  ).sort((a, b) => {
    const at = new Date(a.close_time || a.deploy_time || 0).getTime();
    const bt = new Date(b.close_time || b.deploy_time || 0).getTime();
    return bt - at;
  });
}

function normalizeTradeHistory(trades = [], solPrice = 0, limit = 50) {
  return trades.slice(0, limit).map((t) => {
    const amountSol = Number(t.amount_sol || 0);
    const pnlSol = Number.isFinite(Number(t.pnl_sol))
      ? Number(t.pnl_sol)
      : Number.isFinite(Number(t.paper_unrealized_pnl_sol))
        ? Number(t.paper_unrealized_pnl_sol)
        : null;
    const pnlPct = Number.isFinite(Number(t.pnl_pct))
      ? Number(t.pnl_pct)
      : Number.isFinite(Number(t.paper_unrealized_pnl_pct))
        ? Number(t.paper_unrealized_pnl_pct)
        : null;
    const pnlUsd = Number.isFinite(Number(t.pnl_usd))
      ? Number(t.pnl_usd)
      : (pnlSol != null && solPrice > 0 ? pnlSol * solPrice : null);
    const deployMs = new Date(t.deploy_time || 0).getTime();
    const endMs = new Date(t.close_time || Date.now()).getTime();
    const minutesHeld = Number.isFinite(Number(t.minutes_held))
      ? Number(t.minutes_held)
      : (Number.isFinite(deployMs) && Number.isFinite(endMs) ? Math.max(0, Math.floor((endMs - deployMs) / 60000)) : null);
    return {
      id: t.id || t.position_address || t.pool_address || null,
      pool: t.pool_name || t.pair || "Unknown pool",
      poolAddress: t.pool_address || null,
      positionAddress: t.position_address || null,
      status: t.status || "unknown",
      mode: t.is_dry_run ? "DRY RUN" : "LIVE",
      amountSol,
      strategy: t.strategy || null,
      binsBelow: t.bins_below ?? null,
      lowerBin: t.lower_bin ?? null,
      upperBin: t.upper_bin ?? null,
      entryBin: t.entry_bin ?? null,
      activeBin: t.active_bin ?? null,
      feeTvlRatio: t.fee_tvl_ratio ?? null,
      organicScore: t.organic_score ?? null,
      pnlSol,
      pnlPct,
      pnlUsd: pnlUsd != null ? Math.round(pnlUsd * 100) / 100 : null,
      reason: t.close_reason || (t.status === "open" ? "open" : null),
      deployTime: t.deploy_time || null,
      closeTime: t.close_time || null,
      minutesHeld,
    };
  });
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cache = {};
let _cacheTime = {};
const CACHE_TTL = 15000;

function cached(key, fn) {
  const now = Date.now();
  if (_cache[key] && now - _cacheTime[key] < CACHE_TTL) return _cache[key];
  const result = fn();
  _cache[key] = result;
  _cacheTime[key] = now;
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/status", async (req, res) => {
  try {
    const solPrice = await fetchSolPrice();
    const lines = getAllLogLines();
    const botInfo = extractBotInfo(lines);
    const state = readJSON(PATHS.state, {});
    const config = readJSON(PATHS.userConfig, {});
    const signals = readJSON(PATHS.signals, {});
    const positions = state.positions || {};
    const pnlSummary = calcPnlSummary(config, solPrice);
    const isDryRun = botInfo.mode !== "LIVE";

    res.json({
      ok: true,
      bot: {
        running: botInfo.isRunning,
        mode: botInfo.mode,
        model: botInfo.model,
        lastStartup: botInfo.lastActivity,
        agentId: config.agentId || null,
        screeningCount: botInfo.screeningCount,
      },
      wallet: {
        address: botInfo.wallet,
        solBalance: isDryRun ? pnlSummary.current : botInfo.solBalance,
        solPrice: solPrice,
        usdValue: Math.round((isDryRun ? pnlSummary.current : botInfo.solBalance) * solPrice * 100) / 100,
        simulated: isDryRun,
      },
      positions: {
        count: isDryRun ? pnlSummary.open : Object.keys(positions).length,
        active: positions,
      },
      signals: {
        weights: signals.weights || {},
        lastRecalc: signals.last_recalc || null,
        recalcCount: signals.recalc_count || 0,
      },
      tradeStats: (function() {
        return {
          total:    pnlSummary.total,
          open:     pnlSummary.open,
          wins:     pnlSummary.wins,
          losses:   pnlSummary.losses,
          winRate:  pnlSummary.winRate,
        };
      })(),
      simCapital: (function() {
        const dec = readJSON(PATHS.decisions, { decisions: [] });
        const daily = calcDailyPnl(dec.decisions || []);
        const totalPnlUsd = Object.values(daily).reduce((s, v) => s + v, 0);
        const initial = (config.maxDeployAmount || 40) * (config.maxPositions || 3);
        const totalPnlSol = solPrice > 0 ? totalPnlUsd / solPrice : 0;
        return {
          initial: pnlSummary.initial,
          current: pnlSummary.current,
          pnl:     pnlSummary.pnl,
          locked:  pnlSummary.locked,
          pnlUsd:  pnlSummary.pnlUsd,
          grossPnlUsd: pnlSummary.grossPnlUsd,
          costsUsd: pnlSummary.costsUsd,
          aiCostUsd: pnlSummary.aiCostUsd,
          txCostUsd: pnlSummary.txCostUsd,
          solPrice,
          mode:    botInfo.mode,
          lastUpdated: pnlSummary.lastUpdated,
        };
      })(),
      aiBudget: getAIBudgetStatus(config),
      lastUpdated: state.lastUpdated || null,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/pools", async (req, res) => {
  const solPrice = await fetchSolPrice();
  const lines  = getAllLogLines();
  const result = extractPoolsFromLog(lines);
  const toSol = (usd) => {
    if (usd == null || !Number.isFinite(usd)) return null;
    if (solPrice <= 0) return null;
    const sol = usd / solPrice;
    return sol < 1 ? sol.toFixed(3) + ' SOL' : sol.toFixed(2) + ' SOL';
  };
  const enrich = (p) => ({
    ...p,
    vol: p.vol_usd != null ? toSol(p.vol_usd) : p.vol ?? null,
    tvl: p.tvl_usd != null ? toSol(p.tvl_usd) : p.tvl ?? null,
  });
  res.json({
    ok: true,
    candidates: result.candidates.map(enrich),
    dropped:    result.dropped.map(enrich),
    total:      result.candidates.length,
    solPrice,
    ts:         new Date().toISOString(),
  });
});

app.get("/api/decisions", (req, res) => {
  const data = cached("decisions", () => {
    const dec = readJSON(PATHS.decisions, { decisions: [] });
    return {
      ok: true,
      decisions: (dec.decisions || []).slice(-20).reverse(),
      total: (dec.decisions || []).length,
      ts: new Date().toISOString(),
    };
  });
  res.json(data);
});

app.get("/api/ranking", (req, res) => {
  const db = readJSON(PATHS.rankingDb, { snapshots: [], rankingHistory: [], wallets: {}, meta: {} });
  const snapshots = db.snapshots || [];
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const entries = latest?.entries || [];
  res.json({
    ok: true,
    meta: db.meta || {},
    latest: latest ? {
      ts: latest.ts,
      mode: latest.mode,
      count: latest.count,
      entries,
    } : null,
    walletsTracked: Object.keys(db.wallets || {}).length,
    history: (db.rankingHistory || []).slice(-20).reverse(),
    ts: new Date().toISOString(),
  });
});

app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit || "100");
  const lines = getLatestLog();
  const parsed = lines.map(parseLogLine).filter(Boolean).slice(-limit).reverse();
  res.json({ ok: true, logs: parsed, total: lines.length, ts: new Date().toISOString() });
});

app.get("/api/pnl", async (req, res) => {
  const solPrice = await fetchSolPrice();
  const config = readJSON(PATHS.userConfig, {});
  const pnlSummary = calcPnlSummary(config, solPrice);
  const trades = getModeFilteredTrades(config);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "50", 10) || 50));
  const dec = readJSON(PATHS.decisions, { decisions: [] });
  const decisionDaily = calcDailyPnl(dec.decisions || []);
  const daily = Object.keys(pnlSummary.daily).length ? pnlSummary.daily : decisionDaily;
  const values = Object.values(daily);
  const total = Object.keys(pnlSummary.daily).length ? pnlSummary.pnlUsd : values.reduce((s, v) => s + v, 0);
  const best = values.length ? Math.max(...values) : 0;
  const worst = values.length ? Math.min(...values) : 0;
  const toSol = (usd) => solPrice > 0 ? usd / solPrice : 0;
  const dailySol = Object.fromEntries(Object.entries(daily).map(([d, v]) => [d, Math.round(toSol(v) * 10000) / 10000]));
  res.json({
    ok: true,
    daily: dailySol,
    dailyUsd: daily,
    trades: normalizeTradeHistory(trades, solPrice, limit),
    tradeTotal: trades.length,
    solPrice,
    summary: {
      total:       Math.round(toSol(total) * 10000) / 10000,
      best:        Math.round(toSol(best)  * 10000) / 10000,
      worst:       Math.round(toSol(worst) * 10000) / 10000,
      totalUsd:    Math.round(total * 100) / 100,
      costsUsd:    pnlSummary.costsUsd,
      aiCostUsd:   pnlSummary.aiCostUsd,
      txCostUsd:   pnlSummary.txCostUsd,
      tradingDays: values.filter((v) => v !== 0).length,
      open:        pnlSummary.open,
      lockedSol:   pnlSummary.locked,
      currentSol:  pnlSummary.current,
    },
    ts: new Date().toISOString(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "pool-dashboard-backend", ts: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      ok: true,
      message: "Pool Dashboard API running",
      endpoints: ["/api/status", "/api/pools", "/api/decisions", "/api/logs", "/api/pnl"],
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Pool Dashboard Backend — Ready     ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`\n  API   : http://localhost:${PORT}/api/status`);
  console.log(`  UI    : http://localhost:${PORT}`);
  console.log(`  BOT   : ${BOT_DIR}`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
