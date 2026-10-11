// Offline audit run against a synthetic directory (fetch double): metrics, error counting, the must-light control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDirectories, measure, syntheticControl } from "../src/audit.ts";
import type { FetchLike } from "../src/http.ts";

const PN = "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/fhir+json" } });

const role = (id: string, extra: object[] = []) => ({
  resourceType: "PractitionerRole", id,
  identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: `09000000${id.padStart(2, "0")}` }],
  specialty: [{ coding: [{ system: "http://nucc.org/provider-taxonomy", code: "207X00000X", display: "Orthopaedic Surgery" }] }],
  location: [{ reference: "Location/L1" }],
  extension: [{ url: `${PN}newpatients`, extension: [{ url: "acceptingPatients", valueCodeableConcept: { coding: [{ code: "newpt" }] } }, ...extra] }, { url: `${PN}network-reference`, valueReference: { reference: "Organization/N1" } }],
});
const location = {
  resourceType: "Location", id: "L1", address: { line: ["1 Sample St"], city: "Orlando", state: "FL", postalCode: "32803" },
  hoursOfOperation: [{ daysOfWeek: ["mon", "tue", "wed", "thu", "fri"], openingTime: "08:00", closingTime: "17:00" }],
  telecom: [{ system: "phone", extension: [{ url: `${PN}contactpoint-availabletime`, extension: [{ url: "daysOfWeek", valueCode: "sat" }, { url: "allDay", valueBoolean: true }] }] }],
};

test("audit: metrics over a synthetic chain directory; one ZIP fails and is counted, not hidden", async () => {
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get("location.address-postalcode") === "33333") return new Response("unavailable", { status: 503 });
    return json({ resourceType: "Bundle", entry: [
      { search: { mode: "match" }, resource: role("1", [{ url: "characteristics", valueString: "Ages 3 and up" }]) },
      { search: { mode: "match" }, resource: role("2") },
      { search: { mode: "include" }, resource: location },
    ] });
  };
  const r = await auditDirectories({ zips: ["32803", "33333"], specialties: ["orthopedics"], directories: ["uhc-optum"], fetchImpl, skipNppes: true, skipQhp: true });
  const d = r.directories[0];
  assert.equal(d.key, "uhc-optum");
  assert.equal(d.roles, 2);
  assert.equal(d.locations, 1);
  assert.equal(d.records, 3);
  assert.equal(d.age_policy_published, 1, "the record with 'Ages 3 and up' is counted");
  assert.equal(d.hours_conflict, 1, "Mon-Fri 8-17 vs Sat allDay on the phone line");
  assert.equal(d.scene_roles, 2);
  assert.equal(d.npis, 2);
  assert.equal(d.errors.http, 1, "the failing ZIP is an HTTP error in the counts");
  assert.equal(d.zips.find((z) => z.zip === "33333")!.failures, 1);
  assert.equal(r.control.synthetic_age_record_counted, true);
  assert.equal(r.control.synthetic_plain_record_counted, false);
  assert.equal(r.totals.age_policy_published, 1);
});

test("audit: the control lights and the plain record stays dark (same code path as the sweep)", () => {
  assert.deepEqual(syntheticControl(), { synthetic_age_record_counted: true, synthetic_plain_record_counted: false });
  const m = measure([role("3"), location]);
  assert.equal(m.age_policy_published, 0);
  assert.equal(m.hours_present, 1);
  assert.equal(m.newpatients_present, 1);
});
