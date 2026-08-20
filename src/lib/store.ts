import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  ALGORITHM_VERSION,
  ANALYSIS_LOCK_TTL_SECONDS,
  CACHE_TTL_SECONDS,
  DEFAULT_RATE_LIMIT_PER_HOUR,
} from "./config";
import type {
  ActivityMetrics,
  AnalysisRecord,
  AnalysisStatus,
  ContributorMetrics,
  Freshness,
  IssuePrMetrics,
  ReleaseMetrics,
  RepoRef,
  RepositoryBasic,
  ScoreResult,
  SecurityMetrics,
  SourceName,
} from "./types";

export type Bindings = {
  DB: D1Database;
  GITHUB_TOKEN?: string;
  OSSHS_RATE_LIMIT_PER_HOUR?: string;
};

export type RequestScope = {
  env: Bindings;
  /** Extends the request lifetime so the health stage can finish after the response. */
  waitUntil: (promise: Promise<unknown>) => void;
};

export async function requestScope(): Promise<RequestScope> {
  const { env, ctx } = getCloudflareContext();
  const bindings = env as unknown as Bindings;
  if (!bindings.DB) {
    throw new Error(
      "D1 binding `DB` is missing. Run `npm run db:migrate:local` and check wrangler.jsonc.",
    );
  }
  return {
    env: bindings,
    waitUntil: (promise) => {
      // Locally there is no execution context to extend; awaiting is fine
      // because `next dev` keeps the process alive.
      if (ctx?.waitUntil) ctx.waitUntil(promise);
      else void promise;
    },
  };
}

