import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { applyPoolCooldown, recordPoolDeploy } from "../pool-memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pnlPath = path.join(rootDir, "data", "pnl_log.json");
const memoryPath = path.join(rootDir, "pool-memory.json");

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const pnl = loadJson(pnlPath, { trades: [] });
const memory = loadJson(memoryPath, {});
const existing = new Set();

for (const [pool, entry] of Object.entries(memory)) {
  for (const deploy of entry?.deploys ?? []) {
    existing.add(`${pool}|${deploy.deployed_at}|${deploy.closed_at}`);
  }
}

let imported = 0;
let skipped = 0;
let cooldowns = 0;

for (const trade of pnl.trades ?? []) {
  if (trade.status !== "closed" || !trade.pool_address || trade.pnl_pct == null) continue;

  const key = `${trade.pool_address}|${trade.deploy_time}|${trade.close_time}`;
  if (existing.has(key)) {
    skipped++;
    continue;
  }

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
    strategy: trade.is_dry_run ? "dry_run" : null,
    bin_step: trade.bin_step,
    volatility: trade.volatility,
    fee_tvl_ratio: trade.fee_tvl_ratio,
    organic_score: trade.organic_score,
  });
  existing.add(key);
  imported++;

  if (config.management.lossTriggeredCooldown) {
    const threshold = config.management.lossCooldownThresholdPct ?? -15;
    if (Number.isFinite(trade.pnl_pct) && trade.pnl_pct < threshold) {
      const severity = Math.min(4, Math.ceil(Math.abs(trade.pnl_pct) / Math.abs(threshold)));
      const cooldownHrs = (config.management.lossCooldownHours ?? 6) * severity;
      if (applyPoolCooldown(trade.pool_address, cooldownHrs, `backfill_loss: pnl=${trade.pnl_pct.toFixed(1)}%`)) {
        cooldowns++;
      }
    }
  }
}

console.log(JSON.stringify({ imported, skipped, cooldowns }, null, 2));
