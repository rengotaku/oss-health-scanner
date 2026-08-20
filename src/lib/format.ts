import { CONCENTRATION_BANDS } from "./config";

export function intFmt(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString("en-US");
}

export function pctFmt(share: number | null | undefined): string | null {
  if (share === null || share === undefined || !Number.isFinite(share)) return null;
  return `${Math.round(share * 100)}%`;
}

/** Relative time in Japanese, matching the "Analyzed X ago" copy in spec 16.2. */
export function agoFmt(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "1分未満前";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}分前`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}時間前`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}日前`;
  const months = days / 30.44;
  if (months < 12) return `${Math.round(months)}か月前`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)}年前`;
}

export function daysFmt(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days < 1) return "1日未満";
  if (days < 60) return `${Math.round(days)}日`;
  if (days < 730) return `${Math.round(days / 30.44)}か月`;
  return `${(days / 365.25).toFixed(1)}年`;
}

export function secondsToDaysFmt(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return daysFmt(seconds / 86_400);
}

export function dateFmt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Concentration band for the UI (spec 8.3). */
export function concentrationBand(share: number | null): {
  tone: "good" | "warn" | "high" | "bad";
  label: string;
} | null {
  if (share === null) return null;
  for (const band of CONCENTRATION_BANDS) {
    if (share < band.maxShare) return { tone: band.tone, label: band.label };
  }
  return null;
}
