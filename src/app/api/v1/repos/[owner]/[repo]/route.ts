import { errorResponse, serializeAnalysis } from "@/lib/api";
import { findRepository, isFresh, loadLatestAnalysis, requestScope } from "@/lib/store";
import { normalizeRepoUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/repos/{owner}/{repo} — spec 22.3.
 *
 * Read-only: returns the stored analysis if one exists and never triggers a new
 * one, so it cannot be used to bypass the rate limit on /analyze.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const { owner, repo } = await context.params;
  const normalized = normalizeRepoUrl(`https://github.com/${owner}/${repo}`);
  if (!normalized.ok) {
    return errorResponse("INVALID_URL", "Invalid owner/repo.");
  }

  const scope = await requestScope();
  const existing = await findRepository(scope.env.DB, normalized.ref);
  if (!existing) {
    return errorResponse("ANALYSIS_NOT_FOUND", "This repository has not been analyzed yet.");
  }

  const latest = await loadLatestAnalysis(scope.env.DB, existing.id);
  if (!latest) {
    return errorResponse("ANALYSIS_NOT_FOUND", "This repository has not been analyzed yet.");
  }

  return Response.json(
    { ...(serializeAnalysis(latest, true) as Record<string, unknown>), fresh: isFresh(latest, new Date()) },
    { headers: { "cache-control": "no-store" } },
  );
}
