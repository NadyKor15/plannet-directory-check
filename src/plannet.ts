// Readers for Da Vinci PDex Plan-Net (STU 1.x) resources: NPI, network references, the newpatients extension,
// hours (Location.hoursOfOperation, availableTime, the contactpoint-availabletime extension) and any published
// patient-age wording. Pure functions over JSON; no network.
import type { FhirResource } from "./fhir.ts";

export const PLANNET = "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/";
export const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";

type Ext = { url?: string; valueReference?: { reference?: string }; valueCodeableConcept?: Coding; valueString?: string; valueBoolean?: boolean; valueTime?: string; valueCode?: string; extension?: Ext[] };
type Coding = { coding?: { system?: string; code?: string; display?: string }[]; text?: string };
type Identifier = { system?: string; value?: string; use?: string; type?: Coding };

const exts = (r: unknown): Ext[] => ((r as { extension?: Ext[] })?.extension ?? []);
const urlIs = (e: Ext, name: string) => typeof e.url === "string" && (e.url === PLANNET + name || e.url.endsWith(`/${name}`) || e.url === name);

export function identifiers(r: FhirResource): Identifier[] {
  return ((r as { identifier?: Identifier[] }).identifier ?? []).filter((i) => i && typeof i.value === "string");
}

/** NPI from identifier.system = us-npi, or (as some directories send it) identifier.type code "NPI" with no system. */
export function npiOf(r: FhirResource): string | null {
  const id = identifiers(r).find((i) => i.system === NPI_SYSTEM)
    ?? identifiers(r).find((i) => !i.system && (i.type?.coding ?? []).some((c) => c.code === "NPI"));
  const v = id?.value?.trim() ?? "";
  return /^\d{10}$/.test(v) ? v : null;
}

export function identifierValue(r: FhirResource, systemSuffix: string): string | null {
  return identifiers(r).find((i) => typeof i.system === "string" && i.system.endsWith(systemSuffix))?.value ?? null;
}

/** Targets of the Plan-Net network-reference extension ("Organization/123"). */
export function networkRefs(r: FhirResource): string[] {
  return exts(r).filter((e) => urlIs(e, "network-reference")).map((e) => e.valueReference?.reference).filter((x): x is string => typeof x === "string");
}

export type NewPatientsInfo = {
  /** AcceptingPatientsCS code: newpt | nopt | existptonly | existptofam, or null when absent. */
  code: string | null;
  text: string | null;
  /** Free-text characteristics (the only place Plan-Net has for "ages 3 and up"-style limits). */
  characteristics: string[];
  fromNetwork: string[];
};

export function newPatientsOf(r: FhirResource): NewPatientsInfo[] {
  return exts(r).filter((e) => urlIs(e, "newpatients")).map((e) => {
    const sub = e.extension ?? [];
    // Plan-Net nests acceptingPatients as a sub-extension; some directories put the CodeableConcept on the extension itself.
    const acc = sub.find((s) => s.url === "acceptingPatients")?.valueCodeableConcept ?? e.valueCodeableConcept;
    return {
      code: acc?.coding?.[0]?.code ?? null,
      text: acc?.text ?? acc?.coding?.[0]?.display ?? null,
      characteristics: sub.filter((s) => s.url === "characteristics").map((s) => s.valueString).filter((x): x is string => typeof x === "string"),
      fromNetwork: sub.filter((s) => s.url === "fromNetwork").map((s) => s.valueReference?.reference).filter((x): x is string => typeof x === "string"),
    };
  });
}

/** accepting | not_accepting | unknown, from the newpatients extension (existing-patients-only counts as not accepting new). */
export function acceptingNew(r: FhirResource): "accepting" | "not_accepting" | "unknown" {
  const codes = newPatientsOf(r).map((n) => n.code).filter(Boolean);
  if (codes.includes("newpt")) return "accepting";
  if (codes.some((c) => c === "nopt" || c === "existptonly" || c === "existptofam")) return "not_accepting";
  return "unknown";
}

// ---- hours ------------------------------------------------------------------------------------------------------

export type DayHours = { day: string; allDay: boolean; start: string | null; end: string | null };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function expand(daysOfWeek: unknown, allDay: unknown, start: unknown, end: unknown): DayHours[] {
  const days = Array.isArray(daysOfWeek) ? daysOfWeek.filter((d): d is string => typeof d === "string") : [];
  return days.map((day) => ({ day, allDay: allDay === true, start: typeof start === "string" ? start.slice(0, 5) : null, end: typeof end === "string" ? end.slice(0, 5) : null }));
}

/** Location.hoursOfOperation */
export function hoursOfOperation(r: FhirResource): DayHours[] {
  const h = (r as { hoursOfOperation?: { daysOfWeek?: string[]; allDay?: boolean; openingTime?: string; closingTime?: string }[] }).hoursOfOperation ?? [];
  return h.flatMap((x) => expand(x.daysOfWeek, x.allDay, x.openingTime, x.closingTime));
}

/** PractitionerRole/HealthcareService.availableTime plus the Plan-Net contactpoint-availabletime extension on telecom. */
export function availableTimes(r: FhirResource): DayHours[] {
  const own = (r as { availableTime?: { daysOfWeek?: string[]; allDay?: boolean; availableStartTime?: string; availableEndTime?: string }[] }).availableTime ?? [];
  const out = own.flatMap((x) => expand(x.daysOfWeek, x.allDay, x.availableStartTime, x.availableEndTime));
  const telecom = (r as { telecom?: unknown[] }).telecom ?? [];
  for (const t of telecom) {
    for (const e of exts(t).filter((x) => urlIs(x, "contactpoint-availabletime"))) {
      const sub = e.extension ?? [];
      const days = sub.filter((s) => s.url === "daysOfWeek").map((s) => s.valueCode).filter(Boolean);
      const allDay = sub.find((s) => s.url === "allDay")?.valueBoolean;
      const start = sub.find((s) => s.url === "availableStartTime")?.valueTime;
      const end = sub.find((s) => s.url === "availableEndTime")?.valueTime;
      out.push(...expand(days, allDay, start, end));
    }
  }
  return out;
}

