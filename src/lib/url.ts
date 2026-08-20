import type { RepoRef } from "./types";

export type NormalizeResult =
  | { ok: true; ref: RepoRef; canonicalUrl: string }
  | { ok: false; reason: NormalizeError };

export type NormalizeError =
  | "EMPTY"
  | "NOT_A_URL"
  | "NOT_GITHUB_HOST"
  | "PROFILE_URL"
  | "SUBPATH_URL"
  | "RESERVED_PATH"
  | "INVALID_NAME";

export const NORMALIZE_MESSAGE =
  "このURLから公開GitHub Repositoryを確認できませんでした。RepositoryトップページのURLを入力してください。";

/** GitHub host names that address repositories. */
const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * First path segments that are GitHub's own pages rather than an owner.
 * Without this, `github.com/features/copilot` would normalise to a repository.
 */
const RESERVED_OWNERS = new Set([
  "features",
  "topics",
  "collections",
  "trending",
  "explore",
  "marketplace",
  "sponsors",
  "settings",
  "notifications",
  "pulls",
  "issues",
  "search",
  "orgs",
  "organizations",
  "users",
  "about",
  "pricing",
  "enterprise",
  "login",
  "join",
  "new",
  "codespaces",
  "apps",
  "security",
  "readme",
  "account",
  "dashboard",
  "stars",
  "watching",
]);

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Turns user input into a canonical owner/repo pair.
 *
 * Only the owner and repo are ever extracted; the backend then talks to a fixed
 * GitHub API endpoint rather than fetching the user-supplied URL, which is the
 * SSRF defence required by spec 29.2.
 */
export function normalizeRepoUrl(input: string): NormalizeResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "EMPTY" };

  // Accept bare `github.com/owner/repo` and `owner/repo` shorthand by giving
  // the parser a scheme to work with.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `https://${raw.replace(/^\/+/, "")}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "NOT_A_URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "NOT_GITHUB_HOST" };
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "NOT_GITHUB_HOST" };
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, reason: "NOT_GITHUB_HOST" };
  if (segments.length === 1) return { ok: false, reason: "PROFILE_URL" };
  if (segments.length > 2) return { ok: false, reason: "SUBPATH_URL" };

  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { ok: false, reason: "RESERVED_PATH" };
  }

  // `.git` suffix comes from clone URLs and is not part of the repo name.
  const repo = repoSegment.replace(/\.git$/i, "");
  if (repo === "" || !NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) {
    return { ok: false, reason: "INVALID_NAME" };
  }
  if (repo === "." || repo === "..") {
    return { ok: false, reason: "INVALID_NAME" };
  }

  return {
    ok: true,
    ref: { owner, repo },
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

/** Cache key for a repository. GitHub owner/repo are case-insensitive. */
export function repoKey(ref: RepoRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
}