export function rateLimitPerHour(env: Bindings): number {
  const raw = Number(env.OSSHS_RATE_LIMIT_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RATE_LIMIT_PER_HOUR;
}

type RepoRow = {
  id: number;
  github_repo_id: number | null;
  owner: string;
  name: string;
  canonical_url: string;
  description: string | null;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  archived: number;
  license: string | null;
  language: string | null;
  default_branch: string | null;
  open_issues: number | null;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  last_fetched_at: string | null;
};

function rowToBasic(row: RepoRow): RepositoryBasic {
  return {
    githubRepoId: row.github_repo_id,
    owner: row.owner,
    name: row.name,
    canonicalUrl: row.canonical_url,
    description: row.description,
    stars: row.stars,
    forks: row.forks,
    watchers: row.watchers,
    archived: row.archived === 1,
    license: row.license,
    language: row.language,
    defaultBranch: row.default_branch,
    openIssues: row.open_issues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pushedAt: row.pushed_at,
  };
}

export async function findRepository(
  db: D1Database,
  ref: RepoRef,
): Promise<{ id: number; basic: RepositoryBasic; lastFetchedAt: string | null } | null> {
  const row = await db
    .prepare(
      "SELECT * FROM repositories WHERE lower(owner) = ?1 AND lower(name) = ?2 LIMIT 1",
    )
    .bind(ref.owner.toLowerCase(), ref.repo.toLowerCase())
    .first<RepoRow>();
  if (!row) return null;
  return { id: row.id, basic: rowToBasic(row), lastFetchedAt: row.last_fetched_at };
}

export async function upsertRepository(
  db: D1Database,
  basic: RepositoryBasic,
  fetchedAt: string,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO repositories (
         github_repo_id, owner, name, canonical_url, description, stars, forks, watchers,
         archived, license, language, default_branch, open_issues,
         created_at, updated_at, pushed_at, last_fetched_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
       ON CONFLICT (owner, name) DO UPDATE SET
         github_repo_id = excluded.github_repo_id,
         canonical_url  = excluded.canonical_url,
         description    = excluded.description,
         stars          = excluded.stars,
         forks          = excluded.forks,
         watchers       = excluded.watchers,
         archived       = excluded.archived,
         license        = excluded.license,
         language       = excluded.language,
         default_branch = excluded.default_branch,
         open_issues    = excluded.open_issues,
         updated_at     = excluded.updated_at,
         pushed_at      = excluded.pushed_at,
         last_fetched_at= excluded.last_fetched_at`,
    )
    .bind(
      basic.githubRepoId,
      basic.owner,
      basic.name,
      basic.canonicalUrl,
      basic.description,
      basic.stars,
      basic.forks,
      basic.watchers,
      basic.archived ? 1 : 0,
      basic.license,
      basic.language,
      basic.defaultBranch,
      basic.openIssues,
      basic.createdAt,
      basic.updatedAt,
      basic.pushedAt,
      fetchedAt,
    )
    .run();

  const row = await db
    .prepare("SELECT id FROM repositories WHERE lower(owner) = ?1 AND lower(name) = ?2")
    .bind(basic.owner.toLowerCase(), basic.name.toLowerCase())
    .first<{ id: number }>();
  if (!row) throw new Error("repository upsert did not yield an id");
  return row.id;
}

/**
 * Same-repository deduplication (spec 17.3 / 21.2).
 *
 * D1 runs on a single primary, so a conditional UPDATE is a genuine atomic
 * compare-and-set: exactly one concurrent request sees `changes === 1` and
 * becomes the analyser, and the rest subscribe to that analysis instead of
 * spending a second GitHub budget on the same repository. The lock carries an
 * expiry so an analysis that dies mid-flight cannot block the repository
 * permanently.
 */
export async function tryAcquireLock(
  db: D1Database,
  repositoryId: number,
  nowMs: number,
): Promise<{ acquired: boolean; existingAnalysisId: string | null }> {
  const expires = nowMs + ANALYSIS_LOCK_TTL_SECONDS * 1000;

  const claimed = await db
    .prepare(
      `UPDATE analyses SET lock_expires_at = ?1
         WHERE repository_id = ?2
           AND status IN ('QUEUED','FETCHING_BASIC','FETCHING_ACTIVITY','FETCHING_SECURITY','SCORING')
           AND lock_expires_at IS NOT NULL
           AND lock_expires_at < ?3
         RETURNING id`,
    )
    .bind(expires, repositoryId, nowMs)
    .first<{ id: string }>();

  // An expired in-flight analysis was reclaimed: continue under its id.
  if (claimed) return { acquired: true, existingAnalysisId: claimed.id };

  const live = await db
    .prepare(
      `SELECT id FROM analyses
         WHERE repository_id = ?1
           AND status IN ('QUEUED','FETCHING_BASIC','FETCHING_ACTIVITY','FETCHING_SECURITY','SCORING')
           AND lock_expires_at IS NOT NULL
           AND lock_expires_at >= ?2
         ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(repositoryId, nowMs)
    .first<{ id: string }>();

  if (live) return { acquired: false, existingAnalysisId: live.id };
  return { acquired: true, existingAnalysisId: null };
}

export async function heartbeatLock(
  db: D1Database,
  analysisId: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare("UPDATE analyses SET lock_expires_at = ?1 WHERE id = ?2")
    .bind(nowMs + ANALYSIS_LOCK_TTL_SECONDS * 1000, analysisId)
    .run();
}

export async function createAnalysis(
  db: D1Database,
  args: { analysisId: string; repositoryId: number; startedAt: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analyses (id, repository_id, status, started_at, algorithm_version, lock_expires_at)
       VALUES (?1, ?2, 'QUEUED', ?3, ?4, ?5)`,
    )
    .bind(
      args.analysisId,
      args.repositoryId,
      args.startedAt,
      ALGORITHM_VERSION,
      args.nowMs + ANALYSIS_LOCK_TTL_SECONDS * 1000,
    )
    .run();
}

export async function setAnalysisStatus(
  db: D1Database,
  analysisId: string,
  status: AnalysisStatus,
  extra?: { errorCode?: string | null; basicReadyAt?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE analyses SET status = ?1,
         error_code = COALESCE(?2, error_code),
         basic_ready_at = COALESCE(?3, basic_ready_at)
       WHERE id = ?4`,
    )
    .bind(status, extra?.errorCode ?? null, extra?.basicReadyAt ?? null, analysisId)
    .run();
}

export async function finishAnalysis(
  db: D1Database,
  args: {
    analysisId: string;
    status: AnalysisStatus;
    scores: ScoreResult | null;
    freshness: Freshness;
    unavailable: SourceName[];
    completedAt: string;
  },
): Promise<void> {
  const s = args.scores;
  await db
    .prepare(
      `UPDATE analyses SET
         status = ?1,
         health_score = ?2,
         score_coverage = ?3,
         status_label = ?4,
         maintenance_score = ?5,
         community_score = ?6,
         security_score = ?7,
         release_score = ?8,
         adoption_score = ?9,
         reasons_json = ?10,
         availability_json = ?11,
         freshness_json = ?12,
         unavailable_json = ?13,
         completed_at = ?14,
         lock_expires_at = NULL
       WHERE id = ?15`,
    )
    .bind(
      args.status,
      s?.healthScore ?? null,
      s?.coverage ?? null,
      s?.statusLabel ?? null,
      s?.categories.maintenance.score ?? null,
      s?.categories.community_resilience.score ?? null,
      s?.categories.security_hygiene.score ?? null,
      s?.categories.release_health.score ?? null,
      s?.categories.adoption.score ?? null,
      s ? JSON.stringify({ categories: s.categories, headline: s.headlineSignals }) : null,
      s
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(s.categories).map(([k, v]) => [
                k,
                { available: v.available, reason: v.unavailableReason ?? null },
              ]),
            ),
          )
        : null,
      JSON.stringify(args.freshness),
      JSON.stringify(args.unavailable),
      args.completedAt,
      args.analysisId,
    )
    .run();
}

