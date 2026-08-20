/**
 * Every threshold, weight, TTL and timeout lives here.
 *
 * Spec section 39 requires that external-API limits and scoring thresholds are
 * not scattered through the code as literals, because both the upstream APIs and
 * the scoring model are expected to change.
 */

// 0.2.0 changed how the release interval is measured (see
// RELEASE_MIN_MEDIAN_INTERVAL_DAYS), so scores are not comparable with 0.1.0.
export const ALGORITHM_VERSION = "0.2.0";

export const DAY_SECONDS = 86_400;

/** Category weights for the overall Health Score (spec 9.2). */
export const CATEGORY_WEIGHTS = {
  maintenance: 0.3,
  community_resilience: 0.25,
  security_hygiene: 0.2,
  release_health: 0.15,
  adoption: 0.1,
} as const;

export type CategoryKey = keyof typeof CATEGORY_WEIGHTS;

export const CATEGORY_ORDER: readonly CategoryKey[] = [
  "maintenance",
  "community_resilience",
  "security_hygiene",
  "release_health",
  "adoption",
];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  maintenance: "Maintenance",
  community_resilience: "Community Resilience",
  security_hygiene: "Security Hygiene",
  release_health: "Release Health",
  adoption: "Adoption",
};

/** Score bands (spec 9.4). `min` is inclusive. */
export const SCORE_BANDS = [
  { min: 85, label: "Excellent" },
  { min: 70, label: "Healthy" },
  { min: 55, label: "Mixed" },
  { min: 40, label: "Caution" },
  { min: 0, label: "High Risk / Low Confidence" },
] as const;

/** Maintenance sub-weights (spec 10.4). */
export const MAINTENANCE_WEIGHTS = {
  commit_recency: 0.45,
  activity_continuity: 0.25,
  issue_health: 0.15,
  pr_health: 0.15,
} as const;

/** Commit recency ladder in days (spec 10.1). Evaluated top-down. */
export const COMMIT_RECENCY_LADDER = [
  { maxDays: 7, score: 100 },
  { maxDays: 30, score: 90 },
  { maxDays: 90, score: 75 },
  { maxDays: 180, score: 55 },
  { maxDays: 365, score: 35 },
  { maxDays: Infinity, score: 15 },
] as const;

/**
 * Close-time ladders for issue / PR health (spec 10.3). The spec leaves the
 * exact mapping open; these are the MVP starting values to be tuned against
 * real data (spec 37 step 10).
 */
export const CLOSE_TIME_LADDER_DAYS = [
  { maxDays: 7, score: 100 },
  { maxDays: 30, score: 85 },
  { maxDays: 90, score: 65 },
  { maxDays: 180, score: 45 },
  { maxDays: Infinity, score: 25 },
] as const;

/** Community Resilience sub-weights (spec 11.1). */
export const COMMUNITY_WEIGHTS = {
  effective_contributors: 0.35,
  repeat_ratio: 0.25,
  top3_concentration: 0.25,
  core_maintainers: 0.15,
} as const;

/** Effective contributor count ladder (spec 11.2). Deliberately non-linear. */
export const EFFECTIVE_CONTRIBUTOR_LADDER = [
  { max: 0, score: 0 },
  { max: 1, score: 30 },
  { max: 3, score: 50 },
  { max: 7, score: 70 },
  { max: 15, score: 85 },
  { max: Infinity, score: 100 },
] as const;

/** Core maintainer count ladder — same shape, slightly stricter. */
export const CORE_MAINTAINER_LADDER = [
  { max: 0, score: 0 },
  { max: 1, score: 35 },
  { max: 2, score: 55 },
  { max: 4, score: 75 },
  { max: 8, score: 90 },
  { max: Infinity, score: 100 },
] as const;

/** Top-3 concentration → score (spec 11.4). Lower share scores higher. */
export const TOP3_CONCENTRATION_LADDER = [
  { maxShare: 0.35, score: 100 },
  { maxShare: 0.5, score: 85 },
  { maxShare: 0.65, score: 65 },
  { maxShare: 0.8, score: 40 },
  { maxShare: Infinity, score: 20 },
] as const;

/** Concentration bands shown in the UI (spec 8.3). */
export const CONCENTRATION_BANDS = [
  { maxShare: 0.4, tone: "good", label: "分散" },
  { maxShare: 0.65, tone: "warn", label: "やや集中" },
  { maxShare: 0.85, tone: "high", label: "高集中" },
  { maxShare: Infinity, tone: "bad", label: "非常に高集中" },
] as const;

/** Release delay ratio ladder (spec 13.3). */
export const RELEASE_DELAY_LADDER = [
  { maxRatio: 1.0, score: 100 },
  { maxRatio: 1.5, score: 90 },
  { maxRatio: 2.0, score: 70 },
  { maxRatio: 3.0, score: 45 },
  { maxRatio: Infinity, score: 20 },
] as const;

/** Adoption sub-weights and the log star curve (spec 14.1). */
export const ADOPTION_WEIGHTS = { stars: 0.8, forks: 0.2 } as const;
export const STAR_SCORE_COEFFICIENT = 20;
export const FORK_SCORE_COEFFICIENT = 25;

