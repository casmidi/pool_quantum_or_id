import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { log } from "./logger.js";

const DATA_DIR = "./data";
const USAGE_FILE = path.join(DATA_DIR, "ai_usage.json");

const MODEL_PRICING = [
  { match: /minimax\/minimax-m2\.5/i, inputPer1M: 0.15, outputPer1M: 1.15 },
  { match: /minimax\/minimax-m2\.7/i, inputPer1M: 0.279, outputPer1M: 1.20 },
  { match: /anthropic\/claude-haiku-4\.5/i, inputPer1M: 1.00, outputPer1M: 5.00 },
  { match: /anthropic\/claude-sonnet-4\.[56]/i, inputPer1M: 3.00, outputPer1M: 15.00 },
  { match: /:free$/i, inputPer1M: 0, outputPer1M: 0 },
];

function emptyStore() {
  return { days: {}, months: {}, calls: [] };
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USAGE_FILE)) return emptyStore();
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return emptyStore();
  }
}

function save(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2));
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function bucket(store, key, type) {
  if (!store[type][key]) {
    store[type][key] = {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
  }
  return store[type][key];
}

function pricingFor(model) {
  const name = String(model || "");
  return MODEL_PRICING.find((p) => p.match.test(name)) || {
    inputPer1M: config.llm.defaultInputPricePer1M,
    outputPer1M: config.llm.defaultOutputPricePer1M,
  };
}

export function estimateAICost(model, usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const pricing = pricingFor(model);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output) || input + output,
    cost_usd: (input / 1_000_000) * pricing.inputPer1M + (output / 1_000_000) * pricing.outputPer1M,
    input_price_per_1m: pricing.inputPer1M,
    output_price_per_1m: pricing.outputPer1M,
  };
}

export function canCallAI({ model, agentType = "GENERAL" } = {}) {
  const store = load();
  const dKey = dayKey();
  const mKey = monthKey();
  const day = bucket(store, dKey, "days");
  const month = bucket(store, mKey, "months");
  const dailyBudget = Number(config.llm.dailyBudgetUsd);
  const monthlyBudget = Number(config.llm.monthlyBudgetUsd);
  const maxDailyCalls = Number(config.llm.maxCallsPerDay);

  if (Number.isFinite(monthlyBudget) && monthlyBudget > 0 && month.cost_usd >= monthlyBudget) {
    return { allowed: false, reason: `AI monthly budget reached: $${month.cost_usd.toFixed(4)} >= $${monthlyBudget}`, day, month };
  }
  if (Number.isFinite(dailyBudget) && dailyBudget > 0 && day.cost_usd >= dailyBudget) {
    return { allowed: false, reason: `AI daily budget reached: $${day.cost_usd.toFixed(4)} >= $${dailyBudget}`, day, month };
  }
  if (Number.isFinite(maxDailyCalls) && maxDailyCalls > 0 && day.calls >= maxDailyCalls) {
    return { allowed: false, reason: `AI daily call cap reached: ${day.calls} >= ${maxDailyCalls}`, day, month };
  }
  return { allowed: true, model, agentType, day, month };
}

export function recordAIUsage({ model, agentType = "GENERAL", usage = {} } = {}) {
  const store = load();
  const dKey = dayKey();
  const mKey = monthKey();
  const estimated = estimateAICost(model, usage);

  for (const target of [bucket(store, dKey, "days"), bucket(store, mKey, "months")]) {
    target.calls += 1;
    target.input_tokens += estimated.input_tokens;
    target.output_tokens += estimated.output_tokens;
    target.total_tokens += estimated.total_tokens;
    target.cost_usd = Math.round((target.cost_usd + estimated.cost_usd) * 1_000_000) / 1_000_000;
  }

  store.calls.push({
    ts: new Date().toISOString(),
    model,
    agentType,
    ...estimated,
    cost_usd: Math.round(estimated.cost_usd * 1_000_000) / 1_000_000,
  });
  if (store.calls.length > 500) store.calls = store.calls.slice(-500);
  save(store);

  log(
    "ai_cost",
    `${agentType} ${model}: in=${estimated.input_tokens}, out=${estimated.output_tokens}, cost=$${estimated.cost_usd.toFixed(6)} | today=$${bucket(store, dKey, "days").cost_usd.toFixed(4)}, month=$${bucket(store, mKey, "months").cost_usd.toFixed(4)}`
  );
  return estimated;
}

export function getAIUsageSummary() {
  const store = load();
  return {
    today: bucket(store, dayKey(), "days"),
    month: bucket(store, monthKey(), "months"),
  };
}
