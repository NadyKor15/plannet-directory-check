// Audit of public provider directories: what a family can (and cannot) check before calling a doctor's office.
// Directories × ZIPs; every PractitionerRole and Location record read is measured; errors are counted next to the
// findings. Pure orchestration over the package's clients; the bin/ script prints and writes the result.
import { Counters, getJson, type FetchLike } from "./http.ts";
import { DIRECTORIES, NOT_OPEN, type DirectoryInfo } from "./directories.ts";
import { FhirClient, FhirError, type FhirResource } from "./fhir.ts";
import { agePolicyPublished, hasHours, hoursConflict, newPatientsOf } from "./plannet.ts";
import { rolesInZip, type NormalizedRole } from "./records.ts";
import { nppesSearch, practiceAddresses, zip5 } from "./nppes.ts";
import { matchesGroup, groupOfText, SPECIALTY_GROUPS, type SpecialtyKey } from "./specialties.ts";
import { FL_QHP_INDEXES_PY2026 } from "./qhp-index-fl.ts";

export type AuditOptions = {
  zips: string[];
  specialties: SpecialtyKey[];
  directories?: string[];
  /** Per-location strategy: locations asked per ZIP (default 30). */
  maxLocations?: number;
  /** Pages per search (default 10). */
  maxPages?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  skipNppes?: boolean;
  skipQhp?: boolean;
  log?: (line: string) => void;
  /** Collect practitioner display names (for a local name guard pool; never written by the audit itself). */
  collectNames?: boolean;
};

export type RecordMetrics = {
  records: number;
  roles: number;
  locations: number;
  age_policy_published: number;
  age_examples: string[];
  hours_present: number;
  hours_conflict: number;
  newpatients_present: number;
  newpatients_values: Record<string, number>;
};

export type DirectoryAudit = RecordMetrics & {
  key: string;
  label: string;
  base: string;
  strategy: string;
  /** Roles whose specialty is one of the audited specialties. */
  scene_roles: number;
  scene_by_specialty: Record<string, number>;
  npis: number;
  roles_per_npi_mean: number | null;
  roles_per_npi_max: number | null;
  /** Same NPI + same location + same network more than once. */
  duplicate_role_triples: number;
  /** Roles that carry a specialty (code or text) / an NPI on the role itself. */
  roles_with_specialty: number;
  roles_with_npi: number;
  zips: { zip: string; roles: number; locations: number; failures: number; truncated: boolean; ms: number; ref: string }[];
  errors: Counters["errors"];
  http_status: Record<string, number>;
  requests: number;
  ms: number;
  notes: string[];
};

export type NppesZipAudit = { zip: string; specialty: string; any_address: number; location_elsewhere: number; location_only: number; url: string };
export type QhpIndexAudit = { issuerId: string; url: string; status: number | string; provider_files: number | null; ms: number };

export type AuditResult = {
  startedAt: string;
  finishedAt: string;
  zips: string[];
  specialties: string[];
  directories: DirectoryAudit[];
  notOpen: typeof NOT_OPEN;
  nppes: { rows: NppesZipAudit[]; errors: Counters["errors"]; requests: number } | null;
  qhp: { rows: QhpIndexAudit[]; errors: Counters["errors"]; requests: number } | null;
  totals: RecordMetrics & { scene_roles: number; errors: number; requests: number };
  control: { synthetic_age_record_counted: boolean; synthetic_plain_record_counted: boolean };
  names?: string[];
};

const emptyMetrics = (): RecordMetrics => ({ records: 0, roles: 0, locations: 0, age_policy_published: 0, age_examples: [], hours_present: 0, hours_conflict: 0, newpatients_present: 0, newpatients_values: {} });

/** Record-level metrics over unique resources (one role or location counted once however often it was seen). */
export function measure(resources: FhirResource[], m: RecordMetrics = emptyMetrics()): RecordMetrics {
  for (const r of resources) {
    m.records++;
    if (r.resourceType === "PractitionerRole") m.roles++;
    if (r.resourceType === "Location") m.locations++;
    const age = agePolicyPublished(r);
    if (age.published) { m.age_policy_published++; if (m.age_examples.length < 10) m.age_examples.push(age.matches[0].slice(0, 120)); }
    if (hasHours(r)) m.hours_present++;
    if (hoursConflict(r)) m.hours_conflict++;
    const np = newPatientsOf(r).map((n) => n.code).filter((c): c is string => Boolean(c));
    if (np.length) { m.newpatients_present++; for (const c of new Set(np)) m.newpatients_values[c] = (m.newpatients_values[c] ?? 0) + 1; }
  }
  return m;
}

