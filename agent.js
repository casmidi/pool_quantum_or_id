import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import fs from "fs";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "close_all_positions", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "run_ranking_cycle",
  "score_wallet",
  "score_wallet_advanced",
  "select_top_wallets",
  "run_copy_engine",
  "get_copy_signals",
  "fuse_wallet_data",
  "fuse_multiple_wallets",
  "get_provider_status",
  "get_top_performer_candidates",
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "close_all_positions", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  ranking:    new Set(["run_ranking_cycle", "score_wallet", "score_wallet_advanced", "select_top_wallets"]),
  copy:       new Set(["run_copy_engine", "get_copy_signals", "run_ranking_cycle", "select_top_wallets", "get_my_positions", "get_wallet_balance"]),
  fusion:     new Set(["fuse_wallet_data", "fuse_multiple_wallets", "get_provider_status", "get_top_performer_candidates"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "ranking",     re: /\b(rank|ranking|top wallet|score wallet|wallet score|leaderboard|top performer|best wallet|select wallet|wallet selection|strategy mode|scoring mode|conservative|aggressive|momentum|hybrid|profile)\b/i },
  { intent: "copy",        re: /\b(copy engine|copy.?trade|copy signal|copy signals|master wallet|top wallet positions?|follow wallet|follow position)\b/i },
  { intent: "fusion",      re: /\b(fuse|fusion|intelligence|aggregate wallet|provider status|top candidate|multi.?source|gmgn|dune|helius|birdeye|dexscreener)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { canCallAI, recordAIUsage } from "./ai-budget.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import { isEnabled as telegramEnabled, sendMessage } from "./telegram.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

// Ordered fallback chain — tries each model in order on 404/401/429/model-not-found.
// deepseek/deepseek-v4-flash:free is the primary choice: free, fast, good quality.
// Falls back through the openrouter/free router (auto-routes to any working free model)
// and then individual known-working models.
// openrouter/free is the most reliable fallback — it dynamically selects from available free models.
const MODEL_CHAIN = [
  process.env.LLM_MODEL || "deepseek/deepseek-v4-flash:free",
  "openrouter/free",
  "google/gemini-2.0-flash-lite:free",
  "deepseek/deepseek-chat:free",
].filter(Boolean);
const DEFAULT_MODEL = MODEL_CHAIN[0];
let lastAIBudgetTelegramWarn = 0;
let lastOpenRouterBudgetTelegramWarn = 0;
const AI_PROVIDER_ALERT_PATH = new URL("./data/ai_provider_alert.json", import.meta.url);

function getErrorMessage(error) {
  return String(error?.message || error?.error?.message || error?.response?.data?.error?.message || error || "");
}

function getOpenRouterBudgetReason(error) {
  const message = getErrorMessage(error);
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || error?.error?.code || "");
  if (
    status === 402 ||
    /\b(insufficient|not enough|exhausted|out of)\b.*\b(credit|credits|balance|budget|quota)\b/i.test(message) ||
    /\b(payment required|billing|quota exceeded|credits exhausted|insufficient credits)\b/i.test(message) ||
    /\b(insufficient_credits|quota_exceeded|billing)\b/i.test(code)
  ) {
    return `OpenRouter budget/credits blocked: ${message.slice(0, 240) || `HTTP ${status}`}`;
  }
  return null;
}

function writeAIProviderAlert(reason) {
  try {
    fs.mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
    fs.writeFileSync(AI_PROVIDER_ALERT_PATH, JSON.stringify({
      active: true,
      type: "openrouter_budget",
      reason,
      ts: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}
}

function notifyAIBudgetBlocked(reason) {
  const now = Date.now();
  if (now - lastAIBudgetTelegramWarn < 60 * 60 * 1000) return;
  lastAIBudgetTelegramWarn = now;
  if (!telegramEnabled()) return;
  sendMessage([
    "AI BUDGET WARNING",
    "",
    reason,
    "",
    "Bot masih hidup, tapi keputusan AI/deploy akan tertahan sampai budget/call cap direset atau setting dinaikkan.",
  ].join("\n")).catch(() => {});
}

function notifyOpenRouterBudgetBlocked(reason) {
  writeAIProviderAlert(reason);
  const now = Date.now();
  if (now - lastOpenRouterBudgetTelegramWarn < 60 * 60 * 1000) return;
  lastOpenRouterBudgetTelegramWarn = now;
  if (!telegramEnabled()) return;
  sendMessage([
    "OPENROUTER BUDGET WARNING",
    "",
    reason,
    "",
    "Bot masih hidup, tapi AI/deploy akan tertahan sampai credit/budget OpenRouter ditambah atau model/provider diganti.",
  ].join("\n")).catch(() => {});
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function completeAI({ model = null, agentType = "GENERAL", messages = [], maxTokens = 512, temperature = config.llm.temperature } = {}) {
  const activeModel = model || DEFAULT_MODEL;
  const budgetCheck = canCallAI({ model: activeModel, agentType });
  if (!budgetCheck.allowed) {
    log("ai_budget_warn", budgetCheck.reason);
    notifyAIBudgetBlocked(budgetCheck.reason);
    return {
      content: `AI paused by budget guard: ${budgetCheck.reason}`,
      budget_blocked: true,
    };
  }

  let response;
  try {
    response = await client.chat.completions.create({
      model: activeModel,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
  } catch (error) {
    const openRouterBudgetReason = getOpenRouterBudgetReason(error);
    if (openRouterBudgetReason) notifyOpenRouterBudgetBlocked(openRouterBudgetReason);
    throw error;
  }

  if (!response.choices?.length) {
    throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
  }
  recordAIUsage({ model: activeModel, agentType, usage: response.usage || {} });
  return {
    content: response.choices[0].message?.content || "",
    usage: response.usage || {},
    model: activeModel,
  };
}

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null, beforeToolCall = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position", "close_all_positions"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;
      const budgetCheck = canCallAI({ model: activeModel, agentType });
      if (!budgetCheck.allowed) {
        log("ai_budget_warn", budgetCheck.reason);
        notifyAIBudgetBlocked(budgetCheck.reason);
        return {
          content: `AI paused by budget guard: ${budgetCheck.reason}`,
          userMessage: goal,
          budget_blocked: true,
        };
      }

      // Retry with model fallback chain on transient errors or 404 (model not found)
      let usedModel = activeModel;
      let modelChainIndex = MODEL_CHAIN.indexOf(usedModel);
      if (modelChainIndex === -1) modelChainIndex = 0;
      let response;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      // Try up to 5 attempts with model fallback — if a model returns 404/not-found,
      // try the next in the chain instead of crashing.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          const openRouterBudgetReason = getOpenRouterBudgetReason(error);
          if (openRouterBudgetReason) notifyOpenRouterBudgetBlocked(openRouterBudgetReason);
          // Model not found (404) — try next in chain
          const errMsg = getErrorMessage(error);
          const isModelNotFound = errMsg.includes('404') || errMsg.includes('model not found') || errMsg.includes('not found') || error?.status === 404;
          
          if (isModelNotFound && modelChainIndex < MODEL_CHAIN.length - 1) {
            modelChainIndex++;
            usedModel = MODEL_CHAIN[modelChainIndex];
            log("agent", `Model ${MODEL_CHAIN[modelChainIndex - 1]} not found — falling back to ${usedModel}`);
            attempt -= 1; // don't count this as an attempt, retry with new model
            continue;
          } else if (isModelNotFound) {
            log("error", `All ${MODEL_CHAIN.length} models exhausted — last error: ${errMsg}`);
            throw new Error(`All models exhausted: ${errMsg}`);
          }
          
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          // For other errors (auth, rate limit, etc.), try next model in chain
          if (modelChainIndex < MODEL_CHAIN.length - 1) {
            modelChainIndex++;
            usedModel = MODEL_CHAIN[modelChainIndex];
            log("agent", `Model ${MODEL_CHAIN[modelChainIndex - 1]} error: ${errMsg.slice(0, 80)} — falling back to ${usedModel}`);
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529 || errCode === 404) {
          const wait = (attempt + 1) * 3000;
          // Try next model in chain for server errors too
          if (modelChainIndex < MODEL_CHAIN.length - 1) {
            modelChainIndex++;
            usedModel = MODEL_CHAIN[modelChainIndex];
            log("agent", `HTTP ${errCode} — falling back to ${usedModel}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/5)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      recordAIUsage({ model: usedModel, agentType, usage: response.usage || {} });
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        if (beforeToolCall) {
          const gate = await beforeToolCall({ name: functionName, args: functionArgs, step });
          if (gate?.allowed === false) {
            const result = {
              success: false,
              blocked: true,
              reason: gate.reason || `${functionName} blocked by pre-tool gate`,
            };
            log("agent", `Blocked ${functionName}: ${result.reason}`);
            await onToolFinish?.({ name: functionName, args: functionArgs, result, success: false, step });
            if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      const openRouterBudgetReason = getOpenRouterBudgetReason(error);
      if (openRouterBudgetReason) notifyOpenRouterBudgetBlocked(openRouterBudgetReason);
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
