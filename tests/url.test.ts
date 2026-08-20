import { describe, expect, it } from "vitest";
import { normalizeRepoUrl, repoKey } from "../src/lib/url";

describe("normalizeRepoUrl", () => {
  it("accepts the documented input forms (spec 2.1)", () => {
    for (const input of [
      "https://github.com/ggerganov/llama.cpp",
      "http://github.com/ggerganov/llama.cpp",
      "github.com/ggerganov/llama.cpp",
      "  https://github.com/ggerganov/llama.cpp/  ",
      "https://github.com/ggerganov/llama.cpp.git",
      "https://www.github.com/ggerganov/llama.cpp?tab=readme",
    ]) {
      const result = normalizeRepoUrl(input);
      expect(result.ok, input).toBe(true);
      if (!result.ok) continue;
      expect(result.ref).toEqual({ owner: "ggerganov", repo: "llama.cpp" });
      expect(result.canonicalUrl).toBe("https://github.com/ggerganov/llama.cpp");
    }
  });

  it("rejects every case listed in spec 2.2", () => {
    const cases: [string, string][] = [
      ["https://gitlab.com/owner/repo", "NOT_GITHUB_HOST"],
      ["https://github.com/ggerganov", "PROFILE_URL"],
      ["https://github.com/owner/repo/issues/1", "SUBPATH_URL"],
      ["https://github.com/owner/repo/pull/2", "SUBPATH_URL"],
      ["https://github.com/owner/repo/commit/abc", "SUBPATH_URL"],
      ["https://github.com/features/copilot", "RESERVED_PATH"],
      ["", "EMPTY"],
      ["ftp://github.com/owner/repo", "NOT_GITHUB_HOST"],
    ];
    for (const [input, reason] of cases) {
      const result = normalizeRepoUrl(input);
      expect(result.ok, input).toBe(false);
      if (result.ok) continue;
      expect(result.reason, input).toBe(reason);
    }
  });

  it("does not let a lookalike host through", () => {
    for (const host of ["github.com.evil.test", "notgithub.com", "githubbcom"]) {
      const result = normalizeRepoUrl(`https://${host}/owner/repo`);
      expect(result.ok, host).toBe(false);
    }
  });

  it("treats owner/repo case-insensitively for cache keys", () => {
    expect(repoKey({ owner: "GGerganov", repo: "LLaMA.cpp" })).toBe("ggerganov/llama.cpp");
  });
});
