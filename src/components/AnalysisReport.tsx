"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AnalysisPayload, ApiError } from "@/lib/client-types";
import { TERMINAL_STATUSES } from "@/lib/client-types";
import { CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_WEIGHTS } from "@/lib/config";
import {
  agoFmt,
  concentrationBand,
  dateFmt,
  daysFmt,
  intFmt,
  pctFmt,
  secondsToDaysFmt,
} from "@/lib/format";
import { bandFor } from "@/lib/score";
import { STATUS_COPY } from "@/lib/score/status";
import { Panel, Row, SignalList, Ticks } from "./primitives";

const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 60_000;

const STAGE_COPY: Record<string, string> = {
  queued: "Queued",
  fetching_basic: "Fetching repository metadata",
  fetching_activity: "Fetching activity & contributors",
  fetching_security: "Fetching security & release data",
  scoring: "Scoring",
};

type State =
  | { phase: "loading" }
  | { phase: "error"; code: string; message: string }
  | { phase: "data"; payload: AnalysisPayload };

/**
 * Drives one analysis and renders it progressively (spec 2 / 19.1): the basic
 * card appears as soon as `/analyze` returns, and the detail panels fill in as
 * polling picks up the health stage.
 */
export function AnalysisReport({ owner, repo }: { owner: string; repo: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const startedAt = Date.now();

    async function poll(analysisId: string): Promise<void> {
      while (!cancelled.current && Date.now() - startedAt < POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled.current) return;
        const response = await fetch(`/api/v1/analyses/${analysisId}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as AnalysisPayload;
        if (cancelled.current) return;
        setState({ phase: "data", payload });
        if (TERMINAL_STATUSES.has(payload.status)) return;
      }
    }

    void (async () => {
      try {
        const response = await fetch("/api/v1/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `https://github.com/${owner}/${repo}` }),
        });
        const body = (await response.json()) as AnalysisPayload | ApiError;
        if (cancelled.current) return;

        if (!response.ok || "error" in body) {
          const error = (body as ApiError).error;
          setState({
            phase: "error",
            code: error?.code ?? "INTERNAL",
            message: error?.message ?? "Analysis is temporarily unavailable.",
          });
          return;
        }

        setState({ phase: "data", payload: body });
        if (!TERMINAL_STATUSES.has(body.status)) await poll(body.analysis_id);
      } catch {
        if (!cancelled.current) {
          setState({
            phase: "error",
            code: "NETWORK",
            message: "サーバーに到達できませんでした。",
          });
        }
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [owner, repo]);

  if (state.phase === "loading") {
    return (
      <>
        <ReportHead owner={owner} repo={repo} />
        <Progress stage="queued" />
      </>
    );
  }

  if (state.phase === "error") {
    return <Failure code={state.code} message={state.message} />;
  }

  return <Report payload={state.payload} />;
}

function ReportHead({ owner, repo }: { owner: string; repo: string }) {
  return (
    <header className="report__head">
      <p className="report__breadcrumb">
        {owner} /{" "}
        <a href={`https://github.com/${owner}/${repo}`} rel="noreferrer noopener" target="_blank">
          github.com
        </a>
      </p>
      <h1 className="report__name">{repo}</h1>
    </header>
  );
}

function Progress({ stage }: { stage: string }) {
  return (
    <div className="progress" role="status" aria-live="polite">
      <span className="progress__pulse" />
      {STAGE_COPY[stage] ?? "Working"}
    </div>
  );
}

function Failure({ code, message }: { code: string; message: string }) {
  const title =
    code === "REPOSITORY_NOT_FOUND"
      ? "Repository が見つかりません"
      : code === "RATE_LIMITED"
        ? "解析の上限に達しました"
        : code === "TOKEN_MISSING"
          ? "サーバー設定が未完了です"
          : "解析できませんでした";
  return (
    <section className="failure">
      <p className="failure__code">{code}</p>
      <h1 className="failure__title">{title}</h1>
      <p className="failure__body">{message}</p>
      <p className="failure__body">
        <Link href="/">別の Repository を試す</Link>
      </p>
    </section>
  );
}

