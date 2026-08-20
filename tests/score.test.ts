import { describe, expect, it } from "vitest";
import { computeScore } from "../src/lib/score";
import { computeStatusLabel } from "../src/lib/score/status";
import { computeReleaseMetrics } from "../src/lib/metrics/release";
import { CATEGORY_WEIGHTS } from "../src/lib/config";
import type {
  ActivityMetrics,
  ContributorMetrics,
  RepositoryBasic,
  SecurityMetrics,
} from "../src/lib/types";

const NOW = new Date("2026-08-20T00:00:00Z");
const DAY = 86_400_000;

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

const basic: RepositoryBasic = {
  githubRepoId: 1,
  owner: "acme",
  name: "widget",
  canonicalUrl: "https://github.com/acme/widget",
  description: null,
  stars: 1000,
  forks: 100,
  watchers: 50,
  archived: false,
  license: "MIT",
  language: "TypeScript",
  defaultBranch: "main",
  openIssues: 20,
  createdAt: iso(2000),
  updatedAt: iso(1),
  pushedAt: iso(2),
};

const activity: ActivityMetrics = {
  commits30d: 80,
  commits90d: 240,
  commits365d: 900,
  commitsPrev90d: 220,
  activeWeeks365d: 47,
  lastCommitAt: iso(2),
  source: "github_stats",
};

const contributors: ContributorMetrics = {
  rawContributors: 183,
  active90d: 48,
  active365d: 60,
  repeat365d: 37,
  effectiveContributors: 31,
  coreMaintainers: 14,
  botContributors: 23,
  knownAiAgents: 7,
  humanUnknown: 153,
  oneShotRatio: 0.4,
  top1Share: 0.28,
  top3Share: 0.62,
  top5Share: 0.7,
  humanCommits365d: 900,
  sampleTooSmall: false,
  source: "github_stats",
  coreMaintainersPartial: false,
};

const security: SecurityMetrics = {
  openssfScore: 8.4,
  openssfChecks: [{ name: "Code-Review", score: 9, reason: null }],
  openssfDate: iso(3),
  licensePresent: true,
  depsDataAvailable: false,
  vulnerabilityCount: null,
};

