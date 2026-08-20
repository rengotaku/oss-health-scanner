/**
 * Release Health threshold calibration (spec 36 Risk 1, spec 37 step 10).
 *
 * The shipped formula puts 10 of 24 repositories at the floor value 20, so it is
 * mostly reporting "this project releases often" rather than "this project is
 * late". This fetches real release history and recomputes Release Health under
 * the three candidate fixes, so the choice is made against data.
 *
 * Usage:
 *   make dev-vars                          # writes .dev.vars from pass
 *   node dev/release-calibration.mjs       # reads credentials from .dev.vars
 *
 * Reads only the Releases API: one request per repository.
 */

import { readFileSync } from "node:fs";

function readAuthHeader() {
  const line = readFileSync(".dev.vars", "utf8")
    .split("\n")
    .find((l) => l.startsWith("GITHUB_TOKEN="));
  const value = line?.slice("GITHUB_TOKEN=".length).trim();
  if (!value) {
    console.error("No GITHUB_TOKEN in .dev.vars. Run `make dev-vars` first.");
    process.exit(1);
  }
  return "Bearer ".concat(value);
}

const authorization = readAuthHeader();

const REPOS = [
  "facebook/react",
  "vercel/next.js",
  "ggerganov/llama.cpp",
  "rust-lang/rust",
  "golang/go",
  "python/cpython",
  "kubernetes/kubernetes",
  "microsoft/vscode",
  "vuejs/core",
  "sveltejs/svelte",
  "denoland/deno",
  "tokio-rs/tokio",
  "pallets/flask",
  "psf/requests",
  "expressjs/express",
  "lodash/lodash",
  "chalk/chalk",
  "sindresorhus/slugify",
  "jquery/jquery",
  "moment/moment",
  "twbs/bootstrap",
  "curl/curl",
  "openssl/openssl",
  "redis/redis",
  "prettier/prettier",
  "eslint/eslint",
  "vitejs/vite",
];

const DAY_MS = 86_400_000;
const NOW = Date.now();

/** Same ladder as RELEASE_DELAY_LADDER in src/lib/config.ts. */
const LADDER = [
  { maxRatio: 1.0, score: 100 },
  { maxRatio: 1.5, score: 90 },
  { maxRatio: 2.0, score: 70 },
  { maxRatio: 3.0, score: 45 },
  { maxRatio: Infinity, score: 20 },
];

