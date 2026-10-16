// Offline tests: no network. Every directory answer below is synthetic (invented values, real shapes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Counters, getJson, type FetchLike } from "../src/http.ts";
import { FhirClient, FhirError } from "../src/fhir.ts";
import { acceptingNew, agePolicyPublished, availableTimes, hoursConflict, hoursOfOperation, networkRefs, npiOf } from "../src/plannet.ts";
import { scanJsonArray } from "../src/qhp.ts";
import { groupOfText, matchesGroup } from "../src/specialties.ts";
import { normalizeRole, rolesInZip } from "../src/records.ts";
import type { DirectoryInfo } from "../src/directories.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/fhir+json" } });

test("http: errors are counted by kind (network, timeout, http, parse)", async () => {
  const c = new Counters();
  const net: FetchLike = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(getJson("https://x.invalid/a", { fetchImpl: net, counters: c }));
  const h500: FetchLike = async () => new Response("boom", { status: 500 });
  await assert.rejects(getJson("https://x.invalid/b", { fetchImpl: h500, counters: c }));
  const bad: FetchLike = async () => new Response("<html>", { status: 200 });
  await assert.rejects(getJson("https://x.invalid/c", { fetchImpl: bad, counters: c }));
  const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(getJson("https://x.invalid/d", { fetchImpl: hang, counters: c, timeoutMs: 50 }));
  assert.deepEqual(c.errors, { network: 1, timeout: 1, http: 1, parse: 1, outcome: 0 });
  assert.equal(c.requests, 4);
  assert.equal(c.httpStatus["500"], 1);
});

test("fhir: follows next links up to the page ceiling and marks the result truncated", async () => {
  let n = 0;
  const f: FetchLike = async (url) => {
    n++;
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return json({ resourceType: "Bundle", total: 5, entry: [{ resource: { resourceType: "Location", id: `l${page}` } }], link: page < 5 ? [{ relation: "next", url: `https://x.invalid/fhir/Location?page=${page + 1}` }] : [] });
  };
  const c = new FhirClient("https://x.invalid/fhir", { fetchImpl: f });
  const all = await c.search("Location", {}, 10);
  assert.equal(all.matches.length, 5);
  assert.equal(all.truncated, false);
  const cut = await c.search("Location", {}, 2);
  assert.equal(cut.matches.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(all.total, 5);
  assert.ok(n >= 7);
});

test("fhir: HTTP 200 + OperationOutcome(error) is an error of kind 'outcome', not an empty result", async () => {
  const f: FetchLike = async () => json({ resourceType: "OperationOutcome", issue: [{ severity: "error", diagnostics: "Unknown search parameter \"zz\". Valid search parameters for this search are: [_id, location, specialty]" }] });
  const c = new FhirClient("https://x.invalid/fhir", { fetchImpl: f });
  await assert.rejects(c.search("PractitionerRole", { zz: "1" }), (e: unknown) => e instanceof FhirError && e.kind === "outcome");
  assert.equal(c.counters.errors.outcome, 1);
  assert.deepEqual(await c.probeSearchParams("PractitionerRole"), ["_id", "location", "specialty"]);
  assert.equal(c.counters.errors.outcome, 1, "the deliberate probe is not counted as an error");
});

test("plannet: NPI (system or typed), network refs, newpatients both shapes", () => {
  assert.equal(npiOf({ resourceType: "PractitionerRole", identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }] }), "1234567893");
  assert.equal(npiOf({ resourceType: "PractitionerRole", identifier: [{ type: { coding: [{ code: "NPI" }] }, value: "1234567893" }] }), "1234567893");
  assert.equal(npiOf({ resourceType: "PractitionerRole", identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "12" }] }), null);
  const nested = { resourceType: "PractitionerRole", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/newpatients", extension: [{ url: "acceptingPatients", valueCodeableConcept: { coding: [{ code: "existptonly" }] } }] }, { url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference", valueReference: { reference: "Organization/9" } }] };
  assert.equal(acceptingNew(nested), "not_accepting");
  assert.deepEqual(networkRefs(nested), ["Organization/9"]);
  const flat = { resourceType: "PractitionerRole", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/newpatients", valueCodeableConcept: { coding: [{ code: "newpt" }] } }] };
  assert.equal(acceptingNew(flat), "accepting");
  assert.equal(acceptingNew({ resourceType: "PractitionerRole" }), "unknown");
});

