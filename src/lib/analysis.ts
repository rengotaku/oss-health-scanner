import { CONTRIBUTOR_RULES, GITHUB_REQUEST_BUDGET } from "./config";
import { CircuitOpenError, TimeoutError } from "./http";
import {
  computeActivityFromCommitWeeks,
  computeContributorMetrics,
} from "./metrics/contributors";
import { computeReleaseMetrics } from "./metrics/release";
import { computeScore } from "./score";
import { resolvePackageMapping } from "./sources/depsdev";
import { fetchIssuePrMetrics } from "./sources/ecosystems";
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

  await setAnalysisStatus(db, analysisId, "FETCHING_ACTIVITY");
  await heartbeatLock(db, analysisId, Date.now());

  const [statsResult, releasesResult, issuePrResult, scorecardResult, mappingResult] =
    await Promise.allSettled([
      github.getContributorStats(ref),
      github.getReleases(ref, CONTRIBUTOR_RULES.releaseSampleSize + 4),
      fetchIssuePrMetrics(ref),
      fetchScorecard(ref),
      resolvePackageMapping(ref),
    ]);

  await setAnalysisStatus(db, analysisId, "FETCHING_SECURITY");
  await heartbeatLock(db, analysisId, Date.now());

  // ---- Contributors and activity (GitHub statistics) ----
  let contributors: ContributorMetrics | null = null;
  let activity: ActivityMetrics | null = null;
  let statsPending = false;

  if (statsResult.status === "fulfilled" && statsResult.value.stats) {
    const computed = computeContributorMetrics(statsResult.value.stats, now);
    contributors = computed.contributors;
    activity = { ...computed.activity, lastCommitAt: basic.pushedAt };
    freshness.github = statsResult.value.fetchedAt;
  } else {
    statsPending = statsResult.status === "fulfilled" && statsResult.value.pending;
    // Statistics still generating: fall back to repository-wide commit activity
    // so the Activity card is not empty, while contributor metrics stay null.
    if (statsPending && github.usage.requests < GITHUB_REQUEST_BUDGET.hardCap) {
      try {
        const fallback = await github.getCommitActivity(ref);
        if (fallback.weeks) {
          activity = {
            ...computeActivityFromCommitWeeks(fallback.weeks, now),
            lastCommitAt: basic.pushedAt,
          };
        }
      } catch {
        // Fallback is best-effort by definition.
      }
    }
    if (!statsPending && statsResult.status === "rejected") {
      logSourceFailure("github stats", statsResult.reason);
    }
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
  if (statsPending) {
    scores.headlineSignals.unshift({
      type: "info",
      text: "Contributor details are still unavailable.（GitHub の統計生成待ち）",
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

  const status = unavailable.length > 0 || statsPending || contributors === null
    ? "PARTIAL"
    : "COMPLETE";

  await finishAnalysis(db, {
    analysisId,
    status,
    scores,
    freshness,
    unavailable,
    completedAt,
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