export async function saveMetrics(
  db: D1Database,
  analysisId: string,
  metrics: {
    contributors: ContributorMetrics | null;
    activity: ActivityMetrics | null;
    issuePr: IssuePrMetrics | null;
    release: ReleaseMetrics | null;
    security: SecurityMetrics | null;
    sourceUpdatedAt: Partial<Record<"contributors" | "activity" | "issuePr" | "release" | "security", string | null>>;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const c = metrics.contributors;
  if (c) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO contributor_metrics (
             analysis_id, raw_contributors, active_90d, active_365d, repeat_365d,
             effective_contributors, core_maintainers, bot_contributors, known_ai_agents,
             human_unknown, one_shot_ratio, top1_share, top3_share, top5_share, source_updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
        )
        .bind(
          analysisId,
          c.rawContributors,
          c.active90d,
          c.active365d,
          c.repeat365d,
          c.effectiveContributors,
          c.coreMaintainers,
          c.botContributors,
          c.knownAiAgents,
          c.humanUnknown,
          c.oneShotRatio,
          c.top1Share,
          c.top3Share,
          c.top5Share,
          metrics.sourceUpdatedAt.contributors ?? null,
        ),
    );
  }
  const a = metrics.activity;
  if (a) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO activity_metrics (
             analysis_id, commits_30d, commits_90d, commits_365d, commits_prev_90d,
             active_weeks_365d, last_commit_at, source_updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        )
        .bind(
          analysisId,
          a.commits30d,
          a.commits90d,
          a.commits365d,
          a.commitsPrev90d,
          a.activeWeeks365d,
          a.lastCommitAt,
          metrics.sourceUpdatedAt.activity ?? null,
        ),
    );
  }
  const i = metrics.issuePr;
  if (i) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO issue_pr_metrics (
             analysis_id, total_issues, total_prs, merged_prs, bot_prs,
             avg_issue_close_seconds, avg_pr_close_seconds, issue_authors, pr_authors,
             open_closed_ratio, source_updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
        )
        .bind(
          analysisId,
          i.totalIssues,
          i.totalPrs,
          i.mergedPrs,
          i.botPrs,
          i.avgIssueCloseSeconds,
          i.avgPrCloseSeconds,
          i.issueAuthors,
          i.prAuthors,
          i.openClosedRatio,
          metrics.sourceUpdatedAt.issuePr ?? null,
        ),
    );
  }
  const r = metrics.release;
  if (r) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO release_metrics (
             analysis_id, has_releases, latest_release_at, latest_release_name,
             latest_release_age, release_count_sample, median_interval_days,
             release_delay_ratio, recent_releases_json, source_updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
        )
        .bind(
          analysisId,
          r.hasReleases ? 1 : 0,
          r.latestReleaseAt,
          r.latestReleaseName,
          r.latestReleaseAgeDays === null ? null : Math.round(r.latestReleaseAgeDays),
          r.releaseCountSample,
          r.medianIntervalDays,
          r.releaseDelayRatio,
          JSON.stringify(r.recentReleases),
          metrics.sourceUpdatedAt.release ?? null,
        ),
    );
  }
  const sec = metrics.security;
  if (sec) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO security_metrics (
             analysis_id, openssf_score, openssf_checks_json, openssf_date,
             license_present, deps_data_available, vulnerability_count, source_updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        )
        .bind(
          analysisId,
          sec.openssfScore,
          JSON.stringify(sec.openssfChecks),
          sec.openssfDate,
          sec.licensePresent ? 1 : 0,
          sec.depsDataAvailable ? 1 : 0,
          sec.vulnerabilityCount,
          metrics.sourceUpdatedAt.security ?? null,
        ),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