describe("computeScore (spec 9)", () => {
  it("produces a full-coverage score when every source is present", () => {
    const release = computeReleaseMetrics(
      [
        { name: "v3", publishedAt: iso(10) },
        { name: "v2", publishedAt: iso(40) },
        { name: "v1", publishedAt: iso(70) },
        { name: "v0", publishedAt: iso(100) },
      ],
      NOW,
    );

    const result = computeScore({
      basic,
      contributors,
      activity,
      issuePr: {
        totalIssues: 500,
        totalPrs: 900,
        mergedPrs: 700,
        botPrs: 100,
        avgIssueCloseSeconds: 5 * 86_400,
        avgPrCloseSeconds: 3 * 86_400,
        issueAuthors: 200,
        prAuthors: 150,
        openClosedRatio: 0.1,
      },
      release,
      security,
      now: NOW,
    });

    expect(result.coverage).toBeCloseTo(1, 5);
    expect(result.healthScore).not.toBeNull();
    expect(result.statusLabel).toBe("ACTIVE");
    expect(result.categories.security_hygiene.score).toBe(84);
    expect(result.headlineSignals.length).toBeGreaterThan(0);
  });

  it("renormalises weights instead of scoring a missing category as 0 (spec 9.3)", () => {
    const withSecurity = computeScore({
      basic,
      contributors,
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });

    const withoutSecurity = computeScore({
      basic,
      contributors,
      activity,
      issuePr: null,
      release: null,
      security: { ...security, openssfScore: null, openssfChecks: [] },
      now: NOW,
    });

    // Security 20% + release N/A 15% removed → coverage 65%.
    expect(withoutSecurity.coverage).toBeCloseTo(
      1 - CATEGORY_WEIGHTS.security_hygiene - CATEGORY_WEIGHTS.release_health,
      5,
    );
    expect(withoutSecurity.categories.security_hygiene.score).toBeNull();
    expect(withoutSecurity.categories.security_hygiene.unavailableReason).toBe(
      "OpenSSF Scorecard data unavailable",
    );

    // With an 84 security score removed, the remaining categories must not be
    // dragged toward zero: the score moves, but only by renormalisation.
    expect(withoutSecurity.healthScore!).toBeGreaterThan(
      withSecurity.healthScore! - 20,
    );
  });

  it("gives an archived repository a 0 maintenance score but keeps other data", () => {
    const result = computeScore({
      basic: { ...basic, archived: true },
      contributors,
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });
    expect(result.statusLabel).toBe("ARCHIVED");
    expect(result.categories.maintenance.score).toBe(0);
    expect(result.categories.adoption.score).not.toBeNull();
  });

  it("does not penalise a repository for not publishing releases (spec 13.4)", () => {
    const result = computeScore({
      basic,
      contributors,
      activity,
      issuePr: null,
      release: computeReleaseMetrics([], NOW),
      security,
      now: NOW,
    });
    expect(result.categories.release_health.available).toBe(false);
    expect(result.categories.release_health.score).toBeNull();
    expect(result.coverage).toBeCloseTo(1 - CATEGORY_WEIGHTS.release_health, 5);
  });

  it("keeps a low-activity mature project out of the STALE label (spec 15)", () => {
    const label = computeStatusLabel({
      basic: { ...basic, pushedAt: iso(200) },
      activity: { ...activity, lastCommitAt: iso(200) },
      release: computeReleaseMetrics([{ name: "v1", publishedAt: iso(210) }], NOW),
      issuePr: null,
      now: NOW,
    });
    expect(label).toBe("LOW_CHANGE");
  });

  it("only reports STALE when commits, releases and traffic all agree", () => {
    expect(
      computeStatusLabel({
        basic: { ...basic, pushedAt: iso(900) },
        activity: { ...activity, lastCommitAt: iso(900) },
        release: computeReleaseMetrics([{ name: "v1", publishedAt: iso(950) }], NOW),
        issuePr: {
          totalIssues: 0,
          totalPrs: 0,
          mergedPrs: 0,
          botPrs: 0,
          avgIssueCloseSeconds: null,
          avgPrCloseSeconds: null,
          issueAuthors: 0,
          prAuthors: 0,
          openClosedRatio: null,
        },
        now: NOW,
      }),
    ).toBe("STALE");

    // Same age, but a recent release means it is not stale.
    expect(
      computeStatusLabel({
        basic: { ...basic, pushedAt: iso(900) },
        activity: { ...activity, lastCommitAt: iso(900) },
        release: computeReleaseMetrics([{ name: "v1", publishedAt: iso(30) }], NOW),
        issuePr: null,
        now: NOW,
      }),
    ).toBe("LOW_CHANGE");
  });

  it("flags thin human resilience without penalising agent usage (spec 7.5)", () => {
    const thin = computeScore({
      basic,
      contributors: {
        ...contributors,
        effectiveContributors: 1,
        coreMaintainers: 1,
        knownAiAgents: 6,
        active365d: 8,
        repeat365d: 2,
      },
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });
    const texts = thin.categories.community_resilience.signals.map((s) => s.text);
    expect(texts.some((t) => t.includes("Human maintainer resilience may be low"))).toBe(true);

    // The same repository with no agents scores the same on community: agent
    // presence itself must not be a deduction.
    const noAgents = computeScore({
      basic,
      contributors: {
        ...contributors,
        effectiveContributors: 1,
        coreMaintainers: 1,
        knownAiAgents: 0,
        active365d: 8,
        repeat365d: 2,
      },
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });
    expect(thin.categories.community_resilience.score).toBe(
      noAgents.categories.community_resilience.score,
    );
  });

  it("does not judge a community from a handful of commits (spec 8.3 / 11.2)", () => {
    // chalk/ansi-styles, measured 2026-08-20: 6 commits in the year produced
    // "Top 1 share 67%" (4 of 6) and "Top 3 share 100%" (three people total),
    // and a Community score of 24 that dragged the repository to Caution.
    const tiny = computeScore({
      basic,
      contributors: {
        ...contributors,
        rawContributors: 21,
        active90d: 1,
        active365d: 3,
        repeat365d: 1,
        effectiveContributors: 1,
        coreMaintainers: 0,
        humanUnknown: 19,
        top1Share: null,
        top3Share: null,
        top5Share: null,
        humanCommits365d: 6,
        sampleTooSmall: true,
      },
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });

    expect(tiny.categories.community_resilience.available).toBe(false);
    expect(tiny.categories.community_resilience.score).toBeNull();
    expect(tiny.categories.community_resilience.unavailableReason).toContain("6 件");
    // The weight moves to the remaining categories rather than scoring a zero.
    expect(tiny.coverage).toBeCloseTo(
      1 - CATEGORY_WEIGHTS.community_resilience - CATEGORY_WEIGHTS.release_health,
      5,
    );

    // A well-sampled repository with the same thin community is still scored:
    // a real bus-factor-of-one finding must not be suppressed.
    const wellSampled = computeScore({
      basic,
      contributors: {
        ...contributors,
        effectiveContributors: 1,
        coreMaintainers: 1,
        active365d: 4,
        repeat365d: 1,
        top1Share: 0.95,
        top3Share: 1,
        humanCommits365d: 400,
        sampleTooSmall: false,
      },
      activity,
      issuePr: null,
      release: null,
      security,
      now: NOW,
    });
    expect(wellSampled.categories.community_resilience.available).toBe(true);
    expect(wellSampled.categories.community_resilience.score).not.toBeNull();
  });

  it("scores adoption on a log curve, not linearly (spec 14.1)", () => {
    const at100 = computeScore({ basic: { ...basic, stars: 100, forks: 10 }, contributors: null, activity: null, issuePr: null, release: null, security: null, now: NOW });
    const at100k = computeScore({ basic: { ...basic, stars: 100_000, forks: 10_000 }, contributors: null, activity: null, issuePr: null, release: null, security: null, now: NOW });
    expect(at100.categories.adoption.score).toBeLessThan(at100k.categories.adoption.score!);
    expect(at100k.categories.adoption.score).toBeLessThanOrEqual(100);
  });
});

