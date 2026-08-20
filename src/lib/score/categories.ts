import {
  ADOPTION_WEIGHTS,
  CLOSE_TIME_LADDER_DAYS,
  COMMIT_RECENCY_LADDER,
  COMMUNITY_WEIGHTS,
  CORE_MAINTAINER_LADDER,
  EFFECTIVE_CONTRIBUTOR_LADDER,
  MIN_COMMITS_FOR_COMMUNITY,
  FORK_SCORE_COEFFICIENT,
  MAINTENANCE_WEIGHTS,
  RELEASE_DELAY_LADDER,
  STAR_SCORE_COEFFICIENT,
  TOP3_CONCENTRATION_LADDER,
} from "../config";
import type {
  ActivityMetrics,
  CategoryResult,
  ContributorMetrics,
  IssuePrMetrics,
  ReleaseMetrics,
  RepositoryBasic,
  SecurityMetrics,
  Signal,
} from "../types";
import { clamp, formatDays, round, scoreByMax, weightedMean } from "./ladders";

const DAY_MS = 86_400_000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now.getTime() - then) / DAY_MS);
}

/** Maintenance (spec 10). Weight 30%. */
export function scoreMaintenance(
  basic: RepositoryBasic,
  activity: ActivityMetrics | null,
  issuePr: IssuePrMetrics | null,
  now: Date,
): CategoryResult {
  const signals: Signal[] = [];

  // An archived repository is a stated fact, not an inference (spec 10.1).
  if (basic.archived) {
    return {
      score: 0,
      available: true,
      signals: [
        { type: "negative", text: "Repository は archived として公開されています" },
      ],
    };
  }

  const lastCommitDays = daysSince(activity?.lastCommitAt ?? basic.pushedAt, now);
  if (lastCommitDays === null) {
    return {
      score: null,
      available: false,
      unavailableReason: "最終 Commit の日時を取得できませんでした",
      signals: [],
    };
  }

  const recency = scoreByMax(COMMIT_RECENCY_LADDER, "maxDays", lastCommitDays);
  signals.push({
    type: lastCommitDays <= 90 ? "positive" : lastCommitDays <= 365 ? "warning" : "negative",
    text: `最終 Commit は ${formatDays(lastCommitDays)}前`,
  });

  // Continuity, not volume: spec 10.2 explicitly rejects "more commits is
  // better", so this measures how many weeks saw activity, capped at 1.
  let continuity: number | null = null;
  if (activity && activity.activeWeeks365d !== null) {
    continuity = clamp((activity.activeWeeks365d / 52) * 100);
    signals.push({
      type: activity.activeWeeks365d >= 26 ? "positive" : "info",
      text: `過去52週のうち ${activity.activeWeeks365d} 週で活動`,
    });
  } else if (activity) {
    signals.push({
      type: "info",
      text: "週次の活動分布は未取得（GitHub の統計が生成中のため）",
    });
  }

  const issueHealth = closeTimeScore(issuePr?.avgIssueCloseSeconds ?? null);
  const prHealth = closeTimeScore(issuePr?.avgPrCloseSeconds ?? null);
  if (issuePr?.avgIssueCloseSeconds != null) {
    signals.push({
      type: "info",
      text: `Issue の平均クローズ時間 ${formatDays(issuePr.avgIssueCloseSeconds / 86_400)}`,
    });
  }
  if (issuePr?.avgPrCloseSeconds != null) {
    signals.push({
      type: "info",
      text: `PR の平均クローズ時間 ${formatDays(issuePr.avgPrCloseSeconds / 86_400)}`,
    });
  }

  const { score } = weightedMean([
    { weight: MAINTENANCE_WEIGHTS.commit_recency, score: recency },
    { weight: MAINTENANCE_WEIGHTS.activity_continuity, score: continuity },
    { weight: MAINTENANCE_WEIGHTS.issue_health, score: issueHealth },
    { weight: MAINTENANCE_WEIGHTS.pr_health, score: prHealth },
  ]);

  return { score: round(score), available: score !== null, signals };
}

