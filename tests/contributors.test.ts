import { describe, expect, it } from "vitest";
import {
  classifyContributor,
  computeContributorMetrics,
} from "../src/lib/metrics/contributors";
import type { ContributorStat } from "../src/lib/sources/github";

const NOW = new Date("2026-08-20T00:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const WEEK = 604_800;

/** Week bucket `n` weeks before now. */
function weeksAgo(n: number, commits: number) {
  return { w: NOW_SEC - n * WEEK, c: commits };
}

function stat(
  login: string,
  weeks: { w: number; c: number }[],
  accountType: string | null = "User",
): ContributorStat {
  return {
    login,
    githubUserId: 1,
    accountType,
    total: weeks.reduce((sum, w) => sum + w.c, 0),
    weeks,
  };
}

describe("classifyContributor (spec 7)", () => {
  it("uses only high-confidence bot signals", () => {
    expect(classifyContributor("dependabot[bot]", "Bot")).toBe("BOT");
    expect(classifyContributor("some-ci", "Bot")).toBe("BOT");
    expect(classifyContributor("renovate", "User")).toBe("BOT");
    expect(classifyContributor("anything[bot]", null)).toBe("BOT");
  });

  it("classifies only explicitly identified agents as agents", () => {
    expect(classifyContributor("copilot-swe-agent", "Bot")).toBe("KNOWN_AI_AGENT");
    expect(classifyContributor("devin-ai-integrated", "User")).toBe("KNOWN_AI_AGENT");
  });

  it("never infers AI usage for a human account (spec 7.4)", () => {
    // A human who generated their code with an AI assistant is not an agent.
    expect(classifyContributor("alice", "User")).toBe("HUMAN_OR_UNKNOWN");
    expect(classifyContributor("claude-code-user", "User")).toBe("HUMAN_OR_UNKNOWN");
    expect(classifyContributor("ai-enthusiast", "User")).toBe("HUMAN_OR_UNKNOWN");
  });
});

describe("computeContributorMetrics (spec 6 / 8)", () => {
  const stats: ContributorStat[] = [
    // Core: 20 commits across 4 recent weeks.
    stat("lead", [weeksAgo(1, 5), weeksAgo(2, 5), weeksAgo(3, 5), weeksAgo(4, 5)]),
    // Repeat + active, but below the core thresholds.
    stat("regular", [weeksAgo(2, 1), weeksAgo(30, 1)]),
    // Active once only in the last 90 days: active but not repeat.
    stat("drive-by", [weeksAgo(3, 1)]),
    // Active a year ago only.
    stat("former", [weeksAgo(60, 4), weeksAgo(61, 4)]),
    // Automation with heavy volume — must not affect concentration.
    stat("dependabot[bot]", [weeksAgo(1, 100)], "Bot"),
    stat("copilot-swe-agent", [weeksAgo(1, 50)], "Bot"),
  ];

  const { contributors, activity } = computeContributorMetrics(stats, NOW);

  it("counts raw, active and repeat contributors separately", () => {
    expect(contributors.rawContributors).toBe(6);
    // lead, regular, drive-by, dependabot, copilot committed within 90 days.
    expect(contributors.active90d).toBe(5);
    expect(contributors.active365d).toBe(5);
  });

  it("excludes automation from Effective Contributors (spec 6.4)", () => {
    // lead and regular repeat and are human; drive-by has a single commit.
    expect(contributors.effectiveContributors).toBe(2);
    expect(contributors.botContributors).toBe(1);
    expect(contributors.knownAiAgents).toBe(1);
    expect(contributors.humanUnknown).toBe(4);
  });

  it("applies the core maintainer thresholds (spec 6.5)", () => {
    expect(contributors.coreMaintainers).toBe(1);
  });

  it("excludes bots and agents from concentration (spec 8.2)", () => {
    // Human commits in the last 365 days: lead 20, regular 2, drive-by 1 = 23.
    // The 150 automated commits must not appear in the denominator.
    expect(contributors.top1Share).toBeCloseTo(20 / 23, 5);
    expect(contributors.top3Share).toBeCloseTo(23 / 23, 5);
  });

  it("counts repository-level active weeks without double counting", () => {
    // Weeks 1,2,3,4 and 30 have commits. Week 1 holds three contributors but
    // counts once; `former`'s weeks are 60+ weeks back and fall outside 365d.
    expect(activity.activeWeeks365d).toBe(5);
    expect(activity.commits90d).toBe(20 + 1 + 1 + 100 + 50);
  });

  it("reports null concentration rather than 0 when there are no human commits", () => {
    const botOnly = computeContributorMetrics(
      [stat("dependabot[bot]", [weeksAgo(1, 9)], "Bot")],
      NOW,
    );
    expect(botOnly.contributors.top1Share).toBeNull();
    expect(botOnly.contributors.top3Share).toBeNull();
  });
});
