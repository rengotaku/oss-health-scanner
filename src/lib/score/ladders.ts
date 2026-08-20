/** Shared helpers for the threshold ladders declared in `config.ts`. */

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function scoreByMax<K extends string>(
  ladder: readonly ({ score: number } & Record<K, number>)[],
  key: K,
  value: number,
): number {
  for (const step of ladder) {
    if (value <= step[key]) return step.score;
  }
  return ladder[ladder.length - 1]!.score;
}

/** Weighted mean over the entries that have a score, renormalising weights. */
export function weightedMean(
  parts: { weight: number; score: number | null }[],
): { score: number | null; coverage: number } {
  let weighted = 0;
  let available = 0;
  let total = 0;
  for (const part of parts) {
    total += part.weight;
    if (part.score === null) continue;
    weighted += part.score * part.weight;
    available += part.weight;
  }
  if (available === 0) return { score: null, coverage: 0 };
  return { score: weighted / available, coverage: total > 0 ? available / total : 0 };
}

export function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function formatDays(days: number): string {
  if (days < 1) return "24時間以内";
  if (days < 30) return `${Math.round(days)}日`;
  if (days < 365) return `${Math.round(days / 30)}か月`;
  const years = days / 365;
  return `${years.toFixed(years < 10 ? 1 : 0)}年`;
}
