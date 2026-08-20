import {
  CONTRIBUTOR_RULES,
  KNOWN_AI_AGENT_LOGINS,
  KNOWN_BOT_LOGINS,
} from "../config";
import type { ContributorStat, ContributorWeek } from "../sources/github";
import type { ActivityMetrics, ContributorMetrics, ContributorType } from "../types";

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;

/**
 * Classifies a contributor account (spec 7).
 *
 * Only high-confidence signals are used. An account is never inferred to be an
 * AI agent from its commit content or style: spec 7.4 is explicit that a human
 * who generated their code with an AI assistant stays HUMAN_OR_UNKNOWN, because
 * guessing would both misrepresent people and make the metric unfalsifiable.
 */
export function classifyContributor(
  login: string,
  accountType: string | null,
): ContributorType {
  const normalized = login.toLowerCase();
  const bare = normalized.replace(/\[bot\]$/, "");

  if (KNOWN_AI_AGENT_LOGINS.includes(bare)) return "KNOWN_AI_AGENT";
  if (normalized.endsWith("[bot]")) return "BOT";
  if (accountType?.toLowerCase() === "bot") return "BOT";
  if (KNOWN_BOT_LOGINS.includes(bare)) return "BOT";
  return "HUMAN_OR_UNKNOWN";
}

type Classified = {
  login: string;
  type: ContributorType;
  commits90d: number;
  commits365d: number;
  activeWeeks365d: number;
  totalCommits: number;
};

function commitsInWindow(weeks: ContributorWeek[], fromSec: number, toSec: number): number {
  let total = 0;
  for (const week of weeks) {
    if (week.w >= fromSec && week.w < toSec) total += week.c;
  }
  return total;
}

function activeWeeksInWindow(weeks: ContributorWeek[], fromSec: number): number {
  let count = 0;
  for (const week of weeks) {
    if (week.w >= fromSec && week.c > 0) count += 1;
  }
  return count;
}

/**
 * Derives contributor and activity metrics from GitHub's weekly contributor
 * statistics.
 *
 * Windows are aligned to GitHub's week buckets (Sunday 00:00 UTC), so a
 * "90 day" figure is the sum of the week buckets that start within the last 90
 * days. That is an approximation of a rolling window and is deliberate: the
 * weekly buckets are the only granularity the endpoint offers, and using them
 * keeps the whole analysis inside one request (spec 20.3).
 */
