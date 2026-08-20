-- Local-only fixture for checking the rendered report without spending GitHub
-- quota. Apply with:  npx wrangler d1 execute oss-health --local --file dev/seed-local.sql
-- Never applied to the remote database.

DELETE FROM contributor_metrics WHERE analysis_id = 'ana_devfixture0000001';
DELETE FROM activity_metrics    WHERE analysis_id = 'ana_devfixture0000001';
DELETE FROM issue_pr_metrics    WHERE analysis_id = 'ana_devfixture0000001';
DELETE FROM release_metrics     WHERE analysis_id = 'ana_devfixture0000001';
DELETE FROM security_metrics    WHERE analysis_id = 'ana_devfixture0000001';
DELETE FROM analyses            WHERE id = 'ana_devfixture0000001';
DELETE FROM repositories        WHERE lower(owner) = 'ggerganov' AND lower(name) = 'llama.cpp';

INSERT INTO repositories (
  github_repo_id, owner, name, canonical_url, description, stars, forks, watchers,
  archived, license, language, default_branch, open_issues,
  created_at, updated_at, pushed_at, last_fetched_at
) VALUES (
  612354784, 'ggerganov', 'llama.cpp', 'https://github.com/ggerganov/llama.cpp',
  'LLM inference in C/C++', 68421, 9873, 512,
  0, 'MIT', 'C++', 'master', 341,
  '2023-03-10T18:58:00Z', datetime('now'), datetime('now', '-2 days'), datetime('now', '-3 minutes')
);

INSERT INTO analyses (
  id, repository_id, status, health_score, score_coverage, status_label,
  maintenance_score, community_score, security_score, release_score, adoption_score,
  reasons_json, availability_json, freshness_json, unavailable_json,
  started_at, basic_ready_at, completed_at, algorithm_version, lock_expires_at
) VALUES (
  'ana_devfixture0000001',
  (SELECT id FROM repositories WHERE lower(owner)='ggerganov' AND lower(name)='llama.cpp'),
  'COMPLETE', 86, 1.0, 'ACTIVE',
  92, 81, 84, 89, 98,
  '{"categories":{"maintenance":{"score":92,"available":true,"signals":[{"type":"positive","text":"最終 Commit は 2日前"},{"type":"positive","text":"過去52週のうち 47 週で活動"},{"type":"info","text":"Issue の平均クローズ時間 12日"},{"type":"info","text":"PR の平均クローズ時間 4日"}]},"community_resilience":{"score":81,"available":true,"signals":[{"type":"positive","text":"実効 Contributor 31 人"},{"type":"positive","text":"直近1年の Active Contributor のうち 62% が継続的"},{"type":"warning","text":"Top3 Contributor の Commit 占有率 62%"},{"type":"positive","text":"Core Maintainer 14 人"}]},"security_hygiene":{"score":84,"available":true,"signals":[{"type":"positive","text":"OpenSSF Scorecard 8.4 / 10"},{"type":"warning","text":"OpenSSF Dependency-Update-Tool が低評価（2/10）"}]},"release_health":{"score":89,"available":true,"signals":[{"type":"info","text":"最新 Release「b4732」は 6日前"},{"type":"positive","text":"Release 間隔の中央値 5日に対し、経過は 1.2倍"}]},"adoption":{"score":98,"available":true,"signals":[{"type":"info","text":"68,421 stars / 9,873 forks"}]}},"headline":[{"type":"warning","text":"Top3 Contributor の Commit 占有率 62%"},{"type":"warning","text":"OpenSSF Dependency-Update-Tool が低評価（2/10）"},{"type":"positive","text":"最終 Commit は 2日前"},{"type":"positive","text":"実効 Contributor 31 人"},{"type":"positive","text":"OpenSSF Scorecard 8.4 / 10"}]}',
  '{"maintenance":{"available":true,"reason":null},"community_resilience":{"available":true,"reason":null},"security_hygiene":{"available":true,"reason":null},"release_health":{"available":true,"reason":null},"adoption":{"available":true,"reason":null}}',
  json_object(
    'github',   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 minutes'),
    'ecosystems', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-6 hours'),
    'openssf',  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days'),
    'score',    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 minutes')
  ),
  '["deps_dev"]',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-4 minutes'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-4 minutes'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 minutes'),
  '0.1.0', NULL
);

INSERT INTO contributor_metrics VALUES (
  'ana_devfixture0000001', 183, 48, 60, 37, 31, 14, 23, 7, 153,
  0.41, 0.28, 0.62, 0.71, strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 minutes')
);

INSERT INTO activity_metrics VALUES (
  'ana_devfixture0000001', 87, 241, 1042, 198, 47,
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'),
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 minutes')
);

INSERT INTO issue_pr_metrics VALUES (
  'ana_devfixture0000001', 5122, 4310, 3688, 412, 1036800, 345600, 2140, 1180, 0.12,
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 hours')
);

INSERT INTO release_metrics VALUES (
  'ana_devfixture0000001', 1,
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 days'), 'b4732', 6, 6, 5.0, 1.2,
  json_array(
    json_object('name','b4732','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 days')),
    json_object('name','b4726','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-11 days')),
    json_object('name','b4711','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-16 days')),
    json_object('name','b4698','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-22 days')),
    json_object('name','b4680','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-27 days')),
    json_object('name','b4661','publishedAt', strftime('%Y-%m-%dT%H:%M:%SZ','now','-33 days'))
  ),
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 minutes')
);

INSERT INTO security_metrics VALUES (
  'ana_devfixture0000001', 8.4,
  '[{"name":"Branch-Protection","score":9,"reason":"branch protection is enabled"},{"name":"Code-Review","score":9,"reason":"all changesets reviewed"},{"name":"Dependency-Update-Tool","score":2,"reason":"no update tool detected"},{"name":"Security-Policy","score":10,"reason":"security policy file detected"},{"name":"Maintained","score":10,"reason":"30 commit(s) and 12 issue activity in the last 90 days"},{"name":"Token-Permissions","score":6,"reason":"detected GitHub workflow tokens with excessive permissions"}]',
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days'),
  1, 0, NULL,
  strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days')
);
