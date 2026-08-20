import { CACHE_TTL_SECONDS, ENDPOINTS, TIMEOUTS_MS } from "../config";
import { fetchJson, HttpError } from "../http";
import type { IssuePrMetrics, RepoRef } from "../types";

/**
 * issues.ecosyste.ms already aggregates issue and pull-request history per
 * repository. Spec 20.3 relies on this: computing the same numbers from GitHub
 * would require paginating the full issue history and would blow the 8-request
 * budget on any busy repository.
 *
 * Field names differ across ecosyste.ms deployments and some are absent for
 * repositories it has not fully indexed, so every field is read defensively and
 * a missing field becomes `null` (rendered as N/A) rather than a zero.
 */
type EcosystemsIssuesResponse = Record<string, unknown>;

export type EcosystemsResult = {
  issuePr: IssuePrMetrics;
  /** When ecosyste.ms last refreshed its own copy — shown in Data freshness. */
  sourceUpdatedAt: string | null;
  fetchedAt: string;
};

export async function fetchIssuePrMetrics(ref: RepoRef): Promise<EcosystemsResult | null> {
  const target = encodeURIComponent(`https://github.com/${ref.owner}/${ref.repo}`);
  const url = `${ENDPOINTS.ecosystemsIssues}/repositories/lookup?url=${target}`;

  let payload: EcosystemsIssuesResponse | null;
  let fetchedAt: string;
  try {
    const result = await fetchJson<EcosystemsIssuesResponse>(url, {
      source: "ecosystems",
      timeoutMs: TIMEOUTS_MS.externalEnrichment,
      cacheTtlSeconds: CACHE_TTL_SECONDS.ecosystems,
      treatAsMissing: [404],
    });
    payload = result.data;
    fetchedAt = result.fetchedAt;
  } catch (error) {
    // A 202 means ecosyste.ms queued the repository for indexing; there is
    // nothing to wait for within this request.
    if (error instanceof HttpError && error.status === 202) return null;
    throw error;
  }

  if (!payload) return null;

  const issuePr: IssuePrMetrics = {
    totalIssues: readNumber(payload, ["issues_count", "past_year_issues_count"]),
    totalPrs: readNumber(payload, ["pull_requests_count", "past_year_pull_requests_count"]),
    mergedPrs: readNumber(payload, ["merged_pull_requests_count"]),
    botPrs: readNumber(payload, ["bot_pull_requests_count", "bot_pull_request_count"]),
    avgIssueCloseSeconds: readNumber(payload, [
      "avg_time_to_close_issue",
      "average_time_to_close_issue",
    ]),
    avgPrCloseSeconds: readNumber(payload, [
      "avg_time_to_close_pull_request",
      "average_time_to_close_pull_request",
    ]),
    issueAuthors: readNumber(payload, ["issue_authors_count", "issues_authors_count"]),
    prAuthors: readNumber(payload, [
      "pull_request_authors_count",
      "pull_requests_authors_count",
    ]),
    openClosedRatio: null,
  };

  const openIssues = readNumber(payload, ["open_issues_count"]);
  const closedIssues = readNumber(payload, ["closed_issues_count"]);
  if (openIssues !== null && closedIssues !== null && closedIssues > 0) {
    issuePr.openClosedRatio = openIssues / closedIssues;
  }

  // Every field missing means ecosyste.ms has no usable data for this repo.
  const hasAnything = Object.values(issuePr).some((v) => v !== null);
  if (!hasAnything) return null;

  return {
    issuePr,
    sourceUpdatedAt: readString(payload, ["updated_at", "last_synced_at"]),
    fetchedAt,
  };
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
