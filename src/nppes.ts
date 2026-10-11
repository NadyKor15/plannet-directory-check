// NPPES NPI Registry API v2.1 (public, no key): https://npiregistry.cms.hhs.gov/api-page
// Two things a directory sweep needs from it: joining records of different insurers by NPI, and the practice
// (LOCATION) address. Without address_purpose=LOCATION a ZIP search also matches mailing addresses, so practices in
// other cities come back for an Orlando ZIP.
import { getJson, qs, type HttpOptions } from "./http.ts";

export const NPPES_BASE = "https://npiregistry.cms.hhs.gov/api/";

export type NppesAddress = {
  address_purpose: "LOCATION" | "MAILING" | string;
  address_1?: string; address_2?: string; city?: string; state?: string; postal_code?: string; telephone_number?: string;
};
export type NppesTaxonomy = { code: string; desc: string; primary: boolean; state?: string; license?: string; taxonomy_group?: string };
export type NppesResult = {
  number: string;
  enumeration_type: "NPI-1" | "NPI-2";
  basic: { first_name?: string; last_name?: string; middle_name?: string; credential?: string; organization_name?: string; name_prefix?: string; status?: string; last_updated?: string };
  addresses: NppesAddress[];
  practiceLocations?: NppesAddress[];
  taxonomies: NppesTaxonomy[];
};
export type NppesResponse = { result_count?: number; results?: NppesResult[]; Errors?: { description: string; field?: string }[] };

export type NppesQuery = {
  number?: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  taxonomy_description?: string;
  postal_code?: string;
  city?: string;
  state?: string;
  address_purpose?: "LOCATION" | "MAILING" | "PRIMARY" | "SECONDARY";
  enumeration_type?: "NPI-1" | "NPI-2";
  limit?: number;
  skip?: number;
};

export function nppesUrl(q: NppesQuery, base = NPPES_BASE): string {
  return `${base}?${qs({ version: "2.1", ...q, limit: q.limit ?? 200 })}`;
}

/** One NPPES request. Throws HttpError on transport/HTTP failure and Error when NPPES returns its own Errors array. */
export async function nppesSearch(q: NppesQuery, opts: HttpOptions = {}): Promise<{ results: NppesResult[]; count: number; ms: number; url: string }> {
  const url = nppesUrl(q);
  const { body, ms } = await getJson<NppesResponse>(url, opts, "application/json");
  if (body.Errors?.length) {
    if (opts.counters) opts.counters.errors.outcome++;
    throw new Error(`NPPES: ${body.Errors.map((e) => e.description).join("; ")}`);
  }
  const results = body.results ?? [];
  return { results, count: body.result_count ?? results.length, ms, url };
}

export const locationAddress = (r: NppesResult): NppesAddress | null => r.addresses.find((a) => a.address_purpose === "LOCATION") ?? null;
export const primaryTaxonomy = (r: NppesResult): NppesTaxonomy | null => r.taxonomies.find((t) => t.primary) ?? r.taxonomies[0] ?? null;
export const taxonomyCodes = (r: NppesResult): string[] => r.taxonomies.map((t) => t.code);
export const zip5 = (z: string | undefined | null): string => (z ?? "").replace(/[^0-9]/g, "").slice(0, 5);

/** NPIs of individuals with any of the taxonomy codes, whose LOCATION address is in the ZIP. */
export async function npisWithTaxonomyInZip(taxonomyDescription: string, codes: string[], zip: string, opts: HttpOptions = {}): Promise<{ npis: Set<string>; count: number; url: string; ms: number }> {
  const { results, url, ms } = await nppesSearch({ taxonomy_description: taxonomyDescription, postal_code: zip, address_purpose: "LOCATION", enumeration_type: "NPI-1" }, opts);
  const npis = new Set<string>();
  for (const r of results) {
    const loc = locationAddress(r);
    if (zip5(loc?.postal_code) !== zip) continue;
    if (codes.length && !r.taxonomies.some((t) => codes.includes(t.code))) continue;
    npis.add(r.number);
  }
  return { npis, count: results.length, url, ms };
}
