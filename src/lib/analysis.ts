import { CONTRIBUTOR_RULES, GITHUB_REQUEST_BUDGET } from "./config";
import { CircuitOpenError, TimeoutError } from "./http";
import {
  activityFromAggregation,
  computeActivityFromCommitWeeks,
  computeContributorMetrics,
  computeContributorMetricsFromCommitters,
} from "./metrics/contributors";
import { computeReleaseMetrics } from "./metrics/release";
import { computeScore } from "./score";
import { resolvePackageMapping } from "./sources/depsdev";
import { fetchIssuePrMetrics } from "./sources/ecosystems";
import { fetchCommitAggregation } from "./sources/ecosystems-commits";
import {
  GithubClient,
  GithubRateLimitedError,
  RepositoryNotFoundError,
} from "./sources/github";
import { fetchScorecard } from "./sources/openssf";
import {
  bumpCounters,
  createAnalysis,
  finishAnalysis,
  heartbeatLock,
  loadAnalysis,
  saveMetrics,
  setAnalysisStatus,
  tryAcquireLock,
  upsertRepository,
} from "./store";
import type {
  ActivityMetrics,
  Diagnostics,
  AnalysisRecord,
  ContributorMetrics,
  Freshness,
  IssuePrMetrics,
  ReleaseMetrics,
  RepoRef,
  SecurityMetrics,
  SourceName,
} from "./types";

export class AnalysisLockedError extends Error {
  constructor(readonly analysisId: string) {
    super("An analysis for this repository is already running.");
    this.name = "AnalysisLockedError";
  }
}