function closeTimeScore(seconds: number | null): number | null {
  if (seconds === null || seconds < 0) return null;
  return scoreByMax(CLOSE_TIME_LADDER_DAYS, "maxDays", seconds / 86_400);
}

/** Community Resilience (spec 11). Weight 25%. */
export function scoreCommunity(contributors: ContributorMetrics | null): CategoryResult {
  if (!contributors) {
    return {
      score: null,
      available: false,
      unavailableReason: "Contributor statistics が取得できませんでした",
      signals: [],
    };
  }

  /*
   * Too few commits to characterise a community (spec 8.3 / 11.2).
   *
   * With a handful of commits in the year, every figure in this category is a
   * restatement of that fact: one contributor, no repeat contributors, 100%
   * concentration. Scoring them produced a Caution verdict for small, stable,
   * perfectly healthy packages — chalk/ansi-styles scored 24 here on the
   * strength of 6 commits. The honest answer is that the data does not support a
   * community judgement, which is what N/A plus reduced coverage says.
   *
   * The counts stay visible; only the score is withheld.
   */
  if (contributors.sampleTooSmall) {
    const commits = contributors.humanCommits365d;
    return {
      score: null,
      available: false,
      unavailableReason:
        `直近1年の Commit が ${commits ?? 0} 件しかなく、コミュニティの厚みを評価できません` +
        `（${MIN_COMMITS_FOR_COMMUNITY} 件以上で評価します）`,
      signals: [
        {
          type: "info",
          text: `実効 Contributor ${contributors.effectiveContributors} 人 / 直近1年の Commit ${commits ?? 0} 件`,
        },
        {
          type: "info",
          text: "小規模で変更の少ない Repository では、この値が低いことは欠陥を意味しません",
        },
      ],
    };
  }

  const signals: Signal[] = [];
  const effective = scoreByMax(
    EFFECTIVE_CONTRIBUTOR_LADDER,
    "max",
    contributors.effectiveContributors,
  );
  signals.push({
    type: contributors.effectiveContributors >= 4 ? "positive" : "warning",
    text: `実効 Contributor ${contributors.effectiveContributors} 人`,
  });

  const repeatRatio =
    contributors.active365d > 0
      ? clamp((contributors.repeat365d / contributors.active365d) * 100)
      : null;
  if (repeatRatio !== null) {
    signals.push({
      type: repeatRatio >= 50 ? "positive" : "info",
      text: `直近1年の Active Contributor のうち ${Math.round(repeatRatio)}% が継続的`,
    });
  }

  const concentration =
    contributors.top3Share === null
      ? null
      : scoreByMax(TOP3_CONCENTRATION_LADDER, "maxShare", contributors.top3Share);
  if (contributors.top3Share !== null) {
    signals.push({
      type: contributors.top3Share > 0.65 ? "warning" : "positive",
      text: `Top3 Contributor の Commit 占有率 ${Math.round(contributors.top3Share * 100)}%`,
    });
  }

  const coreScore = scoreByMax(CORE_MAINTAINER_LADDER, "max", contributors.coreMaintainers);
  signals.push({
    type: contributors.coreMaintainers >= 2 ? "positive" : "warning",
    text:
      `Core Maintainer ${contributors.coreMaintainers} 人` +
      (contributors.coreMaintainersPartial ? "（Commit 数のみで判定・活動週は未取得）" : ""),
  });

  // Spec 7.5: the presence of AI agents is not penalised. Only the combination
  // of a thin human bench with heavy agent activity is surfaced, and as a
  // resilience signal rather than a deduction.
  if (
    contributors.knownAiAgents > 0 &&
    contributors.effectiveContributors <= 2 &&
    contributors.knownAiAgents >= contributors.effectiveContributors
  ) {
    signals.push({
      type: "warning",
      text: "Human maintainer resilience may be low（実効の人間 Contributor が少なく、既知 Agent の比重が高い）",
    });
  }

  const { score } = weightedMean([
    { weight: COMMUNITY_WEIGHTS.effective_contributors, score: effective },
    { weight: COMMUNITY_WEIGHTS.repeat_ratio, score: repeatRatio },
    { weight: COMMUNITY_WEIGHTS.top3_concentration, score: concentration },
    { weight: COMMUNITY_WEIGHTS.core_maintainers, score: coreScore },
  ]);

  return { score: round(score), available: score !== null, signals };
}

