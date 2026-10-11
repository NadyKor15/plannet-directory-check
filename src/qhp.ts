// Marketplace (QHP) machine-readable provider files, the format CMS requires from issuers on the federal exchange
// (https://github.com/CMSgov/QHP-provider-formulary-APIs). An issuer publishes an index (cms-data-index.json) that
// lists provider_urls / plan_urls / formulary_urls; each providers file is ONE JSON array that can be 1-2 GB.
// We never load a providers file into memory: `streamJsonArray` reads it as a byte stream, cuts the top-level array
// into objects, hands each object to a callback, and stops at a byte ceiling.
import { getJson, HttpError, type FetchLike, type HttpOptions } from "./http.ts";

export type QhpIndex = { provider_urls: string[]; plan_urls?: string[]; formulary_urls?: string[] };
export type QhpPlanRef = { plan_id_type?: string; plan_id: string; network_tier?: string; years?: number[] };
export type QhpAddress = { address?: string; address_2?: string; city?: string; state?: string; zip?: string; phone?: string };
export type QhpProvider = {
  npi?: number | string;
  type: "INDIVIDUAL" | "FACILITY" | string;
  name?: { prefix?: string; first?: string; middle?: string; last?: string; suffix?: string } | string;
  facility_name?: string;
  facility_type?: string[];
  addresses?: QhpAddress[];
  specialty?: string[];
  accepting?: "accepting" | "not accepting" | "accepting in some locations" | string;
  plans?: QhpPlanRef[];
  languages?: string[];
  gender?: string;
  last_updated_on?: string;
};
export type QhpPlan = { plan_id: string; plan_id_type?: string; marketing_name?: string; summary_url?: string; network?: { network_tier?: string }[]; years?: number[] };

export async function fetchQhpIndex(url: string, opts: HttpOptions = {}): Promise<QhpIndex> {
  const { body } = await getJson<QhpIndex>(url, opts, "application/json");
  if (!Array.isArray(body.provider_urls)) throw new Error(`not a CMS QHP index (no provider_urls): ${url}`);
  return body;
}

export type StreamStats = { bytes: number; objects: number; stoppedBy: "end" | "byte-cap" | "callback" | "error"; ms: number; error?: string };

/**
 * Cut a top-level JSON array into objects from a byte stream. Strings and escapes are tracked, so braces inside
 * strings do not confuse it. `onObject` returns true to stop early.
 */
export async function scanJsonArray(chunks: AsyncIterable<Uint8Array>, onObject: (raw: string) => boolean | void, maxBytes = Number.POSITIVE_INFINITY): Promise<Omit<StreamStats, "ms">> {
  const dec = new TextDecoder();
  let depth = 0;
  let inStr = false;
  let esc = false;
  let buf = "";
  let start = -1;
  let bytes = 0;
  let objects = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    const text = dec.decode(chunk, { stream: true });
    // Keep only the unfinished object from the previous chunk.
    const base = buf.length;
    buf += text;
    for (let i = base; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true; // backslash
        else if (c === 34) inStr = false; // quote
        continue;
      }
      if (c === 34) { inStr = true; continue; }
      if (c === 123) { // {
        depth++; // the outer "[" is not counted, so an element object opens at depth 1
        if (depth === 1 && start < 0) start = i;
      } else if (c === 125) { // }
        depth--;
        if (depth === 0 && start >= 0) {
          objects++;
          const stop = onObject(buf.slice(start, i + 1));
          start = -1;
          if (stop) return { bytes, objects, stoppedBy: "callback" };
        }
      }
    }
    if (start >= 0) { buf = buf.slice(start); start = 0; }
    else buf = "";
    if (bytes >= maxBytes) return { bytes, objects, stoppedBy: "byte-cap" };
  }
  return { bytes, objects, stoppedBy: "end" };
}

/** Stream a remote providers file through `scanJsonArray` with a byte ceiling (Range request when supported). */
export async function streamProviders(url: string, onProvider: (p: QhpProvider) => boolean | void, opts: HttpOptions & { maxBytes?: number; fromByte?: number } = {}): Promise<StreamStats> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": opts.userAgent ?? "plannet-directory-check/0.1" };
  // Ask only for the bytes we will read (the server may ignore it and send everything; we stop reading at the cap anyway).
  if (Number.isFinite(maxBytes)) headers.Range = `bytes=${opts.fromByte ?? 0}-${(opts.fromByte ?? 0) + maxBytes - 1}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    const kind = ctrl.signal.aborted ? "timeout" : "network";
    opts.counters?.record({ url, status: null, ms: Math.round(performance.now() - t0), error: String(err), kind });
    throw new HttpError(kind, url, null, Math.round(performance.now() - t0), `${kind}: ${(err as Error)?.message ?? err}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    opts.counters?.record({ url, status: res.status, ms: Math.round(performance.now() - t0), error: `HTTP ${res.status}`, kind: "http" });
    throw new HttpError("http", url, res.status, Math.round(performance.now() - t0), `HTTP ${res.status}`);
  }
  opts.counters?.record({ url, status: res.status, ms: Math.round(performance.now() - t0) });
  let parseErrors = 0;
  const reader = res.body as unknown as AsyncIterable<Uint8Array>;
  let stats: Omit<StreamStats, "ms">;
  try {
    stats = await scanJsonArray(reader, (raw) => {
      let p: QhpProvider;
      try { p = JSON.parse(raw) as QhpProvider; } catch { parseErrors++; return false; }
      return onProvider(p);
    }, maxBytes);
  } catch (err) {
    stats = { bytes: 0, objects: 0, stoppedBy: "error", error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // stop the download if we stopped early
  }
  if (parseErrors && opts.counters) opts.counters.errors.parse += parseErrors;
  return { ...stats, ms: Math.round(performance.now() - t0), ...(parseErrors ? { error: `${parseErrors} objects did not parse (cut at the byte cap or malformed)` } : {}) };
}

export const providerName = (p: QhpProvider): string => {
  if (typeof p.name === "string") return p.name;
  if (!p.name) return p.facility_name ?? "";
  return [p.name.first, p.name.middle, p.name.last].filter(Boolean).join(" ");
};

export const planIdsOf = (p: QhpProvider): string[] => (p.plans ?? []).map((x) => x.plan_id).filter(Boolean);
export const zipOf = (a: QhpAddress): string => (a.zip ?? "").replace(/[^0-9]/g, "").slice(0, 5);
