import { CACHE_TTL_SECONDS, ENDPOINTS, TIMEOUTS_MS } from "../config";
import { fetchJson } from "../http";
import type { OpenssfCheck, RepoRef } from "../types";

type ScorecardResponse = {
  date?: string;
  score?: number;
  checks?: { name?: string; score?: number; reason?: string | null }[];
};

export type OpenssfResult = {
  score: number;
  checks: OpenssfCheck[];
  date: string | null;
  fetchedAt: string;
};

/** Checks surfaced individually in the Security card (spec 16.5). */
export const HIGHLIGHTED_CHECKS: readonly string[] = [
  "Branch-Protection",
  "Code-Review",
  "Dependency-Update-Tool",
  "Security-Policy",
  "Maintained",
  "Vulnerabilities",
  "Token-Permissions",
  "Dangerous-Workflow",
];

/**
 * OpenSSF publishes Scorecard results for repositories it has scanned. Absence
 * is common and is not a security finding: spec 12.2 requires reporting it as
 * N/A with a reason, never as a zero.
 */
export async function fetchScorecard(ref: RepoRef): Promise<OpenssfResult | null> {
  const url = `${ENDPOINTS.openssf}/projects/github.com/${ref.owner}/${ref.repo}`;
  const { data, fetchedAt } = await fetchJson<ScorecardResponse>(url, {
    source: "openssf",
    timeoutMs: TIMEOUTS_MS.externalEnrichment,
    cacheTtlSeconds: CACHE_TTL_SECONDS.openssf,
    treatAsMissing: [404],
  });

  if (!data || typeof data.score !== "number") return null;

  const checks: OpenssfCheck[] = (data.checks ?? [])
    .filter((c): c is { name: string; score?: number; reason?: string | null } =>
      typeof c.name === "string",
    )
    .map((c) => ({
      name: c.name,
      // OpenSSF uses -1 for "could not determine", which is not a low score.
      // Treating it as 0-ish would report a check as failing when it was never
      // evaluated — the same mistake as scoring a missing category as zero.
      score: typeof c.score === "number" && c.score >= 0 ? c.score : null,
      reason: c.reason ?? null,
    }));

  return { score: data.score, checks, date: data.date ?? null, fetchedAt };
}