function Report({ payload }: { payload: AnalysisPayload }) {
  const repo = payload.repository;
  const status = payload.status_label;
  const statusCopy = status ? STATUS_COPY[status] : null;
  const inFlight = !TERMINAL_STATUSES.has(payload.status);

  return (
    <>
      <header className="report__head">
        <p className="report__breadcrumb">
          {repo.owner} /{" "}
          <a href={repo.canonical_url} rel="noreferrer noopener" target="_blank">
            github.com
          </a>
        </p>
        <h1 className="report__name">{repo.name}</h1>
        {repo.description && <p className="report__desc">{repo.description}</p>}
        {statusCopy && (
          <>
            <span className={`stamp stamp--${status!.toLowerCase()}`}>{statusCopy.label}</span>
            <p className="stamp__note">{statusCopy.note}</p>
          </>
        )}
      </header>

      {inFlight && <Progress stage={payload.status} />}

      <Verdict payload={payload} />

      <div className="panels">
        <BasicPanel payload={payload} />
        <CommunityPanel payload={payload} />
        <ActivityPanel payload={payload} />
        <SecurityPanel payload={payload} />
        <ReleasePanel payload={payload} />
        <FreshnessPanel payload={payload} />
      </div>

      <footer className="footer">
        <span>Scoring model v{payload.algorithm_version}</span>
        <span>Analysis {payload.analysis_id}</span>
        <span>{payload.cached ? "Served from cache" : "Freshly analyzed"}</span>
      </footer>
    </>
  );
}

