import { CIRCUIT_BREAKER, USER_AGENT } from "./config";
import type { SourceName } from "./types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string) {
    super(`Timeout for ${url}`);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly source: SourceName) {
    super(`Circuit open for ${source}`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Circuit breaker (spec 21.5). Per-isolate rather than global: on Workers each
 * isolate independently learns that a source is failing, which is enough to stop
 * a dead upstream from holding up every request in that isolate.
 */
type CircuitState = { failures: number; openedAt: number | null };
const circuits = new Map<SourceName, CircuitState>();

function circuit(source: SourceName): CircuitState {
  let state = circuits.get(source);
  if (!state) {
    state = { failures: 0, openedAt: null };
    circuits.set(source, state);
  }
  return state;
}

export function isCircuitOpen(source: SourceName, now = Date.now()): boolean {
  const state = circuit(source);
  if (state.openedAt === null) return false;
  if (now - state.openedAt >= CIRCUIT_BREAKER.openDurationMs) {
    state.openedAt = null;
    state.failures = 0;
    return false;
  }
  return true;
}

function recordFailure(source: SourceName, now = Date.now()): void {
  const state = circuit(source);
  state.failures += 1;
  if (state.failures >= CIRCUIT_BREAKER.failureThreshold) {
    state.openedAt = now;
  }
}

function recordSuccess(source: SourceName): void {
  const state = circuit(source);
  state.failures = 0;
  state.openedAt = null;
}

/** Reset breaker state. Exposed for tests. */
export function resetCircuits(): void {
  circuits.clear();
}

/**
 * Concurrency limiter (spec 21.3). Keeps well below GitHub's 100-concurrent
 * secondary limit so a burst of analyses cannot trip it.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export type JsonFetchOptions = {
  source: SourceName;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Response TTL for the Cloudflare Cache API, in seconds. */
  cacheTtlSeconds?: number;
  /** Statuses that should resolve to `null` rather than throw. */
  treatAsMissing?: number[];
  /** Called with the raw Response before the body is read. */
  onResponse?: (response: Response) => void;
};

export type JsonFetchResult<T> = {
  data: T | null;
  status: number;
  fetchedAt: string;
  /** True when the Cloudflare edge cache served the response. */
  fromCache: boolean;
};

/**
 * Fetches JSON with a hard timeout, edge caching and circuit-breaker
 * accounting. Never retries on its own: retry policy differs per endpoint
 * (see `github.ts` for the 202 statistics case), and blind retries are exactly
 * what spec 35 forbids for 403/429.
 */
export async function fetchJson<T>(
  url: string,
  options: JsonFetchOptions,
): Promise<JsonFetchResult<T>> {
  if (isCircuitOpen(options.source)) {
    throw new CircuitOpenError(options.source);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const init: RequestInit = {
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...options.headers,
      },
      signal: controller.signal,
    };
    if (options.cacheTtlSeconds !== undefined) {
      // `cf.cacheTtl` is honoured on Workers and ignored elsewhere.
      (init as RequestInit & { cf?: unknown }).cf = {
        cacheTtl: options.cacheTtlSeconds,
        cacheEverything: true,
      };
    }

    const response = await fetch(url, init);
    options.onResponse?.(response);
    const fetchedAt = new Date().toISOString();
    const fromCache = (response.headers.get("cf-cache-status") ?? "") === "HIT";

    if (options.treatAsMissing?.includes(response.status)) {
      recordSuccess(options.source);
      return { data: null, status: response.status, fetchedAt, fromCache };
    }

    if (!response.ok) {
      // 4xx other than rate limiting is an upstream contract issue, not an
      // outage, so it must not trip the breaker for everyone else.
      if (response.status >= 500 || response.status === 429) {
        recordFailure(options.source);
      }
      const body = await response.text().catch(() => "");
      throw new HttpError(response.status, url, body.slice(0, 500));
    }

    const data = (await response.json()) as T;
    recordSuccess(options.source);
    return { data, status: response.status, fetchedAt, fromCache };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      recordFailure(options.source);
      throw new TimeoutError(url);
    }
    recordFailure(options.source);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
