// A minimal read-only FHIR R4 search client: follows `next` links with a page ceiling, applies a timeout per page,
// and counts failures. Some servers answer HTTP 200 with an OperationOutcome when a search parameter is unknown;
// that is reported as an error of kind "outcome", never as an empty result.
import { Counters, getJson, HttpError, qs, type HttpOptions } from "./http.ts";

export type FhirResource = { resourceType: string; id?: string; [k: string]: unknown };
export type Bundle = {
  resourceType: "Bundle";
  total?: number;
  link?: { relation: string; url: string }[];
  entry?: { fullUrl?: string; resource?: FhirResource; search?: { mode?: string } }[];
};

export type SearchParams = Record<string, string | number | undefined | (string | number)[]>;

export type SearchResult = {
  /** Resources of the searched type (search mode "match", or every entry of that type when the server omits modes). */
  matches: FhirResource[];
  /** Other resources returned by _include/_revinclude, keyed "Type/id". */
  included: Map<string, FhirResource>;
  pages: number;
  /** Server-reported total from the first page, when given. */
  total: number | null;
  /** true when the page ceiling stopped us before the last page. */
  truncated: boolean;
  ms: number;
  /** First request URL (for the developer view / provenance). */
  ref: string;
};

export type FhirClientOptions = HttpOptions & {
  /** Page ceiling per search (default 20). */
  maxPages?: number;
};

export class FhirError extends Error {
  kind: HttpError["kind"];
  status: number | null;
  url: string;
  constructor(kind: HttpError["kind"], status: number | null, url: string, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.url = url;
  }
}

export class FhirClient {
  readonly base: string;
  readonly opts: FhirClientOptions;
  readonly counters: Counters;
  constructor(base: string, opts: FhirClientOptions = {}) {
    this.base = base.replace(/\/+$/, "");
    this.counters = opts.counters ?? new Counters();
    this.opts = { ...opts, counters: this.counters };
  }

  url(path: string, params: SearchParams = {}): string {
    const q = qs(params);
    return `${this.base}/${path.replace(/^\/+/, "")}${q ? `?${q}` : ""}`;
  }

  private async page(url: string): Promise<{ body: Bundle; ms: number }> {
    try {
      const { body, ms } = await getJson<Bundle | FhirResource>(url, this.opts);
      if ((body as FhirResource).resourceType === "OperationOutcome") {
        const issue = ((body as { issue?: { severity?: string; diagnostics?: string }[] }).issue ?? [])[0];
        if (!issue || issue.severity === "error" || issue.severity === "fatal") {
          this.counters.errors.outcome++;
          throw new FhirError("outcome", 200, url, `OperationOutcome: ${(issue?.diagnostics ?? "no diagnostics").slice(0, 1000)}`);
        }
      }
      return { body: body as Bundle, ms };
    } catch (err) {
      if (err instanceof FhirError) throw err;
      if (err instanceof HttpError) throw new FhirError(err.kind, err.status, err.url, err.message);
      throw err;
    }
  }

  /** Search with paging. Throws FhirError on the FIRST page failing; a later page failing marks the result truncated. */
  async search(type: string, params: SearchParams = {}, maxPages = this.opts.maxPages ?? 20): Promise<SearchResult & { pageError?: string }> {
    const t0 = performance.now();
    const first = this.url(type, params);
    let url: string | undefined = first;
    const matches: FhirResource[] = [];
    const included = new Map<string, FhirResource>();
    let pages = 0;
    let total: number | null = null;
    let pageError: string | undefined;
    while (url && pages < maxPages) {
      let body: Bundle;
      try {
        ({ body } = await this.page(url));
      } catch (err) {
        if (pages === 0) throw err;
        pageError = (err as Error).message;
        break;
      }
      pages++;
      if (pages === 1 && typeof body.total === "number") total = body.total;
      for (const e of body.entry ?? []) {
        const r = e.resource;
        if (!r) continue;
        const mode = e.search?.mode;
        if (mode === "include" || (mode === undefined && r.resourceType !== type)) included.set(`${r.resourceType}/${r.id}`, r);
        else if (mode === "outcome") continue;
        else matches.push(r);
      }
      url = body.link?.find((l) => l.relation === "next")?.url;
    }
    return { matches, included, pages, total, truncated: Boolean(url) || Boolean(pageError), ms: Math.round(performance.now() - t0), ref: first, pageError };
  }

  async read(ref: string): Promise<FhirResource> {
    const { body } = await this.page(this.url(ref));
    return body as unknown as FhirResource;
  }

  /** Returns the server's CapabilityStatement, or null when /metadata is not exposed (some gateways return 404). */
  async capabilities(): Promise<FhirResource | null> {
    try {
      return await this.read("metadata");
    } catch (err) {
      if (err instanceof FhirError && err.kind === "http" && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Asks the server which search parameters a resource type supports by sending a deliberately unknown one.
   * HAPI-based servers answer with the list ("Valid search parameters for this search are: [...]"). Returns null
   * when the server does not say.
   */
  async probeSearchParams(type: string): Promise<string[] | null> {
    // Deliberately not counted as an error: the "unknown parameter" answer is what we ask for.
    let body: unknown;
    try {
      ({ body } = await getJson(this.url(type, { __unknown_param_probe: "1" }), { ...this.opts, counters: undefined }));
    } catch (err) {
      body = { issue: [{ diagnostics: (err as Error).message }] };
    }
    const text = JSON.stringify(body);
    const m = /Valid search parameters for this search are:\s*(?:%5B|\[)([^\]%]*)(?:%5D|\])/.exec(text);
    return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  }
}
