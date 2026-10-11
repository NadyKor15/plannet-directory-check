// "Practitioner roles at locations in ZIP Z" from one directory, normalized to a flat record. Strategy per directory
// (see directories.ts). Every request goes through one FhirClient so its counters hold the sweep's errors.
import type { DirectoryInfo } from "./directories.ts";
import { FhirClient, FhirError, type FhirResource } from "./fhir.ts";
import { acceptingNew, addressOf, agePolicyPublished, hasHours, hoursConflict, networkRefs, newPatientsOf, npiOf, referenceList, specialtyTexts } from "./plannet.ts";

export type NormalizedRole = {
  directory: string;
  roleId: string;
  npi: string | null;
  practitionerRef: string | null;
  /** Practitioner display name when the directory gives one (included Practitioner or reference display). */
  name: string | null;
  specialtyCodes: string[];
  specialtyTexts: string[];
  /** The role's location inside the searched ZIP. */
  location: { ref: string; name: string | null; line: string; city: string; state: string; zip: string } | null;
  locationCount: number;
  networks: string[];
  networkNames: string[];
  /** Vendor plan identifiers carried on the role (e.g. Florida Blue `plan_id`). */
  planIds: string[];
  accepting: "accepting" | "not_accepting" | "unknown";
  newPatientsPresent: boolean;
  hoursPresent: boolean;
  hoursConflict: boolean;
  age: { published: boolean; matches: string[] };
  /** Raw resources, kept only when asked (capturing fixtures); never written by the audit. */
  raw?: { role: FhirResource; location: FhirResource | null; practitioner: FhirResource | null };
};

export type ZipQuery = {
  zip: string;
  /** Network reference to require server-side where the server supports `network` (per-location strategy). */
  network?: string;
  /** Identifier filter for servers that carry a plan id on the role (chain strategy), "system|value". */
  identifier?: string;
  /** Free-text specialty filter (`specialty:text`) where supported (chain strategy). */
  specialtyText?: string;
  maxPages?: number;
  maxLocations?: number;
  keepRaw?: boolean;
};

export type ZipResult = {
  roles: NormalizedRole[];
  locationsSeen: number;
  truncated: boolean;
  ms: number;
  ref: string;
  /** Requests that failed inside this query (the sweep continues past them). */
  failures: string[];
};

const NUCC = /^\d{3}[0-9A-Z]{6}X$/;

/** NUCC codes anywhere in specialty codings and the Plan-Net qualification extension (Molina puts them there). */
function nuccCodes(r: FhirResource): string[] {
  const out = new Set<string>(specialtyTexts(r).codes);
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.code === "string" && NUCC.test(o.code)) out.add(o.code);
    for (const k of ["specialty", "coding", "extension", "valueCodeableConcept", "code"]) if (k in o) visit(o[k], depth + 1);
  };
  visit((r as { specialty?: unknown }).specialty, 0);
  visit(((r as { extension?: { url?: string }[] }).extension ?? []).filter((e) => (e.url ?? "").endsWith("qualification")), 0);
  return [...out];
}

function practitionerName(p: FhirResource | null, display: string | undefined): string | null {
  const n = (p as { name?: { text?: string; given?: string[]; family?: string; prefix?: string[] }[] } | null)?.name?.[0];
  if (n) return n.text ?? [...(n.given ?? []), n.family].filter(Boolean).join(" ");
  return display ?? null;
}

