import type { CategoryKey } from "./config";
import type {
  ActivityMetrics,
  ContributorMetrics,
  Freshness,
  IssuePrMetrics,
  ReleaseMetrics,
  SecurityMetrics,
  Signal,
  SourceName,
  StatusLabel,
} from "./types";

/** The wire shape produced by `serializeAnalysis`. */
export type AnalysisPayload = {
  analysis_id: string;
  status:
    | "queued"
    | "fetching_basic"
    | "fetching_activity"
    | "fetching_security"
    | "scoring"
    | "complete"
    | "partial"
    | "failed";
  cached: boolean;
  repository: {
    owner: string;
    name: string;
    canonical_url: string;
    description: string | null;
    stars: number | null;
    forks: number | null;
    watchers: number | null;
    archived: boolean;
    license: string | null;
    language: string | null;
    default_branch: string | null;
    open_issues: number | null;
    created_at: string | null;
    updated_at: string | null;
    pushed_at: string | null;
  };
  coverage: number | null;
  health_score: number | null;
  status_label: StatusLabel | null;
  algorithm_version: string;
  scores: Record<CategoryKey, number | null> | null;
  categories: Record<
    CategoryKey,
    {
      score: number | null;
      available: boolean;
      unavailable_reason: string | null;
      signals: Signal[];
    }
  > | null;
  headline_signals: Signal[];
  contributors: ContributorMetrics | null;
  activity: ActivityMetrics | null;
  issue_pr: IssuePrMetrics | null;
  release: ReleaseMetrics | null;
  security: SecurityMetrics | null;
  freshness: Freshness;
  diagnostics: Record<string, { outcome: string; detail?: string }>;
  unavailable: SourceName[];
  started_at: string;
  basic_ready_at: string | null;
  completed_at: string | null;
};

export type ApiError = {
  error: { code: string; reason?: string; message: string };
};

export const TERMINAL_STATUSES = new Set(["complete", "partial", "failed"]);
