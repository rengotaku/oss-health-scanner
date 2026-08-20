import {
  CACHE_TTL_SECONDS,
  ENDPOINTS,
  GITHUB_REQUEST_BUDGET,
  STATS_RETRY_DELAYS_MS,
  STATS_TOTAL_BUDGET_MS,
  TIMEOUTS_MS,
} from "../config";
import { fetchJson, HttpError, Semaphore } from "../http";
import type { RepoRef, RepositoryBasic } from "../types";

/** Spec 21.3: stay far below GitHub's 100-concurrent secondary limit. */
const githubSemaphore = new Semaphore(12);

export class GithubTokenMissingError extends Error {
  constructor() {
    super(
      "GITHUB_TOKEN is not configured. Unauthenticated GitHub REST allows only " +
        "60 requests/hour, which cannot support this service (spec 20.1).",
    );
    this.name = "GithubTokenMissingError";
  }
}

export class GithubBudgetExceededError extends Error {
  constructor(readonly used: number) {
    super(`GitHub request budget exceeded (${used} > ${GITHUB_REQUEST_BUDGET.hardCap})`);
    this.name = "GithubBudgetExceededError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor() {
    super("Repository not found or not publicly accessible.");
    this.name = "RepositoryNotFoundError";
  }
}

export class GithubRateLimitedError extends Error {
  constructor(readonly status: number) {
    super("GitHub rate limit reached.");
    this.name = "GithubRateLimitedError";
  }
}

type GithubRepoResponse = {
  id: number;
  name: string;
  owner: { login: string };
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  watchers_count?: number;
  archived: boolean;
  private: boolean;
  license: { spdx_id?: string | null; name?: string | null } | null;
  language: string | null;
  default_branch: string;
  open_issues_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
};

