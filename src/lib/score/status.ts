import type {
  ActivityMetrics,
  IssuePrMetrics,
  ReleaseMetrics,
  RepositoryBasic,
  StatusLabel,
} from "../types";

const DAY_MS = 86_400_000;

/**
 * Status label, computed independently of the score (spec 15).
 *
 * The distinction that matters is between a finished project and an abandoned
 * one. A repository whose last commit was eight months ago may be either, and
 * the automated signals available here cannot tell them apart — so the middle
 * case gets its own label (LOW_CHANGE) and the UI states the fact instead of
 * concluding. Spec 15.3 forbids "Dead" / "Abandoned" / "Unsafe" as automated
 * verdicts, which is why no such label exists in this type.
 */
export function computeStatusLabel(args: {
  basic: RepositoryBasic;
  activity: ActivityMetrics | null;
  release: ReleaseMetrics | null;
  issuePr: IssuePrMetrics | null;
  now: Date;
}): StatusLabel {
  const { basic, activity, release, issuePr, now } = args;

  if (basic.archived) return "ARCHIVED";

  const lastCommit = activity?.lastCommitAt ?? basic.pushedAt;
  const lastCommitMs = lastCommit ? Date.parse(lastCommit) : NaN;
  if (Number.isNaN(lastCommitMs)) return "INDETERMINATE";

  const days = (now.getTime() - lastCommitMs) / DAY_MS;
  if (days <= 90) return "ACTIVE";

  if (days <= 365) return "LOW_CHANGE";

  // Beyond a year, only call it STALE when releases and issue/PR traffic agree
  // that nothing is happening. If either is missing we cannot tell.
  const releaseAge = release?.latestReleaseAgeDays ?? null;
  const noRecentRelease = release ? !release.hasReleases || (releaseAge ?? Infinity) > 365 : null;
  const noRecentTraffic =
    issuePr === null
      ? null
      : (issuePr.totalPrs ?? 0) === 0 && (issuePr.totalIssues ?? 0) === 0;

  if (noRecentRelease === true && noRecentTraffic !== false) return "STALE";
  if (noRecentRelease === null && noRecentTraffic === null) return "INDETERMINATE";
  return "LOW_CHANGE";
}

export const STATUS_COPY: Record<StatusLabel, { label: string; note: string }> = {
  ACTIVE: {
    label: "ACTIVE",
    note: "直近90日以内に Commit があります。",
  },
  LOW_CHANGE: {
    label: "LOW_CHANGE",
    note: "更新頻度は低いですが、放棄された Repository とは断定できません。",
  },
  STALE: {
    label: "STALE",
    note: "1年以上 Commit・Release・Issue/PR の動きが確認できません。",
  },
  ARCHIVED: {
    label: "ARCHIVED",
    note: "GitHub 上で archived に設定されています。",
  },
  INDETERMINATE: {
    label: "INDETERMINATE",
    note: "判定に必要なデータが揃いませんでした。",
  },
};
