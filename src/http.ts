// Small HTTP layer shared by every client in this package: a timeout per request, an injectable fetch (tests run
// offline), and an error counter that a sweep prints next to its findings (a sweep that hides its failures reads as
// "nothing found" when it really means "could not look").

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string }) => Promise<Response>;

/** "outcome": the server answered 200 with an OperationOutcome error instead of data (some FHIR servers do). */
export type ErrorKind = "network" | "timeout" | "http" | "parse" | "outcome";
export type RequestLog = { url: string; status: number | null; ms: number; error?: string; kind?: ErrorKind };

export class HttpError extends Error {
  kind: ErrorKind;
  status: number | null;
  url: string;
  ms: number;
  constructor(kind: ErrorKind, url: string, status: number | null, ms: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.url = url;
    this.ms = ms;
  }
}

/** Counts every request and every failure by kind. One instance per sweep. */
export class Counters {
  requests = 0;
  errors: Record<ErrorKind, number> = { network: 0, timeout: 0, http: 0, parse: 0, outcome: 0 };
  /** HTTP status codes seen on failures, e.g. { "401": 2, "500": 1 }. */
  httpStatus: Record<string, number> = {};
  log: RequestLog[] = [];
  keepLog: boolean;
  constructor(keepLog = false) { this.keepLog = keepLog; }
  get errorTotal(): number { return Object.values(this.errors).reduce((a, b) => a + b, 0); }
  record(entry: RequestLog): void {
    this.requests++;
    if (entry.kind) {
      this.errors[entry.kind]++;
      if (entry.kind === "http" && entry.status !== null) this.httpStatus[String(entry.status)] = (this.httpStatus[String(entry.status)] ?? 0) + 1;
    }
    if (this.keepLog) this.log.push(entry);
  }
  summary(): string {
    const e = this.errors;
    const codes = Object.entries(this.httpStatus).map(([k, v]) => `${k}×${v}`).join(" ");
    return `requests ${this.requests} · errors ${this.errorTotal} (network ${e.network}, timeout ${e.timeout}, http ${e.http}${codes ? ` [${codes}]` : ""}, parse ${e.parse}, outcome ${e.outcome})`;
  }
}

export type HttpOptions = {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  counters?: Counters;
  userAgent?: string;
};

export const DEFAULT_UA = "plannet-directory-check/0.1 (+public provider directory audit; read-only)";

/** GET a JSON document. Throws HttpError (never a bare error) so callers can count and label failures. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}, accept = "application/fhir+json, application/json"): Promise<{ body: T; ms: number; status: number }> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: accept, "User-Agent": opts.userAgent ?? DEFAULT_UA }, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    const aborted = ctrl.signal.aborted;
    const kind: ErrorKind = aborted ? "timeout" : "network";
    const message = aborted ? `timeout after ${timeoutMs} ms` : `network error: ${(err as Error)?.message ?? String(err)}`;
    opts.counters?.record({ url, status: null, ms: ms(), error: message, kind });
    throw new HttpError(kind, url, null, ms(), message);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const kind: ErrorKind = ctrl.signal.aborted ? "timeout" : "network";
    const message = ctrl.signal.aborted ? `timeout after ${timeoutMs} ms (reading body)` : `body read failed: ${(err as Error)?.message}`;
    opts.counters?.record({ url, status: res.status, ms: ms(), error: message, kind });
    throw new HttpError(kind, url, res.status, ms(), message);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const message = `HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`;
    opts.counters?.record({ url, status: res.status, ms: ms(), error: message, kind: "http" });
    throw new HttpError("http", url, res.status, ms(), message);
  }
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    const message = `not JSON: ${text.slice(0, 120).replace(/\s+/g, " ")}`;
    opts.counters?.record({ url, status: res.status, ms: ms(), error: message, kind: "parse" });
    throw new HttpError("parse", url, res.status, ms(), message);
  }
  opts.counters?.record({ url, status: res.status, ms: ms() });
  return { body, ms: ms(), status: res.status };
}

export function qs(params: Record<string, string | number | undefined | (string | number)[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.append(k, String(v));
  }
  return sp.toString();
}