describe("computeReleaseMetrics (spec 13.2)", () => {
  it("expresses lateness relative to the project's own cadence", () => {
    const monthly = computeReleaseMetrics(
      [
        { name: "v4", publishedAt: iso(60) },
        { name: "v3", publishedAt: iso(90) },
        { name: "v2", publishedAt: iso(120) },
        { name: "v1", publishedAt: iso(150) },
      ],
      NOW,
    );
    expect(monthly.medianIntervalDays).toBeCloseTo(30, 5);
    expect(monthly.releaseDelayRatio).toBeCloseTo(2, 5);

    // An annual-release project 60 days after a release is not late at all.
    const annual = computeReleaseMetrics(
      [
        { name: "v4", publishedAt: iso(60) },
        { name: "v3", publishedAt: iso(425) },
        { name: "v2", publishedAt: iso(790) },
        { name: "v1", publishedAt: iso(1155) },
      ],
      NOW,
    );
    expect(annual.releaseDelayRatio!).toBeLessThan(0.2);
  });

  it("counts same-day releases once (spec 13.2, calibrated 2026-08-20)", () => {
    // A monorepo tagging five packages on one day is one release event. Counting
    // them separately drove the median interval to 0.0 days and the ratio to
    // five figures on facebook/react, openssl and redis.
    const burst = computeReleaseMetrics(
      [
        { name: "a@2", publishedAt: iso(30) },
        { name: "b@2", publishedAt: iso(30) },
        { name: "c@2", publishedAt: iso(30) },
        { name: "a@1", publishedAt: iso(60) },
        { name: "b@1", publishedAt: iso(60) },
        { name: "c@1", publishedAt: iso(90) },
      ],
      NOW,
    );
    // Distinct days are 30/60/90 → intervals 30 and 30 → median 30.
    expect(burst.medianIntervalDays).toBeCloseTo(30, 5);
    expect(burst.releaseDelayRatio).toBeCloseTo(1, 5);
    // All the releases are still listed; only the cadence collapses.
    expect(burst.recentReleases).toHaveLength(6);
  });

  it("floors the divisor so a fresh release never reads as overdue", () => {
    // Released today, after a burst of daily releases: the raw median interval
    // would be 1 day, which used to make a 3-day gap look 3x late.
    const rapid = computeReleaseMetrics(
      [
        { name: "v5", publishedAt: iso(3) },
        { name: "v4", publishedAt: iso(4) },
        { name: "v3", publishedAt: iso(5) },
        { name: "v2", publishedAt: iso(6) },
        { name: "v1", publishedAt: iso(7) },
      ],
      NOW,
    );
    expect(rapid.medianIntervalDays).toBe(14);
    expect(rapid.releaseDelayRatio!).toBeLessThan(1);
  });

  it("leaves a slow-cadence project's ratio untouched by the floor", () => {
    const annual = computeReleaseMetrics(
      [
        { name: "v3", publishedAt: iso(400) },
        { name: "v2", publishedAt: iso(760) },
        { name: "v1", publishedAt: iso(1130) },
      ],
      NOW,
    );
    expect(annual.medianIntervalDays!).toBeGreaterThan(300);
    expect(annual.releaseDelayRatio!).toBeCloseTo(400 / annual.medianIntervalDays!, 5);
  });

  it("refuses to compute a ratio from too little history", () => {
    const two = computeReleaseMetrics(
      [
        { name: "v2", publishedAt: iso(10) },
        { name: "v1", publishedAt: iso(40) },
      ],
      NOW,
    );
    expect(two.hasReleases).toBe(true);
    expect(two.releaseDelayRatio).toBeNull();
  });
});
