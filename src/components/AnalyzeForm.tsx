"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { NORMALIZE_MESSAGE, normalizeRepoUrl } from "@/lib/url";

const SAMPLES = [
  "https://github.com/ggerganov/llama.cpp",
  "https://github.com/sindresorhus/is-odd",
  "https://github.com/facebook/react",
];

/**
 * The only input on the site (spec 16.1): one URL field, no filters and no
 * advanced options. Validation runs client-side with the same normaliser the
 * backend uses, so a bad URL is rejected without spending a request.
 */
export function AnalyzeForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(raw: string) {
    const normalized = normalizeRepoUrl(raw);
    if (!normalized.ok) {
      setError(NORMALIZE_MESSAGE);
      return;
    }
    setError(null);
    startTransition(() => {
      router.push(`/repo/${normalized.ref.owner}/${normalized.ref.repo}`);
    });
  }

  return (
    <div className="probe">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(value);
        }}
      >
        <label className="probe__label" htmlFor="repo-url">
          GitHub repository URL
        </label>
        <div className="probe__row">
          <input
            id="repo-url"
            className="probe__input"
            name="url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repository"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={error ? "repo-url-error" : undefined}
          />
          <button className="probe__submit" type="submit" disabled={pending}>
            {pending ? "Opening" : "Analyze"}
          </button>
        </div>
      </form>

      {error && (
        <p className="probe__error" id="repo-url-error" role="alert">
          {error}
        </p>
      )}

      <div className="probe__samples">
        <span style={{ color: "var(--ash-dim)" }}>試す:</span>
        {SAMPLES.map((sample) => (
          <button
            key={sample}
            type="button"
            className="probe__sample"
            onClick={() => {
              setValue(sample);
              submit(sample);
            }}
          >
            {sample.replace("https://github.com/", "")}
          </button>
        ))}
      </div>
    </div>
  );
}
