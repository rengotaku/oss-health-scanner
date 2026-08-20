import { CONTRIBUTOR_RULES } from "../config";
import type { ReleaseMetrics, ReleaseSummary } from "../types";

const DAY_MS = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Release cadence metrics (spec 13.2).
 *
 * "Days since the latest release" alone cannot distinguish a monthly-release
 * project that is two months late from an annual-release project that is two
 * months into its cycle, so the delay is expressed relative to the project's own
 * median interval. With fewer than two intervals there is no cadence to compare
 * against and the ratio stays null, which makes the category unavailable rather
 * than guessed.
 */
export function computeReleaseMetrics(
  releases: ReleaseSummary[],
  now: Date,
): ReleaseMetrics {
  if (releases.length === 0) {
    return {
      hasReleases: false,
      latestReleaseAt: null,
      latestReleaseName: null,
      latestReleaseAgeDays: null,
      releaseCountSample: 0,
      medianIntervalDays: null,
      releaseDelayRatio: null,
      recentReleases: [],
    };
  }

  const sorted = [...releases].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const sample = sorted.slice(0, CONTRIBUTOR_RULES.releaseSampleSize);
  const latest = sample[0]!;
  const latestMs = Date.parse(latest.publishedAt);
  const ageDays = Number.isNaN(latestMs)
    ? null
    : Math.max(0, (now.getTime() - latestMs) / DAY_MS);

  const intervals: number[] = [];
  for (let i = 0; i < sample.length - 1; i += 1) {
    const newer = Date.parse(sample[i]!.publishedAt);
    const older = Date.parse(sample[i + 1]!.publishedAt);
    if (Number.isNaN(newer) || Number.isNaN(older)) continue;
    const days = (newer - older) / DAY_MS;
    if (days > 0) intervals.push(days);
  }

  const medianInterval = intervals.length >= 2 ? median(intervals) : null;
  const delayRatio =
    medianInterval !== null && medianInterval > 0 && ageDays !== null
      ? ageDays / medianInterval
      : null;

  return {
    hasReleases: true,
    latestReleaseAt: latest.publishedAt,
    latestReleaseName: latest.name,
    latestReleaseAgeDays: ageDays,
    releaseCountSample: sample.length,
    medianIntervalDays: medianInterval,
    releaseDelayRatio: delayRatio,
    recentReleases: sample,
  };
}
