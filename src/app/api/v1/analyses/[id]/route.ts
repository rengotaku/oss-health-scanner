import { errorResponse, serializeAnalysis } from "@/lib/api";
import { loadAnalysis, requestScope } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/v1/analyses/{analysis_id} — spec 22.2. Polled by the client. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const scope = await requestScope();
  const record = await loadAnalysis(scope.env.DB, id);
  if (!record) {
    return errorResponse("ANALYSIS_NOT_FOUND", "No analysis with that id.");
  }
  return Response.json(serializeAnalysis(record, false), {
    headers: { "cache-control": "no-store" },
  });
}