type AnalysisRow = {
  id: string;
  repository_id: number;
  status: AnalysisStatus;
  health_score: number | null;
  score_coverage: number | null;
  status_label: string | null;
  reasons_json: string | null;
  freshness_json: string | null;
  unavailable_json: string | null;
  error_code: string | null;
  started_at: string;
  basic_ready_at: string | null;
  completed_at: string | null;
  algorithm_version: string;
};

export async function loadAnalysis(
  db: D1Database,
  analysisId: string,
): Promise<AnalysisRecord | null> {
  const row = await db
    .prepare("SELECT * FROM analyses WHERE id = ?1")
    .bind(analysisId)
    .first<AnalysisRow>();
  if (!row) return null;
  return hydrate(db, row);
}

export async function loadLatestAnalysis(
  db: D1Database,
  repositoryId: number,
): Promise<AnalysisRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM analyses
         WHERE repository_id = ?1 AND status IN ('COMPLETE','PARTIAL')
         ORDER BY completed_at DESC LIMIT 1`,
    )
    .bind(repositoryId)
    .first<AnalysisRow>();
  if (!row) return null;
  return hydrate(db, row);
}

async function hydrate(db: D1Database, row: AnalysisRow): Promise<AnalysisRecord> {
  const repo = await db
    .prepare("SELECT * FROM repositories WHERE id = ?1")
    .bind(row.repository_id)
    .first<RepoRow>();
  if (!repo) throw new Error(`analysis ${row.id} references a missing repository`);

  const [contributors, activity, issuePr, release, security] = await Promise.all([
    db.prepare("SELECT * FROM contributor_metrics WHERE analysis_id = ?1").bind(row.id).first<Record<string, number | null>>(),
    db.prepare("SELECT * FROM activity_metrics WHERE analysis_id = ?1").bind(row.id).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM issue_pr_metrics WHERE analysis_id = ?1").bind(row.id).first<Record<string, number | null>>(),
    db.prepare("SELECT * FROM release_metrics WHERE analysis_id = ?1").bind(row.id).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM security_metrics WHERE analysis_id = ?1").bind(row.id).first<Record<string, unknown>>(),
  ]);

  const reasons = row.reasons_json
    ? (JSON.parse(row.reasons_json) as {
        categories: ScoreResult["categories"];
        headline: ScoreResult["headlineSignals"];
      })
    : null;

  const scores: ScoreResult | null =
    reasons && row.status_label
      ? {
          healthScore: row.health_score,
          coverage: row.score_coverage ?? 0,
          statusLabel: row.status_label as ScoreResult["statusLabel"],
          categories: reasons.categories,
          headlineSignals: reasons.headline,
          algorithmVersion: row.algorithm_version,
        }
      : null;

  return {
    analysisId: row.id,
    status: row.status,
    repository: rowToBasic(repo),
    scores,
    contributors: contributors
      ? {
          rawContributors: num(contributors.raw_contributors),
          active90d: num(contributors.active_90d),
          active365d: num(contributors.active_365d),
          repeat365d: num(contributors.repeat_365d),
          effectiveContributors: num(contributors.effective_contributors),
          coreMaintainers: num(contributors.core_maintainers),
          botContributors: num(contributors.bot_contributors),
          knownAiAgents: num(contributors.known_ai_agents),
          humanUnknown: num(contributors.human_unknown),
          oneShotRatio: contributors.one_shot_ratio ?? null,
          top1Share: contributors.top1_share ?? null,
          top3Share: contributors.top3_share ?? null,
          top5Share: contributors.top5_share ?? null,
        }
      : null,
    activity: activity
      ? {
          commits30d: num(activity.commits_30d),
          commits90d: num(activity.commits_90d),
          commits365d: num(activity.commits_365d),
          commitsPrev90d: num(activity.commits_prev_90d),
          activeWeeks365d: num(activity.active_weeks_365d),
          lastCommitAt: (activity.last_commit_at as string | null) ?? null,
        }
      : null,
    issuePr: issuePr
      ? {
          totalIssues: issuePr.total_issues ?? null,
          totalPrs: issuePr.total_prs ?? null,
          mergedPrs: issuePr.merged_prs ?? null,
          botPrs: issuePr.bot_prs ?? null,
          avgIssueCloseSeconds: issuePr.avg_issue_close_seconds ?? null,
          avgPrCloseSeconds: issuePr.avg_pr_close_seconds ?? null,
          issueAuthors: issuePr.issue_authors ?? null,
          prAuthors: issuePr.pr_authors ?? null,
          openClosedRatio: issuePr.open_closed_ratio ?? null,
        }
      : null,
    release: release
      ? {
          hasReleases: release.has_releases === 1,
          latestReleaseAt: (release.latest_release_at as string | null) ?? null,
          latestReleaseName: (release.latest_release_name as string | null) ?? null,
          latestReleaseAgeDays: (release.latest_release_age as number | null) ?? null,
          releaseCountSample: num(release.release_count_sample),
          medianIntervalDays: (release.median_interval_days as number | null) ?? null,
          releaseDelayRatio: (release.release_delay_ratio as number | null) ?? null,
          recentReleases: release.recent_releases_json
            ? (JSON.parse(release.recent_releases_json as string) as ReleaseMetrics["recentReleases"])
            : [],
        }
      : null,
    security: security
      ? {
          openssfScore: (security.openssf_score as number | null) ?? null,
          openssfChecks: security.openssf_checks_json
            ? (JSON.parse(security.openssf_checks_json as string) as SecurityMetrics["openssfChecks"])
            : [],
          openssfDate: (security.openssf_date as string | null) ?? null,
          licensePresent: security.license_present === 1,
          depsDataAvailable: security.deps_data_available === 1,
          vulnerabilityCount: (security.vulnerability_count as number | null) ?? null,
        }
      : null,
    freshness: row.freshness_json ? (JSON.parse(row.freshness_json) as Freshness) : {},
    unavailable: row.unavailable_json
      ? (JSON.parse(row.unavailable_json) as SourceName[])
      : [],
    cached: false,
    startedAt: row.started_at,
    basicReadyAt: row.basic_ready_at,
    completedAt: row.completed_at,
    algorithmVersion: row.algorithm_version,
    errorCode: row.error_code,
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Whether a stored analysis is still within the health-metrics TTL (spec 18.1). */
export function isFresh(analysis: AnalysisRecord, now: Date): boolean {
  if (!analysis.completedAt) return false;
  const age = (now.getTime() - Date.parse(analysis.completedAt)) / 1000;
  return Number.isFinite(age) && age < CACHE_TTL_SECONDS.health;
}

/**
 * Self-imposed per-IP rate limit (spec 21.1). Counted per hour bucket in D1
 * rather than in an eventually-consistent store, so the count cannot drift
 * above the limit under concurrency.
 */
export async function consumeRateLimit(
  db: D1Database,
  clientKey: string,
  limit: number,
  nowMs: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const bucket = Math.floor(nowMs / 3_600_000);
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets (client_key, bucket, hits) VALUES (?1, ?2, 1)
       ON CONFLICT (client_key, bucket) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
    )
    .bind(clientKey, bucket)
    .first<{ hits: number }>();

  const hits = row?.hits ?? 1;
  // Opportunistic cleanup of buckets older than two hours.
  if (hits % 25 === 0) {
    await db
      .prepare("DELETE FROM rate_limit_buckets WHERE bucket < ?1")
      .bind(bucket - 2)
      .run();
  }
  return { allowed: hits <= limit, remaining: Math.max(0, limit - hits) };
}

/** Observability counters (spec 30), aggregated per hour bucket. */
export async function bumpCounters(
  db: D1Database,
  entries: { name: string; value: number }[],
  nowMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const bucket = Math.floor(nowMs / 3_600_000);
  await db.batch(
    entries.map((entry) =>
      db
        .prepare(
          `INSERT INTO metric_counters (name, bucket, value) VALUES (?1, ?2, ?3)
           ON CONFLICT (name, bucket) DO UPDATE SET value = value + ?3`,
        )
        .bind(entry.name, bucket, entry.value),
    ),
  );
}

export async function readCounters(
  db: D1Database,
  nowMs: number,
): Promise<Record<string, number>> {
  const bucket = Math.floor(nowMs / 3_600_000);
  const { results } = await db
    .prepare("SELECT name, value FROM metric_counters WHERE bucket = ?1")
    .bind(bucket)
    .all<{ name: string; value: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.name, r.value]));
}