export function computeContributorMetrics(
  stats: ContributorStat[],
  now: Date,
): { contributors: ContributorMetrics; activity: Omit<ActivityMetrics, "lastCommitAt"> } {
  const nowSec = Math.floor(now.getTime() / 1000);
  const from90 = nowSec - CONTRIBUTOR_RULES.activeWindowDays * 86_400;
  const from365 = nowSec - CONTRIBUTOR_RULES.longWindowDays * 86_400;
  const from30 = nowSec - 30 * 86_400;
  const fromPrev90 = from90 - CONTRIBUTOR_RULES.activeWindowDays * 86_400;

  const classified: Classified[] = stats.map((stat) => ({
    login: stat.login,
    type: classifyContributor(stat.login, stat.accountType),
    commits90d: commitsInWindow(stat.weeks, from90, nowSec + WEEK_SECONDS),
    commits365d: commitsInWindow(stat.weeks, from365, nowSec + WEEK_SECONDS),
    activeWeeks365d: activeWeeksInWindow(stat.weeks, from365),
    totalCommits: stat.total,
  }));

  const humans = classified.filter((c) => c.type === "HUMAN_OR_UNKNOWN");

  // Spec 6.2 / 6.3 / 6.5.
  const active90 = classified.filter((c) => c.commits90d >= 1);
  const active365 = classified.filter((c) => c.commits365d >= 1);
  const isRepeat = (c: Classified) =>
    c.commits365d >= CONTRIBUTOR_RULES.repeatMinCommits ||
    c.activeWeeks365d >= CONTRIBUTOR_RULES.repeatMinActiveWeeks;
  const repeat365 = active365.filter(isRepeat);

  // Spec 6.4: active in the last year, repeating, and not automation.
  const effective = classified.filter(
    (c) => c.commits365d >= 1 && isRepeat(c) && c.type === "HUMAN_OR_UNKNOWN",
  );

  // Spec 6.5.
  const core = classified.filter(
    (c) =>
      c.commits365d >= CONTRIBUTOR_RULES.coreMinCommits &&
      c.activeWeeks365d >= CONTRIBUTOR_RULES.coreMinActiveWeeks &&
      c.type === "HUMAN_OR_UNKNOWN",
  );

  // Spec 8: concentration excludes bots and known agents from both numerator
  // and denominator, so automated commit volume cannot mask or manufacture
  // maintainer concentration.
  const humanCommits365 = humans
    .map((c) => c.commits365d)
    .sort((a, b) => b - a);
  const humanTotal365 = humanCommits365.reduce((sum, n) => sum + n, 0);
  const shareOfTop = (n: number): number | null => {
    if (humanTotal365 <= 0) return null;
    const top = humanCommits365.slice(0, n).reduce((sum, c) => sum + c, 0);
    return top / humanTotal365;
  };

  const oneShot = humans.filter((c) => c.totalCommits === 1).length;

  const contributors: ContributorMetrics = {
    rawContributors: classified.length,
    active90d: active90.length,
    active365d: active365.length,
    repeat365d: repeat365.length,
    effectiveContributors: effective.length,
    coreMaintainers: core.length,
    botContributors: classified.filter((c) => c.type === "BOT").length,
    knownAiAgents: classified.filter((c) => c.type === "KNOWN_AI_AGENT").length,
    humanUnknown: humans.length,
    oneShotRatio: humans.length > 0 ? oneShot / humans.length : null,
    top1Share: shareOfTop(1),
    top3Share: shareOfTop(3),
    top5Share: shareOfTop(5),
  };

  const allWeeks = stats.flatMap((s) => s.weeks);
  const activity = {
    commits30d: commitsInWindow(allWeeks, from30, nowSec + WEEK_SECONDS),
    commits90d: commitsInWindow(allWeeks, from90, nowSec + WEEK_SECONDS),
    commits365d: commitsInWindow(allWeeks, from365, nowSec + WEEK_SECONDS),
    commitsPrev90d: commitsInWindow(allWeeks, fromPrev90, from90),
    activeWeeks365d: countRepositoryActiveWeeks(allWeeks, from365),
  };

  return { contributors, activity };
}

/** Weeks in which the repository as a whole saw at least one commit. */
function countRepositoryActiveWeeks(weeks: ContributorWeek[], fromSec: number): number {
  const perWeek = new Map<number, number>();
  for (const week of weeks) {
    if (week.w < fromSec) continue;
    perWeek.set(week.w, (perWeek.get(week.w) ?? 0) + week.c);
  }
  let active = 0;
  for (const total of perWeek.values()) if (total > 0) active += 1;
  return active;
}

/** Fallback activity numbers when contributor statistics are still pending. */
export function computeActivityFromCommitWeeks(
  weeks: ContributorWeek[],
  now: Date,
): Omit<ActivityMetrics, "lastCommitAt"> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const upper = nowSec + WEEK_SECONDS;
  return {
    commits30d: commitsInWindow(weeks, nowSec - 30 * 86_400, upper),
    commits90d: commitsInWindow(weeks, nowSec - 90 * 86_400, upper),
    commits365d: commitsInWindow(weeks, nowSec - 365 * 86_400, upper),
    commitsPrev90d: commitsInWindow(weeks, nowSec - 180 * 86_400, nowSec - 90 * 86_400),
    activeWeeks365d: countRepositoryActiveWeeks(weeks, nowSec - 365 * 86_400),
  };
}

export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now.getTime() - then) / DAY_MS);
}