export function normalizeRole(dir: string, role: FhirResource, location: FhirResource | null, practitioner: FhirResource | null, keepRaw = false): NormalizedRole {
  const loc = location ? addressOf(location) : null;
  const sp = specialtyTexts(role);
  const netExt = ((role as { extension?: { url?: string; valueReference?: { reference?: string; display?: string } }[] }).extension ?? []).filter((e) => (e.url ?? "").endsWith("network-reference"));
  const both = [role, ...(location ? [location] : [])];
  const pRef = (role as { practitioner?: { reference?: string; display?: string } }).practitioner;
  return {
    directory: dir,
    roleId: `PractitionerRole/${role.id}`,
    npi: npiOf(role) ?? (practitioner ? npiOf(practitioner) : null),
    practitionerRef: pRef?.reference ?? null,
    name: practitionerName(practitioner, pRef?.display),
    specialtyCodes: nuccCodes(role),
    specialtyTexts: sp.texts,
    location: location && loc ? { ref: `Location/${location.id}`, name: (location as { name?: string }).name ?? null, ...loc } : null,
    locationCount: referenceList(role, "location").length,
    networks: networkRefs(role),
    networkNames: netExt.map((e) => e.valueReference?.display).filter((x): x is string => typeof x === "string"),
    planIds: ((role as { identifier?: { system?: string; value?: string }[] }).identifier ?? []).filter((i) => (i.system ?? "").endsWith("/plan_id")).map((i) => i.value ?? ""),
    accepting: acceptingNew(role) !== "unknown" ? acceptingNew(role) : location ? acceptingNew(location) : "unknown",
    newPatientsPresent: both.some((x) => newPatientsOf(x).some((n) => n.code !== null)),
    hoursPresent: both.some(hasHours),
    hoursConflict: both.some(hoursConflict),
    age: (() => {
      const m = both.flatMap((x) => agePolicyPublished(x).matches);
      return { published: m.length > 0, matches: m };
    })(),
    ...(keepRaw ? { raw: { role, location, practitioner } } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Practitioner roles at locations in a ZIP, by the directory's strategy. Throws FhirError only when NOTHING could be read. */
export async function rolesInZip(dir: DirectoryInfo, client: FhirClient, q: ZipQuery): Promise<ZipResult> {
  const t0 = performance.now();
  const failures: string[] = [];
  const roles = new Map<string, NormalizedRole>();
  const pageSize = dir.pageSize ?? 100;
  if (dir.strategy === "chain") {
    const params: Record<string, string | string[]> = {
      "location.address-postalcode": q.zip,
      _count: String(pageSize),
      ...(q.identifier ? { identifier: q.identifier } : {}),
      ...(q.specialtyText ? { "specialty:text": q.specialtyText } : {}),
      ...(dir.includes ? { _include: ["PractitionerRole:location", "PractitionerRole:practitioner"] } : {}),
    };
    const res = await client.search("PractitionerRole", params, q.maxPages ?? 30);
    if (res.pageError) failures.push(res.pageError);
    for (const r of res.matches) {
      if (r.resourceType !== "PractitionerRole") continue;
      const locs = referenceList(r, "location").map((ref) => res.included.get(ref)).filter((x): x is FhirResource => Boolean(x));
      const inZip = locs.find((l) => addressOf(l)?.zip === q.zip) ?? null;
      const prac = (() => { const ref = (r as { practitioner?: { reference?: string } }).practitioner?.reference; return ref ? res.included.get(ref) ?? null : null; })();
      roles.set(`PractitionerRole/${r.id}`, normalizeRole(dir.key, r, inZip, prac, q.keepRaw));
    }
    return { roles: [...roles.values()], locationsSeen: [...res.included.keys()].filter((k) => k.startsWith("Location/")).length, truncated: res.truncated, ms: Math.round(performance.now() - t0), ref: res.ref, failures };
  }
  // per-location
  const locRes = await client.search("Location", { "address-postalcode": q.zip, _count: String(pageSize) }, dir.maxLocationPages ?? 5);
  if (locRes.pageError) failures.push(locRes.pageError);
  const locations = locRes.matches.filter((l) => l.resourceType === "Location" && (addressOf(l)?.zip ?? q.zip) === q.zip).slice(0, q.maxLocations ?? 400);
  let truncated = locRes.truncated || locRes.matches.length > (q.maxLocations ?? 400);
  for (const loc of locations) {
    if (dir.pauseMs) await sleep(dir.pauseMs);
    const params: Record<string, string> = { location: dir.bareIds ? String(loc.id) : `Location/${loc.id}`, _count: String(pageSize), ...(q.network ? { network: q.network } : {}) };
    try {
      const res = await client.search("PractitionerRole", params, q.maxPages ?? 5);
      if (res.pageError) failures.push(res.pageError);
      if (res.truncated) truncated = true;
      for (const r of res.matches) if (r.resourceType === "PractitionerRole") roles.set(`PractitionerRole/${r.id}`, normalizeRole(dir.key, r, loc, null, q.keepRaw));
    } catch (err) {
      failures.push(err instanceof FhirError ? `${err.kind}${err.status ? ` ${err.status}` : ""}: ${err.url}` : String(err));
    }
  }
  return { roles: [...roles.values()], locationsSeen: locations.length, truncated, ms: Math.round(performance.now() - t0), ref: locRes.ref, failures };
}
