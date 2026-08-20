import { AnalysisLockedError, startAnalysis } from "@/lib/analysis";
import { clientKey, errorResponse, invalidUrlResponse, serializeAnalysis } from "@/lib/api";
import {
  GithubRateLimitedError,
  GithubTokenMissingError,
  RepositoryNotFoundError,
} from "@/lib/sources/github";
import {
  bumpCounters,
  consumeRateLimit,
  findRepository,
  isFresh,
  loadLatestAnalysis,
  rateLimitPerHour,
  requestScope,
} from "@/lib/store";
import { normalizeRepoUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/analyze — spec 22.1.
 *
 * Returns as soon as the basic card can be rendered. A fresh cached analysis is
 * returned immediately and costs no GitHub quota (spec 18 / 20.4).
 */
export async function POST(request: Request): Promise<Response> {
  let payload: { url?: unknown };
  try {
    payload = (await request.json()) as { url?: unknown };
  } catch {
    return errorResponse("INVALID_URL", "Request body must be JSON with a `url` field.");
  }
  if (typeof payload.url !== "string") {
    return errorResponse("INVALID_URL", "`url` must be a string.");
  }

  const normalized = normalizeRepoUrl(payload.url);
  if (!normalized.ok) return invalidUrlResponse(normalized.reason);

  const scope = await requestScope();
  const bindings = scope.env;
  const now = new Date();

  // A cache hit must not be charged against the rate limit: the limit exists to
  // protect the GitHub quota, and a cache hit spends none (spec 20.4).
  const existing = await findRepository(bindings.DB, normalized.ref);
  if (existing) {
    const latest = await loadLatestAnalysis(bindings.DB, existing.id);
    if (latest && isFresh(latest, now)) {
      await bumpCounters(
        bindings.DB,
        [{ name: "analysis_cache_hit_total", value: 1 }],
        now.getTime(),
      );
      return Response.json(serializeAnalysis(latest, true));
    }
  }

  const limit = rateLimitPerHour(bindings);
  const rate = await consumeRateLimit(bindings.DB, clientKey(request), limit, now.getTime());
  if (!rate.allowed) {
    // A stale cached result beats an error when the caller is over the limit.
    if (existing) {
      const latest = await loadLatestAnalysis(bindings.DB, existing.id);
      if (latest) return Response.json(serializeAnalysis(latest, true));
    }
    return errorResponse(
      "RATE_LIMITED",
      `1時間あたりの解析上限（${limit} 件）に達しました。しばらく待って再試行してください。`,
    );
  }

  const token = bindings.GITHUB_TOKEN;
  if (!token) {
    return errorResponse(
      "TOKEN_MISSING",
      "GITHUB_TOKEN is not configured on the server, so analysis is unavailable.",
    );
  }

  try {
    const record = await startAnalysis({
      db: bindings.DB,
      token,
      ref: normalized.ref,
      waitUntil: scope.waitUntil,
    });
    await bumpCounters(
      bindings.DB,
      [
        { name: "analysis_cache_miss_total", value: 1 },
        { name: "new_repositories_total", value: existing ? 0 : 1 },
      ],
      now.getTime(),
    );
    return Response.json(serializeAnalysis(record, false));
  } catch (error) {
    if (error instanceof RepositoryNotFoundError) {
      return errorResponse(
        "REPOSITORY_NOT_FOUND",
        "Repository not found or not publicly accessible.",
      );
    }
    if (error instanceof GithubRateLimitedError) {
      // Spec 28: prefer a cached result over an error when the upstream limit hits.
      if (existing) {
        const latest = await loadLatestAnalysis(bindings.DB, existing.id);
        if (latest) return Response.json(serializeAnalysis(latest, true));
      }
      return errorResponse("UPSTREAM_RATE_LIMITED", "Analysis is temporarily unavailable.");
    }
    if (error instanceof GithubTokenMissingError) {
      return errorResponse("TOKEN_MISSING", error.message);
    }
    if (error instanceof AnalysisLockedError) {
      return errorResponse("INTERNAL", "Analysis is already running; retry shortly.");
    }
    console.error("analyze failed", error);
    return errorResponse("INTERNAL", "Analysis is temporarily unavailable.");
  }
}