function newAnalysisId(): string {
  return `ana_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Runs the basic stage synchronously and returns as soon as the basic card can
 * be rendered (spec 17.1 / 19.1). The health stage continues afterwards through
 * `waitUntil`, and the client polls the analysis id for the rest.
 */
export async function startAnalysis(args: {
  db: D1Database;
  token: string;
  ref: RepoRef;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<AnalysisRecord> {
  const { db, ref } = args;
  const now = new Date();
  const nowMs = now.getTime();
  const github = new GithubClient(args.token);

  // Basic metadata first: without it there is no repository row to lock on,
  // and a nonexistent repository must fail before anything else is spent.
  const { basic, fetchedAt } = await github.getRepository(ref);
  const repositoryId = await upsertRepository(db, basic, fetchedAt);

  const lock = await tryAcquireLock(db, repositoryId, nowMs);
  if (!lock.acquired && lock.existingAnalysisId) {
    const existing = await loadAnalysis(db, lock.existingAnalysisId);
    if (existing) return existing;
  }

  const analysisId = lock.existingAnalysisId ?? newAnalysisId();
  if (!lock.existingAnalysisId) {
    await createAnalysis(db, {
      analysisId,
      repositoryId,
      startedAt: now.toISOString(),
      nowMs,
    });
  }
  await setAnalysisStatus(db, analysisId, "FETCHING_BASIC", {
    basicReadyAt: new Date().toISOString(),
  });

  args.waitUntil(
    runHealthStage({ db, github, ref, analysisId, basic, githubFetchedAt: fetchedAt }).catch(
      async (error) => {
        // A failed health stage must not leave the row locked forever.
        await finishAnalysis(db, {
          analysisId,
          status: "FAILED",
          scores: null,
          freshness: { github: fetchedAt },
          unavailable: ["ecosystems", "openssf", "deps_dev"],
          diagnostics: {
            health_stage: {
              outcome: "error",
              detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
            },
          },
          completedAt: new Date().toISOString(),
        }).catch(() => undefined);
        console.error("health stage failed", { analysisId, error });
      },
    ),
  );

  const record = await loadAnalysis(db, analysisId);
  if (!record) throw new Error("analysis row disappeared immediately after creation");
  return record;
}

type HealthStageArgs = {
  db: D1Database;
  github: GithubClient;
  ref: RepoRef;
  analysisId: string;
  basic: Awaited<ReturnType<GithubClient["getRepository"]>>["basic"];
  githubFetchedAt: string;
};

/**
 * Level 2 (spec 4). Every source is optional: a failure degrades the result to
 * PARTIAL with the category marked unavailable, and never fails the page
 * (spec 21.4 / 28).
 */
async function runHealthStage(args: HealthStageArgs): Promise<void> {
  const { db, github, ref, analysisId, basic } = args;
  const now = new Date();
  const freshness: Freshness = { github: args.githubFetchedAt };
  const unavailable: SourceName[] = [];
  const diagnostics: Diagnostics = {};

  const note = (
    source: string,
    settled: PromiseSettledResult<unknown>,
    outcome: "ok" | "empty" | "pending" | "too_large" = "ok",
  ): void => {
    diagnostics[source] =
      settled.status === "rejected"
        ? {
            outcome: "error",
            detail:
              settled.reason instanceof Error
                ? `${settled.reason.name}: ${settled.reason.message}`
                : String(settled.reason),
          }
        : { outcome };
  };

  await setAnalysisStatus(db, analysisId, "FETCHING_ACTIVITY");
  await heartbeatLock(db, analysisId, Date.now());

  const [
    commitAggResult,
    commitActivityResult,
    statsResult,
    releasesResult,
    issuePrResult,
    scorecardResult,
    mappingResult,
  ] = await Promise.allSettled([
    // Primary contributor source: pre-aggregated, bounded in size.
    fetchCommitAggregation(ref),
    // Repository-level weekly commit totals: ~2 KB regardless of repo size.
    github.getCommitActivity(ref),
    // Higher-fidelity contributor data, used only if it is cheap to read.
    github.getContributorStats(ref),
    github.getReleases(ref, CONTRIBUTOR_RULES.releaseSampleSize + 4),
    fetchIssuePrMetrics(ref),
    fetchScorecard(ref),
    resolvePackageMapping(ref),
  ]);

  await setAnalysisStatus(db, analysisId, "FETCHING_SECURITY");
  await heartbeatLock(db, analysisId, Date.now());

  note("ecosystems_commits", commitAggResult,
    commitAggResult.status === "fulfilled" && commitAggResult.value === null ? "empty" : "ok");
  note("github_commit_activity", commitActivityResult,
    commitActivityResult.status === "fulfilled" && commitActivityResult.value.weeks === null
      ? "pending"
      : "ok");
  note("github_contributor_stats", statsResult,
    statsResult.status === "fulfilled"
      ? statsResult.value.tooLarge
        ? "too_large"
        : statsResult.value.pending
          ? "pending"
          : "ok"
      : "ok");
  note("github_releases", releasesResult);
  note("ecosystems_issues", issuePrResult,
    issuePrResult.status === "fulfilled" && issuePrResult.value === null ? "empty" : "ok");
  note("openssf", scorecardResult,
    scorecardResult.status === "fulfilled" && scorecardResult.value === null ? "empty" : "ok");
  note("deps_dev", mappingResult,
    mappingResult.status === "fulfilled" && !mappingResult.value.confident ? "empty" : "ok");
  if (mappingResult.status === "fulfilled" && !mappingResult.value.confident) {
    diagnostics.deps_dev = { outcome: "empty", detail: mappingResult.value.reason };
  }

  // ---- Activity (repository level) ----
  let activity: ActivityMetrics | null = null;
  if (commitActivityResult.status === "fulfilled" && commitActivityResult.value.weeks) {
    activity = {
      ...computeActivityFromCommitWeeks(commitActivityResult.value.weeks, now),
      lastCommitAt: basic.pushedAt,
    };
    freshness.github = commitActivityResult.value.fetchedAt;
  } else if (commitActivityResult.status === "rejected") {
    logSourceFailure("github commit_activity", commitActivityResult.reason);
  }

  // ---- Contributors ----
  let contributors: ContributorMetrics | null = null;
  let statsTooLarge = false;
  let statsPending = false;

  if (statsResult.status === "fulfilled") {
    statsTooLarge = statsResult.value.tooLarge;
    statsPending = statsResult.value.pending;
    if (statsResult.value.stats) {
      // Full fidelity: weekly buckets and GitHub account types.
      const computed = computeContributorMetrics(statsResult.value.stats, now);
      contributors = computed.contributors;
      // These weekly figures are per-contributor and therefore more precise
      // than the repository-level fallback, so they win when both exist.
      activity = { ...computed.activity, lastCommitAt: basic.pushedAt };
      freshness.github = statsResult.value.fetchedAt;
    }
    if (statsTooLarge) {
      console.warn("github stats/contributors too large; using ecosyste.ms commits", {
        analysisId,
        bytes: statsResult.value.bytes,
      });
    }
  } else {
    logSourceFailure("github stats/contributors", statsResult.reason);
  }

  const aggregation =
    commitAggResult.status === "fulfilled" ? commitAggResult.value : null;
  if (commitAggResult.status === "rejected") {
    logSourceFailure("commits.ecosyste.ms", commitAggResult.reason);
  }

  if (contributors && aggregation?.totalCommitters !== null && aggregation !== null) {
    // GitHub's stats/contributors returns only the top 100 contributors, so its
    // "raw" count silently saturates at 100 — measured 2026-08-20, 8 of 30
    // well-known repositories reported exactly 100 while ecosyste.ms reported
    // the real totals (curl 1516, rust-lang/rust 7723). Presenting a capped
    // figure next to uncapped ones would make the number meaningless, so the
    // true total wins whenever it is available.
    contributors = { ...contributors, rawContributors: aggregation.totalCommitters };
  }

  if (!contributors && aggregation) {
    // GitHub account types are only available when the statistics call
    // succeeded; without them classification falls back to commit metadata.
    const githubBots = new Set<string>();
    contributors = computeContributorMetricsFromCommitters(aggregation, githubBots).contributors;
    freshness.ecosystems = aggregation.sourceUpdatedAt ?? aggregation.fetchedAt;
  }

  // Last resort for activity: a past-year total with no shorter windows beats an
  // empty Activity card, as long as the missing windows read as N/A.
  if (!activity && aggregation) {
    activity = { ...activityFromAggregation(aggregation), lastCommitAt: basic.pushedAt };
    freshness.ecosystems = aggregation.sourceUpdatedAt ?? aggregation.fetchedAt;
  }

  // ---- Releases ----
  let release: ReleaseMetrics | null = null;
  if (releasesResult.status === "fulfilled") {
    release = computeReleaseMetrics(releasesResult.value.releases, now);
  } else {
    logSourceFailure("github releases", releasesResult.reason);
  }

  // ---- Issue / PR aggregation (ecosyste.ms) ----
  let issuePr: IssuePrMetrics | null = null;
  if (issuePrResult.status === "fulfilled" && issuePrResult.value) {
    issuePr = issuePrResult.value.issuePr;
    freshness.ecosystems = issuePrResult.value.sourceUpdatedAt ?? issuePrResult.value.fetchedAt;
  } else {
    unavailable.push("ecosystems");
    if (issuePrResult.status === "rejected") {
      logSourceFailure("ecosyste.ms", issuePrResult.reason);
    }
  }

  // ---- Security ----
  const security: SecurityMetrics = {
    openssfScore: null,
    openssfChecks: [],
    openssfDate: null,
    licensePresent: basic.license !== null,
    depsDataAvailable: false,
    vulnerabilityCount: null,
  };
  if (scorecardResult.status === "fulfilled" && scorecardResult.value) {
    security.openssfScore = scorecardResult.value.score;
    security.openssfChecks = scorecardResult.value.checks;
    security.openssfDate = scorecardResult.value.date;
    freshness.openssf = scorecardResult.value.date ?? scorecardResult.value.fetchedAt;
  } else {
    unavailable.push("openssf");
    if (scorecardResult.status === "rejected") {
      logSourceFailure("openssf", scorecardResult.reason);
    }
  }

  // deps.dev only contributes when the repository maps unambiguously to one
  // package (spec 3.2); it never feeds the score in the MVP.
  if (mappingResult.status === "fulfilled" && mappingResult.value.confident) {
    security.depsDataAvailable = true;
    freshness.deps_dev = mappingResult.value.fetchedAt;
  } else {
    unavailable.push("deps_dev");
    if (mappingResult.status === "rejected") {
      logSourceFailure("deps.dev", mappingResult.reason);
    }
  }

  await setAnalysisStatus(db, analysisId, "SCORING");

  const scores = computeScore({
    basic,
    contributors,
    activity,
    issuePr,
    release,
    security,
    now,
  });
  if (contributors === null) {
    scores.headlineSignals.unshift({
      type: "info",
      text: statsPending
        ? "Contributor details are still unavailable.（GitHub の統計生成待ち）"
        : "Contributor details are still unavailable.",
    });
  } else if (contributors.source === "ecosystems_commits") {
    // The reader has to know the 90-day figure is absent by source, not by
    // failure, otherwise an N/A looks like a bug.
    scores.headlineSignals.push({
      type: "info",
      text: statsTooLarge
        ? "Contributor 指標は ecosyste.ms の集約値（GitHub の週次統計は大きすぎるため未使用）。90日窓は N/A"
        : "Contributor 指標は ecosyste.ms の集約値。90日窓は N/A",
    });
  }

  const completedAt = new Date().toISOString();
  freshness.score = completedAt;

  await saveMetrics(db, analysisId, {
    contributors,
    activity,
    issuePr,
    release,
    security,
    sourceUpdatedAt: {
      contributors: freshness.github ?? null,
      activity: freshness.github ?? null,
      issuePr: freshness.ecosystems ?? null,
      release: freshness.github ?? null,
      security: freshness.openssf ?? null,
    },
  });

  // PARTIAL means "some data the reader might expect is missing", which covers a
  // failed source, pending GitHub statistics, and the reduced-fidelity
  // contributor path where the 90-day window is unavailable.
  const status =
    unavailable.length > 0 ||
    statsPending ||
    contributors === null ||
    contributors.source === "ecosystems_commits" ||
    activity === null ||
    activity.activeWeeks365d === null
      ? "PARTIAL"
      : "COMPLETE";

  await finishAnalysis(db, {
    analysisId,
    status,
    scores,
    freshness,
    unavailable,
    diagnostics,
    completedAt,
  });

  console.info("analysis complete", {
    analysisId,
    status,
    githubRequests: github.usage.requests,
    contributorSource: contributors?.source ?? null,
    activitySource: activity?.source ?? null,
    unavailable,
  });

  await bumpCounters(
    db,
    [
      { name: "analysis_total", value: 1 },
      { name: status === "PARTIAL" ? "analysis_partial_total" : "analysis_complete_total", value: 1 },
      { name: "github_requests_total", value: github.usage.requests },
      { name: "github_requests_per_analysis_sum", value: github.usage.requests },
      { name: "github_403_total", value: github.usage.count403 },
      { name: "github_429_total", value: github.usage.count429 },
    ],
    Date.now(),
  );

  if (github.usage.requests > GITHUB_REQUEST_BUDGET.typical) {
    // Spec 30: this is the number to watch; make it visible in the logs when it
    // drifts past the design target rather than only when it hits the cap.
    console.warn("github request budget exceeded typical target", {
      analysisId,
      requests: github.usage.requests,
      typical: GITHUB_REQUEST_BUDGET.typical,
      rateLimitRemaining: github.usage.rateLimitRemaining,
    });
  }
}

function logSourceFailure(source: string, error: unknown): void {
  if (error instanceof TimeoutError || error instanceof CircuitOpenError) {
    console.warn(`${source} unavailable: ${error.name}`);
    return;
  }
  if (error instanceof GithubRateLimitedError || error instanceof RepositoryNotFoundError) {
    console.warn(`${source} unavailable: ${error.message}`);
    return;
  }
  console.error(`${source} failed`, error);
}