/** Security Hygiene (spec 12). Weight 20%. */
export function scoreSecurity(security: SecurityMetrics | null): CategoryResult {
  // Spec 12.2: no Scorecard data means N/A, never zero. A repository OpenSSF has
  // not scanned has not failed a security check.
  if (!security || security.openssfScore === null) {
    return {
      score: null,
      available: false,
      unavailableReason: "OpenSSF Scorecard data unavailable",
      signals: security?.licensePresent
        ? [{ type: "info", text: "License は設定されています" }]
        : [{ type: "warning", text: "License が確認できません" }],
    };
  }

  const signals: Signal[] = [
    {
      type: security.openssfScore >= 7 ? "positive" : security.openssfScore >= 5 ? "info" : "warning",
      text: `OpenSSF Scorecard ${security.openssfScore.toFixed(1)} / 10`,
    },
  ];

  for (const check of security.openssfChecks) {
    // `null` means the check was inconclusive, not that it scored badly.
    if (check.score !== null && check.score >= 0 && check.score <= 2) {
      signals.push({ type: "warning", text: `OpenSSF ${check.name} が低評価（${check.score}/10）` });
    }
  }
  if (!security.licensePresent) {
    signals.push({ type: "warning", text: "License が確認できません" });
  }

  return { score: round(clamp(security.openssfScore * 10)), available: true, signals };
}

/** Release Health (spec 13). Weight 15%. */
export function scoreRelease(release: ReleaseMetrics | null): CategoryResult {
  // Spec 13.4: not using releases is a workflow choice, not a defect.
  if (!release || !release.hasReleases) {
    return {
      score: null,
      available: false,
      unavailableReason: "この Repository は Release を使っていません",
      signals: [{ type: "info", text: "Release が存在しないため評価対象外" }],
    };
  }

  const signals: Signal[] = [];
  if (release.latestReleaseAgeDays !== null) {
    signals.push({
      type: "info",
      text: `最新 Release「${release.latestReleaseName}」は ${formatDays(release.latestReleaseAgeDays)}前`,
    });
  }

  if (release.releaseDelayRatio === null) {
    return {
      score: null,
      available: false,
      unavailableReason: "Release 間隔の中央値を出せる履歴がありません（Release 3件未満）",
      signals,
    };
  }

  const score = scoreByMax(RELEASE_DELAY_LADDER, "maxRatio", release.releaseDelayRatio);
  signals.push({
    type: release.releaseDelayRatio <= 1.5 ? "positive" : "warning",
    text: `Release 間隔の中央値 ${Math.round(release.medianIntervalDays ?? 0)}日に対し、経過は ${release.releaseDelayRatio.toFixed(1)}倍`,
  });

  return { score, available: true, signals };
}

/** Adoption (spec 14). Weight 10%. Deliberately the smallest weight. */
export function scoreAdoption(basic: RepositoryBasic): CategoryResult {
  if (basic.stars === null) {
    return {
      score: null,
      available: false,
      unavailableReason: "Star 数を取得できませんでした",
      signals: [],
    };
  }

  const starScore = clamp(STAR_SCORE_COEFFICIENT * Math.log10(basic.stars + 1));
  const forkScore = clamp(FORK_SCORE_COEFFICIENT * Math.log10((basic.forks ?? 0) + 1));

  const { score } = weightedMean([
    { weight: ADOPTION_WEIGHTS.stars, score: starScore },
    { weight: ADOPTION_WEIGHTS.forks, score: basic.forks === null ? null : forkScore },
  ]);

  return {
    score: round(score),
    available: score !== null,
    signals: [
      {
        type: "info",
        text: `${basic.stars.toLocaleString("en-US")} stars / ${(basic.forks ?? 0).toLocaleString("en-US")} forks`,
      },
    ],
  };
}
