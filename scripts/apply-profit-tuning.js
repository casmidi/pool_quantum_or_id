import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "user-config.json");

const tuning = {
  maxDeployVolatility: 3.5,
  maxOorRatioForRedeploy: 0.6,
  minPoolWinRate: 50,
  minPoolScore: 72,
  blockDevSoldAll: true,
  failOpenOnRiskDataUnavailable: false,
  failOpenOnAthDataUnavailable: false,
  failClosedOnMissingRiskMetrics: true,
  blockNegativeEV: true,
  minNetEVPct: 0.1,
  volatilityPositionScaling: true,
  lossTriggeredCooldown: true,
  lossCooldownThresholdPct: -3,
  lossCooldownHours: 8,
  poolQualityPositionScaling: true,
  feeYieldPositionScaling: false,
  maxDailyLossUsd: -3,
  maxConsecutiveOorCloses: 2,
  minOrganic: 70,
  minQuoteOrganic: 60,
  minFeeActiveTvlRatio: 0.035,
  minVolumeTvlRatio: 0.04,
  minActivePct: 35,
  maxAbsPriceChangePct: 12,
  minFeeChangePct: -35,
  minVolumeChangePct: -40,
  maxTokenAgeHours: 168,
  athFilterPct: -20,
  positionSizePct: 0.25,
  deployAmountSol: 0.3,
  aiMonthlyBudgetUsd: 8,
  aiDailyBudgetUsd: 0.25,
  aiMaxCallsPerDay: 20,
  aiHealthCheckEnabled: false,
  aiHybridReviewEnabled: true,
  aiReviewModel: "anthropic/claude-haiku-4.5",
  aiReviewMinPoolScore: 72,
  aiReviewMaxPerCycle: 1,
  aiReviewMaxTokens: 384,
  estimatedRoundTripTxCostUsd: 0.04,
  includeAICostInNetPnl: true,
  maxSteps: 8,
  maxTokens: 2048,
};

const current = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

const next = { ...current, ...tuning };
fs.writeFileSync(configPath, JSON.stringify(next, null, 2));

console.log(JSON.stringify({ applied: tuning, preserved: {
  dryRun: next.dryRun,
  screeningModel: next.screeningModel,
  managementModel: next.managementModel,
  generalModel: next.generalModel,
  dry_run_wallet: next.dry_run_wallet,
}}, null, 2));