function ladderScore(ratio) {
  if (ratio === null) return null;
  for (const step of LADDER) if (ratio <= step.maxRatio) return step.score;
  return 20;
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function intervals(dates) {
  const out = [];
  for (let i = 0; i < dates.length - 1; i += 1) {
    const days = (dates[i] - dates[i + 1]) / DAY_MS;
    if (days > 0) out.push(days);
  }
  return out;
}

/** What ships today: median over the newest 6 releases. */
function current(dates) {
  const sample = dates.slice(0, 6);
  const iv = intervals(sample);
  const med = iv.length >= 2 ? median(iv) : null;
  const age = (NOW - sample[0]) / DAY_MS;
  const ratio = med !== null && med > 0 ? age / med : null;
  return { med, age, ratio, score: ladderScore(ratio) };
}

/** Option 1: floor the median, so a fast cadence cannot amplify lateness. */
function option1(dates, floorDays) {
  const base = current(dates);
  if (base.med === null) return { ...base, score: null };
  const med = Math.max(base.med, floorDays);
  const ratio = base.age / med;
  return { med, age: base.age, ratio, score: ladderScore(ratio) };
}

/** Option 2: median over every release in the last year, not the newest 6. */
function option2(dates) {
  const cutoff = NOW - 365 * DAY_MS;
  const inYear = dates.filter((d) => d >= cutoff);
  const sample = inYear.length >= 3 ? inYear : dates.slice(0, 6);
  const iv = intervals(sample);
  const med = iv.length >= 2 ? median(iv) : null;
  const age = (NOW - dates[0]) / DAY_MS;
  const ratio = med !== null && med > 0 ? age / med : null;
  return { med, age, ratio, score: ladderScore(ratio) };
}

/**
 * Option 1b: collapse releases that land on the same calendar day before
 * measuring the interval, then floor the median.
 *
 * The data says the dominant failure is not a fast cadence but same-day release
 * bursts: facebook/react, openssl and redis all report a median interval of 0.0
 * days because a monorepo publishes many packages at once. Those are one release
 * event, not many, so counting them as separate cadence samples drives the
 * divisor toward zero and the ratio into the thousands.
 */
function option1b(dates, floorDays) {
  const days = [...new Set(dates.map((d) => Math.floor(d / DAY_MS)))]
    .sort((a, b) => b - a)
    .map((d) => d * DAY_MS);
  const sample = days.slice(0, 6);
  const iv = intervals(sample);
  const med = iv.length >= 2 ? median(iv) : null;
  const age = (NOW - dates[0]) / DAY_MS;
  if (med === null) return { med, age, ratio: null, score: null };
  const floored = Math.max(med, floorDays);
  const ratio = age / floored;
  return { med: floored, age, ratio, score: ladderScore(ratio) };
}

/** Option 3: N/A below a weekly cadence — the ratio carries no meaning there. */
function option3(dates, minDays) {
  const base = current(dates);
  if (base.med !== null && base.med < minDays) return { ...base, score: null };
  return base;
}

async function releaseDates(slug) {
  const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=100`, {
    headers: {
      authorization,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "oss-health-scanner/0.1",
    },
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const body = await res.json();
  const dates = body
    .filter((r) => !r.draft && r.published_at)
    .map((r) => Date.parse(r.published_at))
    .sort((a, b) => b - a);
  return { dates };
}

const rows = [];
for (const slug of REPOS) {
  const { dates, error } = await releaseDates(slug);
  if (error || !dates || dates.length === 0) {
    rows.push({ slug, error: error ?? "no releases" });
    continue;
  }
  rows.push({
    slug,
    count: dates.length,
    cur: current(dates),
    o1: option1(dates, 14),
    o2: option2(dates),
    o1b: option1b(dates, 14),
    o3: option3(dates, 7),
  });
}

const left = (v, n) => String(v).padEnd(n);
const right = (v, n) => String(v ?? "—").padStart(n);
const scoreOf = (r) => (r?.score === null ? "N/A" : String(r?.score ?? "—"));
const num = (v) => (v === null || v === undefined ? "—" : v.toFixed(1));

console.log(
  `${left("repository", 24)} ${right("rel", 4)} ${right("median", 7)} ${right("age", 6)} ` +
    `${right("ratio", 6)} ${right("cur", 4)} ${right("o1", 4)} ${right("o1b", 5)} ${right("o2", 4)} ${right("o3", 4)}`,
);
for (const r of rows) {
  if (r.error) {
    console.log(`${left(r.slug, 24)} ${r.error}`);
    continue;
  }
  console.log(
    `${left(r.slug, 24)} ${right(r.count, 4)} ${right(num(r.cur.med), 7)} ` +
      `${right(num(r.cur.age), 6)} ${right(num(r.cur.ratio), 6)} ${right(scoreOf(r.cur), 4)} ` +
      `${right(scoreOf(r.o1), 4)} ${right(scoreOf(r.o1b), 5)} ${right(scoreOf(r.o2), 4)} ${right(scoreOf(r.o3), 4)}`,
  );
}

const scored = rows.filter((r) => !r.error);
function summary(key) {
  const vals = scored.map((r) => r[key].score);
  const na = vals.filter((v) => v === null).length;
  const nums = vals.filter((v) => v !== null);
  return {
    n: nums.length,
    na,
    floor: nums.filter((v) => v === 20).length,
    top: nums.filter((v) => v === 100).length,
    mean: (nums.reduce((a, b) => a + b, 0) / (nums.length || 1)).toFixed(1),
    distinct: new Set(nums).size,
  };
}

console.log("\n--- collapsed-day detail for the rows option1b moves most ---");
for (const slug of ["expressjs/express", "facebook/react", "openssl/openssl", "redis/redis"]) {
  const r = rows.find((x) => x.slug === slug);
  if (!r || r.error) continue;
  console.log(
    `${left(slug, 22)} raw-median=${num(r.cur.med)}d  collapsed-median(floored)=${num(r.o1b.med)}d  ` +
      `age=${num(r.o1b.age)}d  ratio=${num(r.o1b.ratio)}  ${r.cur.score} -> ${scoreOf(r.o1b)}`,
  );
}

console.log(`\n--- distribution over ${scored.length} repositories ---`);
console.log("variant   scored  N/A  at-floor(20)  at-top(100)   mean  distinct");
for (const [label, key] of [
  ["current", "cur"],
  ["option1", "o1"],
  ["option1b", "o1b"],
  ["option2", "o2"],
  ["option3", "o3"],
]) {
  const s = summary(key);
  console.log(
    `${left(label, 9)} ${right(s.n, 6)} ${right(s.na, 4)} ${right(s.floor, 13)} ` +
      `${right(s.top, 12)} ${right(s.mean, 6)} ${right(s.distinct, 9)}`,
  );
}