type GithubReleaseResponse = {
  name: string | null;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

export type ContributorWeek = {
  /** Week start, unix seconds (Sunday 00:00 UTC). */
  w: number;
  /** Commits in that week. */
  c: number;
};

export type ContributorStat = {
  login: string;
  githubUserId: number | null;
  /** GitHub's own account type; "Bot" is a high-confidence bot signal. */
  accountType: string | null;
  total: number;
  weeks: ContributorWeek[];
};

type RawContributorStat = {
  author: { login?: string; id?: number; type?: string } | null;
  total: number;
  weeks: { w: number; a: number; d: number; c: number }[];
};

export type GithubUsage = {
  requests: number;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  count403: number;
  count429: number;
};

/**
 * GitHub REST client with a hard per-analysis request budget.
 *
 * Spec 20.3 sets a typical budget of 8 requests and a hard cap of 12 per
 * uncached repository; spec 30 makes "requests per uncached analysis" the metric
 * to watch. The budget is enforced here rather than tracked after the fact so an
 * accidental pagination loop fails loudly instead of quietly costing quota.
 */
export class GithubClient {
  readonly usage: GithubUsage = {
    requests: 0,
    rateLimitRemaining: null,
    rateLimitLimit: null,
    count403: 0,
    count429: 0,
  };

  constructor(private readonly token: string) {
    if (!token) throw new GithubTokenMissingError();
  }

  private async request<T>(
    path: string,
    opts: {
      timeoutMs: number;
      cacheTtlSeconds: number;
      treatAsMissing?: number[];
      acceptStatus?: number[];
    },
  ): Promise<{ data: T | null; status: number; fetchedAt: string }> {
    if (this.usage.requests >= GITHUB_REQUEST_BUDGET.hardCap) {
      throw new GithubBudgetExceededError(this.usage.requests);
    }
    this.usage.requests += 1;

    const url = `${ENDPOINTS.github}${path}`;
    try {
      return await githubSemaphore.run(() =>
        fetchJson<T>(url, {
          source: "github",
          timeoutMs: opts.timeoutMs,
          cacheTtlSeconds: opts.cacheTtlSeconds,
          treatAsMissing: [...(opts.treatAsMissing ?? []), ...(opts.acceptStatus ?? [])],
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          onResponse: (response) => {
            const remaining = response.headers.get("x-ratelimit-remaining");
            const limit = response.headers.get("x-ratelimit-limit");
            if (remaining !== null) this.usage.rateLimitRemaining = Number(remaining);
            if (limit !== null) this.usage.rateLimitLimit = Number(limit);
            if (response.status === 403) this.usage.count403 += 1;
            if (response.status === 429) this.usage.count429 += 1;
          },
        }),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 404) throw new RepositoryNotFoundError();
        // 403 with an exhausted quota is rate limiting; 403 otherwise is a
        // permission problem. Both must stop rather than retry (spec 35).
        if (error.status === 429 || error.status === 403) {
          throw new GithubRateLimitedError(error.status);
        }
      }
      throw error;
    }
  }

  /** Spec 4 Level 1: the fields needed to render the basic card. */
  async getRepository(ref: RepoRef): Promise<{ basic: RepositoryBasic; fetchedAt: string }> {
    const { data, fetchedAt } = await this.request<GithubRepoResponse>(
      `/repos/${ref.owner}/${ref.repo}`,
      { timeoutMs: TIMEOUTS_MS.githubBasic, cacheTtlSeconds: CACHE_TTL_SECONDS.basic },
    );
    if (!data) throw new RepositoryNotFoundError();
    // A private repository is out of scope (spec 2.2). With a token that can
    // see it, refuse explicitly rather than analysing non-public data.
    if (data.private) throw new RepositoryNotFoundError();

    const license = data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION"
      ? data.license.spdx_id
      : (data.license?.name ?? null);

    return {
      fetchedAt,
      basic: {
        githubRepoId: data.id,
        owner: data.owner.login,
        name: data.name,
        canonicalUrl: `https://github.com/${data.owner.login}/${data.name}`,
        description: data.description,
        stars: data.stargazers_count,
        forks: data.forks_count,
        watchers: data.subscribers_count ?? data.watchers_count ?? null,
        archived: data.archived,
        license,
        language: data.language,
        defaultBranch: data.default_branch,
        openIssues: data.open_issues_count,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        pushedAt: data.pushed_at,
      },
    };
  }

  /** Recent published releases, newest first. Drafts are excluded. */
  async getReleases(
    ref: RepoRef,
    perPage: number,
  ): Promise<{ releases: { name: string; publishedAt: string }[]; fetchedAt: string }> {
    const { data, fetchedAt } = await this.request<GithubReleaseResponse[]>(
      `/repos/${ref.owner}/${ref.repo}/releases?per_page=${perPage}`,
      {
        timeoutMs: TIMEOUTS_MS.githubBasic,
        cacheTtlSeconds: CACHE_TTL_SECONDS.release,
        treatAsMissing: [404],
      },
    );
    const releases = (data ?? [])
      .filter((r) => !r.draft && r.published_at !== null)
      .map((r) => ({
        name: r.name?.trim() || r.tag_name,
        publishedAt: r.published_at as string,
      }))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return { releases, fetchedAt };
  }

  /**
   * Weekly commit counts per contributor.
   *
   * This single endpoint is what makes the request budget work: it yields raw
   * contributor count, per-contributor commit totals, active weeks and the
   * commit windows in one call, and it carries GitHub's own account `type` so
   * bot classification needs no extra lookups.
   *
   * GitHub answers `202 Accepted` while it computes the statistics (spec 19.2).
   * Retries are bounded by both a schedule and a total wall-clock budget; on
   * expiry the caller degrades to a partial result rather than failing the page.
   */
  async getContributorStats(
    ref: RepoRef,
  ): Promise<{ stats: ContributorStat[] | null; fetchedAt: string; pending: boolean }> {
    const startedAt = Date.now();
    let lastFetchedAt = new Date().toISOString();

    for (let attempt = 0; attempt < STATS_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = STATS_RETRY_DELAYS_MS[attempt]!;
      const elapsed = Date.now() - startedAt;
      if (delay > 0) {
        if (elapsed + delay > STATS_TOTAL_BUDGET_MS) break;
        await sleep(delay);
      }

      const { data, status, fetchedAt } = await this.request<RawContributorStat[]>(
        `/repos/${ref.owner}/${ref.repo}/stats/contributors`,
        {
          timeoutMs: TIMEOUTS_MS.githubStats,
          cacheTtlSeconds: CACHE_TTL_SECONDS.health,
          // 202 = still computing. 204 = no content (empty repository).
          acceptStatus: [202, 204],
        },
      );
      lastFetchedAt = fetchedAt;

      if (status === 204) return { stats: [], fetchedAt, pending: false };
      if (status === 202 || data === null) continue;

      const stats: ContributorStat[] = data
        .filter((entry) => entry.author?.login)
        .map((entry) => ({
          login: entry.author!.login!,
          githubUserId: entry.author!.id ?? null,
          accountType: entry.author!.type ?? null,
          total: entry.total,
          weeks: entry.weeks.map((w) => ({ w: w.w, c: w.c })),
        }));
      return { stats, fetchedAt, pending: false };
    }

    return { stats: null, fetchedAt: lastFetchedAt, pending: true };
  }

  /**
   * 52 weeks of repository-wide commit counts. Used only when contributor
   * statistics are still pending, so activity numbers can still be shown.
   */
  async getCommitActivity(
    ref: RepoRef,
  ): Promise<{ weeks: ContributorWeek[] | null; fetchedAt: string }> {
    const { data, status, fetchedAt } = await this.request<
      { week: number; total: number }[]
    >(`/repos/${ref.owner}/${ref.repo}/stats/commit_activity`, {
      timeoutMs: TIMEOUTS_MS.githubStats,
      cacheTtlSeconds: CACHE_TTL_SECONDS.health,
      acceptStatus: [202, 204],
    });
    if (status === 202 || data === null) return { weeks: null, fetchedAt };
    return {
      weeks: data.map((entry) => ({ w: entry.week, c: entry.total })),
      fetchedAt,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
