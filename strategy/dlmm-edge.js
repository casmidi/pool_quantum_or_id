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

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function estimateDailyNetEv(pool, timeframe = "30m") {
  const feeRatio = num(pool?.fee_active_tvl_ratio ?? pool?.fee_tvl_ratio, 0);
  const tfMins = TIMEFRAME_MINUTES[timeframe] ?? TIMEFRAME_MINUTES["30m"];
  const periodsPerDay = 1440 / tfMins;
  const dailyFeeYieldPct = feeRatio * periodsPerDay * 100;

  const binStep = num(pool?.bin_step, 80);
  const volatility = num(pool?.volatility, 0);
  const activePct = num(pool?.active_pct, 0);
  const priceChange = Math.abs(num(pool?.price_change_pct, 0));

  const binStepIL = Math.max(0, (binStep / 10000) * 200);
  const volIL = volatility * 0.4;
  const driftIL = Math.max(0, priceChange - 6) * 0.08;
  const lowActivePenalty = activePct > 0 && activePct < 45 ? (45 - activePct) * 0.025 : 0;
  const dailyILEstimatePct = binStepIL + volIL + driftIL + lowActivePenalty;

  return {
    daily_fee_yield_pct: Number(dailyFeeYieldPct.toFixed(4)),
    daily_il_estimate_pct: Number(dailyILEstimatePct.toFixed(4)),
    net_ev_pct: Number((dailyFeeYieldPct - dailyILEstimatePct).toFixed(4)),
  };
}

export function planDlmmEntry(pool, config) {
  const minBins = Math.max(35, num(config?.strategy?.minBinsBelow, 35));
  const maxBins = Math.max(minBins, num(config?.strategy?.maxBinsBelow, 69));
  const volatility = num(pool?.volatility, 0);
  const binStep = num(pool?.bin_step, 80);
  const activePct = num(pool?.active_pct, 0);
  const priceChange = num(pool?.price_change_pct, 0);
  const feeRatio = num(pool?.fee_active_tvl_ratio ?? pool?.fee_tvl_ratio, 0);
  const ev = estimateDailyNetEv(pool, config?.screening?.timeframe || "30m");

  const volComponent = clamp(volatility / 5, 0, 1);
  const binStepComponent = clamp((binStep - 80) / 45, 0, 1) * 0.2;
  const downsideDriftComponent = priceChange < 0 ? clamp(Math.abs(priceChange) / 12, 0, 1) * 0.18 : 0;
  const lowActiveComponent = activePct > 0 && activePct < 45 ? clamp((45 - activePct) / 20, 0, 1) * 0.15 : 0;
  const rawWidth = volComponent + binStepComponent + downsideDriftComponent + lowActiveComponent;
  const binsBelow = Math.round(clamp(minBins + rawWidth * (maxBins - minBins), minBins, maxBins));

  let regime = "balanced_fee_harvest";
  if (volatility >= 3 || Math.abs(priceChange) >= 8) regime = "wide_defensive_bid_ask";
  else if (feeRatio >= 0.06 && activePct >= 55 && volatility <= 2) regime = "tight_fee_capture";

  const warnings = [];
  if (activePct > 0 && activePct < 45) warnings.push("active liquidity is thin; require extra fee edge");
  if (priceChange > 10) warnings.push("price already extended upward; avoid chasing near local highs");
  if (priceChange < -10) warnings.push("falling price; range widened to avoid catching too shallow");
  if (ev.net_ev_pct < num(config?.screening?.minNetEVPct, 0)) warnings.push("projected net EV below configured minimum");

  return {
    strategy: "bid_ask",
    bins_below: binsBelow,
    bins_above: 0,
    regime,
    projected: ev,
    warnings,
  };
}
