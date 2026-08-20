import { readCounters, requestScope } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/metrics — the counters spec 30 asks for, for the current hour.
 *
 * `github_requests_per_analysis` is derived here because it is the single
 * number spec 30 singles out as the one to watch: if it drifts above 8, the
 * request budget is leaking somewhere.
 */
export async function GET(): Promise<Response> {
  const scope = await requestScope();
  const counters = await readCounters(scope.env.DB, Date.now());

  const analyses = counters.analysis_total ?? 0;
  const requestsSum = counters.github_requests_per_analysis_sum ?? 0;
  const hits = counters.analysis_cache_hit_total ?? 0;
  const misses = counters.analysis_cache_miss_total ?? 0;

  return Response.json(
    {
      window: "current_hour",
      counters,
      derived: {
        github_requests_per_analysis: analyses > 0 ? requestsSum / analyses : null,
        analysis_cache_hit_rate: hits + misses > 0 ? hits / (hits + misses) : null,
        analysis_partial_rate:
          analyses > 0 ? (counters.analysis_partial_total ?? 0) / analyses : null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
