import type { ReactNode } from "react";
import type { Signal } from "@/lib/types";

export const TICK_COUNT = 20;

/**
 * The signature readout: a score drawn as 20 discrete segments.
 *
 * A continuous bar invites reading a 3-point difference as meaningful. These
 * thresholds are explicitly provisional (spec 9.4 / 37 step 10), so the display
 * quantises to 5-point steps and refuses to imply more precision than the model
 * has.
 */
export function Ticks({ score }: { score: number | null }) {
  const lit = score === null ? 0 : Math.round((score / 100) * TICK_COUNT);
  return (
    <span className="ticks" aria-hidden="true">
      {Array.from({ length: TICK_COUNT }, (_, index) => (
        <span
          key={index}
          className={`ticks__tick ${index < lit ? "ticks__tick--on" : "ticks__tick--off"}`}
        />
      ))}
    </span>
  );
}

export type ValueTone = "good" | "warn" | "high" | "bad" | undefined;

/**
 * A label/value pair on the shared measuring axis.
 *
 * Missing data renders as an explicit N/A in a dimmer style rather than as 0 or
 * an empty cell, because spec 16 requires "no data" and "no problem" to stay
 * visibly different.
 */
export function Row({
  label,
  value,
  tone,
  hint,
  emphasis,
  muted,
}: {
  label: string;
  value: ReactNode;
  tone?: ValueTone;
  hint?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  const isMissing = value === null || value === undefined || value === "";
  return (
    <div
      className={`row${emphasis ? " row--emphasis" : ""}${muted ? " row--muted" : ""}`}
    >
      <span className="row__label">
        {label}
        {hint && (
          <span className="info" title={hint} tabIndex={0} role="note" aria-label={hint}>
            i
          </span>
        )}
      </span>
      <span
        className={`row__value${isMissing ? " row__value--na" : ""}${tone ? ` row__value--${tone}` : ""}`}
      >
        {isMissing ? "N/A" : value}
      </span>
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {hint && <span className="panel__hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const GLYPH: Record<Signal["type"], string> = {
  positive: "✓",
  warning: "!",
  negative: "×",
  info: "·",
};

export function SignalList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) return null;
  return (
    <ul className="signals">
      {signals.map((signal, index) => (
        <li key={`${signal.type}-${index}`} className={`signal signal--${signal.type}`}>
          <span className="signal__glyph" aria-hidden="true">
            {GLYPH[signal.type]}
          </span>
          <span>{signal.text}</span>
        </li>
      ))}
    </ul>
  );
}
