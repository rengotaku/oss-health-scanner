import { CATEGORY_ORDER } from "./config";
import type { AnalysisRecord } from "./types";
import { NORMALIZE_MESSAGE, type NormalizeError } from "./url";

export type ApiErrorCode =
  | "INVALID_URL"
  | "REPOSITORY_NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_RATE_LIMITED"
  | "TOKEN_MISSING"
  | "ANALYSIS_NOT_FOUND"
  | "INTERNAL";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  INVALID_URL: 400,
  REPOSITORY_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_RATE_LIMITED: 503,
  TOKEN_MISSING: 500,
  ANALYSIS_NOT_FOUND: 404,
  INTERNAL: 500,
};

export function errorResponse(code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: STATUS_BY_CODE[code] });
}

export function invalidUrlResponse(reason: NormalizeError): Response {
  return Response.json(
    { error: { code: "INVALID_URL", reason, message: NORMALIZE_MESSAGE } },
    { status: 400 },
  );
}

/** Serialises an analysis for the client (spec 22.2). */
export function serializeAnalysis(record: AnalysisRecord, cached: boolean): unknown {
  return {
    analysis_id: record.analysisId,
    status: record.status.toLowerCase(),
    cached,
    repository: {
      owner: record.repository.owner,
      name: record.repository.name,
      canonical_url: record.repository.canonicalUrl,
      description: record.repository.description,
      stars: record.repository.stars,
      forks: record.repository.forks,
      watchers: record.repository.watchers,
      archived: record.repository.archived,
      license: record.repository.license,
      language: record.repository.language,
      default_branch: record.repository.defaultBranch,
      open_issues: record.repository.openIssues,
      created_at: record.repository.createdAt,
      updated_at: record.repository.updatedAt,
      pushed_at: record.repository.pushedAt,
    },
    coverage: record.scores?.coverage ?? null,
    health_score: record.scores?.healthScore ?? null,
    status_label: record.scores?.statusLabel ?? null,
    algorithm_version: record.algorithmVersion,
    scores: record.scores
      ? Object.fromEntries(
          CATEGORY_ORDER.map((key) => [key, record.scores!.categories[key].score]),
        )
      : null,
    categories: record.scores
      ? Object.fromEntries(
          CATEGORY_ORDER.map((key) => {
            const category = record.scores!.categories[key];
            return [
              key,
              {
                score: category.score,
                available: category.available,
                unavailable_reason: category.unavailableReason ?? null,
                signals: category.signals,
              },
            ];
          }),
        )
      : null,
    headline_signals: record.scores?.headlineSignals ?? [],
    contributors: record.contributors,
    activity: record.activity,
    issue_pr: record.issuePr,
    release: record.release,
    security: record.security,
    freshness: record.freshness,
    unavailable: record.unavailable,
    started_at: record.startedAt,
    basic_ready_at: record.basicReadyAt,
    completed_at: record.completedAt,
  };
}

/** Best-effort client identity for rate limiting (spec 21.1). */
export function clientKey(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}
