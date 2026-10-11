# plannet-directory-check

A small, dependency-free, read-only toolkit for the **public provider directories** that US health insurers publish
under CMS-9115-F (HL7 Da Vinci PDex **Plan-Net** FHIR APIs), the **NPPES** NPI Registry, and the **marketplace (QHP)
machine-readable provider files**. It answers "which practitioners of specialty S practice in ZIP Z, in plan P's
network?" and measures what the records leave out — patient ages, hours, a meaningful "accepting new patients".

Node.js ≥ 24 (TypeScript runs through Node's type stripping), no install step, no keys, no registration. Every request
is an anonymous GET; every sweep prints its error count next to its findings.

## Try it

```sh
cd packages/plannet-directory-check
npm test                                              # offline tests, no network
node bin/audit-directories.ts --zips 32803 --no-qhp   # live audit, one ZIP (about a minute)
node bin/audit-directories.ts                          # 6 directories × 3 Orlando ZIPs × 6 specialties
```

The audit writes `docs/AUDIT-<date>.md` (table) and `docs/AUDIT-<date>.json` (all numbers) under `--out-dir`
(default `./docs`) and prints a headline such as `0 of N public directory records … state what patient ages are seen`.

Options: `--zips a,b,c` · `--specialties primary_care,ob_gyn,gastroenterology,dermatology,allergy,orthopedics` ·
`--directories florida-blue,molina,uhc-optum,cigna,humana,centene` · `--max-locations 30` (per ZIP, for directories
that need one request per location) · `--max-pages 10` · `--timeout 20000` · `--no-nppes` · `--no-qhp` ·
`--pool <file>` (writes the practitioner names seen, for a local name guard; keep it out of version control).

## What it measures (per directory, per run)

| Metric | Meaning |
|---|---|
| records | PractitionerRole + Location resources read (each counted once) |
| age stated | records whose `newpatients.characteristics`, comments, descriptions, eligibility or string extensions state a patient age ("ages 3 and up", "under 18 years", "adults only" …) |
| hours present / hours conflict | `hoursOfOperation`, `availableTime` or the Plan-Net `contactpoint-availabletime` extension; conflict = both in one record and they disagree on a day |
| new-patients flag | `newpatients` extension present, and its values (`newpt`, `nopt`, `existptonly`, …) |
| roles with specialty / NPI | the role itself carries a specialty and an NPI (some directories put them only on Practitioner) |
| roles per NPI, repeated NPI + location + network | how many records one practitioner has, and true duplicates |
| NPPES "practice elsewhere" | a `postal_code` search also matches mailing addresses; how many results practice in another ZIP unless `address_purpose=LOCATION` is added |
| QHP indexes | status of each Florida marketplace issuer's `cms-data-index.json` (CMS PUF PY2026) |
| errors | network, timeout, HTTP (by status), parse, and HTTP-200-with-OperationOutcome ("outcome") |

A **must-light control** runs with every audit: the same metric code is applied to a synthetic record that says
"Ages 3 and up" (must count) and to a plain record (must not). The run fails if the control does not light.

## How each directory is asked (checked live, 2026-10-11)

Servers differ in which FHIR search features work, so each directory has a strategy (`src/directories.ts`):

| Directory | Strategy | Why |
|---|---|---|
| Florida Blue | `chain`: `PractitionerRole?location.address-postalcode=Z&specialty:text=…&_include=…` | chained search and `_include` work; no `network` search parameter; `/metadata` hidden (the parameter list comes from the error of an unknown parameter, `FhirClient.probeSearchParams`) |
| UnitedHealthcare / Optum | `chain` | HAPI-style server; roles carry no specialty or NPI on the role |
| Molina | `per-location` (bare ids, paced) | comma-separated id lists answer 0; `_include` with `network` answers 500; bursts answer 403; an undocumented daily call quota answers 403 until 00:00 UTC |
| Cigna | `per-location` (bare ids) | `Location/<id>` answers 0 |
| Humana | `revinclude`: `Location?address-postalcode=Z&_revinclude=PractitionerRole:location` | roles reference locations by absolute URL, so `PractitionerRole?location=<id>` answers 0 |
| Centene (Ambetter, Sunshine, Wellcare) | `per-location` (`Location/<id>`) | `_count` ignored (200 per page); `_revinclude` timed out |

Aetna (401, registration) and Elevance (500 without a token) are listed in `NOT_OPEN` and not audited.

## Library

```ts
import { FhirClient } from "./src/fhir.ts";
import { directoryByKey } from "./src/directories.ts";
import { rolesInZip } from "./src/records.ts";

const fb = directoryByKey("florida-blue");
const client = new FhirClient(fb.base, { timeoutMs: 10_000 });
const res = await rolesInZip(fb, client, { zip: "32803", specialtyText: "DERMATOLOGY",
  identifier: "https://www.edifecs.com/fhir/cms-organization/plan_id|BCHPPO" });
console.log(res.roles.length, client.counters.summary());
```

- `src/fhir.ts` — search with paging ceiling, timeout per page, OperationOutcome-as-error, `probeSearchParams`.
- `src/plannet.ts` — NPI, `network-reference`, `newpatients` (both the profile's nested shape and a flat variant seen in the wild), hours and hours conflicts, published age wording.
- `src/records.ts` — "roles at locations in ZIP Z" by strategy, normalized to one flat record.
- `src/nppes.ts` — NPPES v2.1 search, LOCATION address, taxonomy join.
- `src/qhp.ts` — QHP index and a streaming reader for multi-GB provider files (`scanJsonArray` cuts a top-level JSON array into objects from a byte stream with a byte ceiling).
- `src/specialties.ts` — specialty groups as NUCC taxonomy codes plus the words directories use. Sub-specialties that a directory files under the classification (gastroenterology as "INTERNAL MEDICINE") are never matched by the classification alone — join with NPPES by NPI.
- `src/audit.ts`, `bin/audit-directories.ts` — the audit.

## Limits

- The audit reads samples (page ceilings, location ceilings); it is a measurement of what was read, not a census.
- The age patterns are deliberately broad (English only); the control shows they fire.
- Live endpoints change; the strategies above are what worked on the date shown.
- Runs from a clone. Node does not strip types inside `node_modules`, so the package is not meant to be installed from a registry as-is.

## License

MIT — see `LICENSE`.