/** Overall score, coverage and the per-category gauges (spec 16.2). */
function Verdict({ payload }: { payload: AnalysisPayload }) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const score = payload.health_score;
  const coverage = payload.coverage;

  return (
    <section className="verdict">
      <div>
        <div className="verdict__figure">
          <span className="verdict__value">{score === null ? "—" : score}</span>
          <span className="verdict__of">/ 100</span>
        </div>
        <p className="verdict__band">{score === null ? "Pending" : bandFor(score)}</p>
        <div className="verdict__coverage">
          <span>
            Score coverage {coverage === null ? "—" : `${Math.round(coverage * 100)}%`}
          </span>
          <span>Analyzed {agoFmt(payload.completed_at ?? payload.started_at) ?? "—"}</span>
        </div>
      </div>

      <div>
        <div className="gauges">
          {CATEGORY_ORDER.map((key) => {
            const category = payload.categories?.[key];
            const open = openCategory === key;
            return (
              <div key={key}>
                <button
                  type="button"
                  className="gauge"
                  aria-expanded={open}
                  onClick={() => setOpenCategory(open ? null : key)}
                >
                  <span className="gauge__name">
                    {CATEGORY_LABELS[key]}
                    <span style={{ color: "var(--ash-dim)", fontSize: "0.75rem" }}>
                      {" "}
                      {Math.round(CATEGORY_WEIGHTS[key] * 100)}%
                    </span>
                  </span>
                  <span className="gauge__readout">
                    {category?.score === null || category === undefined ? (
                      <span className="gauge__value gauge__value--na">N/A</span>
                    ) : (
                      <span className="gauge__value">{category.score}</span>
                    )}
                    <Ticks score={category?.score ?? null} />
                  </span>
                </button>
                {open && (
                  <div className="gauge__why">
                    {category && !category.available && (
                      <p className="gauge__unavailable">
                        {category.unavailable_reason ?? "データがありません"}
                      </p>
                    )}
                    <SignalList signals={category?.signals ?? []} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {payload.headline_signals.length > 0 && (
          <div style={{ marginTop: "1.25rem" }}>
            <SignalList signals={payload.headline_signals} />
          </div>
        )}
      </div>
    </section>
  );
}

function BasicPanel({ payload }: { payload: AnalysisPayload }) {
  const repo = payload.repository;
  return (
    <Panel title="Repository" hint="GitHub REST">
      <div className="rows">
        <Row label="Stars" value={intFmt(repo.stars)} />
        <Row label="Forks" value={intFmt(repo.forks)} />
        <Row label="Watchers" value={intFmt(repo.watchers)} />
        <Row label="Primary language" value={repo.language} />
        <Row label="License" value={repo.license} tone={repo.license ? undefined : "warn"} />
        <Row label="Default branch" value={repo.default_branch} />
        <Row label="Open issues (概数)" value={intFmt(repo.open_issues)} />
        <Row label="Created" value={dateFmt(repo.created_at)} />
        <Row label="Last push" value={agoFmt(repo.pushed_at)} />
        <Row
          label="Archived"
          value={repo.archived ? "yes" : "no"}
          tone={repo.archived ? "bad" : undefined}
        />
      </div>
    </Panel>
  );
}

/** Contributor card (spec 16.3), including the Effective Contributor tooltip. */
function CommunityPanel({ payload }: { payload: AnalysisPayload }) {
  const c = payload.contributors;
  const band = concentrationBand(c?.top3Share ?? null);

  return (
    <Panel title="Community" hint="GitHub contributor statistics">
      {!c ? (
        <p className="note">Contributor details are still unavailable.</p>
      ) : (
        <>
          <div className="rows">
            <Row label="Raw Contributors" value={intFmt(c.rawContributors)} muted />
            <Row label="Active Contributors (90d)" value={intFmt(c.active90d)} />
            <Row label="Repeat Contributors (365d)" value={intFmt(c.repeat365d)} />
            <Row
              label="Effective Contributors"
              value={intFmt(c.effectiveContributors)}
              emphasis
              hint="直近1年に継続的な Contribution があり、Bot または明示 AI Agent ではない Contributor です。AI 支援を利用している人間を推測で除外することはありません。"
            />
            <Row
              label="Core Maintainers"
              value={intFmt(c.coreMaintainers)}
              hint="直近1年で 5 commit 以上かつ 3 週以上活動している人間の Contributor（暫定閾値）。"
            />
            <Row label="Bot Contributors" value={intFmt(c.botContributors)} muted />
            <Row
              label="Known AI Agents"
              value={intFmt(c.knownAiAgents)}
              muted
              hint="GitHub 上で Agent として識別できるアカウントのみを数えます。コード内容から AI 生成を推定することはしません。"
            />
            <Row label="Human / Unknown" value={intFmt(c.humanUnknown)} muted />
            <Row label="One-shot Contributor 比率" value={pctFmt(c.oneShotRatio)} muted />
            <Row label="Top 1 contribution share" value={pctFmt(c.top1Share)} emphasis />
            <Row
              label="Top 3 contribution share"
              value={
                band && c.top3Share !== null ? `${pctFmt(c.top3Share)} · ${band.label}` : null
              }
              tone={band?.tone}
              hint="Bot と明示 AI Agent の commit は分母・分子の両方から除外しています。"
            />
            <Row label="Top 5 contribution share" value={pctFmt(c.top5Share)} muted />
          </div>
          {c.effectiveContributors <= 2 && (
            <p className="note">
              Maintainer concentration is high — Contributor が少ない小規模 OSS では、これ自体が
              「悪い OSS」を意味するわけではありません。
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/** Activity card (spec 16.4) with the optional sparkline. */
function ActivityPanel({ payload }: { payload: AnalysisPayload }) {
  const a = payload.activity;
  const trend =
    a && a.commitsPrev90d > 0 ? a.commits90d / a.commitsPrev90d : null;

  return (
    <Panel title="Activity" hint="GitHub weekly statistics">
      {!a ? (
        <p className="note">Activity metrics are still unavailable.</p>
      ) : (
        <>
          <div className="rows">
            <Row label="Last commit" value={agoFmt(a.lastCommitAt)} emphasis />
            <Row label="Commits / 30d" value={intFmt(a.commits30d)} />
            <Row label="Commits / 90d" value={intFmt(a.commits90d)} />
            <Row label="Commits / 365d" value={intFmt(a.commits365d)} />
            <Row label="Active weeks / 1y" value={`${a.activeWeeks365d} / 52`} />
            <Row
              label="Activity trend (90d vs 前90d)"
              value={trend === null ? null : `${trend.toFixed(2)}×`}
              tone={trend === null ? undefined : trend >= 0.8 ? "good" : "warn"}
              muted
            />
            <Row label="90d contributors" value={intFmt(payload.contributors?.active90d)} />
          </div>
          <Sparkline
            values={[a.commitsPrev90d, a.commits90d]}
            labels={["前90日", "直近90日"]}
          />
        </>
      )}
    </Panel>
  );
}

function Sparkline({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values, 1);
  return (
    <>
      <div className="spark" aria-hidden="true">
        {values.map((value, index) => (
          <span
            key={index}
            className={`spark__bar${index === values.length - 1 ? " spark__bar--recent" : ""}`}
            style={{ height: `${Math.max(4, (value / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="spark__legend">
        {labels.map((label, index) => (
          <span key={label}>
            {label} {intFmt(values[index]) ?? "—"}
          </span>
        ))}
      </div>
    </>
  );
}

/** Security card (spec 16.5). "No data" and "no problem" must not look alike. */
function SecurityPanel({ payload }: { payload: AnalysisPayload }) {
  const s = payload.security;
  const checkTone = (score: number | null) =>
    score === null ? undefined : score >= 8 ? "good" : score >= 5 ? "warn" : "bad";
  const checkLabel = (score: number | null) =>
    score === null ? null : score >= 8 ? "Good" : score >= 5 ? "Caution" : "Weak";

  return (
    <Panel title="Security Hygiene" hint="OpenSSF Scorecard">
      <div className="rows">
        <Row
          label="OpenSSF Scorecard"
          value={s?.openssfScore === null || s === null ? null : `${s.openssfScore.toFixed(1)} / 10`}
          emphasis
        />
        {s?.openssfScore === null && (
          <Row label="Reason" value="OpenSSF Scorecard data unavailable" muted />
        )}
        {(s?.openssfChecks ?? [])
          .filter((check) => check.score !== null)
          .slice(0, 8)
          .map((check) => (
            <Row
              key={check.name}
              label={check.name}
              value={checkLabel(check.score)}
              tone={checkTone(check.score)}
              hint={check.reason ?? undefined}
              muted
            />
          ))}
        <Row
          label="License 存在"
          value={s?.licensePresent ? "yes" : "no"}
          tone={s?.licensePresent ? "good" : "warn"}
        />
        <Row
          label="Package security data"
          value={s?.depsDataAvailable ? "available" : null}
          muted
          hint="Repository と Package の対応を高信頼で特定できない場合は表示しません。誤った Package の脆弱性・License を出す方が危険なためです。"
        />
        <Row label="Dependency vulnerability" value={intFmt(s?.vulnerabilityCount)} muted />
      </div>
      <p className="note">
        「データなし」と「問題なし」は別に扱います。N/A は未取得を意味し、減点はしていません。
      </p>
    </Panel>
  );
}

function ReleasePanel({ payload }: { payload: AnalysisPayload }) {
  const r = payload.release;
  return (
    <Panel title="Release" hint="GitHub Releases">
      {!r || !r.hasReleases ? (
        <p className="note">
          この Repository は Release を使っていません。Release Health は評価対象外（N/A）で、
          Weight は再正規化されています。
        </p>
      ) : (
        <>
          <div className="rows">
            <Row label="Latest release" value={r.latestReleaseName} emphasis />
            <Row label="Released" value={agoFmt(r.latestReleaseAt)} />
            <Row label="Release age" value={daysFmt(r.latestReleaseAgeDays)} />
            <Row
              label="Median release interval"
              value={daysFmt(r.medianIntervalDays)}
              hint={`直近 ${r.releaseCountSample} 件の Release から算出`}
            />
            <Row
              label="Release delay ratio"
              value={r.releaseDelayRatio === null ? null : `${r.releaseDelayRatio.toFixed(2)}×`}
              tone={
                r.releaseDelayRatio === null
                  ? undefined
                  : r.releaseDelayRatio <= 1.5
                    ? "good"
                    : r.releaseDelayRatio <= 3
                      ? "warn"
                      : "bad"
              }
              hint="経過日数 ÷ Release 間隔の中央値。月次 Release と年1 Release を同じ基準で測らないための指標です。"
            />
          </div>
          <div className="rows" style={{ marginTop: "1rem" }}>
            {r.recentReleases.map((release) => (
              <Row
                key={`${release.name}-${release.publishedAt}`}
                label={release.name}
                value={dateFmt(release.publishedAt)}
                muted
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

/** Data freshness (spec 16.6). Always shown, one row per source. */
function FreshnessPanel({ payload }: { payload: AnalysisPayload }) {
  const f = payload.freshness;
  const issuePr = payload.issue_pr;

  return (
    <Panel title="Data freshness" hint="ソース別の取得時刻">
      <div className="rows">
        <Row label="GitHub" value={agoFmt(f.github)} />
        <Row label="ecosyste.ms" value={agoFmt(f.ecosystems)} />
        <Row label="OpenSSF" value={agoFmt(f.openssf)} />
        <Row label="deps.dev" value={agoFmt(f.deps_dev)} muted />
        <Row label="Score calculated" value={agoFmt(f.score)} emphasis />
      </div>

      <div className="panel__head" style={{ marginTop: "1.75rem" }}>
        <h2 className="panel__title">Issue / PR</h2>
        <span className="panel__hint">ecosyste.ms</span>
      </div>
      {!issuePr ? (
        <p className="note">Issue / PR metrics = unavailable</p>
      ) : (
        <div className="rows">
          <Row label="Total issues" value={intFmt(issuePr.totalIssues)} />
          <Row label="Total PR" value={intFmt(issuePr.totalPrs)} />
          <Row label="Merged PR" value={intFmt(issuePr.mergedPrs)} />
          <Row label="Bot PR" value={intFmt(issuePr.botPrs)} muted />
          <Row label="Average issue close time" value={secondsToDaysFmt(issuePr.avgIssueCloseSeconds)} />
          <Row label="Average PR close time" value={secondsToDaysFmt(issuePr.avgPrCloseSeconds)} />
          <Row label="Issue authors" value={intFmt(issuePr.issueAuthors)} muted />
          <Row label="PR authors" value={intFmt(issuePr.prAuthors)} muted />
          <Row
            label="Open / Closed 比率"
            value={issuePr.openClosedRatio === null ? null : issuePr.openClosedRatio.toFixed(2)}
            muted
          />
        </div>
      )}

      {payload.unavailable.length > 0 && (
        <p className="note">Unavailable sources: {payload.unavailable.join(", ")}</p>
      )}
    </Panel>
  );
}
