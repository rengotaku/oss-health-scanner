/**
 * Local screenshot harness. Usage:
 *   node dev/shot.mjs <out-dir> [light|dark]
 * Requires the dev server on http://localhost:3210 and the local D1 fixture
 * (`dev/seed-local.sql`) applied.
 */
import { chromium } from "playwright";

const out = process.argv[2];
const scheme = process.argv[3] === "dark" ? "dark" : "light";
const prefix = scheme === "dark" ? "dark-" : "";
const base = "http://localhost:3210";

const browser = await chromium.launch();
const sizes = [
  ["sm", 390, 900],
  ["md", 834, 1100],
  ["lg", 1440, 1200],
];

for (const [name, width, height] of sizes) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${out}/${prefix}home-${name}.png`, fullPage: true });

  await page.goto(`${base}/repo/curl/curl`, { waitUntil: "networkidle" });
  await page.waitForSelector(".verdict__value", { timeout: 15000 });
  await page.screenshot({ path: `${out}/${prefix}report-${name}.png`, fullPage: true });

  if (name === "lg") {
    await page.locator(".gauge").first().click();
    await page.waitForSelector(".gauge__why");
    await page.screenshot({ path: `${out}/${prefix}report-why-${name}.png` });

    await page.goto(`${base}/repo/ggerganov/no-such-repo-xyz`, { waitUntil: "networkidle" });
    await page.waitForSelector(".failure__title", { timeout: 20000 });
    await page.screenshot({ path: `${out}/${prefix}error-${name}.png` });
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  console.log(
    `${scheme} ${name}: overflow=${overflow} consoleErrors=${errors.length}` +
      (errors.length ? ` :: ${errors.slice(0, 3).join(" | ")}` : ""),
  );
  await page.close();
}

await browser.close();