test("must-light: a record that states an age limit in newpatients.characteristics counts as age_policy_published (+1)", () => {
  const base = { resourceType: "PractitionerRole", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/newpatients", extension: [{ url: "acceptingPatients", valueCodeableConcept: { coding: [{ code: "newpt" }] } }] }] };
  const withAge = structuredClone(base) as typeof base & { extension: { extension: unknown[] }[] };
  withAge.extension[0].extension.push({ url: "characteristics", valueString: "Ages 3 and up" });
  const records = [base, withAge];
  const count = records.filter((r) => agePolicyPublished(r).published).length;
  assert.equal(count, 1);
  for (const phrase of ["No patients under 2 years", "Adults only", "ages 0-18", "18 years and older", "Pediatric patients only", "minimum age of 3 years"]) {
    assert.ok(agePolicyPublished({ resourceType: "HealthcareService", comment: phrase }).published, phrase);
  }
  for (const phrase of ["Accepting new patients", "Wheelchair accessible", "Pediatric Orthopaedic Surgery", "Suite 300"]) {
    assert.equal(agePolicyPublished({ resourceType: "HealthcareService", comment: phrase }).published, false, phrase);
  }
});

test("hours: hoursOfOperation vs available-time on the phone line in ONE record -> conflict", () => {
  const loc = {
    resourceType: "Location",
    hoursOfOperation: [{ daysOfWeek: ["mon", "tue", "wed", "thu", "fri"], openingTime: "08:00", closingTime: "17:00" }],
    telecom: [{ system: "phone", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/contactpoint-availabletime", extension: [{ url: "daysOfWeek", valueCode: "sat" }, { url: "daysOfWeek", valueCode: "sun" }, { url: "allDay", valueBoolean: true }] }] }],
  };
  assert.equal(hoursOfOperation(loc).length, 5);
  assert.equal(availableTimes(loc).length, 2);
  assert.equal(hoursConflict(loc), true);
  const same = { ...loc, telecom: [{ system: "phone", extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/contactpoint-availabletime", extension: ["mon", "tue", "wed", "thu", "fri"].map((d) => ({ url: "daysOfWeek", valueCode: d })).concat([{ url: "availableStartTime", valueTime: "08:00:00" } as never, { url: "availableEndTime", valueTime: "17:00:00" } as never]) }] }] };
  assert.equal(hoursConflict(same), false);
  assert.equal(hoursConflict({ resourceType: "Location", hoursOfOperation: loc.hoursOfOperation }), false, "one source alone is not a conflict");
});

test("qhp: scanJsonArray cuts a top-level array into objects across chunk boundaries, braces inside strings ignored", async () => {
  const objs = [{ a: "x{y}z", b: [1, { c: "\"}" }] }, { a: "second", n: { deep: { er: true } } }, { a: "third \\ backslash" }];
  const text = JSON.stringify(objs);
  const bytes = new TextEncoder().encode(text);
  async function* chunks(size: number) { for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size); }
  for (const size of [1, 3, 7, 1000]) {
    const got: unknown[] = [];
    const st = await scanJsonArray(chunks(size), (raw) => { got.push(JSON.parse(raw)); });
    assert.deepEqual(got, objs, `chunk ${size}`);
    assert.equal(st.stoppedBy, "end");
  }
  const one: unknown[] = [];
  const st = await scanJsonArray(chunks(5), (raw) => { one.push(JSON.parse(raw)); return true; });
  assert.equal(one.length, 1);
  assert.equal(st.stoppedBy, "callback");
  const capped = await scanJsonArray(chunks(4), () => {}, 8);
  assert.equal(capped.stoppedBy, "byte-cap");
});

test("specialties: NUCC codes and directory words; sub-specialty never matched by its classification alone", () => {
  assert.equal(matchesGroup("orthopedics", ["207XP3100X"], []), true);
  assert.equal(matchesGroup("gastroenterology", [], ["INTERNAL MEDICINE"]), false);
  assert.equal(matchesGroup("dermatology", [], ["DERMATOLOGY"]), true);
  assert.equal(groupOfText("Orthopedic Surgeon specializing in Pediatrics"), "orthopedics");
  assert.equal(groupOfText("OBGYN (Obstetrician and Gynecologist)"), "ob_gyn");
  assert.equal(groupOfText("Pediatric Dentist"), null);
  assert.equal(groupOfText("Orthopedic Physical Therapist"), null); // allied health, not an orthopedist (Molina 2026-10-13)
  assert.equal(groupOfText("Pediatric Orthopaedic Surgery"), "orthopedics");
});

test("specialties: allied-health titles named after a field are not a physician specialty (Molina 2026-10-13); physician titles still match", () => {
  const alliedHealth = [
    "Orthopedic Physical Therapist",
    "Orthopaedic Technologist",
    "Orthopedic Assistant",
    "Orthotist",
    "Prosthetist",
    "Dermatology Physician Assistant",
    "Allergy Technician",
    "Orthopedic Physical Therapy",
  ];
  for (const t of alliedHealth) assert.equal(groupOfText(t), null, t);
  // must-light control: the same field words with a physician title are still found, so the nulls above are not a dead matcher
  assert.equal(groupOfText("Orthopedic Surgeon"), "orthopedics");
  assert.equal(groupOfText("Orthopaedic Surgery"), "orthopedics");
  assert.equal(groupOfText("Dermatologist"), "dermatology");
  assert.equal(groupOfText("Allergist"), "allergy");
});

test("records: per-location strategy asks one location at a time and keeps going past a failed location", async () => {
  const dir: DirectoryInfo = { key: "t", label: "t", base: "https://x.invalid/fhir", strategy: "per-location", bareIds: true, notes: "" };
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/Location")) return json({ resourceType: "Bundle", entry: ["a", "b", "c"].map((id) => ({ resource: { resourceType: "Location", id, address: { postalCode: "32801" } } })) });
    const loc = u.searchParams.get("location");
    if (loc === "b") return new Response("forbidden", { status: 403 });
    return json({ resourceType: "Bundle", entry: [{ resource: { resourceType: "PractitionerRole", id: `r-${loc}`, location: [{ reference: `Location/${loc}` }], extension: [{ url: "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference", valueReference: { reference: "15" } }] } }] });
  };
  const c = new FhirClient(dir.base, { fetchImpl: f });
  const res = await rolesInZip(dir, c, { zip: "32801", network: "15" });
  assert.deepEqual(res.roles.map((r) => r.roleId).sort(), ["PractitionerRole/r-a", "PractitionerRole/r-c"]);
  assert.equal(res.failures.length, 1);
  assert.equal(c.counters.errors.http, 1);
  assert.ok(calls.filter((u) => u.includes("/PractitionerRole?")).every((u) => /location=[abc](&|$)/.test(u) && u.includes("network=15")));
  const n = normalizeRole("t", res.roles[0].raw?.role ?? { resourceType: "PractitionerRole", id: "x" }, null, null);
  assert.equal(n.directory, "t");
});
