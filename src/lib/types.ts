import type { CategoryKey } from "./config";

/** Analysis state machine (spec 23). */
export type AnalysisStatus =
  | "QUEUED"
  | "FETCHING_BASIC"
  | "FETCHING_ACTIVITY"
  | "FETCHING_SECURITY"
  | "SCORING"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

/** Repository status label, independent of the score (spec 15.1). */
export type StatusLabel =
  | "ACTIVE"
  | "LOW_CHANGE"
  | "STALE"
  | "ARCHIVED"
  | "INDETERMINATE";

/** Contributor classification (spec 7.1). */
export type ContributorType = "HUMAN_OR_UNKNOWN" | "BOT" | "KNOWN_AI_AGENT";

export type RepoRef = { owner: string; repo: string };

export type RepositoryBasic = {
  githubRepoId: number | null;
  owner: string;
  name: string;
  canonicalUrl: string;
  description: string | null;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  archived: boolean;
  license: string | null;
  language: string | null;
  defaultBranch: string | null;
  openIssues: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
};

export type ContributorMetrics = {
  rawContributors: number;
  active90d: number;
  active365d: number;
  repeat365d: number;
  effectiveContributors: number;
  coreMaintainers: number;
  botContributors: number;
  knownAiAgents: number;
  humanUnknown: number;
  oneShotRatio: number | null;
  top1Share: number | null;
  top3Share: number | null;
  top5Share: number | null;
};

export type ActivityMetrics = {
  commits30d: number;
  commits90d: number;
  commits365d: number;
  commitsPrev90d: number;
  activeWeeks365d: number;
  lastCommitAt: string | null;
};

export type IssuePrMetrics = {
  totalIssues: number | null;
  totalPrs: number | null;
  mergedPrs: number | null;
  botPrs: number | null;
  avgIssueCloseSeconds: number | null;
  avgPrCloseSeconds: number | null;
  issueAuthors: number | null;
  prAuthors: number | null;
  openClosedRatio: number | null;
};

export type ReleaseSummary = { name: string; publishedAt: string };

export type ReleaseMetrics = {
  hasReleases: boolean;
  latestReleaseAt: string | null;
  latestReleaseName: string | null;
  latestReleaseAgeDays: number | null;
  releaseCountSample: number;
  medianIntervalDays: number | null;
  releaseDelayRatio: number | null;
  recentReleases: ReleaseSummary[];
};

export type OpenssfCheck = {
  name: string;
  score: number | null;
  reason: string | null;
};

export type SecurityMetrics = {
  openssfScore: number | null;
  openssfChecks: OpenssfCheck[];
  openssfDate: string | null;
  licensePresent: boolean;
  depsDataAvailable: boolean;
  vulnerabilityCount: number | null;
};

/** A single explanation attached to a category score (spec 26). */
export type Signal = {
  type: "positive" | "warning" | "negative" | "info";
  text: string;
};

export type CategoryResult = {
  score: number | null;
  available: boolean;
  /** Why the category is unavailable, shown verbatim in the UI. */
  unavailableReason?: string;
  signals: Signal[];
};

export type ScoreResult = {
  healthScore: number | null;
  coverage: number;
  statusLabel: StatusLabel;
  categories: Record<CategoryKey, CategoryResult>;
  /** Cross-category signals surfaced in the first view (spec 16.2). */
  headlineSignals: Signal[];
  algorithmVersion: string;
};

export type SourceName = "github" | "ecosystems" | "openssf" | "deps_dev";

export type Freshness = Partial<Record<SourceName | "score", string>>;

export type AnalysisRecord = {
  analysisId: string;
  status: AnalysisStatus;
  repository: RepositoryBasic;
  scores: ScoreResult | null;
  contributors: ContributorMetrics | null;
  activity: ActivityMetrics | null;
  issuePr: IssuePrMetrics | null;
  release: ReleaseMetrics | null;
  security: SecurityMetrics | null;
  freshness: Freshness;
  unavailable: SourceName[];
  cached: boolean;
  startedAt: string;
  basicReadyAt: string | null;
  completedAt: string | null;
  algorithmVersion: string;
  errorCode: string | null;
};