export function hasHours(r: FhirResource): boolean {
  return hoursOfOperation(r).length > 0 || availableTimes(r).length > 0;
}

/**
 * true when one record carries BOTH hoursOfOperation and availableTime and they disagree on a day both mention, or
 * one lists a day the other leaves out (e.g. Mon–Fri 8–17 in hoursOfOperation, Sat/Sun "allDay" on the phone line).
 */
export function hoursConflict(r: FhirResource): boolean {
  const a = hoursOfOperation(r);
  const b = availableTimes(r);
  if (a.length === 0 || b.length === 0) return false;
  const key = (h: DayHours) => (h.allDay ? "allDay" : `${h.start ?? "?"}-${h.end ?? "?"}`);
  const mapOf = (hs: DayHours[]) => {
    const m = new Map<string, Set<string>>();
    for (const h of hs) { if (!m.has(h.day)) m.set(h.day, new Set()); m.get(h.day)!.add(key(h)); }
    return m;
  };
  const ma = mapOf(a), mb = mapOf(b);
  for (const d of DAYS) {
    const x = ma.get(d), y = mb.get(d);
    if (!x && !y) continue;
    if (!x || !y) return true;
    if ([...x].sort().join() !== [...y].sort().join()) return true;
  }
  return false;
}

// ---- published patient-age wording -------------------------------------------------------------------------------

/**
 * Wording that states which patient ages are seen. Deliberately broad on purpose: a miss here would understate what
 * directories publish, so the audit errs toward counting. Names and addresses are never scanned (see agePolicyText).
 */
export const AGE_PATTERNS: RegExp[] = [
  /\bages?\s*\d{1,2}\s*(?:\+|and\s+(?:up|older|over|above)|to\s*\d{1,3}|-\s*\d{1,3}|through\s*\d{1,3})/i,
  /\b(?:under|over|older than|younger than|at least|minimum(?: age)?(?: of)?|max(?:imum)?(?: age)?(?: of)?)\s*\d{1,2}\s*(?:years?|yrs?|y\/?o|months?|mos?)\b/i,
  /\b\d{1,2}\s*(?:years?|yrs?|months?|mos?)\s*(?:and|&)\s*(?:up|older|over|above)\b/i,
  /\b(?:adults?|pediatric|paediatric|children|kids|infants?|adolescents?)\s+(?:patients\s+)?only\b/i,
  /\bno\s+(?:children|kids|pediatric|paediatric|infants?|minors?)\b/i,
  /\b(?:age|ages)\s+(?:range|limit|restriction|group)s?\b/i,
];

/** Strings worth scanning for age wording: newpatients.characteristics, comments, descriptions, eligibility. */
export function agePolicyText(r: FhirResource): string[] {
  const out: string[] = [];
  for (const n of newPatientsOf(r)) out.push(...n.characteristics);
  const anyR = r as Record<string, unknown>;
  for (const k of ["comment", "extraDetails", "description"]) if (typeof anyR[k] === "string") out.push(anyR[k] as string);
  for (const el of (anyR.eligibility as { comment?: string; code?: Coding }[] | undefined) ?? []) {
    if (el.comment) out.push(el.comment);
    if (el.code?.text) out.push(el.code.text);
  }
  for (const c of (anyR.characteristic as Coding[] | undefined) ?? []) {
    if (c.text) out.push(c.text);
    for (const cd of c.coding ?? []) if (cd.display) out.push(cd.display);
  }
  // Any other extension carrying a string (vendor extensions sometimes hold "accepts ages 0-18").
  const walk = (e: Ext[], depth: number) => {
    for (const x of e) {
      if (urlIs(x, "newpatients")) continue;
      if (typeof x.valueString === "string") out.push(x.valueString);
      if (x.extension && depth < 4) walk(x.extension, depth + 1);
    }
  };
  walk(exts(r), 0);
  return out;
}

export function agePolicyPublished(r: FhirResource): { published: boolean; matches: string[] } {
  const texts = agePolicyText(r);
  const matches = texts.filter((t) => AGE_PATTERNS.some((p) => p.test(t)));
  return { published: matches.length > 0, matches };
}

export function referenceList(r: FhirResource, field: string): string[] {
  const v = (r as Record<string, unknown>)[field];
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((x) => (x as { reference?: string })?.reference).filter((x): x is string => typeof x === "string");
}

export function addressOf(r: FhirResource): { line: string; city: string; state: string; zip: string } | null {
  const a = (r as { address?: { line?: string[]; city?: string; state?: string; postalCode?: string } | { line?: string[]; city?: string; state?: string; postalCode?: string }[] }).address;
  const one = Array.isArray(a) ? a[0] : a;
  if (!one) return null;
  return { line: (one.line ?? []).join(", "), city: one.city ?? "", state: one.state ?? "", zip: (one.postalCode ?? "").slice(0, 5) };
}

export function specialtyTexts(r: FhirResource): { codes: string[]; texts: string[] } {
  const sp = ((r as { specialty?: Coding[] }).specialty ?? []);
  return {
    codes: sp.flatMap((s) => (s.coding ?? []).filter((c) => c.system === "http://nucc.org/provider-taxonomy").map((c) => c.code ?? "")).filter(Boolean),
    texts: sp.flatMap((s) => [s.text, ...(s.coding ?? []).map((c) => c.display)]).filter((x): x is string => typeof x === "string" && x !== "unknown"),
  };
}
