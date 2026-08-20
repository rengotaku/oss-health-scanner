import { describe, expect, it } from "vitest";
import { GithubClient } from "../src/lib/sources/github";
import { fetchCommitAggregation } from "../src/lib/sources/ecosystems-commits";
import { resolvePackageMapping } from "../src/lib/sources/depsdev";
import { fetchScorecard } from "../src/lib/sources/openssf";

const token = process.env.GITHUB_TOKEN ?? "";
const run = token ? describe : describe.skip;

/**
 * Hits the real APIs. Skipped without a token so `make ci` stays offline-safe;
 * run it deliberately with GITHUB_TOKEN set when changing a source module.
 *
 * The point of these cases is the size behaviour that unit tests cannot show:
 * `stats/contributors` is tens of MB for large repositories, and the fallback
 * has to take over rather than the analysis losing its contributor metrics.
 */
run("GitHub sources against the live API", () => {
  it("reads repository metadata", async () => {
    const client = new GithubClient(token);
    const { basic } = await client.getRepository({ owner: "curl", repo: "curl" });
    expect(basic.owner).toBe("curl");
    expect(basic.stars).toBeGreaterThan(0);
    expect(basic.license).not.toBeNull();
  }, 20_000);

  it("either reads commit activity or reports it as unavailable", async () => {
    // GitHub answers 202 while recomputing, and on a busy repository that state
    // persists across the whole retry budget (observed on curl/curl,
    // 2026-08-20). Both outcomes are correct; silently returning zeros is not.
    const client = new GithubClient(token);
    const { weeks } = await client.getCommitActivity({ owner: "curl", repo: "curl" });
    if (weeks === null) {
      expect(client.usage.requests).toBeGreaterThan(1);
      return;
    }
    expect(weeks.length).toBeGreaterThan(40);
  }, 30_000);

  it("never returns an oversized contributor statistics body as data", async () => {
    const client = new GithubClient(token);
    const result = await client.getContributorStats({ owner: "curl", repo: "curl" });
    // Whatever happens, the analysis must not receive tens of MB of parsed JSON.
    if (result.stats !== null) {
      expect(result.bytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
    } else {
      expect(result.tooLarge || result.pending).toBe(true);
    }
  }, 30_000);

  it("reads contributor statistics for a small repository", async () => {
    const client = new GithubClient(token);
    const result = await client.getContributorStats({ owner: "chalk", repo: "ansi-styles" });
    expect(result.tooLarge).toBe(false);
    if (result.stats) {
      expect(result.stats.length).toBeGreaterThan(0);
      expect(result.stats[0]!.weeks.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it("gets a bounded commit aggregation for a large repository", async () => {
    const aggregation = await fetchCommitAggregation({ owner: "curl", repo: "curl" });
    expect(aggregation).not.toBeNull();
    expect(aggregation!.pastYear.length).toBeGreaterThan(0);
    expect(aggregation!.totalCommitters!).toBeGreaterThan(100);
    expect(aggregation!.pastYear[0]!.commits).toBeGreaterThan(0);
  }, 20_000);
});

run("deps.dev package mapping", () => {
  it("refuses the repository-derived Go pseudo-module (curl/curl)", async () => {
    const mapping = await resolvePackageMapping({ owner: "curl", repo: "curl" });
    expect(mapping.confident).toBe(false);
  }, 20_000);

  it("resolves a real npm package despite re-publishes (chalk/ansi-styles)", async () => {
    const mapping = await resolvePackageMapping({ owner: "chalk", repo: "ansi-styles" });
    expect(mapping.confident, JSON.stringify(mapping)).toBe(true);
    if (mapping.confident) {
      expect(mapping.system.toUpperCase()).toBe("NPM");
      expect(mapping.name).toBe("ansi-styles");
    }
  }, 20_000);
});

run("OpenSSF scorecard parsing", () => {
  it("reports an inconclusive check as null, not as a low score", async () => {
    const result = await fetchScorecard({ owner: "curl", repo: "curl" });
    expect(result).not.toBeNull();
    const negative = result!.checks.filter((c) => c.score !== null && c.score < 0);
    expect(negative, JSON.stringify(negative)).toHaveLength(0);
    // curl has at least one inconclusive check as of 2026-08-20.
    expect(result!.checks.some((c) => c.score === null)).toBe(true);
  }, 20_000);
});
