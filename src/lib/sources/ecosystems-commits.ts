import { CACHE_TTL_SECONDS, TIMEOUTS_MS } from "../config";
import { fetchJson } from "../http";
import type { RepoRef } from "../types";

/**
 * Commit aggregation from commits.ecosyste.ms.
 *
 * This is the primary contributor source, not GitHub's statistics endpoint.
 * Measured on 2026-08-20, `GET /repos/{o}/{r}/stats/contributors` returns
 * 29 MB for kubernetes/kubernetes, 62 MB for curl/curl and 71 MB for
 * torvalds/linux, because it carries every contributor's full weekly history.
 * A Cloudflare Worker cannot parse that (128 MB isolate memory, CPU time
 * limits), so the endpoint is unusable for exactly the popular repositories
 * people paste in. ecosyste.ms returns the same aggregation pre-computed in a
 * few hundred KB regardless of repository size, which is the role spec 3.1 and
 * 20.3 already assign it — avoiding GitHub full-history pagination.
 *
 * What this source does not carry: a 90-day window, and per-contributor active
 * weeks. Those come from the size-guarded GitHub call when it is cheap, and are
 * reported as N/A when it is not.
 */
type CommitsResponse = {
  total_commits?: number;
  total_committers?: number;
  total_bot_commits?: number;
  total_bot_committers?: number;
  dds?: number;
  past_year_total_commits?: number;
  past_year_total_committers?: number;
  past_year_total_bot_commits?: number;
  past_year_total_bot_committers?: number;
  past_year_dds?: number;
  last_synced_at?: string;
  updated_at?: string;
  committers?: CommitterEntry[];
  past_year_committers?: CommitterEntry[];
};

export type CommitterEntry = {
  name?: string;
  email?: string;
  login?: string | null;
  count?: number;
};

export type Committer = {
  /** Login when ecosyste.ms resolved one, otherwise the commit author name. */
  identity: string;
  login: string | null;
  name: string | null;
  email: string | null;
  commits: number;
};

export type CommitAggregation = {
  totalCommits: number | null;
  totalCommitters: number | null;
  totalBotCommitters: number | null;
  pastYearCommits: number | null;
  pastYearCommitters: number | null;
  pastYearBotCommitters: number | null;
  /** Development distribution score: higher means less concentrated. */
  pastYearDds: number | null;
  committers: Committer[];
  pastYear: Committer[];
  sourceUpdatedAt: string | null;
  fetchedAt: string;
};

export async function fetchCommitAggregation(
  ref: RepoRef,
): Promise<CommitAggregation | null> {
  const target = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  const url = `https://commits.ecosyste.ms/api/v1/hosts/GitHub/repositories/${target}`;

  const { data, fetchedAt } = await fetchJson<CommitsResponse>(url, {
    source: "ecosystems",
    timeoutMs: TIMEOUTS_MS.externalEnrichment,
    cacheTtlSeconds: CACHE_TTL_SECONDS.ecosystems,
    treatAsMissing: [404, 202],
  });

  if (!data) return null;
  const pastYear = normalize(data.past_year_committers);
  const all = normalize(data.committers);
  if (pastYear.length === 0 && all.length === 0) return null;

  return {
    totalCommits: num(data.total_commits),
    totalCommitters: num(data.total_committers),
    totalBotCommitters: num(data.total_bot_committers),
    pastYearCommits: num(data.past_year_total_commits),
    pastYearCommitters: num(data.past_year_total_committers),
    pastYearBotCommitters: num(data.past_year_total_bot_committers),
    pastYearDds: num(data.past_year_dds),
    committers: all,
    pastYear,
    sourceUpdatedAt: data.last_synced_at ?? data.updated_at ?? null,
    fetchedAt,
  };
}

function normalize(entries: CommitterEntry[] | undefined): Committer[] {
  if (!entries) return [];
  // The same person often appears under several name/email pairs. Merge on the
  // resolved login when there is one, so concentration is not diluted by a
  // maintainer who commits from two machines.
  const merged = new Map<string, Committer>();
  for (const entry of entries) {
    const login = entry.login?.trim() || null;
    const name = entry.name?.trim() || null;
    const email = entry.email?.trim() || null;
    const identity = (login ?? email ?? name ?? "").toLowerCase();
    if (identity === "") continue;
    const commits = typeof entry.count === "number" && entry.count > 0 ? entry.count : 0;
    const existing = merged.get(identity);
    if (existing) {
      existing.commits += commits;
      existing.login ??= login;
      existing.name ??= name;
      existing.email ??= email;
      continue;
    }
    merged.set(identity, { identity, login, name, email, commits });
  }
  return [...merged.values()].sort((a, b) => b.commits - a.commits);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
