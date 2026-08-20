-- OSS Repository Health Scanner — initial schema (spec section 24).
-- All timestamps are stored as ISO-8601 UTC strings; all durations in seconds.

CREATE TABLE repositories (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  github_repo_id    INTEGER,
  owner             TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  canonical_url     TEXT    NOT NULL,
  description       TEXT,
  stars             INTEGER,
  forks             INTEGER,
  watchers          INTEGER,
  archived          INTEGER NOT NULL DEFAULT 0,
  license           TEXT,
  language          TEXT,
  default_branch    TEXT,
  open_issues       INTEGER,
  created_at        TEXT,
  updated_at        TEXT,
  pushed_at         TEXT,
  last_fetched_at   TEXT
);

-- Repository identity is the lowercased owner/name pair; GitHub treats these
-- case-insensitively, so the cache must too.
CREATE UNIQUE INDEX repositories_owner_name ON repositories (owner, name);

CREATE TABLE analyses (
  id                   TEXT    PRIMARY KEY,
  repository_id        INTEGER NOT NULL REFERENCES repositories (id),
  status               TEXT    NOT NULL,
  health_score         INTEGER,
  score_coverage       REAL,
  status_label         TEXT,

  maintenance_score    INTEGER,
  community_score      INTEGER,
  security_score       INTEGER,
  release_score        INTEGER,
  adoption_score       INTEGER,

  -- Per-category signals/reasons so the UI can answer "why this score?" (spec 26).
  reasons_json         TEXT,
  -- Category weights that were actually available, for coverage display (spec 27).
  availability_json    TEXT,
  -- Per-source fetch timestamps for the Data freshness panel (spec 16.6).
  freshness_json       TEXT,
  unavailable_json     TEXT,
  error_code           TEXT,

  started_at           TEXT    NOT NULL,
  basic_ready_at       TEXT,
  completed_at         TEXT,
  algorithm_version    TEXT    NOT NULL,

  -- Analysis lock for same-repository deduplication (spec 17.3 / 21.2).
  lock_expires_at      INTEGER
);

CREATE INDEX analyses_repository_started ON analyses (repository_id, started_at DESC);

CREATE TABLE contributor_metrics (
  analysis_id            TEXT PRIMARY KEY REFERENCES analyses (id),
  raw_contributors       INTEGER,
  active_90d             INTEGER,
  active_365d            INTEGER,
  repeat_365d            INTEGER,
  effective_contributors INTEGER,
  core_maintainers       INTEGER,
  bot_contributors       INTEGER,
  known_ai_agents        INTEGER,
  human_unknown          INTEGER,
  one_shot_ratio         REAL,
  top1_share             REAL,
  top3_share             REAL,
  top5_share             REAL,
  source_updated_at      TEXT
);

CREATE TABLE activity_metrics (
  analysis_id       TEXT PRIMARY KEY REFERENCES analyses (id),
  commits_30d       INTEGER,
  commits_90d       INTEGER,
  commits_365d      INTEGER,
  commits_prev_90d  INTEGER,
  active_weeks_365d INTEGER,
  last_commit_at    TEXT,
  source_updated_at TEXT
);

CREATE TABLE issue_pr_metrics (
  analysis_id             TEXT PRIMARY KEY REFERENCES analyses (id),
  total_issues            INTEGER,
  total_prs               INTEGER,
  merged_prs              INTEGER,
  bot_prs                 INTEGER,
  avg_issue_close_seconds INTEGER,
  avg_pr_close_seconds    INTEGER,
  issue_authors           INTEGER,
  pr_authors              INTEGER,
  open_closed_ratio       REAL,
  source_updated_at       TEXT
);

CREATE TABLE release_metrics (
  analysis_id           TEXT PRIMARY KEY REFERENCES analyses (id),
  has_releases          INTEGER,
  latest_release_at     TEXT,
  latest_release_name   TEXT,
  latest_release_age    INTEGER,
  release_count_sample  INTEGER,
  median_interval_days  REAL,
  release_delay_ratio   REAL,
  recent_releases_json  TEXT,
  source_updated_at     TEXT
);

CREATE TABLE security_metrics (
  analysis_id         TEXT PRIMARY KEY REFERENCES analyses (id),
  openssf_score       REAL,
  openssf_checks_json TEXT,
  openssf_date        TEXT,
  license_present     INTEGER,
  deps_data_available INTEGER,
  vulnerability_count INTEGER,
  source_updated_at   TEXT
);

-- Self-imposed per-IP rate limiting (spec 21.1). One row per IP per hour bucket.
CREATE TABLE rate_limit_buckets (
  client_key  TEXT    NOT NULL,
  bucket      INTEGER NOT NULL,
  hits        INTEGER NOT NULL,
  PRIMARY KEY (client_key, bucket)
);

-- Observability counters (spec 30). Aggregated per hour bucket to stay cheap.
CREATE TABLE metric_counters (
  name   TEXT    NOT NULL,
  bucket INTEGER NOT NULL,
  value  REAL    NOT NULL,
  PRIMARY KEY (name, bucket)
);
