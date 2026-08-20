/**
 * Risk 1 / Risk 2 / Risk 6 / Risk 7 calibration run (spec 36).
 *
 * Analyses a set of well-known repositories through the running dev server and
 * prints one row each, so a human can judge whether the scores feel right and
 * whether mature low-change projects are being unfairly punished. Also reports
 * the GitHub request count per uncached analysis, which spec 30 names as the
 * number to watch.
 *
 * Usage:
 *   make run        # in another shell, with .dev.vars in place
 *   node dev/calibrate.mjs [--out results.json]
 */

const BASE = "http://localhost:3210";

/** A deliberate mix: hyperactive, mature/low-change, tiny, and archived. */
const REPOS = [
  "facebook/react",
  "vercel/next.js",
  "ggerganov/llama.cpp",
  "torvalds/linux",
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
  "sindresorhus/is-odd",
  "sindresorhus/slugify",
  "jquery/jquery",
  "moment/moment",
  "twbs/bootstrap",
  "curl/curl",
  "openssl/openssl",
  "sqlite/sqlite",
  "redis/redis",
  "prettier/prettier",
  "eslint/eslint",
  "vitejs/vite",
];

const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > -1 ? process.argv[outIndex + 1] : null;

async function analyze(slug) {
  const [owner, repo] = slug.split("/");
  const response = await fetch(`${BASE}/api/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://github.com/${owner}/${repo}` }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    return { slug, error: body.error?.code ?? `HTTP_${response.status}` };
  }

  // Wait for the health stage to land.
  let payload = body;
  const deadline = Date.now() + 45_000;
  while (!["complete", "partial", "failed"].includes(payload.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const poll = await fetch(`${BASE}/api/v1/analyses/${payload.analysis_id}`, {
      cache: "no-store",
    });
    if (!poll.ok) break;
    payload = await poll.json();
  }
  return { slug, payload };
}

function pad(value, width, right = false) {
  const s = String(value ?? "—");
  return right ? s.padStart(width) : s.padEnd(width);
}

const rows = [];
for (const slug of REPOS) {
  const result = await analyze(slug);
  if (result.error) {
    console.log(`${pad(slug, 26)} ERROR ${result.error}`);
    rows.push({ slug, error: result.error });
    continue;
  }
  const p = result.payload;
  const c = p.contributors;
  const row = {
    slug,
    status: p.status,
    label: p.status_label,
    score: p.health_score,
    coverage: p.coverage === null ? null : Math.round(p.coverage * 100),
    maintenance: p.scores?.maintenance ?? null,
    community: p.scores?.community_resilience ?? null,
    security: p.scores?.security_hygiene ?? null,
    release: p.scores?.release_health ?? null,
    adoption: p.scores?.adoption ?? null,
    raw: c?.rawContributors ?? null,
    effective: c?.effectiveContributors ?? null,
    bots: c?.botContributors ?? null,
    agents: c?.knownAiAgents ?? null,
    top3: c?.top3Share === null || c?.top3Share === undefined ? null : Math.round(c.top3Share * 100),
    unavailable: p.unavailable?.join(",") ?? "",
  };
  rows.push(row);
  console.log(
    [
      pad(row.slug, 26),
      pad(row.score, 4, true),
      pad(`${row.coverage ?? "—"}%`, 5, true),
      pad(row.label, 14),
      pad(row.maintenance, 4, true),
      pad(row.community, 4, true),
      pad(row.security, 4, true),
      pad(row.release, 4, true),
      pad(row.adoption, 4, true),
      pad(row.raw, 6, true),
      pad(row.effective, 5, true),
      pad(row.bots, 5, true),
      pad(row.agents, 4, true),
      pad(row.top3 === null ? "—" : `${row.top3}%`, 5, true),
      row.unavailable,
    ].join(" "),
  );
}

const metrics = await fetch(`${BASE}/api/v1/metrics`).then((r) => r.json());
console.log("\n--- observability (current hour) ---");
console.log(JSON.stringify(metrics.derived, null, 2));
console.log(JSON.stringify(metrics.counters, null, 2));

if (outPath) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, JSON.stringify({ rows, metrics }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