/** Contributor classification windows (spec 6). */
export const CONTRIBUTOR_RULES = {
  activeWindowDays: 90,
  longWindowDays: 365,
  repeatMinCommits: 2,
  repeatMinActiveWeeks: 2,
  coreMinCommits: 5,
  coreMinActiveWeeks: 3,
  /** How many release *days* to sample for the median interval (spec 13.2). */
  releaseSampleSize: 6,
} as const;

/**
 * Lower bound on the median release interval, in days.
 *
 * Calibrated against 27 well-known repositories on 2026-08-20. Without a floor,
 * a project that ships several releases in quick succession gets a near-zero
 * divisor and is then reported as thousands of times late: facebook/react
 * measured a ratio of 141,733 and openssl 13,064, and 8 of 24 repositories
 * landed on the floor score of 20 — the metric was reporting release frequency,
 * not lateness. Flooring the divisor at two weeks means "recently released" can
 * never read as overdue.
 */
export const RELEASE_MIN_MEDIAN_INTERVAL_DAYS = 14;

/** Cache TTLs in seconds (spec 18.1). */
export const CACHE_TTL_SECONDS = {
  basic: 60 * 60,
  health: 6 * 60 * 60,
  openssf: 24 * 60 * 60,
  ecosystems: 6 * 60 * 60,
  release: 6 * 60 * 60,
} as const;

/** Timeouts in milliseconds (spec 21.4). */
export const TIMEOUTS_MS = {
  githubBasic: 3_000,
  // Enough to read a few MB of gzip-encoded statistics; the byte cap, not the
  // clock, is what protects memory.
  githubStats: 6_000,
  externalEnrichment: 3_000,
} as const;

/**
 * GitHub statistics endpoints answer `202 Accepted` while the stats are being
 * generated. Retry offsets in ms (spec 19.2); the total budget is ~7-8s.
 */
export const STATS_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000] as const;
export const STATS_TOTAL_BUDGET_MS = 8_000;

/**
 * Hard cap on the `stats/contributors` response body.
 *
 * Measured 2026-08-20: the endpoint returns every contributor's full weekly
 * history, which is 3.1 MB for vitejs/vite, 8.1 MB for expressjs/express,
 * 29 MB for kubernetes/kubernetes, 62 MB for curl/curl and 71 MB for
 * torvalds/linux. A Cloudflare Worker has 128 MB of isolate memory and a CPU
 * time limit, so anything in that upper range cannot be parsed at all. Above
 * this cap the response is abandoned unread and contributor metrics come from
 * the ecosyste.ms aggregation instead.
 */
export const STATS_MAX_BYTES = 4 * 1024 * 1024;

/** GitHub request budget per uncached analysis (spec 20.3). */
export const GITHUB_REQUEST_BUDGET = { typical: 8, hardCap: 12 } as const;

/** Analysis lock TTL — an abandoned analysis must not block the repo forever. */
export const ANALYSIS_LOCK_TTL_SECONDS = 30;

/** Default self-imposed rate limit, overridable via OSSHS_RATE_LIMIT_PER_HOUR. */
export const DEFAULT_RATE_LIMIT_PER_HOUR = 10;

/** Circuit breaker per external source (spec 21.5). */
export const CIRCUIT_BREAKER = {
  failureThreshold: 5,
  openDurationMs: 60_000,
} as const;

/**
 * Logins known to be automation. GitHub's own `type: "Bot"` and the `[bot]`
 * login suffix cover most cases; this list catches accounts that are bots but
 * are not typed as such (spec 7.2).
 */
export const KNOWN_BOT_LOGINS: readonly string[] = [
  "dependabot",
  "renovate",
  "greenkeeper",
  "snyk-bot",
  "imgbot",
  "allcontributors",
  "codecov",
  "mergify",
  "stale",
  "semantic-release-bot",
  "github-actions",
  "pre-commit-ci",
  "whitesource-bolt-for-github",
  "restyled-io",
  "sonarcloud",
  "step-security-bot",
];

/**
 * Accounts that are explicitly identified AI coding agents (spec 7.3).
 * Only accounts whose identity is an agent belong here. A human using an AI
 * assistant is never classified from this list — see spec 7.4.
 */
export const KNOWN_AI_AGENT_LOGINS: readonly string[] = [
  "copilot-swe-agent",
  "copilot",
  "github-copilot",
  "devin-ai-integrated",
  "sweep-ai",
  "codegen-sh",
  "openhands-agent",
  "cursoragent",
  "jules-agent",
  "codex-agent",
];

/** External API base URLs — kept here so they can be swapped or stubbed. */
export const ENDPOINTS = {
  github: "https://api.github.com",
  ecosystemsRepos: "https://repos.ecosyste.ms/api/v1",
  ecosystemsIssues: "https://issues.ecosyste.ms/api/v1",
  openssf: "https://api.securityscorecards.dev",
} as const;

export const USER_AGENT = "oss-health-scanner/0.1 (+https://github.com)";