/** The must-light control printed with every run: the same metric code on two synthetic records. */
export function syntheticControl(): AuditResult["control"] {
  const np = (extra: object[]) => ({ resourceType: "PractitionerRole", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/newpatients", extension: [{ url: "acceptingPatients", valueCodeableConcept: { coding: [{ code: "newpt" }] } }, ...extra] }] });
  const m = measure([np([{ url: "characteristics", valueString: "Ages 3 and up" }])]);
  const p = measure([np([])]);
  return { synthetic_age_record_counted: m.age_policy_published === 1, synthetic_plain_record_counted: p.age_policy_published === 1 };
}

function sceneKey(r: NormalizedRole, specialties: SpecialtyKey[]): SpecialtyKey | null {
  for (const s of specialties) {
    if (matchesGroup(s, r.specialtyCodes, r.specialtyTexts)) return s;
    if (r.specialtyTexts.some((t) => groupOfText(t) === s)) return s;
  }
  return null;
}

async function auditOne(dir: DirectoryInfo, opts: AuditOptions): Promise<{ audit: DirectoryAudit; names: string[] }> {
  const t0 = performance.now();
  const counters = new Counters();
  const client = new FhirClient(dir.base, { timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl, counters, maxPages: opts.maxPages ?? 10 });
  const roleRes = new Map<string, FhirResource>();
  const locRes = new Map<string, FhirResource>();
  const norm = new Map<string, NormalizedRole>();
  const zips: DirectoryAudit["zips"] = [];
  const notes: string[] = [];
  for (const zip of opts.zips) {
    const zt0 = performance.now();
    let roles = 0, locations = 0, failures = 0, truncated = false, ref = "";
    const queries = dir.strategy === "chain" && dir.specialtySearch
      ? [...new Set(opts.specialties.flatMap((s) => dir.specialtySearch?.[s] ?? []))].map((t) => ({ specialtyText: t }))
      : [{}];
    for (const q of queries) {
      try {
        const res = await rolesInZip(dir, client, { zip, keepRaw: true, maxPages: opts.maxPages ?? 10, maxLocations: opts.maxLocations ?? 30, ...(dir.auditIdentifier ? { identifier: dir.auditIdentifier } : {}), ...q });
        ref ||= res.ref;
        failures += res.failures.length;
        truncated ||= res.truncated;
        for (const r of res.roles) {
          if (r.raw?.role) roleRes.set(r.roleId, r.raw.role);
          norm.set(r.roleId, r);
        }
        for (const l of res.locations ?? []) locRes.set(`Location/${l.id}`, l);
        roles += res.roles.length;
        locations += (res.locations ?? []).length;
      } catch (err) {
        failures++;
        ref ||= err instanceof FhirError ? err.url : "";
        opts.log?.(`    ${dir.key} ${zip}${"specialtyText" in q ? ` ${q.specialtyText}` : ""}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    zips.push({ zip, roles, locations, failures, truncated, ms: Math.round(performance.now() - zt0), ref });
    opts.log?.(`  ${dir.key.padEnd(13)} ${zip}: ${roles} roles · ${locations} locations · ${failures} failed requests${truncated ? " · truncated" : ""} · ${Math.round(performance.now() - zt0)} ms`);
  }
  const m = measure([...roleRes.values(), ...locRes.values()]);
  const byNpi = new Map<string, number>();
  const triples = new Map<string, number>();
  const scene: Record<string, number> = {};
  let sceneRoles = 0, withSpec = 0, withNpi = 0;
  const names: string[] = [];
  for (const r of norm.values()) {
    if (r.specialtyCodes.length || r.specialtyTexts.length) withSpec++;
    if (r.npi) withNpi++;
    if (r.npi) byNpi.set(r.npi, (byNpi.get(r.npi) ?? 0) + 1);
    if (r.npi) { const k = `${r.npi}|${r.location?.ref ?? "-"}|${[...r.networks].sort().join(",")}`; triples.set(k, (triples.get(k) ?? 0) + 1); }
    const s = sceneKey(r, opts.specialties);
    if (s) { sceneRoles++; scene[s] = (scene[s] ?? 0) + 1; }
    if (opts.collectNames && r.name) names.push(r.name);
  }
  const counts = [...byNpi.values()];
  if (dir.auditIdentifier) notes.push(`roles filtered by ${dir.auditIdentifier} (one plan, so a practitioner is not counted once per plan)`);
  if (dir.strategy === "chain" && dir.specialtySearch) notes.push(`server-side specialty:text per specialty: ${[...new Set(opts.specialties.flatMap((s) => dir.specialtySearch?.[s] ?? []))].join(", ")}`);
  if (dir.strategy === "per-location") notes.push(`up to ${opts.maxLocations ?? 30} locations per ZIP, one request per location`);
  return {
    names,
    audit: {
      key: dir.key, label: dir.label, base: dir.base, strategy: dir.strategy, ...m,
      scene_roles: sceneRoles, scene_by_specialty: scene,
      npis: byNpi.size,
      roles_per_npi_mean: counts.length ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 100) / 100 : null,
      roles_per_npi_max: counts.length ? Math.max(...counts) : null,
      duplicate_role_triples: [...triples.values()].filter((v) => v > 1).length,
      roles_with_specialty: withSpec,
      roles_with_npi: withNpi,
      zips, errors: { ...counters.errors }, http_status: { ...counters.httpStatus }, requests: counters.requests,
      ms: Math.round(performance.now() - t0), notes,
    },
  };
}

async function auditNppes(opts: AuditOptions): Promise<AuditResult["nppes"]> {
  const counters = new Counters();
  const rows: NppesZipAudit[] = [];
  for (const zip of opts.zips) for (const s of opts.specialties) {
    const term = SPECIALTY_GROUPS[s].nppesTerm;
    try {
      const any = await nppesSearch({ taxonomy_description: term, postal_code: zip, enumeration_type: "NPI-1" }, { counters, timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl });
      // "Practices elsewhere": none of its practice addresses (primary LOCATION or secondary practice locations) is in the ZIP.
      const elsewhere = any.results.filter((r) => !practiceAddresses(r).some((a) => zip5(a.postal_code) === zip)).length;
      const loc = await nppesSearch({ taxonomy_description: term, postal_code: zip, enumeration_type: "NPI-1", address_purpose: "LOCATION" }, { counters, timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl });
      rows.push({ zip, specialty: s, any_address: any.results.length, location_elsewhere: elsewhere, location_only: loc.results.length, url: any.url });
    } catch (err) {
      opts.log?.(`    nppes ${zip} ${s}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return { rows, errors: { ...counters.errors }, requests: counters.requests };
}

async function auditQhp(opts: AuditOptions): Promise<AuditResult["qhp"]> {
  const counters = new Counters();
  const rows: QhpIndexAudit[] = [];
  const seen = new Map<string, QhpIndexAudit>();
  for (const x of FL_QHP_INDEXES_PY2026) {
    const prev = seen.get(x.url);
    if (prev) { rows.push({ ...prev, issuerId: x.issuerId }); continue; }
    const t0 = performance.now();
    let row: QhpIndexAudit;
    try {
      const { body, status } = await getJson<{ provider_urls?: unknown[] }>(x.url, { counters, timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl }, "application/json");
      row = { issuerId: x.issuerId, url: x.url, status, provider_files: Array.isArray(body.provider_urls) ? body.provider_urls.length : null, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      const e = err as { status?: number | null; kind?: string };
      row = { issuerId: x.issuerId, url: x.url, status: e.status ?? e.kind ?? "error", provider_files: null, ms: Math.round(performance.now() - t0) };
    }
    seen.set(x.url, row);
    rows.push(row);
  }
  return { rows, errors: { ...counters.errors }, requests: counters.requests };
}

export async function auditDirectories(opts: AuditOptions): Promise<AuditResult> {
  const startedAt = new Date().toISOString();
  const dirs = DIRECTORIES.filter((d) => !opts.directories || opts.directories.includes(d.key));
  const directories: DirectoryAudit[] = [];
  const names: string[] = [];
  for (const d of dirs) {
    opts.log?.(`${d.label} (${d.strategy})`);
    const { audit, names: n } = await auditOne(d, opts);
    directories.push(audit);
    names.push(...n);
  }
  const nppes = opts.skipNppes ? null : await auditNppes(opts);
  const qhp = opts.skipQhp ? null : await auditQhp(opts);
  const totals = directories.reduce((t, d) => {
    t.records += d.records; t.roles += d.roles; t.locations += d.locations; t.age_policy_published += d.age_policy_published;
    t.hours_present += d.hours_present; t.hours_conflict += d.hours_conflict; t.newpatients_present += d.newpatients_present;
    t.scene_roles += d.scene_roles; t.requests += d.requests;
    t.errors += Object.values(d.errors).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(d.newpatients_values)) t.newpatients_values[k] = (t.newpatients_values[k] ?? 0) + v;
    t.age_examples.push(...d.age_examples.slice(0, 3));
    return t;
  }, { ...emptyMetrics(), scene_roles: 0, errors: 0, requests: 0 });
  return {
    startedAt, finishedAt: new Date().toISOString(), zips: opts.zips, specialties: opts.specialties, directories, notOpen: NOT_OPEN, nppes, qhp, totals,
    control: syntheticControl(),
    ...(opts.collectNames ? { names } : {}),
  };
}
