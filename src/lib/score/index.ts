import { ALGORITHM_VERSION, CATEGORY_ORDER, CATEGORY_WEIGHTS, SCORE_BANDS } from "../config";
import type {
  ActivityMetrics,
  CategoryResult,
  ContributorMetrics,
  IssuePrMetrics,
  ReleaseMetrics,
  RepositoryBasic,
  ScoreResult,
  SecurityMetrics,
  Signal,
} from "../types";
import {
  scoreAdoption,
  scoreCommunity,
  scoreMaintenance,
  scoreRelease,
  scoreSecurity,
} from "./categories";
import { round } from "./ladders";
import { computeStatusLabel } from "./status";

export type ScoreInput = {
  basic: RepositoryBasic;
  contributors: ContributorMetrics | null;
  activity: ActivityMetrics | null;
  issuePr: IssuePrMetrics | null;
  release: ReleaseMetrics | null;
  security: SecurityMetrics | null;
  now: Date;
};

export function bandFor(score: number): string {
  for (const band of SCORE_BANDS) {
    if (score >= band.min) return band.label;
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1]!.label;
}

/**
 * Combines the five category scores into the overall Health Score.
 *
 * The important property is spec 9.3: a missing category is excluded and the
 * remaining weights are renormalised, never treated as zero. Treating "OpenSSF
 * has not scanned this repository" as a 0/100 security score would make the
 * overall number say something the data does not support. Coverage is reported
 * alongside the score so a 86/45% is never mistaken for an 86/95% (spec 27).
 */
export function computeScore(input: ScoreInput): ScoreResult {
  const categories: Record<string, CategoryResult> = {
    maintenance: scoreMaintenance(input.basic, input.activity, input.issuePr, input.now),
    community_resilience: scoreCommunity(input.contributors),
    security_hygiene: scoreSecurity(input.security),
    release_health: scoreRelease(input.release),
    adoption: scoreAdoption(input.basic),
  };

  let weightedTotal = 0;
  let availableWeight = 0;
  for (const key of CATEGORY_ORDER) {
    const category = categories[key]!;
    const weight = CATEGORY_WEIGHTS[key];
    if (!category.available || category.score === null) continue;
    weightedTotal += category.score * weight;
    availableWeight += weight;
  }

  const healthScore = availableWeight > 0 ? round(weightedTotal / availableWeight) : null;

  return {
    healthScore,
    coverage: availableWeight,
    statusLabel: computeStatusLabel({
      basic: input.basic,
      activity: input.activity,
      release: input.release,
      issuePr: input.issuePr,
      now: input.now,
    }),
    categories: categories as ScoreResult["categories"],
    headlineSignals: pickHeadlineSignals(categories as ScoreResult["categories"]),
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/**
 * The first view shows a handful of signals rather than the total alone
 * (spec 16.2). Warnings come first: a reader who scrolls no further should see
 * the concerns, not a curated set of positives.
 */
function pickHeadlineSignals(categories: ScoreResult["categories"]): Signal[] {
  const all: Signal[] = [];
  for (const key of CATEGORY_ORDER) {
    all.push(...categories[key].signals);
  }
  const rank = (signal: Signal): number =>
    signal.type === "negative" ? 0 : signal.type === "warning" ? 1 : signal.type === "positive" ? 2 : 3;
  return [...all].sort((a, b) => rank(a) - rank(b)).slice(0, 5);
}
