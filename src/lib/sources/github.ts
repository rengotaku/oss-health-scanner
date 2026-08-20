import {
  CACHE_TTL_SECONDS,
  ENDPOINTS,
  GITHUB_REQUEST_BUDGET,
  STATS_MAX_BYTES,
  STATS_RETRY_DELAYS_MS,
  STATS_TOTAL_BUDGET_MS,
  TIMEOUTS_MS,
  USER_AGENT,
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
   * Weekly commit counts per contributor — used only when the body is small
   * enough to read.
   *
   * This endpoint is the only source carrying weekly buckets and GitHub account
   * types, but it returns every contributor's complete history. Measured
   * 2026-08-20 with gzip negotiated, curl/curl decodes to 24.8 MB and
   * torvalds/linux is larger still; a Worker cannot hold that. The body is
   * therefore read as a stream and abandoned the moment it crosses
   * `STATS_MAX_BYTES`, and the caller falls back to the ecosyste.ms aggregation.
   *
   * The size cannot be predicted from `content-length`: these responses arrive
   * gzip-encoded and chunked, so the header is absent. Counting decoded bytes as
   * they arrive is the only guard that actually holds.
   *
   * `202 Accepted` means GitHub is still computing (spec 19.2).
   */
  async getContributorStats(
    ref: RepoRef,
  ): Promise<{
    stats: ContributorStat[] | null;
    fetchedAt: string;
    pending: boolean;
    tooLarge: boolean;
    bytes: number | null;
  }> {
    const result = await this.getStatsBody(`/repos/${ref.owner}/${ref.repo}/stats/contributors`);
    if (result.kind === "too_large") {
      return {
        stats: null,
        fetchedAt: result.fetchedAt,
        pending: false,
        tooLarge: true,
        bytes: result.bytes,
      };
    }
    if (result.kind === "pending") {
      return { stats: null, fetchedAt: result.fetchedAt, pending: true, tooLarge: false, bytes: null };
    }
    if (result.kind === "empty") {
      return { stats: [], fetchedAt: result.fetchedAt, pending: false, tooLarge: false, bytes: 0 };
    }

    const raw = JSON.parse(result.text) as RawContributorStat[] | null;
    if (!Array.isArray(raw)) {
      return { stats: null, fetchedAt: result.fetchedAt, pending: true, tooLarge: false, bytes: null };
    }

    const stats: ContributorStat[] = raw
      .filter((entry) => entry.author?.login)
      .map((entry) => ({
        login: entry.author!.login!,
        githubUserId: entry.author!.id ?? null,
        accountType: entry.author!.type ?? null,
        total: entry.total,
        weeks: entry.weeks.map((w) => ({ w: w.w, c: w.c })),
      }));
    return {
      stats,
      fetchedAt: result.fetchedAt,
      pending: false,
      tooLarge: false,
      bytes: result.bytes,
    };
  }

  /**
   * 52 weeks of repository-wide commit totals (~3 KB).
   *
   * This is the activity source for every repository, so it gets the same
   * bounded 202 retry as the contributor statistics: without it, a repository
   * whose statistics GitHub happens to be recomputing loses its activity
   * numbers entirely on the first visit.
   */
  async getCommitActivity(
    ref: RepoRef,
  ): Promise<{ weeks: ContributorWeek[] | null; fetchedAt: string }> {
    const result = await this.getStatsBody(
      `/repos/${ref.owner}/${ref.repo}/stats/commit_activity`,
    );
    if (result.kind !== "ok") return { weeks: null, fetchedAt: result.fetchedAt };

    const raw = JSON.parse(result.text) as { week: number; total: number }[] | null;
    if (!Array.isArray(raw)) return { weeks: null, fetchedAt: result.fetchedAt };
    return {
      weeks: raw.map((entry) => ({ w: entry.week, c: entry.total })),
      fetchedAt: result.fetchedAt,
    };
  }

  /**
   * Fetches a `stats/*` endpoint with the 202 retry schedule and a hard cap on
   * how many decoded bytes will be accumulated.
   */
  private async getStatsBody(path: string): Promise<
    | { kind: "ok"; text: string; bytes: number; fetchedAt: string }
    | { kind: "too_large"; bytes: number; fetchedAt: string }
    | { kind: "pending"; fetchedAt: string }
    | { kind: "empty"; fetchedAt: string }
  > {
    const startedAt = Date.now();
    let lastFetchedAt = new Date().toISOString();

    for (let attempt = 0; attempt < STATS_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = STATS_RETRY_DELAYS_MS[attempt]!;
      if (delay > 0) {
        if (Date.now() - startedAt + delay > STATS_TOTAL_BUDGET_MS) break;
        await sleep(delay);
      }

      if (this.usage.requests >= GITHUB_REQUEST_BUDGET.hardCap) {
        throw new GithubBudgetExceededError(this.usage.requests);
      }
      this.usage.requests += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.githubStats);
      try {
        const response = await githubSemaphore.run(() =>
          fetch(`${ENDPOINTS.github}${path}`, {
            headers: {
              authorization: `Bearer ${this.token}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": USER_AGENT,
            },
            signal: controller.signal,
          }),
        );
        lastFetchedAt = new Date().toISOString();

        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining !== null) this.usage.rateLimitRemaining = Number(remaining);
        if (response.status === 403) this.usage.count403 += 1;
        if (response.status === 429) this.usage.count429 += 1;

        if (response.status === 404) throw new RepositoryNotFoundError();
        if (response.status === 429 || response.status === 403) {
          throw new GithubRateLimitedError(response.status);
        }
        if (response.status === 204) {
          await cancel(response);
          return { kind: "empty", fetchedAt: lastFetchedAt };
        }
        if (response.status === 202) {
          await cancel(response);
          continue;
        }
        if (!response.ok || !response.body) {
          // Worth logging: a repeatedly unusable statistics endpoint is the
          // difference between "no contributor data" and "a bug here".
          console.warn("github stats attempt unusable", {
            path,
            status: response.status,
            hasBody: response.body !== null,
          });
          await cancel(response);
          continue;
        }

        const read = await readCapped(response.body, STATS_MAX_BYTES);
        if (read.exceeded) {
          controller.abort();
          return { kind: "too_large", bytes: read.bytes, fetchedAt: lastFetchedAt };
        }
        return { kind: "ok", text: read.text, bytes: read.bytes, fetchedAt: lastFetchedAt };
      } finally {
        clearTimeout(timer);
      }
    }

    return { kind: "pending", fetchedAt: lastFetchedAt };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Reads a body until `maxBytes` decoded bytes have arrived, then stops.
 *
 * The cap has to be enforced while reading rather than from `content-length`:
 * GitHub's statistics responses are gzip-encoded and chunked, so the header is
 * absent and the decoded size is unknown until it arrives. Buffering first and
 * checking afterwards is exactly the failure this avoids — a 25 MB body would
 * already be in memory by then.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; bytes: number; exceeded: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: "", bytes, exceeded: true };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), bytes, exceeded: false };
  } finally {
    reader.releaseLock?.();
  }
}
